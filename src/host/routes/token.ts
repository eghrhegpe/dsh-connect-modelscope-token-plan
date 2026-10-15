/**
 * 令牌路由：面板「接入」tab 保存 / 忘掉访问令牌。
 *
 * 存的是凭据引用（ms-auth TOKEN_REF），不是新 kind。保存/忘掉后**不需要**
 * 失效任何缓存：模型目录免认证、probe 每次现 resolve 令牌——本插件没有
 * 「凭据换手后缓存还在替旧身份说话」的形态，这是免认证目录带来的结构性
 * 简化（SPIKE.md §结论 3）。
 * @module dsh-connect-modelscope-token-plan/routes/token
 */
import { TOKEN_PATH, TOKEN_FORGET_PATH } from "./paths.ts";
import { writeJson, refuseMethod, withOrigin, respondError, readJsonBodyOr400 } from "./http.ts";
import type { Wiring } from "../types.ts";

/**
 * 注册令牌路由（POST /token 保存，POST /token/forget 忘掉）。
 *
 * 返回类型是本族唯一的一个**数组**：token 注册两条路由（save + forget），其余
 * 路由族各只注册一条、返回单个 off()。标注在**这里**而不是在 routes.ts 里对
 * 调用结果做 `as Array<() => void>` 断言——断言放在消费端等于把「这两条返回的是
 * 注销回调而不是 handler」这个约定藏起来，标注在产地才是声明。
 */
export function registerTokenRoute(ctx: any, wiring: Pick<Wiring, "settings" | "tokenStore" | "logger">): Array<() => void> {
  const { settings, tokenStore } = wiring;

  const save = withOrigin(async (request: any, response: any) => {
    if (request.method !== "POST") {
      refuseMethod(response);
      return;
    }
    const body = await readJsonBodyOr400(request, response);
    if (body === null) return;
    const token = typeof body.token === "string" ? body.token : "";
    if (token.trim() === "") {
      writeJson(response, 400, { ok: false, error: "a ModelScope token (ms-…) is required" }, { "cache-control": "no-store" });
      return;
    }
    try {
      await tokenStore.save(token);
      writeJson(response, 200, { ok: true, ...(await tokenStore.state()) }, { "cache-control": "no-store" });
    } catch (error) {
      respondError(response, error);
    }
  }, settings.allowedHosts);

  const forget = withOrigin(async (request: any, response: any) => {
    if (request.method !== "POST") {
      refuseMethod(response);
      return;
    }
    try {
      await tokenStore.forget();
      writeJson(response, 200, { ok: true, ...(await tokenStore.state()) }, { "cache-control": "no-store" });
    } catch (error) {
      respondError(response, error);
    }
  }, settings.allowedHosts);

  return [
    ctx.webServer.register({ kind: "exact", path: TOKEN_PATH, handler: save }),
    ctx.webServer.register({ kind: "exact", path: TOKEN_FORGET_PATH, handler: forget })
  ];
}
