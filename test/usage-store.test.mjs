// usage-store 行为测试：注入 DSH_HOME 到临时目录，隔离的 profile 段里跑。
// 覆盖：天桶/单模型计数、跨日清零、事件有界、损坏即忽略、版本只读闸。
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileUsageStore, localDateKey, exhaustedModelIds } from "../src/host/usage-store.ts";
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
  retentionDays: 3,
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

// §4 天桶修剪：retentionDays=3，出现第 4 个天桶后最早的那个被删。
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

// §6 读不到 ≠ 0：非 JSON / 形状坏 → daily 给 **null**（不可知），且留下痕迹。
//
// 判据是「文件在不在」：文件不存在才是真实的 0（这台 Host 从没调用过，那是
// **已知答案**）；文件在却读成空是**信息丢失**，把它报成 0 会让操作者以为今天
// 没调用过，而真相是他不知道（wire.ts DailyUsage 的 null≠0 基线）。
writeFileSync(file, "{not json", "utf8");
const corrupted = makeStore();
assert.equal((await corrupted.daily()).calls, null, "损坏：不炸，但也不谎报 0");
writeFileSync(file, JSON.stringify({ version: 1, days: 42 }), "utf8");
const shapeshift = makeStore();
assert.equal((await shapeshift.daily()).calls, null, "形状损坏 → null（不是 0）");
assert.match(shapeshift.anomaly() ?? "", /days is not an object/, "形状损坏留下 shapeWarning 痕迹");

// §6b 反向对照：文件压根不存在 → 真实的 0。
rmSync(file, { force: true });
const fresh = makeStore();
assert.equal((await fresh.daily()).calls, 0, "文件不存在 = 真实的 0（没调用过是已知答案，不是数据丢失）");
assert.equal((await fresh.daily()).tokens, 0);
assert.equal(fresh.anomaly(), null, "真实零不该带任何痕迹");

// §7 版本只读闸：磁盘 version 2 → 读作空且写入被拒绝（不 clobber）。
mkdirSync(dir, { recursive: true });
writeFileSync(file, JSON.stringify({ version: 2, days: { "2099-01-01": { calls: 9, tokens: 9 } } }), "utf8");
warnings.length = 0;
const future = makeStore();
// 磁盘上明明白白写着 9 次调用，但那是更新构建的格式，本构建不该读它——于是答案
// 既不是 9 也不是 0，而是「不知道」。报 0 是伪造（操作者会以为今天很闲）。
assert.equal((await future.daily()).calls, null, "未知版本读作「读不到」，不是空");
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

// §9 两个 store 实例共用同一个状态目录（两个 Host 进程是同一件事）：写基线必须来自
// **磁盘上的当前值**，不能是各自内存里的陈旧快照。
//
// 曾经写路径是 `loaded ? current : …`——首次落盘之后再也不读盘，于是 A 的第二次写会用
// 自己那份旧载荷把 B 刚写下的**整份**数据覆盖掉：丢的不只是计数，还有 events 与趋势
// 天桶，而且没有任何日志。provider-store 的 patchPayload 一直是「临界区内重新读盘」，
// 这条用例把 usage-store 拉回同一条纪律。
{
  const shared = "cross-instance";
  const a = makeStore({ profile: shared });
  const b = makeStore({ profile: shared });
  const sharedFile = join(home, "state", shared, PLUGIN_ID, "usage.json");

  await a.recordCall({ modelId: "a/A", tokens: 1, at: clock });
  await b.recordCall({ modelId: "b/B", tokens: 7, at: clock });   // B 首次写：读盘合并（旧代码也对）
  await a.recordCall({ modelId: "a/A", tokens: 1, at: clock });   // A 第二次写：基线若取内存就会覆盖 B

  const sharedOnDisk = JSON.parse(readFileSync(sharedFile, "utf8"));
  assert.deepEqual(
    Object.keys(sharedOnDisk.models).sort(),
    ["a/A", "b/B"],
    "B 写下的模型不得被 A 的陈旧基线整份覆盖"
  );
  assert.equal(sharedOnDisk.models["a/A"].calls, 2, "A 自己的计数照常累加");
  assert.equal(sharedOnDisk.models["b/B"].tokens, 7, "B 的计数保持");
}

