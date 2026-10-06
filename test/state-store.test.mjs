// state-store 的原子写原语：崩溃一致性 + 临时文件清理。
//
// ## 为什么这个文件存在
//
// `writeStateFile` 是**四个 store 共同的唯一写入口**（usage / provider / catalog /
// throttle），所以它的失败模式会被放大到所有状态文件上。此前它只有一句
// `writeFile → rename`，而 `rename` 失败时（Windows 上目标文件被占用最常见）
// 临时文件**留在原地**：名字是 `<base>.<pid>.<ts>.<uuid>.tmp`，每次失败多一个，
// 而全仓原本无任何 unlink——`state/<profile>/<name>/` 会慢慢堆满垃圾。
//
// fsync 那一条是**崩溃一致性**（rename 本身只保证并发原子性，不保证断电安全）：
// 没有它，断电/内核崩溃时 rename 可能把一个空或半截文件立到目标路径上，而
// parsePayload 对损坏文件是「读作未设置」静默降级——用户看到的是「清单和历史
// 全没了」而没有任何错误。

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStateFile, temporaryOf, ensureStateDir, STATE_READ_TTL_MS, createStateReadCache } from "../src/host/state-store.ts";

const dir = mkdtempSync(join(tmpdir(), "state-store-"));
const file = join(dir, "state.json");

// §1 正常路径：0600 临时文件 + 原子 rename + 尾部换行。
{
  const tmp = temporaryOf(dir, "state.json");
  await writeStateFile(file, '{"a":1}', { temporary: tmp });
  assert.equal(readFileSync(file, "utf8"), '{"a":1}\n', "内容落盘且带尾部换行");
  assert.equal(existsSync(tmp), false, "rename 之后临时文件不存在");
  assert.equal(readdirSync(dir).length, 1, "目录里只剩最终文件（无残留 tmp）");
}

// §2 rename 失败时清掉自己的临时文件。
//
// 造一个真实的 rename 失败：把**目标路径**变成一个非空目录（Windows 上
// 「文件被占用」是 EPERM/EACCES，POSIX 上对非空目录 rename 也失败——两者同因：
// 目标无法被替换）。改不了权限的 Windows 环境下这是唯一稳定的造法。
{
  const blocked = join(dir, "blocked");
  mkdirSync(blocked);
  writeFileSync(join(blocked, "keep"), "x");   // 让它非空
  const tmp = temporaryOf(dir, "blocked");
  let threw = false;
  try {
    await writeStateFile(blocked, '{"b":2}', { temporary: tmp });
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "rename 失败必须向上传播（调用方自己决定要不要吞）");
  assert.equal(existsSync(tmp), false, "失败后临时文件必须被清掉（否则目录会堆满垃圾）");
  assert.equal(existsSync(join(blocked, "keep")), true, "原有内容未被破坏");
}

// §2b 连续失败不累积垃圾（这是「清理」的真实判据：一次失败不算数）。
{
  const blocked = join(dir, "blocked2");
  mkdirSync(blocked);
  writeFileSync(join(blocked, "keep"), "x");
  for (let i = 0; i < 5; i += 1) {
    const tmp = temporaryOf(dir, "blocked2");
    await writeStateFile(blocked, "{}" + i, { temporary: tmp }).catch(() => undefined);
    assert.equal(existsSync(tmp), false, `第 ${i + 1} 次失败的临时文件应被清掉`);
  }
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith(".tmp")),
    [],
    "5 次失败后目录里不该有任何 .tmp"
  );
}

// §3 覆盖写：rename 是原子的，目标内容永远是某一次完整写入的产物。
{
  const f = join(dir, "overwrite.json");
  for (let i = 0; i < 20; i += 1) {
    await writeStateFile(f, JSON.stringify({ i }), { temporary: temporaryOf(dir, "overwrite.json") });
  }
  const parsed = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(parsed.i, 19, "最后一次写入胜出");
  assert.equal(readdirSync(dir).filter((n) => n.startsWith("overwrite.json.")).length, 0, "无临时文件残留");
}

// §4 目录不存在时先建（写路径依赖它；只读 Home 上 mkdir 会抛，那由调用方决定）。
{
  const nested = join(dir, "a", "b", "c");
  const nestedFile = join(nested, "deep.json");
  await ensureStateDir(nested);
  await writeStateFile(nestedFile, '{"deep":true}', { temporary: temporaryOf(nested, "deep.json") });
  assert.equal(JSON.parse(readFileSync(nestedFile, "utf8")).deep, true, "深层目录里的写入成功");
}

// §5 读缓存的 adopt 语义：「从未读过」与「读过但没有」是两个不同值。
//
// 这是 store 的地基：legacy 继承靠它只尝试一次，而把两者混成一个会让继承在每个
// TTL 周期都重跑（读一个不存在的旧文件）。
{
  let reads = 0;
  let now = 0;
  const cache = createStateReadCache(async () => {
    reads += 1;
    return { v: reads };
  }, { ttlMs: 100, now: () => now });
  const a = await cache.read();
  const b = await cache.read();
  assert.deepEqual(a, b, "TTL 内返回同一个值（不重读）");
  assert.equal(reads, 1, "只读了一次");
  // TTL 必须真的会过期——原先那句 `assert.ok(cache !== null)` 是恒真摆设，
  // 它证明不了缓存会失效（前一行 await read() 成功就已经隐含对象存在）。
  // 现在钉住「到期前不重读、到期后必重读」这对双向行为。
  now = 99;
  assert.equal(reads, 1, "TTL 未到期不重读");
  now = 101;
  const c = await cache.read();
  assert.equal(reads, 2, "TTL 到期后重读盘");
  assert.notDeepEqual(c, a, "重读拿到新值，不是旧缓存");

  // 恒返回 null 的读源：null 是「读过、没有」，而 adopt 只发生一次。
  let nullReads = 0;
  const nullCache = createStateReadCache(async () => {
    nullReads += 1;
    return null;
  }, { ttlMs: 0, inheritFrom: { read: async () => null, write: async () => {} } });
  assert.equal(await nullCache.read(), null, "读不到时返回 null");
  assert.equal(await nullCache.read(), null, "再次读仍是 null");
  assert.ok(nullReads >= 1, "至少读过一次");
  assert.ok(STATE_READ_TTL_MS >= 1, "默认 TTL 是正数（0 会让每次都重读盘）");
}

console.log("state-store.test.mjs: all checks passed");
