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

let detailCalls = 0;

function mockFetch(url) {
  if (url.endsWith("/models")) {
    return Promise.resolve({ ok: true, json: async () => CATALOG });
  }
  if (url.includes("/api/v1/models/")) {
    detailCalls += 1;
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

// ── 标签缓存的 TTL 与目录/余额**解耦** ──
//
// 回归用例：三条路径曾共用 `cacheSeconds`（默认 60s）。面板与对话框胶囊按
// `pollSeconds`（默认 30s）轮询快照、快照每次都调 fetchModels，于是穿透时对目录
// 里**每个**模型各打一次 siteBase/api/v1/models/{id}——当前目录 ~37 条 = 每轮
// 38 个 HTTP 请求、稳定每分钟一轮（约 5 万/天），只为判一个几乎不变的布尔值，
// 打的还是 modelscope.cn 网站上一个非公开、非契约的接口。
//
// 换一个窗口覆盖 = 换一个目录缓存键（目录必然重新穿透），但详情端点**一次都不该
// 再打**：标签有自己 6 小时的 TTL。
assert.equal(detailCalls, CATALOG.data.length, "首轮：目录里每条各打一次详情");
const beforeSwap = detailCalls;
await client.fetchModels(262144);
assert.equal(detailCalls, beforeSwap, "换目录缓存键后详情端点不得重打（标签走自己的长 TTL）");

// ── 详情端点失败**不算结论**，不得被缓存成「这个模型没有标签」 ──
//
// 同一个「读不到 ≠ 没有」的判据：旧实现把 429/5xx/形状漂移降级成 `[]`，而 `[]`
// 会被新加的 6 小时 TTL 缓存——一次网络抖动就把某模型的视觉标签钉死半天。现在
// 失败抛错、不进缓存：本轮按「没标签」处理，下一轮必须重试。
{
  const FLAKY_CATALOG = {
    object: "list",
    data: [{ id: "Foo/Widget-9", object: "", owned_by: "system", created: 1 }]
  };
  let failDetails = true;
  let attempts = 0;
  const flaky = createInferenceClient({
    settings,
    tokenStore,
    deps: {
      fetchImpl: (url) => {
        if (url.endsWith("/models")) return Promise.resolve({ ok: true, json: async () => FLAKY_CATALOG });
        if (url.includes("/api/v1/models/")) {
          attempts += 1;
          if (failDetails) return Promise.resolve({ ok: false, status: 429, json: async () => ({}) });
          return Promise.resolve({
            ok: true,
            json: async () => ({ Code: 200, Data: { Tasks: [{ Name: "image-text-to-text" }], widgets: [] } })
          });
        }
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
    }
  });
  const first = await flaky.fetchModels();
  assert.equal(
    first.entries.find((e) => e.id === "Foo/Widget-9")?.vision,
    false,
    "详情 429 那一轮读不到标签 → 不猜（名字不含 vl/vision、也不在策展清单）"
  );
  assert.equal(attempts, 1, "首轮确实打了详情端点一次");
  failDetails = false;
  // 换目录缓存键绕开 60s 的目录 TTL，让第二轮真的重跑一遍打标签。
  const second = await flaky.fetchModels(262144);
  assert.equal(
    second.entries.find((e) => e.id === "Foo/Widget-9")?.vision,
    true,
    "上一轮的失败没被当成结论缓存——下一轮必须重试并拿到真实标签"
  );
  assert.equal(attempts, 2, "两轮各打一次（失败那轮没有被记住）");
}

console.log("inference-vision.test.mjs: all checks passed");
