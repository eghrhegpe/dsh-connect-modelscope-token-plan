// 路由族测试：桩 webServer 捕获 handler，可换装的全局 fetch 顶替上游，
// 全链路走一遍快照/目录/令牌/probe。HTTP 恒 200、失败即数据（ok:false +
// code）的形状在这里钉死。
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/host/index.ts";
import { buildSnapshotBody } from "../src/host/snapshot-aggregate.ts";
import { name, resolveSettings } from "../src/host/host-config.ts";
import { registerProbeRoute } from "../src/host/routes/probe.ts";
import { CODE } from "../src/host/codes.ts";
import { setDrawToolNote, setDrawToolMounted, resetDrawToolNote } from "../src/host/draw-tool-state.ts";
import { SNAPSHOT_PATH, MODELS_PATH, TOKEN_PATH, TOKEN_FORGET_PATH, PROBE_PATH, PROVIDER_PATH, DRAW_PATH, DRAW_RESET_PATH, TREND_WINDOW_PATH } from "../src/host/routes/paths.ts";

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
apply(makeCtx(handlers), {}, { env: {} });
assert.ok([SNAPSHOT_PATH, MODELS_PATH, TOKEN_PATH, PROBE_PATH].every((p) => handlers.has(p)), "四条路由全部注册");

// ── 信任围栏必须是**结构事实**，不是「每个路由族记得手写一条 403 用例」──
//
// 围栏的机制是 `withOrigin` 逐个包在 handler 外层，而「每个路由都包了」这件事此前
// 只由三处**手写**的 403 用例间接守着（snapshot / draw / provider 各一条）。缺口
// 形态很具体：加一个路由（或一整族路由）时，忘了包 `withOrigin` **且**忘了补那条
// 403 用例，就静默漏——而「把『记得登记』变成结构事实」正是本仓库的既有纪律
// （test/run-all.mjs 的文件头把「每个套件都被跑到」从自觉登记改成 glob 事实）。
//
// 所以这里改成**枚举**：把 `apply()` 捕获到的每一个路径都拿恶意 Host / 跨站 Origin
// 打一遍，全部必须 403。将来新增路由只要忘了包围栏，这条自动变红，不需要谁记得。
{
  const fenced = new Map();
  apply(makeCtx(fenced), {}, { env: {} });
  const registered = [...fenced.keys()].sort();
  // 清单按**各自实际形态**归类，不要为了让分类整齐去改生产代码的形状（与
  // panel.test.mjs 的 LITERAL_SUFFIXES / DERIVED_SUFFIXES 同一条注记）：
  // `/draw/reset` 是 paths.ts 里的字面量，`/provider/*` 是 provider.ts 用
  // `${PROVIDER_PATH}/…` 拼的派生路由。
  const expected = [
    SNAPSHOT_PATH, MODELS_PATH, TOKEN_PATH, TOKEN_FORGET_PATH, PROBE_PATH,
    PROVIDER_PATH, `${PROVIDER_PATH}/roster`, `${PROVIDER_PATH}/reset`, `${PROVIDER_PATH}/context`,
    DRAW_PATH, DRAW_RESET_PATH, TREND_WINDOW_PATH
  ].sort();
  assert.deepEqual(
    registered,
    expected,
    "注册的路由集合变了——新路由必须过 withOrigin 围栏，并把它的路径加进本断言\n" +
    "        （否则它不受这条枚举门禁保护：忘了包围栏也不会有人发现）"
  );
  for (const path of registered) {
    const handler = fenced.get(path);
    const badHost = makeRes();
    await handler(makeReq("GET", { host: "evil.example" }), badHost);
    assert.equal(badHost.status, 403, `${path}：白名单外 Host 必须 403（围栏漏了？）`);
    assert.equal(badHost.body?.ok, false, `${path}：403 要带面板认的失败形状`);

    const crossSite = makeRes();
    await handler(makeReq("GET", { host: "localhost:3080", origin: "https://evil.example" }), crossSite);
    assert.equal(crossSite.status, 403, `${path}：跨站 Origin 必须 403（围栏漏了？）`);

    // 围栏在最外层：被拒的请求**在方法闸之前**就返回，所以恶意请求既不会读 body、
    // 也不会因为方法不对而被误报成 405。这条同时钉住「围栏不是第二道死守卫」。
    const methodOnHostile = makeRes();
    await handler(makeReq("POST", { host: "evil.example" }), methodOnHostile);
    assert.equal(methodOnHostile.status, 403, `${path}：围栏必须先于方法闸（恶意请求不得拿到 405 这种「路由存在」的信息）`);
  }
}

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
    apply(makeCtx(isolated), {}, { env: {} });
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
    apply(makeCtx(isolated), {}, { env: {} });
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
  // 没有 usage.json（这台 Host 从未经本插件调用过）= 空趋势数组，**不是** 14 根零柱。
  // 桶的形状来自 store 的三态（读不到 ≠ 0，红线 3）：文件不在 = 从未记录过 =
  // 已知的零；文件在却读不出 = null（面板画「—」）。两种零在面板上必须分开。
  assert.deepEqual(body.trend.buckets, [], "无本地记录 = 空趋势（不是 14 根零柱）");
  assert.equal(body.trend.days, 14, "趋势默认 14 天");
  assert.equal(body.trend.maxDays, 90, "保留窗口默认 90 天（显示被夹在它之内）");
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
    apply(makeCtx(local), {}, { env: {} });
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
  apply(makeCtx(local), {}, { env: {} });
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
  apply(makeCtx(broken), { apiBase: "not a url" }, { env: {} });
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
  }, {}, { env: {} });
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
  const run = async (tokenState, probe = async () => ({ ok: true, validity: "token-ok" })) => {
    const events = [];
    const validityNotes = [];
    let handler = null;
    registerProbeRoute(
      { webServer: { register: ({ path, handler: h }) => { if (path === PROBE_PATH) handler = h; return () => {}; } } },
      {
        settings: resolveSettings({}).settings,
        tokenStore: { state: tokenState, noteValidity: (valid) => { validityNotes.push(valid); } },
        usageStore: { recordEvent: async (event) => { events.push(event); } },
        inference: { probe },
        logger: { warn: () => {} }
      }
    );
    assert.ok(handler, "probe handler 必须被注册");
    const res = makeRes();
    await handler(makeReq("POST", { body: { modelId: "ok/model" } }), res);
    return { body: res.body, events, validityNotes };
  };

  const readable = await run(async () => ({ present: true, source: "credentials", valid: null, checkedAt: null, ephemeral: false }));
  assert.equal(readable.body.ok, true, "令牌状态可读：成功的探测照实回报");
  assert.equal(readable.events.length, 0, "成功不记事件");
  assert.deepEqual(readable.validityNotes, [true], "成功 → 记「令牌好」（200/400 都算鉴权过了）");

  const unreadable = await run(async () => { throw new Error("credentials service unavailable"); });
  assert.equal(unreadable.body.ok, true, "令牌状态读失败不得把已成功的探测报成失败");
  assert.equal(unreadable.body.tokenState, null, "读不到就回落 null（与失败分支的 .catch 同形）");
  assert.equal(unreadable.events.length, 0, "更不得往事件流写一条假 error");
}

