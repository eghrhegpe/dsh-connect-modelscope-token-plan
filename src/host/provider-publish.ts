/**
 * 魔搭 provider 的**发布状态机**——接入 DSH 的 control-plane 半边。
 *
 * 三条承重语义，每条都被一条必须继续绿的测试钉住：
 *   - publish 队列把每一次 publish 排到所有在途 publish 之后，慢 publish 不能被
 *     快 publish 覆盖（队列语义见 `publish-core.ts` 的 `createPublishQueue`）；
 *   - `disposed` 闸拦住 dispose 之后才到的 publish，不让它注册进一个已经撤下本
 *     插件的 Host；
 *   - 单点 `registerPair`（带 factory-await + shape 检查）被 publish 与 rollback
 *     两条路共用；失败时**恢复旧对**，坏 publish 不会把已在服务的模型也拉下来。
 *
 * 与姊妹插件的差异**只有**：工厂导出名 `"createModelScopeAdapter"`、`registerPair`
 * 用的 `LLM_PROVIDER_ID`/`LLM_DISPLAY_NAME`、`warnBuildFailure` 的 label
 * `"ModelScope"`。上面的四条语义原样保留——它们是 `publish-core.ts` 的骨头。
 *
 * peer-free：不 import 任何运行时 peer。适配器工厂由调用方注入
 * （`loadAdapterModule`，默认 `import("./llm-adapter.ts")`），所以离线套件可以换
 * 一个假工厂而不碰 Host 的 node_modules。
 *
 * 跨切面行为指路：目录变化 / 开关翻转 / 清单保存 → 重注册 = `index.ts` 轮询
 * publish + provider 路由 handler。
 *
 * @module dsh-connect-modelscope-token-plan/provider-publish
 */

import { LLM_PROVIDER_ID, LLM_DISPLAY_NAME, isVisionModel } from "./llm-models.ts";
import type { CatalogEntry } from "./llm-models.ts";
import type { UsageSinks } from "./usage-observer.ts";
import { str } from "./util.ts";
import { resolveSwitchEnabled } from "./switch-precedence.ts";
import {
  createPublishQueue,
  createPairReleaser,
  createAdapterFactoryResolver,
  registerProviderPair,
  isBuiltAdapter,
  BAD_FACTORY_SHAPE_ERROR,
  describeBuildFailure,
  warnBuildFailure,
  swapRegistration,
  resolveRegistrationService,
  unregister
} from "./publish-core.ts";
import type { PublisherStateBase } from "./publish-core.ts";

/**
 * `createProviderPublisher` 的输入依赖。刻意内联（本插件的 `types.ts` 只承载
 * 「多个模块都要念的名字」，这一条是 publisher 自己读的接缝）。
 */
interface ProviderPublisherDeps {
  settings?: { registerProvider?: boolean; apiBase?: string };
  panelSwitch?: () => Promise<boolean | null>;
  loadAdapterModule?: () => Promise<object>;
  getLlm?: (service: string) => object | null;
  resolveApiKey?: () => Promise<string>;
  /**
   * 本地计数的写入口，透传给适配器工厂（`usage-observer.ts`）。
   *
   * 缺省即「不套观察层」——那正是 M4 之前的状态：面板四块计数面板恒为 0 与空。
   * 它是 deps 而非模块内构造：usage-store 由 `index.ts` 按 profile 创建，观察
   * 层必须写进**同一个** store，否则面板读的是另一个目录的账。
   */
  usage?: UsageSinks;
  emit?: (event: string) => void;
  logger?: { warn?: (m: string) => void };
}

/** 魔搭 publisher 的活状态：共享注册字段 + 这条上游 rollback 时读的目录/清单事实。 */
export interface ProviderPublisherState extends PublisherStateBase {
  /** 当前注册所依据的目录条目。 */
  entries: any[];
  /** 注册时刻的允许清单（空 = 全部模型）。 */
  enabledIds: string[];
  /** 上次发布给 picker 的额度耗尽模型 id。 */
  unavailableIds: string[];
  /** 已提供集合的廉价签名（目录 ids + vision 位 + 允许清单）。 */
  signature: string;
  /** 额度耗尽集合的廉价签名；某个池过零时翻转。 */
  quotaSignature: string;
}

