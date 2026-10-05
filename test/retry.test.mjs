// llm-retry 离线套件：429 重试策略的纯函数半边，peer-free（不 import 任何运行时
// peer；真 peer 的 resolveRetryPolicy 契约由 test/peer-contract.test.mjs 在 peer 可达
// 时钉死，该 peer 未 vendored 本仓库）。这里只钉本模块自身导出的形状与语义。
import { strict as assert } from "node:assert";
import { buildRetryPolicyConfig, retryableCodes, QUOTA_CODES } from "../src/host/llm-retry.ts";

// 重试码集合：排除两种配额耗尽（共享池耗尽不可重试，重试只会拖长冷却窗）。
{
  const codes = retryableCodes();
  assert.deepEqual(codes, [
    QUOTA_CODES.emptyResponse,
    QUOTA_CODES.rateLimit,
    QUOTA_CODES.server,
    QUOTA_CODES.timeout,
    QUOTA_CODES.transport
  ], "重试码固定顺序，且不含 QUOTA/ACCOUNT_QUOTA");
  assert.ok(!codes.includes(QUOTA_CODES.quota), "QUOTA 不重试（共享池耗尽）");
  assert.ok(!codes.includes(QUOTA_CODES.accountQuota), "ACCOUNT_QUOTA 不重试");
  // 无重复、非空（consumer 需要有效数组）。
  assert.equal(new Set(codes).size, codes.length, "无重复码");
  assert.ok(codes.length > 0, "重试码非空");
}

// 策略形状：正好是 peer 的 resolveRetryPolicy 接受的 { mode, maxRetries, retryableCodes, backoff }。
// 数字针对魔搭白天 rpm/tpm 上限调过：尝试更多、初退更长、带抖动，但不无限自旋。
{
  const cfg = buildRetryPolicyConfig();
  assert.equal(cfg.mode, "normal");
  assert.equal(cfg.maxRetries, 8, "8 次重试覆盖白天的速率窗口");
  assert.deepEqual(cfg.retryableCodes, retryableCodes(), "重试码与 retryableCodes 同源");
  assert.equal(cfg.backoff.initialDelayMs, 1500, "初退 1.5s（比 peer 默认更缓，不立即重锤共享池）");
  assert.equal(cfg.backoff.maxDelayMs, 20000, "上限 20s");
  assert.equal(cfg.backoff.jitterRatio, 0.25, "25% 抖动打散并发");
  // 有限上界：真故障约 ~90s 退避后失败，而非无限。
  assert.ok(cfg.backoff.maxDelayMs >= cfg.backoff.initialDelayMs, "退避上限 ≥ 初退");
}

// ─────────────────────────────────────────────────────────────────────────
// 承重契约：重分类改写出的 code，必须真的落在本策略的 retryableCodes 里。
//
// 这是本插件全部 429 自愈价值的**唯一接缝**，而它此前没有任何测试覆盖：
// `error-fix.test.mjs` 钉「改写后的 code 是什么」，本文件钉「可重试码有哪些」，
// 但「改写后的 code ∈ 可重试码」这一步没人测。若哪天有人把 RATE_LIMIT 移出
// retryableCodes、或把重分类的目标码改成别的字符串，两侧各自的测试都会继续
// 全绿，而线上表现为「限频永远快失败、退避重试从不发生」。
//
// 链路依据（2026-10-05 读 peer 源码核实）：
//   dsh-agent-loop/lib/index.js:1116-1134 —— 流被消费完后读 `live.finish`，
//     以 `failure: finish.failure` 派发 `agent/request-error` 瀑布；
//   dsh-llm-retry/lib/index.js:160 —— `retryableCodes.includes(failure.code)`。
// 故流出口改写出的 code 就是重试判据本身。
// ─────────────────────────────────────────────────────────────────────────

// 1. 一个被 peer 判成 QUOTA、但实为 rpm 限频的魔搭错误体，经重分类后必须可重试。
{
  const { shouldReclassifyQuotaToRate, reclassifyFinish } = await import("../src/host/llm-error-fix.ts");
  const { CODE } = await import("../src/host/llm-error-fix.ts");
  const motorBike = {
    message: '{"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}',
    code: "QUOTA"
  };
  assert.equal(
    shouldReclassifyQuotaToRate(motorBike),
    true,
    "rpm exhausted 体应被纠正为限频（魔搭把速率上限复用 quota_exceeded_error 这个名字）"
  );
  const finish = reclassifyFinish({
    type: "finish",
    reason: { kind: "error", failure: motorBike }
  });
  const rewritten = finish.reason.failure.code;
  assert.equal(rewritten, "RATE_LIMIT", "改写结果就是 peer 的 RATE_LIMIT 字面量");
  assert.ok(
    retryableCodes().includes(rewritten),
    `重分类后的 code ${rewritten} 必须在本策略的 retryableCodes 内，否则自愈路径断在这里`
  );
  assert.equal(rewritten, QUOTA_CODES.rateLimit, "改写目标与本模块的 rateLimit 码字面量一致");
  // 同时确认它确实**不是**被排除的那个码（否则本用例会被上面的 includes 掩盖）。
  assert.ok(!retryableCodes().includes(QUOTA_CODES.quota), "QUOTA 仍不在可重试码内");
}

// 2. 真配额耗尽**不得**被拉进可重试码：改写应为 false，且原 code 不可重试。
{
  const { shouldReclassifyQuotaToRate } = await import("../src/host/llm-error-fix.ts");
  const exhausted = {
    message: '{"message":"balance exhausted","type":"quota_exceeded_error"}',
    code: "QUOTA"
  };
  assert.equal(shouldReclassifyQuotaToRate(exhausted), false, "真耗尽不纠正（重试只会延长冷却窗）");
  assert.ok(
    !retryableCodes().includes(QUOTA_CODES.quota),
    "真耗尽的 QUOTA 必须落在可重试码之外——快失败并让面板说明原因"
  );
}

console.log("retry.test.mjs: all checks passed");
