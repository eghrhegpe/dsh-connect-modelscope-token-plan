// Client 半边测试：加载**构建产物** client.js（浏览器跑什么测试就跑什么），
// 用替身 React 渲染 PanelPage；另钉字典键对齐、GUIDANCE 副本 ⊆ CODE、
// client 路由字面量与 Host paths.ts 一致。
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// ── 替身 React：单渲染通的 hooks（决策测试不需要状态机）。 ──
const makeReact = () => ({
  createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined) }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial })
});

// 捕获版 loader：必须在 import 产物之前装到 globalThis.window 上。
let registration = null;
globalThis.window = { __ModuleLoader__: { load: (reg) => { registration = reg; } } };
await import(new URL("../client.js", import.meta.url));
assert.ok(registration, "client.js 必须在加载时调用 window.__ModuleLoader__.load");
assert.equal(registration.id, "dsh-connect-modelscope-token-plan", "REGISTRATION.id = slug");

const { panel, apply, inject } = registration.factory(() => makeReact());
assert.deepEqual(inject, ["slots", "locale"], "client 硬依赖 slots + locale");

const { zh, en } = panel.dictionaries;

// §1 字典键对齐：en 是 zh 的 typeof（编译期已钉），运行时再核一遍值域。
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "zh/en 键集必须一致");
for (const key of Object.keys(zh)) {
  assert.equal(typeof zh[key], "string");
  assert.equal(typeof en[key], "string");
}

// §2 GUIDANCE_BY_CODE 的键必须是 Host codes.ts CODE 表的真值（副本被钉住）。
const hostCodes = Object.values((await import("../src/host/codes.ts")).CODE);
for (const code of Object.keys(panel.tables.GUIDANCE_BY_CODE)) {
  assert.ok(hostCodes.includes(code), `GUIDANCE_BY_CODE 的 ${code} 不在 codes.ts CODE 表里——副本漂移`);
}
for (const code of panel.tables.FORM_EXCLUDED_CODES) {
  assert.ok(hostCodes.includes(code), `FORM_EXCLUDED_CODES 的 ${code} 不在 CODE 表里`);
}

// §3 interpretSnapshot / viewOf 决策。
// fixture 必须**逐字含齐** SNAPSHOT_REQUIRED_KEYS 的每个键（§3b 会逐个删键验证
// 补空形状，所以这里少一个键会让「完整 body」那一断言误报）。
const okBody = { ok: true, name: "dsh-connect-modelscope-token-plan", version: "0.1.0", now: "2026-10-04T00:00:00Z", pollSeconds: 30, cacheSeconds: 60, token: { present: true, source: "credentials", valid: null, checkedAt: null, ephemeral: false }, balance: { available: 143, total: 143, frozen: 0, fetchedAt: null, error: null }, quota: { daily: { usedLocal: 0 }, perModel: [], countingNote: "local-counting" }, events: [], trend: { days: 14, buckets: [] }, models: { available: true, count: 35, sample: [], error: null }, provider: { enabled: false, source: "config", llmAvailable: false, registered: false, error: null, modelCount: 0, enabledCount: 0, allowed: "all", enabledIds: [], roster: [] }, shapeWarnings: [], quotaError: null };
// helpers 不含 interpretSnapshot，真身在 panel 顶层。原先这里是
// `panel.helpers.interpretSnapshot ? null : null` —— 两支都是 null 且变量从未使用，
// 是重构残留。现在把它变成真正钉住形状的断言：谁把函数挪进 helpers，
// 下面第 52 行的 `panel.interpretSnapshot(okBody)` 就会炸。
assert.equal(panel.helpers?.interpretSnapshot, undefined, "interpretSnapshot 住在 panel 顶层，不在 helpers 里");
const interpreted = panel.interpretSnapshot(okBody);
assert.equal(interpreted.data === null, false, "ok:true body 读出数据");
const view = panel.viewOf(interpreted.data, null, (key) => zh[key]);
assert.equal(view.failure, null);
assert.equal(view.needsSetup, false);

