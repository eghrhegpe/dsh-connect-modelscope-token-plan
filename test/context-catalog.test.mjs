// 内置策展表：三级真值链（目录声明 > 用户覆盖 > 策展表 > 128k 兜底）。
// 既有 inference-vision.test.mjs 的 mock 形态，另加声明窗口与覆盖两条路径。
import { strict as assert } from "node:assert";
import { createInferenceClient } from "../src/host/inference-client.ts";
import { CURATED_CONTEXT_WINDOWS, curatedWindowOf } from "../src/host/context-catalog.ts";
import { contextWindowSourceOf, rosterWithAvailability } from "../src/host/llm-models.ts";

// ── 表本身：值合法、命中/未命中判据 ──
for (const [id, window] of Object.entries(CURATED_CONTEXT_WINDOWS)) {
  assert.ok(Number.isFinite(window) && window > 0, `策展值必须是正数：${id} → ${window}`);
  assert.equal(curatedWindowOf(id), window, `表内 id 必须自洽命中：${id}`);
}
assert.equal(curatedWindowOf("deepseek-ai/DeepSeek-V4.1-Flash"), 1048576);
assert.equal(curatedWindowOf("Qwen/Qwen-Image-Edit"), null, "生图模型不进表");
assert.equal(curatedWindowOf("no/such-model"), null, "未收录 → null（兜底留给调用方）");
assert.equal(curatedWindowOf(""), null, "空 id → null");
assert.equal(curatedWindowOf(undefined), null, "非字符串 → null");

// ── fetchModels 打标 e2e ──
const CATALOG = {
  object: "list",
  data: [
    // 策展命中：目录不声明 → 策展表 1048576
    { id: "deepseek-ai/DeepSeek-V4.1-Flash", object: "", owned_by: "system", created: 1 },
    // 不在表（生图）→ 兜底 128000
    { id: "Qwen/Qwen-Image-Edit", object: "", owned_by: "system", created: 1 },
    // 策展命中：GLM-5.2 → 1000000
    { id: "ZhipuAI/GLM-5.2", object: "", owned_by: "system", created: 1 },
    // 目录声明 40960 → 任何一级都不碰
    { id: "test/Declared-Model", object: "", owned_by: "system", created: 1, context_length: 40960 }
  ]
};

function detailTasks(id) {
  if (id === "deepseek-ai/DeepSeek-V4.1-Flash") return [{ Name: "image-text-to-text", ChineseName: "视觉多模态理解" }];
  if (id === "Qwen/Qwen-Image-Edit") return [{ Name: "image-to-image", ChineseName: "图片生成图片" }];
  return [{ Name: "text-generation", ChineseName: "文本生成" }];
}

function mockFetch(url) {
  if (url.endsWith("/models")) {
    return Promise.resolve({ ok: true, json: async () => CATALOG });
  }
  if (url.includes("/api/v1/models/")) {
    const id = url.split("/api/v1/models/")[1];
    return Promise.resolve({ ok: true, json: async () => ({ Code: 200, Data: { Tasks: detailTasks(id), widgets: [] } }) });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
}

const settings = {
  apiBase: "https://api-inference.modelscope.cn/v1",
  siteBase: "https://modelscope.cn",
  cacheSeconds: 60,
  inferenceTimeoutMs: 5000
};
const tokenStore = { resolve: async () => ({ value: "", source: null }) };
const client = createInferenceClient({ settings, tokenStore, deps: { fetchImpl: mockFetch } });

// 无覆盖：策展表生效
const { entries } = await client.fetchModels();
const ds = entries.find((e) => e.id === "deepseek-ai/DeepSeek-V4.1-Flash");
assert.equal(ds?.contextWindow, 1048576, "策展表命中 → 1048576（不是 128000 兜底）");
assert.equal(contextWindowSourceOf(ds), "curated", "策展命中标记 curated");
const glm = entries.find((e) => e.id === "ZhipuAI/GLM-5.2");
assert.equal(glm?.contextWindow, 1000000, "GLM-5.2 策展 1000000");
assert.equal(contextWindowSourceOf(glm), "curated");
const img = entries.find((e) => e.id === "Qwen/Qwen-Image-Edit");
assert.equal(img?.contextWindow, 128000, "不在表 → pi-ai 兜底 128000");
assert.equal(contextWindowSourceOf(img), "catalog", "兜底态记 catalog");
const declared = entries.find((e) => e.id === "test/Declared-Model");
assert.equal(declared?.contextWindow, 40960, "目录声明优先，策展表不推翻");
assert.equal(contextWindowSourceOf(declared), "catalog");

// 覆盖压过策展表（同一 client，不同缓存键各自成立）
const { entries: overridden } = await client.fetchModels(262144);
const dsO = overridden.find((e) => e.id === "deepseek-ai/DeepSeek-V4.1-Flash");
assert.equal(dsO?.contextWindow, 262144, "用户覆盖 > 策展表");
assert.equal(contextWindowSourceOf(dsO), "override", "覆盖标记 override");
const declaredO = overridden.find((e) => e.id === "test/Declared-Model");
assert.equal(declaredO?.contextWindow, 40960, "目录声明 > 用户覆盖");

// roster 投影带来源标记（descriptor/roster 同一真值链，两侧不说两套话）
const roster = rosterWithAvailability(entries, []);
const dsRow = roster.find((row) => row.id === "deepseek-ai/DeepSeek-V4.1-Flash");
assert.equal(dsRow?.contextSource, "curated");
assert.equal(dsRow?.contextWindow, 1048576);

console.log("context-catalog.test.mjs: all checks passed");
