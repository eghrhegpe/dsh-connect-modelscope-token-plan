/**
 * Theme-token-only styles; a renamed token degrades looks, never rendering.
 */

/**
 * The plugin's brand color, spelled once. The shell may expose
 * `--modelscope-brand` (tabs under a branded theme); the hex fallback keeps the
 * accent identical in shells that do not. One literal, four consumers —
 * previously the fallback was re-spelled at each use (including one bare hex in
 * toggle-switch.ts), so a rebrand left a third of the accent behind.
 */
export const BRAND = "var(--modelscope-brand, #7B3FF2)";

/** The shared button skin; `rosterBulk` reuses it one step taller so the bulk
 *  buttons sit level with the 32px roster search box. */
const BUTTON = { height: 30, padding: "0 12px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", fontSize: 13, cursor: "pointer" };
export const S = {
  // The config card is embedded inside the Plugins page
  // (`plugins.bundle.config` slot). The host page provides outer margins,
  // so this root only needs flex layout and overflow clipping: the pinned
  // header stays flex-none and `scroll` (flex:1, min-height:0) takes the
  // overflow. Without this chain the card grows past its container and
  // the host silently truncates everything below the fold.
  page: { flex: "1 1 auto", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", color: "var(--dsw-alias-label-primary)", fontSize: 14, lineHeight: "22px" },
  headerBar: { flex: "none", background: "var(--dsw-alias-bg-base)", position: "relative", zIndex: 1 },
  header: { display: "flex", alignItems: "center", gap: 12, padding: "16px 0 12px" },
  scroll: { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" },
  content: { padding: "6px 0 56px" },
  // Two fixed perspectives — daily quota reading vs. one-off API wiring —
  // so the setup cards stop crowding the numbers the panel exists for.
  tabBar: { display: "flex", gap: 4, borderBottom: "1px solid var(--dsw-alias-border-l1)", marginBottom: 4 },
  // 焦点环与下划线是两种不同状态，不冲突：下划线说「当前选中」，焦点环说
  // 「当前可操作」。早期版本写 `outline: "none"` 是想压掉外壳给被点击按钮盖的
  // 白色焦点环（觉得那是第二种 active 语言），但内联样式的 outline: none 优先级
  // 高于任何非 !important 规则——结果把键盘焦点环也一起压掉了，键盘用户扫到
  // tab 时什么都看不到。这里改用 outlineOffset 把焦点环向内收一点，保留可见性。
  tab: { appearance: "none", background: "none", border: "none", borderBottom: "2px solid transparent", padding: "8px 12px", fontSize: 13, color: "var(--dsw-alias-label-secondary)", cursor: "pointer", outlineOffset: -2 },
  tabActive: { color: "var(--dsw-alias-label-primary)", fontWeight: 600, borderBottom: `2px solid ${BRAND}` },
  title: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: "28px" },
  updated: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 },
  spacer: { flex: 1 },
  // The active tab's status cluster on the right of the pinned header: a
  // compact row (更新于 + chip + banner + 刷新) that stays put while the body
  // scrolls. `inline-flex` lets it shrink instead of pushing the title off.
  cluster: { display: "inline-flex", alignItems: "center", gap: 12, flexWrap: "wrap", justifyContent: "flex-end" },
  button: BUTTON,
  sectionTitle: { margin: "22px 0 10px", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-secondary)" },
  // Content sections are workbuddy-style collapsible cards: a bordered
  // card whose header is a full-width button (title + rotating chevron).
  // `PanelPage` starts both sections expanded; the reader can tuck one
  // away to focus on the other.
  sectionCard: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden", marginTop: 22 },
  sectionHead: { display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left" },
  sectionHeadTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
  chevron: { display: "inline-flex", flex: "none", transition: "transform 0.15s ease", color: "var(--dsw-alias-label-secondary)" },
  chevronOpen: { transform: "rotate(180deg)" },
  sectionBody: { borderTop: "1px solid var(--dsw-alias-border-l1)", margin: "0 16px", padding: "12px 0 16px" },
  card: { background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, padding: 16 },
  poolName: { fontSize: 15, fontWeight: 600 },
  quotaLabel: { fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-secondary)" },
  // 魔粒余额的拆分卡片：auto-fit 每列至少 110px（放得下最长的标签而不折行），
  // 窄面板下堆叠。110px 这个下限是量出来的，不是随手取的。
  statGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 110px), 1fr))", gap: 10, marginTop: 12 },
  // 拆分卡片用 layer-2 底色（而不是第四层嵌套边框）表达从属关系。
  statCard: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0, padding: "10px 12px", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)" },
  // The part's figure is the point of the card; the name under it is the label,
  // so the big number leads and the label never competes with it.
  statValue: { fontSize: 16, fontWeight: 600, lineHeight: "20px", fontVariantNumeric: "tabular-nums" },
  // 已用次数的安静脚注（占满一行，窄面板下不会与别的数字挤在一行）。
  quotaUsed: { fontSize: 11, lineHeight: "15px", color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
  barFill: { height: "100%", borderRadius: 3, background: BRAND },
  modelTag: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 11, padding: "2px 6px", borderRadius: 6, background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l1)" },
  trendRow: { display: "flex", flexDirection: "column", gap: 8, padding: "10px 0", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
  trendRowHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, minWidth: 0 },
  trendModel: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  trendCredits: { fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  // 趋势卡的轨道用 layer-2，与卡片自身的 layer-1 形成一格台阶差。
  trendBar: { height: 6, borderRadius: 3, background: "var(--dsw-alias-bg-layer-2)", overflow: "hidden" },
  // The legend under the bars: quiet secondary text, lifted a little off
  // the last row's divider so it reads as a caption, not another data row.
  trendLegend: { marginTop: 10, fontSize: 11, lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
  // 天桶趋势的**竖向柱状图**（与姊妹插件 Agnes 的用量图同形）：柱子等比铺满宽度，
  // 高按区间内最大值相对显示；只有首末日期做轴，逐日读数走每根柱的 title/aria。
  // 柱色与横向条同一枚品牌色，沿用趋势卡同一套 token，不新开一套配色。
  trendChartBars: { display: "flex", alignItems: "flex-end", gap: 2, height: 96, padding: "0 1px" },
  // `position: relative` 是承重：次数标签绝对定位在**这根柱的坐标系**里，`bottom`
  // 由调用方按柱高算（见 cards.ts 的 TrendBars），标签于是骑在柱顶而不是另起一行。
  trendChartBar: { flex: 1, minWidth: 2, height: "100%", display: "flex", alignItems: "flex-end", position: "relative" },
  trendChartFill: { width: "100%", minHeight: 2, borderRadius: 2, background: BRAND },
  // 骑在柱顶的次数标签：9px、单行高、不吃指针事件（悬停仍归柱自己的 title）。
  trendChartValue: { position: "absolute", left: 0, right: 0, fontSize: 9, lineHeight: 1, textAlign: "center", color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums", pointerEvents: "none" },
  trendChartAxis: { display: "flex", justifyContent: "space-between", gap: 12, marginTop: 6, fontSize: 11, color: "var(--dsw-alias-label-secondary)" },
  muted: { color: "var(--dsw-alias-label-secondary)" },
  error: { color: "var(--dsw-alias-state-error-primary)" },
  empty: { color: "var(--dsw-alias-label-secondary)", padding: "18px 0" },
  input: {
    height: 32, padding: "0 10px", borderRadius: 8, fontSize: 13,
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-bg-layer-1)",
    color: "var(--dsw-alias-label-primary)"
  },
  /** Real shell tokens — replaces the color-mix hack that faked "on-primary". */
  primary: {
    height: 32, padding: "0 16px", borderRadius: 8, fontSize: 13, fontWeight: 500,
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-button-primary-fill)",
    color: "var(--dsw-alias-label-primary-foreground)", cursor: "pointer"
  },
  formError: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, margin: "10px 0 0" },
  formNote: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, margin: "10px 0 0" },
  // The model picker: a search box, then one flat row per model. The section
  // card owns the ONLY frame — a border per row was a card inside a card and
  // flattened the hierarchy (WorkBuddy lesson: inner elements never re-draw
  // the outer box). Badges read by background step alone, and a badge marks a
  // NOTABLE state only: "text only" is the default and earns nothing.
  rosterTools: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 },
  rosterCount: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums", marginLeft: "auto" },
  rosterBulk: { ...BUTTON, height: 32 },
  modelList: { display: "flex", flexDirection: "column", margin: 0, padding: 0, listStyle: "none" },
  // Head line over the parameter line: the divider separates rows without a
  // box, the padding keeps the whole row as the visual unit.
  modelRow: { display: "flex", flexDirection: "column", gap: 2, padding: "8px 4px", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
  modelRowHead: { display: "flex", alignItems: "center", gap: 8 },
  modelRowOff: { opacity: 0.55 },
  modelCheck: { flex: "none", width: 15, height: 15, cursor: "pointer", accentColor: BRAND, margin: 0 },
  // `0 1 auto` (not `1 1 auto`): the name hugs the rate chip instead of
  // stretching to the right edge; the label shrinks, so ellipsis still works.
  modelName: { flex: "0 1 auto", minWidth: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  modelBadge: { flex: "none", fontSize: 11, padding: "1px 7px", borderRadius: 999, background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)" },
  // 推荐（deepseek/glm/qwen 三家）与「视觉」**同构**：同一枚 pill，不改行背景、
  // 不加左边线、不动名字字号——推荐是一个事实标签，不是一次整行高亮。整行染色
  // 把三行拉成「被选中的行」，而它们只是一批里的三批模型；标签只标这一条。
  modelBadgeFeatured: { flex: "none", fontSize: 11, padding: "1px 7px", borderRadius: 999, background: "var(--dsw-alias-bg-layer-2)", color: BRAND, fontWeight: 600 },
  rosterFoot: { display: "flex", gap: 8, alignItems: "center", marginTop: 10 },
  // A roster's own frame — one step INSIDE the section card. The rule above
  // still holds (rows draw no box of their own; the divider separates them),
  // but "one frame per level" is about not repeating the SAME frame, not about
  // leaving a whole list adrift: this panel keeps every list inside its section card
  // block that already wears a card, and an unframed list beside a framed one
  // read as an unfinished half rather than as a deliberate hierarchy.
  modelPanel: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)", padding: "12px 14px" },

  // ── 对话框用量胶囊（conversation.input.right 座席）──────────────────────────
  // 这一族按**宿主输入框工具栏**的尺度定：28px 高 / 12px 字 / 无框 / 透明底，
  // 不按本插件自己的卡片尺度（那是 13px 字 + 1px 框）。本插件不注入样式表
  // （同 toggle-switch.ts 的裁定），所以这些是 inline style；颜色只取宿主 token，
  // 换肤与明暗随之走，一个写死的主题色都不留。
  //
  // `borderStyle: "none"` 与 `borderWidth: 0` 必须**分开写**：写成
  // `border: "none"` 时 UA 的 border-image 仍会画出一圈框（jsdom 还会把
  // `border: 0` 解成非法值），胶囊于是带着一个本不该存在的方块，而它在
  // `getComputedStyle` 之外看不出来是哪儿来的。
  pillTrigger: {
    appearance: "none",
    WebkitAppearance: "none",
    height: 28,
    borderStyle: "none",
    borderWidth: 0,
    background: "none",
    // 显式 inherit：`<button>` 的 UA 默认字色是 ButtonText，在深色外壳里会
    // 自己变黑，跟工具栏其它图标不是一套墨。
    color: "inherit",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "0 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    lineHeight: "18px",
    // 胶囊本身没有点击行为（tooltip 才是它的内容），所以不给手型光标，
    // 也不给它按钮的按下反馈——但保留可聚焦：键盘用户聚焦后能读到
    // aria-label 里的来源与口径说明。
    cursor: "default",
    flexShrink: 0,
    whiteSpace: "nowrap"
  },
  pillDot: { width: 8, height: 8, borderRadius: 999, flex: "none", background: "var(--dsw-alias-label-secondary)" },
  // 套餐 / 来源前缀压暗一档：它是「这些数字属于谁」的注脚，不是读数本身。
  pillPlan: { opacity: 0.72 },
  // 「上次数据」：斜体 + 更淡，弱到不抢读数，又明确到不会被当成当前值。
  pillStale: { opacity: 0.62, fontStyle: "italic" },
  // 三档墨色（绿 / 红 / 灰）。**没有黄色**：黄色在姊妹插件里表示「已用 ≥80%」，
  // 而魔粒余额没有官方上限，任何「低于 N 魔粒算黄」的阈值都是本插件凭空发明的
  // 分母。要么绿（读数是正数）、要么红（官方给的读数确实是 0）、要么灰（读不到）。
  pillTierOk: "#22c55e",
  pillTierExhausted: "#ef4444",
  pillTierUnknown: "#9ca3af",
  // 只有余额读数确实为 0 时才把正文染成告警色——健康读数保持 inherit。
  pillTierExhaustedText: { color: "var(--dsw-alias-state-error-primary)" }
};