// ── probe 的失败**不等于**令牌坏：只有 401/403 才写 valid:false ──
//
// `token.valid` 的三态里，false 是「探过且令牌坏」的**证据**，不是「这次请求没成」。
// 429 / 额度耗尽 / 上游错误回答的是「上游现在忙不忙」——把它们记成 false，就是把限频
// 说成令牌坏，正是 429 分诊那条修正（把 rpm 误判成额度耗尽）的同一个误判换了个地方。
// 这三种不动结论：上一次的结果仍然是已知的最好答案。
{
  const tokenState = async () => ({ present: true, source: "credentials", valid: true, checkedAt: "2026-10-16T00:00:00.000Z", ephemeral: false });
  const failing = (code) => async () => {
    const error = new Error("upstream said no");
    error.code = code;
    throw error;
  };
  const run = async (probe) => {
    const validityNotes = [];
    let handler = null;
    registerProbeRoute(
      { webServer: { register: ({ path, handler: h }) => { if (path === PROBE_PATH) handler = h; return () => {}; } } },
      {
        settings: resolveSettings({}).settings,
        tokenStore: { state: tokenState, noteValidity: (valid) => { validityNotes.push(valid); } },
        usageStore: { recordEvent: async () => {} },
        inference: { probe },
        logger: { warn: () => {} }
      }
    );
    await handler(makeReq("POST", { body: { modelId: "ok/model" } }), makeRes());
    return validityNotes;
  };

  assert.deepEqual(await run(failing(CODE.AUTH_ERROR)), [false], "401/403 → 记「令牌坏」");

  for (const [code, label] of [[CODE.RATE_LIMITED, "429 限频"], [CODE.QUOTA_EXCEEDED, "429 额度耗尽"], [CODE.UPSTREAM_ERROR, "上游 5xx"]]) {
    assert.deepEqual(await run(failing(code)), [], `${label} 不是令牌的证据 → 不动 valid（留着上一次的结论）`);
  }
}

