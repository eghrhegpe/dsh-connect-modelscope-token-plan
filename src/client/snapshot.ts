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
import { SNAPSHOT_REQUIRED_KEYS } from "../shared/wire.ts";

/**
 * 面板视图层的失败形状（与 wire.ts 的 `SnapshotFailure` 同名异形曾是漂移源，
 * 审核后改名区分）：wire 线上失败携带 `error` 字段；本视图把它归一化为
 * `message`（errorOfStatus 合成的 HTTP 失败没有线上的 error 可用）。
 */
export interface PanelFailure {
  message: unknown;
  code?: unknown;
}

/**
 * Client 自产的稳定码（Host `codes.ts` CODE 表的同名副本，值由 panel.test
 * §2/§3c 钉住必须在 Host 表内）。唯一用途：Host 响应**无法解读成快照**时
 * 走 GUIDANCE_BY_CODE 的引导文案，而不是把裸英文串上屏。
 */
export const CLIENT_CODE = Object.freeze({
  PAYLOAD_ERROR: "payload_error"
});

/** (data, error) 对：恰好一边非空。 */
export interface SnapshotRead {
  data: Snapshot | null;
  error: PanelFailure | string | null;
  /**
   * `ok:true` 但缺失的顶层键（`SNAPSHOT_REQUIRED_KEYS` 的子集）。
   *
   * 空数组 = 契约完整。非空 = Host 少给了键，属双端漂移——面板据此在
   * `viewOf` 里加一条提示，而不是静默渲染半空的面板。
   */
  missingKeys?: readonly string[];
}

/**
 * 缺失块的空形状，**逐字对齐 Host 的降级实现**（`snapshot-aggregate.ts` 的
 * `providerDegraded` 与各 `soft()` 失败分支、TokenStatus 的失败分支）。
 *
 * 这里的每一条都是「Host 那一路失败时真的产出的形状」，不是随手捏的：面板渲染
 * 的每一个字段都必须有一个与 Host 同构的空值，否则补出来的空块自己就会炸——
 * 那正是本函数存在的原因。
 */
function emptyBlock(key: string): unknown {
  switch (key) {
    case "token":
      return { present: false, source: "none", valid: null, checkedAt: null, ephemeral: true };
    case "balance":
      return { available: null, total: null, frozen: null, fetchedAt: null, error: null };
    case "quota":
      return { daily: { usedLocal: 0 }, perModel: [], countingNote: "local-counting" };
    case "events":
      return [];
    case "trend":
      return { days: 0, buckets: [] };
    case "models":
      return { available: false, count: 0, sample: [], error: null };
    case "provider":
      // 与 DEGRADED_PROVIDER 同源；用同一个常量避免两处漂移。
      return DEGRADED_PROVIDER;
    case "shapeWarnings":
    case "quotaError":
      return key === "quotaError" ? null : [];
    // 标量键（ok/name/version/now/pollSeconds/cacheSeconds）补undefined 就够：
    // 渲染层对它们各自有兜底（数字 NaN 不上屏、`?? null` 落到「—」）。
    default:
      return undefined;
  }
}

