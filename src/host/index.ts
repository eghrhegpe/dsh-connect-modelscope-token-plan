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
 *   - `usage-observer.ts`     真实对话 → 本地计数/事件（观察流出口，见该文件头）
 *
 * @module dsh-connect-modelscope-token-plan
 */
import { createTokenStore } from "./ms-auth.ts";
import { createFileUsageStore } from "./usage-store.ts";
import { createInferenceClient } from "./inference-client.ts";
import { createFileProviderStore } from "./provider-store.ts";
import { createProviderPublisher } from "./provider-publish.ts";
import { profileSegment } from "./state-store.ts";
import { registerRoutes } from "./routes.ts";
import { resolveSettings, inject, name } from "./host-config.ts";
import { errMsg, redactSecrets } from "./util.ts";
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

  // ── M4：把魔搭接入 DSH 作为 LLM provider ──
  // 面板开关持久层（provider-store，按 profile 分段：回答「这个 profile 要不要
  // 接入」，两个 profile 不能互相覆盖）与注册状态机（provider-publish：publish
  // 队列 / disposed 闸 / registerPair 单点 + rollback 恢复旧对）。`getLlm` 与
  // `emit` 都传**函数**而非快照——llm 服务可能在本插件挂载之后才注册（与
  // credentials 同一个「resolver-not-snapshot」模式）。
  const providerStore = createFileProviderStore({ profile, logger: ctx.logger });
  const publisher = createProviderPublisher({
    settings,
    panelSwitch: () => providerStore.enabled(),
    getLlm: (service: string) => ctx.get?.(service) ?? null,
    resolveApiKey: async () => (await tokenStore.resolve()).value,
    // 本地计数的唯一生产者：DSH 真实对话经适配器出去时，每一次调用与每一条
    // 429/错误事件都写进上面那个 usage-store（面板四块计数面板的**唯一**数据
    // 来源——probe 那条写入路径已随目录表删除）。写同一个 store 实例，所以面板
    // 读到的就是这里写的账，不会分叉到另一个 profile 目录。
    //
    // 两条都吞错：观测失败不是对话失败（`usage-observer.safe` 也再兜一层）。
    usage: {
      recordCall: (input) => usageStore.recordCall({ modelId: input.modelId, tokens: input.tokens }).catch(() => {}),
      recordEvent: (input) => usageStore.recordEvent(input).catch(() => {})
    },
    emit: (event: string) => ctx.emit?.(event),
    logger: ctx.logger
  });

  /**
   * 当前允许清单：落盘优先，读不到回退内存最近一次 publish 的清单。
   *
   * 清单是**落盘**的（provider-store 按 profile 分段持久化），重启后内存里的
   * `publisher.state.enabledIds` 早已清空——若只从它读，用户勾选的清单会随
   * 重启静默丢失（见 fix A）。反过来，磁盘损坏/未初始化时回退内存值，不让
   * 一次坏读把清单清成空（空清单 = 提供全部模型，比没有清单更危险）。
   * @returns {Promise<string[]>}
   */
  const currentEnabledIds = async (): Promise<string[]> => {
    const stored = await providerStore.enabledIds().catch(() => null);
    if (Array.isArray(stored) && stored.length > 0) return stored;
    return Array.isArray(publisher.state.enabledIds) ? publisher.state.enabledIds : [];
  };

  /**
   * 一次目录轮询：拉目录，再 publish 当前 offer。
   *
   * 清单在 `fetchModels()` **之后**读（不是之前）——目录拉取可能耗时数百毫秒，
   * 期间用户可能保存了新清单；读放在 fetch 之后、publish 之前，能捕获这段窗口
   * 内的编辑。这是刻意的顺序，不是疏忽。
   * @returns {Promise<void>}
   */
  const runPoll = async (): Promise<void> => {
    try {
      const catalog = await inference.fetchModels();
      await publisher.publish(catalog.entries, await currentEnabledIds(), []);
    } catch {
      // 轮询失败不影响面板：下一轮再试，快照侧另有降级形状。
    }
  };

  const wiring = {
    settings,
    configError,
    tokenStore,
    usageStore,
    inference,
    providerStore,
    publisher,
    logger: ctx.logger
  };

  const offs = registerRoutes(ctx, wiring);

  ctx.effect(() => {
    // M4 seed：挂载时立即跑一次轮询，让重启的 Host 在第一次目录拉到后就有模型，
    // 且**用落盘的允许清单**注册（而非空清单）——见 fix A/C。读不到目录就等下一轮
    // 轮询；开关/清单保存在 provider-store，provider 路由直接 publish。
    void runPoll();

    // 目录轮询：每 `pollSeconds` 一次，拉目录、读落盘清单、`publish`。变化检测在
    // `publishProviderOnce` 内按 `catalogSignature` 比对——未变则空转不重建
    // （见 fix B）；开关翻转、清单保存由 provider 路由直接 publish，不在这里。
    const timer = setInterval(() => {
      void runPoll();
    }, settings.pollSeconds * 1000);

    // 返回的是卸载清理：Cordis 在 fiber dispose 时跑它——提前跑会把刚注册的
    // 路由当场注销。
    return () => {
      clearInterval(timer);
      // 顺序承重：先 dispose（闸住后续 publish，不再注册进已撤下本插件的 Host），
      // 再 release（摘掉已注册的 provider 对）。
      publisher.dispose();
      publisher.release();
      for (const off of offs) {
        try {
          off?.();
        } catch (error) {
          ctx.logger?.warn?.(`${name}: route unregister failed: ${redactSecrets(errMsg(error))}`);
        }
      }
    };
  }, `${name}: routes`);
}

export { apply, inject, name, resolveSettings };
