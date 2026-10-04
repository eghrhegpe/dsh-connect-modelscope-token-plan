/**
 * probe 路由：面板「接入」tab 的「测试一次调用」，也是本地计数器的第一个
 * 数据源。
 *
 * 两种形态（SPIKE.md §结论 5）：
 * - `kind:"usage"` —— 真调用（max_tokens=1），**消耗 1 次免费额度**；成功后
 *   recordCall 把这次调用记进当天天桶与单模型计数（tokens 取 usage）。
 * - `kind:"validity"` —— 故意缺 messages 的请求，预期 401 先于 400，零额度
 *   鉴权探针（语义待真机回填）。只记事件，不记调用。
 *
 * 失败照常记账：429 分诊成 quota/rate_limit 事件（带 Retry-After），401 记
 * auth 事件——事件流是面板「额度」tab 的第三块。错误消息先脱敏（红线 1）。
 * @module dsh-connect-modelscope-token-plan/routes/probe
 */
import { PROBE_PATH } from "./paths.ts";
import { CODE } from "../codes.ts";
import { writeJson, refuseMethod, withOrigin, redactedError, readJsonBodyOr400 } from "./http.ts";
import type { Wiring } from "../types.ts";
import type { QuotaEvent } from "../../shared/wire.ts";

/** 注册 probe 路由。wiring 子集：settings / tokenStore / usageStore / inference / logger。 */
export function registerProbeRoute(ctx: any, wiring: Pick<Wiring, "settings" | "tokenStore" | "usageStore" | "inference" | "logger">) {
  const { settings, usageStore, inference, logger } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: PROBE_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      if (request.method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
      const kind = body.kind === "validity" ? "validity" : "usage";
      if (modelId === "") {
        writeJson(response, 400, { ok: false, error: "modelId is required" }, { "cache-control": "no-store" });
        return;
      }
      try {
        const result = await inference.probe({ modelId, kind });
        if (kind === "usage") {
          await usageStore.recordCall({
            modelId,
            tokens: result.usage === null ? null : result.usage.totalTokens
          });
        }
        // validity 成功（200/400 都算令牌好）不记调用也不记事件——它不是一次
        // 用量，2026-10-04 实测它返回的是零 token 空壳（SPIKE.md）；是否耗一次
        // 免费次数未证实，所以宁可不计。
        writeJson(response, 200, { ...result, tokenState: await wiring.tokenStore.state() }, { "cache-control": "no-store" });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const message = redactedError(error);
        // 失败也记账：429 按分诊入事件流，其余按 error。
        const eventKind: QuotaEvent["kind"] =
          code === CODE.QUOTA_EXCEEDED ? "quota" :
          code === CODE.RATE_LIMITED ? "rate_limit" : "error";
        await usageStore.recordEvent({ modelId, kind: eventKind, message }).catch(() => {});
        if (eventKind !== "error") logger?.warn?.(`probe ${modelId}: ${eventKind}: ${message}`);
        const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
        writeJson(response, 200, {
          ok: false,
          code: typeof code === "string" ? code : CODE.UPSTREAM_ERROR,
          error: message,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          tokenState: await wiring.tokenStore.state().catch(() => null)
        }, { "cache-control": "no-store" });
      }
    }, settings.allowedHosts)
  });
}