/** 把缺失的顶层键补成空形状（不改原body，返回新对象）。 */
function withEmptyBlocks(raw: Record<string, unknown>, missingKeys: readonly string[]): Record<string, unknown> {
  const out = { ...raw };
  for (const key of missingKeys) out[key] = emptyBlock(key);
  return out;
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

/**
 * 读一个快照应答。HTTP 恒 200，成败看 body.ok。
 *
 * `ok:true` 的body **必须**带齐 {@link SNAPSHOT_REQUIRED_KEYS} 的每个顶层键，
 * 缺一个都在这里被归一，而不是留到渲染期炸掉。曾经这里是裸 cast，于是
 * `panel-page.ts` 里 `data?.models.sample[0]` 这类解引用会抛 TypeError 把整个面板
 * 炸掉——`data?.` 只护住了 `data` 本身，护不住它下面的 `models`。而那一行在
 * **所有 tab 上都执行**，所以任意一个键缺失都不止炸当前 tab。
 *
 * 缺键走两件事：把确实缺的那个块补成同构的空形状（让面板渲染「空」而不是
 * 崩），并把缺失名单带进 `shapeWarnings` 的等价物——`SnapshotRead` 上的
 * `missingKeys`，由 `viewOf` 呈现给用户。**不**静默：Host 少给键是双端契约
 * 漂移，用户该看见。
 */
export function interpretSnapshot(body: unknown): SnapshotRead {
  const payload = body as { ok?: unknown; error?: unknown; code?: unknown } | null | undefined;
  if (payload && payload.ok === false) {
    // ok:false 的失败码由 Host 给（auth_error 等）；缺码时用 client 自产的
    // 稳定码，消息保留 Host 原文（可能缺席——有引导文案时 message 不上屏）。
    const code = typeof payload.code === "string" && payload.code !== "" ? payload.code : CLIENT_CODE.PAYLOAD_ERROR;
    return {
      data: null,
      error: { message: typeof payload.error === "string" && payload.error !== "" ? payload.error : null, code }
    };
  }
  if (!payload || payload.ok !== true) {
    // 整个载荷不可读（非 JSON / 登录墙 HTML / 缺 ok 字段）：不猜内容，只给
    // 稳定码 + 引导文案。曾经这里是裸英文串 "unexpected payload"——i18n 泄漏。
    return { data: null, error: { message: null, code: CLIENT_CODE.PAYLOAD_ERROR } };
  }
  const raw = payload as unknown as Record<string, unknown>;
  const missingKeys = SNAPSHOT_REQUIRED_KEYS.filter((key) => raw[key] === undefined);
  // provider 块原样透传：它就是 body 上的顶层字段，裸 cast 已经带上；缺失时由
  // providerOf(null) 给出 DEGRADED_PROVIDER，两条路不会互相漂移。
  const filled = missingKeys.length === 0 ? raw : withEmptyBlocks(raw, missingKeys);
  return { data: filled as unknown as Snapshot, error: null, missingKeys };
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
    // NaN 也是 "number"：`typeof NaN === "number"` 为 true，会把 NaN 渲成
    // 「NaN 个模型」。Number.isFinite 一并挡掉 NaN / Infinity。
    modelCount: typeof p.modelCount === "number" && Number.isFinite(p.modelCount) ? p.modelCount : roster.length,
    enabledCount: typeof p.enabledCount === "number" && Number.isFinite(p.enabledCount) ? p.enabledCount : 0,
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
  quota_exceeded: "panel.upstream",
  // 聚合器自身抛错时的兜底码（Host 的 soft()/failureCode 在无 code 时产出它）。
  // 曾经漏在这里：最需要人看的内部错误反而没有引导文案，且因为不在
  // FORM_EXCLUDED_CODES 里，needsSetup 会算成 true——把一个内部错误引导去「配
  // 令牌」，方向完全反了。
  internal_error: "panel.internalError",
  // Client 自产码（CLIENT_CODE，Host codes.ts 表内同名值）：响应无法解读成
  // 快照时的引导文案，替代曾经上屏的裸英文 "unexpected payload"。
  payload_error: "panel.payloadError"
});

/** 这些码不是「配令牌」能修的：引导行不是去贴令牌，而是等/修配置。 */
export const FORM_EXCLUDED_CODES: ReadonlySet<string> = Object.freeze(
  new Set(["config_error", "network_error", "timeout_error", "upstream_error", "rate_limited", "quota_exceeded", "internal_error", "payload_error"])
);

/**
 * 面板决策：这张快照意味着什么。纯函数，Node 套件驱动同一个函数。
 *
 * `missingKeys` 是 `interpretSnapshot` 查出的缺失顶层键（非空 = 双端契约漂移）。
 * 它**不**把面板变成错误态——数据能渲染就渲染——但会作为一条 shapeWarning
 * 冒到面板上，因为「Host 少给了键」是维护者要修的事，用户该看见而不是面对
 * 一个悄悄少了一半信息的界面。
 */
export function viewOf(
  data: Snapshot | null,
  error: PanelFailure | string | null,
  tt: Tt,
  missingKeys: readonly string[] = []
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
  const shapeWarnings = Array.isArray(data?.shapeWarnings) ? [...(data.shapeWarnings as string[])] : [];
  if (missingKeys.length > 0) {
    // 曾经是英文原句（"snapshot: Host omitted required key(s): …"），绕过了
    // 「键即编译错误」的字典纪律直接上屏。现在由字典翻译，键名列表保留裸值。
    shapeWarnings.push(format(tt("shape.missingKeys"), { keys: missingKeys.join(", ") }));
  }
  return { failure, needsSetup, guidanceKey, guidance, shapeWarnings };
}

export type { SnapshotResponse };