/**
 * provider 发布器。
 *
 * 持有活注册状态（`state`）；publish 队列、`disposed` 闸与单点 `registerPair` 是
 * `publish-core.ts` 共享的骨头。调用方从挂载 seed、目录轮询、provider 开关、roster
 * 保存来驱动 `publish`，从 `ctx.effect` 的 teardown 调 `dispose`。
 *
 * `getLlm` 解析器是**函数**不是快照：`llm` 服务可能在本插件挂载后才与 Host 注册
 * ——与 `credentials` 的「解析器而非快照」同一套。
 *
 * @param {ProviderPublisherDeps} [deps]
 * @returns {{
 *   state: ProviderPublisherState,
 *   publish: (entries: object[], enabledIds: string[],
 *             unavailableModelIds?: string[]) => Promise<object>,
 *   release: () => void,
 *   dispose: () => void,
 *   isDisposed: () => boolean
 * }}
 */
export function createProviderPublisher(deps: ProviderPublisherDeps = {}) {
  const {
    settings,
    panelSwitch,
    loadAdapterModule,
    getLlm,
    resolveApiKey,
    usage,
    emit,
    logger
  } = deps;
  const effectiveSettings = settings ?? {};
  const effectivePanelSwitch = panelSwitch ?? (async () => null);
  const effectiveLoadAdapterModule = loadAdapterModule ?? (() => import("./llm-adapter.ts"));
  const effectiveGetLlm = getLlm ?? (() => null);
  const effectiveResolveApiKey = resolveApiKey ?? (async () => "");
  // `emit` 刻意不在这里给默认值。publish 路径把原始（可能缺席的）`ctx.emit` 传
  // 给 `publish-core`，其 `emitAdaptersUpdated` 同时兼容缺席与拒绝的发射器——本地
  // 塞一个 no-op 顶多掩盖错误，加不了安全。
  const effectiveLogger = logger ?? { warn: () => {} };

  /**
   * 活注册状态。一个普通对象，调用方以 `state` 读它（快照的 provider 块从上面取
   * `registered`/`error`）。release 函数住在这里而不是作为返回值，是因为在注册
   * 已完成后才抛的注册也必须能被拿到——否则适配器会比插件活得久（见
   * `registerPair`）。
   */
  const state: ProviderPublisherState = {
    entries: [],
    enabledIds: [],
    unavailableIds: [],
    signature: "",
    quotaSignature: "",
    /** 是否有应答 `registerAdapter` 的 `llm` 服务。 */
    llmAvailable: false,
    /** 我们的 provider 对当前是否已无错注册。 */
    registered: false,
    /** 最近一次注册错误，经快照脱敏呈现。 */
    error: null,
    releaseAdapter: null,
    releaseDirectory: null,
    /** 当前 release 函数所属于的已构建适配器。 */
    built: null
  };

  /** publish 队列与 `disposed` 闸——三条承重语义里的前两条，都在 `publish-core.ts`。 */
  const queue = createPublishQueue();

  /** 解析 peer-dependent 适配器工厂，只解析一次并 memoize。 */
  const resolveAdapterFactory = createAdapterFactoryResolver(
    effectiveLoadAdapterModule,
    "createModelScopeAdapter"
  );

  /** 释放已注册的 provider 对。释放函数在 Host 里是幂等的。 */
  const release = createPairReleaser(state);

  /**
   * 把一个构建好的适配器交给 llm 服务，并把它的 release 函数记到 `target` 上。
   *
   * 函数体是共享的 `registerProviderPair`——所有 publisher、两条路径共用一份；
   * 这个包装只补上「这行是给哪个 provider 的」。
   * @param {object} llm - 注册服务。
   * @param {{providerIds: string[], adapter: unknown}} built - 要注册的东西。
   * @param {object} target - release 函数要记到哪（`state`）。
   * @returns {void}
   */
  const registerPair = (llm: { registerAdapter: (providerIds: string[], adapter: unknown) => () => void; registerConfigurableProviders?: (rows: object[]) => () => void }, built: { providerIds: string[]; adapter: unknown }, target: PublisherStateBase) => registerProviderPair(llm, built, target, {
    providerId: LLM_PROVIDER_ID,
    displayName: LLM_DISPLAY_NAME
  });

  /**
   * 为一个目录/允许清单快照（重）构建并注册 provider。
   *
   * 重建并重注册而非原地改：`PiAiAdapter` 内部 memoize profiles 快照，只有新的注册
   * 才能改变提供的模型列表。注册失败时**恢复上一对**，所以坏 publish 永远不能把
   * 已在服务的模型拉下来。
   * @param {object[]} entries - 归一目录条目。
   * @param {string[]} enabledIds - 允许清单（空 = 全部）。
   * @param {string[]} [unavailableModelIds] - 要从 picker 的 offer 里丢掉的额度耗尽 id。
   * @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
   */
  const publishProviderOnce = async (entries: unknown, enabledIds: unknown, unavailableModelIds: string[] = []) => {
    // 插件 dispose 之后才到的 publish，会把 provider 注册进一个已经撤下本插件的
    // Host：没有主人、没有 release，屏幕上也没说它从哪来。
    if (queue.isDisposed()) return { ok: false, skipped: true };
    const previousBuilt = state.built;
    const previousEntries = state.entries;
    const previousEnabledIds = state.enabledIds;
    const previousUnavailable = state.unavailableIds;
    // 三个领域字段在查询开关**之前**写入，下面的开关关分支刻意不回滚它们。这个
    // 不对称是承重的，不是疏忽：`routes/provider.ts` 与 roster 保存会在开关重新
    // 打开时正好从这些字段重新 publish，所以用户的允许清单编辑与最后一次拉到的
    // 目录**必须**熬过关闭期。把 `previous*` 还回去会静默丢掉两者——开关关闭期间
    // 做的保存，会在开关重新打开时消失。`swapRegistration` 的 `onRollback` 会还
    // 它们，但只对注册真的抛了的路径——那种失败必须让先前在服务的
    // 对继续服务，这是与「开关关着」不同的承诺。
    state.entries = Array.isArray(entries) ? entries : [];
    state.enabledIds = Array.isArray(enabledIds) ? enabledIds : [];
    state.unavailableIds = Array.isArray(unavailableModelIds) ? unavailableModelIds : [];
    // Opt-in：开关关着时不能留下某一行把它翻关之后才注册的 registration。有效开关
    // 是 panel 优先（`provider-store.ts`），回退到 patch 值——这里每次 publish 重读，
    // 所以翻转不用重启就生效。
    const panelValue = await effectivePanelSwitch().catch(() => null);
    // `effectiveSettings` may be a bare `{}` (no settings passed, the tests), so
    // an absent patch default reads as "not registered" — never a crash.
    const registerWanted = resolveSwitchEnabled(panelValue, effectiveSettings.registerProvider === true);
    if (!registerWanted) {
      // 空转守卫：开关关着、且上次也确实没注册、签名也没漂（offer 没变），就别跑
      // unregister——否则每个轮询周期都做一次无意义（且会发 llm/adapters-updated
      // 事件的）注销。见 fix B：签名比对让「目录没变」的轮询不再 churn。
      if (state.registered === false && state.error === null &&
          state.signature === catalogSignature(state.entries, state.enabledIds) &&
          state.quotaSignature === quotaSignatureOf(state.unavailableIds)) {
        return { ok: true, skipped: true };
      }
      const result = unregister({ state, release });
      syncSignaturesAfterPublish(state); // 让下次开关内轮的空转判断有正确基准
      return result;
    }
    const llm = resolveRegistrationService({ state, getLlm: effectiveGetLlm, release });
    if (llm === null) return { ok: false, error: state.error };
    let createModelScopeAdapter;
    let built;
    try {
      createModelScopeAdapter = await resolveAdapterFactory();
      // 用 await 而不是假设同步：factory 一旦变成 async，就会把一个 Promise 交给
      // `registerAdapter`，Host 于是被提供一个 adapter 为 `undefined` 的 provider——
      // 一种表现为模型路由坏掉、离它的成因很远的失败。
      if (createModelScopeAdapter === undefined) throw new Error(BAD_FACTORY_SHAPE_ERROR);
      built = await createModelScopeAdapter({
        entries: state.entries,
        enabledIds: state.enabledIds,
        baseUrl: effectiveSettings.apiBase,
        resolveApiKey: effectiveResolveApiKey,
        get: effectiveGetLlm,
        unavailableModelIds: state.unavailableIds,
        // 观察层缺席即不套（`exactOptionalPropertyTypes` 下条件展开，不能传
        // undefined 让它与「显式无观察层」变成两件事）。
        ...(usage !== undefined ? { usage } : {})
      });
      // 同一个理由，换个说法：适配器是 Host 级注册的，所以 factory 返回别的形状
      // 必须在这里失败，而不是发布一个无法服务请求的 provider。
      if (!isBuiltAdapter(built)) throw new Error(BAD_FACTORY_SHAPE_ERROR);
    } catch (e) {
      // 缺失 llm peer 会以 Node 的 ERR_MODULE_NOT_FOUND 出现在抛出的值上（可能根本
      // 不是插件 Error）——共享的 describer 读它、脱敏消息、补上补救办法。
      const described = describeBuildFailure(e);
      state.error = described.note;
      warnBuildFailure(effectiveLogger, "ModelScope", described);
      return { ok: false, error: described.error };
    }
    // 空转守卫（注册路径）：开关开着、且 offer 与失败状态都没变——这次 publish 与上
    // 次重建出来的结果完全一致——就**不要重建** provider 对（否则每轮询周期都摘下再
    // 挂上同一个对，期间任何在途请求可能被打断）。见 fix B。注意只在「已成功注册」
    // 且「无错误」时跳过；失败态必须继续尝试重注册自愈。
    if (state.registered === true && state.error === null &&
        state.signature === catalogSignature(state.entries, state.enabledIds) &&
        state.quotaSignature === quotaSignatureOf(state.unavailableIds)) {
      return { ok: true, skipped: true };
    }
    // swap（连同背后的 rollback）是共享机制：失败的重新注册必须恢复先前在服务的对。
    // 在这边被恢复的是目录身份——entries、允许清单与额度耗尽集合（不能还指着一个
    // 我们没能发布的集合）。
    const result = swapRegistration({
      llm,
      built,
      previousBuilt,
      state,
      release,
      registerPair,
      emit,
      onRollback: () => {
        state.entries = previousEntries;
        state.enabledIds = previousEnabledIds;
        state.unavailableIds = previousUnavailable;
      }
    });
    // 成功的 publish 之后同步签名（与轮询用的公式同源，由 syncSignaturesAfterPublish
    // 内部调用导出的 catalogSignature/quotaSignatureOf，不会漂移）。失败的 publish 上
    // onRollback 已经恢复了之前的字段，这里同步的也是恢复后的正确基准。
    syncSignaturesAfterPublish(state);
    return result;
  };

  /**
   * publish，排到所有其他在途 publish 之后。
   *
   * 包装的存在是为了没有任何调用方要记得队列：挂载 seed、目录轮询、provider 开关、
   * roster 保存都走同一条临界区，它们任何一个与另一个竞争就是上面的 bug。
   * @param {object[]} entries - 归一目录条目。
   * @param {string[]} enabledIds - 允许清单（空 = 全部）。
   * @param {string[]} [unavailableModelIds] - 额度耗尽的模型 id。
   * @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
   */
  const publish = (entries: unknown, enabledIds: unknown, unavailableModelIds: string[] = []) =>
    queue.enqueue(() => publishProviderOnce(entries, enabledIds, unavailableModelIds));

  /**
   * 标记 publisher 已 dispose：之后（或在途的）任何 publish 都变成 no-op，不能注册
   * 进一个已撤下的 Host。
   */
  const dispose = () => queue.dispose();

  return {
    state,
    publish,
    release,
    dispose,
    // 暴露出来让调用方读某次 publish 是否因 dispose 被跳过（挂载 seed 据此保持安静）。
    isDisposed: () => queue.isDisposed()
  };
}