// §10 额度耗尽集合的推断（纯函数 exhaustedModelIds）——picker 丢不丢一个模型、
// 面板灰显谁的**唯一判定真源**。三条规则各有用例：只有 quota 算证据、窗口外
// 不算、不推断恢复（成功不发事件，恢复不可观测）。
//
// 事故背景：0.2.0 曾把**任何** 429 都当额度耗尽（QUOTA 快速失败 vs RATE_LIMIT
// 退避两条路被压成一条），这里把 kind 分诊钉死。
{
  const now = new Date(2026, 9, 18, 12, 0, 0);
  const at = (msAgo) => new Date(now.getTime() - msAgo).toISOString();
  const ev = (modelId, kind, msAgo) => ({ at: at(msAgo), modelId, kind, message: "m" });

  // ① 只有 kind:"quota" 算证据——rate_limit 会退避重试、error 是未知。
  assert.deepEqual(
    exhaustedModelIds([ev("a/A", "quota", 60_000)], now, 60),
    ["a/A"],
    "窗口内的 quota 事件 → 耗尽"
  );
  assert.deepEqual(
    exhaustedModelIds([ev("a/A", "rate_limit", 60_000), ev("b/B", "error", 60_000)], now, 60),
    [],
    "rate_limit（瞬时限频，会退避重试）与 error（未知）都不是耗尽证据"
  );

  // ② 窗口边界：window 内有效、外过期（额度按天重置，昨天的耗尽不关今天的模型）。
  assert.deepEqual(
    exhaustedModelIds([ev("a/A", "quota", 60 * 60_000 - 1)], now, 60),
    ["a/A"],
    "恰好落在窗口内（差 1ms）算"
  );
  assert.deepEqual(
    exhaustedModelIds([ev("a/A", "quota", 60 * 60_000 + 1)], now, 60),
    [],
    "移出窗口 1ms 即恢复——没有「手动解除」这种东西，恢复是时间性的"
  );

  // ③ 不推断恢复：成功不发事件，所以「已恢复」在这份数据里不可观测；
  //    一个模型在窗口内先耗尽后又成功过，仍然算耗尽（保守方向）。
  assert.deepEqual(
    exhaustedModelIds([ev("a/A", "quota", 30 * 60_000)], now, 60),
    ["a/A"],
    "耗尽后即便调用成功过（无事件），窗口内仍判耗尽——宁可少提供一会"
  );

  // ④ 形状防御：乱序、重复、坏时间戳、空 modelId 都不许把结果带歪。
  assert.deepEqual(
    exhaustedModelIds([ev("b/B", "quota", 10_000), ev("a/A", "quota", 20_000), ev("a/A", "quota", 30_000)], now, 60),
    ["a/A", "b/B"],
    "去重 + 排序（快照稳定，quotaSignature 才不无故漂移）"
  );
  assert.deepEqual(
    exhaustedModelIds([{ at: "not-a-timestamp", modelId: "a/A", kind: "quota", message: "m" }], now, 60),
    [],
    "时间戳解析不了的事件跳过，不猜"
  );
  assert.deepEqual(
    exhaustedModelIds([{ at: at(10_000), modelId: "", kind: "quota", message: "m" }], now, 60),
    [],
    "空 modelId 跳过（「某个模型耗尽但不知道是哪个」不是可用证据）"
  );
  assert.deepEqual(exhaustedModelIds(null, now, 60), [], "null 事件流 = 没有证据");
  assert.deepEqual(exhaustedModelIds([], now, 60), [], "空事件流 = 没有证据");
  assert.deepEqual(
    exhaustedModelIds([ev("a/A", "quota", 0)], now, 0),
    [],
    "windowMinutes 非正 = 总量防御的空集（host-config 已夹 [5,1440]，走到这是编程错误）"
  );
  assert.deepEqual(
    exhaustedModelIds([ev("a/A", "quota", 0)], now, Number.NaN),
    [],
    "windowMinutes 非有限 = 空集（同上）"
  );
}

console.log("usage-store.test.mjs: all checks passed");
