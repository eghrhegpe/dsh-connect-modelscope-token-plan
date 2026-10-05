// codes.ts 的分诊行为测试：429 文案 → quota / rate_limit。
//
// ## 为什么这个文件存在（它守的是一个曾经静默失效的不变量）
//
// `classifyRateLimit` 曾长期**没有任何测试覆盖**——全套件绿灯，而它把
// "Rate limit reached"、"daily"、"次数" 全归进 quota 桶。后果不是分类错一点，
// 而是插件内部两层互相抵消：
//
//   inference-client 选 QUOTA_EXCEEDED → llm-retry 刻意把 QUOTA 排除在可重试之外
//   → 瞬时限频被当成额度耗尽、快失败且不重试；面板事件流还把 rpm 限频显示成
//     「额度耗尽」，与 llm-error-fix 那套「429 不是耗尽」的纠正层在同一条数据上矛盾。
//
// 判据现在与 `llm-error-fix.ts` 共用同一份词表（`looksLikeRateLimit` +
// `hasHardQuotaWordingIn`），本套件钉住**分流结果**，那张表改词时会一起红。
//
// 语义优先级（易被误改）：限频信号优先，硬额度措辞兜底，读不懂 → rate_limit
// （退避是两个方向里更安全的默认）。

import { strict as assert } from "node:assert";
import { classifyRateLimit, parseRetryAfterMs, classifyStatus, CODE } from "../src/host/codes.ts";
import { looksLikeRateLimit, hasHardQuotaWordingIn } from "../src/host/llm-error-fix.ts";

// §1 限频措辞 → rate_limit（可退避重试）。
//
// 这几条全部曾被误判成 quota：它们含 "limit reached" / "daily" / "次数"，
// 而旧词表只认这些词、不认限频词，于是「限频」被读成「耗尽」。
for (const message of [
  "Rate limit reached, please retry after 60 seconds",
  "429 rate limit reached for rpm",
  "Too Many Requests",
  "rate_limit exceeded, slow down",
  "请求过于频繁，请稍后重试",
  "每分钟请求次数超限",
  ""
]) {
  assert.equal(classifyRateLimit(message), "rate_limit", `限频体应判rate_limit：${JSON.stringify(message)}`);
}

// §2 硬额度措辞 → quota（快失败，重试无意义）。
for (const message of [
  "quota exceeded",
  "quota exhausted",
  "You have reached your daily limit",
  "daily quota limit reached",
  "balance exhausted",
  "out of credits",
  "额度已用尽",
  "每日调用上限"
]) {
  assert.equal(classifyRateLimit(message), "quota", `额度耗尽应判 quota：${JSON.stringify(message)}`);
}

// §3 读不懂 → rate_limit（保守默认：退避更安全）。
for (const message of ["some unrecognized upstream text", "  ", "429"]) {
  assert.equal(classifyRateLimit(message), "rate_limit", `读不懂应保守判 rate_limit：${JSON.stringify(message)}`);
}

// §4 非字符串输入不崩，且走保守默认。（.mjs 是纯 JS，不写 TS 断言——直接喂
// 运行时才会出现的值，函数内部必须自己挡住。）
assert.equal(classifyRateLimit(undefined), "rate_limit");
assert.equal(classifyRateLimit(null), "rate_limit");
assert.equal(classifyRateLimit(429), "rate_limit");
assert.equal(classifyRateLimit({}), "rate_limit");

// §5 两处判据是同一份词表（防止将来又各自维护一份而漂移）。
// limits 与 error-fix 对同一条消息必须给出一致判断。
for (const message of ["Rate limit reached", "quota exceeded", "每日调用上限", "unknown"]) {
  const isRate = looksLikeRateLimit(message);
  const hasHard = hasHardQuotaWordingIn(message);
  // classifyRateLimit 的语义：有限频信号 → rate_limit；否则硬额度 → quota。
  const expected = isRate ? "rate_limit" : hasHard ? "quota" : "rate_limit";
  assert.equal(classifyRateLimit(message), expected, `codes 与 error-fix 判据不一致：${JSON.stringify(message)}`);
  // 两者不能同时为真：那会让「有限频信号且有硬额度措辞」既像限频又像耗尽。
  assert.equal(isRate && hasHard, false, `同一条消息既是限频又命中硬额度：${JSON.stringify(message)}`);
}

// §6 classifyStatus 与 parseRetryAfterMs（分诊的另外两半）。
assert.equal(classifyStatus(401), CODE.AUTH_ERROR, "换令牌能修，绝不重试");
assert.equal(classifyStatus(403), CODE.AUTH_ERROR);
assert.equal(classifyStatus(429), CODE.RATE_LIMITED, "429 交由 classifyRateLimit 二次分诊");
assert.equal(classifyStatus(500), CODE.UPSTREAM_ERROR);
assert.equal(classifyStatus(200), CODE.NETWORK_ERROR);

// Retry-After 头：秒 / HTTP 日期。
assert.equal(parseRetryAfterMs({ get: () => "60" }, ""), 60_000, "秒 → 毫秒");
assert.equal(parseRetryAfterMs({ get: () => "0" }, ""), 0, "0 是合法答案（立即重试）");
assert.equal(parseRetryAfterMs({ get: () => "garbage" }, ""), null, "解析不出的头不猜");

// 文案里的等待时长：中文单位。**注意 30 分钟 = 1_800_000ms**（30 * 60 * 1000），
// 别把它当成 30 小时——那正是本文件第一次写断言时自己算错的地方。
assert.equal(parseRetryAfterMs({ get: () => null }, "请等待 30 分钟"), 1_800_000, "中文分钟");
assert.equal(parseRetryAfterMs({ get: () => null }, "等待 2 小时"), 7_200_000, "中文小时");
assert.equal(parseRetryAfterMs({ get: () => null }, "等待 30秒"), 30_000, "中文秒（无空格）");
assert.equal(parseRetryAfterMs({ get: () => null }, "等待 3 天"), 259_200_000, "中文天");

// 英文单位：曾经只认中文，上游把文案换成英文就静默退化成「无时长」。
assert.equal(parseRetryAfterMs({ get: () => null }, "retry after 5 seconds"), 5_000, "英文秒");
assert.equal(parseRetryAfterMs({ get: () => null }, "try again in 2 minutes"), 120_000, "英文分钟");
assert.equal(parseRetryAfterMs({ get: () => null }, "retry after 1 hour"), 3_600_000, "英文小时");
assert.equal(parseRetryAfterMs({ get: () => null }, "retry after 3 days"), 259_200_000, "英文天");
assert.equal(parseRetryAfterMs({ get: () => null }, "retry after 30 secs"), 30_000, "secs 缩写");

// 无时长可解析时返回 null，让调用方用自己的默认退避。
assert.equal(parseRetryAfterMs({ get: () => null }, "无时长信息"), null);
assert.equal(parseRetryAfterMs(null, ""), null, "无 headers 不炸");

console.log("codes.test.mjs: all checks passed");
