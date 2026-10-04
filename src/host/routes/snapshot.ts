/**
 * 快照路由——Client 面板轮询的唯一只读路由。
 *
 * HTTP 恒 200，成败看 body（wire.ts 的 Snapshot | SnapshotFailure）：一次
 * 读取失败不许顺着渲染树炸穿成整页失效，错误是**数据**（ok:false + code）
 * 不是异常。configError 在这里短路——面板把它映射成顶部一行，让操作者看到
 * 配错的是什么，而不是一个莫名其妙的网络失败。
 *
 * @module dsh-connect-modelscope-token-plan/routes/snapshot
 */
import { SNAPSHOT_PATH } from "./paths.ts";
import { buildSnapshotBody, failureCode } from "../snapshot-aggregate.ts";
import { CODE } from "../codes.ts";
import { writeJson, refuseMethod, withOrigin, redactedError } from "./http.ts";
import type { Wiring } from "../types.ts";

/**
 * 注册快照路由。wiring 子集：settings / configError / tokenStore /
 * usageStore / inference / providerStore / publisher / logger。
 * @returns {Function} off() 注销回调。
 */
export function registerSnapshotRoute(ctx: any, wiring: Pick<Wiring, "settings" | "configError" | "tokenStore" | "usageStore" | "inference" | "providerStore" | "publisher" | "logger">) {
  const { settings, configError } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: SNAPSHOT_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      if (request.method !== undefined && request.method !== "GET" && request.method !== "HEAD") {
        refuseMethod(response);
        return;
      }
      if (configError !== null) {
        writeJson(response, 200, {
          ok: false,
          code: CODE.CONFIG_ERROR,
          error: configError
        }, { "cache-control": "no-store" });
        return;
      }
      try {
        const body = await buildSnapshotBody(wiring);
        writeJson(response, 200, body, { "cache-control": "no-store" });
      } catch (error) {
        writeJson(response, 200, {
          ok: false,
          error: redactedError(error),
          code: failureCode(error)
        }, { "cache-control": "no-store" });
      }
    }, settings.allowedHosts)
  });
}
