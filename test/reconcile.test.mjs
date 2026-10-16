// provider-reconcile.ts 的 desired-state 收敛测试：双驱动收编后的唯一控制面。
//
// ## 为什么这个文件存在
//
// 收敛环是 M4 控制面的新脊柱：轮询定时器与四条 provider 路由都只是「标记
// dirty」，读 desired → 拉目录 → 复查 desired → publish 只有这一处。它收编
// 的两个旧病必须各有一条回归：
//   1. **fetch 失败不再发布空目录**（旧 readEntries 把失败降级成 [] 再
//      publish——一次瞬时抖动把已服务的模型全部撤下）；
//   2. **fetch 期间 desired 被改 → 重跑**（旧 runPoll「跳过本轮、等一个
//      pollSeconds」，丢一次更新）。
// 外加收敛的链性质：并发触发合并成最多两遍，调用方 await 返回时新值已落地。

import { strict as assert } from "node:assert";
import { createProviderReconciler } from "../src/host/provider-reconcile.ts";

/** 可中途改值的 desired store 桩（模拟保存路由在 fetch 期间落盘）。 */
function makeStore(initial = {}) {
  let current = { enabled: null, enabledIds: null, contextWindow: null, ...initial };
  return {
    get value() { return { ...current }; },
    set(next) { current = { ...current, ...next }; },
    enabled: async () => current.enabled,
    enabledIds: async () => current.enabledIds,
    contextWindow: async () => current.contextWindow
  };
}

function makeDeps({ store, fetch, logger } = {}) {
  const published = [];
  const deps = {
    settings: { registerProvider: true },
    providerStore: store ?? makeStore(),
    inference: {
      fetchModels: fetch ?? (async (contextWindow) => ({ entries: [{ id: "a/A" }] }))
    },
    publisher: {
      state: { enabledIds: [] },
      publish: async (entries, enabledIds, unavailable) => {
        published.push({ entries, enabledIds, unavailable });
        return { ok: true };
      }
    },
    logger: logger ?? { warn: () => {} }
  };
  return { deps, published };
}

// §1 一遍收敛：读 desired → 带窗口覆盖拉目录 → 按落盘清单 publish。
{
  const store = makeStore({ enabled: true, enabledIds: ["a/A"], contextWindow: 4096 });
  const fetches = [];
  const { deps, published } = makeDeps({
    store,
    fetch: async (contextWindow) => { fetches.push(contextWindow); return { entries: [{ id: "a/A" }, { id: "b/B" }] }; }
  });
  const { reconcile } = createProviderReconciler(deps);
  await reconcile();
  assert.deepEqual(fetches, [4096], "窗口覆盖必须喂给 fetchModels（否则打标条目与注册口径分叉）");
  assert.equal(published.length, 1, "一遍收敛一次 publish");
  assert.deepEqual(published[0].enabledIds, ["a/A"], "清单走 resolveEnabledIds：落盘值优先");
  assert.equal(published[0].entries.length, 2, "目录条目原样交给 publisher");
  assert.deepEqual(published[0].unavailable, [], "M4 无额度聚合，unavailable 恒空");
}

// §2 fetch 失败：**不得**发布空目录，保留当前 offer，只记原因。
{
  const warnings = [];
  const { deps, published } = makeDeps({
    fetch: async () => { throw new Error("upstream 503"); },
    logger: { warn: (m) => warnings.push(m) }
  });
  const { reconcile } = createProviderReconciler(deps);
  await reconcile(); // 不 reject
  assert.equal(published.length, 0, "fetch 失败时一次 publish 都不能有（空目录会把已服务模型全部撤下）");
  assert.equal(warnings.length, 1, "失败原因必须留档");
  assert.match(warnings[0], /catalog fetch failed/, "日志说清是目录没拉到，不是注册失败");
}

