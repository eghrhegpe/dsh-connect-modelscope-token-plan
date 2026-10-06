// 路由族测试：桩 webServer 捕获 handler，可换装的全局 fetch 顶替上游，
// 全链路走一遍快照/目录/令牌/probe。HTTP 恒 200、失败即数据（ok:false +
// code）的形状在这里钉死。
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/host/index.ts";
import { name, resolveSettings } from "../src/host/host-config.ts";
import { registerProbeRoute } from "../src/host/routes/probe.ts";
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

// ── provider.json 版本不符：读侧宽容，但必须说出来 ──
//
// 写侧的 ADR-006 守卫已经挡住覆盖；读侧是**故意**宽容的（读作「未设置」），
// 免得一份新构建留下的文件把整条快照搞挂。但宽容的代价是：「保存了隐藏清单」
// 与「从未保存过」在读侧长得一模一样，而空清单 = 不过滤 = 提供全部模型——危险
// 方向上更糟的那个答案。所以这一节钉的是「说出来」：警告必须进 shapeWarnings，
// 面板才看得见。
//
// 这段用**第二个插件实例**而不是主 handlers：provider store 有 1s 读缓存，主实例
// 在其它节里已经发过快照，缓存里那份空载荷会把 versionNote 顶成 null。新实例的
// 缓存是冷的，首次读就是磁盘上这份外部版本——顺序无关，也不会给后面的节留一个
// 「关于已删除文件的幽灵警告」（主实例的缓存全程不接触这份 v99）。
// 状态目录（两节共用；每节结束时清空）。
const stateDirPath = join(process.env.DSH_HOME, "state", name);

{
  mkdirSync(stateDirPath, { recursive: true });
  writeFileSync(join(stateDirPath, "provider.json"), JSON.stringify({ version: 99, enabled: true, enabledIds: ["a/A"] }));
  try {
    const isolated = new Map();
    apply(makeCtx(isolated), {});
    const drifted = await call(isolated, SNAPSHOT_PATH, makeReq("GET"));
    assert.equal(drifted.ok, true, "形状漂移不该让整条快照失败");
    assert.ok(
      drifted.shapeWarnings.some((warning) => warning.startsWith("provider-state:")),
      "未知版本的 provider.json 必须进 shapeWarnings（宽容读 ≠ 静默）"
    );
    assert.match(drifted.shapeWarnings.find((warning) => warning.startsWith("provider-state:")) ?? "", /99/, "说明里带上磁盘上的版本号");
    assert.equal(drifted.provider.enabled, false, "宽容读：开关按未设置回落到配置默认");
    assert.equal(drifted.provider.source, "config", "回落来自配置而非面板");
    assert.deepEqual(drifted.provider.enabledIds, [], "宽容读：清单读作空 = 不过滤");
    assert.equal(drifted.provider.allowed, "all", "空清单的口径就是 all");
    // 脱敏红线：说明是拼进 shapeWarnings 的，走聚合层的收口，不能带出令牌形状。
    assert.ok(!drifted.shapeWarnings.join("").includes("ms-"), "shapeWarnings 不带令牌形状");
  } finally {
    rmSync(stateDirPath, { recursive: true, force: true });
  }
}

// ── provider.json 损坏：**不**产生 provider-state 警告（反向也要钉）──
//
// 坏 JSON 被读作空载荷，version 是 null，所以 versionNote 无话可说——面板静默。
// 这与 usage-store 的既有约定一致（面板不因损坏变红），损坏只有 doctor 报得出。
// 把这条静默钉成**设计决定**，免得将来有人当成漏报去「修」。
{
  mkdirSync(stateDirPath, { recursive: true });
  writeFileSync(join(stateDirPath, "provider.json"), "not json{{");
  try {
    const isolated = new Map();
    apply(makeCtx(isolated), {});
    const corrupted = await call(isolated, SNAPSHOT_PATH, makeReq("GET"));
    assert.equal(corrupted.ok, true, "损坏的状态文件不该让快照失败");
    assert.ok(
      !corrupted.shapeWarnings.some((warning) => warning.startsWith("provider-state:")),
      "损坏（非版本不符）→ 无 provider-state 警告；这条静默是刻意的"
    );
    assert.equal(corrupted.provider.enabled, false, "损坏读作未设置，回落配置默认");
    assert.deepEqual(corrupted.provider.enabledIds, [], "损坏读作空清单 = 不过滤");
  } finally {
    rmSync(stateDirPath, { recursive: true, force: true });
  }
}

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

