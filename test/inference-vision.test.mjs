// 端到端：fetchModels 并行拉取详情端点 → 用 Tasks[].Name 精确判定 vision。
// 用 mock fetchImpl 模拟 /v1/models（目录）与 /api/v1/models/{id}（详情），不触网。
import { strict as assert } from "node:assert";
import { createInferenceClient } from "../src/host/inference-client.ts";

const CATALOG = {
  object: "list",
  data: [
    { id: "deepseek-ai/DeepSeek-V4.1-Flash", object: "", owned_by: "system", created: 1 },
    { id: "Qwen/Qwen-Image-Edit", object: "", owned_by: "system", created: 1 },
    { id: "ZhipuAI/GLM-5.2", object: "", owned_by: "system", created: 1 }
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
const { entries } = await client.fetchModels();

const v41 = entries.find((e) => e.id === "deepseek-ai/DeepSeek-V4.1-Flash");
assert.equal(v41?.vision, true, "详情端点 image-text-to-text → vision 自动识别（无需策展/名字）");
const imgEdit = entries.find((e) => e.id === "Qwen/Qwen-Image-Edit");
assert.equal(imgEdit?.vision, false, "image-to-image 不被误判为吃图");
const glm = entries.find((e) => e.id === "ZhipuAI/GLM-5.2");
assert.equal(glm?.vision, false, "text-generation → 非 vision");

console.log("inference-vision.test.mjs: all checks passed");