// ── 端到端：探针的结论必须一路到快照 ──
//
// 上面两节用的是**桩** tokenStore，证明路由写了什么；这一节用**真实挂载的插件**
// 证明整条链是通的（noteValidity → state() → snapshot-aggregate 的 spread →
// 快照响应），并且令牌换手后旧结论失效。此前 `valid` / `checkedAt` 在 Host 侧是
// 硬编码 null，这条链的下游（client 的 validity.yes、i18n 键）早已建好却从未被喂过。
{
  await call(handlers, TOKEN_PATH, makeReq("POST", { body: { token: "ms-0123456789abcdef0123456789abcdef" } }));
  const before = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
  assert.equal(before.token.valid, null, "探之前：未校验（不是「无效」）");

  currentFetch = async () => ({ status: 200, body: null, headers: new Map() });
  const good = await call(handlers, PROBE_PATH, makeReq("POST", { body: { modelId: "ok/model" } }));
  assert.equal(good.ok, true);
  const afterGood = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
  assert.equal(afterGood.token.valid, true, "HTTP 200 → 快照说令牌好");
  assert.equal(typeof afterGood.token.checkedAt, "string", "并且带上了时间戳");

  currentFetch = async () => ({ status: 401, body: null, json: async () => ({ error: { message: "token rejected" } }), headers: new Map() });
  await call(handlers, PROBE_PATH, makeReq("POST", { body: { modelId: "ok/model" } }));
  const afterBad = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
  assert.equal(afterBad.token.valid, false, "HTTP 401 → 快照说令牌坏（不是回到「未校验」）");

  // 换令牌：旧结论立刻失效，不许一个关于**别的值**的判断继续替新令牌说话。
  await call(handlers, TOKEN_PATH, makeReq("POST", { body: { token: "ms-ffffffffffffffffffffffffffffffff" } }));
  const afterSwap = await call(handlers, SNAPSHOT_PATH, makeReq("GET"));
  assert.equal(afterSwap.token.valid, null, "换令牌 → 回到「未校验」");
  await call(handlers, TOKEN_FORGET_PATH, makeReq("POST", { body: {} }));
  currentFetch = NO_NETWORK;
}

// ── 聚合层不得伪造值：读不到就说读不到 ──
//
// token 状态读失败曾被伪造成 `{present:false, source:"none"}`，还顺手把余额错误压成
// null；天桶读失败被渲染成真实的「今日 0 次」。两者都违反 wire.ts 的 null≠0 基线：
// 0 与「没有令牌」都是**可信的日常值**，把「读不到」画成它们，操作者会据此做错判断
// （以为今天没调用过 / 以为自己没配令牌）。这里直接驱动聚合器，用会拒绝的桩造出那两
// 条失败路径（挂载的真实 store 造不出「读的时候抛」）。
{
  const body = await buildSnapshotBody({
    settings: resolveSettings({}).settings,
    tokenStore: { state: async () => { throw new Error("credentials service unavailable"); } },
    usageStore: {
      daily: async () => { throw new Error("usage.json unreadable"); },
      perModelToday: async () => [],
      trend: async () => [],
      events: async () => [],
      anomaly: () => null
    },
    inference: {
      fetchModels: async () => ({ ids: [], entries: [] }),
      fetchBalance: async () => { throw new Error("balance endpoint refused"); }
    },
    providerStore: { enabled: async () => null, enabledIds: async () => [], contextWindow: async () => null, versionNote: async () => null },
    // draw.json 的 versionNote 也必须进 shapeWarnings（2026-10-17 补的读侧另一半：
    // 未知版本宽容读作「没设过」，不说出口就是「从未保存过」，而回退方向是
    // patch 默认——通常=关）。
    drawStore: {
      enabled: async () => null,
      modelId: async () => null,
      versionNote: async () => "draw-state: draw.json holds version 99, which this build cannot read"
    },
    // usage-prefs.json 的 versionNote 同理（同一半纪律的第三个消费者）。
    usagePrefsStore: {
      windowDays: async () => null,
      versionNote: async () => "usage-prefs-state: usage-prefs.json holds version 99, which this build cannot read"
    },
    publisher: { state: { enabledIds: [], llmAvailable: false, registered: false, error: null } },
    logger: { warn: () => {} }
  });

  assert.equal(body.quota.daily.usedLocal, null, "本地计数读不到 → null，绝不是 0");
  assert.equal(body.token.present, false, "形状保持可渲染");
  assert.equal(typeof body.token.readError, "string", "令牌状态读失败必须显式说明，而不是静默 present:false");
  assert.notEqual(body.balance.error, null, "令牌状态读不到时不得把余额错误压成 null（我们并不知道有没有令牌）");
  assert.ok(body.shapeWarnings.some((w) => w.startsWith("token source failed")), "警告按来源标注（token 不是「用量源」）");
  assert.ok(body.shapeWarnings.some((w) => w.startsWith("daily source failed")), "警告按来源标注");
  assert.ok(
    body.shapeWarnings.some((w) => w.startsWith("draw-state:")),
    "draw.json 的版本说明必须进 shapeWarnings（provider 的那半同一条纪律）"
  );
  assert.ok(
    body.shapeWarnings.some((w) => w.startsWith("usage-prefs-state:")),
    "usage-prefs.json 的版本说明必须进 shapeWarnings（与 provider / draw 同一条纪律）"
  );
}