// ── probe：零额度鉴权探针；429 分诊；401 分诊 ──
//
// `kind:"usage"`（真调用、消耗额度、成功即 recordCall）已随「模型目录」试调
// 按钮一并删除——真调用的计数生产者是 usage-observer.ts（见 usage-observer.test.mjs）。
// 本段因此**不再断言任何本地用量增长**：probe 现在一个 token 都不记。
{
  const saved = await call(handlers, TOKEN_PATH, makeReq("POST", { body: { token: "ms-0123456789abcdef0123456789abcdef" } }));
  assert.equal(saved.ok, true);

  let lastBody = null;
  currentFetch = async (url, init) => {
    lastBody = JSON.parse(String(init.body));
    if (lastBody.model === "ok/model") {
      // 真机实测的空壳补全形状：缺 messages 也返回 200。
      return new Response(JSON.stringify({ id: "x", created: 0, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
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
    // modelId 护栏：空串（与纯空白）必须在**发出任何请求之前**被 400 挡回。
    // 这条由变异测试发现是盲区——把护栏改成 if (false) 时全套件仍全绿。
    // 用裸 handler 调用：`call` 硬断言 200，而这里测的正是 400。
    for (const bad of ["", "   "]) {
      let fetched = false;
      currentFetch = async () => { fetched = true; return new Response("{}", { status: 200 }); };
      const res = makeRes();
      await handlers.get(PROBE_PATH)(makeReq("POST", { body: { modelId: bad } }), res);
      assert.equal(res.status, 400, `modelId ${JSON.stringify(bad)} → 400`);
      assert.equal(res.body.ok, false);
      assert.equal(fetched, false, "护栏在发请求之前就挡下了");
    }

    currentFetch = async (url, init) => {
      lastBody = JSON.parse(String(init.body));
      if (lastBody.model === "ok/model") {
        return new Response(JSON.stringify({ id: "x", created: 0, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (lastBody.model === "quota/model") {
        return new Response(JSON.stringify({ error: { message: "daily quota limit reached" } }), { status: 429, headers: { "retry-after": "60" } });
      }
      if (lastBody.model === "bad/model") {
        return new Response(JSON.stringify({ error: { message: "Authentication failed" } }), { status: 401 });
      }
      throw new Error("unexpected probe target");
    };

    const ok = await call(handlers, PROBE_PATH, makeReq("POST", { body: { modelId: "ok/model" } }));
    assert.equal(ok.ok, true, "200 空壳 → 令牌好");
    assert.equal(lastBody.messages, undefined, "鉴权探针故意缺 messages");
    assert.equal(lastBody.max_tokens, undefined, "鉴权探针不请求生成，零额度");
    assert.equal(ok.usage, undefined, "探针不回 usage（真调用的 token 由观察层取）");

    const snap = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
    assert.equal(snap.quota.daily.usedLocal, 0, "probe 成功不计入本地计数");
    assert.equal(snap.quota.perModel.length, 0, "probe 不产生单模型用量");

    // 429 分诊：文案含 quota → quota_exceeded，进事件流。
    const quota = await call(handlers, PROBE_PATH, makeReq("POST", { body: { modelId: "quota/model" } }));
    assert.equal(quota.ok, false);
    assert.equal(quota.code, "quota_exceeded", "429 文案含 quota → 分诊 quota_exceeded");
    assert.equal(quota.retryAfterMs, 60000, "Retry-After 解析");

    const snap2 = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
    assert.equal(snap2.events[0].kind, "quota", "429 入事件流");
    assert.equal(snap2.quota.daily.usedLocal, 0, "429 也不计入用量");

    const auth = await call(handlers, PROBE_PATH, makeReq("POST", { body: { modelId: "bad/model" } }));
    assert.equal(auth.ok, false);
    assert.equal(auth.code, "auth_error", "401 → auth_error");
    const snap3 = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
    assert.ok(snap3.events.some((e) => e.kind === "error"), "401 probe 记 error 事件");

    // 400 是「先鉴权后校验」的校验层拒绝 → 令牌仍然好。
    currentFetch = async () => new Response(JSON.stringify({ error: { message: "messages is required" } }), { status: 400 });
    const validation = await call(handlers, PROBE_PATH, makeReq("POST", { body: { modelId: "ok/model" } }));
    assert.equal(validation.ok, true, "400 → 令牌好（鉴权早于校验）");
    assert.equal(validation.status, 400);

    const snap4 = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
    assert.equal(snap4.quota.daily.usedLocal, 0, "全程零用量");
    assert.equal(snap4.events.filter((e) => e.kind === "error" && e.modelId === "ok/model").length, 0, "令牌好不记事件");
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

// ── probe：探测成功而令牌状态读失败，不得被报成探测失败 ──
//
// `tokenState` 的读取住在**成功分支的 try 里**：它一抛错，控制流就落进 catch，于是
// 一次已经成功的验令牌被回报成 ok:false，还在事件流里写进一条假 error——事件流是
// 面板「额度」tab 的独家数据源，污染它比少一个字段糟得多。这里直接注册 probe 路由
// 造出那次抛错（apply() 挂的是真实 tokenStore，造不出「读状态时抛」）。
{
  const run = async (tokenState) => {
    const events = [];
    let handler = null;
    registerProbeRoute(
      { webServer: { register: ({ path, handler: h }) => { if (path === PROBE_PATH) handler = h; return () => {}; } } },
      {
        settings: resolveSettings({}).settings,
        tokenStore: { state: tokenState },
        usageStore: { recordEvent: async (event) => { events.push(event); } },
        inference: { probe: async () => ({ ok: true, validity: "token-ok" }) },
        logger: { warn: () => {} }
      }
    );
    assert.ok(handler, "probe handler 必须被注册");
    const res = makeRes();
    await handler(makeReq("POST", { body: { modelId: "ok/model" } }), res);
    return { body: res.body, events };
  };

  const readable = await run(async () => ({ present: true, source: "credentials", valid: null, checkedAt: null, ephemeral: false }));
  assert.equal(readable.body.ok, true, "令牌状态可读：成功的探测照实回报");
  assert.equal(readable.events.length, 0, "成功不记事件");

  const unreadable = await run(async () => { throw new Error("credentials service unavailable"); });
  assert.equal(unreadable.body.ok, true, "令牌状态读失败不得把已成功的探测报成失败");
  assert.equal(unreadable.body.tokenState, null, "读不到就回落 null（与失败分支的 .catch 同形）");
  assert.equal(unreadable.events.length, 0, "更不得往事件流写一条假 error");
}

console.log("routes.test.mjs: all checks passed");
