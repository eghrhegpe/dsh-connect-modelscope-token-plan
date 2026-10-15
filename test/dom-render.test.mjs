/**
 * dom-render.test.mjs —— 把**构建产物 client.js** 挂进**真 DOM**（jsdom）的渲染与交互门禁。
 *
 * 补的是哪块缺口：docs/ROADMAP.md 记着「替身 React 能钉住组件输出了什么，钉不住时序
 * 与事件」。`test/panel.test.mjs` 至今如此——`createElement` 返回一个普通对象，断言靠
 * flatten 那棵树 + `JSON.stringify` 找子串。于是下面这些缺陷形态在门禁里是隐形的：
 *   - `props.onClick` 拼错、绑到了错的元素、或压根没绑 → 替身树里它只是一个属性值，
 *     永远「在」，而真浏览器里那个按钮点下去什么也不发生；
 *   - 受控输入的值没有真的回流到写盘 payload（input → onChange → state → 保存）；
 *   - busy 期间按钮/开关该 `disabled`（真 DOM 语义：禁用控件收不到 click），写完之后
 *     disabled 该撤掉；
 *   - 点「全部隐藏」后保存清单发出混排 ids（哨兵独占态活在 handler 闭包里，不在渲染
 *     输出里）；
 *   - 挂载副作用（首轮轮询、locale 订阅）到底跑没跑、卸载时 cleanup 跑没跑、在途请求
 *     作不作废；
 *   - 卡片体压根没渲染过：替身 React 把 children 放在 `props` **旁边**，而
 *     `SectionCard` 从 `props` 里解构 `children` → 折叠体里的卡在那个套件里从未出现。
 * 这里全部走真 DOM：jsdom 给出真的 document / Element / Event / 属性序列化 / disabled
 * 语义，客户端代码里的 `document.visibilityState` 与 `document.addEventListener` 也真的
 * 被调用（那是 `use-polling-interval` 的暂停分支，替身套件里恒为「没有 document」）。
 *
 * ── 这套替身 React 复现了什么、没复现什么（把下面的结论当浏览器事实读之前先看这里）──
 * 复现：函数组件按「路径 + 组件名」保持 hook 槽位（与 React 的隐式 key 同一条规则：
 * 同位置换组件 = 重挂 = 状态清零）；useState / useRef / useMemo / useCallback /
 * useEffect；setState → 微任务里合并成一次重渲染；effect 在 commit 之后跑、deps 变化
 * 先跑 cleanup；unmount 跑全部 cleanup；children 真的经 `props.children` 进组件。
 * 未复现（不要据此下结论）：DOM diff 与节点复用（每次 commit 整棵重建）、`key` 参与
 * 身份、React 的 style 数值 px 归一（**应用但绝不断言**：那是 React 的行为不是被测代码
 * 的行为，断言它等于拿自己造的桩当被测物）、并发/Suspense/错误边界、batching 的精确
 * 边界。要验「同一 DOM 节点被就地更新、焦点不丢」得上真 React + react-dom，那是
 * ROADMAP 的另一档成本，本套件不冒充它。
 *
 * 跑法：`node test/dom-render.test.mjs`（已挂进 `npm test`）。需要 devDependencies 里的
 * jsdom——与 build-gate 需要 tsdown 同一性质，干净 checkout 先 `npm install`。
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

/** jsdom 缺失时给一句可读的话，而不是 ERR_MODULE_NOT_FOUND 堆栈。 */
let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch (why) {
  throw new Error(`dom-render.test.mjs 需要 devDependencies 里的 jsdom（先 npm install）：${why?.message ?? why}`);
}

// ══════════════════════════════════════════════════════════════════════════
// §0a 被测入口：默认**构建产物**，DSH_DOM_TARGET=src 切到 TS 源码
//
// 为什么要有第二个入口：本套件默认加载根 `client.js`（浏览器跑什么测试就跑什么），
// 而 `tools/dev/mutate.mjs` 改的是 `src/**`——不重新 build 的话产物里根本没有那个改动，
// 于是一整轮变异审计会报告「全部漏过」，而真相是变异没进到被测物。同一个坑在
// `test/snapshot.test.mjs` 的文件头就写着（它存在的理由正是「panel.test.mjs 看不到源码
// 改动」）。src 入口让变异测试能真的打在渲染代码上；artifact 入口仍然是 `npm test`
// 的默认，两个入口跑的是同一批断言。
// ══════════════════════════════════════════════════════════════════════════
const SRC_MODE = process.env.DSH_DOM_TARGET === "src";
const SLUG = "dsh-connect-modelscope-token-plan";

let registration = null;
if (!SRC_MODE) {
  // 与 panel.test.mjs 同一个 loader 捕获口径。
  globalThis.window = { __ModuleLoader__: { load: (reg) => { registration = reg; } } };
  await import(new URL("../client.js", import.meta.url));
  assert.ok(registration, "client.js 必须在加载时调用 window.__ModuleLoader__.load");
  assert.equal(registration.id, SLUG, "REGISTRATION.id = slug");
}

