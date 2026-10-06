/**
 * 错误分类的单一真源（对齐姊妹插件的 codes.ts 纪律）。
 *
 * 魔搭的分类现实（SPIKE.md）：上游不带任何额度头，额度耗尽与每分钟限频都只
 * 会以 429 + 文案出现，所以 429 的分诊是**按 body 文案**做的保守二分——
 * QUOTA_EXCEEDED 快速失败不重试，RATE_LIMITED 交给调用方退避。分不清时归
 * RATE_LIMITED（退避是两方向里更安全的那个）。
 *
 * @module dsh-connect-modelscope-token-plan/codes
 */

import { looksLikeRateLimit, hasHardQuotaWordingIn } from "./llm-error-fix.ts";

/**
 * 面板按它分流的稳定码表 —— Client 的 `GUIDANCE_BY_CODE` 以这份表的键为契约，
 * 新增/改名必须同步 Client，否则内部错误没有引导文案（见下 `INTERNAL_ERROR`）。
 */
export const CODE = Object.freeze({
  CONFIG_ERROR: "config_error",
  NETWORK_ERROR: "network_error",
  TIMEOUT_ERROR: "timeout_error",
  AUTH_ERROR: "auth_error",
  RATE_LIMITED: "rate_limited",
  QUOTA_EXCEEDED: "quota_exceeded",
  UPSTREAM_ERROR: "upstream_error",
  /**
   * 插件自身抛错（聚合器、状态层、路由之外的意外）。
   *
   * 曾经只作为 `soft()` / `failureCode()` 的兜底字符串出现在快照里，没进这张
   * 表——于是 Client 的 `GUIDANCE_BY_CODE` 也没法映射它（那份映射被测试钉住
   * 「每个键必须在 CODE 里」），最需要人看的内部错误反而没有引导文案。
   * 正式收进码表，两端从此同一份真源。
   */
  INTERNAL_ERROR: "internal_error",
  /**
   * Client 自产码：Host 响应无法解读成快照（非 JSON / 缺 ok 字段）时，
   * 面板用它走引导文案，而不是把裸英文串（"unexpected payload"）上屏。
   *
   * 本表是 `GUIDANCE_BY_CODE` 的键集真源（panel.test §2 钉「每个键必须在
   * CODE 里」、§3c 钉「每个码必须有引导」）——新增 client 码必须同时进
   * 这张表，两侧才同步。
   */
  PAYLOAD_ERROR: "payload_error"
});

export type CodeValue = (typeof CODE)[keyof typeof CODE];

/**
 * 把上游 HTTP 状态归类成稳定码。
 *
 * 401/403 → AUTH_ERROR（换令牌能修，绝不自动重试——魔搭没有锁号问题，
 * 但重试一个坏令牌只会刷屏）；429 由调用方先走 {@link classifyRateLimit}
 * 分诊，这里只兜底；其余 4xx/5xx → UPSTREAM_ERROR；低于 400 → NETWORK_ERROR。
 */
export function classifyStatus(status: number): CodeValue {
  if (status === 401 || status === 403) return CODE.AUTH_ERROR;
  if (status === 429) return CODE.RATE_LIMITED;
  // 4xx 与 5xx 在上游眼里都是「这次请求没法完成」，归到同一码；区分它俩
  // 对调用方没有行动差异（都不可靠地重试），分得越细越难维护。
  if (status >= 400) return CODE.UPSTREAM_ERROR;
  return CODE.NETWORK_ERROR;
}

/**
 * 429 的文案分诊：quota（当日/单模型额度耗尽，重试无意义）vs rate_limit
 * （每分钟限频，退避有用）。
 *
 * 判据**复用 `llm-error-fix.ts` 的 {@link looksLikeRateLimit}**（限频信号 +
 * 硬额度措辞的二元区分），不再在这里维护第二份词表——两个词表必然漂移，而漂移
 * 的后果是插件内部两层互相抵消。
 *
 * 为什么曾经判错：这张表原来把 `"limit reached"` / `"daily"` / `"次数"` 归进
 * quota 桶，于是
 *
 *   - `"Rate limit reached, please retry after 60 seconds"` → quota（应为 rate_limit）
 *   - `"429 rate limit reached for rpm"`                → quota（应为 rate_limit）
 *   - `"请求过于频繁，请稍后重试"`                        → quota（"次数" 命中）
 *
 * 后果很具体：`inference-client` 据此选 `QUOTA_EXCEEDED`，而 `llm-retry.ts`刻意
 * 把 QUOTA 排除在可重试之外 —— 瞬时限频被当成耗尽、快失败且不重试；面板事件流
 * 还会把 rpm 限频显示成「额度耗尽」，与 `llm-error-fix.ts` 那套「429 不是耗尽」
 * 的纠正层在同一条数据上自相矛盾。
 *
 * 语义顺序：**限频信号优先，硬额度措辞兜底**。`looksLikeRateLimit` 正是这个
 * 二元判定（有限频信号且无硬额度措辞），所以它说 true → rate_limit；说 false
 * 时需要区分「有硬额度措辞的真耗尽」与「完全读不懂」，前者 quota、后者按更安全
 * 的默认归 rate_limit。
 */
export function classifyRateLimit(message: string): "quota" | "rate_limit" {
  if (typeof message !== "string" || message.length === 0) return "rate_limit";
  if (looksLikeRateLimit(message)) return "rate_limit";
  // 走到这里 = 没有限频信号。命中硬额度措辞才是真耗尽；否则读不懂 → rate_limit。
  return hasHardQuotaWording(message) ? "quota" : "rate_limit";
}

/** 文本是否含硬额度措辞（真耗尽，不纠正）——直接问 llm-error-fix 的那张表。 */
function hasHardQuotaWording(message: string): boolean {
  return hasHardQuotaWordingIn(message);
}

/**
 * 解析 Retry-After（秒或 HTTP 日期）与平台文案里写明的等待时长。
 * 上游声明多长就等多长，不截断也不放大；解析不出返回 null。
 */
export function parseRetryAfterMs(headers: { get?: (name: string) => string | null | undefined } | null | undefined, message: string): number | null {
  const raw = headers?.get?.("retry-after") ?? null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const seconds = Number(raw.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  // 文案里的等待时长。中文与英文都要认：只认中文时，上游把文案换成
  // "retry after 5 seconds" 会静默退化成「无时长」→ 调用方改用自己的默认退避。
  const cn = String(message).match(/(\d+)\s*(秒|分钟|小时|天)/);
  if (cn) {
    const unit = cn[2] ?? "秒";
    const value = Number(cn[1]);
    const multiplier = unit === "分钟" ? 60 : unit === "小时" ? 3600 : unit === "天" ? 86400 : 1;
    if (Number.isFinite(value) && value > 0) return value * multiplier * 1000;
  }
  // 注意 `(...)` 是**捕获**组：单位必须捕获才能读倍率。早先写成 `(?:...)` 时
  // `en[2]` 恒为 undefined，"2 minutes" 会被当成 2 秒——退避差 30 倍。
  const en = String(message).match(/(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i);
  if (en) {
    const value = Number(en[1]);
    const unit = (en[2] ?? "seconds").toLowerCase();
    const multiplier = unit.startsWith("min") ? 60
      : unit.startsWith("h") ? 3600
        : unit.startsWith("d") ? 86400
          : 1;
    if (Number.isFinite(value) && value > 0) return value * multiplier * 1000;
  }
  return null;
}
