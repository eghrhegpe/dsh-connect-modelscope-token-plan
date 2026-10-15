// 出图路由测试：开关读/写、模型偏好、候选集合、缺席原因、信任围栏。
//
// 桩 ctx 与 provider-routes.test.mjs 同款（webServer 捕获 handler、内存凭据服务、
// 全局 fetch 顶替上游目录）。
//
// 本套件钉住几个**易被改错**的点：
//   · 候选来自目录的出图能力（tasks 标签），**不是** provider 的允许清单——
//     两者混淆会让「用户裁剪 chat picker」静默删掉出图工具的候选；
//   · 空 body / 类型错误的 POST 要被拒，不能静默成功（界面会显示「保存了」）；
//   · 出图与 provider 是**两条独立路由**，写一个不影响另一个。

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/host/index.ts";
import { DRAW_PATH, PROVIDER_PATH } from "../src/host/routes/paths.ts";
import { setDrawToolNote, resetDrawToolNote } from "../src/host/draw-tool-state.ts";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "ms-draw-routes-"));

let currentFetch = () => Promise.reject(new Error("no network in this test"));
globalThis.fetch = (...args) => currentFetch(...args);

const credentialsService = {
  store: new Map(),
  async set(ref, value) { this.store.set(ref, value); },
  async unset(ref) { this.store.delete(ref); },
  async resolve(ref) { return this.store.has(ref) ? { value: this.store.get(ref) } : null; }
};
const makeCtx = (capture) => ({
  get: (service) => (service === "credentials" ? credentialsService : undefined),
  logger: { warn: () => {} },
  effect: (_fn, _label) => {},
  webServer: {
    register({ path, handler }) {
      capture.set(path, handler);
      return () => capture.delete(path);
    }
  }
});

const makeReq = (method, { host = "localhost:3080", origin = null, body = null } = {}) => {
  const req = { method, headers: { host, ...(origin ? { origin } : {}) } };
  if (body !== null) req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body)); };
  return req;
};
const makeRes = () => {
  const res = { status: null, headers: null, body: null };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
};
const call = async (handlers, path, req) => {
  const handler = handlers.get(path);
  assert.ok(handler, `route ${path} not registered`);
  const res = makeRes();
  await handler(req, res);
  return res;
};