// ══════════════════════════════════════════════════════════════════════════
// §0b 真 DOM + 挂载器
// ══════════════════════════════════════════════════════════════════════════
const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, { pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
// 覆盖 §0a 的 loader 捕获桩（产物在 import 时已拿到 REGISTRATION，之后没人再读 window），
// 并把真 document 交给全局：use-polling-interval 的 hidden() 与 visibilitychange 监听
// 在浏览器里就是这样拿到 document 的。
globalThis.window = window;
globalThis.document = document;

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(["svg", "path", "g", "circle", "ellipse", "line", "polyline", "polygon", "rect", "text", "tspan", "defs", "use", "clipPath", "mask", "linearGradient", "stop"]);
/** style 只应用、不断言（见文件头）：数值 px 归一是 React 的行为，不是被测代码的行为。 */
const UNITLESS = new Set(["opacity", "flex", "flexGrow", "flexShrink", "order", "zIndex", "fontWeight", "lineHeight", "widows", "orphans", "strokeOpacity", "fillOpacity"]);
const EVENT_RE = /^on[A-Z]/;
const IDL_PROPS = new Set(["value", "checked", "disabled", "hidden", "selected", "multiple", "readOnly"]);

const createRenderer = (doc, container) => {
  /** 组件实例：按「路径|组件名」存 hook 槽位（React 的隐式 key 规则）。 */
  const instances = new Map();
  let current = null;
  let pendingEffects = [];
  let rendering = false;
  let scheduled = false;
  let mounted = null;
  let renders = 0;

  const sameDeps = (a, b) => {
    if (a === undefined || b === undefined) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => Object.is(value, b[index]));
  };

  /** 每个 hook 一次槽位；顺序不稳 = 组件违反了 hook 规则，这里直接响。 */
  const hook = (init) => {
    if (current === null) throw new Error("替身 React：在组件之外调用了 hook");
    const index = current.cursor;
    current.cursor += 1;
    if (current.hooks.length <= index) current.hooks.push(init());
    return current.hooks[index];
  };

  const React = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) };
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      // React 不把 key/ref 透进 props。
      delete merged.key;
      delete merged.ref;
      return { __vnode: true, type, props: merged };
    },
    useState(initial) {
      const slot = hook(() => ({ value: typeof initial === "function" ? initial() : initial }));
      const set = (next) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
        schedule();
      };
      return [slot.value, set];
    },
    useRef(initial) {
      return hook(() => ({ current: initial }));
    },
    useMemo(factory, deps) {
      const slot = hook(() => ({ deps: undefined, value: undefined, fresh: false }));
      if (!slot.fresh || !sameDeps(slot.deps, deps)) {
        slot.value = factory();
        slot.deps = deps;
        slot.fresh = true;
      }
      return slot.value;
    },
    useCallback(callback, deps) {
      return React.useMemo(() => callback, deps);
    },
    useEffect(effect, deps) {
      const slot = hook(() => ({ deps: undefined, ran: false, cleanup: undefined }));
      pendingEffects.push({ slot, effect, deps });
    }
  };

  const applyStyle = (el, style) => {
    if (typeof style === "string") {
      el.setAttribute("style", style);
      return;
    }
    if (style === null || typeof style !== "object") return;
    for (const [key, value] of Object.entries(style)) {
      if (value === null || value === undefined || value === false || value === "") continue;
      const numeric = typeof value === "number" && Number.isFinite(value) && !UNITLESS.has(key);
      const prop = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).toLowerCase();
      try {
        el.style.setProperty(prop, numeric ? `${value}px` : String(value));
      } catch { /* cssstyle 不认的属性静默丢：本套件不据此下结论 */ }
    }
  };

  const build = (node, path, inSvg) => {
    if (node === null || node === undefined || node === false || node === true) return null;
    if (Array.isArray(node)) {
      const frag = doc.createDocumentFragment();
      node.forEach((child, index) => {
        const built = build(child, `${path}/${index}`, inSvg);
        if (built !== null) frag.appendChild(built);
      });
      return frag;
    }
    if (typeof node === "string" || typeof node === "number") return doc.createTextNode(String(node));
    if (node.__vnode !== true) return doc.createTextNode(String(node));

    const { type, props } = node;
    if (typeof type === "function") {
      const key = `${path}|${type.name}`;
      let inst = instances.get(key);
      if (inst === undefined) {
        inst = { hooks: [], name: type.name, used: false };
        instances.set(key, inst);
      }
      inst.used = true;
      const outer = current;
      current = inst;
      inst.cursor = 0;
      let out;
      try {
        out = type(props);
      } finally {
        current = outer;
      }
      return build(out, key, inSvg);
    }

    const tag = String(type);
    const svg = inSvg || SVG_TAGS.has(tag);
    const el = svg ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
    let changeHandler = null;
    for (const [name, value] of Object.entries(props)) {
      if (name === "children") continue;
      if (name === "style") {
        applyStyle(el, value);
        continue;
      }
      if (EVENT_RE.test(name) && typeof value === "function") {
        el.addEventListener(name.slice(2).toLowerCase(), value);
        if (name === "onChange") changeHandler = value;
        continue;
      }
      if (svg) {
        // SVG 上 React 一律走 attribute（width/height/viewBox 都不是 style）。
        if (value === null || value === undefined || value === false) continue;
        el.setAttribute(name, String(value));
        continue;
      }
      if (IDL_PROPS.has(name)) {
        el[name] = name === "value" ? String(value ?? "") : Boolean(value);
        continue;
      }
      if (name.startsWith("aria-") || name.startsWith("data-")) {
        // React 对 aria-*/data-* 的布尔量序列化字面量（aria-selected="false" 而非省略）。
        if (value === null || value === undefined) continue;
        el.setAttribute(name, String(value));
        continue;
      }
      if (typeof value === "boolean") {
        if (value) el.setAttribute(name, "");
        continue;
      }
      if (value === null || value === undefined || value === false) continue;
      el.setAttribute(name, String(value));
    }
    // React 的 onChange 在文本类控件上由 `input` 事件驱动（浏览器只在失焦才发 change），
    // 复选框则由 click→change 驱动。绑错这条，「打字后点保存」在测试里就不成立。
    if (changeHandler !== null && (tag === "input" || tag === "textarea")) {
      const inputType = String(props.type ?? "text");
      if (inputType !== "checkbox" && inputType !== "radio" && inputType !== "file") {
        el.addEventListener("input", changeHandler);
      }
    }
    const kids = props.children;
    if (kids !== undefined && kids !== null) {
      const list = Array.isArray(kids) ? kids : [kids];
      list.forEach((child, index) => {
        const built = build(child, `${path}/${tag}/${index}`, svg);
        if (built !== null) el.appendChild(built);
      });
    }
    return el;
  };

  const flushEffects = () => {
    const queue = pendingEffects;
    pendingEffects = [];
    for (const { slot, effect, deps } of queue) {
      if (slot.ran && sameDeps(slot.deps, deps)) continue;
      if (typeof slot.cleanup === "function") slot.cleanup();
      const cleanup = effect();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      slot.deps = deps;
      slot.ran = true;
    }
  };

  /** 这一轮没被渲染到的组件 = 已卸载：跑它的 cleanup（tab 切走时轮询不许留着）。 */
  const prune = () => {
    for (const [key, inst] of instances) {
      if (inst.used) continue;
      for (const slot of inst.hooks) {
        if (slot && typeof slot.cleanup === "function") slot.cleanup();
      }
      instances.delete(key);
    }
  };

  const commit = () => {
    if (mounted === null) return;
    rendering = true;
    try {
      for (const inst of instances.values()) inst.used = false;
      pendingEffects = [];
      renders += 1;
      const built = build(React.createElement(mounted.component, mounted.props), "root", false);
      container.textContent = "";
      if (built !== null) container.appendChild(built);
      prune();
      flushEffects();
    } finally {
      rendering = false;
    }
  };

  const schedule = () => {
    if (mounted === null || rendering || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      commit();
    });
  };

  const runCleanups = () => {
    for (const inst of instances.values()) {
      for (const slot of inst.hooks) {
        if (slot && typeof slot.cleanup === "function") slot.cleanup();
      }
    }
    instances.clear();
  };

  return {
    React,
    mount(component, props) {
      mounted = { component, props };
      commit();
    },
    unmount() {
      // React 的卸载语义：所有 effect 的 cleanup 都要跑（轮询 loop、在途作废、locale 反订阅）。
      runCleanups();
      mounted = null;
      container.textContent = "";
    },
    renders: () => renders
  };
};

