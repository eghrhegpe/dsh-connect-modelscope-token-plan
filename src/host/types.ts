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
 * fetch。v0.1 只需要 fetch 缝（probe 路由与模型目录的 HTTP 出口）。
 */
export interface HostDeps {
  fetchImpl?: typeof fetch;
}

/** 路由族共享的 wiring 袋；每个路由用 `Pick<Wiring, …>` 声明自己摸的子集。 */
export interface Wiring {
  settings: import("./host-config.ts").ResolvedSettings;
  configError: string | null;
  tokenStore: ReturnType<typeof import("./ms-auth.ts").createTokenStore>;
  usageStore: ReturnType<typeof import("./usage-store.ts").createFileUsageStore>;
  inference: ReturnType<typeof import("./inference-client.ts").createInferenceClient>;
  logger?: { warn?: (message: string, error?: unknown) => void };
}