const failBody = { ok: false, code: "auth_error", error: "token rejected" };
const failedRead = panel.interpretSnapshot(failBody);
assert.equal(failedRead.data, null);
const failedView = panel.viewOf(null, failedRead.error, (key) => zh[key]);
assert.equal(failedView.guidanceKey, "panel.authError", "auth_error → 引导去接入 tab");
assert.equal(failedView.needsSetup, true, "auth_error 由配令牌修复 → needsSetup");

const cfgView = panel.viewOf(null, { message: "bad apiBase", code: "config_error" }, (key) => zh[key]);
assert.equal(cfgView.needsSetup, false, "config_error 不是配令牌能修的 → 不进 setup 分支");
assert.match(cfgView.guidance ?? "", /插件配置有误/);

// §3b 契约漂移：Host 少给顶层键时，面板渲染「空」而不是崩。
//
// 回归用例。interpretSnapshot 曾经对 ok:true 的 body 是裸cast，于是
// `data?.models.sample[0]` 这类解引用抛 TypeError 把整个面板炸掉——`data?.`
// 只护住 data 本身，护不住它下面的 models；而那一行在**所有 tab 上都执行**。
// SNAPSHOT_REQUIRED_KEYS 那时只在 test/wire.test.mjs 里被引用，运行时零防线。
//
// 期望行为：缺失的键被补成与 Host 降级同构的空形状 + 进 missingKeys（供面板
// 显示成 shapeWarning），数据仍可渲染。
{
  const complete = okBody;
  assert.deepEqual(panel.interpretSnapshot(complete).missingKeys, [], "完整 body 没有缺失键");

  // 逐个删键：都必须被认出来 + 补出可安全解引用的空形状。
  for (const key of Object.keys(complete)) {
    if (key === "ok") continue;   // ok 缺失不是契约漂移，是非法载荷（下面单独断言）
    const broken = { ...complete };
    delete broken[key];
    const r = panel.interpretSnapshot(broken);
    assert.notEqual(r.data, null, `缺 ${key} 仍应给出可渲染的 data`);
    assert.ok((r.missingKeys ?? []).includes(key), `缺 ${key} 必须被认出来`);
    // 补出的空形状要能扛住面板那些解引用（曾经的崩点）。
    const d = r.data;
    assert.doesNotThrow(() => {
      void (d?.models?.sample?.[0] ?? null);
      void (d?.trend?.days ?? 0);
      void (d?.trend?.buckets ?? []);
      void (d?.token?.present === true);
      void (d?.events ?? []);
      void (d?.balance ?? null);
      void (Array.isArray(d?.quota?.perModel) ? d.quota.perModel : []);
    }, `缺 ${key} 补出的空形状不该让面板解引用抛错`);
  }

  // 缺失要冒到面板上（不静默：Host 少给键是双端漂移，用户该看见）。
  // 2026-10-06：文案改为走字典键（shape.missingKeys），此处断言翻译后的中文
  // 文本 + 键名列表，不再钉旧英文原句。
  const drifted = panel.interpretSnapshot({ ...complete, models: undefined });
  const driftView = panel.viewOf(drifted.data, null, (key) => zh[key], drifted.missingKeys);
  assert.ok(
    driftView.shapeWarnings.some((w) => /顶层键/.test(w) && /models/.test(w)),
    "缺失键进入 shapeWarnings（经字典翻译）"
  );

  // ok 缺失是另一回事：不是「少了个块」，而是整个载荷不合法。曾经返回裸英文
  // "unexpected payload"，现在给 client 自产稳定码 payload_error（引导文案走
  // GUIDANCE_BY_CODE），断言钉码而非钉字符串。
  assert.equal(panel.interpretSnapshot({ name: "x" }).data, null, "缺 ok → data 为 null");
  assert.equal(panel.interpretSnapshot({ name: "x" }).error?.code, "payload_error", "不可读载荷 → client 稳定码");
}

