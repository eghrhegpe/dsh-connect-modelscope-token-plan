/**
 * composer-pill.test.mjs —— 对话框用量胶囊的离线门禁（纯规则面）。
 *
 * 分工：真 reconciler 下的渲染、DOM 结构与样式落地由 `test/dom-render-react.test.mjs`
 * 负责；本套件只钉**不需要 DOM 就能钉死**的四类：
 *   §1 接线：座席 id 与实际注册次数（同一座席注册两份 = 屏幕上真会出现两个胶囊）；
 *   §2 门控：provider 归属判定（含「空 next 不许遮住可用的 lastUsed」）；
 *   §3 口径：**null ≠ 0**、三档定级、两段文案、陈旧判定；
 *   §4 字典与样式族：键在 zh/en 都在、正文自带「本地」二字、pill* 族存在。
 *
 * 两个入口（同 `test/dom-render.test.mjs` / `dom-render-react.test.mjs`）：
 * 默认被测物是**构建产物** `client.js`（浏览器跑什么测试就跑什么，改完 src/ 必须先
 * `npm run build`）；`DSH_DOM_TARGET=src` 切到 TS 源码，**变异审计必须走这一档**
 * ——变异改的是 src，产物入口看不见它，整份审计会假绿（见 tools/dev/README.md）。
 *
 * @module test/composer-pill
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

/** 最小替身 React：hook 全为单次取值，effect 不跑（所以不会发网络请求）。 */
const stubReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? null, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (make) => make(),
  useRef: (value) => ({ current: value })
};

const SRC_MODE = process.env.DSH_DOM_TARGET === "src";
let panel;
if (SRC_MODE) {
  const { provideClientReact } = await import("../src/client/runtime.ts");
  provideClientReact(stubReact);
  const pill = await import("../src/client/composer-usage-pill.ts");
  const { zh, en } = await import("../src/client/i18n.ts");
  const { S } = await import("../src/client/styles.ts");
  panel = {
    dictionaries: { zh, en },
    styles: S,
    helpers: {
      MODELSCOPE_PROVIDER: pill.MODELSCOPE_PROVIDER,
      selectedProviderOf: pill.selectedProviderOf,
      availableOf: pill.availableOf,
      usedTodayOf: pill.usedTodayOf,
      tierOf: pill.tierOf,
      balanceText: pill.balanceText,
      callsText: pill.callsText,
      readingText: pill.readingText,
      staleOf: pill.staleOf
    },
    components: { ComposerUsagePill: pill.ComposerUsagePill, ModelscopePill: pill.ModelscopePill }
  };
} else {
  /** 捕获版 loader：在 import 产物之前装到 globalThis.window 上。 */
  let registration = null;
  globalThis.window = { __ModuleLoader__: { load: (reg) => { registration = reg; } } };
  await import(new URL("../client.js", import.meta.url));
  assert.ok(registration, "client.js 必须在加载时调用 window.__ModuleLoader__.load");
  panel = registration.factory(() => stubReact).panel;
}

const { zh, en } = panel.dictionaries;
const { helpers, components } = panel;
const ttZh = (key) => zh[key];
const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