// 目录桩。注意**两条上游**：
//   · `apiBase/models` 给目录列表（每条只有 id）；
//   · `siteBase/api/v1/models/{id}` 给详情，`Data.Tasks[].Name` 才是能力标签——
//     本仓库的能力判定读的是后者（`inference-client.fetchTaskTags`），
//     `/v1/models` 本身不返回任何模态字段（实测，见 docs/SPIKE.md）。
// 所以桩必须按 URL 分流，只答列表会让所有条目退化成 unknown、候选为空。
const TASKS_BY_ID = {
  "Qwen/Qwen3.5-35B-A3B": ["text-generation"],
  "Qwen/Qwen2.5-VL-32B": ["image-text-to-text"],
  "Qwen/Qwen-Image-Edit": ["image-to-image"],
  "MusePublic/Qwen-Image-Edit": ["image-to-image"]
};
currentFetch = async (url) => {
  const href = String(url);
  if (href.includes("/api/v1/models/")) {
    const id = decodeURIComponent(href.split("/api/v1/models/")[1] ?? "");
    const tasks = TASKS_BY_ID[id];
    return new Response(JSON.stringify({
      Code: 200,
      Data: { Tasks: (tasks ?? []).map((Name) => ({ Name })) }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({
    object: "list",
    data: Object.keys(TASKS_BY_ID).map((id) => ({ id }))
  }), { status: 200, headers: { "content-type": "application/json" } });
};

const handlers = new Map();
apply(makeCtx(handlers), {}, { env: {} });
assert.ok(handlers.has(DRAW_PATH), "出图路由已注册");
assert.ok(handlers.has(PROVIDER_PATH), "provider 路由仍注册（两条独立）");

// ── 信任围栏 ──
{
  const res = makeRes();
  await handlers.get(DRAW_PATH)(makeReq("GET", { origin: "https://evil.example" }), res);
  assert.equal(res.status, 403, "跨站 origin 必须被拒");
}

// ── GET：默认形状 ──
{
  const res = await call(handlers, DRAW_PATH, makeReq("GET"));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.enabled, false, "默认不开启（opt-in）");
  assert.equal(res.body.source, "config", "未保存过 → 来源是配置");
  assert.deepEqual(res.body.candidateIds, ["Qwen/Qwen-Image-Edit", "MusePublic/Qwen-Image-Edit"],
    "候选来自目录的出图能力（tasks 标签）");
  assert.equal(res.body.candidateCount, 2);
  assert.equal(res.body.preferredModel, null, "默认自动");
  assert.equal(res.body.toolName, "modelscope_draw_image");
  assert.equal(res.body.mountPending, false, "开关没开时不算 pending");
}

// ── 候选不含普通 chat 与吃图模型 ──
{
  const res = await call(handlers, DRAW_PATH, makeReq("GET"));
  assert.ok(!res.body.candidateIds.includes("Qwen/Qwen3.5-35B-A3B"), "chat 模型不进候选");
  assert.ok(!res.body.candidateIds.includes("Qwen/Qwen2.5-VL-32B"), "吃图模型不等于能出图");
}

// ── POST 开开关 ──
{
  const res = await call(handlers, DRAW_PATH, makeReq("POST", { body: { enabled: true } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.source, "panel", "保存后来源是面板");
  assert.equal(res.body.mountPending, false, "本次挂载未登记缺席 → 不算 pending");
}

// ── 开关持久化到 GET ──
{
  const res = await call(handlers, DRAW_PATH, makeReq("GET"));
  assert.equal(res.body.enabled, true, "GET 应读到保存的值");
}

// ── 缺席原因进快照 ──
{
  setDrawToolNote("no-tools-service");
  try {
    const res = await call(handlers, DRAW_PATH, makeReq("GET"));
    assert.equal(res.body.absentReason, "no-tools-service");
    assert.equal(res.body.mountPending, true, "开关开着且有缺席原因 → 面板要提示重启");
  } finally {
    resetDrawToolNote();
  }
}

// ── POST 保存模型偏好 ──
{
  const res = await call(handlers, DRAW_PATH, makeReq("POST", { body: { modelId: "MusePublic/Qwen-Image-Edit" } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.preferredModel, "MusePublic/Qwen-Image-Edit");
  assert.equal(res.body.preferredSource, "panel");
  assert.equal(res.body.enabled, true, "只改模型不该动开关");
}

// ── modelId: null 清掉偏好（回到自动） ──
{
  const res = await call(handlers, DRAW_PATH, makeReq("POST", { body: { modelId: null } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.preferredModel, null, "null = 清掉偏好，回到自动");
}

// ── 拒绝空 body：不能静默成功 ──
{
  const res = await call(handlers, DRAW_PATH, makeReq("POST", { body: {} }));
  assert.equal(res.status, 400, "空 body 必须被拒，否则界面显示「保存了」而什么都没变");
  assert.equal(res.body.ok, false);
}

// ── 拒绝类型错误：不能当「没给」处理 ──
{
  const wrongEnabled = await call(handlers, DRAW_PATH, makeReq("POST", { body: { enabled: "yes" } }));
  assert.equal(wrongEnabled.status, 400, "enabled 非布尔必须报错");
  const wrongModel = await call(handlers, DRAW_PATH, makeReq("POST", { body: { modelId: 42 } }));
  assert.equal(wrongModel.status, 400, "modelId 非字符串/非 null 必须报错");
}

// ── 拒绝错误方法 ──
{
  const res = await call(handlers, DRAW_PATH, makeReq("DELETE"));
  assert.equal(res.status, 405);
}

// ── reset 回到默认 ──
{
  const res = await call(handlers, `${DRAW_PATH}/reset`, makeReq("POST"));
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false, "reset 回到 patch 默认（false）");
  assert.equal(res.body.source, "config");
  assert.equal(res.body.preferredModel, null);
}

// ── 两条路由互不干扰 ──
{
  await call(handlers, DRAW_PATH, makeReq("POST", { body: { enabled: true } }));
  const providerRes = await call(handlers, PROVIDER_PATH, makeReq("GET"));
  assert.equal(providerRes.body.enabled, false,
    "开出图不该影响 provider 开关——两者是独立的问题");
  await call(handlers, `${DRAW_PATH}/reset`, makeReq("POST"));
}

console.log("draw-routes.test.mjs: all checks passed");
