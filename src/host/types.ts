/**
 * Host 半边的公共类型。刻意小：只放「多个模块都要念的名字」。
 * @module dsh-connect-modelscope-token-plan/types
 */
import type { CodeValue } from "./codes.ts";

/**
 * `pluginError` 的运行时产物：带稳定 `code` 的 Error，附可选结构化字段
 * （面板与 trace 读）。字段是挂上去的，不是继承——结构标注，不是子类。
 */
export type PluginError = Error & {
  code: CodeValue;
  retryAfterMs?: number;
  detail?: string;
};

/**
 * `apply()` 的测试缝：真实 Loader 不传任何东西，测试用它替换 peer 模块、fetch
 * 与可选服务。**每个字段都必须在 `index.ts` 里真的被读到**——声明了不接线的缝
 * 比没有更坏：注入被静默忽略，测试以为自己覆盖了，其实测的还是 ctx 里那份。
 *
 * 2026-10-16 接线审计（同类漂移的第三例）：本接口曾声明 5 个缝，其中
 * `credentials` / `getLlm` / `emit` 三个从未被读取（`index.ts` 硬编码走 ctx），
 * `pollMs` 描述的是一个根本不存在的机制（注释自己写着"轮询实际取
 * settings.pollSeconds"）。现在前三个接上、`pollMs` 删除（留着只会让人以为它
 * 能用——与当年移除 `dailyQuotaTotal` 同一条纪律），并把**实际在用却从未声明**
 * 的 `loadToolsModule` / `drawFetch` 补进来（此前靠 `deps: any` 绕过类型）。
 *
 * 「谁声明了没接线」由 `test/deps-wiring.test.mjs` 扫描，不靠记性。
 */
export interface HostDeps {
  fetchImpl?: typeof fetch;
  /** 可选服务的解析缝；**缺省走 `ctx.get`（已接线）**。 */
  getLlm?: (service: string) => unknown;
  /** 事件发射缝；**缺省走 `ctx.emit`（已接线）**。 */
  emit?: (event: string) => void;
  /** 凭据服务本身或其 resolver 函数；**缺省走 `ctx.get("credentials")`（已接线）**。 */
  credentials?: unknown;
  /**
   * 出图 peer 模块（`@deepseek-ai/dsh-tools`）的惰性加载缝；缺省真 `import()`。
   * **实际在用**（`draw-register.ts`），此前只是没写进本接口。
   */
  loadToolsModule?: () => Promise<unknown>;
  /** 出图的 fetch 缝；缺省全局 `fetch`。同样**实际在用**。 */
  drawFetch?: (url: string, options: object) => Promise<unknown>;
  /**
   * 出图轮询间隔的装配缝（`draw-register.ts` → `defineDrawTool`）；缺省 15s。
   *
   * 与 `drawFetch` 同性质，但它管的是**时间**：默认 15s 意味着任何走真装配链的
   * 离线用例都要睡满一个间隔（`draw-register.test.mjs` 会从 10s 级掉到 10ms 级）。
   */
  pollIntervalMs?: number;
  /**
   * provider 适配器工厂模块的加载缝（publisher 的 `loadAdapterModule`，缺省真
   * `import("./llm-adapter.ts")`）。真模块 import 的 peer（`@deepseek-ai/dsh-llm-pi-ai`）
   * 只在 Host 进程里存在，离线测试进程加载必败——测试注入假模块（返回
   * `{ createModelScopeAdapter }`）才能驱动完整 publish 链。此前只是 publisher 的
   * deps 缝，没接到 HostDeps，注入到不了位。
   */
  loadAdapterModule?: () => Promise<object>;
  /**
   * 令牌读取的**环境源**缝（缺省走 `process.env`）。
   *
   * 存在的理由是一只具体的鬼（2026-10-16 实测）：默认的 `process.env` 让测试
   * 进程**继承宿主的真实令牌**——`test/routes.test.mjs` 断言「空状态快照的
   * token.present === false」，而任何在开发机上配过 `MODELSCOPE_API_KEY` 的机器
   * 都会让它读到真令牌从而断言失败。方向最坏：CI（干净环境）永远绿，只有装了
   * 真令牌的机器红，也就是作者和真实用户。
   *
   * 所以这里要的不是「测试记得 delete 环境变量」（`doctor.test.mjs` 手工删过，
   * `routes.test.mjs` 没删——同一条纪律两个下场），而是一个**必须被显式传**的缝：
   * 测试传 `env: {}`，进程环境就进不了判定；产品不传，行为与今天完全一致。
   * 「谁忘了传」由 `test/env-hermetic.test.mjs` 的源码级门禁抓，不靠自觉。
   */
  env?: Record<string, string | undefined>;
}

