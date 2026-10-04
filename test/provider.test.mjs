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
  resolveModelCapability,
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
  assert.equal(isVisionModel(normalizeEntry({ id: "Qwen/Qwen3.8-Flash-Next" })), true, "官方 SDK 示例证明能吃图 → vision（名字无 vl/vision）");
  assert.equal(isVisionModel(normalizeEntry({ id: "deepseek-ai/DeepSeek-V4-Pro" })), false, "未策展且名字无视觉 token → 非 vision");
  // 策展清单 = 详情端点实测吃图的全量（2026-10-04，api-inference 35 条目录里共 14 条
  // image-text-to-text）。这里逐条验证离线兜底覆盖完整，防止加了模型却漏进清单。
  {
    const curatedVision = [
      "deepseek-ai/DeepSeek-V4.1-Flash",
      "MiniMax/MiniMax-M3",
      "OpenGVLab/InternVL3_5-241B-A28B",
      "PaddlePaddle/ERNIE-4.5-VL-28B-A3B-PT",
      "Qwen/Qwen3.5-122B-A10B",
      "Qwen/Qwen3.5-27B",
      "Qwen/Qwen3.5-35B-A3B",
      "Qwen/Qwen3.5-397B-A17B",
      "Qwen/Qwen3.8-27B",
      "Qwen/Qwen3.8-Flash-Next",
      "Shanghai_AI_Laboratory/Intern-S1",
      "Shanghai_AI_Laboratory/Intern-S1-mini",
      "Shanghai_AI_Laboratory/Intern-S2-Preview",
      "stepfun-ai/Step-3.7-Flash"
    ];
    for (const id of curatedVision) {
      assert.equal(isVisionModel(normalizeEntry({ id })), true, `策展兜底覆盖 ${id}`);
    }
    // 名字启发漏判、只能靠策展清单捞回的代表（名字不含 vl/vision/internvl 等 token）
    assert.equal(isVisionModel(normalizeEntry({ id: "MiniMax/MiniMax-M3" })), true, "MiniMax-M3 名字无视觉 token，靠策展捞回");
    assert.equal(isVisionModel(normalizeEntry({ id: "Shanghai_AI_Laboratory/Intern-S1" })), true, "Intern-S1 名字无视觉 token，靠策展捞回");
    assert.equal(isVisionModel(normalizeEntry({ id: "stepfun-ai/Step-3.7-Flash" })), true, "Step-3.7-Flash 名字无视觉 token，靠策展捞回");
  }
  // 详情端点 Tasks[].Name 精确判定（fetchModels 会把标签挂到 entry.tasks）
  assert.equal(isVisionModel(normalizeEntry({ id: "deepseek-ai/DeepSeek-V4.1-Flash", tasks: ["image-text-to-text"] })), true, "tasks 含 image-text-to-text → vision（精确，无需策展/名字）");
  assert.equal(isVisionModel(normalizeEntry({ id: "Qwen/Qwen-Image-Edit", tasks: ["image-to-image"] })), false, "tasks 含 image-to-image（图出非图入）→ 非 vision，不被误判");
  assert.equal(isVisionModel(normalizeEntry({ id: "ZhipuAI/GLM-5.2", tasks: ["text-generation"] })), false, "tasks 含 text-generation → 非 vision");
  // 有结构化任务标签时以标签为准，哪怕名字像视觉
  assert.equal(isVisionModel(normalizeEntry({ id: "Foo/bar-vl", tasks: ["text-generation"] })), false, "有任务标签时以标签为准（名字像视觉也压住）");

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
// §3b resolveModelCapability：任务标签 → 能力类型（能力路由）
// ─────────────────────────────────────────────────────────────────────────────
{
  const cap = (id, tasks) => resolveModelCapability({ id, name: id, tasks });

  // 权威标签路径（真机核实词表，2026-10-04）
  assert.equal(cap("q/a", ["text-generation"]), "text", "text-generation → text");
  assert.equal(cap("q/b", ["text2text-generation"]), "text", "text2text-generation → text");
  assert.equal(cap("q/c", ["image-text-to-text"]), "vision-input", "image-text-to-text → vision-input");
  assert.equal(cap("q/d", ["image-to-text"]), "image-to-text", "image-to-text → image-to-text");
  assert.equal(cap("q/e", ["image-to-image"]), "image-to-image", "image-to-image → image-to-image");
  assert.equal(cap("q/f", ["text-to-image-synthesis"]), "text-to-image", "text-to-image-synthesis → text-to-image（hub 真机实测任务名）");
  assert.equal(cap("q/g", ["text-to-video-synthesis"]), "text-to-video", "text-to-video-synthesis → text-to-video");

  // 多标签取最具体（rank 高的图像类赢）
  assert.equal(cap("q/h", ["text-generation", "image-text-to-text"]), "vision-input", "多标签取图像相关而非 text");
  assert.equal(cap("q/i", ["image-text-to-text", "image-to-image"]), "image-to-image", "多标签取更具体的图像类");

  // 有标签但全不认识 → unknown（不猜）
  assert.equal(cap("q/j", ["some-future-task"]), "unknown", "未知任务标签 → unknown，不猜");

  // 无标签走兜底链：策展 / 名字启发 / unknown
  assert.equal(resolveModelCapability({ id: "Qwen/Qwen2.5-VL-32B" }), "vision-input", "名字启发兜底 → vision-input");
  assert.equal(resolveModelCapability({ id: "Qwen/Qwen3.5-35B-A3B" }), "vision-input", "策展清单兜底 → vision-input（该 id 实测能吃图，名字无 vl）");
  assert.equal(resolveModelCapability({ id: "acme/Not-Real" }), "unknown", "无任何信号 → unknown");

  // 结构化模态字段仍是最高权威，盖过任务标签
  assert.equal(
    resolveModelCapability({ id: "x/y", input_modalities: ["image", "text"], tasks: ["text-generation"] }),
    "vision-input",
    "结构化字段优先于任务标签"
  );

  // isVisionModel 是 capability 的布尔投影：图出图 / 文生图不算 vision
  assert.equal(isVisionModel(normalizeEntry({ id: "q/e", tasks: ["image-to-image"] })), false, "image-to-image 不是 vision（图出图不吃图）");
  assert.equal(isVisionModel(normalizeEntry({ id: "q/f", tasks: ["text-to-image-synthesis"] })), false, "text-to-image-synthesis 不是 vision");
  assert.equal(isVisionModel(normalizeEntry({ id: "q/c", tasks: ["image-text-to-text"] })), true, "image-text-to-text 是 vision");
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

  // 上面这句读的是 cache.remember 填的内存值，所以「面板显示对了」并不等于
  // 「磁盘写对了」。曾经 save() 把 enabled 交给 patchPayload 的 merge 分支，
  // 开关值在落盘时被静默丢弃：内存 true / 磁盘无键，冷读即回落到「未接入」。
  // 这里对同一目录另开一个 store（空缓存）来钉住真正的落盘值。
  {
    const cold = () => createFileProviderStore({ dir });
    const onDisk = () => JSON.parse(readFileSync(join(dir, "provider.json"), "utf8"));
    assert.equal(onDisk().enabled, true, "开关值必须落盘，不能只活在缓存里");
    assert.equal(await cold().enabled(), true, "冷读（新进程/新缓存）必须也是 true");

    // 关掉开关同样要落盘（反向也要钉：写 false 不能被磁盘上的 true 挡住）
    await store.save(false);
    assert.equal(onDisk().enabled, false, "关开关必须写 false 到磁盘");
    assert.equal(await cold().enabled(), false, "冷读后仍是 false");
    await store.save(true);
    assert.equal(onDisk().enabled, true, "恢复 true");
  }

  // 保存清单不能覆盖开关；反之亦然
  await store.saveEnabledIds(["a/A", "b/B"]);
  assert.equal(await store.enabled(), true, "保存清单后开关保持");
  // 清单保存后开关不仅要「内存里还在」，磁盘上也必须还在。
  assert.equal(
    JSON.parse(readFileSync(join(dir, "provider.json"), "utf8")).enabled,
    true,
    "保存清单后开关在磁盘上保持"
  );
  await store.save(false);
  assert.deepEqual(await store.enabledIds(), ["a/A", "b/B"], "保存开关后清单保持");
  // ★ 用户报的那个 bug：保存开关会把已存的清单整个删掉（只传了 {enabled}，
  //   而 body 只在 patch.enabledIds !== undefined 时才带该键）。清单在磁盘上
  //   必须活着 —— 内存断言抓不到它，因为 cache.remember 用的是 list 变量。
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, "provider.json"), "utf8")).enabledIds,
    ["a/A", "b/B"],
    "保存开关后清单在磁盘上保持"
  );

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
