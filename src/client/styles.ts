/**
 * Theme-token-only styles; a renamed token degrades looks, never rendering.
 */

/**
 * The plugin's brand color, spelled once. The shell may expose
 * `--modelscope-brand` (tabs under a branded theme); the hex fallback keeps the
 * accent identical in shells that do not. One literal, three consumers —
 * previously the fallback was re-spelled at each use, so a rebrand left a
 * third of the accent behind.
 */
const BRAND = "var(--modelscope-brand, #7B3FF2)";

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
  // `outline: none` because the shell stamps its own white focus ring on
  // every clicked button — a second "active" language that fought this one:
  // the tabs share the same underline language (lesson from the sister plugin fork:
  // a second white-box accent fought this one). The underline + weight below IS the active state, visible
  // without a ring; keyboard users keep the aria-selected semantics.
  tab: { appearance: "none", background: "none", border: "none", borderBottom: "2px solid transparent", padding: "8px 12px", fontSize: 13, color: "var(--dsw-alias-label-secondary)", cursor: "pointer", outline: "none" },
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
  // Pool cards live in the responsive `poolsGrid` (gap owns the spacing),
  // so the card itself carries no bottom margin.
  card: { background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, padding: 16 },
  // Responsive deck of pool cards: each column is at least 320px and the
  // row reflows on narrow panels instead of overflowing.
  poolsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 12, alignItems: "start" },
  cardHead: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  poolName: { fontSize: 15, fontWeight: 600 },
  chip: { display: "inline-flex", alignItems: "center", height: 22, padding: "0 8px", borderRadius: 999, fontSize: 12, border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)" },
  // The grant balance is money the user can still spend, so it reads as a
  // metric, not a decoration: right-aligned tabular figures on the card's
  // own line, no chip frame. A pill here gave a headline number the same
  // weight as the static type label beside it.
  grantChip: { display: "inline-flex", alignItems: "center", fontSize: 13, color: "var(--dsw-alias-label-primary)", fontVariantNumeric: "tabular-nums" },
  // The two quota windows sit side by side as twin sub-cards, stacking
  // when the card gets narrower than ~2*170px (170 leaves room for the
  // longest "used x / limit" caption beside the headline figures).
  quotas: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))", gap: 10, marginTop: 14 },
  // The twin quota windows float on a darker surface (layer-2) rather than
  // a third nested border: the section card owns the outer frame and the
  // pool card owns the inner one, so the sub-window reads by background
  // step alone. A border here made three equal-weight rectangles inside
  // each other and flattened the hierarchy it was meant to express.
  quota: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0, padding: "12px 14px", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)" },
  // `flexWrap` because the reset stamp can grow to `MM-DD HH:mm`: in a narrow
  // twin column the label and the date no longer share a row, and the date is
  // the one part of the line that must never be clipped.
  quotaTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  quotaLabel: { fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-secondary)" },
  // The second upstream's balance is the same KIND of fact a quota headline is
  // — the number the user came to read — so it borrows the quota headline's
  // weight (18 / 650 / tabular) rather than the run-on meta line it used to
  // ride in. The balance headline is the number the user came to read, so it
  // owns its own card; that independence was never a licence to skip the type
  // scale, and a headline spelled in 12px secondary text is how a tab reads as
  // unfinished next to its siblings.
  statHeadline: { fontSize: 18, lineHeight: "22px", fontWeight: 650, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" },
  // A quiet secondary label for a headline's own caption line (the declared
  // split, the credential clocks). It is the same stop `quotaLabel` uses, so a
  // number and its caption read as one unit across both upstreams.
  statCaption: { fontSize: 11, lineHeight: "15px", color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
  // A headline figure that IS the alarm, not decoration: a balance at zero
  // must say so at the same weight the bar's error tone does. There is no warn
  // band here on purpose — the quota headline has one because a PERCENTAGE has
  // honest thresholds, while an absolute credit figure's normal magnitude is
  // not something this client is told, so any "low" cut would be a number
  // invented below the wire.
  statError: { color: "var(--dsw-alias-state-error-primary)" },
  // The balance split, as a deck of min-width cards:
  // the same responsive rule `poolsGrid` and `quotas` own (auto-fit, each
  // column at least N px, row reflows instead of overflowing). 110px is the
  // floor that fits the longest label ("奖励") beside its figure without
  // dropping it to a second line, and it stacks to 2×2 or a single column on a
  // narrow panel. One run-on `每日 600 · 奖励 8344 · 月度 0 · 充值 0` line read as
  // a comma list of four different facts with no place to separate them.
  statGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 110px), 1fr))", gap: 10, marginTop: 12 },
  // A grid card rides on the card's own step — the balance headline gives
  // the deck the same layer-2 the quota twin gets, so a part reads by
  // background alone rather than as a fourth nested border.
  statCard: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0, padding: "10px 12px", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)" },
  // The part's figure is the point of the card; the name under it is the label,
  // so the big number leads and the label never competes with it.
  statValue: { fontSize: 16, fontWeight: 600, lineHeight: "20px", fontVariantNumeric: "tabular-nums" },
  quotaReset: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" },
  // The usage PERCENTAGE is the headline — the same number the bar below
  // draws, so the pair can never point in opposite directions. Tabular
  // figures keep it still while polling.
  quotaRemaining: { fontSize: 18, lineHeight: "22px", fontWeight: 650, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" },
  // used/limit is a single quiet caption under the bar (its own full row,
  // so the figures row never wraps on a narrow twin card).
  quotaUsed: { fontSize: 11, lineHeight: "15px", color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
  bar: { height: 6, borderRadius: 3, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 3, background: BRAND },
  barFillWarn: { background: "var(--dsw-alias-state-warn-primary)" },
  barFillError: { background: "var(--dsw-alias-state-error-primary)" },
  // Secondary bookkeeping (grant expiry, model coverage) folds away so a
  // card's open state is just its name, the twin quotas, and nothing else.
  details: { marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--dsw-alias-border-l1)" },
  detailsSummary: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", cursor: "pointer", userSelect: "none" },
  detailsBody: { display: "flex", flexDirection: "column", gap: 10, marginTop: 10 },
  grant: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
  models: { display: "flex", flexWrap: "wrap", gap: 6 },
  modelTag: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 11, padding: "2px 6px", borderRadius: 6, background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l1)" },
  // The per-model consumption card: a label row over one horizontal-bar
  // row per model. The bar is relative to the LARGEST consumer — the
  // chart answers "which model is burning credits" — so the top model
  // fills the track and the rest shrink proportionally; the absolute
  // number stays right-aligned beside the model name.
  trendHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, paddingBottom: 6, borderBottom: "1px solid var(--dsw-alias-border-l1)" },
  trendHeadLabel: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", fontWeight: 500 },
  trendRow: { display: "flex", flexDirection: "column", gap: 8, padding: "10px 0", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
  trendRowHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, minWidth: 0 },
  // 目录里「好用三家」(deepseek/glm/qwen) 的高亮：左边线 + 轻微底色 + 圆角 +
  // ★ 标记 + 品牌色加粗名。只改视觉，不抢层级（section card 仍是唯一外框）。
  trendRowFeatured: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, minWidth: 0, borderLeft: `2px solid ${BRAND}`, paddingLeft: 8, background: "var(--dsw-alias-bg-layer-2)", borderRadius: "0 6px 6px 0" },
  catalogStar: { flex: "none", width: 14, textAlign: "center", fontSize: 12, lineHeight: 1, color: BRAND },
  trendModel: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  trendModelFeatured: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: BRAND, fontWeight: 600 },
  trendCredits: { fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  // The trend card sits on layer-1 like the pool cards, so its bar track
  // must be layer-2 (the quota bars invert this: layer-1 inside layer-2).
  trendBar: { height: 6, borderRadius: 3, background: "var(--dsw-alias-bg-layer-2)", overflow: "hidden" },
  // The legend under the bars: quiet secondary text, lifted a little off
  // the last row's divider so it reads as a caption, not another data row.
  trendLegend: { marginTop: 10, fontSize: 11, lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
  muted: { color: "var(--dsw-alias-label-secondary)" },
  error: { color: "var(--dsw-alias-state-error-primary)" },
  empty: { color: "var(--dsw-alias-label-secondary)", padding: "18px 0" },
  field: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 },
  fieldLabel: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
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
  primaryHover: { background: "var(--dsw-alias-button-primary-hover)" },
  primaryBusy: { opacity: 0.6, cursor: "default" },
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
  modelRate: { flex: "none", fontSize: 11, color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
  modelBadge: { flex: "none", fontSize: 11, padding: "1px 7px", borderRadius: 999, background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)" },
  // The WorkBuddy-style parameter line: only per-model facts — the figures the
  // platform declares (window, output ceiling) and the levels the selector
  // offers. Provider-wide constants live in the header once, never here.
  // Indented under the model name (15px checkbox + 10px gap = 25).
  modelMeta: { paddingLeft: 25, fontSize: 11, lineHeight: "15px", color: "var(--dsw-alias-label-secondary)" },
  rosterFoot: { display: "flex", gap: 8, alignItems: "center", marginTop: 10 },
  // A roster's own frame — one step INSIDE the section card. The rule above
  // still holds (rows draw no box of their own; the divider separates them),
  // but "one frame per level" is about not repeating the SAME frame, not about
  // leaving a whole list adrift: this panel keeps every list inside its section card
  // block that already wears a card, and an unframed list beside a framed one
  // read as an unfinished half rather than as a deliberate hierarchy.
  modelPanel: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)", padding: "12px 14px" }
};