// ── 趋势读不到：trend 抛错 → `buckets` 必须是 null，不是 [] ──
//
// 红线 3 在聚合层的落点。`trend.ok ? trend.value : []` 是本轮修掉的那半条：soft()
// 失败时画成空数组，面板就会说「还没有本地调用记录」——对一份坏 usage.json 下事实
// 断言。这里用会拒绝的桩造出该路径（挂载的真实 store 造不出「读的时候抛」），并
// 顺手钉住三件事：null 透传、警告按来源标注、以及「store 自己说 null」与「抛错」
// 两条路汇聚到同一个 wire 值。
{
  const base = {
    settings: resolveSettings({}).settings,
    tokenStore: { state: async () => ({ present: false, source: "none", valid: null, checkedAt: null, ephemeral: true }) },
    inference: {
      fetchModels: async () => ({ ids: [], entries: [] }),
      fetchBalance: async () => { throw new Error("balance endpoint refused"); }
    },
    providerStore: { enabled: async () => null, enabledIds: async () => [], contextWindow: async () => null, versionNote: async () => null },
    drawStore: { enabled: async () => null, modelId: async () => null, versionNote: async () => null },
    usagePrefsStore: { windowDays: async () => null, versionNote: async () => null },
    publisher: { state: { enabledIds: [], llmAvailable: false, registered: false, error: null } },
    logger: { warn: () => {} }
  };
  const common = {
    daily: async () => ({ calls: 0 }),
    perModelToday: async () => [],
    events: async () => [],
    anomaly: () => null
  };

  const threw = await buildSnapshotBody({ ...base, usageStore: { ...common, trend: async () => { throw new Error("usage.json unreadable"); } } });
  assert.equal(threw.trend.buckets, null, "trend 抛错 → buckets 为 null（读不到 ≠ 0 条记录）");
  assert.ok(
    threw.shapeWarnings.some((w) => w.startsWith("trend source failed")),
    "趋势失败必须进 shapeWarnings（否则面板只说「—」，没人知道是上游还是自己没调用过）"
  );

  // store 自己的第二态（文件在、读不出 → null）走的是另一条代码路径（trend.ok === true，
  // value === null），两条路必须在 wire 上汇合成同一个值。
  const storedNull = await buildSnapshotBody({ ...base, usageStore: { ...common, trend: async () => null } });
  assert.equal(storedNull.trend.buckets, null, "store 返回 null（文件在、读不出）→ 原样透传 null");

  // 对照：真实空数组不得被升级成 null（否则「确实一次都没有」这个可信日常值也会消失）。
  const trulyEmpty = await buildSnapshotBody({ ...base, usageStore: { ...common, trend: async () => [] } });
  assert.deepEqual(trulyEmpty.trend.buckets, [], "store 返回 []（读到了、确实没有）→ 原样透传空数组");
}