// §3b2 NaN 防护：`typeof NaN === "number"` 为 true，若不检查 isFinite，
// Host 返回 NaN 时面板会显示「NaN 个模型」。
{
  const nanProvider = { ...okBody.provider, modelCount: NaN, enabledCount: NaN };
  const result = panel.providerOf(nanProvider);
  assert.equal(result.modelCount, nanProvider.roster.length, "NaN modelCount 回退为 roster.length");
  assert.equal(result.enabledCount, 0, "NaN enabledCount 回退为 0");
  // Infinity 也应被挡（typeof Infinity === "number"）。
  const infProvider = { ...okBody.provider, modelCount: Infinity, enabledCount: -Infinity };
  assert.equal(panel.providerOf(infProvider).modelCount, infProvider.roster.length, "Infinity modelCount 回退");
  assert.equal(panel.providerOf(infProvider).enabledCount, 0, "-Infinity enabledCount 回退");
}

// §3c internal_error 必须有引导文案，且**不能**被导去「配令牌」。
//
// 回归用例：soft() 与 failureCode() 在错误无 code 时统一产出 internal_error，而
// GUIDANCE_BY_CODE 曾漏了它——最需要人看的内部错误反而没有引导，且因为不在
// FORM_EXCLUDED_CODES 里，needsSetup 算成 true，把内部错误引导去贴令牌，方向反了。
{
  const internalView = panel.viewOf(null, { message: "boom", code: "internal_error" }, (key) => zh[key]);
  assert.equal(internalView.guidanceKey, "panel.internalError", "internal_error 有引导文案");
  assert.match(internalView.guidance ?? "", /内部错误/);
  assert.equal(internalView.needsSetup, false, "内部错误不该引导去配令牌");

  // 码表完整性：Host 每个码都必须有引导文案，否则用户看到裸错误。
  // （internal_error 曾漏在这里——最需要人看的内部错误反而没有引导，且因为不在
  // FORM_EXCLUDED_CODES 里，needsSetup 算成 true，把内部错误引导去贴令牌。）
  for (const code of hostCodes) {
    assert.ok(panel.tables.GUIDANCE_BY_CODE[code] !== undefined, `Host 码 ${code} 缺引导文案`);
  }
}

// §4 渲染 PanelPage（空快照 = 加载态）：tab 栏 + data-dsh-plugin 标记 + 三个 tab。
const tree = panel.components.PanelPage({ tt: (key) => zh[key], localeSubscribe: null });
const flatten = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (node.type !== undefined || node.props !== undefined) {
    out.push(node);
    for (const child of node.children ?? []) flatten(child, out);
  }
  return out;
};
const nodes = flatten(tree);
const tabNodes = nodes.filter((n) => n.props && n.props.role === "tab");
assert.equal(tabNodes.length, 3, "三个 tab（额度/模型/接入）");
const pageRoot = nodes.find((n) => n.props && n.props["data-dsh-plugin"] === "dsh-connect-modelscope-token-plan");
assert.ok(pageRoot, "根节点带 data-dsh-plugin 标记");

// §5 BalanceCard：真实形状渲染三格 + 数字；错误形状渲染错误行。
const balance = panel.components.BalanceCard({ balance: okBody.balance, tt: (key) => zh[key] });
const balanceText = JSON.stringify(balance);
assert.ok(balanceText.includes("143"), "余额数字 143 上屏");
const balanceErr = panel.components.BalanceCard({ balance: { available: null, total: null, frozen: null, fetchedAt: null, error: "boom" }, tt: (key) => zh[key] });
assert.ok(JSON.stringify(balanceErr).includes("boom"), "错误形状渲染错误行而非崩溃");

// §6 client 的路由与 Host 的 paths.ts 一致。产物里的路由是**模板拼接**
// （"/api/"+NS+后缀，NS 来自 REGISTRATION.id），所以分别核：Host 字面量全集、
// 产物里的 slug 与各后缀模板。
const artifact = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const hostPaths = readFileSync(new URL("../src/host/routes/paths.ts", import.meta.url), "utf8");
const hostProviderRoutes = readFileSync(new URL("../src/host/routes/provider.ts", import.meta.url), "utf8");
const slug = registration.id;

