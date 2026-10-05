/**
 * provider 注册路由：开关读/写、允许清单保存、回退默认。
 *
 * 三件事（§9）：
 *   - GET  `PROVIDER_PATH`        读当前开关 + 目录 + 允许清单 + 注册状态（无副作用）；
 *   - POST `PROVIDER_PATH`        body `{enabled?: boolean}` → 保存面板开关并重注册；
 *   - POST `PROVIDER_PATH/roster` body `{enabledIds?: string[]}` → 保存允许清单并重注册；
 *   - POST `PROVIDER_PATH/reset`  忘掉面板开关与允许清单，回到 patch 默认。
 *
 * `withOrigin` 围栏与 `refuseMethod` 照现有路由；写开关/清单失败**必须传播**
 * （`ok:false` + error），不静默吞——这是用户的显式操作，面板必须看见它没生效。
 *
 * peer-free：不 import 任何 Host peer（`@deepseek-ai/*` / `@earendil-works/*`）。
 * @module dsh-connect-modelscope-token-plan/routes/provider
 */
import { PROVIDER_PATH } from "./paths.ts";
import { rosterWithAvailability, resolveAllowedList } from "../llm-models.ts";
import { resolveSwitchEnabled, switchSource } from "../switch-precedence.ts";
import { optional } from "../util.ts";
import { writeJson, refuseMethod, withOrigin, readJsonBodyOr400, readJsonBody, redactedError, MAX_JSON_BODY_BYTES } from "./http.ts";

/**
 * 本路由读到的 wiring 子集。
 *
 * 本插件的 `types.ts` 只承载「多个模块都要念的名字」，publisher/providerStore 的
 * 具体形状还没进 `Wiring`，所以这里按 §9 内联声明（`index.ts` 装配时传入的真实对象
 * 只会比这个宽）。允许清单的持久化（`enabledIds`/`saveEnabledIds`）由
 * `provider-store.ts` 提供（§8）；在它带上这两个方法前，roster 保存只走内存
 * publish，GET 从 publisher 的活状态回读——这是可接受的降级，不是静默失败。
 */
interface ProviderRouteWiring {
  settings: import("../host-config.ts").ResolvedSettings;
  providerStore: {
    enabled: () => Promise<boolean | null>;
    save: (value: boolean) => Promise<void>;
    forget: () => Promise<void>;
    enabledIds?: () => Promise<string[] | null>;
    saveEnabledIds?: (ids: string[]) => Promise<void>;
  };
  publisher: {
    state: {
      enabledIds: string[];
      llmAvailable: boolean;
      registered: boolean;
      error: string | null;
    };
    publish: (entries: unknown[], enabledIds: string[], unavailable?: string[]) => Promise<unknown>;
  };
  inference: {
    fetchModels: () => Promise<{ entries?: unknown[]; [k: string]: unknown }>;
  };
  logger?: { warn?: (message: string) => void };
}

/**
 * 读目录条目，读不到按空目录降级（GET 不能因目录失败把整个面板状态打掉）。
 */
async function readEntries(inference: ProviderRouteWiring["inference"]): Promise<unknown[]> {
  const catalog = await inference.fetchModels().catch((error) => {
    return { entries: [], __error: error };
  });
  return Array.isArray(catalog?.entries) ? catalog.entries : [];
}

/**
 * 读「当前」允许清单：优先持久化的，否则 publisher 最近 publish 的那份。
 */
async function readEnabledIds(store: ProviderRouteWiring["providerStore"], published: string[]): Promise<string[]> {
  const stored = await optional(store.enabledIds?.(), null);
  if (Array.isArray(stored)) return stored;
  return Array.isArray(published) ? published : [];
}

/**
 * `allowed` 的分类：委托给 `llm-models.ts` 的单一口径
 * {@link resolveAllowedList}（fix D：快照与 provider 路由以前各写一套分类，会漂移）。
 *
 * 旧版 `allowedOf` 只认「恰好哨兵」为 `"none"`，`["__hide_all__","other"]` 会被错判成
 * `"list"`；统一到 `resolveAllowedList` 后，含哨兵即 `"none"`，与 `filterByEnabled` /
 * `isModelEnabled` 口径一致。
 * @param {string[]} enabledIds - 允许清单。
 * @returns {"all"|"none"|"list"}
 */
function allowedOf(enabledIds: string[]): "all" | "none" | "list" {
  return resolveAllowedList(enabledIds);
}

/**
 * 注册 provider 路由（三条路径）。wiring 子集：settings / providerStore /
 * publisher / inference / logger。
 * @param ctx - host 根上下文（只用 `ctx.webServer`）。
 * @param {ProviderRouteWiring} wiring - 本路由读到的子集。
 * @returns {Function} 依次调用三个 `off()` 的注销回调。
 */
export function registerProviderRoute(ctx: any, wiring: ProviderRouteWiring) {
  const { settings, providerStore, publisher, inference, logger } = wiring;

  /**
   * 组装一份 §9 响应形状。GET 与成功后的 POST 共用，所以两个方向不可能对「当前
   * 状态是什么」说两套话。
   * @param {object} [extra] - 调用方要追加/覆盖的字段。
   * @returns {Promise<object>} 响应体。
   */
  const snapshot = async (extra: Record<string, unknown> = {}) => {
    const panelSwitch = await optional(providerStore.enabled());
    const enabledIds = await readEnabledIds(providerStore, publisher.state.enabledIds);
    const entries = await readEntries(inference);
    const roster = rosterWithAvailability(entries, []);
    const allowed = allowedOf(enabledIds);
    const modelCount = roster.length;
    const allowSet = new Set(enabledIds);
    return {
      ok: true,
      enabled: resolveSwitchEnabled(panelSwitch, settings.registerProvider),
      source: switchSource(panelSwitch),
      llmAvailable: publisher.state.llmAvailable === true,
      registered: publisher.state.registered === true,
      error: typeof publisher.state.error === "string" ? publisher.state.error : null,
      modelCount,
      // 启用数：all = roster 全部；none = 0；list = roster 中真正命中的条数（按
      // allowSet 过滤，过期的 id 不再虚增计数，与 snapshot-aggregate 口径一致）。
      enabledCount: allowed === "all"
        ? modelCount
        : allowed === "none"
          ? 0
          : roster.filter((row) => allowSet.has(row.id)).length,
      allowed,
      enabledIds,
      roster,
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
        writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
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
        // 开关只决定「提不提供模型」，不决定「提供哪些」——所以用当前目录立即重
        // 注册，而不是等下一次轮询。失败在 publish 内部回滚到上一对并落进
        // publisher.state.error。
        const entries = await readEntries(inference);
        await publisher.publish(entries, await readEnabledIds(providerStore, publisher.state.enabledIds), []);
      } catch (error) {
        writeJson(response, 200, { ok: false, error: redactedError(error) }, { "cache-control": "no-store" });
        return;
      }
      writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
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
        // 持久化允许清单（provider-store 具备时）；没有就先只 publish，清单随下次
        // 重注册生效。
        await providerStore.saveEnabledIds?.(ids);
        const entries = await readEntries(inference);
        await publisher.publish(entries, ids, []);
      } catch (error) {
        writeJson(response, 200, { ok: false, error: redactedError(error) }, { "cache-control": "no-store" });
        return;
      }
      writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
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
        // = 不过滤全部模型。
        await providerStore.forget();
        await providerStore.saveEnabledIds?.([]);
        const entries = await readEntries(inference);
        await publisher.publish(entries, [], []);
      } catch (error) {
        writeJson(response, 200, { ok: false, error: redactedError(error) }, { "cache-control": "no-store" });
        return;
      }
      writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
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