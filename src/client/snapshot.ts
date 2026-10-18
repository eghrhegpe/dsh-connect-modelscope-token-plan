/**
 * 决策层：把快照应答读成面板视图；wire 码 → 文案键的表。
 *
 * GUIDANCE_BY_CODE 的**键集以 `CodeValue` 为类型契约**（`shared/codes.ts` 的
 * CODE 表）：Host 新增一个码而这里没跟，是编译错误——不再只靠「副本漂移两者
 * 都会红」的测试兜底。码表本身双端同读 shared，浏览器 import Host 模块的旧
 * 理由已随 shared/wire.ts 的运行时值一起过期。
 * @module dsh-connect-modelscope-token-plan/client/snapshot
 */
import { format } from "./format.ts";
import type { zh } from "./i18n.ts";
import type { Tt } from "./runtime.ts";
import type { Snapshot, SnapshotResponse, ProviderStatus, DrawStatus } from "../shared/wire.ts";
import { SNAPSHOT_REQUIRED_KEYS } from "../shared/wire.ts";
import { CODE } from "../shared/codes.ts";
import type { CodeValue } from "../shared/codes.ts";

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
 * Client 自产码就是共享码表里的 `PAYLOAD_ERROR`（`shared/codes.ts`）——曾经
 * 这里有一张 `CLIENT_CODE` 同名副本，理由是「浏览器无法 import Host 模块」；
 * shared/ 早双端同读，副本已删。唯一用途：Host 响应**无法解读成快照**时走
 * GUIDANCE_BY_CODE 的引导文案，而不是把裸英文串上屏。
 */

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
 * 缺失块的空形状，**逐字对齐 Host 的降级实现**（`snapshot-aggregate.ts` 各
 * `soft()` 失败分支、TokenStatus 的失败分支）。
 *
 * `provider` 块现在是**省略**而不是由 Host 塞一个降级块（2026-10-17）：Host 那份
 * 降级形状「看起来就是一个答案」，面板据此认为块在、不再走 `GET /provider` 兜底，
 * 于是只能拿编出来的值渲染。省略之后，兜底真的跑起来，降级形状只剩这里一份。
 *
 * 这里的每一条都是「Host 那一路失败时真的产出的形状」，不是随手捏的：面板渲染
 * 的每一个字段都必须有一个与 Host 同构的空值，否则补出来的空块自己就会炸——
 * 那正是本函数存在的原因。
 */