// 两边**全部**路由后缀的并集。client 侧每条都是 `const.ts` 里的模板字面量；
// Host 侧分两种：`paths.ts` 里的字面量（单数前缀），以及 `routes/provider.ts`
// 里用 `${PROVIDER_PATH}/suffix` 拼出来的派生路由。**三条 provider 路由曾经整个
// 漏在本清单外**（M4 加了路由没同步这里，于是「client 与 Host 路由一致」对 M4 的
// 主功能恰好是盲的）。
const ALL_SUFFIXES = [
  "/snapshot",
  "/models",
  "/token",
  "/token/forget",
  "/probe",
  "/provider",
  "/provider/roster",
  "/provider/reset"
];
const LITERAL_SUFFIXES = ["/snapshot", "/models", "/token", "/token/forget", "/probe", "/provider"];
const DERIVED_SUFFIXES = ["/provider/roster", "/provider/reset"];

for (const suffix of ALL_SUFFIXES) {
  // ① client 产物里必须有这条模板（浏览器实际打的路径）。
  assert.ok(artifact.includes("`/api/${NS}" + suffix + "`"), `产物缺路由模板 ${suffix}`);
  // ② Host 侧必须真的接得住这条路径——字面量或派生，二者必居其一。
  if (LITERAL_SUFFIXES.includes(suffix)) {
    assert.ok(hostPaths.includes(`/api/${slug}${suffix}`), `paths.ts 缺字面量 /api/${slug}${suffix}`);
  } else {
    // 派生路由：`routes/provider.ts` 里 `${PROVIDER_PATH}` + 后缀。
    const derived = suffix.slice("/provider".length); // "/roster" | "/reset"
    assert.ok(
      hostProviderRoutes.includes("${PROVIDER_PATH}" + derived + "`"),
      `routes/provider.ts 缺派生路由 \${PROVIDER_PATH}${derived}`
    );
  }
}

