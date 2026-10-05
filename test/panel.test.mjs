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
const okBody = { ok: true, name: "dsh-connect-modelscope-token-plan", now: "2026-10-04T00:00:00Z", pollSeconds: 30, cacheSeconds: 60, token: { present: true, source: "credentials", valid: null, checkedAt: null, ephemeral: false }, balance: { available: 143, total: 143, frozen: 0, fetchedAt: null, error: null }, quota: { daily: { usedLocal: 0 }, perModel: [], countingNote: "local-counting" }, events: [], trend: { days: 14, buckets: [] }, models: { available: true, count: 35, sample: [], error: null }, shapeWarnings: [], quotaError: null };
const read = panel.helpers.interpretSnapshot
  ? null // helpers 不含 interpretSnapshot；真身在 panel 顶层
  : null;
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
const slug = registration.id;
for (const suffix of ["/snapshot", "/models", "/token", "/token/forget", "/probe"]) {
  const resolved = `/api/${slug}${suffix}`;
  assert.ok(hostPaths.includes(resolved), `paths.ts 缺 ${resolved}`);
  // 产物里路由是模板拼接：`/api/${NS}/suffix`，NS 在运行时来自 REGISTRATION.id。
  assert.ok(artifact.includes("`/api/${NS}" + suffix + "`"), `产物缺路由模板 ${suffix}`);
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
