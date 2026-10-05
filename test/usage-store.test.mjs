// usage-store 行为测试：注入 DSH_HOME 到临时目录，隔离的 profile 段里跑。
// 覆盖：天桶/单模型计数、跨日清零、事件有界、损坏即忽略、版本只读闸。
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileUsageStore, localDateKey } from "../src/host/usage-store.ts";
import { PLUGIN_ID } from "../src/shared/wire.ts";

const home = mkdtempSync(join(tmpdir(), "ms-usage-"));
process.env.DSH_HOME = home;
const PROFILE = "test-profile";
const dir = join(home, "state", PROFILE, PLUGIN_ID);
const file = join(dir, "usage.json");

const warnings = [];
const makeStore = (overrides = {}) => createFileUsageStore({
  name: PLUGIN_ID,
  profile: PROFILE,
  trendDays: 3,
  maxEvents: 3,
  now: () => clock,
  logger: { warn: (m) => warnings.push(m) },
  ...overrides
});

// §1 基本计数：同一模型同一天（日期用本地时间构造，测试不依赖机器时区）。
// 时钟可变：store 的「今天」跟着 clock 走，跨日场景直接拨表。
const t0 = new Date(2026, 9, 4, 10, 0, 0);
let clock = t0;
const store = makeStore();
await store.recordCall({ modelId: "deepseek-ai/DeepSeek-V4.1-Flash", tokens: 32, at: t0 });
await store.recordCall({ modelId: "deepseek-ai/DeepSeek-V4.1-Flash", tokens: 10, at: t0 });
await store.recordCall({ modelId: "Qwen/Qwen3-Coder", tokens: null, at: t0 });
const daily = await store.daily();
assert.equal(daily.calls, 3, "账户级调用数");
assert.equal(daily.tokens, 42, "token 总数累加");
const perModel = await store.perModelToday();
assert.equal(perModel.length, 2, "两个模型有记录");
assert.equal(perModel[0].modelId, "deepseek-ai/DeepSeek-V4.1-Flash", "按次数降序");
assert.equal(perModel[0].calls, 2);
assert.equal(perModel[0].tokens, 42);

// §2 持久化：文件落盘且为 version 1；新实例读回同一状态。
const onDisk = JSON.parse(readFileSync(file, "utf8"));
assert.equal(onDisk.version, 1);
const reopened = makeStore();
assert.equal((await reopened.daily()).calls, 3, "重启后计数仍在");

// §3 跨日：拨表到 10-05，dayCalls 清零、总累计保留；趋势桶按天对齐。
const t1 = new Date(2026, 9, 5, 9, 0, 0);
clock = t1;
await store.recordCall({ modelId: "deepseek-ai/DeepSeek-V4.1-Flash", tokens: 5, at: t1 });
const perModelNext = await store.perModelToday();
assert.equal(perModelNext[0].calls, 1, "跨日后当日计数清零重计");
assert.equal(perModelNext[0].tokens, 5, "跨日后当日 token 同步清零（今日口径，不再并排历史累计 42）");
const trend = await store.trend(3);
assert.deepEqual(trend.map((b) => b.dateKey), [localDateKey(new Date(2026, 9, 3)), localDateKey(new Date(2026, 9, 4)), localDateKey(new Date(2026, 9, 5))], "趋势以本地日历天对齐");
assert.equal(trend[1].calls, 3);
assert.equal(trend[2].calls, 1);

// §4 天桶修剪：trendDays=3，出现第 4 个天桶后最早的那个被删。
const old = new Date(2026, 8, 20, 9, 0, 0);
await store.recordCall({ modelId: "m/x", tokens: null, at: old });
const t2 = new Date(2026, 9, 6, 8, 0, 0);
await store.recordCall({ modelId: "m/x", tokens: null, at: t2 });
const pruned = JSON.parse(readFileSync(file, "utf8"));
assert.ok(!("2026-09-20" in pruned.days), "超出保留窗口的天桶被修剪");
assert.deepEqual(Object.keys(pruned.days).sort(), [localDateKey(new Date(2026, 9, 4)), localDateKey(new Date(2026, 9, 5)), localDateKey(new Date(2026, 9, 6))]);

// §5 事件有界：maxEvents=3，Newest-first。
for (let i = 0; i < 5; i += 1) {
  await store.recordEvent({ modelId: "m/x", kind: "rate_limit", message: `hit ${i}`, at: new Date(t1.getTime() + i * 1000) });
}
const events = await store.events();
assert.equal(events.length, 3);
assert.equal(events[0].message, "hit 4", "最新在前");

