/**
 * 令牌路由：面板「接入」tab 保存 / 忘掉访问令牌。
 *
 * 存的是凭据引用（ms-auth TOKEN_REF / TOKEN_REF_INTERNATIONAL），不是新 kind。
 * 保存/忘掉后**不需要**失效任何缓存：模型目录免认证、probe 每次现 resolve 令牌
 * ——本插件没有「凭据换手后缓存还在替旧身份说话」的形态，这是免认证目录带来的
 * 结构性简化（SPIKE.md §结论 3）。
 *
 * **两个账户共享这两条路由**（拓扑修订）：请求体带可选 `region`（"cn" | "ai"），
 * 由账户池解析对应的 tokenStore。缺省/其它值一律按 "cn" 处理——老客户端（和本仓
 * 既有的全部离线用例）不带这个字段，行为与单账户时代逐字一致。刻意不新开
 * `/token/international` 路由：路由字面量集合由 test/panel.test.mjs §6/§6b 双向
 * 钉死，用请求体维度避免那一整套清单同步。
 * @module dsh-connect-modelscope-token-plan/routes/token
 */
import { TOKEN_PATH, TOKEN_FORGET_PATH } from "./paths.ts";
import { writeJson, refuseMethod, withOrigin, respondError, readJsonBodyOr400, readJsonBody, MAX_JSON_BODY_BYTES } from "./http.ts";
import type { Wiring } from "../types.ts";
import type { Region } from "../account-pool.ts";

/** 请求体里的 region 只认字面 "ai" 走国际，其余（含缺省）全归 CN——不让脏值选错账户。 */
function regionOf(body: Record<string, unknown>): Region {
  return body.region === "ai" ? "ai" : "cn";
}

/**
 * 注册令牌路由（POST /token 保存，POST /token/forget 忘掉）。
 *
 * 返回类型是本族唯一的一个**数组**：token 注册两条路由（save + forget），其余
 * 路由族各只注册一条、返回单个 off()。标注在**这里**而不是在 routes.ts 里对
 * 调用结果做 `as Array<() => void>` 断言——断言放在消费端等于把「这两条返回的是
 * 注销回调而不是 handler」这个约定藏起来，标注在产地才是声明。
 *
 * `accountPool` 取 `Partial`：production 装配必带它，但离线用例可能直接构造本路由
 * 而不带——那种情况下 "ai" 也安全回落到 CN 的 tokenStore（不抛、不误选账户）。
 */
export function registerTokenRoute(ctx: any, wiring: Pick<Wiring, "settings" | "tokenStore" | "logger"> & Partial<Pick<Wiring, "accountPool">>): Array<() => void> {
  const { settings, tokenStore, accountPool } = wiring;

  /** 该 region 的令牌出口：CN 直接用注入的 tokenStore（它就是账户池的 cn 那把）。 */
  const storeFor = (region: Region) =>
    region === "ai" && accountPool !== undefined ? accountPool.tokenStoreOf("ai") : tokenStore;

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
    const region = regionOf(body);
    try {
      const store = storeFor(region);
      await store.save(token);
      writeJson(response, 200, { ok: true, region, ...(await store.state()) }, { "cache-control": "no-store" });
    } catch (error) {
      respondError(response, error);
    }
  }, settings.allowedHosts);

  const forget = withOrigin(async (request: any, response: any) => {
    if (request.method !== "POST") {
      refuseMethod(response);
      return;
    }
    // 忘掉路由历史上不读 body（空 body 也合法），所以不能用 readJsonBodyOr400——
    // 那会对没有 body 的老请求先写一个 400。读不到就按 CN，保持单账户时代行为。
    const parsed = await readJsonBody(request, MAX_JSON_BODY_BYTES);
    const region = parsed.ok ? regionOf(parsed.value) : "cn";
    try {
      const store = storeFor(region);
      await store.forget();
      writeJson(response, 200, { ok: true, region, ...(await store.state()) }, { "cache-control": "no-store" });
    } catch (error) {
      respondError(response, error);
    }
  }, settings.allowedHosts);

  return [
    ctx.webServer.register({ kind: "exact", path: TOKEN_PATH, handler: save }),
    ctx.webServer.register({ kind: "exact", path: TOKEN_FORGET_PATH, handler: forget })
  ];
}
