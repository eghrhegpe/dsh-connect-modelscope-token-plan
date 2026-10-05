/**
 * Host ⇄ Client 快照契约（type-only，双端同读；本文件不许有运行时行为——
 * 有例外时先在两侧测试钉住再说）。
 *
 * 语义基线（与 SPIKE.md 一致）：
 * - 面板头条是**官方魔粒余额**（balance，真实值）；本地计数只回答官方余额
 *   答不了的问题（分布/趋势/429 事件流），一切「剩余」类数字都是推算值；
 * - 严格区分 null（没读到）与 0（确实为零）——usage-store 丢桶不得伪装成零用量；
 * - 快照路由 HTTP 恒 200，成败看 body（Snapshot | SnapshotFailure）。
 */

export const PLUGIN_ID = "dsh-connect-modelscope-token-plan";
export const SNAPSHOT_VERSION = 1;

/**
 * 今日本地调用数（仅经本插件的调用，含失败与用户中断）。
 *
 * 刻意**只有**这一个数：官方改「魔粒」计费后，面板头条是官方余额，次数口径的
 * 「剩余 / 参考上限」推算条已删除（两个单位并排是误导）。所以这里没有 `limit`，
 * 也没有 `limit − used` 的 `remainingComputed`——`limit` 曾经是社区快照的
 * 「每日 N 次」，非官方数据，留着会让人以为面板能算「还剩几次」。
 */
export interface DailyUsage {
  /** 今日调用次数（本地口径）。 */
  usedLocal: number;
}

/** 单模型本地用量（今日口径：calls 与 tokens 都跨日清零，见 usage-store）。 */
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

/**
 * 模型目录条目（`GET /v1/models` 的 `data[]` 归一投影，见 llm-models.ts 的
 * `normalizeEntry`）。向后兼容的扩展：旧契约只有 `id`，新增字段全部可选，
 * 读旧响应的面板不受影响。
 */
export interface ModelEntry {
  id: string;
  /** 展示名；平台未声明时回退 id。 */
  name?: string;
  /** 是否吃图：结构化字段（input_modalities）优先，名字启发兜底。 */
  vision?: boolean;
  /** 声明的窗口；未知时用 FALLBACK_CONTEXT_WINDOW（128k）兜底。 */
  contextWindow?: number;
  /** 声明的单次输出上限；0 = 平台未声明。 */
  maxOutputLength?: number;
}

/**
 * Provider 注册状态块（M4，§11）：面板「接入模型」开关区与模型勾选区读它。
 *
 * 与 models 块的分工：`models` 只回答「上游目录通不通、有几个模型」；`provider`
 * 回答「这个 profile 要不要接入、接没接成、允许清单是什么」。两处口径不同是
 * 故意的——roster 保留额度耗尽的模型（灰显），picker 才丢弃它们。
 *
 * 软失败：目录读不到时 `modelCount` 为 0、`roster` 为空、`error` 说明原因；
 * 开关读不到时 `enabled:false, source:"config"`（patch 默认兜底）。
 */
export interface ProviderStatus {
  /** 生效开关（面板保存值优先，patch 默认兜底）。 */
  enabled: boolean;
  /** 生效值来自哪一侧。 */
  source: "panel" | "config";
  /** Host 上是否存在可应答 registerAdapter 的 llm 服务。 */
  llmAvailable: boolean;
  /** 本插件的 provider 是否已注册且无错。 */
  registered: boolean;
  /** 最近一次注册/读取的失败原因（已脱敏），null = 无错。 */
  error: string | null;
  /** roster 长度（面板清单里的模型数）。 */
  modelCount: number;
  /** 允许清单命中的模型数。 */
  enabledCount: number;
  /** 允许清单语义：all = 不过滤；none = 哨兵「什么都不提供」；list = 严格清单。 */
  allowed: "all" | "none" | "list";
  /** 允许清单；空数组语义是「不过滤」（与哨兵 HIDE_ALL_MODELS 区分）。 */
  enabledIds: string[];
  /** 面板清单：每行带可用性与额度耗尽标记。 */
  roster: {
    id: string;
    name: string;
    vision: boolean;
    available: boolean;
    quotaExhausted: boolean;
  }[];
}

/** 令牌状态。valid: null = 未检查过（不是「有效」也不是「无效」）。 */
export interface TokenStatus {
  present: boolean;
  source: "credentials" | "env" | "none" | "memory";
  valid: boolean | null;
  checkedAt: string | null;
  /** true = 这台 Host 没有凭据服务，面板保存的令牌重启即丢。 */
  ephemeral: boolean;
}

/**
 * 官方「魔粒」余额（GET siteBase/openapi/v1/magicubes/balance，2026-10-04
 * 实测可用，SPIKE.md §魔粒）。available/total/frozen 为 null = 上游没给该
 * 数或本次没读到（error 说明原因）——null 不是 0。
 */
export interface BalanceData {
  available: number | null;
  total: number | null;
  frozen: number | null;
  fetchedAt: string | null;
  error: string | null;
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
  /** 官方魔粒余额——面板的头条数字。 */
  balance: BalanceData;
  quota: {
    daily: DailyUsage;
    perModel: PerModelUsage[];
    /** 固定文案键：面板渲染「本地推算」说明用，i18n 在 client 侧做。 */
    countingNote: "local-counting";
  };
  events: QuotaEvent[];
  trend: { days: number; buckets: TrendBucket[] };
  models: { available: boolean; count: number; sample: string[]; error: string | null };
  /** Provider 注册状态（M4）：开关 + 注册 + 允许清单 + 面板 roster。 */
  provider: ProviderStatus;
  shapeWarnings: string[];
  quotaError: { code: string } | null;
}

/**
 * 失败快照。字段名是 `error`——与 routes/snapshot.ts 实际写入、client
 * interpretSnapshot 实际读取一致（审核 2026-10-04：此前声明 `message` 与
 * 两端实现漂移）。线格式由 test/routes.test.mjs 的 configError 分支钉住。
 */
export interface SnapshotFailure {
  ok: false;
  code: string;
  error: string;
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
  "balance",
  "quota",
  "events",
  "trend",
  "models",
  "provider",
  "shapeWarnings",
  "quotaError",
] as const);