// §3 fetch 期间 desired 被改（保存路由落盘）→ 原地重跑，不等下一个 pollSeconds。
{
  const store = makeStore({ enabled: true, contextWindow: 4096 });
  let firstFetch = true;
  const fetches = [];
  const { deps, published } = makeDeps({
    store,
    fetch: async (contextWindow) => {
      fetches.push(contextWindow);
      if (firstFetch) {
        firstFetch = false;
        // 第一次 fetch 在途时，用户保存了新覆盖（保存路由会落盘 + 触发收敛）。
        store.set({ contextWindow: 8192 });
      }
      return { entries: [{ id: "a/A" }] };
    }
  });
  const { reconcile } = createProviderReconciler(deps);
  await reconcile();
  assert.equal(fetches.length, 2, "desired 在 fetch 期间变了 → 第二遍收敛（旧 runPoll 只会跳过本轮）");
  assert.deepEqual(fetches, [4096, 8192], "第二遍必须带新覆盖拉取（第一遍的旧标条目不发布）");
  assert.equal(published.length, 1, "已知陈旧的 offer 不 publish——只发布收敛后的新值");
}

// §4 并发触发合并：触发落在一遍收敛**在途期间**时，恰好再多一遍（不是 N 遍），
// 且每个调用方都等到「自己的触发已被消费」。
//
// 对照面：触发若落在一遍开始读 desired **之前**，会被那一遍直接吸收（它的
// readDesired 本来就排在触发之后）——所以本桩先放行第一遍进 fetch，再连发两个
// 触发，钉的正是「在途期间到达的触发只值一遍重跑」。
{
  const store = makeStore({ enabled: true });
  let fetchCount = 0;
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const { deps, published } = makeDeps({
    store,
    fetch: async () => {
      fetchCount += 1;
      await gate; // 卡在门上：放行前，后两个触发全部在途
      return { entries: [{ id: "a/A" }] };
    }
  });
  const { reconcile } = createProviderReconciler(deps);
  const p1 = reconcile();
  await new Promise((resolve) => setImmediate(resolve)); // 第一遍进 fetch（已读过 desired）
  assert.equal(fetchCount, 1, "在途时只有一个环在跑");
  const p2 = reconcile();
  const p3 = reconcile();
  openGate();
  await Promise.all([p1, p2, p3]);
  assert.equal(fetchCount, 2, `在途期间的两个触发应合并成恰好一遍重跑，实际 ${fetchCount}`);
  assert.equal(published.length, 2, "publish 次数与 fetch 一致（没有空转重建之外的额外 churn）");
}

// §5 publish 抛错：收敛自己吞掉并记档（poll/路由都 void 调用，不能把未拒绝的
//  promise 变成 unhandled rejection）。
{
  const warnings = [];
  const { deps } = makeDeps({
    logger: { warn: (m) => warnings.push(m) }
  });
  deps.publisher.publish = async () => { throw new Error("registerAdapter blew up"); };
  const { reconcile } = createProviderReconciler(deps);
  await reconcile();
  assert.equal(warnings.length, 1, "publish 失败记档且不 reject");
  assert.match(warnings[0], /publish failed/);
}

// §6 store 读失败：按「未设置」降级，收敛照常完成（不炸链）。
{
  const { deps, published } = makeDeps({
    store: {
      enabled: async () => { throw new Error("disk gone"); },
      enabledIds: async () => { throw new Error("disk gone"); },
      contextWindow: async () => { throw new Error("disk gone"); }
    }
  });
  const { reconcile } = createProviderReconciler(deps);
  await reconcile();
  assert.equal(published.length, 1, "读不到 desired 也要发布一遍（空清单 = 不过滤，publisher 自己裁决开关）");
}

// §7 链的串行性：前一遍没收尾，后一遍不插队（fetch 顺序即 publish 顺序）。
{
  const order = [];
  const gates = [];
  const { deps, published } = makeDeps({
    fetch: async (contextWindow) => {
      order.push(`fetch:${contextWindow}`);
      await new Promise((resolve) => gates.push(resolve));
      return { entries: [{ id: "a/A" }] };
    }
  });
  const { reconcile } = createProviderReconciler(deps);
  const p1 = reconcile();
  await new Promise((resolve) => setImmediate(resolve)); // 第一遍进 fetch
  gates[0]();                 // 放行第一遍
  await p1;
  const p2 = reconcile();
  await new Promise((resolve) => setImmediate(resolve)); // 第二遍进 fetch
  gates[1]();                 // 放行第二遍
  await p2;
  assert.deepEqual(order, ["fetch:null", "fetch:null"], "两遍收敛严格串行");
  assert.equal(published.length, 2);
}

console.log("reconcile.test.mjs: all checks passed");
