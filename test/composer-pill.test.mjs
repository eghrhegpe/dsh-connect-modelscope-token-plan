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
      staleOf: pill.staleOf,
      newModelsOf: pill.newModelsOf
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
  // 内层现在返回**锚壳**（`<span>`），触发器是它唯一的子节点：面板要跟触发器
  // 做兄弟（`<button>` 里塞 `role="dialog"` 是非法嵌套），所以外面多一层锚。
  // 注意替身 createElement 把 children 放在 `.children` 上（真 React 放
  // `props.children`），所以这里读 `.children`。
  assert.equal(inner.type, "span", "内层渲染一个锚壳（面板必须是触发器的兄弟）");
  assert.equal(inner.props.className, "dsh-modelscope-composer-pill-anchor", "锚壳 className 是测试选择器，别改名");
  const trigger = inner.children[0];
  assert.equal(trigger.type, "button", "锚壳里第一个子节点是触发器 button");
  assert.equal(trigger.props.className, "dsh-modelscope-composer-pill", "className 是测试选择器，别改名");
  assert.equal(trigger.props["aria-haspopup"], "dialog", "触发器声明它拥有一个面板");
  assert.equal(trigger.props["aria-expanded"], false, "默认收起");
  assert.equal(trigger.props["aria-controls"], undefined, "收起时不指 aria-controls（指向不存在的节点是坏引用）");
  assert.equal(typeof trigger.props.onClick, "function", "点触发器必须能展开");
  const flat = JSON.stringify(trigger);
  assert.ok(flat.includes("…"), "首帧还没读到数据时正文是「读取中」，不是 0");
  assert.ok(!flat.includes("0 魔粒"), "首帧绝不能把「还没读到」画成 0 魔粒");
  assert.ok(trigger.props.title.includes(zh["composer.pillTitle"]), "tooltip 必须带标题那句");
  // 默认收起：面板不挂（锚壳的第二个 child 是 null——替身 createElement 不
  // 过滤 null 子节点，真 React 会把它略过）。
  assert.equal(inner.children.length, 2, "锚壳恰好两个子节点位：触发器 + 面板位");
  assert.equal(inner.children[1], null, "收起时面板位是 null");
  // 替身 React 下数据恒为 null → newModelIds 为空 → 第三段不画。
  assert.ok(!flat.includes(zh["composer.newModels"]), "没有新模型时不画第三段（0 新模型是噪声）");
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
  for (const name of [
    "pillTrigger",
    "pillDot",
    "pillPlan",
    "pillStale",
    "pillTierOk",
    "pillTierExhausted",
    "pillTierUnknown",
    "pillTierExhaustedText",
    // 0.6.6 展开面板族 + 第三段。
    "pillNewTag",
    "pillPopoverAnchor",
    "pillPopover",
    "pillPopoverHead",
    "pillPopoverTitle",
    "pillPopoverStale",
    "pillPopoverRow",
    "pillPopoverRowLine",
    "pillPopoverLabel",
    "pillPopoverFigure",
    "pillPopoverNote"
  ]) {
    assert.ok(S[name] !== undefined, `styles.ts 必须有 ${name}（胶囊外观全在这一族里）`);
  }
  // 宿主工具栏尺度。
  assert.equal(S.pillTrigger.height, 28, "胶囊按宿主工具栏的 28px 定尺度");
  assert.equal(S.pillTrigger.display, "inline-flex");
  // 胶囊现在可点（点开详情面板），所以光标必须是手型——一个能点的东西不给
  // 手型，用户根本不会去点它。
  assert.equal(S.pillTrigger.cursor, "pointer", "可点就必须给手型光标");
  // 面板向上弹：胶囊在输入框工具栏，向下会盖住正在打的草稿。
  assert.equal(S.pillPopover.bottom, "100%", "面板必须向上弹，不许盖住草稿");
  assert.equal(S.pillPopover.position, "absolute");
  assert.equal(S.pillPopover.right, 0, "面板右缘对齐胶囊右缘");
  assert.equal(S.pillPopoverAnchor.position, "relative", "锚必须是面板绝对定位的参照系");
  assert.equal(S.pillPopoverAnchor.display, "inline-flex");
  // 面板不写死主题色（同胶囊正文的纪律）：底色与字色都取宿主 token。
  assert.ok(String(S.pillPopover.background).includes("--dsw-alias-"), "面板底色取宿主 token，不写死");
  assert.ok(String(S.pillPopover.color).includes("--dsw-alias-"), "面板字色取宿主 token，不写死");
  // 第三段是旁注，不能比读数更抢眼：secondary 一档，且不许是正文字色。
  assert.ok(String(S.pillNewTag.color).includes("--dsw-alias-label-secondary"), "「N 新模型」压暗到 secondary");
  // 这条是渲染坑的防线：写成 border:"none" 时 UA 的 border-image 仍会画出框；
  // borderStyle:"none" + borderWidth:0 分开写才是真的无框。
  assert.equal(S.pillTrigger.borderStyle, "none", "无框必须走 borderStyle（不是 border 简写）");
  assert.equal(S.pillTrigger.borderWidth, 0);
  assert.equal(S.pillTrigger.border, undefined, "不要用 border 简写——UA border-image 会画出一个框");
  assert.equal(S.pillTierExhaustedText.color, "var(--dsw-alias-state-error-primary)", "耗尽档正文取宿主告警 token，不写死 hex");
  assert.equal(new Set([S.pillTierOk, S.pillTierExhausted, S.pillTierUnknown]).size, 3, "三档墨色必须互不相同");
}