const root = document.getElementById("root");
const renderer = createRenderer(document, root);

// ══════════════════════════════════════════════════════════════════════════
// §0c 网络与定时器的可观察替身
// ══════════════════════════════════════════════════════════════════════════
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const liveTimers = new Set();
const timerSpecs = [];
globalThis.setInterval = (fn, ms, ...rest) => {
  const id = realSetInterval(fn, ms, ...rest);
  liveTimers.add(id);
  timerSpecs.push(ms);
  return id;
};
globalThis.clearInterval = (id) => {
  liveTimers.delete(id);
  return realClearInterval(id);
};

const calls = [];
const held = [];
let snapshotResponses = [];
let writeResponses = [];
let defaultSnapshot = { body: null };   // §0e 之后指向 SNAPSHOT
let holdSnapshots = 0;
let holdWrites = 0;

/** 与真 fetch 一致：已作废的请求不返回结果，reject 一个 AbortError。 */
const abortError = () => {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
};

const deliver = (record, descriptor) => {
  if (record.signal?.aborted === true) throw abortError();
  if (descriptor.networkError !== undefined) throw new Error(descriptor.networkError);
  const status = descriptor.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (descriptor.html === true) throw new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`);
      return descriptor.body;
    }
  };
};

globalThis.fetch = async (url, init = {}) => {
  const record = {
    url: String(url),
    method: String(init.method ?? "GET").toUpperCase(),
    body: init.body === undefined ? null : String(init.body),
    signal: init.signal ?? null,
    headers: init.headers ?? null,
    cache: init.cache ?? null
  };
  calls.push(record);
  const isSnapshot = record.method === "GET" && record.url === HOST.SNAPSHOT_PATH;
  const nextDescriptor = () => {
    if (record.method === "POST") return writeResponses.length > 0 ? writeResponses.shift() : { body: { ok: true } };
    if (isSnapshot) return snapshotResponses.length > 0 ? snapshotResponses.shift() : defaultSnapshot;
    return { body: { ok: true } };
  };
  if (isSnapshot && holdSnapshots > 0) {
    holdSnapshots -= 1;
    const descriptor = nextDescriptor();
    return await new Promise((resolve, reject) => { held.push({ record, resolve, reject, descriptor }); });
  }
  if (record.method === "POST" && holdWrites > 0) {
    holdWrites -= 1;
    const descriptor = nextDescriptor();
    return await new Promise((resolve, reject) => { held.push({ record, resolve, reject, descriptor }); });
  }
  return await deliver(record, nextDescriptor());
};

/** 释放第 n 个挂起请求；顺带兑现 fetch 对已作废请求的语义。 */
const releaseHeld = (index) => {
  const entry = held[index];
  assert.ok(entry, `没有第 ${index} 个挂起请求`);
  held.splice(index, 1);
  try {
    entry.resolve(deliver(entry.record, entry.descriptor));
  } catch (why) {
    entry.reject(why);
  }
};
const heldFor = (url) => held.filter((entry) => entry.record.url === url);
const postCalls = (url) => calls.filter((call) => call.method === "POST" && call.url === url);const getCalls = (url) => calls.filter((call) => call.method === "GET" && call.url === url);
const lastPost = (url) => postCalls(url)[postCalls(url).length - 1] ?? null;
const jsonOf = (call) => (call === null || call.body === null ? null : JSON.parse(call.body));
/** 宏任务边界：把替身 React 的微任务重渲染与 fetch 的 promise 链一次排干。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ══════════════════════════════════════════════════════════════════════════
// §0d Host 侧路由集合：动态闭环的对照组（从源码解析，不复用 client 的常量）
// ══════════════════════════════════════════════════════════════════════════
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const HOST = await import("../src/host/routes/paths.ts");
const hostRoutes = new Set(
  [...read("../src/host/routes/paths.ts").matchAll(/["'](\/api\/[a-z0-9/_-]+)["']/g)].map((m) => m[1])
);
for (const m of read("../src/host/routes/provider.ts").matchAll(/`\$\{PROVIDER_PATH\}(\/[a-z/]+)`/g)) {
  hostRoutes.add(`${HOST.PROVIDER_PATH}${m[1]}`);
}
for (const m of read("../src/host/routes/draw.ts").matchAll(/`\$\{DRAW_PATH\}(\/[a-z/]+)`/g)) {
  hostRoutes.add(`${HOST.DRAW_PATH}${m[1]}`);
}
assert.ok(hostRoutes.size >= 8, `Host 侧应解析出至少 8 条路由，实际 ${hostRoutes.size}`);
// roster / reset 是 routes/provider.ts 里 `${PROVIDER_PATH}/xxx` 拼出来的**派生**路由，
// roster / reset 是 routes/provider.ts 里用常量拼出来的**派生**路由（`${PROVIDER_PATH}`
// + "/roster" | "/reset"），paths.ts 没有对应导出——照着它写 `HOST.PROVIDER_ROSTER_PATH`
// 会得到 undefined，于是每条 roster 断言都在拿 undefined 比对 URL，看着像「没发请求」，
// 其实常量不存在。
const PROVIDER_ROSTER_PATH = `${HOST.PROVIDER_PATH}/roster`;
const PROVIDER_RESET_PATH = `${HOST.PROVIDER_PATH}/reset`;
const DRAW_RESET_PATH = `${HOST.DRAW_PATH}/reset`;
for (const [name, value] of Object.entries({ PROVIDER_ROSTER_PATH, PROVIDER_RESET_PATH, DRAW_RESET_PATH })) {
  assert.ok(typeof value === "string" && value.startsWith("/api/"), `${name} 必须是完整的同源路由：${value}`);
  assert.ok(hostRoutes.has(value), `${name} 不在 Host 注册集合里：${value}`);
}
const { HIDE_ALL_MODELS } = await import("../src/client/const.ts");

// ══════════════════════════════════════════════════════════════════════════
// §0e 取被测组件 + fixture
// ══════════════════════════════════════════════════════════════════════════
let PanelPage;
let zh;
if (SRC_MODE) {
  const { provideClientReact } = await import("../src/client/runtime.ts");
  provideClientReact(renderer.React);
  PanelPage = (await import("../src/client/panel-page.ts")).PanelPage;
  zh = (await import("../src/client/i18n.ts")).zh;
  assert.equal((await import("../src/client/const.ts")).PANEL_ID, SLUG, "src 入口：PANEL_ID = slug");
} else {
  const { panel } = registration.factory(() => renderer.React);
  PanelPage = panel.components.PanelPage;
  zh = panel.dictionaries.zh;
}
const tt = (key) => zh[key];

const row = (id, name, extra = {}) => ({ id, name, vision: false, available: true, quotaExhausted: false, ...extra });
const DEEPSEEK = "deepseek-ai/DeepSeek-V3";
const QWEN = "Qwen/Qwen3-8B";
const GLM = "ZhipuAI/GLM-4.5-Air";

const SNAPSHOT = {
  ok: true,
  name: SLUG,
  version: "0.2.0",
  now: "2026-10-15T00:00:00Z",
  pollSeconds: 30,
  cacheSeconds: 60,
  token: { present: true, source: "credentials", valid: null, checkedAt: null, ephemeral: false, readError: null },
  balance: { available: 143, total: 143, frozen: 0, fetchedAt: null, error: null },
  quota: { daily: { usedLocal: 7 }, perModel: [{ modelId: QWEN, calls: 5, tokens: 1200 }], countingNote: "local-counting" },
  events: [{ at: "2026-10-14T09:00:00Z", modelId: QWEN, kind: "rate_limit", message: "429 from upstream" }],
  trend: { days: 14, buckets: [{ dateKey: "2026-10-14", calls: 3, tokens: 900 }, { dateKey: "2026-10-15", calls: 4, tokens: 300 }] },
  models: { available: true, count: 35, sample: [DEEPSEEK], error: null },
  provider: {
    enabled: false, source: "config", llmAvailable: true, registered: false, error: null,
    modelCount: 3, enabledCount: 1, allowed: "list", enabledIds: [QWEN],
    roster: [row(DEEPSEEK, "DeepSeek V3", { vision: true }), row(QWEN, "Qwen3 8B"), row(GLM, "GLM-4.5-Air", { available: false, quotaExhausted: true })]
  },
  draw: {
    enabled: false, source: "config", candidateIds: ["Qwen/Qwen-Image"], candidateCount: 1,
    preferredModel: null, preferredSource: "config", absentReason: null, mountPending: false,
    toolName: "modelscope_draw_image"
  },
  shapeWarnings: [],
  quotaError: null
};
defaultSnapshot = { body: SNAPSHOT };
const snapshotWith = (over = {}) => ({ ...SNAPSHOT, ...over });
/** 余额块换成别的数字（选互不含子串的值，避免 `includes` 误命中）。 */
const snapshotBalance = (available) => snapshotWith({ balance: { ...SNAPSHOT.balance, available, total: available } });

const q = (selector) => document.querySelector(selector);
const qa = (selector) => [...document.querySelectorAll(selector)];
const bodyText = () => document.body.textContent;
const byText = (selector, want) => qa(selector).find((el) => el.textContent.trim() === want);
const buttons = () => qa("button");
const tabButton = (key) => byText('[role="tab"]', tt(key));
/** roster 复选框每次重渲染都是新节点，所以每次都要重新取。 */
const rosterChecks = () => qa('input[type="checkbox"][aria-label]');
const toggleSwitches = () => qa('input[type="checkbox"]:not([aria-label])');
const sectionBody = (titleKey) => {
  const head = buttons().find((el) => el.textContent.trim() === tt(titleKey));
  return head?.nextElementSibling ?? null;
};

// ══════════════════════════════════════════════════════════════════════════
// §1 页面在真 DOM 里成型（结构、属性序列化、文本卫生、SVG 命名空间、折叠 hidden）
// ══════════════════════════════════════════════════════════════════════════
const subscribed = [];
const unsubscribed = [];
renderer.mount(PanelPage, {
  tt,
  localeSubscribe: (fn) => {
    subscribed.push(fn);
    return () => { unsubscribed.push(fn); };
  }
});
await settle();

assert.ok(q(`[data-dsh-plugin="${SLUG}"]`), "根节点带 data-dsh-plugin 标记（真 attribute）");
const tabs = qa('[role="tablist"] [role="tab"]');
assert.equal(tabs.length, 3, "tablist 下三个真 tab");
assert.deepEqual(tabs.map((el) => el.tagName), ["BUTTON", "BUTTON", "BUTTON"], "role=tab 落在 button 上，不是 div 冒充");
const selected = qa('[role="tab"][aria-selected="true"]');
assert.equal(selected.length, 1, "恰有一个 tab 处于选中态");
assert.equal(selected[0].textContent.trim(), tt("tab.quota"), "默认停在额度 tab");
assert.equal(tabs[1].getAttribute("aria-selected"), "false", "aria-selected=false 序列化字面量（React 语义），不是被省略");
// 卡片体经 SectionCard 的 children 落到 DOM —— 替身 React 下这一段从未被渲染过。
assert.match(bodyText(), /143/, "余额 143 经 children 上了真 DOM");
for (const junk of ["NaN", "undefined", "[object Object]", "Infinity"]) {
  assert.ok(!bodyText().includes(junk), `文本卫生：DOM 里不得出现 ${junk}`);
}
const chevron = q("svg");
assert.ok(chevron, "折叠 chevron 是 SVG 元素");
assert.equal(chevron.namespaceURI, SVG_NS, "svg 必须在 SVG 命名空间里（HTML 命名空间的 <svg> 不是真 SVG）");
assert.equal(chevron.getAttribute("viewBox"), "0 0 16 16", "viewBox 按 SVG attribute 原样大小写落地");
assert.equal(chevron.getAttribute("width"), "14", "SVG 上的数字 width 走 attribute，不是 style");
assert.ok(chevron.firstElementChild, "svg 里有子元素（path）");
// 折叠中的 section：events 默认 open=false → body 不渲染 + 兄弟 div 带 hidden。
const collapsed = buttons().filter((el) => el.getAttribute("aria-label")?.startsWith(tt("section.expand")));
assert.equal(collapsed.length, 1, "只有一个 section 默认折叠（限流与错误事件）");
assert.equal(collapsed[0].getAttribute("aria-expanded"), "false", "折叠头部 aria-expanded=false");
assert.equal(collapsed[0].nextElementSibling.hidden, true, "折叠的 section body 带 hidden");
assert.ok(!bodyText().includes("429 from upstream"), "折叠体的内容不在 DOM 里（open=false 时 children 不渲染）");
assert.equal(qa('[aria-label^="' + tt("section.collapse") + '"]')[0].nextElementSibling.hidden, false, "展开的 section body 不 hidden");
const usageLink = q(`a[href^="https://modelscope.cn/magicube/usage"]`);
assert.ok(usageLink, "魔粒用量外链存在");
assert.equal(usageLink.getAttribute("target"), "_blank");
assert.equal(usageLink.getAttribute("rel"), "noreferrer", "外链带 rel=noreferrer（令牌域名页不得带 referer）");
assert.equal(qa('[role="alert"]').length, 0, "健康快照上没有错误行");

// ══════════════════════════════════════════════════════════════════════════
// §2 挂载副作用真的跑了：首轮轮询 + 定时器 + locale 订阅
// ══════════════════════════════════════════════════════════════════════════
assert.equal(getCalls(HOST.SNAPSHOT_PATH).length, 1, "挂载即发首轮快照（effect 真跑了，不是替身里的空函数）");
// 首帧 data 还是 null（数据要等轮询回来），所以 provider 与 draw 的**兜底 GET**各发
// 一发——这是浏览器里真实发生的一帧，替身套件看不见。快照带回两个块之后就不该再发。
assert.equal(calls.length, 3, "挂载三发：快照 + provider 兜底 + draw 兜底");
assert.equal(getCalls(HOST.PROVIDER_PATH).length, 1, "provider 兜底 GET 只有一发");
assert.equal(getCalls(HOST.DRAW_PATH).length, 1, "draw 兜底 GET 只有一发");
assert.equal(calls[0].cache, "no-store", "轮询绕开 HTTP 缓存");
assert.ok(calls[0].signal, "轮询带 AbortController signal（卸载/顶替要作废它）");
assert.equal(liveTimers.size, 1, "挂载起了且只起了一个轮询 interval");
assert.deepEqual(timerSpecs, [30000], "cadence 取自 fixture 声明的 pollSeconds=30 → 30000ms");
assert.equal(subscribed.length, 1, "locale 订阅发生在挂载副作用里");
await settle();
// 快照带回 provider / draw 两个块之后，hasProviderBlock 变 true，effect 直接 return：
// 兜底 GET 不该每一轮轮询都再来一发（pollRevision 是它的依赖）。
assert.equal(getCalls(HOST.PROVIDER_PATH).length, 1, "有快照块后不再重复 provider 兜底 GET");
assert.equal(getCalls(HOST.DRAW_PATH).length, 1, "有快照块后不再重复 draw 兜底 GET");

// ══════════════════════════════════════════════════════════════════════════
// §3 tab 切换 = 真重渲染（替身 React 的一次性 useState 做不到这件事）
// ══════════════════════════════════════════════════════════════════════════
const rendersBefore = renderer.renders();
tabButton("tab.access").click();
await settle();
assert.ok(renderer.renders() > rendersBefore, "点击触发了重渲染");
assert.equal(qa('[role="tab"][aria-selected="true"]')[0].textContent.trim(), tt("tab.access"), "选中态跟着移动");
const tokenInput = q('input[type="password"]');
assert.ok(tokenInput, "接入 tab 的令牌输入框出现在真 DOM 里");
assert.equal(tokenInput.getAttribute("aria-label"), tt("token.ariaLabel"));
assert.equal(tokenInput.value, "", "受控输入初始为空");
assert.ok(byText("button", tt("token.forget")), "token.present=true → 渲染「忘掉已保存」");
assert.ok(byText("button", tt("probe.validity")), "models.sample 非空 → 渲染「验令牌」");
assert.equal(tabs.length, 3, "tab 栏仍在（重建后仍是三条）");

// ══════════════════════════════════════════════════════════════════════════
// §4 打字 → POST /token 带的是打进 DOM 的那个值（input→state→payload 整条链）
// ══════════════════════════════════════════════════════════════════════════
const TOKEN_VALUE = "ms-secret-token-123";
q('input[type="password"]').value = TOKEN_VALUE;
q('input[type="password"]').dispatchEvent(new window.Event("input", { bubbles: true }));
await settle();
assert.equal(q('input[type="password"]').value, TOKEN_VALUE, "打字回流到 state（重渲染后 DOM 仍显示它）");
const snapshotGetBefore = getCalls(HOST.SNAPSHOT_PATH).length;
byText("button", tt("token.save")).click();
await settle();
const saved = lastPost(HOST.TOKEN_PATH);
assert.ok(saved, "点「保存」真的 POST 了 /token");
assert.deepEqual(jsonOf(saved), { token: TOKEN_VALUE }, "payload 里是 DOM 中输入的值（不是空串、不是 state 初值）");
assert.equal(saved.headers?.["content-type"], "application/json", "写路径带 JSON 头");
assert.equal(saved.cache, "no-store", "写路径也绕开缓存");
await settle();
assert.equal(q('input[type="password"]').value, "", '保存后输入框清空（handler 的 setValue("") 生效）');
assert.ok(getCalls(HOST.SNAPSHOT_PATH).length > snapshotGetBefore, "写成功即刷新快照（不做乐观更新）");

// §4b busy 期间真的禁用了控件，且真浏览器语义下点不动（写盘在途，故意扣住响应）
holdWrites = 1;
byText("button", tt("token.save")).click();
await settle();
assert.equal(byText("button", tt("token.save")).disabled, true, "写盘在途时保存按钮 disabled");
const postsWhileBusy = postCalls(HOST.TOKEN_PATH).length;
byText("button", tt("token.save")).click();
await settle();
assert.equal(postCalls(HOST.TOKEN_PATH).length, postsWhileBusy, "disabled 的按钮点不动（禁用控件收不到 click）");
releaseHeld(0);
await settle();
assert.equal(byText("button", tt("token.save")).disabled, false, "写盘结束后 disabled 撤掉");

// ══════════════════════════════════════════════════════════════════════════
// §5 忘掉令牌 / 验令牌：两条路由都由真实点击产生
// ══════════════════════════════════════════════════════════════════════════
byText("button", tt("token.forget")).click();
await settle();
assert.ok(lastPost(HOST.TOKEN_FORGET_PATH), "「忘掉已保存」POST /token/forget");
assert.deepEqual(jsonOf(lastPost(HOST.TOKEN_FORGET_PATH)), {}, "forget 的 payload 是空对象");
byText("button", tt("probe.validity")).click();
await settle();
assert.deepEqual(jsonOf(lastPost(HOST.PROBE_PATH)), { modelId: DEEPSEEK }, "验令牌 POST /probe 带目录样本的 modelId");

// ══════════════════════════════════════════════════════════════════════════
// §6 折叠这个 section，它的表单真的从 DOM 里消失、再展开又回来
// ══════════════════════════════════════════════════════════════════════════
const tokenHead = () => buttons().find((el) => el.getAttribute("aria-label") === `${tt("section.collapse")}: ${tt("section.token")}`);
tokenHead().click();
await settle();
assert.equal(q('input[type="password"]'), null, "折叠后表单不留在 DOM 里（children 随 open 一起不渲染）");
assert.equal(sectionBody("section.token").hidden, true, "折叠后 body 带 hidden");
buttons().find((el) => el.getAttribute("aria-label") === `${tt("section.expand")}: ${tt("section.token")}`).click();
await settle();
assert.ok(q('input[type="password"]'), "再展开又回来了");

// ══════════════════════════════════════════════════════════════════════════
// §7 模型 tab：两个开关与 roster 的 checkbox 在 DOM 里可区分（toggle-switch 的契约）
// ══════════════════════════════════════════════════════════════════════════
tabButton("tab.models").click();
await settle();
// toggle-switch.ts 写着：开关内层的 input 不写 aria-label（隐式 label 命名），roster
// 复选框写 aria-label = 模型 id。那条契约在真 DOM 里的落点就是下面这两行。
assert.equal(toggleSwitches().length, 2, "provider 与出图各一个滑杆开关");
assert.deepEqual(rosterChecks().map((el) => el.getAttribute("aria-label")), [DEEPSEEK, QWEN, GLM], "roster 每行一个复选框，aria-label = 模型 id");
assert.equal(rosterChecks()[2].disabled, true, "额度耗尽的行 disabled（灰显但不从清单里删）");
assert.equal(rosterChecks()[1].checked, true, "enabledIds 命中的行勾中");
assert.equal(rosterChecks()[0].checked, false, "未命中的行不勾");
assert.match(bodyText(), /已启用 1 \/ 3/, "已启用计数上屏");
assert.match(bodyText(), /视觉/, "vision 行带「视觉」标记");
assert.match(bodyText(), /推荐/, "FEATURED_OWNERS 的 owner 带「推荐」标记");
holdWrites = 1;
toggleSwitches()[0].click();
await settle();
assert.deepEqual(jsonOf(lastPost(HOST.PROVIDER_PATH)), { enabled: true }, "翻 provider 开关：POST /provider 且发的是**翻转后**的值");
assert.equal(toggleSwitches()[0].disabled, true, "写盘在途时开关 disabled");
assert.ok(bodyText().includes(tt("provider.busy")), "开关标签换成「切换中…」");
assert.equal(rosterChecks()[0].disabled, true, "同一张卡的复选框也随 busy 禁用（两张卡各有一套 busy 才有意义）");
releaseHeld(0);
await settle();
assert.equal(toggleSwitches()[0].disabled, false, "写盘结束后开关恢复可用");
// 不做乐观更新：POST 只回 ok:true，面板上的开关状态由**刷新回来的快照**决定，而默认
// fixture 里 provider 仍是关的。写成功就把标签翻成「已接入」是面板对 Host 撒谎。
assert.equal(toggleSwitches()[0].closest("label").textContent.trim(), tt("provider.off"), "写成功后仍显示 Host 回显的值（不做乐观更新）");
// 下一次刷新带回 enabled=true，标签与「下次启动才生效」那句才该出现。
snapshotResponses = [{ body: snapshotWith({ draw: { ...SNAPSHOT.draw, enabled: true, mountPending: true } }) }];
toggleSwitches()[1].click();
await settle();
assert.deepEqual(jsonOf(lastPost(HOST.DRAW_PATH)), { enabled: true }, "出图开关 POST /draw（与 provider 各自一条路由）");
assert.equal(toggleSwitches()[1].closest("label").textContent.trim(), tt("draw.on"), "回显 enabled=true → 标签「已开启」");
assert.ok(bodyText().includes(tt("draw.restartHint")), "enabled=true 的出图卡把「下次 Host 启动才挂载」说出来");

// ══════════════════════════════════════════════════════════════════════════
// §8 哨兵独占态：全部隐藏 → 发纯哨兵；勾一个真实模型即退出哨兵再保存
// ══════════════════════════════════════════════════════════════════════════
byText("button", tt("provider.hideAll")).click();
await settle();
assert.deepEqual(jsonOf(lastPost(PROVIDER_ROSTER_PATH)), { enabledIds: [HIDE_ALL_MODELS] }, "「全部隐藏」发哨兵，不混排真实 id");
assert.match(bodyText(), /已启用 0 \/ 3/, "哨兵态下计数为 0（与 Host 的「含哨兵即 none」同口径）");
assert.ok(rosterChecks().every((el) => el.checked === false), "哨兵态下没有任何一行画成勾中");
rosterChecks()[0].click();
await settle();
assert.equal(rosterChecks()[0].checked, true, "勾一个真实模型 → 该行画成勾中");
byText("button", tt("provider.saveList")).click();
await settle();
assert.deepEqual(jsonOf(lastPost(PROVIDER_ROSTER_PATH)), { enabledIds: [DEEPSEEK] }, "勾一个真实模型必须退出哨兵态（曾经的混排 bug：UI 说 1 个、Host 落 0 个）");
byText("button", tt("provider.allowAll")).click();
await settle();
assert.deepEqual(jsonOf(lastPost(PROVIDER_ROSTER_PATH))?.enabledIds?.slice()?.sort(), [DEEPSEEK, GLM, QWEN].sort(), "「全部」发整份 roster ids");
// 额度耗尽那行是禁用的：真 DOM 里点它不该改动清单。
const beforeUnusable = rosterChecks()[2].checked;
rosterChecks()[2].click();
await settle();
assert.equal(rosterChecks()[2].checked, beforeUnusable, "禁用行点不动，勾选态不变");

// ══════════════════════════════════════════════════════════════════════════
// §9 两个「回到默认」（同一个字样、两条不同路由）
// ══════════════════════════════════════════════════════════════════════════
const resetButtons = () => buttons().filter((el) => el.textContent.trim() === tt("provider.reset"));
assert.equal(tt("provider.reset"), tt("draw.reset"), "两张卡的按钮同名（正因如此必须分别点）");
assert.equal(resetButtons().length, 2, "provider 与出图各有一个「回到默认」");
resetButtons()[0].click();
await settle();
assert.ok(lastPost(PROVIDER_RESET_PATH), "上面那个是 provider 的：POST /provider/reset");
assert.deepEqual(jsonOf(lastPost(PROVIDER_RESET_PATH)), {}, "reset 的 payload 是空对象");
resetButtons()[1].click();
await settle();
assert.ok(lastPost(DRAW_RESET_PATH), "下面那个是出图的：POST /draw/reset");

// ══════════════════════════════════════════════════════════════════════════
// §10 动态闭环：每一次真实请求打的 URL 都在 Host 注册的路由集合里
// ══════════════════════════════════════════════════════════════════════════
const touched = new Set(calls.map((call) => call.url));
for (const url of touched) {
  assert.ok(hostRoutes.has(url), `面板真的请求了 ${url}，而 Host 没注册它——点下去就是 404`);
}
for (const needed of [HOST.SNAPSHOT_PATH, HOST.TOKEN_PATH, HOST.TOKEN_FORGET_PATH, HOST.PROBE_PATH, HOST.PROVIDER_PATH, PROVIDER_ROSTER_PATH, PROVIDER_RESET_PATH, HOST.DRAW_PATH, DRAW_RESET_PATH]) {
  assert.ok(touched.has(needed), `九条面板路由都应被真实点击覆盖过，缺 ${needed}`);
}
assert.ok(hostRoutes.has(PROVIDER_ROSTER_PATH) && hostRoutes.has(DRAW_RESET_PATH), "派生路由（roster/reset）也在对照组里（M4 曾整族漏）");

// ══════════════════════════════════════════════════════════════════════════
// §11 写失败必须上屏：Host 恒回 HTTP 200 + ok:false，界面上不许「什么都没发生」
// ══════════════════════════════════════════════════════════════════════════
writeResponses = [{ body: { ok: false, error: "credentials file is read-only" } }];
tabButton("tab.access").click();
await settle();
byText("button", tt("token.forget")).click();
await settle();
assert.ok(buttons().some((el) => el.textContent.trim() === tt("token.forget")), "失败后按钮还在（不是一闪而没）");
const alertRow = qa('[role="alert"]').find((el) => el.textContent.includes("read-only"));
assert.ok(alertRow, "写盘失败以 role=alert 现形，透出的正是 Host 那句原因");
assert.equal(byText("button", tt("token.save")).disabled, false, "失败也要清 busy（finally 分支）");

// ══════════════════════════════════════════════════════════════════════════
// §12 generation guard：慢的一发不许覆盖快的；自己的顶替不算故障
// ══════════════════════════════════════════════════════════════════════════
tabButton("tab.quota").click();
await settle();
holdSnapshots = 2;
snapshotResponses = [{ body: snapshotBalance(823) }, { body: snapshotBalance(611) }];
const refresh = () => byText("button", tt("panel.refresh")).click();
refresh();
await settle();
refresh();
await settle();
assert.equal(held.length, 2, "两发快照都挂在途");
const slow = heldFor(HOST.SNAPSHOT_PATH)[0];
assert.equal(slow.record.signal.aborted, true, "第二发把第一发 abort 了（顶替，不是并行）");
releaseHeld(1);
await settle();
const balanceText = () => sectionBody("section.balance")?.textContent ?? "";
assert.ok(balanceText().includes("611"), "快的响应（611）上了余额格");
assert.ok(!balanceText().includes("823"), "慢的一发还没回，屏上不该有它的数");
releaseHeld(0);
await settle();
assert.ok(balanceText().includes("611"), "慢的一发落地后也没把屏幕倒回旧值");
assert.ok(!balanceText().includes("823"), "被 abort 的那一发不写 data");
assert.equal(qa('[role="alert"], [role="status"]').filter((el) => el.textContent.includes("aborted")).length, 0, "自己的顶替不写错误行");

// ══════════════════════════════════════════════════════════════════════════
// §13 隐藏暂停 / 可见恢复 / 失败退避（use-polling-interval 的 document 分支）
// ══════════════════════════════════════════════════════════════════════════
let visible = true;
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (visible ? "visible" : "hidden") });
const snapshotsBeforeHidden = getCalls(HOST.SNAPSHOT_PATH).length;
visible = false;
document.dispatchEvent(new window.Event("visibilitychange"));
await settle();
assert.equal(liveTimers.size, 0, "切到后台即 clearInterval（后台窗口不该满速打 Host）");
visible = true;
document.dispatchEvent(new window.Event("visibilitychange"));
await settle();
assert.equal(liveTimers.size, 1, "回到前台重新起一个 interval");
assert.ok(getCalls(HOST.SNAPSHOT_PATH).length > snapshotsBeforeHidden, "回到前台先补一发（不让屏幕停在隐藏前的旧数）");
// 失败退避：Host 读不到的那一轮，cadence 必须慢到 ERROR_BACKOFF 以上。
// 排队**两发**失败：loop 重建时会立刻补发一次 fire()，只喂一发的话第二发拿到的是成功
// 快照，`setError(null)` 会在同一次 settle 里把错误行擦掉（那是对的客户端行为，
// 只是让它没法被我观察到）。
const specsBeforeFailure = timerSpecs.length;
snapshotResponses = [{ networkError: "host is down" }, { networkError: "host is down" }];
refresh();
await settle();
assert.ok(timerSpecs.length > specsBeforeFailure, "失败后轮询 loop 重建过（failed 进了依赖）");
assert.ok(Math.max(...timerSpecs.slice(specsBeforeFailure)) >= 60_000, "失败退避到至少 60s（不得低于健康 cadence）");
assert.ok(q('[title*="host is down"]'), "连续失败仍要在面板上留一句原因原文（不是静默重试）");

// ══════════════════════════════════════════════════════════════════════════
// §14 卸载即停：interval 清掉、在途作废、locale 反订阅，之后不再有任何请求
// ══════════════════════════════════════════════════════════════════════════
holdSnapshots = 1;
snapshotResponses = [{ body: snapshotBalance(5) }];
refresh();
await settle();
assert.equal(held.length, 1, "卸载前有一发在途");
const inFlight = held[0];
renderer.unmount();
await settle();
assert.equal(inFlight.record.signal.aborted, true, "卸载作废在途请求（面板关了还在打 Host 就是泄漏）");
assert.equal(liveTimers.size, 0, "卸载清掉轮询 interval");
assert.equal(unsubscribed.length, 1, "locale 订阅在卸载时反订阅");
assert.equal(root.children.length, 0, "容器清空");
const callsAtUnmount = calls.length;
visible = false;
document.dispatchEvent(new window.Event("visibilitychange"));
visible = true;
document.dispatchEvent(new window.Event("visibilitychange"));
await settle();
assert.equal(calls.length, callsAtUnmount, "卸载后的可见性变化不再产生请求");

// ══════════════════════════════════════════════════════════════════════════
// §15 目录没有样本模型时验令牌按钮不渲染（诚实降级，不猜模型名）
// ══════════════════════════════════════════════════════════════════════════
snapshotResponses = [{ body: snapshotWith({ models: { available: true, count: 0, sample: [], error: null } }) }];
renderer.mount(PanelPage, { tt, localeSubscribe: null });
await settle();
tabButton("tab.access").click();
await settle();
assert.ok(q('input[type="password"]'), "重新挂载后表单仍在");
assert.equal(byText("button", tt("probe.validity")), undefined, "models.sample 为空 → 没有验令牌按钮（宁可漏，不肯猜）");
assert.ok(byText("button", tt("token.save")), "保存按钮不受影响");
renderer.unmount();
await settle();

// ══════════════════════════════════════════════════════════════════════════
// §16 Host 被登录墙/代理劫持（body 是 HTML）：不得把 HTML 源码画进面板
//
// 排队**两发**的理由与 §13 相同：`failed` 从 false 变 true 会让 loop 的 deps 变化、
// effect 重建，而重建里带着一次立刻补发——只喂一发的话第二发拿到成功快照，
// `setError(null)` 会在同一次 settle 里把错误行擦掉。
// ══════════════════════════════════════════════════════════════════════════
snapshotResponses = [{ html: true }, { html: true }];
const snapshotsBeforeHijack = getCalls(HOST.SNAPSHOT_PATH).length;
renderer.mount(PanelPage, { tt, localeSubscribe: null });
await settle();
assert.ok(bodyText().includes(tt("panel.payloadError")), "非 JSON 响应读作 payload_error 那句人话");
assert.ok(!bodyText().includes("<!DOCTYPE"), "HTML 源码没有进面板正文");
assert.ok(q('[role="alert"]'), "读不懂的载荷以 role=alert 呈现，不是静默空白");
assert.equal(getCalls(HOST.SNAPSHOT_PATH).length - snapshotsBeforeHijack, 2, "失败让 loop 重建并立刻补发一次（有界重试）");
await settle();
assert.equal(getCalls(HOST.SNAPSHOT_PATH).length - snapshotsBeforeHijack, 2, "同一档失败不连环补发（不是重试风暴）");
assert.equal(liveTimers.size, 1, "这一档挂载仍只有一个 interval");
renderer.unmount();
await settle();
assert.equal(liveTimers.size, 0, "所有挂载点都收干净了（没有留着跑完测试进程的定时器）");

// ══════════════════════════════════════════════════════════════════════════
// §17 契约漂移要看得见：Host 少给顶层键时，面板渲染「空」**并且**说出缺了哪个键
//
// panel.test.mjs §3b 钉的是 `interpretSnapshot` / `viewOf` 的返回值（决策层）；
// 这里钉的是那句话真的上了屏。缺了这一步的后果是「静默画空」：余额变成「—」、
// 趋势变成空，而没人知道是上游形状变了还是自己今天真的没调用过。
// ══════════════════════════════════════════════════════════════════════════
const drifted = { ...SNAPSHOT };
delete drifted.trend;
snapshotResponses = [{ body: drifted }];
renderer.mount(PanelPage, { tt, localeSubscribe: null });
await settle();
const driftPrefix = tt("panel.shapeDrift").replace("{detail}", "");
assert.ok(bodyText().includes(driftPrefix), "缺键进了面板上的「结构可能有变」那一行");
assert.ok(bodyText().includes("trend"), "缺的键名本身也上屏（运维能据此对上 Host 侧日志）");
assert.ok(byText("button", tt("section.balance")), "缺 trend 不影响别的区块：余额卡头部仍在");
assert.ok(bodyText().includes(tt("trend.none")), "缺的块被补成空形状：趋势画成「无数据」而不是崩");
assert.ok(bodyText().includes("143"), "缺 trend 不影响余额块照常显示");
renderer.unmount();
await settle();

globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
console.log(`dom-render.test.mjs: all checks passed（${calls.length} 次真实请求，${renderer.renders()} 次重渲染）`);
