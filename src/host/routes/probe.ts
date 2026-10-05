/**
 * probe 路由：面板「接入」tab 的「验令牌（零额度）」按钮。
 *
 * 只剩一种形态（SPIKE.md §结论 5，2026-10-04 真机回填）：
 * - 故意缺 messages 的请求——魔搭**不先校验消息体**，实测返回 200（空壳）而非
 *   400，所以判定规则是 **401/403 = 令牌坏；200/400 = 令牌好；429 = 限频中**。
 *   早先「401 先于 400」的预期已被真机推翻（空壳响应 `created:0`，疑似零额度，
 *   未证实——故 validity 结果**不计入**本地用量，也不记调用，只记事件）。
 *
 * `kind:"usage"`（真调用、max_tokens=1、消耗 1 次免费额度）**已删除**：它只服务
 * 已随面板收敛删掉的「模型目录」逐行试调按钮，且**不在 DSH 的调用路径上**——真
 * 调用经 provider adapter，由 `usage-observer.ts` 在流出口记账。删它的另一个理由
 * 是形态本身：服务端原有 `kind = body.kind === "validity" ? "validity" : "usage"`
 * 的**缺省即 usage**，任何人 POST 一个 modelId 就会触发一次真实计费调用。面板只
 * 剩零额度探针之后，缺省不该指向「花钱的那个」。
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
      if (modelId === "") {
        writeJson(response, 400, { ok: false, error: "modelId is required" }, { "cache-control": "no-store" });
        return;
      }
      try {
        const result = await inference.probe({ modelId });
        // 成功（200/400 都算令牌好）不记调用也不记事件——它不是一次用量，
        // 2026-10-04 实测它返回的是零 token 空壳（SPIKE.md）；是否耗一次免费
        // 次数未证实，所以宁可不计。
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
