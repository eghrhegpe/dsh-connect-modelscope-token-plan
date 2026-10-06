// M4 provider 离线套件：目录→descriptor 映射、面板开关+允许清单持久层、
// publish 队列/闸/回滚三条承重语义、provider 路由形状。peer-free：不 import
// 任何 Host peer，裸 node 直接跑。
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
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
import { createFileProviderStore, normalizeEnabledIds, resolveEnabledIds, PROVIDER_VERSION, KNOWN_PROVIDER_VERSIONS, isKnownProviderVersion } from "../src/host/provider-store.ts";
import { name } from "../src/host/host-config.ts";
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

  // 版本判据的同源不变量：白名单必须包含当前写入版本。
  // 这条是升级规程的门闸——`parseAt` 与 `describeProviderPayload` 问的都是白名单
  // （都不是 PROVIDER_VERSION）。若升级时只把 PROVIDER_VERSION 加一、忘了往白名单
  // 补新号，本构建会把自己的写入读作「未设置」，而 doctor/说明仍报 versionKnown，
  // 读侧与说明互相打脸，静默塌缩复活。这里不测那个假设的未来值，只测不变量本身。
  assert.ok(
    KNOWN_PROVIDER_VERSIONS.includes(PROVIDER_VERSION),
    "白名单必须包含当前写入版本（升级版本时两个都要改）"
  );
  // 单一谓词的四支：本构建版本认、外部版本不认、无版本号不认、字符串不认。
  // `null` 必须返回 false —— 写侧用的是 isKnownStateVersion（额外放行「无文件」），
  // 若这里也放行 null，读侧就会把「从来没存过」当成「认得但内容不认识」。
  assert.equal(isKnownProviderVersion(PROVIDER_VERSION), true, "本构建版本 → 认");
  assert.equal(isKnownProviderVersion(99), false, "外部版本 → 不认");
  assert.equal(isKnownProviderVersion(null), false, "无版本号 → 不认（≠「无文件」）");
  assert.equal(isKnownProviderVersion("1"), false, "字符串 → 不认");

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

  // §8b 并发保存不得互相覆盖（写串行化回归）。
  //
  // 回归用例：这个 store 曾**完全没有写串行化**（usage-store 有 writeChain，这里
  // 没有），于是面板开关 POST 与 roster POST —— 两个独立请求——各自读到同一个
  // `current`，后写的赢，前一次的改动被整个丢掉。实测修复前：先存清单，再并发
  // `save(true)` + `saveEnabledIds([...])`，磁盘上只剩其中一次。
  //
  // 断言打在**磁盘**上（同§8 的理由：内存断言会被 cache.remember 喂成假的）。
  {
    const raceDir = mkdtempSync(join(tmpdir(), "ms-provider-race-"));
    const race = createFileProviderStore({ dir: raceDir });
    const diskOf = () => JSON.parse(readFileSync(join(raceDir, "provider.json"), "utf8"));
    await race.saveEnabledIds(["keep/One"]);
    await Promise.all([
      race.save(true),
      race.saveEnabledIds(["keep/One", "keep/Two"])
    ]);
    assert.equal(diskOf().enabled, true, "并发下开关必须落盘");
    assert.deepEqual(
      diskOf().enabledIds,
      ["keep/One", "keep/Two"],
      "并发下清单必须落盘，且不被另一次保存整个丢掉"
    );
  }
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

  // 读侧的另一半（§8c）：写侧守卫挡住了覆盖，读侧也必须把「文件在场、版本不
  // 认识」说出来。否则「保存的值读不到」会被呈现成「从未保存过」——而对允许清
  // 单，这两者读出的方向是危险的：空清单 = 不过滤 = 提供全部模型，用户勾了
  // 隐藏清单却看到全量，且没有任何一条警告提示他。
  {
    const note = await future.versionNote();
    assert.match(note ?? "", /version 99/, "未知版本必须有可读说明");
    assert.match(note ?? "", /this build knows/, "说明里要带本构建认识哪些版本");
    assert.equal(await future.enabled(), null, "未知版本宽容读作未设置");
    assert.deepEqual(await future.enabledIds(), [], "未知版本宽容读作空清单");
    assert.equal(await future.isSet(), false, "未知版本不算「保存过」");
  }
  // 本构建版本、文件缺失、损坏文件 → 无说明（都不是版本不符）
  assert.equal(await store.versionNote(), null, "本构建版本 → 无说明");
  assert.equal(await broken.versionNote(), null, "损坏文件 → 无说明（不是版本不符）");
  {
    // 「从未保存」不是故障，不该报一条警告——这条分支与上面的损坏分支必须分开
    // 覆盖：两者都产出空载荷，但 version 一个是 null、一个是坏 JSON 读不出。
    const absent = createFileProviderStore({ dir: mkdtempSync(join(tmpdir(), "ms-provider-absent-")) });
    assert.equal(await absent.versionNote(), null, "文件缺失 → 无说明");
    assert.equal(await absent.enabled(), null);
    assert.deepEqual(await absent.enabledIds(), []);
  }

  // §8d 写后不得再用 TTL 缓存回读。
  //
  // 回归用例：save / saveEnabledIds / forget 曾各自在写完后 `readPayload()` 回读
  // 另一半再 remember——那条回读走的是 TTL 缓存，拿到的是**写入前**的值。单进程
  // 单 store 看不出来（同一个 store 刚写完），两个独立写入者共享一个目录就能把一个
  // 较新的缓存项顶成旧值；而快照读的正是这个 store，于是面板显示「清单被清成
  // 空」，直到 TTL 过期才自愈。
  {
    const twoDir = mkdtempSync(join(tmpdir(), "ms-provider-cache-"));
    const writerA = createFileProviderStore({ dir: twoDir });
    const writerB = createFileProviderStore({ dir: twoDir });
    await writerB.enabledIds();               // 先填 B 的读缓存（此刻文件还不存在）
    await writerA.saveEnabledIds(["k/One"]); // A 落盘
    await writerB.save(true);                 // B 写开关
    assert.equal(await writerB.enabled(), true, "开关可读");
    assert.deepEqual(
      await writerB.enabledIds(),
      ["k/One"],
      "A 保存的清单不能被 B 的写入顶成空（缓存必须反映刚写下的合并结果）"
    );
    assert.equal(
      JSON.parse(readFileSync(join(twoDir, "provider.json"), "utf8")).enabled,
      true,
      "磁盘上开关也是 true（内存一致且不是假的）"
    );
  }

  // §8e 旧布局（pre-§23 共享目录）的一次性继承，以及「显式 reset 不该被复活」。
  //
  // 这是 provider-store 里唯一没有别处覆盖的路径：继承只在 profile 自己的文件
  // **根本不在场**时发生，而 `createFileProviderStore({ dir })` 的显式目录从不
  // 继承——所以必须用真 profile + $DSH_HOME，不能用 dir。
  // 它同时钉住 version 守卫的两种触发：foreign 版本（写必然被拒）与本构建写的
  // 空文件（forget 的产物），两者都不该再尝试继承。
  {
    const home = mkdtempSync(join(tmpdir(), "ms-provider-adopt-"));
    const shared = join(home, "state", name);
    mkdirSync(shared, { recursive: true });
    writeFileSync(
      join(shared, "provider.json"),
      JSON.stringify({ version: 1, enabled: true, enabledIds: ["legacy/L"] })
    );
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      const adopted = createFileProviderStore({ profile: "p-adopt" });
      assert.equal(await adopted.enabled(), true, "自己的文件不在场 → 从共享布局继承");
      assert.deepEqual(await adopted.enabledIds(), ["legacy/L"], "继承清单");
      const ownFile = join(home, "state", "p-adopt", name, "provider.json");
      assert.equal(
        JSON.parse(readFileSync(ownFile, "utf8")).enabled,
        true,
        "继承值回写到 profile 自己的目录（下次读不再穿旧路径）"
      );
      // 显式「恢复默认」之后，旧布局的遗留值**不该**在下一次读时复活：一次明确的
      // reset 不能被几年前的共享文件撤销。冷读（新 store = 空缓存）是必须的，
      // 因为刚 forget 的那个 store 自己会记住空载荷。
      await adopted.forget();
      const cold = createFileProviderStore({ profile: "p-adopt" });
      assert.equal(await cold.enabled(), null, "reset 后不被旧布局复活");
      assert.deepEqual(await cold.enabledIds(), [], "reset 后不被旧布局复活（清单）");
      // 反过来：一份 foreign 版本躺在 profile **自己的**目录上时，继承也不能把它
      // 当空文件覆盖掉——ADR-006 挡写，而 version 守卫省掉那次注定被拒的尝试
      // （旧行为是每个读 TTL 都试写一次、每次被拒、每次打一条 degraded 警告）。
      const ownDir = join(home, "state", "p-future", name);
      mkdirSync(ownDir, { recursive: true });
      writeFileSync(
        join(ownDir, "provider.json"),
        JSON.stringify({ version: 99, enabled: true, enabledIds: ["future/F"] })
      );
      const foreign = createFileProviderStore({ profile: "p-future" });
      assert.equal(await foreign.enabled(), null, "foreign 宽容读作未设置");
      assert.match(await foreign.versionNote() ?? "", /version 99/, "foreign 仍有可读说明");
      assert.equal(
        JSON.parse(readFileSync(join(ownDir, "provider.json"), "utf8")).version,
        99,
        "foreign 文件未被继承写覆盖"
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
    }
  }

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

