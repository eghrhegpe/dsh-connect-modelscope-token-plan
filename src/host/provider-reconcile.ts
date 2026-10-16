/**
 * provider 注册的 **desired-state reconciler**——把两个各自为政的驱动收编成
 * 一个控制器。
 *
 * ## 它取代什么
 *
 * 改之前，往同一个注册态里写的有两个 driver：挂载 seed + 每 `pollSeconds`
 * 一次的目录轮询（`index.ts` 的 `runPoll`），以及四条 provider 路由的
 * 「保存后立即 publish」。两者没有共同的状态词汇表，于是 `runPoll` 不得不把
 * 窗口覆盖**读两遍**（fetch 前一次、fetch 后一次），「期间被改就跳过本轮」——
 * 那是没有 desired-state 控制器的典型补丁：丢一次更新、再等一个轮询周期。
 *
 * ## 模型
 *
 *   - **desired state**（操作者想要什么）= `providerStore` 里的开关 + 允许
 *     清单 + 窗口覆盖。它只有一个家，轮询和路由都只读它、不各写一份；
 *   - **reconcile 一遍** = 读 desired → 带窗口覆盖拉目录 → 复查 desired
 *     （fetch 期间被改就重跑，不等下一轮）→ 把「当前目录 + 当前清单」交给
 *     publisher（它自己重读开关，single source 不变）；
 *   - **触发方全部降级为「标记 dirty」**：挂载、轮询定时器、四条写路由。
 *     谁都不用记得「别人是不是也在 publish」——队列性质由本模块的串行链保证。
 *
 * ## 两个刻意的行为改变（相对旧 runPoll）
 *
 *   1. **fetch 失败不再发布空目录**。旧 `readEntries` 把 fetch 失败降级成
 *      `entries: []` 再 publish——一次瞬时的目录抖动会把已服务的模型全部撤下
 *      （破坏，不是重试）。这里失败只记原因、保留当前 offer，下一轮自然重试；
 *      轮询侧本来就该如此（旧 runPoll 正是这么做的），路由侧现在与它一致。
 *   2. **fetch 期间 desired 被改 → 重跑，不是跳过**。旧代码「跳过本轮、等
 *      pollSeconds」；这里原地收敛，保存路由的 await 返回时新值一定已落地。
 *
 * peer-free：不 import 任何 Host peer。
 *
 * @module dsh-connect-modelscope-token-plan/provider-reconcile
 */

import { resolveEnabledIds } from "./provider-store.ts";
import { errMsg, redactSecrets } from "./util.ts";
import { name } from "./host-config.ts";
import type { ResolvedSettings } from "./host-config.ts";

/** reconciler 读到的 wiring 子集（装配见 `index.ts`）。 */
export interface ProviderReconcilerDeps {
  /**
   * patch 配置。收敛本身不读它（开关裁决在 publisher 内，single source），留在
   * deps 里是为了与 wiring 的其他消费者同形状，也为了将来收敛要读 patch 默认
   * 时有处可读——删掉它只会让下一个加配置的人重新发明接线。
   */
  settings: ResolvedSettings;
  providerStore: {
    enabled: () => Promise<boolean | null>;
    enabledIds: () => Promise<string[] | null>;
    contextWindow: () => Promise<number | null>;
  };
  inference: {
    // 与 host-contextOptions 语义对齐：fetchModels 可携带全局窗口覆盖
    // （null = 跟随目录）。
    fetchModels: (contextWindow?: number | null) => Promise<{ entries?: unknown[]; [k: string]: unknown }>;
  };
  publisher: {
    state: { enabledIds: string[] };
    publish: (entries: unknown[], enabledIds: string[], unavailable?: string[]) => Promise<unknown>;
  };
  logger?: { warn?: (message: string) => void };
}

/** desired state 的一次快照：三个字段都来自 `provider.json`（panel 优先）。 */
interface Desired {
  enabled: boolean | null;
  enabledIds: string[] | null;
  contextWindow: number | null;
}

/**
 * 创建 provider reconciler。
 *
 * 串行链 + dirty 标志：每次触发（轮询/路由/挂载）都排在链尾，链上每一环先看
 * dirty 再决定要不要真跑——在途那一轮会替后来者消费 dirty，所以 N 次连续触发
 * 最多收敛成两遍 reconcile，不会排 N 遍。调用方 await 返回的 promise，即
 * 「我的触发已被消费」。
 * @param {ProviderReconcilerDeps} deps - wiring 子集。
 * @returns {{reconcile: () => Promise<void>}} 触发一次收敛。
 */