/**
 * 从持久化的开关/清单 seed 注册，让重启的 Host 在第一次轮询之前就有模型。
 *
 * Fire-and-forget：读不到状态目录就等第一次轮询。
 * @param {Pick<ReturnType<typeof createProviderPublisher>, "state" | "publish">} publisher
 *   - seed 只会碰到的两个成员。
 * @param {() => Promise<object[]>} listCatalog - 读持久化目录条目。
 * @param {() => Promise<string[]>} listEnabled - 读持久化允许清单。
 * @param {(entries: object[], enabledIds: string[]) => string} signatureOf - 廉价签名。
 */
export function seedPublisherFromCatalog(publisher: Pick<ReturnType<typeof createProviderPublisher>, "state" | "publish">, listCatalog: () => Promise<object[]>, listEnabled: () => Promise<string[]>, signatureOf: (entries: object[], enabledIds: string[]) => string) {
  return (async () => {
    try {
      const [stored, storedEnabled] = await Promise.all([
        listCatalog(),
        listEnabled()
      ]);
      publisher.state.signature = signatureOf(stored, storedEnabled);
      await publisher.publish(stored, storedEnabled, []);
    } catch {
      // 没有 seed 目录：第一次成功的轮询会 publish。
    }
  })();
}

/**
 * 一份 provider 注册会提供的模型集合的廉价签名。
 *
 * 它只回答「重建会不会改变什么」：目录顺序里的模型 id，每个带上 descriptor 用的
 * 同一个 vision 判定（id 没变但模态翻了也必须重建），加上允许清单。目录条目里其他
 * 东西变了不影响注册的 offer。
 * @param {object[]} entries - 归一目录条目。
 * @param {string[]} enabledIds - 允许清单（空 = 全部）。
 * @returns {string}
 */
