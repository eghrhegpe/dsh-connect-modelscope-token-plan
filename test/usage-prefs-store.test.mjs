// usage-prefs-store 行为测试：归一、裁决+夹取、读写/清除、损坏即忽略、
// ADR-006 写守卫、读侧 versionNote、doctor 速览函数。
//
// 为什么单独立一个套件：这是第四个状态文件（provider / usage / draw 之后），
// 前三个各自都咬过一次「三件套缺一件」的漂移（并发丢保存 / 版本降级覆写 / 读侧
// 静默读作未设置）。本套件把那三条在 usage-prefs.json 上各钉一遍——它是**同一套
// 原语（state-store）的调用方**，不是新发明。
//
// 断言一律打在**磁盘**上：内存断言会被 cache.remember 喂成假的（provider §8d 的
// 教训——写后回读走 TTL 缓存，拿到的是写入前的值）。
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { name } from "../src/host/host-config.ts";
import {
  createFileUsagePrefsStore,
  describeUsagePrefsPayload,
  normalizeWindowDays,
  resolveWindowDays,
  isKnownUsagePrefsVersion,
  USAGE_PREFS_VERSION,
  KNOWN_USAGE_PREFS_VERSIONS
} from "../src/host/usage-prefs-store.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "ms-usage-prefs-"));
const diskOf = (dir) => JSON.parse(readFileSync(join(dir, "usage-prefs.json"), "utf8"));

// ── §1 归一函数与版本白名单 ──
{
  assert.equal(normalizeWindowDays(30), 30);
  assert.equal(normalizeWindowDays(30.9), 30, "向下取整");
  assert.equal(normalizeWindowDays(0), null, "0 不是有效窗口");
  assert.equal(normalizeWindowDays(-7), null);
  assert.equal(normalizeWindowDays(Number.NaN), null);
  assert.equal(normalizeWindowDays(Number.POSITIVE_INFINITY), null);
  assert.equal(normalizeWindowDays("30"), null, "字符串不是数字");
  assert.equal(normalizeWindowDays(null), null, "null = 未设置");
  assert.equal(normalizeWindowDays(undefined), null);
  assert.equal(isKnownUsagePrefsVersion(1), true);
  assert.equal(isKnownUsagePrefsVersion(USAGE_PREFS_VERSION), true);
  assert.equal(isKnownUsagePrefsVersion(2), false, "只认白名单，不与写版本比较");
  assert.equal(isKnownUsagePrefsVersion("1"), false, "字符串版本不是数字");
  assert.equal(isKnownUsagePrefsVersion(null), false, "读侧判据不放行 null（写侧才放行）");
  assert.deepEqual(KNOWN_USAGE_PREFS_VERSIONS, [1]);
}

// ── §2 裁决 + 夹取：面板值优先，随后落进 [1, maxDays] ──
{
  assert.equal(resolveWindowDays(null, 14, 90), 14, "未保存 → 配置默认");
  assert.equal(resolveWindowDays(30, 14, 90), 30, "面板值优先");
  assert.equal(resolveWindowDays(200, 14, 90), 90, "超过上界 → 夹到保留窗口");
  assert.equal(resolveWindowDays(0, 14, 90), 1, "下界 1");
  assert.equal(resolveWindowDays(null, 90, 30), 30, "配置默认也可能越界（保留被调小）→ 同样夹");
  assert.equal(resolveWindowDays(7.9, 14, 90), 7, "落盘值向下取整");
}

