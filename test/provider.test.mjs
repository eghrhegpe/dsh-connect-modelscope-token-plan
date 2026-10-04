// M4 provider 离线套件：目录→descriptor 映射、面板开关+允许清单持久层、
// publish 队列/闸/回滚三条承重语义、provider 路由形状。peer-free：不 import
// 任何 Host peer，裸 node 直接跑。
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LLM_PROVIDER_ID, LLM_DISPLAY_NAME, LLM_API_KEY_NAME,
  FALLBACK_CONTEXT_WINDOW, HIDE_ALL_MODELS,
  normalizeEntry, isVisionModel, isChatModel, contextWindowOf, maxOutputLengthOf,
  toPiDescriptor, filterByEnabled, isModelEnabled, buildDescriptors,
  rosterWithAvailability, summarizeCatalog
} from "../src/host/llm-models.ts";
import { createFileProviderStore, normalizeEnabledIds, PROVIDER_VERSION, KNOWN_PROVIDER_VERSIONS } from "../src/host/provider-store.ts";
import { createPublishQueue, swapRegistration, createPairReleaser, BAD_FACTORY_SHAPE_ERROR } from "../src/host/publish-core.ts";

// ─────────────────────────────────────────────────────────────────────────────
// §3 目录→descriptor 映射
// ─────────────────────────────────────────────────────────────────────────────
{
  // 常量：契约 §1
  assert.equal(LLM_PROVIDER_ID, "modelscope-token-plan");
  assert.equal(LLM_DISPLAY_NAME, "ModelScope Token Plan");
  assert.equal(LLM_API_KEY_NAME, "ModelScope token");
  assert.equal(HIDE_ALL_MODELS, "__hide_all__");

  // normalizeEntry：id 必取、name 回退 id、raw 保留
  const entry = normalizeEntry({ id: "Qwen/Qwen3.5-35B-A3B", context_length: 262144 });
  assert.equal(entry.id, "Qwen/Qwen3.5-35B-A3B");
  assert.equal(entry.name, "Qwen/Qwen3.5-35B-A3B", "无 name → 回退 id");
  assert.equal(entry.contextWindow, 262144, "声明的窗口生效");
  assert.equal(entry.raw.id, "Qwen/Qwen3.5-35B-A3B", "raw 保留原始条目");
  assert.equal(normalizeEntry(null).id, "", "null 条目 → 空 id，不抛");

  // vision：结构化字段权威；无字段回退名字启发
  assert.equal(isVisionModel(normalizeEntry({ id: "m", input_modalities: ["image", "text"] })), true, "input_modalities 含 image → vision");
  assert.equal(isVisionModel(normalizeEntry({ id: "m", input_modalities: ["text"] })), false, "结构化字段只含 text → 非 vision");
  assert.equal(isVisionModel(normalizeEntry({ id: "Qwen/Qwen2.5-VL-32B" })), true, "名字含 vl → vision 启发");
  assert.equal(isVisionModel(normalizeEntry({ id: "Qwen/Qwen3.5-35B" })), false, "纯文本模型名 → 非 vision");
  // 上游零模态元数据 + 名字无 vl/vision，只能靠策展清单兜底
  assert.equal(isVisionModel(normalizeEntry({ id: "deepseek-ai/DeepSeek-V4.1-Flash" })), true, "策展清单命中 → vision（名字无 vl 但能吃图）");
  assert.equal(isVisionModel(normalizeEntry({ id: "deepseek-ai/DeepSeek-V4-Pro" })), false, "未策展且名字无视觉 token → 非 vision");

  // chat：宽松方向，只排除明确生图模型
  assert.equal(isChatModel(normalizeEntry({ id: "m", output_modalities: ["image"] })), false, "output_modalities 只含 image → 生图");
  assert.equal(isChatModel(normalizeEntry({ id: "m", output_modalities: ["text"] })), true, "output_modalities 含 text → chat");
  assert.equal(isChatModel(normalizeEntry({ id: "m", output_modalities: [] })), true, "空数组不算生图声明");
  assert.equal(isChatModel(normalizeEntry({ id: "wanx/wanx2.1-t2i" })), false, "wanx 生图名排除");
  assert.equal(isChatModel(normalizeEntry({ id: "Qwen/Qwen3.5-35B" })), true, "未标注 → chat（宽松方向）");

  // 窗口与输出上限：缺字段回退/归零
  assert.equal(contextWindowOf(normalizeEntry({ id: "m" })), FALLBACK_CONTEXT_WINDOW, "未声明窗口 → 兜底");
  assert.equal(maxOutputLengthOf(normalizeEntry({ id: "m", max_output_length: 65536 })), 65536);
  assert.equal(maxOutputLengthOf(normalizeEntry({ id: "m" })), 0, "未声明输出上限 → 0");

  // toPiDescriptor：承重形状
  const desc = toPiDescriptor(normalizeEntry({ id: "Qwen/Qwen2.5-VL-32B", max_output_length: 8192 }), { baseUrl: "https://api-inference.modelscope.cn/v1" });
  assert.equal(desc.api, "openai-completions");
  assert.equal(desc.provider, LLM_PROVIDER_ID);
  assert.deepEqual(desc.input, ["text", "image"], "vision 模型吃图");
  assert.equal(desc.reasoning, false, "§4：保守默认 reasoning:false");
  assert.equal(desc.contextWindow, FALLBACK_CONTEXT_WINDOW);
  assert.equal(desc.maxTokens, 8192, "声明了输出上限才带 maxTokens");
  assert.deepEqual(desc.compat, { maxTokensField: "max_tokens", supportsDeveloperRole: false }, "supportsDeveloperRole:false 是承重墙");
  assert.equal("thinkingLevelMap" in desc, false, "§4：不设 thinkingLevelMap");
  const textDesc = toPiDescriptor(normalizeEntry({ id: "Qwen/Qwen3.5-35B" }));
  assert.deepEqual(textDesc.input, ["text"]);
  assert.equal("maxTokens" in textDesc, false, "未声明输出上限 → 不带 maxTokens");

  // filterByEnabled：空清单不过滤、HIDE_ALL 全隐藏、白名单严格
  const catalog = [normalizeEntry({ id: "a/A" }), normalizeEntry({ id: "b/B" }), normalizeEntry({ id: "c/C" })];
  assert.equal(filterByEnabled(catalog, []).length, 3, "空清单 = 不过滤");
  assert.equal(filterByEnabled(catalog, ["a/A", "c/C"]).map((e) => e.id).join(","), "a/A,c/C", "白名单严格");
  assert.equal(filterByEnabled(catalog, [HIDE_ALL_MODELS]).length, 0, "哨兵 → 什么都不提供");
  assert.equal(isModelEnabled([], "a/A"), true, "空清单提供一切");
  assert.equal(isModelEnabled([HIDE_ALL_MODELS], "a/A"), false, "哨兵不提供任何真实 id");
  assert.equal(isModelEnabled(["a/A"], "a/A"), true);

  // buildDescriptors：先过滤再丢不可用；去重保留末次
  const deduped = buildDescriptors([normalizeEntry({ id: "a/A" }), normalizeEntry({ id: "a/A" }), normalizeEntry({ id: "b/B" })], {});
  assert.equal(deduped.filter((d) => d.id === "a/A").length, 1, "同 id 去重");
  const withUnavailable = buildDescriptors(catalog, { unavailableModelIds: ["b/B"] });
  assert.equal(withUnavailable.some((d) => d.id === "b/B"), false, "不可用模型从 picker 丢弃");
  const withList = buildDescriptors(catalog, { enabledIds: [HIDE_ALL_MODELS] });
  assert.equal(withList.length, 0, "哨兵经 buildDescriptors 得空 offer");

  // roster：保留耗尽模型但标记不可用
  const roster = rosterWithAvailability(catalog, ["b/B"]);
  assert.equal(roster.length, 3, "roster 保留耗尽模型（灰显而非消失）");
  assert.equal(roster.find((r) => r.id === "b/B").available, false);
  assert.equal(roster.find((r) => r.id === "b/B").quotaExhausted, true);
  assert.equal(roster.find((r) => r.id === "a/A").available, true);

  // summarizeCatalog
  const summary = summarizeCatalog([normalizeEntry({ id: "a/A" }), normalizeEntry({ id: "Qwen/Qwen2.5-VL" }), normalizeEntry({ id: "wanx/wanx2.1-t2i" })]);
  assert.equal(summary.modelCount, 2, "生图模型不计入 chat 模型数");
  assert.equal(summary.visionCount, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 开关 + 允许清单持久层
// ─────────────────────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "ms-provider-store-"));
  const store = createFileProviderStore({ dir });

  // 初始：未设置
  assert.equal(await store.enabled(), null, "未保存 → null（回退配置）");
  assert.equal((await store.enabledIds()).length, 0, "未保存清单 → 空 = 不过滤");
  assert.equal(await store.isSet(), false);

  // 保存开关；写失败传播
  await store.save(true);
  assert.equal(await store.enabled(), true);
  assert.equal(await store.isSet(), true);

  // 保存清单不能覆盖开关；反之亦然
  await store.saveEnabledIds(["a/A", "b/B"]);
  assert.equal(await store.enabled(), true, "保存清单后开关保持");
  await store.save(false);
  assert.deepEqual(await store.enabledIds(), ["a/A", "b/B"], "保存开关后清单保持");

  // 清单去重保序
  await store.saveEnabledIds(["a/A", "a/A", "", "b/B"]);
  assert.deepEqual(await store.enabledIds(), ["a/A", "b/B"], "重复与空白剔除");

  // 忘掉：回到「未设置」
  await store.forget();
  assert.equal(await store.enabled(), null);
  assert.equal((await store.enabledIds()).length, 0);
  assert.equal(await store.isSet(), false);

  // 损坏文件 → 读作未设置（不抛）
  const brokenDir = mkdtempSync(join(tmpdir(), "ms-provider-store-broken-"));
  writeFileSync(join(brokenDir, "provider.json"), "not json{{");
  const broken = createFileProviderStore({ dir: brokenDir });
  assert.equal(await broken.enabled(), null, "损坏文件读作未设置");
  assert.equal(await broken.isSet(), false);

  // ADR-006 写侧守卫：新版本文件拒绝覆盖
  const futureDir = mkdtempSync(join(tmpdir(), "ms-provider-store-future-"));
  writeFileSync(join(futureDir, "provider.json"), JSON.stringify({ version: 99, enabled: true }));
  const future = createFileProviderStore({ dir: futureDir });
  await assert.rejects(() => future.save(true), /refusing to overwrite/, "未知版本 → 拒绝覆盖");
  // 本 build 读不了 version 99（这正是守卫的目的），所以要核对磁盘原文件没被改。
  assert.equal(
    JSON.parse(readFileSync(join(futureDir, "provider.json"), "utf8")).version,
    99,
    "原文件未被破坏（仍是版本 99）"
  );

  // normalizeEnabledIds 归一化
  assert.deepEqual(normalizeEnabledIds(["x", "x", 1, null, "y"]), ["x", "y"]);
  assert.equal(normalizeEnabledIds("nope"), null, "非数组 → null");
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 publish-core 三条承重语义
// ─────────────────────────────────────────────────────────────────────────────
{
  // 队列串行：慢 publish 不能被快 publish 覆盖
  const queue = createPublishQueue();
  const order = [];
  const slow = queue.enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push("slow");
    return "slow";
  });
  const fast = queue.enqueue(async () => {
    order.push("fast");
    return "fast";
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["slow", "fast"], "后入的 publish 排在在途之后执行");

  // disposed 闸
  const queue2 = createPublishQueue();
  queue2.dispose();
  assert.equal(queue2.isDisposed(), true);
  let ran = false;
  await queue2.enqueue(async () => { ran = true; });
  assert.equal(ran, true, "enqueue 本身仍执行任务；disposed 闸在 publisher 的 publish 层判定");

  // swapRegistration：注册失败恢复旧对
  const registered = [];
  const releases = [];
  const llm = {
    registerAdapter: (ids, adapter) => {
      registered.push(ids);
      const off = () => releases.push("off");
      return off;
    }
  };
  const state = { registered: false, error: null, releaseAdapter: null, releaseDirectory: null, built: null };
  const release = createPairReleaser(state);
  const oldBuilt = { providerIds: ["old"], adapter: {} };
  // 先注册一对成功的
  const first = swapRegistration({ llm, built: oldBuilt, previousBuilt: null, state, release, registerPair: (l, b, t) => {
    t.releaseAdapter = l.registerAdapter(b.providerIds, b.adapter);
  } });
  assert.equal(first.ok, true);
  assert.equal(state.registered, true);
  assert.equal(state.built, oldBuilt);

  // 注册新对时抛错 → 恢复旧对（llm 只对 bad id 抛，rollback 用的同一个 llm）
  const badBuilt = { providerIds: ["bad"], adapter: {} };
  const second = swapRegistration({
    llm: {
      registerAdapter: (ids) => {
        if (ids.includes("bad")) throw new Error(BAD_FACTORY_SHAPE_ERROR);
        releases.push("off");
        return () => {};
      }
    },
    built: badBuilt, previousBuilt: oldBuilt, state, release,
    registerPair: (l, b, t) => { t.releaseAdapter = l.registerAdapter(b.providerIds, b.adapter); }
  });
  assert.equal(second.ok, false, "注册失败返回 ok:false");
  assert.equal(state.registered, true, "恢复旧对后仍 registered");
  assert.equal(state.built, oldBuilt, "恢复旧对 identity");
  assert.match(state.error, /did not return/, "失败原因进 state.error");
}

console.log("provider.test.mjs: all checks passed");
