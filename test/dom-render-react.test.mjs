/**
 * dom-render-react.test.mjs —— 真 React 18.3.1 + react-dom/client + jsdom 的渲染门禁。
 *
 * 与 `test/dom-render.test.mjs` 的分工（那套是零版本耦合的 mini 替身，永远跑得）：
 * 本套件只承载**由 React 的 reconciler 决定**、替身结构上无法表达的五类检查——
 *   §1 选中态在真 CSSOM 里真的与未选中不同（`style.cssText`，不是 `aria-selected`）；
 *   §2 重渲染复用**同一批 DOM 节点**（对象身份）；
 *   §3 重渲染不丢焦点（这面板每 30s 一次 `setData` 就重渲染一次，正在输入的令牌框
 *      被打断是真实缺陷形态，而 mini 替身每次 commit 整棵重建，压根看不见）；
 *   §4 列表换序时勾选跟着**模型 id** 走，不跟着位置走；
 *   §5 React 自己的开发期告警为零（非法 DOM 属性、受控/非受控切换、缺 key……替身
 *      永远不会说这些话，所以这一类只能在这里钉）。
 * mini 替身在同样两条检查上的实测对照：`页根节点是同一个对象 = false`、
 * `重渲染后焦点还在输入框 = false（activeElement = BODY）`——这就是本套件存在的理由。
 *
 * ── 版本耦合（唯一的代价，必须核对）──
 * 浏览器里 React 由宿主 loader 注入，本仓库不控制它（见 types/dsh-peer-modules.d.ts
 * 的立场）。这里的 pin 是**实测宿主当前那一份**：`node tools/dev/probe-host-react.mjs`
 * 从 DSH 安装目录的 app.asar 里读出 React devtools 注册点的版本。宿主升级时先重跑它，
 * 再把下面的 EXPECTED_REACT_VERSION 与 package.json 的 pin 一起改——**不要反过来**：
 * 门禁静默测着一个旧的 reconciler，比不测更容易骗人。
 *
 * ── 两个必踩的坑（都在这里显式处理，注释别删）──
 * ① `react-dom/client` 必须在 `globalThis.window`/`document` 就位**之后**再 import：
 *    它在模块求值时算死 `canUseDOM` 与一串 feature detection，先 import 再换全局会让它
 *    以为身处「没有 DOM」的环境，于是走 IE 的老式 input 事件兜底，在 jsdom 里直接
 *    `TypeError: activeElement.attachEvent is not a function`。
 * ② 真 React 给受控 input 装了值追踪器，`el.value = "x"` + 派发 input 会被判成
 *    「没有变化」而吞掉 onChange；必须调 `HTMLInputElement.prototype` 的原生 setter。
 *    （@testing-library 的 user-event 就是为这件事存在的——这里 3 行绕过，不引框架。）
 *
 * 跑法：`node test/dom-render-react.test.mjs`（已挂进 `npm test`）。缺 react/react-dom
 * 时给一句可读的话；默认被测物是产物 `client.js`，`DSH_DOM_TARGET=src` 切到 TS 源码
 * （理由与 `dom-render.test.mjs` 相同：变异审计改的是 src，产物入口看不见）。
 */
import { strict as assert } from "node:assert";
import { JSDOM } from "jsdom";

const SLUG = "dsh-connect-modelscope-token-plan";
const EXPECTED_REACT_VERSION = "18.3.1";

// ── 顺序是承重的（坑 ①）：window/document 必须先就位，再 import react-dom ──
// react-dom 在**模块求值时**算死 `canUseDOM` 与一串 feature detection。先 import 再换
// 全局，它会以为身处「没有 DOM」的环境，于是 `isInputEventSupported` 为 false：文本
// 输入框走 IE 的老式兜底（`startWatchingForValueChange` → `activeElement.attachEvent`）
// 直接 TypeError，或者像本次这样——input 事件被整条吞掉，`onChange` 永远不跑，
// 表现为「打字进不去、payload 是空串」，看起来像被测代码的缺陷。
// 这句话不是抄来的：本文件第一版就是把依赖检查放在 jsdom 之前，写的人当场踩回去。
const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { document } = dom.window;

/** 缺包 / 版本漂移都给一句能行动的话（与 build-gate 需要 tsdown 同性质）。 */
let React;
let createRoot;
try {
  React = (await import("react")).default;
  ({ createRoot } = await import("react-dom/client"));
} catch (why) {
  throw new Error(`dom-render-react.test.mjs 需要 devDependencies 里的 react / react-dom（先 npm install）：${why?.message ?? why}`);
}
assert.equal(
  React.version, EXPECTED_REACT_VERSION,
  `本套件的语义与被钉住的宿主 React 不一致：装的是 ${React.version}，期望 ${EXPECTED_REACT_VERSION}。\n` +
  `    先跑 node tools/dev/probe-host-react.mjs 核对宿主当前版本，再决定改 pin 还是改 node_modules。`
);
assert.equal(typeof React.act, "function", "React 18.3 起 act 从 react 导出（不要用已废弃的 react-dom/test-utils）");
const { act } = React;

