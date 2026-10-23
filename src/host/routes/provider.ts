/**
 * provider 注册路由：开关读/写、允许清单保存、上下文窗口覆盖、回退默认。
 *
 * 四件事（§9）：
 *   - GET  `PROVIDER_PATH`           读当前开关 + 目录 + 允许清单 + 注册状态（无副作用）；
 *   - POST `PROVIDER_PATH`           body `{enabled?: boolean}` → 保存面板开关并重注册；
 *   - POST `PROVIDER_PATH/roster`    body `{enabledIds?: string[]}` → 保存允许清单并重注册；
 *   - POST `PROVIDER_PATH/context`   body `{contextWindow: number|null}` → 保存全局上下文
 *     窗口覆盖并重注册（null = 跟随目录）；
 *   - POST `PROVIDER_PATH/reset`     忘掉面板开关、允许清单与窗口覆盖，回到 patch 默认。
 *
 * `withOrigin` 围栏与 `refuseMethod` 照现有路由；写开关/清单失败**必须传播**
 * （`ok:false` + error），不静默吞——这是用户的显式操作，面板必须看见它没生效。
 *
 * peer-free：不 import 任何 Host peer（`@deepseek-ai/*` / `@earendil-works/*`）。
 * @module dsh-connect-modelscope-token-plan/routes/provider
 */
import { PROVIDER_PATH } from "./paths.ts";
import { resolveEnabledIds } from "../provider-store.ts";
import { rosterWithAvailability } from "../llm-models.ts";
import { parseAllowedList, enabledCountOf } from "../../shared/allow-list.ts";
import { resolveSwitchEnabled, switchSource } from "../switch-precedence.ts";
import { optional } from "../util.ts";
import { writeJson, refuseMethod, withOrigin, readJsonBodyOr400, readJsonBody, respondError, redactedError, MAX_JSON_BODY_BYTES } from "./http.ts";

/**
 * 本路由读到的 wiring 子集。
 *
 * 本插件的 `types.ts` 只承载「多个模块都要念的名字」，publisher/providerStore 的
 * 具体形状还没进 `Wiring`，所以这里按 §9 内联声明（`index.ts` 装配时传入的真实对象
 * 只会比这个宽）。允许清单的持久化（`enabledIds`/`saveEnabledIds`）由
 * `provider-store.ts` 提供（§8）；在它带上这两个方法前，roster 保存只走内存
 * publish，GET 从 publisher 的活状态回读——这是可接受的降级，不是静默失败。
 *
 * **写路径不再自己 publish**：保存后只触发 `reconcile`（desired-state 收敛，
 * 见 `provider-reconcile.ts`）。四个写路由曾经各自 `readEntries` + `publish`
 * 一遍——与轮询是两个各自为政的 driver，且 fetch 失败会被降级成空目录发布
 * （把已服务的模型全部撤下）。现在「保存 → 标记 dirty → 收敛」只有一条路。
 */
interface ProviderRouteWiring {
  settings: import("../host-config.ts").ResolvedSettings;
  providerStore: {
    enabled: () => Promise<boolean | null>;
    save: (value: boolean) => Promise<void>;
    forget: () => Promise<void>;
    enabledIds?: () => Promise<string[] | null>;
    saveEnabledIds?: (ids: string[]) => Promise<void>;
    contextWindow?: () => Promise<number | null>;
    saveContextWindow?: (value: number | null) => Promise<void>;
  };
  publisher: {
    state: {
      enabledIds: string[];
      llmAvailable: boolean;
      registered: boolean;
      error: string | null;
      /** 最近一次收敛发布的额度耗尽集合（picker 与两个 roster 的同一份真值）。 */
      unavailableIds: string[];
    };
  };
  /** 保存后触发一次收敛（注册态反映 desired 后 resolve）。 */
  reconcile: () => Promise<void>;
  inference: {
    // 与 host-contextOptions 语义对齐：fetchModels 可携带全局窗口覆盖（null =
    // 跟随目录）。readEntries 每次重注册都把 store 里的覆盖传下去。
    fetchModels: (contextWindow?: number | null) => Promise<{ entries?: unknown[]; [k: string]: unknown }>;
  };
  /**
   * 首见表：**本路由只读**（`fresh()`）。
   *
   * 与 `Wiring.rosterSeenStore` 的写侧注释成对：写只发生在收敛器。这条路由是
   * 面板 `GET /provider` 的兜底读路径，一次刷新就会跑；在这里「顺手记一下」
   * 等于把「谁是新模型」变成「谁最近一次被面板读到」。
   */
  rosterSeenStore?: { fresh: (nowMs?: number) => Promise<string[]> };
  logger?: { warn?: (message: string) => void };
}