// ── §1 接线 ────────────────────────────────────────────────────────────────
{
  const applySrc = read("src/client/apply.ts");
  const pillSrc = read("src/client/composer-usage-pill.ts");
  const indexSrc = read("src/client/index.ts");

  // 座席 id 与注册次数。宿主把该座席声明为 kind:"list"，所以「注册两份」不会被
  // 去重挡住——那就是两个胶囊并排，这里必须钉住数量。
  const registrations = applySrc.match(/slots\.inject\("conversation\.input\.right"/g) ?? [];
  assert.equal(registrations.length, 1, "conversation.input.right 只能注册一次（多一次就多一个胶囊）");
  assert.ok(applySrc.includes("${NS}-composer-pill"), "登记 id 必须带 -composer-pill 后缀（与配置卡的 id 区分开）");
  assert.ok(applySrc.includes("ComposerUsagePill"), "apply.ts 必须挂真的胶囊组件，不是占位");
  assert.ok(pillSrc.includes("conversation.input.right"), "胶囊模块头部必须写明它占哪个座席");
  assert.ok(indexSrc.includes("ComposerUsagePill"), "index.ts 必须把胶囊放进测试面（产物入口才看得见）");

  // provider 字面量与 Host 侧同一个常量。客户端不能 import host 模块，所以这条
  // 一致性只能靠静态读取核对——拼错一处就是「接入了魔搭模型但胶囊永不出现」。
  const hostSrc = read("src/host/llm-models.ts");
  const hostId = hostSrc.match(/export const LLM_PROVIDER_ID = "([^"]+)"/)?.[1];
  assert.ok(hostId, "必须能从 src/host/llm-models.ts 读到 LLM_PROVIDER_ID");
  assert.equal(helpers.MODELSCOPE_PROVIDER, hostId, "胶囊认领的 provider 必须与 Host 注册的 provider id 逐字一致");
  assert.ok(pillSrc.includes("modelscope-token-plan"), "胶囊源码里的值要可读（别只靠 import）");
}

// ── §2 门控：谁是归属 provider ──────────────────────────────────────────────
{
  const providers = (projection) => helpers.selectedProviderOf(projection);
  assert.equal(providers({ next: { provider: helpers.MODELSCOPE_PROVIDER } }), helpers.MODELSCOPE_PROVIDER);
  assert.equal(providers({ lastUsed: { provider: helpers.MODELSCOPE_PROVIDER } }), helpers.MODELSCOPE_PROVIDER);
  assert.equal(providers({ next: { provider: "" }, lastUsed: { provider: helpers.MODELSCOPE_PROVIDER } }), helpers.MODELSCOPE_PROVIDER);
  assert.equal(providers({ next: null, lastUsed: { provider: helpers.MODELSCOPE_PROVIDER } }), helpers.MODELSCOPE_PROVIDER);
  // picker 刚切完、新选择还没落到 next 上的那几帧：next 是 {}，不许遮住 lastUsed。
  assert.equal(providers({ next: {}, lastUsed: { provider: helpers.MODELSCOPE_PROVIDER } }), helpers.MODELSCOPE_PROVIDER);
  // 真的切到别人时，门控必须让位。
  assert.equal(providers({ next: { provider: "sensenova-token-plan" }, lastUsed: { provider: helpers.MODELSCOPE_PROVIDER } }), "sensenova-token-plan");
  assert.equal(providers({ next: { model: "Qwen/Qwen3-8B" } }), undefined, "只有 model 没有 provider 时不可判定");
  assert.equal(providers({ next: { provider: "" } }), undefined, "空串不是 provider");
  assert.equal(providers(undefined), undefined);
  assert.equal(providers({ next: null, lastUsed: null }), undefined);

  // 非归属会话：外层完全不渲染（也就不会跑任何请求）。
  const foreign = components.ComposerUsagePill({ tt: ttZh, useProjection: () => ({ next: { provider: "other-provider" } }) });
  assert.equal(foreign, null, "非归属 provider 必须整块缺席");
  // 没有投影源（Node 侧、或槽位没物化）时同样不渲染，不抛。
  assert.equal(components.ComposerUsagePill({ tt: ttZh }), null, "没有 useProjection 时不渲染也不抛");

  // 归属会话：外层挂上内层组件（门控在组件边界，所以这里拿到的是一个组件引用，
  // 不是 DOM 节点——DOM 结构由真 reconciler 那套钉）。替身 React 下数据恒为 null，
  // 所以内层正文是「读取中」，正好用来钉「首帧不是 0」。
  const tree = components.ComposerUsagePill({
    tt: ttZh,
    useProjection: () => ({ next: { provider: helpers.MODELSCOPE_PROVIDER } })
  });
  assert.ok(tree, "归属会话必须挂内层胶囊");
  assert.equal(typeof tree.type, "function", "外层返回的是内层组件（hook 都在内层，切模型不踩 hook 顺序）");
  const inner = tree.type({ tt: ttZh });
  assert.equal(inner.type, "button", "内层渲染一个 button");
  assert.equal(inner.props.className, "dsh-modelscope-composer-pill", "className 是测试选择器，别改名");
  const flat = JSON.stringify(inner);
  assert.ok(flat.includes("…"), "首帧还没读到数据时正文是「读取中」，不是 0");
  assert.ok(!flat.includes("0 魔粒"), "首帧绝不能把「还没读到」画成 0 魔粒");
  assert.ok(inner.props.title.includes(zh["composer.pillTitle"]), "tooltip 必须带标题那句");
}

