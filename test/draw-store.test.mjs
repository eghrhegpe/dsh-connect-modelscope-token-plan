// draw-store 行为测试：并发写回归、ADR-006 写守卫、读侧 versionNote、
// 三态补丁语义、TTL 缓存、doctor 速览函数。
//
// 为什么单独立一个套件：draw-store 曾经**零测试覆盖**（test/ 下没有任何文件
// import 它），于是它同时也是三件套全缺的那个 store——并发保存丢一次、磁盘
// version 比本构建新时降级覆写、读侧静默读作「没设过」，与 provider-store
// 注释里记着「咬过三次」的漂移同款（2026-10-17 实测复现后修复）。本套件把
// provider.test.mjs §8b/§8c 的回归用例在 draw 上各钉一遍。
//
// 断言一律打在**磁盘**上：内存断言会被 cache.remember 喂成假的（provider §8d
// 的教训——写后回读走 TTL 缓存，拿到的是写入前的值）。
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileDrawStore,
  describeDrawPayload,
  normalizeDrawModelId,
  normalizeDrawEnabled,
  isKnownDrawVersion,
  DRAW_STORE_VERSION,
  KNOWN_DRAW_VERSIONS
} from "../src/host/draw-store.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "ms-draw-store-"));
const diskOf = (dir) => JSON.parse(readFileSync(join(dir, "draw.json"), "utf8"));

// ── §1 归一函数：三态语义的入口 ──
{
  assert.equal(normalizeDrawEnabled(true), true);
  assert.equal(normalizeDrawEnabled(false), false);
  assert.equal(normalizeDrawEnabled("yes"), null, "非布尔读作未设置");
  assert.equal(normalizeDrawEnabled(1), null);
  assert.equal(normalizeDrawModelId("  m/Image  "), "m/Image", "trim 后非空");
  assert.equal(normalizeDrawModelId(""), null, "空串 = 自动");
  assert.equal(normalizeDrawModelId("   "), null);
  assert.equal(normalizeDrawModelId(42), null);
  assert.equal(isKnownDrawVersion(1), true);
  assert.equal(isKnownDrawVersion(DRAW_STORE_VERSION), true);
  assert.equal(isKnownDrawVersion(2), false, "只认白名单，不与写版本比较");
  assert.equal(isKnownDrawVersion("1"), false, "字符串版本不是数字");
  assert.equal(isKnownDrawVersion(null), false, "读侧判据不放行 null（写侧才放行）");
  assert.deepEqual(KNOWN_DRAW_VERSIONS, [1]);
}

// ── §2 基本读写：两个字段互不覆盖 + reset + isConfigured ──
{
  const dir = tmp();
  const store = createFileDrawStore({ dir });
  // 纯读不建文件
  assert.equal(await store.enabled(), null, "从未保存 → null（回退 patch 默认）");
  assert.equal(await store.modelId(), null, "从未保存 → null（自动）");
  assert.equal(await store.isConfigured(), false);

  await store.saveEnabled(true);
  assert.equal(await store.enabled(), true);
  assert.equal(diskOf(dir).enabled, true, "开关落盘");
  assert.equal(await store.modelId(), null, "只存开关不动模型偏好");

  await store.saveModelId("m/Image");
  assert.equal(await store.modelId(), "m/Image");
  assert.equal(diskOf(dir).modelId, "m/Image", "模型偏好落盘");
  assert.equal(await store.enabled(), true, "只存模型不动开关——两个字段同生共死在一个 patch 里");
  assert.equal(await store.isConfigured(), true);

  // modelId: null 清掉偏好（回到自动），开关不动
  await store.saveModelId(null);
  assert.equal(await store.modelId(), null);
  assert.equal(diskOf(dir).modelId, undefined, "清除后磁盘上没有该键");
  assert.equal(await store.enabled(), true, "清除偏好不动开关");

  // reset：两个键都不在盘上（「没配过」是键的缺席，不是 false/空串）
  await store.reset();
  assert.equal(await store.enabled(), null);
  assert.equal(await store.modelId(), null);
  assert.equal(await store.isConfigured(), false);
  assert.equal(diskOf(dir).enabled, undefined, "reset 后磁盘上没有 enabled 键");
  assert.equal(diskOf(dir).modelId, undefined, "reset 后磁盘上没有 modelId 键");
  assert.equal(diskOf(dir).version, DRAW_STORE_VERSION, "版本键永远在");

  // 非法输入：TypeError，不当「没给」处理
  for (const bad of ["yes", 1, null, undefined]) {
    await assert.rejects(() => store.saveEnabled(bad), TypeError, `非法开关值 ${String(bad)} 必须拒绝`);
  }
  for (const bad of ["", "   ", 42, true]) {
    await assert.rejects(() => store.saveModelId(bad), TypeError, `非法模型值 ${String(bad)} 必须拒绝`);
  }
  assert.equal(await store.enabled(), null, "拒绝后状态不变");
}