// ── §3 基本读写：从未保存 → null（跟随配置）；保存 → 落盘；null → 清除 ──
{
  const dir = tmp();
  const store = createFileUsagePrefsStore({ dir });
  assert.equal(await store.windowDays(), null, "从未保存 → null（跟随 trendDays 配置默认）");

  await store.saveWindowDays(30);
  assert.equal(await store.windowDays(), 30);
  assert.equal(diskOf(dir).windowDays, 30, "窗口落盘");

  await store.saveWindowDays(null);
  assert.equal(await store.windowDays(), null, "null = 清除覆盖");
  assert.equal(diskOf(dir).windowDays, undefined, "清除后磁盘上没有该键（「没设过」是键的缺席）");
  assert.equal(diskOf(dir).version, USAGE_PREFS_VERSION, "版本键永远在");

  // 非法输入：TypeError，不当「清除」处理（那会把一次误发读成用户要的重置）
  for (const bad of ["30", 0, -1, Number.NaN, true]) {
    await assert.rejects(() => store.saveWindowDays(bad), TypeError, `非法窗口 ${String(bad)} 必须拒绝`);
  }
  assert.equal(await store.windowDays(), null, "拒绝后状态不变");
  // 小数被归一成整数（路由也会夹，但 store 自己不该写一个 30.9 进盘）
  await store.saveWindowDays(30.9);
  assert.equal(diskOf(dir).windowDays, 30, "落盘的是整数");
}

// ── §4 损坏文件 → 读作未设置（不抛），且可被覆盖（恢复手段） ──
{
  const brokenDir = tmp();
  writeFileSync(join(brokenDir, "usage-prefs.json"), "not json{{");
  const broken = createFileUsagePrefsStore({ dir: brokenDir });
  assert.equal(await broken.windowDays(), null, "损坏文件读作未设置");
  assert.equal(await broken.versionNote(), null, "损坏文件没有版本号可报（不是版本不符）");
  await broken.saveWindowDays(7);
  assert.equal(diskOf(brokenDir).windowDays, 7, "损坏文件允许覆盖");
}

// ── §5 两个 store 句柄共享一个目录：写基线必须从磁盘重读 ──
//
// 回归形状（provider §8d / draw §4 同款）：B 的读缓存停在「文件不存在」，随后
// B 的写入若不从磁盘重读基线，就会把 A 刚写的窗口顶回未设置。
{
  const twoDir = tmp();
  const writerA = createFileUsagePrefsStore({ dir: twoDir });
  const writerB = createFileUsagePrefsStore({ dir: twoDir });
  await writerB.windowDays(); // 先填 B 的读缓存（此刻文件还不存在）
  await writerA.saveWindowDays(30); // A 落盘
  await writerB.saveWindowDays(7); // B 覆盖
  assert.equal(diskOf(twoDir).windowDays, 7, "B 的写入落在磁盘上");
  assert.equal(diskOf(twoDir).version, USAGE_PREFS_VERSION);
}

// ── §6 写后立刻对自己可见（cache.remember，不等 TTL） ──
{
  const dir = tmp();
  const store = createFileUsagePrefsStore({ dir });
  await store.saveWindowDays(30);
  assert.equal(await store.windowDays(), 30, "写完立即可读（remember，不走回读）");
  writeFileSync(join(dir, "usage-prefs.json"), JSON.stringify({ version: 1, windowDays: 7 }));
  assert.equal(await store.windowDays(), 30, "TTL 内先信自己的缓存");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(await store.windowDays(), 7, "TTL 过期后另一个进程的写入可见");
}

// ── §7 ADR-006 写守卫：读不懂的版本拒绝覆盖 ──
{
  const futureDir = tmp();
  writeFileSync(join(futureDir, "usage-prefs.json"), JSON.stringify({ version: 99, windowDays: 30 }));
  const future = createFileUsagePrefsStore({ dir: futureDir });
  await assert.rejects(() => future.saveWindowDays(7), /refusing to overwrite/, "未知版本 → 拒绝覆盖");
  assert.equal(diskOf(futureDir).version, 99, "原文件未被破坏（仍是版本 99）");
  assert.equal(await future.windowDays(), null, "读侧宽容：未知版本读作「没设过」");
  assert.equal(typeof await future.versionNote(), "string", "读侧宽容必须说出口（versionNote）");
}