// §6 损坏即忽略：非 JSON → 读作空不炸；形状坏（days 非对象）→ anomaly 痕迹。
writeFileSync(file, "{not json", "utf8");
const corrupted = makeStore();
assert.equal((await corrupted.daily()).calls, 0, "非 JSON 读作空，不炸");
writeFileSync(file, JSON.stringify({ version: 1, days: 42 }), "utf8");
const shapeshift = makeStore();
assert.equal((await shapeshift.daily()).calls, 0);
assert.match(shapeshift.anomaly() ?? "", /days is not an object/, "形状损坏留下 shapeWarning 痕迹");

// §7 版本只读闸：磁盘 version 2 → 读作空且写入被拒绝（不 clobber）。
mkdirSync(dir, { recursive: true });
writeFileSync(file, JSON.stringify({ version: 2, days: { "2099-01-01": { calls: 9, tokens: 9 } } }), "utf8");
warnings.length = 0;
const future = makeStore();
assert.equal((await future.daily()).calls, 0, "未知版本读作空");
await future.recordCall({ modelId: "m/y", tokens: null, at: t0 });
assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 2, "只读闸：新版本文件未被覆写");
assert.equal((await future.state()).readOnly, true);

// §7b 守卫必须在**第一次写入**之前就位，不能靠读路径的副作用。
//
// 回归用例，对应一次真实事故：守卫早先写在 enqueue 开头，而 readOnly 的置位
// 发生在其后的 cache.read() 内部——判据比真正的探测晚了一步，于是**首次**
// recordCall 就用空载荷把version 2 的文件降级覆写成 version 1（实测两天共 110
// 次历史归零，而日志还在说 "recording disabled to avoid clobbering"：日志与磁盘
// 状态互相撒谎）。§7 测的是「先读后写」，恰好绕过了这一步，所以全绿。
//
// 这里**不读**就直接写：新实例的第一个动作必须是 recordCall。
{
  const v2 = JSON.stringify({
    version: 2,
    days: { "2026-10-01": { calls: 50, tokens: 5000 }, "2026-10-02": { calls: 60, tokens: 6000 } },
    models: {},
    events: []
  });
  writeFileSync(file, v2, "utf8");
  warnings.length = 0;
  const blind = makeStore();
  await blind.recordCall({ modelId: "m/first", tokens: 1, at: t0 });
  assert.equal(
    readFileSync(file, "utf8"),
    v2,
    "首次写入（未经任何读）也不得clobber 新版本文件"
  );
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.version, 2, "磁盘版本保持 2，不被降级覆写");
  assert.equal(onDisk.days["2026-10-01"].calls, 50, "历史天桶保持不变");
  assert.equal(onDisk.days["2026-10-02"].calls, 60, "历史天桶保持不变");
  assert.ok(
    warnings.some((m) => /newer than this build knows/.test(m)),
    "并且要留下警告（此前是「日志说在保护、磁盘已被抹」）"
  );
}

// §7c 只读闸必须能复位：删掉文件是用户可见的恢复手段（doctor 就是这么建议的）。
//
// 闩锁曾经只置位不复位，于是这条路径永久静默：文件不重建、每次写入被丢弃，面板
// 却还在显示内存里的残留数字，用户唯一出路是重启 Host。
{
  writeFileSync(file, JSON.stringify({ version: 2, days: { "2026-10-01": { calls: 9, tokens: 9 } } }), "utf8");
  const latched = makeStore();
  await latched.recordCall({ modelId: "m/a", tokens: 1, at: t0 });
  assert.equal((await latched.state()).readOnly, true, "先闩住");
  rmSync(file, { force: true });
  await latched.recordCall({ modelId: "m/b", tokens: 5, at: t0 });
  assert.ok(existsSync(file), "删文件后写入必须恢复（闩锁要复位）");
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).models["m/b"].tokens,
    5,
    "恢复后的新计数真的落盘了"
  );
  assert.equal((await latched.state()).readOnly, false, "闩锁已复位");
}

// §8 localDateKey 是本地时区日历天。
assert.equal(localDateKey(new Date(2026, 9, 4)), "2026-10-04");

console.log("usage-store.test.mjs: all checks passed");
