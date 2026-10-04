/**
 * dsh-connect-modelscope-token-plan — Host 半边（thin router）。
 *
 * 读魔搭 API-Inference 的**本地用量**（上游没有余额接口，见 docs/SPIKE.md）
 * 并经一条只读 /api 路由喂给 Client 面板。重活都在专注的兄弟模块里，本文件
 * 只保留 Cordis 入口（name/inject/apply）、wiring 装配与卸载副作用：
 *
 *   - `host-config.ts`        配置契约 + isAdmitted 信任围栏
 *   - `routes.ts`             四条路由的门面（snapshot/models/token/probe）
 *   - `ms-auth.ts`            访问令牌存取（静态钥匙，无登录流）
 *   - `inference-client.ts`   模型目录（零额度）+ probe 调用（带分诊）
 *   - `usage-store.ts`        本地计数：天桶/单模型/事件流（原子写、版本守卫）
 *   - `snapshot-aggregate.ts` 快照聚合（软失败）
 *   - `state-store.ts`        状态文件原子原语
 *   - `codes.ts`              错误分类单一真源
 *
 * @module dsh-connect-modelscope-token-plan
 */
import { createTokenStore } from "./ms-auth.ts";
import { createFileUsageStore } from "./usage-store.ts";
import { createInferenceClient } from "./inference-client.ts";
import { profileSegment } from "./state-store.ts";
import { registerRoutes } from "./routes.ts";
import { resolveSettings, inject, name } from "./host-config.ts";
import { errMsg } from "./util.ts";
import type { HostDeps } from "./types.ts";

/**
 * Host 入口：装配 wiring、注册路由、挂卸载副作用。
 * @param ctx - Host 根上下文。
 * @param config - 行的原始 patch 配置（无 schema，未校验；坏配置以
 *   configError 经快照呈现，而不是在挂载时炸掉整台插件）。
 * @param deps - 测试缝（fetchImpl）。真实 Loader 不传。
 */
function apply(ctx: any, config: any = {}, deps: HostDeps = {}) {
  const { settings, configError } = resolveSettings(config);

  // 凭据服务是可选的：没有它的 Host 仍然有完整面板，令牌走 env / 内存
  // （重启即丢，快照的 token.ephemeral 会说明这一点）。
  const tokenStore = createTokenStore({
    credentials: () => ctx.get("credentials") ?? null
  });

  // 本地计数按 profile 分段（usage-store 注释里的裁定）；profile 取不到时
  // 退回共享目录，行为与旧 Host 一致。
  const profile = profileSegment(ctx);
  const usageStore = createFileUsageStore({
    name,
    profile,
    trendDays: settings.trendDays,
    maxEvents: settings.maxEvents,
    logger: ctx.logger
  });

  // 模型目录的 coalesced 缓存长在 inference-client 里（免认证目录不需要
  // 凭据换手失效——见 routes/token.ts 的注释）。
  const inference = createInferenceClient({
    settings,
    tokenStore,
    deps,
    logger: ctx.logger
  });

  const wiring = {
    settings,
    configError,
    tokenStore,
    usageStore,
    inference,
    logger: ctx.logger
  };

  const offs = registerRoutes(ctx, wiring);

  ctx.effect(() => {
    // 返回的是卸载清理：Cordis 在 fiber dispose 时跑它——提前跑会把刚注册的
    // 路由当场注销。
    return () => {
      for (const off of offs) {
        try {
          off?.();
        } catch (error) {
          ctx.logger?.warn?.(`${name}: route unregister failed: ${errMsg(error)}`);
        }
      }
    };
  }, `${name}: routes`);
}

export { apply, inject, name, resolveSettings };
