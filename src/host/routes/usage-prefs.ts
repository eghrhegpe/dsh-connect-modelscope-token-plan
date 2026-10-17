/**
 * 趋势图**显示窗口**路由：读当前窗口（GET）与保存（POST）。
 *
 * 一条路径两件事：
 *   - GET  `TREND_WINDOW_PATH`   读面板覆盖 + 生效天数 + 上界（无副作用）；
 *   - POST `TREND_WINDOW_PATH`   body `{ windowDays: number|null }` → 保存
 *     （`null` = 清除覆盖，回到 `trendDays` 配置默认）。
 *
 * **与 provider / draw 路由不同，本路由保存后不触发任何收敛**：显示窗口只影响
 * 快照里 `trend` 那一段，面板保存成功后自己调一次 `load()` 就当场回显；没有
 * 需要重建的注册态。
 *
 * 越界值**夹取而不是拒绝**：上界是保留窗口（`settings.retentionDays`），而
 * host-config 对配置里的同一个值也是夹——两处若一个夹一个拒，同一个越界值会因
 * 来源不同得到两个下场。类型给错（字符串 / 缺字段）仍然按 400 拒：那是形状错，
 * 不是范围错。
 *
 * peer-free：不 import 任何 Host peer。
 * @module dsh-connect-modelscope-token-plan/routes/usage-prefs
 */
import { TREND_WINDOW_PATH } from "./paths.ts";
import { resolveWindowDays } from "../usage-prefs-store.ts";
import { switchSource } from "../switch-precedence.ts";
import { optional } from "../util.ts";
import { writeJson, refuseMethod, withOrigin, readJsonBodyOr400, respondError, redactedError } from "./http.ts";

/** 本路由读到的 wiring 子集（`index.ts` 装配时传的真实对象只会比这个宽）。 */
interface UsagePrefsRouteWiring {
  settings: import("../host-config.ts").ResolvedSettings;
  usagePrefsStore: {
    windowDays: () => Promise<number | null>;
    // 写失败（ADR-006 拒写 / 只读 Home）与 provider / draw 路由同一方言：**抛**，
    // 由下面的 try/catch 转 respondError 呈报，不静默。
    saveWindowDays: (value: number | null) => Promise<void>;
  };
  logger?: { warn?: (message: string) => void };
}

/**
 * 注册趋势窗口路由。
 * @param ctx - host 根上下文（只用 `ctx.webServer`）。
 * @param {UsagePrefsRouteWiring} wiring - 本路由读到的子集。
 * @returns {Function} 注销回调。
 */
export function registerUsagePrefsRoute(ctx: any, wiring: UsagePrefsRouteWiring) {
  const { settings, usagePrefsStore, logger } = wiring;

  /**
   * 组装响应。GET 与写成功后的响应共用，两个方向不可能对「当前窗口」说两套话。
   * @param {object} [extra] - 追加/覆盖字段。
   * @returns {Promise<object>} 响应体。
   */
  const snapshot = async (extra: Record<string, unknown> = {}) => {
    const panel = await optional(usagePrefsStore.windowDays());
    return {
      ok: true,
      windowDays: panel,
      days: resolveWindowDays(panel, settings.trendDays, settings.retentionDays),
      maxDays: settings.retentionDays,
      source: switchSource(panel),
      ...extra
    };
  };

  const off = ctx.webServer.register({
    kind: "exact",
    path: TREND_WINDOW_PATH,
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
      // 缺字段要拒，不能当「清除覆盖」读：那会把一次格式坏掉的 body 变成
      // 用户没要求的重置（与 provider 的 context 路由同一条纪律）。
      const isNull = body.windowDays === null;
      const isNumber = typeof body.windowDays === "number" && Number.isFinite(body.windowDays);
      if (!isNull && !isNumber) {
        writeJson(response, 400, { ok: false, error: "expected { windowDays: number | null }" }, { "cache-control": "no-store" });
        return;
      }
      // 越界夹取（见文件头）：下界 1，上界 = 保留窗口。
      const saved = isNull ? null : Math.min(Math.max(1, Math.floor(body.windowDays as number)), settings.retentionDays);
      try {
        await usagePrefsStore.saveWindowDays(saved);
      } catch (error) {
        respondError(response, error);
        return;
      }
      writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
    }, settings.allowedHosts)
  });

  return () => {
    try {
      off();
    } catch (error) {
      logger?.warn?.(`trend window route unregister failed: ${redactedError(error)}`);
    }
  };
}
