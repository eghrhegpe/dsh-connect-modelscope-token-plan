// provider-publish 状态机测试：dispose 闸门、publish 队列、回滚、签名。
//
// ## 为什么这个文件存在
//
// `provider-publish.ts` 曾**完全没有测试覆盖**（ROADMAP 声称 test/provider.test.mjs
// 测「publish 三条语义」，实际上没有）。零覆盖的直接后果是藏着一个 P0：
//
//   `publishProviderOnce` 只在**入口**检查一次 `queue.isDisposed()`，而注册发生在
//   最后一个 await 之后。teardown 落在这段窗口里时，闸门不重跑，
//   `registerAdapter` 把适配器注册进一个**已撤下本插件的 Host**，而 teardown 早就
//   跑完、release 永不调用。泄漏的对持有 tokenStore 与整个 Cordis ctx 的闭包 →
//   僵尸 provider：picker 里还在、还能路由，而面板路由已注销，用户没有界面能关掉它。
//
// 模拟 peer 的关键行为：`registerAdapter` 把适配器放进一个**宿主注册表**，只有
// 它的 release handle 能摘掉——这正是「注册了但没人能摘」的危害来源。

import { strict as assert } from "node:assert";
import { createProviderPublisher, catalogSignature, quotaSignatureOf, syncSignaturesAfterPublish } from "../src/host/provider-publish.ts";

const ENTRIES = [{ id: "deepseek-ai/DeepSeek-V4.1-Flash", name: "DS" }];

/**
 * 造一个假的 Host llm 服务：注册进`adapters` 表，release handle 负责摘除。
 * 记录每个注册对，供断言「有没有人把它摘掉」。
 */
function makeLlm() {
  const adapters = new Map();
  const released = [];
  return {
    adapters,
    released,
    service: {
      registerAdapter(providerIds, adapter) {
        const owned = new Set(providerIds);
        for (const p of owned) adapters.set(p, adapter);
        return () => {
          for (const p of owned) adapters.delete(p);
          released.push([...owned]);
        };
      }
    }
  };
}

/** 造 publisher，`loadAdapterModule` 可控延迟（用来卡在 await 窗口里）。 */
function makePublisher({ llm, panel = true, gate } = {}) {
  const warnings = [];
  const publisher = createProviderPublisher({
    settings: { registerProvider: true },
    panelSwitch: async () => panel,
    getLlm: () => llm?.service ?? null,
    loadAdapterModule: async () => {
      if (gate) await gate.promise;
      return { createModelScopeAdapter: async () => ({ adapter: { tag: "built" }, providerIds: ["modelscope-token-plan"] }) };
    },
    resolveApiKey: async () => "ms-3f2a1b8c1111222233334444555566",
    logger: { warn: (m) => warnings.push(m) }
  });
  return { publisher, warnings };
}

// §1 正常路径：publish 注册进 Host，release 能摘掉。
{
  const llm = makeLlm();
  const { publisher } = makePublisher({ llm });
  const result = await publisher.publish(ENTRIES, [], []);
  assert.equal(result.ok, true, "publish 成功");
  assert.equal(llm.adapters.has("modelscope-token-plan"), true, "适配器进了 Host");
  assert.equal(publisher.state.registered, true);
  publisher.release();
  assert.equal(llm.adapters.has("modelscope-token-plan"), false, "release 摘掉了适配器");
}

// §2 P0 回归：dispose 落在 await 窗口里，注册**不得**发生。
//
// 竞态要造准，否则测的是假东西。**同步** dispose（紧接着 publish 调用）是
// 测不到的：入口那道 `queue.isDisposed()` 就在第一个 await 之前，同步 dispose
// 会被它拦住（实测连 `loadAdapterModule` 都还没进）。真实的 teardown 经由
// `ctx.effect` 回调，落在「publish 已经await 住动态 import」之后——所以本用例
// 先让 publish 跑到 import 处（`setImmediate` 让出一次微任务），**再** dispose。
//
// 修复前实测：`import-start → import-done → build → REGISTER`，宿主表 size=1，
// 僵尸 provider 注册进了已撤下本插件的 Host，且 release 永不调用。
{
  const llm = makeLlm();
  let openGate;
  const gate = { promise: new Promise((r) => { openGate = r; }) };
  const { publisher } = makePublisher({ llm, gate });

  const inFlight = publisher.publish(ENTRIES, [], []);
  await new Promise((r) => setImmediate(r));   // 让 publish 走到 loadAdapterModule
  publisher.dispose();                          // teardown：落在 await 窗口里
  publisher.release();
  openGate();                                   // import 完成，publish 恢复

  const result = await inFlight;
  assert.equal(llm.adapters.has("modelscope-token-plan"), false, "dispose 之后不得再注册进 Host（僵尸 provider）");
  assert.equal(llm.released.length, 0, "没有可释放的对——说明它压根不该被注册");
  assert.equal(result.ok, false, "publish 报失败");
  assert.equal(result.skipped, true, "publish 被记为 skipped");
  assert.equal(publisher.state.registered, false, "状态不得声称已注册");
}

