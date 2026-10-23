// roster-seen-store 行为测试：归一、首见窗口、播种不宣布、形状漂移不写、下架丢弃、
// ADR-006 写守卫、读侧 versionNote、doctor 速览函数。
//
// 为什么单独立一个套件：这是第五个状态文件（provider / usage / draw / usage-prefs
// 之后）。它比前四个更容易出**语义**事故而不是完整性事故——「新模型」这句话一旦
// 说错（把整个目录宣布成刚上架、把震荡计数当真、把下架又回来的模型说成从没存在
// 过），面板就在对用户的事实断言上撒谎。所以本套件把每一句谎各钉一条。
//
// 断言一律打在**磁盘**上：内存断言会被 cache.remember 喂成假的（provider §8d 的
// 教训——写后回读走 TTL 缓存，拿到的是写入前的值）。
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileRosterSeenStore,
  describeRosterSeenPayload,
  normalizeRosterSeen,
  freshIdsOf,
  isKnownRosterSeenVersion,
  ROSTER_SEEN_VERSION,
  KNOWN_ROSTER_SEEN_VERSIONS,
  ROSTER_SEEN_NEW_WINDOW_MS,
  ROSTER_SEEN_MAX_IDS
} from "../src/host/roster-seen-store.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "ms-roster-seen-"));
const diskOf = (dir) => JSON.parse(readFileSync(join(dir, "roster-seen.json"), "utf8"));
const DAY = 24 * 60 * 60 * 1000;

