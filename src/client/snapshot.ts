/**
 * 决策层：把快照应答读成面板视图；wire 码 → 文案键的表。
 *
 * GUIDANCE_BY_CODE 是 Host codes.ts 的**唯一刻意副本**（浏览器无法 import
 * Host 模块）；副本被 test 钉住（每个键必须存在于 CODE），改名两边都会红。
 * @module dsh-connect-modelscope-token-plan/client/snapshot
 */
import { format } from "./format.ts";
import type { zh } from "./i18n.ts";
import type { Tt } from "./runtime.ts";
import type { Snapshot, SnapshotResponse, ProviderStatus } from "../shared/wire.ts";

/**
 * 面板视图层的失败形状（与 wire.ts 的 `SnapshotFailure` 同名异形曾是漂移源，
 * 审核后改名区分）：wire 线上失败携带 `error` 字段；本视图把它归一化为
 * `message`（errorOfStatus 合成的 HTTP 失败没有线上的 error 可用）。
 */
export interface PanelFailure {
  message: unknown;
  code?: unknown;
}

/** (data, error) 对：恰好一边非空。 */
export interface SnapshotRead {
  data: Snapshot | null;
  error: PanelFailure | string | null;
}

/** viewOf 的裁决：这张快照对面板意味着什么。 */
export interface SnapshotView {
  failure: PanelFailure | null;
  needsSetup: boolean;
  /** 文案键（不是文本）——测试断言决策而不必拥有字典。 */
  guidanceKey: keyof typeof zh | null;
  guidance: string | null;
  shapeWarnings: string[];
}

/** 读一个快照应答。HTTP 恒 200，成败看 body.ok。 */
export function interpretSnapshot(body: unknown): SnapshotRead {
  const payload = body as { ok?: unknown; error?: unknown; code?: unknown } | null | undefined;
  if (payload && payload.ok === false) {
    return { data: null, error: { message: payload.error || "unexpected payload", code: payload.code } };
  }
  if (!payload || payload.ok !== true) return { data: null, error: "unexpected payload" };
  // provider 块原样透传：它就是 body 上的顶层字段，`data` 的裸 cast 已经带上。
  // 失败分支没有 provider 块可言（data 恒 null）——调用方用 providerOf(null) 拿到
  // DEGRADED_PROVIDER，那就是失败时的降级形状，两条路不会互相漂移。
  return { data: payload as unknown as Snapshot, error: null };
}

/**
 * provider 读不到时的降级形状：开关关、没注册、目录空——面板照常用，该区块
 * 只是缺席。`error: "unavailable"` 是这块自己造的哨兵（不是 Host 的错误文案），
 * 渲染方把它当「无数据」而不是「接入失败」。
 */
export const DEGRADED_PROVIDER: ProviderStatus = Object.freeze({
  enabled: false,
  source: "config",
  llmAvailable: false,
  registered: false,
  error: "unavailable",
  modelCount: 0,
  enabledCount: 0,
  allowed: "all",
  enabledIds: [],
  roster: []
});

/**
 * 把 wire/路由返回的 provider 块归一成 `ProviderStatus`；不合法一律降级。
 * 形状由 wire.ts 钉死，本函数只做防御性归一（旧 Host 可能缺字段）。
 */
export function providerOf(raw: unknown): ProviderStatus {
  if (raw === null || typeof raw !== "object") return DEGRADED_PROVIDER;
  const p = raw as Record<string, unknown>;
  const ids = Array.isArray(p.enabledIds)
    ? (p.enabledIds as unknown[]).map((id) => String(id ?? "")).filter((id) => id !== "")
    : [];
  const roster = Array.isArray(p.roster)
    ? (p.roster as unknown[]).map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const id = String(row.id ?? "");
      return {
        id,
        name: typeof row.name === "string" && row.name !== "" ? row.name : id,
        vision: row.vision === true,
        available: row.available !== false,
        quotaExhausted: row.quotaExhausted === true
      };
    }).filter((entry) => entry.id !== "")
    : [];
  return {
    enabled: p.enabled === true,
    source: p.source === "panel" ? "panel" : "config",
    llmAvailable: p.llmAvailable === true,
    registered: p.registered === true,
    error: typeof p.error === "string" ? p.error : null,
    modelCount: typeof p.modelCount === "number" ? p.modelCount : roster.length,
    enabledCount: typeof p.enabledCount === "number" ? p.enabledCount : 0,
    allowed: p.allowed === "none" ? "none" : p.allowed === "list" ? "list" : "all",
    enabledIds: ids,
    roster
  };
}

/** 非 2xx 响应的降级读法（无 body，状态码是唯一线索）。 */
export function errorOfStatus(status: number): PanelFailure | string {
  if (status === 401 || status === 403) return { message: `HTTP ${status}`, code: "auth_error" };
  return `HTTP ${status}`;
}

/** wire 码 → 文案键。副本被 test/panel.test.mjs 钉住。 */
export const GUIDANCE_BY_CODE: Readonly<Record<string, keyof typeof zh>> = Object.freeze({
  auth_error: "panel.authError",
  config_error: "panel.configError",
  network_error: "panel.networkError",
  timeout_error: "panel.timeout",
  upstream_error: "panel.upstream",
  rate_limited: "panel.upstream",
  quota_exceeded: "panel.upstream"
});

/** 这些码不是「配令牌」能修的：引导行不是去贴令牌，而是等/修配置。 */
export const FORM_EXCLUDED_CODES: ReadonlySet<string> = Object.freeze(
  new Set(["config_error", "network_error", "timeout_error", "upstream_error", "rate_limited", "quota_exceeded"])
);

/** 面板决策：这张快照意味着什么。纯函数，Node 套件驱动同一个函数。 */
export function viewOf(
  data: Snapshot | null,
  error: PanelFailure | string | null,
  tt: Tt
): SnapshotView {
  const failure: PanelFailure | null = error === null || error === undefined
    ? null
    : typeof error === "string" ? { message: error, code: null } : error;
  const needsSetup = data === null && !FORM_EXCLUDED_CODES.has((failure?.code ?? null) as string);
  const guidanceKey = failure === null ? null : GUIDANCE_BY_CODE[failure.code as string] ?? null;
  const guidance = guidanceKey === null
    ? null
    : guidanceKey === "panel.configError"
      ? format(tt(guidanceKey), { error: failure?.message })
      : tt(guidanceKey);
  const shapeWarnings = Array.isArray(data?.shapeWarnings) ? (data.shapeWarnings as string[]) : [];
  return { failure, needsSetup, guidanceKey, guidance, shapeWarnings };
}

export type { SnapshotResponse };
