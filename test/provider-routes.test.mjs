// M4 provider 路由测试：开关读/写、允许清单保存、哨兵分类、信任围栏。
// 与 routes.test.mjs 同款桩 ctx（webServer 捕获 handler、内存凭据服务、全局 fetch 顶替上游）。
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/host/index.ts";
import { PROVIDER_PATH } from "../src/host/routes/paths.ts";
import { HIDE_ALL_MODELS } from "../src/host/llm-models.ts";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "ms-provider-routes-"));

const NO_NETWORK = () => Promise.reject(new Error("no network in this test"));
let currentFetch = NO_NETWORK;
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

// 目录桩：两个模型 + 一个 vision + 一个生图。
currentFetch = async () => new Response(JSON.stringify({
  object: "list",
  data: [
    { id: "Qwen/Qwen3.5-35B-A3B" },
    { id: "Qwen/Qwen2.5-VL-32B", input_modalities: ["text", "image"] },
    { id: "wanx/wanx2.1-t2i", output_modalities: ["image"] }
  ]
}), { status: 200, headers: { "content-type": "application/json" } });

const handlers = new Map();
apply(makeCtx(handlers), {});
assert.ok(handlers.has(PROVIDER_PATH), "provider 路由已注册");

// ── 信任围栏 ──
{
  const res = makeRes();
  await handlers.get(PROVIDER_PATH)(makeReq("GET", { host: "evil.example" }), res);
  assert.equal(res.status, 403, "白名单外 Host → 403");
  const res2 = makeRes();
  await handlers.get(PROVIDER_PATH)(makeReq("DELETE", { host: "localhost:3080" }), res2);
  assert.equal(res2.status, 405, "未知方法 → 405");
}

// ── GET：默认关（patch 默认 registerProvider:false），目录降级为 roster ──
{
  const res = await call(handlers, PROVIDER_PATH, makeReq("GET"));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.enabled, false, "默认关");
  assert.equal(res.body.source, "config");
  assert.equal(res.body.allowed, "all", "空清单 = 不过滤");
  assert.equal(res.body.modelCount, 2, "roster 只含可用作 chat 的模型（生图模型剔除）");
  assert.deepEqual(
    res.body.roster.map((r) => r.id).sort(),
    ["Qwen/Qwen2.5-VL-32B", "Qwen/Qwen3.5-35B-A3B"],
    "roster 含 Qwen chat 模型、不含 wanx 生图模型"
  );
  assert.equal(res.body.roster.find((r) => r.id === "Qwen/Qwen2.5-VL-32B").vision, true, "vision 标记进 roster");
  assert.equal(res.body.roster.find((r) => r.id === "Qwen/Qwen2.5-VL-32B").capability, "vision-input", "能力类型进 roster（结构化 input_modalities 命中）");
  assert.equal(res.body.roster.find((r) => r.id === "Qwen/Qwen3.5-35B-A3B").capability, "vision-input", "无模态字段/任务标签时走策展清单兜底（该 id 实测能吃图）");
  assert.equal(res.body.llmAvailable, false, "本机 Host 无 llm 服务");
  assert.equal(res.body.registered, false);
}

// ── POST 开关：面板值优先于配置 ──
{
  const res = await call(handlers, PROVIDER_PATH, makeReq("POST", { body: { enabled: true } }));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.source, "panel", "面板保存值优先");
  // 无 llm 服务 → 注册失败但形状完整
  assert.equal(res.body.llmAvailable, false);
  assert.equal(res.body.registered, false);
  assert.equal(typeof res.body.error, "string");
}

// ── POST roster：允许清单 + 哨兵分类 ──
{
  const res = await call(handlers, PROVIDER_PATH + "/roster", makeReq("POST", { body: { enabledIds: ["Qwen/Qwen3.5-35B-A3B"] } }));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.allowed, "list");
  assert.deepEqual(res.body.enabledIds, ["Qwen/Qwen3.5-35B-A3B"]);

  const none = await call(handlers, PROVIDER_PATH + "/roster", makeReq("POST", { body: { enabledIds: [HIDE_ALL_MODELS] } }));
  assert.equal(none.body.allowed, "none", "哨兵 → 什么都不提供");
  assert.deepEqual(none.body.enabledIds, [HIDE_ALL_MODELS]);
}

// ── POST reset：回到配置默认 ──
{
  const res = await call(handlers, PROVIDER_PATH + "/reset", makeReq("POST", { body: {} }));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.enabled, false, "忘掉面板开关 → 配置默认关");
  assert.equal(res.body.source, "config");
  assert.equal(res.body.allowed, "all", "忘掉清单 → 不过滤");
}

// ── 坏 body：400 ──
// 原先这里写的是 `status === 200 || status === 400`「皆可」——但实现是明确的
// 400（routes/provider.ts:152-155：typeof body.enabled !== "boolean" 一律拒），
// 与 roster 路由的 !Array.isArray(body.enabledIds) 同一口径。放宽等于放弃钉住
// 校验失败路径：谁把 400 改成 200 静默接受错误类型，都不会红。
{
  const res = makeRes();
  await handlers.get(PROVIDER_PATH)(makeReq("POST", { body: { enabled: "not-a-bool" } }), res);
  assert.equal(res.status, 400, `enabled 非布尔必须是 400，实际 ${res.status}`);
  assert.equal(res.body.ok, false, "响应体必须标 ok:false");
  assert.equal(res.headers["cache-control"], "no-store", "错误响应不得被缓存");
}

console.log("provider-routes.test.mjs: all checks passed");