// ── 单模型排行 / 事件流读不到：透传 null，不是空数组 ──
//
// 2026-10-18 补的最后一块拼图（§6d 的聚合层姊妹篇）：trend 有专属断言，perModel /
// events 却没有——`perModel.ok ? perModel.value : []` 曾把「读不到」画成空排行，
// 同一份坏文件在今日头条画「—」、在排行画「还没有本地调用记录。」。这里钉死三条
// 路（抛错 / store 自报 null / 真实空数组）汇聚到同一个 wire 值，与 trend 逐字对齐。
{
  const base = {
    settings: resolveSettings({}).settings,
    tokenStore: { state: async () => ({ present: false, source: "none", valid: null, checkedAt: null, ephemeral: true }) },
    inference: {
      fetchModels: async () => ({ ids: [], entries: [] }),
      fetchBalance: async () => { throw new Error("balance endpoint refused"); }
    },
    providerStore: { enabled: async () => null, enabledIds: async () => [], contextWindow: async () => null, versionNote: async () => null },
    drawStore: { enabled: async () => null, modelId: async () => null, versionNote: async () => null },
    usagePrefsStore: { windowDays: async () => null, versionNote: async () => null },
    publisher: { state: { enabledIds: [], llmAvailable: false, registered: false, error: null } },
    logger: { warn: () => {} }
  };
  const common = {
    daily: async () => ({ calls: 0 }),
    trend: async () => [],
    anomaly: () => null
  };

  const threw = await buildSnapshotBody({
    ...base,
    usageStore: { ...common, perModelToday: async () => { throw new Error("usage.json unreadable"); }, events: async () => { throw new Error("usage.json unreadable"); } }
  });
  assert.equal(threw.quota.perModel, null, "perModelToday 抛错 → perModel 为 null（读不到 ≠ 空排行）");
  assert.equal(threw.events, null, "events 抛错 → events 为 null（读不到 ≠ 「暂无事件」）");

  // store 自己的第二态（文件在、读不出 → null）走的是另一条代码路径（ok === true，
  // value === null），两条路必须在 wire 上汇合成同一个值。
  const storedNull = await buildSnapshotBody({ ...base, usageStore: { ...common, perModelToday: async () => null, events: async () => null } });
  assert.equal(storedNull.quota.perModel, null, "store 返回 null（文件在、读不出）→ 原样透传 null");
  assert.equal(storedNull.events, null, "store 返回 null（文件在、读不出）→ 原样透传 null");

  // 对照：真实空数组不得被升级成 null（否则「确实没有」这个可信日常值也会消失）。
  const trulyEmpty = await buildSnapshotBody({ ...base, usageStore: { ...common, perModelToday: async () => [], events: async () => [] } });
  assert.deepEqual(trulyEmpty.quota.perModel, [], "store 返回 []（读到了、确实没有）→ 原样透传空数组");
  assert.deepEqual(trulyEmpty.events, [], "store 返回 []（读到了、确实没有）→ 原样透传空数组");
}

// ── provider 块聚合失败：**省略**整个块，不塞填满默认值的「降级块」 ──
//
// 旧实现失败时塞 `{ enabled:false, allowed:"all", roster:[], … }`。那个形状**看起来
// 就是一个答案**：客户端据此认为「块在」，于是不再走 `GET /provider` 的兜底，只能
// 拿编出来的值渲染——而真相是「读不到」。省略让兜底真的跑起来（与 draw 块同一条
// 纪律），降级形状因此只剩客户端那一份（`DEGRADED_PROVIDER`）。
//
// 省掉的块不能把原因一起带走：原因进 shapeWarnings，否则操作者只看到「未接入」，
// 而真相是「Host 读不到自己的状态」。
{
  const body = await buildSnapshotBody({
    settings: resolveSettings({}).settings,
    tokenStore: { state: async () => ({ present: false, source: "none", valid: null, checkedAt: null, ephemeral: true }) },
    usageStore: {
      daily: async () => ({ calls: 0 }),
      perModelToday: async () => [],
      trend: async () => [],
      events: async () => [],
      anomaly: () => null
    },
    inference: {
      fetchModels: async () => ({ ids: [], entries: [] }),
      fetchBalance: async () => { throw new Error("balance endpoint refused"); }
    },
    providerStore: { enabled: async () => null, enabledIds: async () => [], contextWindow: async () => null, versionNote: async () => null },
    drawStore: { enabled: async () => null, modelId: async () => null, versionNote: async () => null },
    usagePrefsStore: { windowDays: async () => null, versionNote: async () => null },
    // provider 块里唯一会真抛的一路：publisher 状态读不到。
    publisher: { get state() { throw new Error("publisher state unavailable"); } },
    logger: { warn: () => {} }
  });
  assert.equal(
    "provider" in body,
    false,
    "provider 块读不到时必须省略——塞降级块会让客户端跳过 /provider 兜底，只能拿编出来的值渲染"
  );
  assert.ok(
    body.shapeWarnings.some((w) => w.startsWith("provider source failed")),
    "省略不等于把原因也带走：操作者要能区分「未接入」与「Host 读不到自己的状态」"
  );
}