/**
 * 读目录条目，读不到**抛错**（让 snapshot() 走 respondError 返回 ok:false）。
 *
 * 读目录前先取**当前窗口覆盖**传给 `fetchModels`：条目在归一前打上覆盖标记，
 * descriptor / roster / catalogSignature 都从这份条目派生。每个写路由（开关、
 * 清单、窗口、reset）都经这里取条目再 publish，所以任何一次重注册都带着最新
 * 覆盖——否则先存窗口、再存清单会把未打标的目录重新注册上去，覆盖静默失效到
 * 下一轮轮询。
 *
 * **为什么抛错而不是降级成空目录**：空 roster 与「真的没有模型」在面板上长得
 * 一模一样（modelCount=0），而真相是「目录拉不到」——这与 snapshot-aggregate
 * 的 `models.available=false` 语义矛盾（后者明确区分「0 个模型」与「读不到」）。
 * 抛错让 GET 返回 ok:false + error，面板能显示「目录拉不到」而不是「0 个模型」。
 */
async function readEntries(inference: ProviderRouteWiring["inference"], providerStore?: ProviderRouteWiring["providerStore"]): Promise<unknown[]> {
  const contextWindow = await optional(providerStore?.contextWindow?.(), null);
  const catalog = await inference.fetchModels(contextWindow);
  return Array.isArray(catalog?.entries) ? catalog.entries : [];
}

/**
 * 读「当前」允许清单：优先持久化的，否则 publisher 最近 publish 的那份。
 *
 * 判据是**共用**的 resolveEnabledIds（provider-store）——本文件与面板聚合、
 * index.ts 的轮询必须对「空清单」给同一个答案，否则三个界面各说一套。
 */
async function readEnabledIds(store: ProviderRouteWiring["providerStore"], published: string[]): Promise<string[]> {
  return resolveEnabledIds(await optional(store.enabledIds?.(), null), published);
}

/**
 * `allowed` 的分类与 `enabledCount` 的计数：都从 `shared/allow-list.ts` 的
 * {@link parseAllowedList} 联合上取（fix D：快照与 provider 路由以前各写一套
 * 分类，会漂移；旧版 `allowedOf` 只认「恰好哨兵」为 `"none"`，
 * `["__hide_all__","other"]` 会被错判成 `"list"`——统一到联合后，含哨兵即
 * `"none"`，与 `filterByEnabled` / `isModelEnabled` 同一份解释）。
 */

/**
 * 注册 provider 路由（三条路径）。wiring 子集：settings / providerStore /
 * publisher / inference / logger。
 * @param ctx - host 根上下文（只用 `ctx.webServer`）。
 * @param {ProviderRouteWiring} wiring - 本路由读到的子集。
 * @returns {Function} 依次调用三个 `off()` 的注销回调。
 */
