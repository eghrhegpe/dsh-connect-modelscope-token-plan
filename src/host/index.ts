/**
 * dsh-connect-modelscope-token-plan — Host 半边（thin router）。
 *
 * 读魔搭 API-Inference 的**本地用量**，并把它与官方魔粒余额一起经一条只读 /api
 * 路由喂给 Client 面板。口径分工：推理响应**不携带**额度头（SPIKE.md §结论 1），但
 * 官方另有魔粒余额端点（`GET {siteBase}/openapi/v1/magicubes/balance`，SPIKE.md
 * 文首后记，2026-10-04 实测可用），面板头条读的是它；本文件下的兄弟模块只负责本地
 * 计数那一半（按模型分布 / 本地趋势 / 429 事件流），回答官方余额答不了的问题。
 * 重活都在专注的兄弟模块里，本文件
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
import { createFileProviderStore, resolveEnabledIds } from "./provider-store.ts";
import { createFileDrawStore } from "./draw-store.ts";
import { registerDrawTool } from "./draw-register.ts";
import { resetDrawToolNote } from "./draw-tool-state.ts";
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
 * @param deps - 测试缝（`HostDeps`：fetchImpl / getLlm / emit / credentials / env
 *   与出图那两条）。真实 Loader 不传；**每个缝不传时都必须落回 ctx 或全局默认**，
 *   产品行为零漂移。声明与接线由 `test/deps-wiring.test.mjs` 双向扫描守着。
 */
function apply(ctx: any, config: any = {}, deps: HostDeps = {}) {
  const { settings, configError } = resolveSettings(config);

  // 凭据服务是可选的：没有它的 Host 仍然有完整面板，令牌走 env / 内存
  // （重启即丢，快照的 token.ephemeral 会说明这一点）。
  //
  // `credentials` / `env` 都走 deps 缝，而不是硬连 ctx / process.env：
  //   - `env` 那条路一旦连到宿主环境，测试进程就会继承开发机上那把**真实令牌**，
  //     把「应当没有令牌」的断言顶成绿不了的红（详见 types.ts 的 env 注释）；
  //   - `credentials` 同理：不接线的话，测试注入的假凭据服务会被静默忽略，测的
  //     还是 ctx 里那份——比没有这个缝更糟，因为它让人以为自己覆盖了。
  // 不传 deps 时两者都落回 ctx / process.env，产品行为零漂移。
  const tokenStore = createTokenStore({
    credentials: deps.credentials !== undefined ? deps.credentials : () => ctx.get("credentials") ?? null,
    env: deps.env
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

  // 出图开关的持久层。（与 provider 开关同一个 profile 分段纪律；两个开关独立。）
  const drawStore = createFileDrawStore({ profile, logger: ctx.logger });
  const publisher = createProviderPublisher({
    settings,
    panelSwitch: () => providerStore.enabled(),
    // 同上：缝不接线就是纸面的。测试注入的 getLlm / emit 必须真的被用上。
    getLlm: deps.getLlm ?? ((service: string) => ctx.get?.(service) ?? null),
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
    emit: deps.emit ?? ((event: string) => ctx.emit?.(event)),
    logger: ctx.logger
  });

  /**
   * 当前允许清单：落盘优先，读不到回退内存最近一次 publish 的清单。
   *
   * 判据与另外两个消费者（`snapshot-aggregate.ts` 的面板块、`routes/provider.ts`
   * 的 GET）**共用** {@link resolveEnabledIds}——空清单是「不过滤，提供全部模型」，
   * 那是 provider-store 的契约，不是「没有答案」。本函数曾经自己写成
   * `stored.length > 0` 才算数，于是**可读的空清单**（操作者按 versionNote 的建议
   * 删掉 provider.json，或清单被保存为空）会让面板说 all、轮询却继续按内存里的旧
   * 清单注册：面板与 Host 对「正在提供什么」各说一套。只有读**抛错**（`.catch`
   * → null）才回退内存。
   * @returns {Promise<string[]>}
   */
  const currentEnabledIds = async (): Promise<string[]> =>
    resolveEnabledIds(
      await providerStore.enabledIds().catch(() => null),
      publisher.state.enabledIds
    );

  /**
   * 一次目录轮询：拉目录，再 publish 当前 offer。
   *
   * 清单在 `fetchModels()` **之后**读（不是之前）——目录拉取可能耗时数百毫秒，
   * 期间用户可能保存了新清单；读放在 fetch 之后、publish 之前，能捕获这段窗口
   * 内的编辑。这是刻意的顺序，不是疏忽。
   * @returns {Promise<void>}
   */
  const runPoll = async (): Promise<void> => {
    // 轮询失败不影响面板：下一轮再试，快照侧另有降级形状。但**原因不能丢**——
    // 目录持续拉不到时，面板只会看到 models.available:false，没有任何一行说清是
    // 上游拒了、还是网络断了、还是令牌过期；那条可观测性只能靠这里。两段**分开**
    // 记：「目录拉到了但注册失败」与「目录根本没拉到」对操作员是完全不同的处置，
    // 合成一条 "poll failed" 就把可诊断信息抹掉了。
    // 脱敏在收口处做（与 snapshot-aggregate 的 soft() 同一纪律），不靠上游自觉。
    let catalog: Awaited<ReturnType<typeof inference.fetchModels>> | null = null;
    try {
      catalog = await inference.fetchModels();
    } catch (error) {
      ctx.logger?.warn?.(
        `${name}: catalog fetch failed (${redactSecrets(errMsg(error))}) — the next poll retries; the panel keeps its degraded models block`
      );
      return;
    }
    try {
      await publisher.publish(catalog.entries, await currentEnabledIds(), []);
    } catch (error) {
      ctx.logger?.warn?.(
        `${name}: publish failed (${redactSecrets(errMsg(error))}) — the catalog is current, only the provider registration did not land`
      );
    }
  };

  const wiring = {
    settings,
    configError,
    tokenStore,
    usageStore,
    inference,
    providerStore,
    drawStore,
    publisher,
    logger: ctx.logger
  };

  const offs = registerRoutes(ctx, wiring);
  ctx.effect(() => {
    // M4 seed：挂载时立即跑一次轮询，让重启的 Host 在第一次目录拉到后就有模型，
    // 且**用落盘的允许清单**注册（而非空清单）——见 fix A/C。读不到目录就等下一轮
    // 轮询；开关/清单保存在 provider-store，provider 路由直接 publish。
    void runPoll();

    // 出图工具（opt-in，默认关）：与 provider 注册是**两条独立的开关**——「把魔搭
    // 当 chat provider」和「给 agent 一个出图工具」回答的是不同问题，合并没有好处。
    //
    // 注册时机承重：**工具注册不可撤销**（peer 的 tools registry 没有 unregister），
    // 所以这里只在挂载时尝试一次，且 `isDisposed` 闸住已在途的调用。开关在挂载后
    // 翻转要到下次 Host 启动才生效——这正是 sensenova 那份的面板文案也要说明的事。
    void registerDrawTool(ctx, wiring, deps);

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
      // 出图工具的缺席原因只对**本次挂载**有意义：清掉，下一个生命周期从干净的
      // 「未登记」开始（否则一次成功挂载后会残留上一轮的缺席原因）。
      resetDrawToolNote();
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