// ── 网络与定时器替身 ──
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const liveTimers = new Set();
const specs = [];
globalThis.setInterval = (fn, ms, ...rest) => { const id = realSetInterval(fn, ms, ...rest); liveTimers.add(id); specs.push(ms); return id; };
globalThis.clearInterval = (id) => { liveTimers.delete(id); return realClearInterval(id); };
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const record = { url: String(url), method: String(init.method ?? "GET").toUpperCase(), body: init.body === undefined ? null : String(init.body), signal: init.signal ?? null };
  calls.push(record);
  if (record.signal?.aborted === true) { const error = new Error("aborted"); error.name = "AbortError"; throw error; }
  const isSnapshot = record.method === "GET" && record.url === HOST.SNAPSHOT_PATH;
  return { ok: true, status: 200, json: async () => (isSnapshot ? snapshotBody() : record.method === "POST" ? { ok: true } : { ok: true }) };
};

const HOST = await import("../src/host/routes/paths.ts");
const SRC_MODE = process.env.DSH_DOM_TARGET === "src";

// ── fixture：roster 会换序，所以快照体是**有状态**的 ──
const A = "deepseek-ai/DeepSeek-V3";
const B = "Qwen/Qwen3-8B";
const C = "ZhipuAI/GLM-4.5-Air";
const row = (id, name, extra = {}) => ({ id, name, vision: false, available: true, quotaExhausted: false, ...extra });
let rosterOrder = [row(A, "DeepSeek V3"), row(B, "Qwen3 8B"), row(C, "GLM-4.5-Air", { available: false, quotaExhausted: true })];
const snapshotBody = () => ({
  ok: true, name: SLUG, version: "0.2.0", now: "2026-10-15T00:00:00Z", pollSeconds: 30, cacheSeconds: 60,
  token: { present: true, source: "credentials", valid: null, checkedAt: null, ephemeral: false, readError: null },
  balance: { available: 143, total: 143, frozen: 0, fetchedAt: null, error: null },
  quota: { daily: { usedLocal: 7 }, perModel: [], countingNote: "local-counting" },
  events: [], trend: { days: 14, buckets: [] }, models: { available: true, count: 3, sample: [A], error: null },
  provider: { enabled: false, source: "config", llmAvailable: true, registered: false, error: null, modelCount: 3, enabledCount: 0, allowed: "all", enabledIds: [], roster: rosterOrder },
  draw: { enabled: false, source: "config", candidateIds: [], candidateCount: 0, preferredModel: null, preferredSource: "config", absentReason: null, mountPending: false, toolName: "modelscope_draw_image" },
  shapeWarnings: [], quotaError: null
});

// ── 被测组件：产物或源码，两个入口 ──
let registration = null;
let PanelPage;
let zh;
if (SRC_MODE) {
  const { provideClientReact } = await import("../src/client/runtime.ts");
  provideClientReact(React);
  PanelPage = (await import("../src/client/panel-page.ts")).PanelPage;
  zh = (await import("../src/client/i18n.ts")).zh;
} else {
  // loader 捕获装在 jsdom 的 window 上（不是换一个假 window——本套件的 window 是真的）。
  dom.window.__ModuleLoader__ = { load: (reg) => { registration = reg; } };
  await import(new URL("../client.js", import.meta.url));
  assert.ok(registration, "client.js 必须调用 window.__ModuleLoader__.load");
  const { panel } = registration.factory(() => React);
  PanelPage = panel.components.PanelPage;
  zh = panel.dictionaries.zh;
}
const tt = (key) => zh[key];

// React 的开发期告警是唯一「只有真 reconciler 会说话」的信号，全程收集。
const reactWarnings = [];
const realError = console.error;
const realWarn = console.warn;
console.error = (...args) => { reactWarnings.push(String(args[0])); };
console.warn = (...args) => { reactWarnings.push(String(args[0])); };

const container = document.getElementById("root");
const root = createRoot(container);
const q = (s) => document.querySelector(s);
const qa = (s) => [...document.querySelectorAll(s)];
const byText = (s, want) => qa(s).find((el) => el.textContent.trim() === want);
const rosterChecks = () => qa('input[type="checkbox"][aria-label]');
/** 坑 ②：必须走原生 setter，否则 React 的值追踪器会吞掉 onChange。 */
const nativeValueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;

