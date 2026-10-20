/**
 * 出图工具路由：开关读/写、模型偏好保存、回到默认。
 *
 * 三条路径：
 *   - GET  `DRAW_PATH`        读开关 + 出图候选模型 + 工具挂载状态（无副作用）；
 *   - POST `DRAW_PATH`        body `{enabled?: boolean, modelId?: string|null}` → 保存；
 *   - POST `DRAW_PATH/reset`  忘掉面板值，回到 patch 默认。
 *
 * **与 provider 路由刻意分开**：provider 管「魔搭作为 chat provider」，本路由管
 * 「给 agent 一个出图工具」。两者的开关、状态文件、候选集合都不同，合并会让
 * 「关掉出图」波及 provider 的注册时序（详见 draw-store.ts 的头注）。
 *
 * 一处**与 provider 路由不同**的地方必须说清：provider 开关翻转会**立即**重注册
 * （publish 是活的重建），而出图工具的开关翻转**要等下次 Host 启动**——peer 的
 * tools registry 没有 unregister，工具一旦注册就摘不下来（完整论述见
 * draw-register.ts 文件头注）。所以本路由保存成功后
 * 不改挂载状态，只在响应里给出 `mountPending`，让面板能说清这件事，而不是让用户
 * 以为开关坏了。
 *
 * peer-free：不 import 任何 Host peer。
 * @module dsh-connect-modelscope-token-plan/routes/draw
 */
import { DRAW_PATH } from "./paths.ts";
import { drawCandidates, resolveDrawModelChoice } from "../llm-models.ts";
import { drawToolMounted, drawToolNote } from "../draw-tool-state.ts";
import { resolveSwitchEnabled, resolveSwitchValue, switchSource } from "../switch-precedence.ts";
import { optional } from "../util.ts";
import { writeJson, refuseMethod, withOrigin, readJsonBodyOr400, readJsonBody, respondError, redactedError, MAX_JSON_BODY_BYTES } from "./http.ts";

/**
 * 本路由读到的 wiring 子集（`index.ts` 装配时传的真实对象只会比这个宽）。
 */
interface DrawRouteWiring {
  settings: import("../host-config.ts").ResolvedSettings;
  drawStore: {
    enabled: () => Promise<boolean | null>;
    modelId: () => Promise<string | null>;
    // 写失败（ADR-006 拒写 / 只读 Home）与 provider 路由同一方言：**抛**，
    // 由下面的 try/catch 转 respondError 呈报，不静默。
    saveEnabled: (value: boolean) => Promise<void>;
    saveModelId: (modelId: string | null) => Promise<void>;
    reset: () => Promise<void>;
  };
  inference: {
    fetchModels: () => Promise<{ entries?: unknown[]; [k: string]: unknown }>;
  };
  logger?: { warn?: (message: string) => void };
}

/**
 * 读目录条目。
 *
 * 与 provider 路由同一条纪律：GET 不能因为一次目录失败就把整个面板状态打掉——
 * 出图候选为空只影响「能不能挑模型」，不影响开关的显示。
 *
 * 但「空目录」和「目录读不到」必须分开（红线 3）：后者要能回答「首选模型还在
 * 不在」时说「不知道」而不是「不在」。所以这里返回 `{ ok, entries }`，调用方
 * 按 ok 决定是断言还是弃权。
 *
 * @param {object} inference - inference client。
 * @returns {Promise<{ok: boolean, entries: unknown[]}>} 目录读取结果与归一条目。
 */
async function readEntries(
  inference: DrawRouteWiring["inference"]
): Promise<{ ok: boolean; entries: unknown[] }> {
  try {
    const catalog = await inference.fetchModels();
    return { ok: true, entries: Array.isArray(catalog?.entries) ? catalog.entries : [] };
  } catch {
    // 读不到 ≠ 空目录：`preferredInCatalog` 要据此置 null（不知道），而不是 false
    // （不在）。候选集仍按空数组走，面板照常显示开关与已保存的首选。
    return { ok: false, entries: [] };
  }
}

/**
 * 注册出图路由（两条路径）。
 * @param ctx - host 根上下文（只用 `ctx.webServer`）。
 * @param {DrawRouteWiring} wiring - 本路由读到的子集。
 * @returns {Function} 注销回调。
 */