// §2b 已注册过之后再dispose：新publish 同样不得注册。
{
  const llm = makeLlm();
  let openGate;
  const gate = { promise: new Promise((r) => { openGate = r; }) };
  const { publisher } = makePublisher({ llm, gate });

  const inFlight = publisher.publish([...ENTRIES, { id: "Qwen/Qwen3.5-27B", name: "Q" }], [], []);
  await new Promise((r) => setImmediate(r));
  publisher.dispose();
  publisher.release();
  openGate();
  await inFlight;
  assert.equal(llm.adapters.size, 0, "被 dispose 的 publisher 不得留下自己那一对");
}

// §3 发布后 dispose + release 摘干净（正向确认上面两条不是靠「什么都不做」通过的）。
{
  const llm = makeLlm();
  const { publisher } = makePublisher({ llm });
  await publisher.publish(ENTRIES, [], []);
  publisher.dispose();
  publisher.release();
  assert.equal(llm.adapters.size, 0, "teardown 摘干净");
  assert.equal(llm.released.length, 1, "release 被调用过一次");
}

// §4 开关关闭 → 不注册（opt-in 默认关）。
{
  const llm = makeLlm();
  const { publisher } = makePublisher({ llm, panel: false });
  const result = await publisher.publish(ENTRIES, [], []);
  assert.equal(llm.adapters.size, 0, "开关关着不注册");
  assert.equal(publisher.state.registered, false);
  assert.equal(result.skipped, true);
}

// §5 队列：并发 publish 排成一条，后一个不能被前一个覆盖。
{
  const llm = makeLlm();
  let concurrent = 0;
  let maxConcurrent = 0;
  // §5 自己造 publisher（要注入计数用的假工厂），返回值就是 publisher 本身。
  const publisher = createProviderPublisher({
    settings: { registerProvider: true },
    panelSwitch: async () => true,
    getLlm: () => llm.service,
    loadAdapterModule: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 1));
      concurrent -= 1;
      return { createModelScopeAdapter: async () => ({ adapter: { tag: "built" }, providerIds: ["modelscope-token-plan"] }) };
    },
    resolveApiKey: async () => "ms-3f2a1b8c1111222233334444555566"
  });
  await Promise.all([
    publisher.publish(ENTRIES, [], []),
    publisher.publish(ENTRIES, ["deepseek-ai/DeepSeek-V4.1-Flash"], []),
    publisher.publish([], [], [])
  ]);
  assert.equal(maxConcurrent, 1, `publish 必须串行（实测最大并发 ${maxConcurrent}）`);
  assert.equal(llm.adapters.size, 1, "最后一次 publish 胜出，宿主只有一对");
}

// §6 回滚：注册抛错时恢复先前在服务的对。
{
  const adapters = new Map();
  const released = [];
  // 只让**下一次**注册抛错：恢复旧对的那次必须成功，否则测的是「两次都失败」
  //（`swapRegistration` 的回滚 catch 分支），不是回滚本身。
  let failNext = false;
  const service = {
    registerAdapter(providerIds, adapter) {
      if (failNext) {
        failNext = false;
        throw new Error("route table full");
      }
      const owned = new Set(providerIds);
      for (const p of owned) adapters.set(p, adapter);
      return () => { for (const p of owned) adapters.delete(p); released.push([...owned]); };
    }
  };
  let buildCount = 0;
  const publisher = createProviderPublisher({
    settings: { registerProvider: true },
    panelSwitch: async () => true,
    getLlm: () => service,
    loadAdapterModule: async () => ({
      createModelScopeAdapter: async () => {
        buildCount += 1;
        return { adapter: { tag: `built-${buildCount}` }, providerIds: ["modelscope-token-plan"] };
      }
    }),
    resolveApiKey: async () => "ms-3f2a1b8c1111222233334444555566"
  });

  await publisher.publish(ENTRIES, [], []);
  assert.equal(adapters.size, 1, "先成功注册一对");

  failNext = true;
  const failed = await publisher.publish([...ENTRIES, { id: "Qwen/Q1", name: "Q" }], [], []);
  assert.equal(failed.ok, false, "注册抛错 → ok:false");
  assert.equal(adapters.size, 1, "坏 publish 不得把已在服务的对拉下来（回滚）");
  assert.equal(adapters.get("modelscope-token-plan").tag, "built-1", "恢复的是先前那一对");
  assert.equal(publisher.state.registered, true, "回滚后仍算已注册");
}