// 反向①：paths.ts 导出的每条字面量都必须在清单里（新增 Host 路由却忘了同步本
// 清单时，这条会红——比漏检更早发现）。
const hostLiterals = [...hostPaths.matchAll(/\/api\/dsh-connect-modelscope-token-plan(\/[a-z/]+)"/g)].map((m) => m[1]);
for (const literal of hostLiterals) {
  assert.ok(
    LITERAL_SUFFIXES.includes(literal),
    `paths.ts 有未纳入本清单的路由 ${literal}——新增路由请同步 panel.test.mjs §6`
  );
}

// 反向②：client 每条路由都必须能对上一个 Host 路由（防止 client 打了个
// Host 根本没注册的后缀——这是「面板点一下 404」的形态）。
const clientSuffixes = [...artifact.matchAll(/`\/api\/\$\{NS\}(\/[a-z/]+)`/g)].map((m) => m[1]);
assert.ok(clientSuffixes.length > 0, "产物里应当能抓到 client 路由模板");
for (const suffix of new Set(clientSuffixes)) {
  assert.ok(
    ALL_SUFFIXES.includes(suffix),
    `产物里有本清单未覆盖的 client 路由 ${suffix}——请确认 Host 也注册了它，然后同步本清单`
  );
}

// §6b **真正的两边交叉核对**：把 client 源码 const.ts 的模板后缀解析成完整路径，
// 与 Host 侧实际生效的完整路径逐一比对。上面的 §6 只检查「两边分别提到了这个
// 后缀」，两边各自打错、但错成同一个字面量时它不会红；这里比较的是**解析后的
// 完整字符串**，所以改错任何一边都会红。
//
// （这正是 docs/PROVIDER-M4.md:244 曾经**谎称**存在的那条断言。）
{
  const clientConst = readFileSync(new URL("../src/client/const.ts", import.meta.url), "utf8");
  // client 侧：`/api/${NS}/xxx` → `/api/<slug>/xxx`，NS 运行时就是 REGISTRATION.id。
  const clientResolved = new Set(
    [...clientConst.matchAll(/`\/api\/\$\{NS\}(\/[a-z/]+)`/g)].map((m) => `/api/${slug}${m[1]}`)
  );
  // Host 侧：paths.ts 的字面量 ∪ routes/provider.ts 的派生路由。
  const hostResolved = new Set(
    [...hostPaths.matchAll(/["'](\/api\/[a-z0-9/_-]+)["']/g)].map((m) => m[1])
  );
  for (const m of hostProviderRoutes.matchAll(/`\$\{PROVIDER_PATH\}(\/[a-z/]+)`/g)) {
    hostResolved.add(`/api/${slug}/provider${m[1]}`);
  }

  assert.ok(clientResolved.size >= 5, `client 侧应解析出至少 5 条路由，实际 ${clientResolved.size}`);
  assert.ok(hostResolved.size >= 5, `Host 侧应解析出至少 5 条路由，实际 ${hostResolved.size}`);

  // 每个 client 会打的路径，Host 必须都有；反之亦然。
  for (const path of clientResolved) {
    assert.ok(hostResolved.has(path), `client 会打 ${path}，但 Host 没注册——点下去就是 404`);
  }
  for (const path of hostResolved) {
    assert.ok(clientResolved.has(path), `Host 注册了 ${path}，但 client 没有任何 const 指向它（死路由？）`);
  }
}

// §6c 哨兵字面量双端一致。`__hide_all__` 在 host/llm-models.ts 与
// client/const.ts 各有一份拷贝——浏览器 bundle 无法从 host 模块 import，
// 两份是设计意图（见 const.ts:35-38 的警告）。但它与路由路径不同：路由有
// §6/§6b 双向钉住，哨兵一直只有 host 侧被 provider.test.mjs:28 钉死字面值，
// client 侧零断言。改坏 client 那一份，npm test 全绿，而效果是「点全部隐藏」
// 被当成普通模型 id 发给 filterByEnabled——匹配不到任何真实模型，「全部隐藏」
// 静默变成「全部提供」。
{
  const hostLlm = readFileSync(new URL("../src/host/llm-models.ts", import.meta.url), "utf8");
  const clientConst = readFileSync(new URL("../src/client/const.ts", import.meta.url), "utf8");
  const sentinelOf = (src) => (src.match(/HIDE_ALL_MODELS\s*=\s*"([^"]+)"/) ?? [])[1];
  const hostSentinel = sentinelOf(hostLlm);
  const clientSentinel = sentinelOf(clientConst);
  assert.equal(typeof hostSentinel, "string", "host/llm-models.ts 必须定义 HIDE_ALL_MODELS");
  assert.equal(typeof clientSentinel, "string", "client/const.ts 必须定义 HIDE_ALL_MODELS");
  assert.equal(clientSentinel, hostSentinel,
    `双端哨兵必须同字面量：host="${hostSentinel}" client="${clientSentinel}"`);
}

// §6d locale 文件 key 集合一致。i18n.ts 的运行时字典（zh/en 各 85 键）由
// `export const en: typeof zh` 在编译期钉死，但 locale/*.json 是另一套（给市场
// 页用的 title/description），两边互不兜底。en.json 曾缺 meta.description，
// 市场英文页简介空白而所有测试全绿。
{
  const flat = (obj, prefix = "") => Object.entries(obj).flatMap(([k, v]) =>
    (v !== null && typeof v === "object") ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]);
  const zhJson = JSON.parse(readFileSync(new URL("../locale/zh.json", import.meta.url), "utf8"));
  const enJson = JSON.parse(readFileSync(new URL("../locale/en.json", import.meta.url), "utf8"));
  assert.deepEqual(flat(enJson).sort(), flat(zhJson).sort(),
    "locale/en.json 与 zh.json 的 key 集合必须一致");
}

// §7 apply()：把字典与卡注册进 slots。
{
  const registered = [];
  const calls = [];
  apply({
    effect: (fn, label) => { calls.push(label ?? ""); return () => {}; },
    locale: { register: (ns, dicts) => { registered.push([ns, dicts]); return () => {}; }, bind: () => (key) => key, subscribe: () => () => {} },
    slots: {
      inject: (slot, register) => { register(); return () => {}; },
      register: (declaration, component) => { registered.push([declaration.key, component]); return () => {}; }
    }
  });
  assert.ok(registered.some(([ns]) => ns === "dsh-connect-modelscope-token-plan"), "字典按 NS 注册");
  assert.ok(registered.some(([key]) => key === "dsh-connect-modelscope-token-plan"), "卡按 NS 注册");
  assert.ok(calls.length >= 2, "挂载副作用已登记");
}

console.log("panel.test.mjs: all checks passed");