export function registerDrawRoute(ctx: any, wiring: DrawRouteWiring) {
  const { settings, drawStore, inference, logger } = wiring;

  /**
   * 组装响应。GET 与写成功后的响应共用，两个方向不可能对「当前状态」说两套话。
   * @param {object} [extra] - 追加/覆盖字段。
   * @returns {Promise<object>} 响应体。
   */
  const snapshot = async (extra: Record<string, unknown> = {}) => {
    const panelSwitch = await optional(drawStore.enabled());
    const panelModelId = await optional(drawStore.modelId());
    const catalog = await readEntries(inference);
    // 候选明细与「当前使用谁、为什么」都从 llm-models 的同一份判定派生（与快照
    // 聚合、工具里 pickDrawModel 同源），面板据此画出能力徽章与生效模型。
    const candidates = drawCandidates(catalog.entries);
    const preferredModelId = resolveSwitchValue(panelModelId, settings.drawModelId === "" ? undefined : settings.drawModelId) ?? null;
    const choice = resolveDrawModelChoice(catalog.entries, undefined, preferredModelId ?? undefined);
    return {
      ok: true,
      enabled: resolveSwitchEnabled(panelSwitch, settings.drawEnabled),
      source: switchSource(panelSwitch),
      // 候选来自**目录**（平台声明的出图能力），不是 provider 的允许清单——用户
      // 裁剪 chat picker 不该波及出图工具的候选。
      candidateIds: candidates.map((row) => row.id),
      candidateCount: candidates.length,
      candidates,
      preferredModel: preferredModelId,
      preferredSource: switchSource(panelModelId),
      effectiveModel: choice.id,
      effectiveSource: choice.source,
      // 工具的实际挂载结果。`null` = 开关没开或已成功挂载；非 null = 缺席原因码
      // （措辞在客户端 i18n 里，与 sensenova 的 DRAW_ABSENT_KEY 同一套分工）。
      absentReason: drawToolNote(),
      /**
       * 开关的保存**不会**改变本次挂载的工具。
       *
       * 工具无法注销（peer 的 tools registry 没有 unregister），所以开关翻转只在
       * 下次 Host 启动时生效。面板据此显示一句说明——否则用户会以为开关坏了。
       * 判据：开关为开且**本次挂载没注册上**。
       *
       * 注意判据不是「有缺席原因」：缺席原因非 null 表示注册尝试过且失败，而挂载
       * 那一刻开关是关的（用户之后才翻开）时 absentReason 为 null、却同样没注册
       * 上——后者才是最需要这句提示的场景。见 `draw-tool-state.ts` 文件头。
       */
      mountPending: resolveSwitchEnabled(panelSwitch, settings.drawEnabled) === true && drawToolMounted() !== true,
      // 首选模型还在不在目录里。false = 目录读到了、它不在（下架/改名，但按「用户
      // 点了谁就是谁」快照仍照显这个 id）；null = 没设首选或目录读不到，不敢断言
      // （红线 3：读不到 ≠ 不在）。
      preferredInCatalog:
        preferredModelId === null
          ? null
          : catalog.ok
            ? candidates.some((row) => row.id === preferredModelId)
            : null,
      toolName: "modelscope_draw_image",
      ...extra
    };
  };

  const offs: (() => void)[] = [];

  // 开关 + 模型偏好路由（GET 读 / POST 写）。
  offs.push(ctx.webServer.register({
    kind: "exact",
    path: DRAW_PATH,
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
      // 两个字段都可选，但**至少要有一个**：空 body 应当被拒，否则一次误发的空
      // POST 会静默成功，界面看起来「保存了」而什么都没变。
      const hasEnabled = typeof body.enabled === "boolean";
      const hasModel = body.modelId === null || typeof body.modelId === "string";
      if (!hasEnabled && !hasModel) {
        writeJson(response, 400, { ok: false, error: "expected { enabled?: boolean, modelId?: string|null }" }, { "cache-control": "no-store" });
        return;
      }
      // 类型给错要拒，不能当「没给」处理：`enabled: "yes"` 静默变成不改动，比报错更坏。
      if (body.enabled !== undefined && !hasEnabled) {
        writeJson(response, 400, { ok: false, error: "enabled must be a boolean" }, { "cache-control": "no-store" });
        return;
      }
      if (body.modelId !== undefined && !hasModel) {
        writeJson(response, 400, { ok: false, error: "modelId must be a string or null" }, { "cache-control": "no-store" });
        return;
      }
      try {
        if (hasEnabled) await drawStore.saveEnabled(body.enabled as boolean);
        if (body.modelId !== undefined) await drawStore.saveModelId(body.modelId as string | null);
      } catch (error) {
        // 拒写（ADR-006：盘上是更新构建写的版本）与 IO 失败都在这里呈报——
        // 与 provider 路由同一方言：throw，不返回理由串让调用方各自解释。
        respondError(response, error);
        return;
      }
      writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
    }, settings.allowedHosts)
  }));

  // 回退默认路由（POST，空 body 合法）。
  offs.push(ctx.webServer.register({
    kind: "exact",
    path: `${DRAW_PATH}/reset`,
    handler: withOrigin(async (request: any, response: any) => {
      const method = request.method === undefined ? "POST" : request.method;
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      // reset 不接受参数：空 body 也合法，所以不能用 readJsonBodyOr400（那会先写
      // 一个 400 再继续，没有意义）。与 provider 的 reset 同一条处理。
      await readJsonBody(request, MAX_JSON_BODY_BYTES).catch(() => ({ ok: false, error: "ignored" }));
      try {
        await drawStore.reset();
      } catch (error) {
        respondError(response, error);
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
        logger?.warn?.(`draw route unregister failed: ${redactedError(error)}`);
      }
    }
  };
}
