// 源码级测试：直接 import TS 源码（strip-types），验证 providerOf 的
// NaN / Infinity 防护。与 panel.test.mjs（测产物）互补——mutate.mjs 修改
// 源码后，本文件能抓到变异，而 panel.test.mjs 看不到源码改动。
import { strict as assert } from "node:assert";
import { providerOf, DEGRADED_PROVIDER } from "../src/client/snapshot.ts";
import { modelscopeModelUrl, HIDE_ALL_MODELS } from "../src/client/const.ts";

// ── 基线：合法 provider 块原样归一 ──
{
  const ok = {
    enabled: true, source: "panel", llmAvailable: true, registered: true, error: null,
    modelCount: 5, enabledCount: 3, allowed: "list",
    enabledIds: ["a", "b", "c"],
    roster: [
      { id: "a", name: "A", vision: true, available: true, quotaExhausted: false },
      { id: "b", name: "B", vision: false, available: true, quotaExhausted: false },
      { id: "c", name: "C", vision: false, available: false, quotaExhausted: true },
    ]
  };
  const r = providerOf(ok);
  assert.equal(r.modelCount, 5, "合法 modelCount 原样通过");
  assert.equal(r.enabledCount, 3, "合法 enabledCount 原样通过");
  assert.equal(r.roster.length, 3, "roster 长度保持");
}

// ── NaN 防护：typeof NaN === "number" 为 true，不检查 isFinite 会渲成「NaN 个模型」──
{
  const nan = { ...providerFixture(), modelCount: NaN, enabledCount: NaN };
  const r = providerOf(nan);
  assert.equal(r.modelCount, nan.roster.length, "NaN modelCount 回退为 roster.length");
  assert.equal(r.enabledCount, 0, "NaN enabledCount 回退为 0");
}

// ── Infinity 防护：typeof Infinity === "number" 同样为 true ──
{
  const inf = { ...providerFixture(), modelCount: Infinity, enabledCount: -Infinity };
  const r = providerOf(inf);
  assert.equal(r.modelCount, inf.roster.length, "Infinity modelCount 回退");
  assert.equal(r.enabledCount, 0, "-Infinity enabledCount 回退");
}

// ── 非对象输入 → DEGRADED_PROVIDER ──
{
  assert.deepEqual(providerOf(null), DEGRADED_PROVIDER, "null → 降级");
  assert.deepEqual(providerOf("bad"), DEGRADED_PROVIDER, "字符串 → 降级");
}

// ── 辅助：构造一个最小合法 provider 块 ──
function providerFixture() {
  return {
    enabled: false, source: "config", llmAvailable: false, registered: false, error: null,
    modelCount: 2, enabledCount: 1, allowed: "all",
    enabledIds: [],
    roster: [
      { id: "x", name: "X", vision: false, available: true, quotaExhausted: false },
      { id: "y", name: "Y", vision: true, available: true, quotaExhausted: false },
    ]
  };
}

// ── encodeURI 不转义 #/?，模型 id 含这些字符时 URL 语义被破坏 ──
{
  // 正常 id 不被过度转义（斜杠保留）
  const normal = modelscopeModelUrl("SenseNova/Light-14B");
  assert.match(normal, /SenseNova\/Light-14B$/, "正常 id 斜杠保留");

  // # 和 ? 必须被转义（否则成为 URL fragment / query）
  assert.match(modelscopeModelUrl("owner/model#section"), /%23/, "# 被转义为 %23");
  assert.match(modelscopeModelUrl("owner/model?query=1"), /%3F/, "? 被转义为 %3F");

  // 含特殊字符的 id 逐段转义
  const special = modelscopeModelUrl("owner/name with space");
  assert.match(special, /%20|name%20with%20space/, "空格被转义");

  // 多段 id
  const multi = modelscopeModelUrl("org/team/model");
  assert.match(multi, /org\/team\/model$/, "多段 id 斜杠保留");
}
