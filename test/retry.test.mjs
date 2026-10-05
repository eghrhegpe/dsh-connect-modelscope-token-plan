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

console.log("retry.test.mjs: all checks passed");
