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
  /**
   * 今日调用次数（本地口径）。
   *
   * `null` = **没读到**（本地计数文件读失败/损坏被拒），`0` = 确实一次都没有。
   * 两者必须分开：0 是可信的日常值，把「读不到」渲染成 0 会让操作者以为今天
   * 没调用过，而真相是他不知道。面板对 null 渲染「—」。
   */
  usedLocal: number | null;
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
 * 代表「什么都不提供」的哨兵 id——`ProviderStatus.enabledIds` 线编码的一部分。
 *
 * 空的允许清单已经表示「不过滤（全部提供）」，所以「全部隐藏」只能走这个哨兵：
 * 一个永远不可能成为真实模型 id 的字符串，作为清单里唯一的项。裸 `[]` 不能同时
 * 表示「全部模型」与「没有模型」。两侧（Host 的 `llm-models.ts` 与 Client 的
 * `const.ts`）都从本模块再导出——它曾经是两边各写一份的字面量，拼错一处就是
 * 「点隐藏反而全放出来」。
 */
export const HIDE_ALL_MODELS = "__hide_all__";

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
  /**
   * 面板保存的全局上下文窗口覆盖（tokens），`null` = 跟随目录。作用于目录
   * 未声明窗口的模型；descriptor / roster / 签名都在打标后派生。
   */
  contextWindow: number | null;
  /** 面板清单：每行带可用性与额度耗尽标记。 */
  roster: {
    id: string;
    name: string;
    vision: boolean;
    available: boolean;
    quotaExhausted: boolean;
    /** 该行生效的窗口（覆盖或目录声明后的归一值；总是正数）。 */
    contextWindow?: number;
    /**
     * 窗口数字的来源：catalog = 目录声明或 pi-ai 兜底；override = 用户全局
     * 覆盖；curated = 策展表。与 host 的 contextWindowSourceOf 同词汇。
     */
    contextSource?: "catalog" | "override" | "curated";
  }[];
}

/**
 * 出图工具的状态（`DRAW_PATH` 的响应形状，也进快照）。
 *
 * **刻意与 `ProviderStatus` 分开**：那个说「魔搭作为 chat provider 提供什么模型」，
 * 这个说「给 agent 一个出图工具」。两者的开关、候选集合、生效时机都不同——出图
 * 开关翻转**不会**立刻改变挂载（工具无法注销），这正是 `mountPending` 要表达的。
 *
 * 实测依据见 docs/SPIKE-image-gen.md。
 */
export interface DrawStatus {
  /** 生效的开关值（面板保存值优先于 patch 默认）。 */
  enabled: boolean;
  /** 谁说了算：面板保存的值，还是 patch 的默认。 */
  source: "panel" | "config";
  /**
   * 出图候选模型 id。来自**目录**（平台声明的出图能力），不是 provider 的允许
   * 清单——裁剪 chat picker 不该波及出图工具的候选。
   */
  candidateIds: string[];
  candidateCount: number;
  /**
   * 候选的明细：能力档 + 「实测可纯文生图」。面板每行的徽章与提示从它派生。
   *
   * 可选：旧 Host 只给 `candidateIds`，面板退化为只显示 id（不假装知道能力）。
   */
  candidates?: {
    id: string;
    /** 平台声明的能力档（platform 说 `image-to-image` 就是 `image-to-image`）。 */
    capability: "text-to-image" | "image-to-image" | "other";
    /** 实测可纯文生图（平台声明 text-to-image，或已知的 `Qwen/Qwen-Image-Edit`）。 */
    textToImage: boolean;
  }[];
  /** 面板/配置保存的默认模型；`null` = 未指定，走自动选择。 */
  preferredModel: string | null;
  preferredSource: "panel" | "config";
  /**
   * **当前实际会用**的模型 id（`pickDrawModel` 的裁决结果，含自动选择）。
   * `null` = 目录里没有出图模型，调用会以「没有候选」失败。
   */
  effectiveModel?: string | null;
  /**
   * 为什么是 `effectiveModel`。面板据此把「你指定的」与「自动挑的」分开说清——
   * 只报 id 不报理由，用户看到两个候选却不知道哪个在生效。
   */
  effectiveSource?: "preferred" | "declared-text-to-image" | "known-text-to-image" | "catalog-first" | null;
  /**
   * 工具缺席的原因；`null` = 开关没开，或已成功挂载。
   *
   * 三种原因里只有 `no-tools-service` 是「正常」（Host 没提供该服务），另两种是
   * Host 缺陷。面板必须分开措辞，否则用户没法自己诊断「开关开着但工具不在」。
   */
  absentReason: "no-tools-service" | "peer-load-failed" | "registry-refused" | null;
  /**
   * 开关已开，但本次挂载**尚未**把工具注册上（或缺席）。
   *
   * 与 `absentReason` 的区别：这个说「本进程里还看不到工具」，是翻转开关后到下次
   * Host 启动之间应有的状态——不是故障。面板据此显示「重启后生效」。
   */
  mountPending: boolean;
  /** agent 侧的工具名（就是用户能在对话里看到的那个）。 */
  toolName: string;
}

/** 令牌状态。valid: null = 未检查过（不是「有效」也不是「无效」）。 */
export interface TokenStatus {
  present: boolean;
  source: "credentials" | "env" | "none" | "memory";
  valid: boolean | null;
  checkedAt: string | null;
  /** true = 这台 Host 没有凭据服务，面板保存的令牌重启即丢。 */
  ephemeral: boolean;
  /**
   * 读凭据存储失败的原因；`null`/缺席 = 读到了（此时 `present` 才可信）。
   *
   * 这一路失败原先被伪造成 `present: false, source: "none"`——对**有**令牌的
   * 用户展示「未配置、去粘贴令牌」，并顺手把余额的错误也压成 null。`present`
   * 是布尔量，表达不了「读不到」；这条字段就是那个缺失的第三态。
   */
  readError?: string | null;
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
  trend: {
    /** 画多少天——**生效值**（面板覆盖优先，否则配置默认，恒 ≤ `maxDays`）。 */
    days: number;
    /** 面板保存的显示窗口；`null` = 跟随配置默认（选择器据此回显）。 */
    windowDays: number | null;
    /** 可选窗口的上界 = 保留窗口（画得比它多会把已剪的日子画成 0）。 */
    maxDays: number;
    buckets: TrendBucket[];
  };
  models: { available: boolean; count: number; sample: string[]; error: string | null };
  /**
   * Provider 注册状态（M4）：开关 + 注册 + 允许清单 + 面板 roster。
   *
   * **可选**，与 `draw` 同一条纪律：Host 侧这一块聚合失败时**省略它**，而不是塞
   * 一个填了默认值的「降级块」。理由不是洁癖——填默认值的块**看起来**是一个
   * 答案（`allowed:"all"`、`roster:[]`、`enabled:false`），面板因此会认为「块在」、
   * 不再走 `GET /provider` 兜底，于是只能拿那份编出来的形状渲染；而真相是
   * 「读不到」。省略则让兜底路径真的跑起来（兜底也失败才用 `DEGRADED_PROVIDER`）。
   */
  provider?: ProviderStatus;
  /**
   * 出图工具状态。**可选**：旧 Host 或过渡期可能不给这个块，面板走
   * `drawOf` 的降级形状（与 `provider` 同一套「resolver-not-snapshot」纪律）。
   */
  draw?: DrawStatus;
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