// ── roster 的额度耗尽来自 publisher 最近一次收敛发布的那份 ──
//
// picker 丢不丢一个模型、面板灰显谁，两端必须同一批：耗尽集合的唯一生产者是
// provider-reconciler（每轮从 429 事件流按纯函数 exhaustedModelIds 推断，见
// reconcile.test.mjs §8 的接线用例），聚合器与 provider GET 路由只读
// state.unavailableIds——自己再算一遍就会与另外两端漂移。
{
  const body = await buildSnapshotBody({
    settings: resolveSettings({}).settings,
    tokenStore: { state: async () => ({ present: true, source: "env", valid: null, checkedAt: null, ephemeral: true }) },
    usageStore: {
      daily: async () => ({ calls: 0 }), perModelToday: async () => [], trend: async () => [], events: async () => [], anomaly: () => null
    },
    inference: {
      fetchModels: async () => ({ ids: ["a/A", "b/B"], entries: [{ id: "a/A" }, { id: "b/B" }] }),
      fetchBalance: async () => ({ available: 10, total: 10, frozen: 0, fetchedAt: "2026-10-18T00:00:00.000Z" })
    },
    providerStore: { enabled: async () => true, enabledIds: async () => [], contextWindow: async () => null, versionNote: async () => null },
    drawStore: { enabled: async () => null, modelId: async () => null, versionNote: async () => null },
    usagePrefsStore: { windowDays: async () => null, versionNote: async () => null },
    // 本轮的「事实」：b/B 在推断窗口内出现过 quota 事件。
    publisher: { state: { enabledIds: [], llmAvailable: true, registered: true, error: null, unavailableIds: ["b/B"] } },
    logger: { warn: () => {} }
  });
  const rows = new Map((body.provider?.roster ?? []).map((r) => [r.id, r]));
  assert.equal(rows.get("a/A")?.available, true, "没有证据的模型可用");
  assert.equal(rows.get("b/B")?.available, false, "publisher 发布过的耗尽模型 → 面板不可用");
  assert.equal(rows.get("b/B")?.quotaExhausted, true, "且带 quotaExhausted 标记（客户端据此灰显 + 禁勾选）");
}