/** 路由族共享的 wiring 袋；每个路由用 `Pick<Wiring, …>` 声明自己摸的子集。 */
export interface Wiring {
  settings: import("./host-config.ts").ResolvedSettings;
  configError: string | null;
  tokenStore: ReturnType<typeof import("./ms-auth.ts").createTokenStore>;
  usageStore: ReturnType<typeof import("./usage-store.ts").createFileUsageStore>;
  inference: ReturnType<typeof import("./inference-client.ts").createInferenceClient>;
  /** 面板开关持久层（M4 §8）：读/写「这个 profile 要不要接入 provider」。 */
  providerStore: ReturnType<typeof import("./provider-store.ts").createFileProviderStore>;
  /**
   * 出图工具的开关 + 模型偏好持久层。
   *
   * **与本包的 providerStore 是两件事**：那个管「魔搭作为 chat provider」，这个管
   * 「给 agent 一个出图工具」。分开是有意的（见 draw-store.ts 头注）。
   */
  drawStore: ReturnType<typeof import("./draw-store.ts").createFileDrawStore>;
  /**
   * 出图作业表（纯进程内，不落盘）：两段式工具靠它把 `jobId` 续上。
   *
   * 它必须挂在 wiring 上、由 `index.ts` 建与销毁，**不能**在 `draw-register.ts`
   * 里现建：那样没有任何人持有它的引用，`DrawJobs.dispose()` 永远走不到（2026-10-19
   * 锐评实测：`dispose()` 的调用方只剩测试）。表随插件卸载清空是安全的——工具无法
   * 从 peer registry 注销，但 `execute` 的 `isDisposed` 闸已在拒绝卸载后的调用。
   */
  drawJobs: ReturnType<typeof import("./draw-jobs.ts").createDrawJobs>;
  /**
   * 用量面板的显示偏好持久层（目前只有趋势图的显示窗口）。
   *
   * **不与 usageStore 合并**：那是**数据**（天桶/计数/事件），写路径是观测热路径；
   * 偏好混进去会让「偏好读不到」与「计数文件损坏」共用一条降级语义，且版本漂移时
   * 旧构建重写会静默丢掉这个键。详见 usage-prefs-store.ts 头注。
   */
  usagePrefsStore: ReturnType<typeof import("./usage-prefs-store.ts").createFileUsagePrefsStore>;
  /**
   * 「本机第一次见到这个模型是什么时候」的首见表（`roster-seen.json`）。
   *
   * **写只发生在一处**：收敛器拿到目录那一刻调 `note()`。快照聚合与 provider
   * 路由都只 `fresh()` 读——读路径若顺手补戳，一次面板轮询就能把「谁是新模型」
   * 改写掉。这个不对称是有意的，别在路由里「顺手也记一下」。
   *
   * 口径是**本机首次见到**，不是网关新增（见 roster-seen-store.ts 头注）。
   */
  rosterSeenStore: ReturnType<typeof import("./roster-seen-store.ts").createFileRosterSeenStore>;
  /** provider 注册状态机（M4 §7）：publish/dispose/release 与 state。 */
  publisher: ReturnType<typeof import("./provider-publish.ts").createProviderPublisher>;
  /**
   * provider 注册的 desired-state reconciler 触发口（M4 §7 的控制面收编）。
   *
   * 目录轮询与四条 provider 路由都只是「标记 dirty」——收敛（读 desired →
   * 拉目录 → 复查 desired → publish）只有这一处。await 它返回的 promise 即
   * 「本次触发已被消费，注册态已反映 desired」。
   */
  reconcile: () => Promise<void>;
  logger?: { warn?: (message: string, error?: unknown) => void };
}