export function catalogSignature(entries: unknown, enabledIds: unknown): string {
  // 覆盖「重建会不会改变 offer」的每一个维度：id（模型在不在）+ vision 位（是否吃图，
  // 用与 roster/descriptor 完全相同的判定）+ 展示名 + 上下文窗口 + 单次输出上限
  // （三者任一变了，descriptor 形状就变了）。id 没变但任一属性翻了也必须重建。
  const models = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const e = entry as CatalogEntry;
      const id = str(e?.id, "");
      const vision = isVisionModel(e) ? 1 : 0;
      const name = str(e?.name, id);
      const ctx = typeof e?.contextWindow === "number" ? e.contextWindow : "";
      const out = typeof e?.maxOutputLength === "number" ? e.maxOutputLength : "";
      return `${id}:v${vision}:n${name}:c${ctx}:o${out}`;
    })
    .join(",");
  return `${models}|${(Array.isArray(enabledIds) ? enabledIds : []).join(",")}`;
}

/**
 * 额度不可用集合的签名：轮询的「耗尽集合变没变」信号。
 *
 * 导出是为了让轮询路径与 {@link syncSignaturesAfterPublish} 无法漂移——它们以前把
 * 这个公式各写一遍（`[...ids].sort().join(",")`），正是那种一对会被碰一下就走样的
 * 组合，失败方式是静默的：两边不再看到对方的 publish，注册要么每次轮询都 churn，
 * 要么再也不重建。构造上与顺序无关（排序过），所以两个相等的集合永远产出同一个
 * 字符串。
 * @param {string[]} unavailableIds - 耗尽的模型 id。
 * @returns {string}
 */