// ── §5 「· N 新模型」：清单净味与口径 ───────────────────────────────────────
{
  const { newModelsOf } = helpers;

  // 老 Host / 降级快照：没有这个字段时是空清单，不是抛。
  assert.deepEqual(newModelsOf(null), []);
  assert.deepEqual(newModelsOf(undefined), []);
  assert.deepEqual(newModelsOf({}), []);
  assert.deepEqual(newModelsOf({ provider: {} }), []);
  assert.deepEqual(newModelsOf({ provider: { newModelIds: null } }), []);
  assert.deepEqual(newModelsOf({ provider: { newModelIds: "Qwen/Qwen3-8B" } }), [], "字符串不是清单");
  assert.deepEqual(newModelsOf({ provider: { newModelIds: { a: 1 } } }), [], "对象不是清单");

  // 正常清单原样保留（含顺序——Host 侧按首见时间升序给）。
  assert.deepEqual(newModelsOf({ provider: { newModelIds: ["b", "a"] } }), ["b", "a"]);

  // 三道净味：非字符串、空串/纯空白、重复。任何一条漏掉都会让面板画出一个
  // 空名字的行，或者把「3 个新模型」写成 4 行同名。
  assert.deepEqual(newModelsOf({ provider: { newModelIds: ["a", null, "b"] } }), ["a", "b"], "非字符串丢掉");
  assert.deepEqual(newModelsOf({ provider: { newModelIds: ["a", "", "   ", "b"] } }), ["a", "b"], "空串与纯空白丢掉");
  assert.deepEqual(newModelsOf({ provider: { newModelIds: [" a ", "a", "b"] } }), ["a", "b"], "去重前先 trim");
  assert.deepEqual(newModelsOf({ provider: { newModelIds: ["a", 1, "a"] } }), ["a"], "非字符串不参与去重判定");

  // 口径文案：**不许**出现「新增 / new in gateway」这类把本机观察说成上游事实的措辞。
  assert.equal(zh["composer.newModels"], "新模型");
  assert.ok(zh["composer.newModelsNote"].includes("本机"), "中文注脚必须说清是「本机」首见");
  assert.ok(!zh["composer.newModelsNote"].includes("网关新增"), "注脚不许写成「网关新增」");
  assert.ok(zh["composer.newModelsNote"].includes("7"), "注脚必须写明窗口是 7 天");
  assert.ok(en["composer.newModelsNote"].includes("this device"), "英文注脚同样要说 this device");
  assert.ok(!en["composer.newModelsNote"].includes("newly added by"), "英文注脚不许写成上游新增");
  assert.ok(zh["composer.newModelsTitle"].endsWith("："), "tooltip 前缀以全角冒号收尾（后面直接接名字）");
  assert.ok(en["composer.newModelsTitle"].endsWith(": "), "英文 tooltip 前缀以「: 」收尾");

  // 面板文案键：键集必须 zh/en 同时在场（en 是 typeof zh，缺键即编译错；这条是
  // 运行期再兜一次，防止有人把 en 的值写成 undefined）。
  for (const key of [
    "composer.panelTitle",
    "composer.panelBalance",
    "composer.panelCalls",
    "composer.panelNote",
    "composer.newModels",
    "composer.newModelsRow",
    "composer.newModelsTitle",
    "composer.newModelsSep",
    "composer.newModelsNote"
  ]) {
    assert.equal(typeof zh[key], "string", `${key} 必须在 zh 里`);
    assert.equal(typeof en[key], "string", `${key} 必须在 en 里`);
    assert.ok(zh[key] !== "", `${key} 的 zh 不许是空串`);
    assert.ok(en[key] !== "", `${key} 的 en 不许是空串`);
  }
}

console.log("composer-pill.test.mjs: all checks passed");
