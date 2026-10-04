/**
 * 模型目录路由：`GET /models` —— 免认证的 `/v1/models` 读穿透（缓存与单飞
 * 在 inference-client 里），零额度成本（SPIKE.md §结论 3）。只读。
 * @module dsh-connect-modelscope-token-plan/routes/models
 */
import { MODELS_PATH } from "./paths.ts";
import { CODE } from "../codes.ts";
import { writeJson, refuseMethod, withOrigin, redactedError } from "./http.ts";
import type { Wiring } from "../types.ts";

/** 注册模型目录路由。wiring 子集：settings / inference。 */
export function registerModelsRoute(ctx: any, wiring: Pick<Wiring, "settings" | "inference">) {
  const { settings, inference } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: MODELS_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      if (request.method !== undefined && request.method !== "GET" && request.method !== "HEAD") {
        refuseMethod(response);
        return;
      }
      try {
        const catalog = await inference.fetchModels();
        writeJson(response, 200, {
          ok: true,
          models: catalog.ids.map((id) => ({ id })),
          count: catalog.ids.length,
          fetchedAt: catalog.fetchedAt,
          cacheSeconds: settings.cacheSeconds
        }, { "cache-control": "no-store" });
      } catch (error) {
        // 目录失败不是面板失败：ok:false + 稳定码，下一轮轮询自愈。
        const code = (error as { code?: unknown }).code;
        writeJson(response, 200, {
          ok: false,
          code: typeof code === "string" ? code : CODE.UPSTREAM_ERROR,
          error: redactedError(error)
        }, { "cache-control": "no-store" });
      }
    }, settings.allowedHosts)
  });
}