// ── §3 口径：null ≠ 0、定档、文案、陈旧 ─────────────────────────────────────
{
  const { availableOf, usedTodayOf, tierOf, balanceText, callsText, readingText, staleOf } = helpers;

  // 读不到 ≠ 0。只接受有限数；字符串 / NaN / undefined / 缺失一律 null。
  assert.equal(availableOf(null), null);
  assert.equal(availableOf(undefined), null);
  assert.equal(availableOf({ available: null, total: 143, frozen: 0, fetchedAt: null, error: null }), null);
  assert.equal(availableOf({ available: 0, total: 0, frozen: 0, fetchedAt: null, error: null }), 0, "0 是读数：余额确实耗尽");
  assert.equal(availableOf({ available: "143" }), null, "字符串不是数字");
  assert.equal(availableOf({ available: Number.NaN }), null);
  assert.equal(availableOf({ available: Number.POSITIVE_INFINITY }), null);

  assert.equal(usedTodayOf(null), null);
  assert.equal(usedTodayOf({ quota: { daily: { usedLocal: 0 } } }), 0, "0 次是读数：今天确实没调用");
  assert.equal(usedTodayOf({ quota: { daily: { usedLocal: null } } }), null);
  assert.equal(usedTodayOf({ quota: {} }), null);
  assert.equal(usedTodayOf({ quota: { daily: { usedLocal: "7" } } }), null, "字符串不是数字");

  assert.equal(tierOf(null), "unknown", "读不到 → 灰");
  assert.equal(tierOf(0), "exhausted", "官方读数确实是 0 → 红");
  assert.equal(tierOf(1), "ok");
  assert.equal(tierOf(143), "ok");
  // 没有「低额=黄」这一档：魔粒余额没有官方上限，任何阈值都是本插件发明的。
  assert.equal(tierOf(1), "ok", "1 魔粒仍是绿——没有官方阈值可以拿它判黄");

  assert.equal(balanceText(143, ttZh), "143 魔粒");
  assert.equal(balanceText(0, ttZh), "0 魔粒", "0 不许画成 —");
  assert.equal(balanceText(null, ttZh), "— 魔粒", "读不到才画 —");
  assert.ok(callsText(7, ttZh).includes("7"), "次数进正文");
  assert.ok(callsText(null, ttZh).includes("—"), "次数读不到画 —");
  assert.equal(readingText(143, 7, ttZh), "143 魔粒 · 今日本地 7 次");
  assert.equal(readingText(0, 0, ttZh), "0 魔粒 · 今日本地 0 次", "两个 0 都是读数，都要画出来");
  assert.ok(readingText(null, null, ttZh).startsWith("— 魔粒"), "两段同时读不到时仍是两段");

  // 陈旧判定：从没读到过不算陈旧（没有「上次」可谈）；读到过之后，失败或超过
  // 3 个声明周期才算。`hasReading` 是承重输入——`updatedAt > 0` 只说明**曾经**
  // 读到过，读失败时轮询 hook 会清空 data 却保留 updatedAt（只看 updatedAt 会在
  // 两个读数都是「—」时挂上「上次数据」，标签描述一份不在屏幕上的数据；完整经过
  // 见 docs/archive/2026-10-19-0.6.3-process.md §十一 ⑤）。
  const cadence = 30_000;
  assert.equal(staleOf({ error: null, hasReading: false, updatedAt: 0, now: 1_000_000, cadenceMs: cadence }), false, "从没读到 ≠ 陈旧");
  assert.equal(staleOf({ error: "boom", hasReading: false, updatedAt: 0, now: 1_000_000, cadenceMs: cadence }), false, "没有读数就没有陈旧读数");
  assert.equal(staleOf({ error: "boom", hasReading: false, updatedAt: 1_000, now: 1_100, cadenceMs: cadence }), false, "本帧没读数（data 被清空）→ 不标陈旧，屏幕上没有「上次的数」可留");
  assert.equal(staleOf({ error: null, hasReading: true, updatedAt: 1_000, now: 1_000 + cadence, cadenceMs: cadence }), false, "刚读过不陈旧");
  assert.equal(staleOf({ error: null, hasReading: true, updatedAt: 1_000, now: 1_000 + cadence * 3, cadenceMs: cadence }), false, "整 3 个周期仍算边界内（严格大于）");
  assert.equal(staleOf({ error: null, hasReading: true, updatedAt: 1_000, now: 1_001 + cadence * 3, cadenceMs: cadence }), true, "超过 3 个周期算陈旧");
  assert.equal(staleOf({ error: "boom", hasReading: true, updatedAt: 1_000, now: 1_100, cadenceMs: cadence }), true, "有读数 + 读失败即陈旧（屏幕上留着上一轮的数）");
  // Host 改声明周期，「多久算陈旧」必须跟着改。
  assert.equal(staleOf({ error: null, hasReading: true, updatedAt: 1_000, now: 1_000 + 100_000, cadenceMs: 60_000 }), false, "cadence 60s 时 100s 还不算陈旧");
}