export function registerProviderRoute(ctx: any, wiring: ProviderRouteWiring) {
  const { settings, providerStore, publisher, reconcile, inference, rosterSeenStore, logger } = wiring;

  /**
   * 组装一份 §9 响应形状。GET 与成功后的 POST 共用，所以两个方向不可能对「当前
   * 状态是什么」说两套话。
   *
   * **目录读不到怎么办**：GET 是权威读路径，读不到就让它失败（handler 转
   * `respondError`，面板看见「目录拉不到」而不是「0 个模型」）。POST 的响应只是
   * 保存后的回读，而此时**保存已经成功**——不能把一次成功的写报成失败，所以
   * `tolerateCatalogFailure` 让它降级为空 roster 并带上 `catalogError` 说明原因。
   * @param {object} [extra] - 调用方要追加/覆盖的字段。
   * @param {object} [options] - `{ tolerateCatalogFailure }`：写成功后的回读宽容模式。
   * @returns {Promise<object>} 响应体。
   */
  const snapshot = async (extra: Record<string, unknown> = {}, options: { tolerateCatalogFailure?: boolean } = {}) => {
    const panelSwitch = await optional(providerStore.enabled());
    const enabledIds = await readEnabledIds(providerStore, publisher.state.enabledIds);
    const contextWindow = await optional(providerStore.contextWindow?.(), null);
    // 覆盖值要喂进 fetchModels（不只是顶层字段）：否则 GET 的 roster 行显示
    // 目录原始窗口，而顶层面板显示覆盖值——同一份快照自相矛盾。
    let entries: unknown[] = [];
    let catalogError: string | null = null;
    try {
      entries = await readEntries(inference, providerStore);
    } catch (error) {
      if (options.tolerateCatalogFailure !== true) throw error;
      // 写已成功；回读降级但把原因说出来（空 roster 本身不解释任何事）。
      catalogError = redactedError(error);
    }
    // 耗尽集合取 publisher 最近一次收敛发布的那份（provider-reconcile 每轮从
    // 429 事件流按纯函数 exhaustedModelIds 推断，与快照聚合、picker 同一份
    // 真值）——路由自己不算，算了就会与另外两处漂移。
    // 输出上限覆盖随行透传：GET 的 roster 行必须与 descriptor 用同一个解析器
    // （llm-models.maxTokensFor），否则「面板显示的数」与「线上发的数」会分叉——
    // 与上面 contextWindow 那条是同一类毛病，处理方式也一样。
    const roster = rosterWithAvailability(entries, publisher.state.unavailableIds ?? [], settings.maxTokensOverrides);
    // 联合只解析一次：`allowed` 是它的 mode 投影，`enabledCount` 走它的计数
    // （all = roster 全部；none = 0；list = roster 中真正命中的条数，过期的 id
    // 不虚增，与 snapshot-aggregate 同一份 enabledCountOf）。
    const allowedList = parseAllowedList(enabledIds);
    const modelCount = roster.length;
    // 「本机第一次见到」还算新的模型：**只读**，且读失败降级为空数组。
    //
    // 为什么容忍失败而不是让整条 GET 报错：这条字段只决定胶囊多画不画一段，
    // 而本路由是面板 provider 块的权威读路径——为一个装饰性的字段把整块状态
    // 打成 ok:false，是拿用户的「模型清单能不能看」去换「标记准不准」。
    // 真正需要说出口的是**版本漂移**（读作空表），那条在快照的 shapeWarnings 里。
    const newModelIds = rosterSeenStore === undefined
      ? []
      : await optional(rosterSeenStore.fresh(), [] as string[]);
    return {
      ok: true,
      enabled: resolveSwitchEnabled(panelSwitch, settings.registerProvider),
      source: switchSource(panelSwitch),
      llmAvailable: publisher.state.llmAvailable === true,
      registered: publisher.state.registered === true,
      error: typeof publisher.state.error === "string" ? publisher.state.error : null,
      modelCount,
      enabledCount: enabledCountOf(allowedList, roster.map((row) => row.id)),
      allowed: allowedList.mode,
      enabledIds,
      contextWindow,
      newModelIds,
      roster,
      ...(catalogError !== null ? { catalogError } : {}),
      ...extra
    };
  };

  const offs: (() => void)[] = [];

  // 开关路由（GET 读 / POST 写 enabled）。
  offs.push(ctx.webServer.register({
    kind: "exact",
    path: PROVIDER_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      const method = request.method === undefined ? "GET" : request.method;
      if (method === "GET") {
        // 目录读不到时**不许**回一个「0 个模型」的 ok:true（那让「拉不到」与
        // 「真的没有模型」长得一样）。GET 是权威读路径，失败就如实报。
        try {
          writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
        } catch (error) {
          respondError(response, error);
        }
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      if (typeof body.enabled !== "boolean") {
        writeJson(response, 400, { ok: false, error: "expected { enabled: boolean }" }, { "cache-control": "no-store" });
        return;
      }
      try {
        await providerStore.save(body.enabled);
        // 开关只决定「提不提供模型」，不决定「提供哪些」——落盘后触发收敛：
        // reconciler 带**当前窗口覆盖**拉目录、按**落盘清单**重注册，不等
        // 下一次轮询。失败在 publish 内部回滚到上一对并落进
        // publisher.state.error。
        await reconcile();
      } catch (error) {
        respondError(response, error);
        return;
      }
      writeJson(response, 200, await snapshot({}, { tolerateCatalogFailure: true }), { "cache-control": "no-store" });
    }, settings.allowedHosts)
  }));

  // 允许清单路由（POST 写 enabledIds）。
  offs.push(ctx.webServer.register({
    kind: "exact",
    path: `${PROVIDER_PATH}/roster`,
    handler: withOrigin(async (request: any, response: any) => {
      const method = request.method === undefined ? "POST" : request.method;
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // 缺字段要拒，不能当「全部模型」读：那等于把 offer 静默扩到目录里每个模型。
      if (!Array.isArray(body.enabledIds)) {
        writeJson(response, 400, { ok: false, error: "expected { enabledIds: string[] }" }, { "cache-control": "no-store" });
        return;
      }
      const ids = body.enabledIds.filter((id: unknown): id is string => typeof id === "string" && id !== "");
      try {
        // 持久化允许清单（provider-store 具备时）；随后触发收敛——reconciler
        // 用**落盘的**清单重注册（不是本环传进来的这份：落盘优先是
        // resolveEnabledIds 的判据，见 provider-reconcile.ts）。
        await providerStore.saveEnabledIds?.(ids);
        await reconcile();
      } catch (error) {
        respondError(response, error);
        return;
      }
      writeJson(response, 200, await snapshot({}, { tolerateCatalogFailure: true }), { "cache-control": "no-store" });
    }, settings.allowedHosts)
  }));

  // 全局上下文窗口覆盖路由（POST 写 contextWindow；null = 跟随目录）。
  offs.push(ctx.webServer.register({
    kind: "exact",
    path: `${PROVIDER_PATH}/context`,
    handler: withOrigin(async (request: any, response: any) => {
      const method = request.method === undefined ? "POST" : request.method;
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // 与 roster 同一纪律：缺字段要拒。`undefined` 静默当作「跟随目录」会把
      // 一个格式坏掉的 body 读成重置——用户以为是保存，实际什么都没存。
      if (body.contextWindow !== null && (typeof body.contextWindow !== "number" || !Number.isFinite(body.contextWindow) || body.contextWindow <= 0)) {
        writeJson(response, 400, { ok: false, error: "expected { contextWindow: number | null }" }, { "cache-control": "no-store" });
        return;
      }
      try {
        // 持久化覆盖（provider-store 具备时）；随后触发收敛——覆盖随本次重注册
        // 生效（reconciler 读 desired 时把覆盖喂给 fetchModels），不再有
        // 「先存窗口、再存清单把未打标目录注册上去」的窗口。
        await providerStore.saveContextWindow?.(body.contextWindow);
        await reconcile();
      } catch (error) {
        respondError(response, error);
        return;
      }
      writeJson(response, 200, await snapshot({}, { tolerateCatalogFailure: true }), { "cache-control": "no-store" });
    }, settings.allowedHosts)
  }));

  // 回退默认路由（POST，空 body）。
  offs.push(ctx.webServer.register({
    kind: "exact",
    path: `${PROVIDER_PATH}/reset`,
    handler: withOrigin(async (request: any, response: any) => {
      const method = request.method === undefined ? "POST" : request.method;
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      // reset 不接受参数：body 可有可无（空 body 也合法），所以不能用
      // readJsonBodyOr400——那会对空 body 先写一个 400，再继续就没意义了。
      await readJsonBody(request, MAX_JSON_BODY_BYTES).catch(() => ({ ok: false, error: "ignored" }));
      try {
        // 忘掉面板开关（回到 patch 默认，本插件默认 false = 不注册）并清空允许清单
        // = 不过滤全部模型。随后触发收敛：reset 的语义是「回到插件出厂设置」，
        // 注册态必须当场反映它。
        await providerStore.forget();
        await providerStore.saveEnabledIds?.([]);
        await reconcile();
      } catch (error) {
        respondError(response, error);
        return;
      }
      writeJson(response, 200, await snapshot({}, { tolerateCatalogFailure: true }), { "cache-control": "no-store" });
    }, settings.allowedHosts)
  }));

  return () => {
    for (const off of offs) {
      try {
        off();
      } catch (error) {
        logger?.warn?.(`provider route unregister failed: ${redactedError(error)}`);
      }
    }
  };
}