// §9 允许清单的**唯一判据**：可读清单（含空清单）优先，只有读抛错才回退内存。
//
// 三处消费者曾各写一套，而轮询侧那套把「空清单」读成「没有答案」：操作者按
// versionNote 的建议删掉 provider.json（正是它给的 reset 手段）之后，面板说
// allowed:"all"（enabledCount 数上全部模型），轮询却继续按内存里的旧清单注册——
// 面板与 Host 对「正在提供什么」各说一套。判据收进 resolveEnabledIds 一份，这里把
// 它的每一支钉住，尤其「空清单」那一支（漂移就发生在这里）。
{
  assert.deepEqual(resolveEnabledIds(["a", "b"], ["x"]), ["a", "b"], "可读清单优先");
  assert.deepEqual(resolveEnabledIds([], ["x"]), [], "空清单是「不过滤」，不是「没有答案」——这一支曾漂移");
  assert.deepEqual(resolveEnabledIds([HIDE_ALL_MODELS], ["x"]), [HIDE_ALL_MODELS], "哨兵清单同样优先");
  assert.deepEqual(resolveEnabledIds(null, ["x"]), ["x"], "读抛错（null）才回退内存");
  assert.deepEqual(resolveEnabledIds(undefined, []), [], "两边都没有 → 空");
  assert.deepEqual(resolveEnabledIds("nonsense", "nonsense"), [], "形状不对一律读作空");
}

