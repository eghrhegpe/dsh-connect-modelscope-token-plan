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
 * `apply()` 的测试缝：真实 Loader 不传任何东西，测试用它替换 peer 模块与
 * fetch。v0.1 只需要 fetch 缝（probe 路由与模型目录的 HTTP 出口）；M4 追加
 * 其余可选缝（pollMs / getLlm / emit / credentials），全部可选以保持向后兼容。
 */
export interface HostDeps {
  fetchImpl?: typeof fetch;
  /** 轮询间隔（毫秒）测试缝；M4 轮询实际取 settings.pollSeconds。 */
  pollMs?: number;
  /** 可选服务的解析缝（缺省走 ctx.get）。 */
  getLlm?: (service: string) => unknown;
  /** 事件发射缝（缺省走 ctx.emit）。 */
  emit?: (event: string) => void;
  /** 凭据服务的解析缝（缺省走 ctx.get("credentials")）。 */
  credentials?: unknown;
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
  /** provider 注册状态机（M4 §7）：publish/dispose/release 与 state。 */
  publisher: ReturnType<typeof import("./provider-publish.ts").createProviderPublisher>;
  logger?: { warn?: (message: string, error?: unknown) => void };
}
