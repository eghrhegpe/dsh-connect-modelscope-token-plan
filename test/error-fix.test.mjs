// llm-error-fix 离线套件：把"看似限频却被 peer 误判为 QUOTA 的 429"纠正回
// RATE_LIMIT 的纯函数半边，peer-free。这里只钉本模块自身的纠正判定与流改写，
// 不依赖任何运行时 peer。
//
// 覆盖边界（不是覆盖）：真 peer 的 classifyPiAiError 行为**没有任何测试钉死**——
// 验证它需要运行时 peer，而 peer 未 vendored 进本仓库，所以进不了离线门禁
// （docs/ROADMAP.md Backlog）。本套件证明的是「给定 peer 那样的行为，我们的
// 纠正是对的」，证明不了 peer 的行为本身没有漂移。
import { strict as assert } from "node:assert";
import { reclassifyFinish, looksLikeRateLimit, CODE } from "../src/host/llm-error-fix.ts";

// looksLikeRateLimit 纯判据（v1 文本启发）：出现显式限频信号（RATE_SIGNAL 任一）
// 且不命中硬额度措辞（HARD_QUOTA_WORDING）才判为限频。
{
  // 显式限频信号。
  assert.equal(looksLikeRateLimit("HTTP 429 Too Many Requests"), true);
  assert.equal(looksLikeRateLimit("rate limit reached, try later"), true);
  assert.equal(looksLikeRateLimit("too many requests from this IP"), true);
  assert.equal(looksLikeRateLimit("requests per minute exceeded"), true);
  assert.equal(looksLikeRateLimit("throttled by upstream"), true);
  assert.equal(looksLikeRateLimit("rpm exhausted"), true);
  assert.equal(looksLikeRateLimit("请求过于频繁，请稍后再试"), true);
  assert.equal(looksLikeRateLimit("服务限流中"), true);
  // 真配额耗尽硬措辞 → 不纠正（避免把真耗尽拉去重试）。
  assert.equal(looksLikeRateLimit("balance exhausted"), false);
  assert.equal(looksLikeRateLimit("out of credits"), false);
  assert.equal(looksLikeRateLimit("quota exceeded, upgrade plan"), false);
  assert.equal(looksLikeRateLimit("额度已用尽"), false);
  // 空串兜底。
  assert.equal(looksLikeRateLimit(""), false);
}

// reclassifyFinish：只对"误判 QUOTA 的 error 型 finish chunk"改写 code→RATE_LIMIT，
// 保留原始 message 与所有其它字段。注意触发纠正需要 message 命中 RATE_CAP_WORDING
// （rpm/tpm/每分钟/限流/频率…），这正是魔搭把速率上限复用 quota_exceeded_error 名字
// 时的典型体。
{
  const quotaChunk = {
    type: "finish",
    reason: { kind: "error", failure: { code: CODE.QUOTA, message: "rpm exhausted for this minute, retry later" } }
  };
  const fixed = reclassifyFinish(quotaChunk);
  assert.equal(fixed.reason.failure.code, CODE.RATE_LIMIT, "误判 QUOTA 的 429（rpm 信号）→ RATE_LIMIT");
  assert.equal(fixed.reason.failure.message, "rpm exhausted for this minute, retry later", "message 原样保留");
  assert.equal(fixed.type, "finish", "其它字段不变");

  // 真配额耗尽（硬措辞，无速率信号）→ 不纠正。
  const hardQuota = {
    type: "finish",
    reason: { kind: "error", failure: { code: CODE.QUOTA, message: "balance exhausted" } }
  };
  assert.equal(reclassifyFinish(hardQuota).reason.failure.code, CODE.QUOTA, "真余额耗尽不纠正");

  // 非 QUOTA / 非 error / 非 finish → 原样返回（不创建新对象）。
  const nonError = { type: "message", data: { content: "hi" } };
  assert.equal(reclassifyFinish(nonError), nonError, "非 finish 直接透传");
  const success = { type: "finish", reason: { kind: "done" } };
  assert.equal(reclassifyFinish(success), success, "非 error 终止透传");
  const alreadyRate = {
    type: "finish",
    reason: { kind: "error", failure: { code: CODE.RATE_LIMIT, message: "throttled" } }
  };
  assert.equal(reclassifyFinish(alreadyRate), alreadyRate, "已是 RATE_LIMIT 不重复改写");
}

console.log("error-fix.test.mjs: all checks passed");
