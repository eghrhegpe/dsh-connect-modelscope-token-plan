// doctor 行为测试：注入 DSH_HOME 到临时目录，覆盖布局发现、usage.json 速览、
// 损坏/未知版本症状、env 令牌在场性，以及「令牌值绝不进任何输出」的红线。
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose, renderReport, hintFor, SYMPTOM } from "../src/host/doctor.ts";
import { PLUGIN_ID } from "../src/shared/wire.ts";

const home = mkdtempSync(join(tmpdir(), "ms-doctor-"));
process.env.DSH_HOME = home;
delete process.env.MODELSCOPE_API_KEY;

// ── §1 空机器：无 profile、无共享状态 → 干净报告，零症状。 ──
{
  const report = await diagnose({ dshHome: home });
  assert.equal(report.plugin, PLUGIN_ID);
  assert.equal(report.profiled, false);
  assert.equal(report.shared, null);
  assert.equal(report.scopes.length, 0);
  assert.equal(report.tokenEnv, false);
  assert.equal(report.symptoms.length, 0, "干净机器的诚实答案是零症状");
  assert.ok(!renderReport(report).includes("undefined"), "渲染层不漏内部形状");
}

// ── §2 profile 布局：合法 usage.json → 速览正确、零症状。 ──
const dir = join(home, "state", "p1", PLUGIN_ID);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "usage.json"), JSON.stringify({
  version: 1,
  days: { "2026-10-04": { calls: 2, tokens: 30 } },
  models: {},
  events: [{ at: "2026-10-04T00:00:00Z", modelId: "m", kind: "error", message: "x" }]
}));
{
  const report = await diagnose({ dshHome: home });
  assert.equal(report.profiled, true);
  assert.equal(report.scopes.length, 1);
  assert.equal(report.scopes[0].profile, "p1");
  assert.equal(report.scopes[0].usage.days, 1);
  assert.equal(report.scopes[0].usage.events, 1);
  assert.equal(report.scopes[0].usage.versionKnown, true);
  assert.equal(report.scopes[0].unreadable.length, 0);
  assert.equal(report.symptoms.length, 0);
  assert.ok(renderReport(report).includes("p1"), "渲染出 profile 名");
}

// ── §3 损坏文件 → unreadable + 症状。 ──
writeFileSync(join(dir, "usage.json"), "{not json", "utf8");
{
  const report = await diagnose({ dshHome: home });
  assert.match(report.scopes[0].unreadable[0] ?? "", /usage\.json/);
  assert.equal(report.symptoms.length, 1);
  assert.equal(report.symptoms[0].id, SYMPTOM.STATE_UNREADABLE);
  assert.notEqual(report.symptoms[0].hint, "", "症状必须带下一步动作");
}

// ── §4 未知版本 → 仍属 unreadable 类，但速览保留 versionKnown:false。 ──
writeFileSync(join(dir, "usage.json"), JSON.stringify({ version: 99, days: { "2099-01-01": { calls: 1, tokens: 1 } } }));
{
  const report = await diagnose({ dshHome: home });
  assert.equal(report.scopes[0].usage.versionKnown, false, "未知版本被单独标记");
  assert.equal(report.symptoms.length, 1);
}

// ── §5 共享布局：无 profile 时报 shared 作用域。 ──
{
  const local = mkdtempSync(join(tmpdir(), "ms-doctor-shared-"));
  const dir2 = join(local, "state", PLUGIN_ID);
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "usage.json"), JSON.stringify({ version: 1, days: {}, models: {}, events: [] }));
  const report = await diagnose({ dshHome: local });
  assert.equal(report.profiled, false);
  assert.equal(report.shared === null, false, "无 profile 时共享布局是唯一作用域");
  assert.equal(report.shared.usage.days, 0);
}

// ── §6 env 令牌在场性：只报布尔，裸值绝不进输出（红线 1）。 ──
process.env.MODELSCOPE_API_KEY = "ms-00000000-0000-0000-0000-000000000000";
{
  const report = await diagnose({ dshHome: home });
  assert.equal(report.tokenEnv, true);
  const rendered = renderReport(report) + JSON.stringify(report);
  assert.ok(!rendered.includes("ms-00000000"), "令牌裸值绝不进 doctor 的任何输出");
}
delete process.env.MODELSCOPE_API_KEY;

// ── §7 hint 总函数：每个声明过的症状都有 hint（缺一条编译就该红）。 ──
for (const id of Object.values(SYMPTOM)) {
  assert.equal(typeof hintFor(id), "string");
}

console.log("doctor.test.mjs: all checks passed");