// ── §8 doctor 只读速览：不认识 → null；认识但版本未知 → versionKnown:false ──
{
  assert.equal(describeUsagePrefsPayload(null), null);
  assert.equal(describeUsagePrefsPayload("x"), null);
  assert.equal(describeUsagePrefsPayload({ windowDays: 30 }), null, "缺 version → 整个载荷不认");
  assert.deepEqual(describeUsagePrefsPayload({ version: 1, windowDays: 30 }), { versionKnown: true, windowDays: 30 });
  assert.deepEqual(describeUsagePrefsPayload({ version: 1 }), { versionKnown: true, windowDays: null });
  assert.deepEqual(describeUsagePrefsPayload({ version: 99, windowDays: 30 }), { versionKnown: false, windowDays: 30 });
}

// —— §9 legacy 继承（pre-profile 共享目录）：一次性、过写队列、显式清除不复活 ——
//
// 与 provider §8e 同款：继承只在 profile 自己的文件**根本不在场**时发生，显式
// `dir` 从不继承（它从来不是共享布局的一部分）——所以必须用真
// profile + $DSH_HOME，不能用 dir。usage-prefs 是单值偏好，回填无害
// （裱定见文件头注）；对照 usage.json 的历史计数**不搬**。
{
  const home = mkdtempSync(join(tmpdir(), "ms-usage-prefs-adopt-"));
  const shared = join(home, "state", name);
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, "usage-prefs.json"), JSON.stringify({ version: 1, windowDays: 90 }));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const adopted = createFileUsagePrefsStore({ profile: "p-adopt" });
    assert.equal(await adopted.windowDays(), 90, "自己的文件不在场 → 从共享布局继承");
    assert.equal(
      JSON.parse(readFileSync(join(home, "state", "p-adopt", name, "usage-prefs.json"), "utf8")).windowDays,
      90,
      "继承值回写到 profile 自己的目录（下次读不再穿旧路径）"
    );
    // 显式清除之后，旧布局的遗留值**不该**在下一次读时复活：一次明确的
    // 重置不能被共享目录里的旧值撤销。冷读（新 store = 空缓存）是必须的。
    await adopted.saveWindowDays(null);
    const cold = createFileUsagePrefsStore({ profile: "p-adopt" });
    assert.equal(await cold.windowDays(), null, "显式清除后不被旧布局复活");
    // foreign 版本躺在自己的目录上时不继承（写了也被 ADR-006 拒，省掉注定失败的尝试）。
    const futureDir = join(home, "state", "p-future", name);
    mkdirSync(futureDir, { recursive: true });
    writeFileSync(join(futureDir, "usage-prefs.json"), JSON.stringify({ version: 99, windowDays: 30 }));
    const foreign = createFileUsagePrefsStore({ profile: "p-future" });
    assert.equal(await foreign.windowDays(), null, "foreign 宽容读作未设置");
    assert.equal(
      JSON.parse(readFileSync(join(futureDir, "usage-prefs.json"), "utf8")).version,
      99,
      "foreign 文件未被继承写覆盖"
    );
    // 共享目录里没有可继承的值时，不写自己的文件（干净机器不该被继承写造出文件）。
    const emptyHome = mkdtempSync(join(tmpdir(), "ms-usage-prefs-nolegacy-"));
    mkdirSync(join(emptyHome, "state", name), { recursive: true });
    process.env.DSH_HOME = emptyHome;
    const noLegacy = createFileUsagePrefsStore({ profile: "p-empty" });
    assert.equal(await noLegacy.windowDays(), null, "共享目录无值 → 仍是未设置");
    assert.equal(
      existsSync(join(emptyHome, "state", "p-empty", name, "usage-prefs.json")),
      false,
      "无可继承值时不回写造文件"
    );
    rmSync(emptyHome, { recursive: true, force: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
}

console.log("usage-prefs-store.test.mjs: all checks passed");