// ── §3 损坏文件 → 读作未设置（不抛） ──
{
  const brokenDir = tmp();
  writeFileSync(join(brokenDir, "draw.json"), "not json{{");
  const broken = createFileDrawStore({ dir: brokenDir });
  assert.equal(await broken.enabled(), null, "损坏文件读作未设置");
  assert.equal(await broken.modelId(), null);
  assert.equal(await broken.isConfigured(), false);
  assert.equal(await broken.versionNote(), null, "损坏文件没有版本号可报（不是版本不符）");
  // 损坏文件可被覆盖（恢复手段）
  await broken.saveEnabled(false);
  assert.equal(diskOf(brokenDir).enabled, false, "损坏文件允许覆盖");
}

// ── §4 并发保存不得互相覆盖（P0 核心回归） ──
//
// 回归用例：draw-store 曾**没有写串行化**（provider/usage 都有），于是并发的
// `saveEnabled(true)` + `saveModelId(...)` 各自读到同一个 current，后写的赢，
// 前一次保存被整个丢掉。实测修复前：并发两个保存，磁盘上只剩其中一个字段
// （用户开了开关又挑了模型，两次点击只活下来一次）。现在读-改-写整体排队，
// 临界区内从磁盘重读基线（不用 TTL 缓存——provider §8d 同款回归）。
{
  const raceDir = tmp();
  const race = createFileDrawStore({ dir: raceDir });
  await race.saveEnabled(false);
  await Promise.all([
    race.saveEnabled(true),
    race.saveModelId("race/Model")
  ]);
  assert.equal(diskOf(raceDir).enabled, true, "并发下开关必须落盘");
  assert.equal(diskOf(raceDir).modelId, "race/Model", "并发下模型偏好必须落盘，不被另一次保存整个丢掉");
  assert.equal(await race.enabled(), true);
  assert.equal(await race.modelId(), "race/Model");

  // 两个独立 store 句柄共享一个目录（两个 Host 进程的形状）：B 的读缓存停在
  // 「文件不存在」，随后 B 的保存必须**从磁盘重读基线**，不许把 A 刚写的开关
  // 顶掉（provider §8d 同款回归：写后回读走 TTL 缓存会拿到写入前的值）。
  //
  // 注意这里断言的是**顺序**写入：跨进程的并发读-改-写需要文件锁，本仓三个
  // store 都不做（provider/usage 同款），原子 rename 只保证不出现半截文件。
  const twoDir = tmp();
  const writerA = createFileDrawStore({ dir: twoDir });
  const writerB = createFileDrawStore({ dir: twoDir });
  await writerB.enabled(); // 先填 B 的读缓存（此刻文件还不存在）
  await writerA.saveEnabled(true); // A 落盘
  await writerB.saveModelId("two/Model"); // B 写模型偏好
  assert.equal(diskOf(twoDir).enabled, true, "B 的保存不许把 A 的开关顶掉（基线从磁盘重读）");
  assert.equal(diskOf(twoDir).modelId, "two/Model", "B 的模型偏好落盘");
}

// ── §5 写后立刻对自己可见（cache.remember，不等 TTL） ──
{
  const dir = tmp();
  const store = createFileDrawStore({ dir });
  await store.saveModelId("visible/Model");
  assert.equal(await store.modelId(), "visible/Model", "写完立即可读（remember，不走回读）");
  // 另一个进程改了盘，一个 TTL 内可见（STATE_READ_TTL_MS = 1s）
  writeFileSync(join(dir, "draw.json"), JSON.stringify({ version: 1, enabled: true, modelId: "other/Model" }));
  assert.equal(await store.modelId(), "visible/Model", "TTL 内先信自己的缓存");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(await store.modelId(), "other/Model", "TTL 过期后另一个进程的写入可见");
}