// ── 出图块：待重启 + 首选已不在目录 ──
//
// 两条都是「字段算出来了却用错了地方」：
//   · mountPending 曾以「有缺席原因」为判据，而挂载那一刻开关是关的（用户之后才
//     翻开）时压根没尝试注册、没有缺席原因——最常见的「刚打开开关」场景因此
//     什么都不提示。真判据是「本次挂载没注册上」。
//   · 首选模型下架后 resolveDrawModelChoice 仍照显它（用户点了谁就是谁），
//     preferredInCatalog=false 把这件沉默的事说出来；目录读不到时必须置 null。
{
  const base = {
    settings: resolveSettings({}).settings,
    tokenStore: { state: async () => ({ present: true, source: "env", valid: null, checkedAt: null, ephemeral: true }) },
    usageStore: {
      daily: async () => ({ calls: 0 }), perModelToday: async () => [], trend: async () => [], events: async () => [], anomaly: () => null
    },
    providerStore: { enabled: async () => null, enabledIds: async () => [], contextWindow: async () => null, versionNote: async () => null },
    usagePrefsStore: { windowDays: async () => null, versionNote: async () => null },
    publisher: { state: { enabledIds: [], llmAvailable: false, registered: false, error: null } },
    logger: { warn: () => {} }
  };
  // 目录条目必须带任务标签：能力只认平台声明（`image-to-image`），没有标签的条目
  // 会走名字启发落到 vision-input，根本进不了出图候选。
  const entries = [{ id: "a/Image", tasks: ["image-to-image"] }, { id: "b/Image", tasks: ["image-to-image"] }];

  // 开关开着、本次挂载没注册上（缺席原因也是 null：压根没尝试过）——正是要提示
  // 重启的那一档。
  setDrawToolMounted(false);
  setDrawToolNote(null);
  const pending = await buildSnapshotBody({
    ...base,
    inference: { fetchModels: async () => ({ ids: ["a/Image"], entries: [{ id: "a/Image" }] }), fetchBalance: async () => ({}) },
    drawStore: { enabled: async () => true, modelId: async () => null, versionNote: async () => null }
  });
  assert.equal(pending.draw?.mountPending, true, "开关开着但本次没注册上 → 待重启（哪怕没有缺席原因）");
  assert.equal(pending.draw?.absentReason, null);

  // 注册成功 → 不再提示。旧判据在这一档答不对。
  setDrawToolMounted(true);
  const mounted = await buildSnapshotBody({
    ...base,
    inference: { fetchModels: async () => ({ ids: ["a/Image"], entries: [{ id: "a/Image" }] }), fetchBalance: async () => ({}) },
    drawStore: { enabled: async () => true, modelId: async () => null, versionNote: async () => null }
  });
  assert.equal(mounted.draw?.mountPending, false, "已注册上 → 不该再提示重启");

  // 首选在目录 / 不在目录 / 目录读不到：三态。
  const inCatalog = await buildSnapshotBody({
    ...base,
    inference: { fetchModels: async () => ({ ids: entries.map((e) => e.id), entries }), fetchBalance: async () => ({}) },
    drawStore: { enabled: async () => true, modelId: async () => "a/Image", versionNote: async () => null }
  });
  assert.equal(inCatalog.draw?.preferredInCatalog, true, "首选还在目录里 → true");

  const gone = await buildSnapshotBody({
    ...base,
    inference: { fetchModels: async () => ({ ids: entries.map((e) => e.id), entries }), fetchBalance: async () => ({}) },
    drawStore: { enabled: async () => true, modelId: async () => "Owner/Vanished", versionNote: async () => null }
  });
  assert.equal(gone.draw?.preferredModel, "Owner/Vanished", "用户点了谁就是谁，不校验目录在场");
  assert.equal(gone.draw?.effectiveModel, "Owner/Vanished", "因此生效模型仍是这个已消失的 id");
  assert.equal(gone.draw?.preferredInCatalog, false, "目录读到了、它不在 → false（面板据此提示重选）");

  const unreadable = await buildSnapshotBody({
    ...base,
    inference: { fetchModels: async () => { throw new Error("catalog refused"); }, fetchBalance: async () => ({}) },
    drawStore: { enabled: async () => true, modelId: async () => "Owner/Vanished", versionNote: async () => null }
  });
  assert.equal(unreadable.draw?.preferredInCatalog, null, "目录读不到 → null（不知道），不是 false（红线 3）");
  // 目录读不到时 provider.error **必须说明原因**：wire.ts 的 ProviderStatus 承诺
  // 「目录读不到时 modelCount 为 0、roster 为空、error 说明原因」，而
  // provider-reconcile 在目录 fetch 失败时只 warn、不写 publisher.state.error
  // （那份 error 只记 publish 失败）。2026-10-19 锐评实测：旧写法下面板呈现
  // 「已注册 + 0 个模型 + 没有任何原因」，正是红线 3（读不到 ≠ 0）的漏点。
  assert.equal(unreadable.provider?.modelCount, 0, "目录读不到 → 0 个模型");
  assert.equal(typeof unreadable.provider?.error, "string", "目录读不到必须在 provider.error 里说明原因");
  assert.match(unreadable.provider.error, /catalog refused/, "原因里要带上真实的失败文本");
  assert.equal(inCatalog.provider?.error, null, "目录读得到时不报目录故障——软失败不许误报");

  // 没设首选 → null，不是 false。
  const auto = await buildSnapshotBody({
    ...base,
    inference: { fetchModels: async () => ({ ids: ["a/Image"], entries: [{ id: "a/Image" }] }), fetchBalance: async () => ({}) },
    drawStore: { enabled: async () => true, modelId: async () => null, versionNote: async () => null }
  });
  assert.equal(auto.draw?.preferredInCatalog, null, "没设首选 → null");

  resetDrawToolNote();
}

// ── 同一条语义，用**真实挂载的插件**再钉一次 ──
//
// 上面那节的注释原话是「挂载的真实 store 造不出『读的时候抛』」——它用一个会抛错
// 的桩钉住了 null 语义，而真实 store 从不抛：它把一切读失败吞成空载荷，于是
// `usedLocal` 恒为数字，`number | null` 里的 null 分支从未在本机真的产出过。
// 结果是 wire.ts / cards.ts / snapshot-aggregate.ts 三处都写着「读不到渲成 0
// 会让操作者以为今天没调用过」，实现却一次都没兑现。
//
// 这一节补的就是那块拼图：不靠桩，靠磁盘上一份**更新构建写的** usage.json。
{
  mkdirSync(stateDirPath, { recursive: true });
  // 日期是什么无所谓——整份载荷本构建都不认识，重点是 daily() 不许把「读不到」
  // 落成 0（下面那条 shapeWarnings 才是给用户看的原因）。
  const usageFile = join(stateDirPath, "usage.json");
  writeFileSync(usageFile, JSON.stringify({
    version: 99,
    days: { "2026-10-16": { calls: 7, tokens: 3 } },
    models: {},
    events: []
  }), "utf8");
  try {
    const isolated = new Map();
    apply(makeCtx(isolated), {}, { env: {} });
    const body = await call(isolated, SNAPSHOT_PATH, makeReq("GET"));
    assert.equal(
      body.quota.daily.usedLocal,
      null,
      "磁盘上那 7 次本构建读不了 → 头条必须是「不知道」（null），不是伪造的 0"
    );
    assert.ok(
      body.shapeWarnings.some((w) => w.startsWith("usage-state:")),
      "读不到必须留下痕迹，否则面板上的「—」没有原因可查"
    );
  } finally {
    rmSync(usageFile, { force: true });
  }
}