// ── §1 归一函数与版本白名单 ──
{
  assert.deepEqual(normalizeRosterSeen({ a: 1, b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(normalizeRosterSeen({ a: 0 }), {}, "0 戳丢掉（会让 id 永远算新）");
  assert.deepEqual(normalizeRosterSeen({ a: -5 }), {}, "负戳丢掉");
  assert.deepEqual(normalizeRosterSeen({ a: Number.NaN }), {}, "NaN 丢掉");
  assert.deepEqual(normalizeRosterSeen({ a: Number.POSITIVE_INFINITY }), {}, "Infinity 丢掉");
  assert.deepEqual(normalizeRosterSeen({ a: "123" }), {}, "字符串戳不是数字");
  assert.deepEqual(normalizeRosterSeen({ "": 123 }), {}, "空 id 丢掉");
  assert.deepEqual(normalizeRosterSeen(null), {});
  assert.deepEqual(normalizeRosterSeen([]), {}, "数组不是表");
  assert.deepEqual(normalizeRosterSeen("nope"), {});
  assert.equal(isKnownRosterSeenVersion(1), true);
  assert.equal(isKnownRosterSeenVersion(ROSTER_SEEN_VERSION), true);
  assert.equal(isKnownRosterSeenVersion(2), false, "只认白名单，不与写版本比较");
  assert.equal(isKnownRosterSeenVersion(null), false, "读侧判据不放行 null（写侧才放行）");
  assert.deepEqual(KNOWN_ROSTER_SEEN_VERSIONS, [1]);
}

// ── §2 freshIdsOf：窗口边界 + 升序 ──
{
  const now = 1_000 * DAY;
  assert.deepEqual(freshIdsOf({}, now), [], "空表 → 空");
  assert.deepEqual(freshIdsOf({ a: now }, now), ["a"], "刚见到 → 新");
  assert.deepEqual(freshIdsOf({ a: now - ROSTER_SEEN_NEW_WINDOW_MS + 1 }, now), ["a"], "窗口内（差 1ms）→ 新");
  assert.deepEqual(freshIdsOf({ a: now - ROSTER_SEEN_NEW_WINDOW_MS }, now), [], "正好落在窗口边界 → 不算新");
  assert.deepEqual(freshIdsOf({ a: now - 30 * DAY }, now), [], "早就过期 → 不算新");
  assert.deepEqual(
    freshIdsOf({ late: now - 1 * DAY, early: now - 3 * DAY, middle: now - 2 * DAY }, now),
    ["early", "middle", "late"],
    "按首见时间升序（最老的在前）"
  );
  assert.deepEqual(
    freshIdsOf({ fresh: now - DAY, stale: now - 30 * DAY }, now),
    ["fresh"],
    "过期的不进结果"
  );
}

// ── §3 首轮是播种：写盘、但一个都不宣布 ──
{
  const dir = tmp();
  const store = createFileRosterSeenStore({ dir });
  assert.equal(existsSync(join(dir, "roster-seen.json")), false, "还没写过 → 文件不在场");
  assert.equal(await store.isSet(), false);
  assert.deepEqual(await store.fresh(1000 * DAY), [], "没有表 → 没有新模型");

  const first = await store.note(["a", "b"], 1000 * DAY);
  assert.deepEqual(first.newIds, [], "播种轮不宣布任何模型（不知道谁才是新的）");
  assert.equal(await store.isSet(), true);
  const disk = diskOf(dir);
  assert.equal(disk.version, ROSTER_SEEN_VERSION);
  assert.equal(disk.seen.a, 1000 * DAY - ROSTER_SEEN_NEW_WINDOW_MS, "播种戳盖成「已过期」");
  assert.equal(disk.seen.b, 1000 * DAY - ROSTER_SEEN_NEW_WINDOW_MS);
  assert.deepEqual(await store.fresh(1000 * DAY), [], "播种的 id 一个都不算新");
}

// ── §4 目录增长：只有新出现的 id 被宣布，老 id 保留原戳 ──
{
  const dir = tmp();
  const store = createFileRosterSeenStore({ dir });
  await store.note(["a", "b"], 1000 * DAY);

  const grown = await store.note(["a", "b", "c"], 1001 * DAY);
  assert.deepEqual(grown.newIds, ["c"], "只有 c 是新见到的");
  assert.equal(diskOf(dir).seen.a, 1000 * DAY - ROSTER_SEEN_NEW_WINDOW_MS, "老 id 的戳不动");
  assert.equal(diskOf(dir).seen.c, 1001 * DAY, "新 id 盖当前时刻");

  // 再拉一遍同样的目录：c 还是新的（窗口内），但戳不该被刷新。
  const again = await store.note(["a", "b", "c"], 1002 * DAY);
  assert.deepEqual(again.newIds, ["c"], "窗口内反复看到仍算新");
  assert.equal(diskOf(dir).seen.c, 1001 * DAY, "反复看到不刷新首见戳");

  // 窗口过了 → 不再算新。
  assert.deepEqual((await store.note(["a", "b", "c"], 1001 * DAY + ROSTER_SEEN_NEW_WINDOW_MS)).newIds, []);
}

// ── §5 下架再上架 = 重新首见（而不是「从没存在过」） ──
{
  const dir = tmp();
  const store = createFileRosterSeenStore({ dir });
  await store.note(["a", "b"], 1000 * DAY);
  const shrunk = await store.note(["a"], 1001 * DAY);
  assert.deepEqual(shrunk.newIds, [], "下架不产生新模型");
  assert.equal(diskOf(dir).seen.b, undefined, "下架的 id 从表里丢掉");
  const back = await store.note(["a", "b"], 1002 * DAY);
  assert.deepEqual(back.newIds, ["b"], "回来的 id 算重新首见");
  assert.equal(diskOf(dir).seen.b, 1002 * DAY);
}

// ── §6 空目录：不写、不清表（一次瞬时空目录不许把历史抹掉） ──
{
  const dir = tmp();
  const store = createFileRosterSeenStore({ dir });
  await store.note(["a", "b"], 1000 * DAY);
  const before = readFileSync(join(dir, "roster-seen.json"), "utf8");
  assert.deepEqual((await store.note([], 1001 * DAY)).newIds, []);
  assert.deepEqual((await store.note(["", ""], 1001 * DAY)).newIds, [], "空串 id 也不算");
  assert.equal(readFileSync(join(dir, "roster-seen.json"), "utf8"), before, "空目录不落笔");
}

// ── §7 形状漂移：超过上限 → 不写、不宣布、旧 map 保留 ──
{
  const dir = tmp();
  const store = createFileRosterSeenStore({ dir });
  await store.note(["seed"], 1000 * DAY);
  const before = diskOf(dir);
  const huge = Array.from({ length: ROSTER_SEEN_MAX_IDS + 1 }, (_, i) => `m${i}`);
  const drift = await store.note(huge, 1001 * DAY);
  assert.deepEqual(drift.newIds, [], "形状漂移不宣布");
  assert.deepEqual(diskOf(dir), before, "形状漂移不落笔（旧 map 原样保留）");
  // 自愈：目录回到合理规模后照常工作。
  const healed = await store.note(["seed", "fresh"], 1002 * DAY);
  assert.deepEqual(healed.newIds, ["fresh"], "回到合理规模后自愈");
}

// ── §8 未来戳夹到 now ──
{
  const dir = tmp();
  writeFileSync(
    join(dir, "roster-seen.json"),
    JSON.stringify({ version: 1, seen: { a: 5000 * DAY, b: 1000 * DAY } }),
    "utf8"
  );
  const store = createFileRosterSeenStore({ dir });
  await store.note(["a", "b"], 1000 * DAY);
  assert.equal(diskOf(dir).seen.a, 1000 * DAY, "未来戳夹到 now（否则 now-stamp 为负，标记永远亮）");
  assert.equal(diskOf(dir).seen.b, 1000 * DAY);
}

// ── §9 未知版本：读侧宽容成空表，但 note 不写也不宣布；versionNote 说出来 ──
{
  const dir = tmp();
  writeFileSync(join(dir, "roster-seen.json"), JSON.stringify({ version: 99, seen: { a: 1000 * DAY } }), "utf8");
  const store = createFileRosterSeenStore({ dir });
  assert.deepEqual(await store.fresh(1000 * DAY), [], "未知版本读作空表");
  const note = await store.versionNote();
  assert.equal(typeof note, "string", "未知版本必须有一句说明");
  assert.match(/** @type {string} */ (note), /roster-seen\.json/);
  assert.match(/** @type {string} */ (note), /99/);
  const before = readFileSync(join(dir, "roster-seen.json"), "utf8");
  assert.deepEqual((await store.note(["a", "b"], 1000 * DAY)).newIds, [], "未知版本不宣布");
  assert.equal(readFileSync(join(dir, "roster-seen.json"), "utf8"), before, "未知版本不落笔（ADR-006）");
}

// ── §10 损坏文件：读作空表，且**允许覆盖**（这是操作者的恢复手段，不是要拦的事故） ──
//
// 与 ADR-006 的分界：守卫拦的是「盘上是**更新的构建**写的、本构建读不懂」那种覆盖；
// 半截 JSON 没有可保护的版本号（`readStateVersion` 对损坏文件返回 null），拦它只会
// 让一个已经坏掉的文件永远坏下去。所以这里走播种：读作空表、写回一份合法 payload、
// 一个都不宣布。
{
  const dir = tmp();
  writeFileSync(join(dir, "roster-seen.json"), "{not json", "utf8");
  const store = createFileRosterSeenStore({ dir });
  assert.deepEqual(await store.fresh(1000 * DAY), [], "损坏读作空表");
  assert.equal(await store.versionNote(), null, "损坏没有版本号可报（与「版本不符」两件事）");
  const healed = await store.note(["a"], 1000 * DAY);
  assert.deepEqual(healed.newIds, [], "从损坏里恢复 = 播种，不宣布");
  const disk = diskOf(dir);
  assert.equal(disk.version, ROSTER_SEEN_VERSION, "写回一份合法 payload");
  assert.equal(disk.seen.a, 1000 * DAY - ROSTER_SEEN_NEW_WINDOW_MS, "播种戳");
}

// ── §11 多 store 实例共享一个目录：后写的看到先写的（不靠进程内缓存） ──
{
  const dir = tmp();
  const first = createFileRosterSeenStore({ dir });
  await first.note(["a"], 1000 * DAY);
  const second = createFileRosterSeenStore({ dir });
  const grown = await second.note(["a", "b"], 1001 * DAY);
  assert.deepEqual(grown.newIds, ["b"], "第二个实例读到第一个写的历史");
}

// ── §12 doctor 速览：损坏/非对象 → null；未知版本 versionKnown:false ──
{
  assert.equal(describeRosterSeenPayload(null), null);
  assert.equal(describeRosterSeenPayload([]), null);
  assert.equal(describeRosterSeenPayload("x"), null);
  assert.equal(describeRosterSeenPayload({ seen: {} }), null, "没有版本号 → 不认识");

  const now = Date.now();
  const ok = describeRosterSeenPayload({ version: 1, seen: { a: now, b: now - 30 * DAY } });
  assert.equal(ok?.versionKnown, true);
  assert.equal(ok?.ids, 2);
  assert.equal(ok?.fresh, 1, "只数窗口内的");

  const unknown = describeRosterSeenPayload({ version: 99, seen: { a: now } });
  assert.equal(unknown?.versionKnown, false, "未知版本仍给速览（doctor 据此区分损坏与更新构建写的）");
}

// ── §13 落盘路径：显式 dir 优先，否则按 profile 分段 ──
{
  const dir = tmp();
  const store = createFileRosterSeenStore({ dir });
  assert.equal(store.filePath, join(dir, "roster-seen.json"));
}

rmSync(join(tmpdir(), "ms-roster-seen-"), { recursive: true, force: true });
console.log("roster-seen-store.test.mjs: all checks passed");
