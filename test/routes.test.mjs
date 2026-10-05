// 路由族测试：桩 webServer 捕获 handler，可换装的全局 fetch 顶替上游，
// 全链路走一遍快照/目录/令牌/probe。HTTP 恒 200、失败即数据（ok:false +
// code）的形状在这里钉死。
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/host/index.ts";
import { name } from "../src/host/host-config.ts";
import { SNAPSHOT_PATH, MODELS_PATH, TOKEN_PATH, TOKEN_FORGET_PATH, PROBE_PATH } from "../src/host/routes/paths.ts";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "ms-routes-"));

// 上游替换缝：默认断网（任何没显式装桩的 fetch 都拒绝），各节再装自己的桩。
const NO_NETWORK = () => Promise.reject(new Error("no network in this test"));
let currentFetch = NO_NETWORK;
globalThis.fetch = (...args) => currentFetch(...args);

// ── 桩：webServer 捕获路由；内存版凭据服务 ──
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

// 桩 request/response。
const makeReq = (method, { host = "localhost:3080", origin = null, body = null } = {}) => {
  const req = { method, headers: { host, ...(origin ? { origin } : {}) } };
  if (body !== null) {
    req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body)); };
  }
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
  assert.equal(res.status, 200, "快照族路由 HTTP 恒 200");
  return res.body;
};

// ── 挂载（无配置 = 全默认）──
const handlers = new Map();
apply(makeCtx(handlers), {});
assert.ok([SNAPSHOT_PATH, MODELS_PATH, TOKEN_PATH, PROBE_PATH].every((p) => handlers.has(p)), "四条路由全部注册");

// ── 信任围栏 ──
{
  const res = makeRes();
  await handlers.get(SNAPSHOT_PATH)(makeReq("GET", { host: "evil.example" }), res);
  assert.equal(res.status, 403, "白名单外 Host → 403");
  const res2 = makeRes();
  await handlers.get(SNAPSHOT_PATH)(makeReq("POST", { host: "localhost:3080" }), res2);
  assert.equal(res2.status, 405, "快照拒绝 POST → 405");
}

// ── 快照：空状态（无令牌、无记录、上游断网目录降级）──
{
  const body = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
  assert.equal(body.ok, true);
  assert.equal(body.name, name);
  assert.equal(body.token.present, false);
  assert.equal(body.token.source, "none");
  assert.deepEqual(body.quota.daily, { usedLocal: 0 }, "quota.daily 只有本地次数：无 limit / remainingComputed");
  assert.equal(body.quota.countingNote, "local-counting");
  assert.deepEqual(body.events, []);
  assert.equal(body.trend.buckets.length, 14, "趋势默认 14 天");
  assert.equal(body.models.available, false, "上游断网时目录降级，不伪装成 0 个模型");
  assert.equal(body.models.error !== null, true);
  assert.equal(body.quotaError, null, "v0.1 无上游余额来源");
}

// ── 令牌：保存 → 快照反映；空白拒绝；忘掉 → 反映 ──
{
  const saved = await call(handlers, TOKEN_PATH, makeReq("POST", { body: { token: "ms-0123456789abcdef0123456789abcdef" } }));
  assert.equal(saved.ok, true);
  assert.equal(saved.present, true);
  assert.equal(saved.source, "credentials");
  const snap = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
  assert.equal(snap.token.source, "credentials");
  assert.equal(snap.token.ephemeral, false, "凭据服务在场");

  // 参数校验失败回真实 400（与 readJsonBodyOr400 同族）；域内失败才回 200+ok:false。
  {
    const res = makeRes();
    await handlers.get(TOKEN_PATH)(makeReq("POST", { body: { token: "   " } }), res);
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false, "空白令牌拒绝");
  }

  const forgotten = await call(handlers, TOKEN_FORGET_PATH, makeReq("POST", { body: {} }));
  assert.equal(forgotten.ok, true);
  assert.equal(forgotten.present, false);
}

