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
  /** provider 注册状态机（M4 §7）：publish/dispose/release 与 state。 */
  publisher: ReturnType<typeof import("./provider-publish.ts").createProviderPublisher>;
  logger?: { warn?: (message: string, error?: unknown) => void };
}