// ── §6 ADR-006 写守卫：新版本文件拒绝覆盖 ──
{
  const futureDir = tmp();
  writeFileSync(join(futureDir, "draw.json"), JSON.stringify({ version: 99, enabled: true, modelId: "future/Model" }));
  const future = createFileDrawStore({ dir: futureDir });
  await assert.rejects(() => future.saveEnabled(false), /refusing to overwrite/, "未知版本 → 拒绝覆盖");
  await assert.rejects(() => future.saveModelId("x/Model"), /refusing to overwrite/, "模型保存同样拒写");
  await assert.rejects(() => future.reset(), /refusing to overwrite/, "reset 同样拒写");
  // 本 build 读不了 version 99（守卫的目的），核对磁盘原文件没被改
  assert.equal(diskOf(futureDir).version, 99, "原文件未被破坏（仍是版本 99）");
  assert.equal(diskOf(futureDir).enabled, true, "原文件的开关值未被降级覆写");
  // 读侧宽容：读作未设置，但不静默（versionNote 说出口）
  assert.equal(await future.enabled(), null, "未知版本宽容读作未设置");
  assert.equal(await future.modelId(), null, "未知版本宽容读作自动");
  assert.equal(await future.isConfigured(), false, "未知版本不算「保存过」");
}

// ── §7 读侧 versionNote：守卫挡覆盖，说明补静默 ──
{
  const note = await (async () => {
    const dir = tmp();
    writeFileSync(join(dir, "draw.json"), JSON.stringify({ version: 99, enabled: true }));
    return createFileDrawStore({ dir }).versionNote();
  })();
  assert.match(note ?? "", /version 99/, "未知版本必须有可读说明");
  assert.match(note ?? "", /this build knows/, "说明里要带本构建认识哪些版本");
  assert.match(note ?? "", /draw\.json/, "说明里点出文件名");

  // 本构建版本 / 文件缺失 / 损坏 → 无说明（都不是版本不符）
  const dir = tmp();
  const store = createFileDrawStore({ dir });
  await store.saveEnabled(true);
  assert.equal(await store.versionNote(), null, "本构建版本 → 无说明");
  const absent = createFileDrawStore({ dir: tmp() });
  assert.equal(await absent.versionNote(), null, "文件缺失 → 无说明（「从未保存」不是故障）");
  const brokenDir = tmp();
  writeFileSync(join(brokenDir, "draw.json"), "{not json");
  const broken = createFileDrawStore({ dir: brokenDir });
  assert.equal(await broken.versionNote(), null, "损坏文件 → 无说明（不是版本不符）");
}

// ── §8 写失败传播：只读 Home 不许静默吞掉 ──
//
// 与 provider 同一方言：save* 抛（路由 catch 后 respondError 呈报）。旧实现把
// 一切失败咽回一个 `string|null` 返回值，与 provider 的 throw 方言同盘两套，
// 后来者容易判错；且「拒绝原因」与「IO 失败」被混成同一种形状。
{
  // 用一不存在且不可建的路径当只读 Home 的形状：目录是一个**文件**，mkdir 必失败。
  const blocker = tmp();
  writeFileSync(join(blocker, "draw.json"), "x"); // 占住名字
  const dir = join(blocker, "draw.json", "nested"); // 下面是文件，建不出目录
  const store = createFileDrawStore({ dir });
  await assert.rejects(() => store.saveEnabled(true), /draw store write failed|ENOTDIR|EACCES|EPERM|EEXIST/i,
    "只读/不可建目录的写失败必须抛，不静默");
}

// ── §9 degrade 留痕：拒绝写有 warn 日志 ──
{
  const dir = tmp();
  writeFileSync(join(dir, "draw.json"), JSON.stringify({ version: 99 }));
  const warnings = [];
  const store = createFileDrawStore({ dir, logger: { warn: (m) => warnings.push(m) } });
  await assert.rejects(() => store.saveEnabled(true));
  assert.ok(
    warnings.some((w) => w.includes("refusing to overwrite")),
    `拒写必须落 warn 日志（swallow the failure, not the reason），实际：${JSON.stringify(warnings)}`
  );
}

// ── §10 describeDrawPayload（doctor 速览函数） ──
{
  assert.equal(describeDrawPayload(null), null);
  assert.equal(describeDrawPayload("nope"), null);
  assert.equal(describeDrawPayload({ enabled: true }), null, "无 version 键 → 不认识");
  assert.equal(describeDrawPayload({ version: "1" }), null, "字符串版本 → 不认识");
  assert.deepEqual(
    describeDrawPayload({ version: 1, enabled: false, modelId: "m/Image" }),
    { versionKnown: true, enabled: false, modelId: "m/Image" }
  );
  assert.equal(describeDrawPayload({ version: 1, enabled: "yes" }).enabled, null, "非布尔归一化为未设置");
  assert.equal(describeDrawPayload({ version: 1, modelId: "" }).modelId, null, "空串归一化为 auto");
  assert.equal(describeDrawPayload({ version: 2 }).versionKnown, false, "能解析但版本未知");
}

console.log("draw-store.test.mjs: all checks passed");