function emptyBlock(key: string): unknown {
  switch (key) {
    case "token":
      return { present: false, source: "none", valid: null, checkedAt: null, ephemeral: true, readError: null };
    case "balance":
      return { available: null, total: null, frozen: null, fetchedAt: null, error: null };
    case "quota":
      // 缺键 = **未知**，不是「零次」：usedLocal 用 null，面板渲染「—」，与 Host
      // 软失败时的形状同构（wire.ts DailyUsage：null = 没读到，0 = 确实为零）。
      // perModel/events 同理：缺键 = 没读到 = null，不是「今天没有模型调用 /
      // 没有事件」的空数组——把「读不到」画成空会伪造一个答案。
      return { daily: { usedLocal: null }, perModel: null, countingNote: "local-counting" };
    case "events":
      return null;
    case "trend":
      // 缺键 = **未知**，不是「读到了、都是零」：buckets 给 null，TrendBars 画
      // 「—」，与 Host 软失败时的形状同构（wire.ts trend.buckets：null = 没读到，
      // [] = 确实一次都没有）。`{days:0,buckets:[]}` 那个旧形状既让选择器以为
      // maxDays=0（放开全部档位），又把「读不到」画成零柱。
      return { days: 0, windowDays: null, maxDays: 0, buckets: null };
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
    // ok:false 的失败码由 Host 给（auth_error 等）；缺码时用共享码表里
    // client 自产的那个稳定码，消息保留 Host 原文（可能缺席——有引导文案时
    // message 不上屏）。
    const code = typeof payload.code === "string" && payload.code !== "" ? payload.code : CODE.PAYLOAD_ERROR;
    return {
      data: null,
      error: { message: typeof payload.error === "string" && payload.error !== "" ? payload.error : null, code }
    };
  }
  if (!payload || payload.ok !== true) {
    // 整个载荷不可读（非 JSON / 登录墙 HTML / 缺 ok 字段）：不猜内容，只给
    // 稳定码 + 引导文案。曾经这里是裸英文串 "unexpected payload"——i18n 泄漏。
    return { data: null, error: { message: null, code: CODE.PAYLOAD_ERROR } };
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
  contextWindow: null,
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
      const w = row.contextWindow;
      // 来源标记：只认已知三值，其余（旧 Host 缺字段 / 脏值）当 catalog——
      // 缺席时徽章退化为普通窗口显示，不破坏旧行为。
      const contextSource: "catalog" | "override" | "curated" =
        row.contextSource === "override" || row.contextSource === "curated" ? row.contextSource : "catalog";
      // 输出上限的来源同样只认已知值，其余当 catalog（旧 Host 缺字段时不画徽章，
      // 不是画一个假的「目录声明」）。
      const maxOutputSource: "catalog" | "override" = row.maxOutputSource === "override" ? "override" : "catalog";
      const out = row.maxOutputLength;
      return {
        id,
        name: typeof row.name === "string" && row.name !== "" ? row.name : id,
        vision: row.vision === true,
        available: row.available !== false,
        quotaExhausted: row.quotaExhausted === true,
        contextSource,
        maxOutputSource,
        // 旧 Host 的 roster 行没有窗口字段：合法时才带键，整键缺席（
        // exactOptionalPropertyTypes 下显式 undefined 不满足可选属性）——
        // badge 缺席，而不是伪装成某个默认值。
        ...(typeof w === "number" && Number.isFinite(w) && w > 0 ? { contextWindow: w } : {}),
        // 输出上限同理：只有有限正数才带键。**0 不带键**——0 的语义是「不声明
        // `maxTokens`、harness 兜底 32768」，画成「最大输出 0」会比不画更错。
        ...(typeof out === "number" && Number.isFinite(out) && out > 0 ? { maxOutputLength: out } : {})
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
    // 旧 Host 不带覆盖字段 → null（跟随目录）；0 / 负数 / NaN / 字符串都不是
    // 可用的窗口，同样读作未设置——与 Host 侧 normalizeContextWindow 同判据。
    contextWindow: typeof p.contextWindow === "number" && Number.isFinite(p.contextWindow) && p.contextWindow > 0
      ? p.contextWindow
      : null,
    roster
  };
}

/** 非 2xx 响应的降级读法（无 body，状态码是唯一线索）。 */
export function errorOfStatus(status: number): PanelFailure | string {
  if (status === 401 || status === 403) return { message: `HTTP ${status}`, code: "auth_error" };
  return `HTTP ${status}`;
}

/**
 * 出图块的降级形状：旧 Host 不给 `draw` 时用它，面板不白屏。
 *
 * `absentReason: null` + `enabled: false` 表达的是「这个 Host 没告诉我出图状态」，
 * 渲染成「未开启」——比把缺席原因猜成 `no-tools-service` 诚实：那会向用户宣称一个
 * 我们并不知道的原因。
 */
export const DEGRADED_DRAW: DrawStatus = Object.freeze({
  enabled: false,
  source: "config",
  candidateIds: [],
  candidateCount: 0,
  candidates: [],
  preferredModel: null,
  preferredSource: "config",
  effectiveModel: null,
  effectiveSource: null,
  absentReason: null,
  mountPending: false,
  // 「不知道」而不是 false：没设首选，且这个 Host 连目录都没给我，无从判断。
  preferredInCatalog: null,
  toolName: "modelscope_draw_image"
});

/**
 * 把 wire/路由返回的出图块归一成 `DrawStatus`；不合法一律降级。
 *
 * 与 `providerOf` 同一套防御性归一（旧 Host 可能缺字段）。`absentReason` 只认三个
 * 已知码——上游若新增第四个，归一到 `null` 而不是把它透传成渲染不出的值；面板的
 * 「缺席」措辞有兜底键，但**状态本身**宁可显示「未知」也不假装认识它。
 * @param {unknown} raw - 原始块。
 * @returns {DrawStatus} 归一后的状态。
 */
export function drawOf(raw: unknown): DrawStatus {
  if (raw === null || typeof raw !== "object") return DEGRADED_DRAW;
  const d = raw as Record<string, unknown>;
  const candidates = Array.isArray(d.candidateIds)
    ? (d.candidateIds as unknown[]).map((id) => String(id ?? "")).filter((id) => id !== "")
    : [];
  const reason = d.absentReason;
  const absentReason = reason === "no-tools-service" || reason === "peer-load-failed" || reason === "registry-refused"
    ? reason
    : null;
  // 候选明细：旧 Host 只给 `candidateIds`。**不**从 id 编一档能力出来——编出来
  // 的 `image-to-image` 会把「不知道」说成「平台这么声明」。缺席即缺席，面板退化为
  // 只显示 id（`candidates` 字段整键不带）。
  const rawCandidates: { id: string; capability: "text-to-image" | "image-to-image" | "other"; textToImage: boolean }[] | null =
    Array.isArray(d.candidates)
      ? (d.candidates as unknown[]).map((entry) => {
        const row = (entry ?? {}) as Record<string, unknown>;
        const id = String(row.id ?? "");
        const capability: "text-to-image" | "image-to-image" | "other" =
          row.capability === "text-to-image" ? "text-to-image"
            : row.capability === "image-to-image" ? "image-to-image"
              : "other";
        return { id, capability, textToImage: row.textToImage === true };
      }).filter((row) => row.id !== "")
      : null;
  const effectiveSource =
    d.effectiveSource === "preferred" || d.effectiveSource === "declared-text-to-image" ||
    d.effectiveSource === "known-text-to-image" || d.effectiveSource === "catalog-first"
      ? d.effectiveSource
      : null;
  return {
    enabled: d.enabled === true,
    source: d.source === "panel" ? "panel" : "config",
    candidateIds: candidates,
    // NaN 也是 "number"：与 providerOf 同一条理由，Number.isFinite 一并挡掉。
    candidateCount: typeof d.candidateCount === "number" && Number.isFinite(d.candidateCount) ? d.candidateCount : candidates.length,
    ...(rawCandidates !== null ? { candidates: rawCandidates } : {}),
    preferredModel: typeof d.preferredModel === "string" && d.preferredModel !== "" ? d.preferredModel : null,
    preferredSource: d.preferredSource === "panel" ? "panel" : "config",
    // 旧 Host 不带这两键：保留缺席（面板不显示「当前使用」行），不猜一个默认值。
    ...("effectiveModel" in d
      ? { effectiveModel: typeof d.effectiveModel === "string" && d.effectiveModel !== "" ? d.effectiveModel : null }
      : {}),
    ...("effectiveSource" in d ? { effectiveSource } : {}),
    absentReason,
    mountPending: d.mountPending === true,
    // 三态归一：只有显式 true/false 才采信，其余（旧 Host 不给、给了 null、给了
    // 别的类型）一律读作 null = 「不知道」，不做任何断言（红线 3）。
    preferredInCatalog:
      d.preferredInCatalog === true ? true : d.preferredInCatalog === false ? false : null,
    toolName: typeof d.toolName === "string" && d.toolName !== "" ? d.toolName : "modelscope_draw_image"
  };
}

/**
 * wire 码 → 文案键。键集是 `CodeValue` 的**全函数**（类型即契约）：Host 码表
 * 新增一个码而这里没跟，tsc 直接红——副本漂移从「测试兜底」升级为「编译错误」。
 * 值仍是 Client 侧 i18n 键（文案归字典，这里只做映射）。
 */
export const GUIDANCE_BY_CODE: Readonly<Record<CodeValue, keyof typeof zh>> = Object.freeze({
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
  // Client 自产码（共享码表的 PAYLOAD_ERROR）：响应无法解读成快照时的引导
  // 文案，替代曾经上屏的裸英文 "unexpected payload"。
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
  // 未知码（Host 给了表外字符串）查不到引导 → null：面板走通用失败行，不假装认识。
  const guidanceKey = failure === null ? null : GUIDANCE_BY_CODE[failure.code as CodeValue] ?? null;
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