export function createProviderReconciler(deps: ProviderReconcilerDeps) {
  const { providerStore, inference, publisher, logger } = deps;

  /**
   * 读一次 desired。三路都 `.catch(() => null)`：读不到按「未设置」降级，
   * 与开关/清单/覆盖各自的读侧纪律一致——一次读失败不该把收敛打掉。
   * @returns {Promise<Desired>}
   */
  const readDesired = async (): Promise<Desired> => {
    const [enabled, enabledIds, contextWindow] = await Promise.all([
      providerStore.enabled().catch(() => null),
      providerStore.enabledIds().catch(() => null),
      providerStore.contextWindow().catch(() => null)
    ]);
    return { enabled, enabledIds, contextWindow };
  };

  /** desired 的稳定键：用于「fetch 期间被改了吗」的比对。 */
  const desiredKey = (desired: Desired): string =>
    JSON.stringify([desired.enabled, desired.enabledIds, desired.contextWindow]);

  /**
   * 收敛一遍：读 desired → 拉目录 → 复查 desired → publish。
   * @returns {Promise<void>}
   */
  const runOnce = async (): Promise<void> => {
    const before = await readDesired();
    let catalog: { entries?: unknown[] };
    try {
      catalog = await inference.fetchModels(before.contextWindow);
    } catch (error) {
      // 目录拉不到 ≠ 发布空目录：保留当前 offer，只留原因。两段失败分开记的
      // 纪律与旧 runPoll 相同（「目录拉到了但注册失败」与「目录根本没拉到」
      // 对操作员是完全不同的处置）；脱敏在收口处做。
      logger?.warn?.(
        `${name}: catalog fetch failed (${redactSecrets(errMsg(error))}) — the current offer stays registered; the next pass retries`
      );
      return;
    }
    // fetch 可能耗时数百毫秒，期间保存路由可能刚落一个新值——此时条目带的是
    // 旧窗口标，publish 会把刚保存的覆盖倒退回去。**置 dirty 让收敛环原地
    // 重跑**：不是「跳过本轮、等下一个 pollSeconds」（旧 runPoll 的补丁），
    // 保存路由 await 返回时新值一定已落地。注意这一遍**不 publish**——已知
    // 陈旧的 offer 发出去只会先churn一遍再被下一遍推翻。
    const after = await readDesired();
    if (desiredKey(after) !== desiredKey(before)) {
      dirty = true;
      return;
    }
    const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
    // 清单口径与快照/路由**共用** resolveEnabledIds：可读的落盘清单（含空清单
    // = 不过滤）优先，只有读抛错才回退内存里最近一次 publish 的那份。
    const enabledIds = resolveEnabledIds(after.enabledIds, publisher.state.enabledIds);
    try {
      await publisher.publish(entries, enabledIds, []);
    } catch (error) {
      // 收敛失败不影响面板：下一轮再试。原因不丢——「目录是当前的，只有注册
      // 没落地」对操作员是可处置的信息。
      logger?.warn?.(
        `${name}: publish failed (${redactSecrets(errMsg(error))}) — the catalog is current, only the provider registration did not land`
      );
    }
  };

  /** 串行链：每次触发排到链尾；在途那一轮替后来者消费 dirty。 */
  let chain: Promise<void> = Promise.resolve();
  /** 有新触发待消费。闭包状态，不暴露——触发方只看得见 {@link reconcile}。 */
  let dirty = false;

  /**
   * 触发一次收敛。幂等且可重入：在途时只置 dirty，由在途那一轮替本调用消费
   * （N 次连续触发最多收敛成两遍 reconcile，不会排 N 遍）。
   * @returns {Promise<void>} 本触发已被消费（注册态已反映 desired）后 resolve。
   */
  const reconcile = (): Promise<void> => {
    dirty = true;
    const result = chain = chain.then(async () => {
      let guard = 0;
      while (dirty) {
        dirty = false;
        await runOnce();
        // 收敛理论上应终止；guard 是「desired 每秒都在变」的极端情况下的
        // 保险丝——让位给下一轮触发，而不是把链堵死。
        if (++guard > 100) break;
      }
    });
    return result;
  };

  return { reconcile };
}