// ── coalesced 缓存：clear() 之后的 pre-clear 答案不得复活 ──
//
// 世代号必须取自**一条**单调序列。曾经 per-key 与 global 各自 +1，两个数值域会撞号：
// 先 clear("k") 得 1 → 飞行以 born=1 起飞 → 随后全局 clear 把 global 也变成 1，而
// keys.clear() 让 genOf("k") 落回 1 ⇒ 那次 clear 之前的答案被当成有效缓存读出来，
// 与 clear() 自己的承诺（clear 之前的飞行结果永不可再被读到）相反。
{
  const { createCoalescedFetch, clearCoalescedFetch } = await import("../src/host/coalesced-fetch.ts");
  const cache = new Map();
  const inflight = new Map();
  const fetch = createCoalescedFetch({ cache, inflight });

  clearCoalescedFetch(cache, inflight, "k");     // 先抬高该键的世代号
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pre = fetch.read("k", async () => { await gate; return "PRE-CLEAR"; }, 60_000);
  clearCoalescedFetch(cache, inflight);          // 紧接着全局 clear（旧代码在这里撞号）
  release();
  assert.equal(await pre, "PRE-CLEAR", "在途调用自身仍拿到它要的答案（clear 不取消在途）");

  let produced = 0;
  const after = await fetch.read("k", async () => { produced += 1; return "FRESH"; }, 60_000);
  assert.equal(after, "FRESH", "clear 之后的读必须重取：pre-clear 的答案不得复活");
  assert.equal(produced, 1, "确实重新拉了一次");
}

// ── 趋势显示窗口路由：GET 读 / POST 写 + 形状与范围两条判据 ──────────────────
//
// 越界**夹取**（与 host-config 对配置值的处理同一口径——同一个越界值不该因来源
// 不同得到两个下场），形状错**拒绝 400**（给错了 ≠ 给多了：把一次误发的 body 静默
// 读成「清除覆盖」，等于替用户做了一次他没要的重置）。
{
  const defaults = resolveSettings({}).settings;
  const get = async () => {
    const res = makeRes();
    await handlers.get(TREND_WINDOW_PATH)(makeReq("GET"), res);
    assert.equal(res.status, 200);
    return res.body;
  };
  const post = async (body) => {
    const res = makeRes();
    await handlers.get(TREND_WINDOW_PATH)(makeReq("POST", { body }), res);
    return res;
  };

  const fresh = await get();
  assert.equal(fresh.windowDays, null, "从未保存 → 覆盖为 null");
  assert.equal(fresh.days, defaults.trendDays, "生效天数 = 配置默认");
  assert.equal(fresh.maxDays, defaults.retentionDays, "上界 = 保留窗口");
  assert.equal(fresh.source, "config", "未保存时来源是 config");

  const saved = await post({ windowDays: 30 });
  assert.equal(saved.status, 200, "合法保存回 200");
  assert.equal(saved.body.windowDays, 30);
  assert.equal(saved.body.days, 30);
  assert.equal(saved.body.source, "panel", "保存后来源是 panel");
  assert.equal((await get()).days, 30, "GET 与 POST 说的是同一份状态");

  assert.equal((await post({ windowDays: 999 })).body.windowDays, defaults.retentionDays, "超过保留 → 夹到上界");

  for (const bad of [{}, { windowDays: "30" }, { windowDays: true }]) {
    assert.equal((await post(bad)).status, 400, `形状错必须 400：${JSON.stringify(bad)}`);
  }
  assert.equal((await get()).days, defaults.retentionDays, "被拒的写不改动已有状态");

  const cleared = await post({ windowDays: null });
  assert.equal(cleared.body.windowDays, null, "null = 清除覆盖");
  assert.equal(cleared.body.days, defaults.trendDays, "清除后回到配置默认");
}

console.log("routes.test.mjs: all checks passed");
