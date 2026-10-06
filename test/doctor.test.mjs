// doctor 行为测试：注入 DSH_HOME 到临时目录，覆盖布局发现、usage.json 速览、
// 损坏/未知版本症状、env 令牌在场性，以及「令牌值绝不进任何输出」的红线。
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose, renderReport, hintFor, SYMPTOM } from "../src/host/doctor.ts";
import { describeProviderPayload } from "../src/host/provider-store.ts";
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

// ── §8 provider.json 速览：开关三态 + 清单条数，两份文件都合法 → 零症状。 ──
writeFileSync(join(dir, "usage.json"), JSON.stringify({ version: 1, days: {}, models: {}, events: [] }));
writeFileSync(join(dir, "provider.json"), JSON.stringify({ version: 1, enabled: false, enabledIds: ["a/A", "b/B"] }));
{
  const report = await diagnose({ dshHome: home });
  const scope = report.scopes[0];
  assert.equal(scope.provider === null, false, "provider.json 在场必须有速览");
  assert.equal(scope.provider.enabled, false, "保存的 false 必须与「未设置」分开");
  assert.equal(scope.provider.enabledIds, 2, "清单只报条数，不把 id 带进报告");
  assert.equal(scope.provider.versionKnown, true);
  assert.equal(scope.unreadable.length, 0);
  assert.equal(report.symptoms.length, 0, "两份文件都合法 → 零症状");
  assert.ok(renderReport(report).includes("provider.json"), "渲染出 provider.json 一行");
}

// 「从未设置」与「保存了空清单」也要分开：前者是 not set，后者报 0。
writeFileSync(join(dir, "provider.json"), JSON.stringify({ version: 1, enabledIds: [] }));
{
  const report = await diagnose({ dshHome: home });
  const scope = report.scopes[0];
  assert.equal(scope.provider.enabled, null, "缺省 enabled → not set");
  assert.equal(scope.provider.enabledIds, 0, "空清单报 0，不是 null");
  assert.equal(report.symptoms.length, 0);
}

// ── §9 provider.json 未知版本 → versionKnown:false + unreadable + 症状。 ──
writeFileSync(join(dir, "provider.json"), JSON.stringify({ version: 99, enabled: true, enabledIds: ["a/A"] }));
{
  const report = await diagnose({ dshHome: home });
  const scope = report.scopes[0];
  assert.equal(scope.provider.versionKnown, false, "未知版本被单独标记");
  assert.match(scope.unreadable.find((entry) => /provider\.json/.test(entry)) ?? "", /unknown version/);
  assert.equal(report.symptoms.length, 1);
  assert.equal(report.symptoms[0].id, SYMPTOM.STATE_UNREADABLE);
}

// ── §10 provider.json 损坏 → 同一症状 id 只报一次，渲染不漏内部形状。 ──
writeFileSync(join(dir, "provider.json"), "{not json", "utf8");
{
  const report = await diagnose({ dshHome: home });
  const scope = report.scopes[0];
  assert.equal(scope.provider, null, "损坏文件没有速览");
  assert.equal(scope.unreadable.filter((entry) => /provider\.json/.test(entry)).length, 1);
  assert.equal(report.symptoms.length, 1, "usage 与 provider 同属一个症状 id，不重复计数");
  assert.equal(report.symptoms[0].id, SYMPTOM.STATE_UNREADABLE);
  const rendered = renderReport(report);
  assert.ok(rendered.includes("UNREADABLE"), "人读行点出损坏文件");
  assert.ok(!rendered.includes("undefined"), "渲染层不漏内部形状");
}

// ── §11 describeProviderPayload 边界：形状不符 → null；清单去重后再计数。 ──
{
  assert.equal(describeProviderPayload(null), null);
  assert.equal(describeProviderPayload("nope"), null);
  assert.equal(describeProviderPayload({ enabled: true }), null, "无 version 键 → 不认识");
  assert.equal(describeProviderPayload({ version: "1" }), null, "字符串版本 → 不认识");
  assert.deepEqual(
    describeProviderPayload({ version: 1, enabled: true, enabledIds: ["a", "a", "b"] }),
    { versionKnown: true, enabled: true, enabledIds: 2 },
    "清单去重后再计数"
  );
  assert.equal(describeProviderPayload({ version: 1, enabled: "yes" }).enabled, null, "非布尔 enabled 归一化为未设置");
  assert.equal(describeProviderPayload({ version: 2, enabled: true }).versionKnown, false, "能解析但版本未知");
}

console.log("doctor.test.mjs: all checks passed");