// §7 签名：offer 没变时空转（不churn），变了就重建。
//
// 指标必须是 `registerAdapter` 的调用次数，不是工厂次数：空转守卫在
// `createModelScopeAdapter` **之后**（工厂无副作用，守卫要在 built 拿到后才能比
// 签名），所以工厂照样跑一次。真正要防的 churn 是「摘下再挂上同一个对」——那会
// 打断在途请求，判据只能是注册次数。
{
  const adapters = new Map();
  const regCalls = [];
  let builds = 0;
  const service = {
    registerAdapter(providerIds, adapter) {
      regCalls.push(adapter);   // 存适配器本身（引用比较），不是它的 tag
      const owned = new Set(providerIds);
      for (const p of owned) adapters.set(p, adapter);
      return () => { for (const p of owned) adapters.delete(p); };
    }
  };
  const publisher = createProviderPublisher({
    settings: { registerProvider: true },
    panelSwitch: async () => true,
    getLlm: () => service,
    loadAdapterModule: async () => ({
      createModelScopeAdapter: async () => {
        builds += 1;
        return { adapter: { tag: `b${builds}` }, providerIds: ["modelscope-token-plan"] };
      }
    }),
    resolveApiKey: async () => "ms-3f2a1b8c1111222233334444555566"
  });
  const first = await publisher.publish(ENTRIES, [], []);
  assert.equal(first.skipped, undefined, "首次必须注册");
  assert.equal(regCalls.length, 1);
  const same = await publisher.publish(ENTRIES, [], []);
  assert.equal(same.skipped, true, "offer 未变 → skipped");
  assert.equal(regCalls.length, 1, "offer 未变 → 不得重新注册（每轮询 churn 会打断在途请求）");
  const changed = await publisher.publish([...ENTRIES, { id: "Qwen/Q1", name: "Q" }], [], []);
  assert.equal(changed.skipped, undefined, "offer 变了 → 重建");
  assert.equal(regCalls.length, 2);
  // 不断言 tag 是b2：守卫在工厂**之后**，被跳过的 publish 也跑过工厂，编号会漂。
  // 真正的断言是「注册的是个不同的适配器实例」——用引用比较，不是字符串相等。
  assert.notEqual(regCalls[1], regCalls[0], "重建出的是新适配器实例");
}

// §8 签名的纯函数语义（轮询与 publish 共用同一份公式，构造上无法漂移）。
{
  assert.equal(catalogSignature(ENTRIES, []), catalogSignature(ENTRIES, []), "同输入同输出");
  assert.notEqual(catalogSignature(ENTRIES, []), catalogSignature(ENTRIES, ["a"]), "允许清单参与签名");
  assert.equal(quotaSignatureOf(["b", "a"]), quotaSignatureOf(["a", "b"]), "耗尽集签名与顺序无关");

  // vision 位参与签名——但**不是读 entry.vision 字段**，而是走
  // `isVisionModel`（模态字段 → 策展表 → 名字启发）。所以判据要用**会被判定器
  // 识别**的模型 id，而不是随手编一个：不在策展表也不带 VL 名字的 id 两边都判
  // false，签名自然相同——那不是 bug，是判据的输入本来就一样。
  const visionId = "Qwen/Qwen3.5-VL-7B";
  // 挑一个**不在策展表、名字也不带 VL/vision** 的 id：否则它会被判成视觉模型
  // （实测 `deepseek-ai/DeepSeek-V4.1-Flash` 就在策展表里——真吃图）。
  const plainId = "some-org/some-text-model";
  const withVision = catalogSignature([{ id: visionId, name: "VL" }], []);
  const withoutVision = catalogSignature([{ id: plainId, name: "plain" }], []);
  assert.notEqual(withVision, withoutVision, "能力不同的模型 id 必须产出不同签名");
  assert.match(withVision, /:v1:/, "视觉模型的签名带 v1");
  assert.match(withoutVision, /:v0:/, "纯文本模型的签名带 v0");

  // 同一个 id 的签名跨调用稳定（空转守卫依赖这条：不稳就每轮都churn）。
  assert.equal(catalogSignature(ENTRIES, []), catalogSignature([...ENTRIES], []), "同 id 跨调用稳定");

  const st = { entries: ENTRIES, enabledIds: [], unavailableIds: ["b", "a"], signature: "", quotaSignature: "" };
  syncSignaturesAfterPublish(st);
  assert.equal(st.signature, catalogSignature(ENTRIES, []));
  assert.equal(st.quotaSignature, quotaSignatureOf(["a", "b"]));
}

console.log("provider-publish.test.mjs: all checks passed");
