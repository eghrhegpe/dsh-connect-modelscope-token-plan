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
apply(makeCtx(handlers), {}, { env: {} });
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

// ── POST context：全局上下文窗口覆盖 ──
// 打在两层：快照顶层字段（面板选择器回显）与 roster 行（每行 badge）。桩条目
// 没声明窗口，真值链 = 目录声明 > 用户覆盖 > 策展表 > 兜底：Qwen3.5-35B-A3B
// 在策展表（262144，curated），Qwen2.5-VL-32B 不在（128000 兜底，catalog）；
// 写覆盖后两行都被覆盖值接管（override 压过策展）。
{
  const before = await call(handlers, PROVIDER_PATH, makeReq("GET"));
  assert.equal(before.body.contextWindow, null, "未设置时快照读 null");
  const beforeCurated = before.body.roster.find((r) => r.id === "Qwen/Qwen3.5-35B-A3B");
  const beforeFallback = before.body.roster.find((r) => r.id === "Qwen/Qwen2.5-VL-32B");
  assert.equal(beforeCurated.contextWindow, 262144, "策展表命中的行=表值，不是 128000");
  assert.equal(beforeCurated.contextSource, "curated", "来源标记 curated");
  assert.equal(beforeFallback.contextWindow, 128000, "不在表 → 目录兜底 128000");
  assert.equal(beforeFallback.contextSource, "catalog", "来源标记 catalog");

  const saved = await call(handlers, PROVIDER_PATH + "/context", makeReq("POST", { body: { contextWindow: 262144 } }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.contextWindow, 262144, "保存后快照回显覆盖值");
  assert.ok(
    saved.body.roster.every((r) => r.contextWindow === 262144),
    "覆盖值打进每条 roster 行（descriptor 同源）"
  );
  assert.ok(
    saved.body.roster.every((r) => r.contextSource === "override"),
    "覆盖接管后来源标记 override（压过策展）"
  );

  // 目录声明窗口的条目不受覆盖影响：桩里换一条带 context_length 的模型再存
  // 另一个档位——目录缓存按覆盖值分键（models:<override>），同键会命中旧桩
  // 的缓存体，换档位 = 换缓存键 = 强制真拉新桩。
  currentFetch = async () => new Response(JSON.stringify({
    object: "list",
    data: [
      { id: "Qwen/Qwen3.5-35B-A3B" },
      { id: "Declared/Big-Window", context_length: 1000000 }
    ]
  }), { status: 200, headers: { "content-type": "application/json" } });
  const mixed = await call(handlers, PROVIDER_PATH + "/context", makeReq("POST", { body: { contextWindow: 524288 } }));
  assert.equal(mixed.body.contextWindow, 524288);
  assert.equal(mixed.body.roster.find((r) => r.id === "Declared/Big-Window").contextWindow, 1000000, "目录已声明的窗口不被覆盖");
  assert.equal(mixed.body.roster.find((r) => r.id === "Qwen/Qwen3.5-35B-A3B").contextWindow, 524288, "未声明的走覆盖");

  // 清除：null 回跟随目录（顶层 null、行回真值链底：策展命中=表值，否则兜底）。
  currentFetch = async () => new Response(JSON.stringify({
    object: "list",
    data: [{ id: "Qwen/Qwen3.5-35B-A3B" }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  const cleared = await call(handlers, PROVIDER_PATH + "/context", makeReq("POST", { body: { contextWindow: null } }));
  assert.equal(cleared.body.contextWindow, null, "null 清除覆盖");
  assert.equal(cleared.body.roster[0].contextWindow, 262144, "清除后策展命中的行回表值（不是 128000）");
  assert.equal(cleared.body.roster[0].contextSource, "curated");

  // reset 连覆盖一起忘（forget 的三键语义）。
  await call(handlers, PROVIDER_PATH + "/context", makeReq("POST", { body: { contextWindow: 131072 } }));
  const reset = await call(handlers, PROVIDER_PATH + "/reset", makeReq("POST", { body: {} }));
  assert.equal(reset.body.contextWindow, null, "reset 忘掉覆盖");

  // 坏 body：400（缺字段 / 非数字 / 非正数）——与 roster 同一口径，不静默当重置。
  for (const bad of [{}, { contextWindow: "262144" }, { contextWindow: 0 }, { contextWindow: -1 }]) {
    const res = makeRes();
    await handlers.get(PROVIDER_PATH + "/context")(makeReq("POST", { body: bad }), res);
    assert.equal(res.status, 400, `非法 body ${JSON.stringify(bad)} 必须 400，实际 ${res.status}`);
    assert.equal(res.body.ok, false, "400 响应体标 ok:false");
  }
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

// ── 端到端：保存开关 → 收敛 → registerAdapter 真的落地 ──
//
// 上面各节的 `registered:false` 有一个盲区：没有 llm 服务时，reconcile 哪怕
// 整个变 no-op，断言也全绿。本节把两条缝都接上（ctx 提供 llm 服务、deps 提供
// 适配器工厂缝），钉住收编后的完整链路：路由保存 → 标记 dirty → 收敛 →
// publisher 注册进 Host。这是「双驱动收编」在路由层的验收。
{
  const adapters = new Map();
  const llmService = {
    registerAdapter(providerIds, adapter) {
      for (const p of providerIds) adapters.set(p, adapter);
      return () => { for (const p of providerIds) adapters.delete(p); };
    }
  };
  const handlers2 = new Map();
  apply({
    get: (service) => (service === "llm" ? llmService : service === "credentials" ? credentialsService : undefined),
    logger: { warn: () => {} },
    effect: () => {},
    webServer: {
      register({ path, handler }) { handlers2.set(path, handler); return () => handlers2.delete(path); }
    }
  }, {}, {
    env: {},
    loadAdapterModule: async () => ({
      createModelScopeAdapter: async () => ({ adapter: { tag: "e2e" }, providerIds: ["modelscope-token-plan"] })
    })
  });
  currentFetch = async () => new Response(JSON.stringify({
    object: "list",
    data: [{ id: "Qwen/Qwen3.5-35B-A3B" }]
  }), { status: 200, headers: { "content-type": "application/json" } });

  const res = await call(handlers2, PROVIDER_PATH, makeReq("POST", { body: { enabled: true } }));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.enabled, true, "面板保存值优先");
  assert.equal(res.body.registered, true, "保存开关 → 收敛 → registerAdapter 必须真的落地（reconcile 变 no-op 这里就红）");
  assert.ok(adapters.has("modelscope-token-plan"), "假 Host 的注册表里必须出现适配器");

  // 关回去：收敛同样要真的摘掉。
  const off = await call(handlers2, PROVIDER_PATH, makeReq("POST", { body: { enabled: false } }));
  assert.equal(off.body.registered, false, "关开关 → 收敛 → 注销");
  assert.equal(adapters.has("modelscope-token-plan"), false, "假 Host 的注册表必须摘干净");
}

console.log("provider-routes.test.mjs: all checks passed");
