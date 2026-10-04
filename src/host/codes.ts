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

/** 面板按它分流的稳定码表。 */
export const CODE = Object.freeze({
  CONFIG_ERROR: "config_error",
  NETWORK_ERROR: "network_error",
  TIMEOUT_ERROR: "timeout_error",
  AUTH_ERROR: "auth_error",
  RATE_LIMITED: "rate_limited",
  QUOTA_EXCEEDED: "quota_exceeded",
  UPSTREAM_ERROR: "upstream_error"
});

export type CodeValue = (typeof CODE)[keyof typeof CODE];

/**
 * 把上游 HTTP 状态归类成稳定码。
 *
 * 401/403 → AUTH_ERROR（换令牌能修，绝不自动重试——魔搭没有锁号问题，
 * 但重试一个坏令牌只会刷屏）；429 由调用方先走 {@link classifyRateLimit}
 * 分诊，这里只兜底；5xx → UPSTREAM_ERROR；其余 → NETWORK_ERROR。
 */
export function classifyStatus(status: number): CodeValue {
  if (status === 401 || status === 403) return CODE.AUTH_ERROR;
  if (status === 429) return CODE.RATE_LIMITED;
  if (status >= 500) return CODE.UPSTREAM_ERROR;
  if (status >= 400) return CODE.UPSTREAM_ERROR;
  return CODE.NETWORK_ERROR;
}

/**
 * 429 的文案分诊：quota（当日/单模型额度耗尽，重试无意义）vs rate_limit
 * （每分钟限频，退避有用）。判据是**平台自己的语言**，单词命中即可；没有
 * 文案或看不懂时归 rate_limit——退避是两个方向里更安全的默认。
 */
export function classifyRateLimit(message: string): "quota" | "rate_limit" {
  const text = String(message).toLowerCase();
  const quotaWords = ["quota", "daily", "limit reached", "额度", "上限", "次数"];
  return quotaWords.some((word) => text.includes(word)) ? "quota" : "rate_limit";
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
  const cn = String(message).match(/(\d+)\s*(秒|分钟|小时|天)/);
  if (cn) {
    const unit = cn[2] ?? "秒";
    const value = Number(cn[1]);
    const multiplier = unit === "分钟" ? 60 : unit === "小时" ? 3600 : unit === "天" ? 86400 : 1;
    if (Number.isFinite(value) && value > 0) return value * multiplier * 1000;
  }
  return null;
}