await act(async () => { root.render(React.createElement(PanelPage, { tt, localeSubscribe: null })); });
assert.equal(calls.filter((c) => c.url === HOST.SNAPSHOT_PATH).length, 1, "挂载即首轮轮询（真 effect 跑了）");
assert.deepEqual(specs, [30000], "cadence 来自快照声明的 pollSeconds");

// §1 选中态在真 CSSOM 里真的有差别（不是只挂了个 aria-selected）
const tabs = () => qa('[role="tab"]');
const activeCss = () => tabs().find((el) => el.getAttribute("aria-selected") === "true")?.style.cssText ?? "";
const idleCss = () => tabs().find((el) => el.getAttribute("aria-selected") === "false")?.style.cssText ?? "";
assert.ok(activeCss().length > 0, "选中 tab 的 style 真的进了 CSSOM（对象没被丢光）");
assert.notEqual(activeCss(), idleCss(), "选中与未选中的 tab 样式必须不同（styles.ts 的 tabActive 真的生效）");

// §2 重渲染复用同一批 DOM 节点（mini 替身这里实测 false）
const pageRef = q(`[data-dsh-plugin="${SLUG}"]`);
const titleRef = pageRef.querySelector("h1");
const svgRef = pageRef.querySelector("svg");
assert.ok(pageRef && titleRef && svgRef, "先拿到节点引用");
await act(async () => { byText("button", tt("panel.refresh")).click(); });
assert.equal(q(`[data-dsh-plugin="${SLUG}"]`), pageRef, "页根：重渲染后仍是同一个 DOM 对象");
assert.equal(pageRef.querySelector("h1"), titleRef, "标题节点被就地复用");
assert.equal(pageRef.querySelector("svg"), svgRef, "svg 节点被就地复用");

// §3 重渲染不丢焦点（面板每 30s 自动重渲染一次，正在打字的人不该被打断）
await act(async () => { byText('[role="tab"]', tt("tab.access")).click(); });
const input = q('input[type="password"]');
assert.ok(input, "令牌输入框在");
await act(async () => { input.focus(); });
assert.equal(document.activeElement, input, "先确认真的拿到了焦点");
await act(async () => { byText("button", tt("panel.refresh")).click(); });
assert.equal(document.activeElement, input, "重渲染后焦点仍在那个输入框上（不是掉回 <body>）");

// §4 列表换序：勾选跟着模型 id 走，不跟着位置走
await act(async () => { byText('[role="tab"]', tt("tab.models")).click(); });
assert.deepEqual(rosterChecks().map((el) => el.getAttribute("aria-label")), [A, B, C], "换序前：id 顺序");
const ticked = () => rosterChecks().filter((el) => el.checked).map((el) => el.getAttribute("aria-label"));
await act(async () => { rosterChecks()[1].click(); });
assert.deepEqual(ticked(), [B], "勾中第二行（B）");
rosterOrder = [row(C, "GLM-4.5-Air", { available: false, quotaExhausted: true }), row(B, "Qwen3 8B"), row(A, "DeepSeek V3")];
await act(async () => { byText("button", tt("panel.refresh")).click(); });
assert.deepEqual(rosterChecks().map((el) => el.getAttribute("aria-label")), [C, B, A], "换序后：id 顺序");
assert.deepEqual(ticked(), [B], "换序后勾中的仍是 B（按 id，不按位置）");

// §5 真 React 的受控链路：打字 → onChange → state → payload（mini 那条测的是替身）
await act(async () => { byText('[role="tab"]', tt("tab.access")).click(); });
const input2 = q('input[type="password"]');
await act(async () => {
  nativeValueSetter.call(input2, "ms-real-token-9");
  input2.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
});
assert.equal(input2.value, "ms-real-token-9", "原生 setter 让 React 的 onChange 真的跑了");
await act(async () => { byText("button", tt("token.save")).click(); });
const tokenPost = calls.find((c) => c.method === "POST" && c.url === HOST.TOKEN_PATH);
assert.ok(tokenPost, "点保存真的 POST /token");
assert.deepEqual(JSON.parse(tokenPost.body ?? "null"), { token: "ms-real-token-9" }, "payload 里是打进 DOM 的那个值");

// §6 卸载收干净 + 全程零 React 开发期告警
await act(async () => { root.unmount(); });
assert.equal(liveTimers.size, 0, "卸载清掉轮询 interval");
assert.equal(container.children.length, 0, "卸载清空容器");
console.error = realError;
console.warn = realWarn;
assert.deepEqual(reactWarnings, [], `React 开发期告警必须为零：\n    ${reactWarnings.join("\n    ")}`);
console.log(`dom-render-react.test.mjs: all checks passed（React ${React.version}，${calls.length} 次请求）`);