// ── §4 字典与样式族 ────────────────────────────────────────────────────────
{
  const keys = ["composer.prefix", "composer.pillTitle", "composer.balanceUnit", "composer.localCalls", "composer.stale"];
  for (const key of keys) {
    assert.equal(typeof zh[key], "string", `${key} 必须在 zh 里（键集的真源）`);
    assert.equal(typeof en[key], "string", `${key} 必须在 en 里（en 是 typeof zh，缺键即编译错）`);
  }
  // 第二个数字必须自带「本地」口径：它是本插件自己的日桶，官方接口没有这一项。
  assert.ok(zh["composer.localCalls"].includes("本地"), "中文正文必须写「本地」——否则会被读成官方计数");
  assert.ok(en["composer.localCalls"].includes("local"), "英文正文必须写 local");
  assert.ok(zh["composer.localCalls"].includes("{calls}"), "次数占位符叫 {calls}（format 按名替换）");
  assert.ok(en["composer.localCalls"].includes("{calls}"));
  assert.ok(!zh["composer.balanceUnit"].includes("本地"), "余额段不标本地：它是官方数据");

  const S = panel.styles;
  for (const name of ["pillTrigger", "pillDot", "pillPlan", "pillStale", "pillTierOk", "pillTierExhausted", "pillTierUnknown", "pillTierExhaustedText"]) {
    assert.ok(S[name] !== undefined, `styles.ts 必须有 ${name}（胶囊外观全在这一族里）`);
  }
  // 宿主工具栏尺度。
  assert.equal(S.pillTrigger.height, 28, "胶囊按宿主工具栏的 28px 定尺度");
  assert.equal(S.pillTrigger.display, "inline-flex");
  // 这条是渲染坑的防线：写成 border:"none" 时 UA 的 border-image 仍会画出框；
  // borderStyle:"none" + borderWidth:0 分开写才是真的无框。
  assert.equal(S.pillTrigger.borderStyle, "none", "无框必须走 borderStyle（不是 border 简写）");
  assert.equal(S.pillTrigger.borderWidth, 0);
  assert.equal(S.pillTrigger.border, undefined, "不要用 border 简写——UA border-image 会画出一个框");
  assert.equal(S.pillTierExhaustedText.color, "var(--dsw-alias-state-error-primary)", "耗尽档正文取宿主告警 token，不写死 hex");
  assert.equal(new Set([S.pillTierOk, S.pillTierExhausted, S.pillTierUnknown]).size, 3, "三档墨色必须互不相同");
}

console.log("composer-pill.test.mjs: all checks passed");