export function quotaSignatureOf(unavailableIds: string[]): string {
  return [...unavailableIds].sort().join(",");
}

/**
 * 按 publisher 刚发布出去的 offer 重算 state 的 `signature` 与 `quotaSignature`。
 *
 * 在每次绕开轮询变更检测的**直接** publish 之后调用：那两个字段是轮询的「offer 变没
 * 变」信号，所以它们必须跟着实际提供的东西走，否则下一次轮询会无谓地 churn（重建）
 * 注册。这里的公式与轮询用的**相同**——它们就是被导出的函数，不是抄一份——所以
 * 两者不会漂移。只在成功的 publish 之后有意义：失败的 publish 上，调用方的 rollback
 * 已经恢复了之前的字段。
 * @param {{entries?: unknown, enabledIds?: unknown, unavailableIds?: unknown,
 *          signature: string, quotaSignature: string}} state - `publisher.state`。
 */
export function syncSignaturesAfterPublish(state: { entries?: unknown; enabledIds?: unknown; unavailableIds?: unknown; signature: string; quotaSignature: string }) {
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const enabledIds = Array.isArray(state.enabledIds) ? state.enabledIds : [];
  const unavailable = Array.isArray(state.unavailableIds) ? state.unavailableIds : [];
  state.signature = catalogSignature(entries, enabledIds);
  state.quotaSignature = quotaSignatureOf(unavailable);
}