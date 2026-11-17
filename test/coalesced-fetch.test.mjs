// coalesced-fetch 的 stale-while-revalidate（SWR）契约。
//
// 为什么需要 SWR：快照是**单响应**，目录（要公网、60s TTL 一到就同步重取）一慢，
// 整块面板连本地计数一起停在「加载中」——实测一次冷目录取数 8.6s。这里钉住的
// 是「过期但仍在陈旧预算内」的三个性质：立刻给旧值、后台刷新发起、刷新后的新值
// 接管；以及两条边界：超预算要老实等生产者、没有缓存时不许凭空造值。
import { strict as assert } from "node:assert";
import { createCoalescedFetch } from "../src/host/coalesced-fetch.ts";

let t = 0;
const { readDetailed } = createCoalescedFetch({ now: () => t });

// ── TTL 内：命中缓存，不重取 ──
{
  t = 0;
  let calls = 0;
  const produce = async () => {
    calls += 1;
    return { gen: calls };
  };
  const first = await readDetailed("fresh", produce, 1_000, 10_000);
  assert.deepEqual(first, { value: { gen: 1 }, ageMs: 0, stale: false }, "首次读 = 现取，年龄 0");
  t = 500;
  const second = await readDetailed("fresh", produce, 1_000, 10_000);
  assert.equal(second.stale, false, "TTL 内不是 stale");
  assert.equal(second.ageMs, 500, "年龄如实报告");
  assert.deepEqual(second.value, { gen: 1 }, "TTL 内给同一份值");
  assert.equal(calls, 1, "TTL 内不得重取");
}

// ── 过期但预算内：立刻给旧值 + 后台刷新 ──
{
  t = 0;
  let calls = 0;
  const produce = async () => {
    calls += 1;
    return { gen: calls };
  };
  let produced = 0;
  const produceOnce = async () => { produced += 1; calls += 1; return { gen: produced }; };
  await readDetailed("swr", produceOnce, 1_000, 10_000);
  calls = 0;
  t = 1_500;
  const staleRead = await readDetailed("swr", produceOnce, 1_000, 10_000);
  assert.equal(staleRead.stale, true, "过期但在预算内 → stale:true");
  assert.deepEqual(staleRead.value, { gen: 1 }, "先给旧值，不等生产者");
  assert.equal(staleRead.ageMs, 1_500, "旧值的年龄如实报告");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1, "后台刷新已发起（不是不刷）");
  t = 1_600;
  const afterRefresh = await readDetailed("swr", produceOnce, 1_000, 10_000);
  assert.equal(afterRefresh.stale, false, "刷新落盘后回到新鲜");
  assert.deepEqual(afterRefresh.value, { gen: 2 }, "新值接管");
}

// ── 后台刷新挂死：旧值照给，绝不阻塞（这正是它存在的理由）──
{
  t = 0;
  let calls = 0;
  await readDetailed("hang", async () => {
    calls += 1;
    return { gen: calls };
  }, 1_000, 10_000);
  calls = 0;
  t = 2_000;
  const hanging = readDetailed("hang", () => new Promise(() => {}), 1_000, 10_000);
  const raced = await Promise.race([
    hanging,
    new Promise((resolve) => setTimeout(() => resolve("BLOCKED"), 200))
  ]);
  assert.notEqual(raced, "BLOCKED", "生产者挂死时 SWR 必须立刻返回旧值，不许跟着挂");
  assert.equal(raced.stale, true);
  assert.deepEqual(raced.value, { gen: 1 });
}

// ── 超出陈旧预算：不许再拿旧值，等生产者 ──
{
  t = 0;
  let calls = 0;
  const produce = async () => {
    calls += 1;
    return { gen: calls };
  };
  let produced = 0;
  const produceOnce = async () => { produced += 1; calls += 1; return { gen: produced }; };
  await readDetailed("expired", produceOnce, 1_000, 5_000);
  calls = 0;
  t = 6_000;
  const beyond = await readDetailed("expired", produceOnce, 1_000, 5_000);
  assert.equal(beyond.stale, false, "超出预算不再声明「旧值可用」");
  assert.deepEqual(beyond.value, { gen: 2 }, "老实等新值");
  assert.equal(calls, 1);
}

// ── 无缓存 + staleMs=0（不用 SWR 的调用方）：行为与 read 一致 ──
{
  t = 0;
  let calls = 0;
  const produce = async () => {
    calls += 1;
    return { gen: calls };
  };
  const first = await readDetailed("nohdr", produce, 1_000, 0);
  assert.equal(first.stale, false);
  t = 2_000;
  const second = await readDetailed("nohdr", produce, 1_000, 0);
  assert.equal(second.stale, false, "staleMs=0 → 永不声明 stale");
  assert.equal(calls, 2, "过期即重取");
}

console.log("coalesced-fetch.test.mjs: all checks passed");
