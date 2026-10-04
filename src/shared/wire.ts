/**
 * Host ⇄ Client 快照契约（type-only，双端同读；本文件不许有运行时行为——
 * 有例外时先在两侧测试钉住再说）。
 *
 * 语义基线（与 SPIKE.md 一致）：
 * - 面板没有官方余额，一切「剩余」都是 quotaWindow.limit − 本地计数的推算值；
 * - 严格区分 null（没读到）与 0（确实为零）——usage-store 丢桶不得伪装成零用量；
 * - 快照路由 HTTP 恒 200，成败看 body（Snapshot | SnapshotFailure）。
 */

export const PLUGIN_ID = "dsh-connect-modelscope-token-plan";
export const SNAPSHOT_VERSION = 1;

/** 一个额度窗口的本地推算。limit 来自配置（非官方常数）。 */
export interface QuotaWindow {
  /** 配置的额度常数（如每日 2000）。 */
  limit: number;
  /** 本地计数（仅经本插件的调用）。 */
  usedLocal: number;
  /** limit − usedLocal；usedLocal > limit 时为 0（不出现负数展示）。 */
  remainingComputed: number | null;
}

/** 单模型本地用量。 */
export interface PerModelUsage {
  modelId: string;
  calls: number;
  tokens: number | null;
  lastAt: string | null;
}

/** 限流/额度事件（429 等的本地记录）。kind 的分诊标准见 inference-client。 */
export interface QuotaEvent {
  at: string;
  modelId: string;
  kind: "quota" | "rate_limit" | "error";
  message: string;
}

/** 本地趋势天桶（dateKey = 本地日期 YYYY-MM-DD）。 */
export interface TrendBucket {
  dateKey: string;
  calls: number;
  tokens: number;
}

export interface ModelEntry {
  id: string;
}

/** 令牌状态。valid: null = 未检查过（不是「有效」也不是「无效」）。 */
export interface TokenStatus {
  present: boolean;
  source: "credentials" | "env" | "none";
  valid: boolean | null;
  checkedAt: string | null;
}

/** 成功快照。字段增删必须同步 test/wire.test.mjs 的钉死清单与面板 wire。 */
export interface Snapshot {
  ok: true;
  name: string;
  version: string;
  now: string;
  pollSeconds: number;
  cacheSeconds: number;
  token: TokenStatus;
  quota: {
    daily: QuotaWindow;
    perModelLimit: number;
    perModel: PerModelUsage[];
    /** 固定文案键：面板渲染「本地推算」说明用，i18n 在 client 侧做。 */
    countingNote: "local-counting";
  };
  events: QuotaEvent[];
  trend: { days: number; buckets: TrendBucket[] };
  models: { available: boolean; count: number; sample: string[]; error: string | null };
  shapeWarnings: string[];
  quotaError: { code: string } | null;
}

export interface SnapshotFailure {
  ok: false;
  code: string;
  message: string;
}

export type SnapshotResponse = Snapshot | SnapshotFailure;

/** 钉死清单：任何新增顶层字段都必须先过 test/wire.test.mjs。 */
export const SNAPSHOT_REQUIRED_KEYS = Object.freeze([
  "ok",
  "name",
  "version",
  "now",
  "pollSeconds",
  "cacheSeconds",
  "token",
  "quota",
  "events",
  "trend",
  "models",
  "shapeWarnings",
  "quotaError",
] as const);