// §10 「存在但读不出」的状态文件必须让写守卫**拒写**（ADR-006 不得 fail-open）。
//
// readStateVersion 只把 ENOENT 读作「没有文件」；其余 fs 错误抛出来，写守卫据此
// 拒绝覆盖。造法同 state-store.test.mjs：目录占住文件路径。
{
  const dir = mkdtempSync(join(tmpdir(), "ms-provider-unreadable-"));
  const blocked = join(dir, "provider.json");
  mkdirSync(blocked);
  const store = createFileProviderStore({ dir, logger: { warn: () => {} } });
  let refusal = null;
  await store.save(true).catch((error) => { refusal = error; });
  assert.notEqual(refusal, null, "读不出 provider.json 时保存必须失败，而不是把它覆盖掉");
  assert.match(refusal.message, /refusing to overwrite/, "拒绝理由要写明是拒写");
  assert.equal(existsSync(blocked), true, "原路径未被破坏");
  rmSync(dir, { recursive: true, force: true });
}

// §11 三处消费者必须**真的用上**共用判据。
//
// 上一节钉的是 resolveEnabledIds 的分支；但这次的缺陷形态是「同一个问题在三处各写
// 一套」，所以还要钉住三个调用点没有偷偷写回自己的规则——尤其是 index.ts 那条
// `stored.length > 0`（把可读的空清单当成「没有答案」）。源码级断言在本仓已有先例
// （credentials.test.mjs 钉脱敏表达式），这里用同一种手法守住这一行。
{
  for (const file of ["src/host/index.ts", "src/host/snapshot-aggregate.ts", "src/host/routes/provider.ts"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(
      text.includes("resolveEnabledIds("),
      `${file} 必须走共用的 resolveEnabledIds，不得自带一套空清单规则`
    );
  }
  const index = readFileSync(new URL("../src/host/index.ts", import.meta.url), "utf8");
  assert.ok(
    !index.includes("Array.isArray(stored) && stored.length > 0"),
    "index.ts 不得再把「空清单」读成「没有答案」（那正是面板与轮询各说一套的来源）"
  );
}

console.log("provider.test.mjs: all checks passed");