// ── 魔粒余额：官方端点走 Bearer 令牌；形状漂移降级 ──
{
  await call(handlers, TOKEN_PATH, makeReq("POST", { body: { token: "ms-0123456789abcdef0123456789abcdef" } }));
  currentFetch = async (url) => {
    if (String(url).endsWith("/openapi/v1/magicubes/balance")) {
      return new Response(JSON.stringify({ success: true, request_id: "x", data: { total_balance: 143, available_balance: 143, frozen_amount: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected fetch target: " + String(url));
  };
  try {
    const snap = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
    assert.equal(snap.balance.available, 143, "官方余额进快照");
    assert.equal(snap.balance.frozen, 0);
    assert.equal(snap.balance.error, null);
  } finally {
    currentFetch = NO_NETWORK;
  }

  // 形状漂移：独立实例（成功余额在 cacheSeconds TTL 内回缓存，这是对的
  // 缓存行为，漂移测试不能跟它共实例）。
  {
    const local = new Map();
    apply(makeCtx(local), {});
    await call(local, TOKEN_PATH, makeReq("POST", { body: { token: "ms-0123456789abcdef0123456789abcdef" } }));
    currentFetch = async () => new Response(JSON.stringify({ success: true, data: "nope" }), { status: 200 });
    try {
      const drifted = await call(local, SNAPSHOT_PATH, makeReq("GET"));
      assert.equal(drifted.balance.available, null, "余额形状漂移 → available null");
      assert.match(String(drifted.balance.error), /shape drifted/);
      assert.ok(drifted.shapeWarnings.some((w) => w.startsWith("balance:")), "余额漂移进 shapeWarnings");
    } finally {
      currentFetch = NO_NETWORK;
    }
  }

  // 无令牌时余额静默缺席（error null），不冒充故障。
  {
    await call(handlers, TOKEN_FORGET_PATH, makeReq("POST", { body: {} }));
    const anon = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
    assert.equal(anon.balance.available, null);
    assert.equal(anon.balance.error, null, "无令牌 → 余额静默缺席");
  }
}

// ── probe：usage 成功记账；429 分诊；401 分诊 ──
{
  const saved = await call(handlers, TOKEN_PATH, makeReq("POST", { body: { token: "ms-0123456789abcdef0123456789abcdef" } }));
  assert.equal(saved.ok, true);

  let lastBody = null;
  currentFetch = async (url, init) => {
    lastBody = JSON.parse(String(init.body));
    if (lastBody.model === "ok/model") {
      return new Response(JSON.stringify({ id: "x", usage: { prompt_tokens: 30, completion_tokens: 1, total_tokens: 31 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (lastBody.model === "quota/model") {
      return new Response(JSON.stringify({ error: { message: "daily quota limit reached" } }), { status: 429, headers: { "retry-after": "60" } });
    }
    if (lastBody.model === "bad/model") {
      return new Response(JSON.stringify({ error: { message: "Authentication failed" } }), { status: 401 });
    }
    throw new Error("unexpected probe target");
  };
  try {
    const ok = await call(handlers, PROBE_PATH, makeReq("POST", { body: { modelId: "ok/model", kind: "usage" } }));
    assert.equal(ok.ok, true);
    assert.equal(ok.usage.totalTokens, 31);
    assert.equal(lastBody.max_tokens, 1, "usage probe 只花 1 个 token");

    const snap = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
    assert.equal(snap.quota.daily.usedLocal, 1, "probe 成功计入本地计数");
    assert.equal(snap.quota.perModel[0].modelId, "ok/model");

    const quota = await call(handlers, PROBE_PATH, makeReq("POST", { body: { modelId: "quota/model", kind: "usage" } }));
    assert.equal(quota.ok, false);
    assert.equal(quota.code, "quota_exceeded", "429 文案含 quota → 分诊 quota_exceeded");
    assert.equal(quota.retryAfterMs, 60000, "Retry-After 解析");

    const snap2 = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
    assert.equal(snap2.events[0].kind, "quota", "429 入事件流");
    assert.equal(snap2.quota.daily.usedLocal, 1, "429 的调用不计入成功计数");

    const auth = await call(handlers, PROBE_PATH, makeReq("POST", { body: { modelId: "bad/model", kind: "validity" } }));
    assert.equal(auth.ok, false);
    assert.equal(auth.code, "auth_error", "401 → auth_error");
    const snap3 = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
    assert.ok(snap3.events.some((e) => e.kind === "error"), "401 probe 记 error 事件");

    // validity 的 200 是「令牌好」（真机实测：缺 messages 返回 200 空壳），
    // 不计用量、不记事件。
    const validityOk = await call(handlers, PROBE_PATH, makeReq("POST", { body: { modelId: "ok/model", kind: "validity" } }));
    assert.equal(validityOk.ok, true, "validity 200 → 令牌好");
    assert.equal(validityOk.usage, null);
    const snap4 = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
    assert.equal(snap4.quota.daily.usedLocal, 1, "validity 不计入本地用量");
    assert.equal(snap4.events.filter((e) => e.kind === "error" && e.modelId === "ok/model").length, 0, "validity 成功不记事件");
  } finally {
    currentFetch = NO_NETWORK;
  }
}

// ── 模型目录：独立实例（避开 60s 目录缓存）；先漂移后正常 ──
{
  const local = new Map();
  apply(makeCtx(local), {});
  currentFetch = async () => new Response(JSON.stringify({ object: "weird", data: "nope" }), { status: 200 });
  const drifted = await call(local, MODELS_PATH, makeReq("GET"));
  assert.equal(drifted.ok, false, "目录形状漂移 → ok:false");
  assert.equal(drifted.code, "upstream_error");

  currentFetch = async () => new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-ai/DeepSeek-V4-Flash-0731" }, { id: "Qwen/Qwen3-Coder" }] }), { status: 200, headers: { "content-type": "application/json" } });
  const catalog = await call(local, MODELS_PATH, makeReq("GET"));
  assert.equal(catalog.ok, true, "被拒的飞行不缓存，下一个请求重新起飞");
  assert.equal(catalog.count, 2);
  assert.equal(catalog.models[0].id, "deepseek-ai/DeepSeek-V4-Flash-0731");
  currentFetch = NO_NETWORK;
}

// ── configError 短路：非法端点 → ok:false + config_error ──
{
  const broken = new Map();
  apply(makeCtx(broken), { apiBase: "not a url" }, {});
  const res = makeRes();
  await broken.get(SNAPSHOT_PATH)(makeReq("GET"), res);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, "config_error", "apiBase 非法 → 挂载期 configError → 快照短路");
  // 失败线格式的钉子（wire.ts SnapshotFailure）：字段是 error 不是 message，
  // client 的 interpretSnapshot 读的就是它。
  assert.deepEqual(Object.keys(res.body).sort(), ["code", "error", "ok"], "SnapshotFailure 线格式 = {ok, code, error}");
}

// ── 卸载：effect 返回的清理函数真的摘路由 ──
{
  const local = new Map();
  let cleanup = null;
  apply({
    get: () => undefined,
    logger: { warn: () => {} },
    effect: (fn) => { cleanup = fn; },
    webServer: { register: ({ path, handler }) => { local.set(path, handler); return () => local.delete(path); } }
  }, {}, {});
  assert.ok(local.size > 0);
  // Cordis 语义：effect 的 fn 是 setup，其**返回值**才是 dispose。
  const dispose = cleanup();
  assert.equal(typeof dispose, "function", "effect 的 setup 必须返回清理函数");
  dispose();
  assert.equal(local.size, 0, "teardown 摘掉全部路由");
}

console.log("routes.test.mjs: all checks passed");
