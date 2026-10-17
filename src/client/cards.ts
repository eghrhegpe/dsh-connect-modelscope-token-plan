/**
 * 展示组件：魔粒余额头条、本地计数卡、单模型用量、天桶趋势、事件流、
 * 令牌表单、可折叠 section。形状不对的数据渲染「空」，绝不抛——一行坏数据
 * 不许白屏整个面板。仅 TokenForm 持有 state（输入框），其余无 hook。
 * @module dsh-connect-modelscope-token-plan/client/cards
 */
import { count, format, isoTime } from "./format.ts";
import { h, useEffect, useMemo, useState } from "./runtime.ts";
import type { DictionaryKey, Tt } from "./runtime.ts";
import { S } from "./styles.ts";
import { MODELSCOPE_TOKEN_URL, MODELSCOPE_USAGE_URL, modelscopeModelUrl, FEATURED_OWNERS, catalogOwner, formatWindow } from "./const.ts";
import { providerOf, drawOf } from "./snapshot.ts";
import { ToggleSwitch } from "./toggle-switch.ts";
import { parseAllowedList, normalizeRosterSave, hideAllRoster } from "../shared/allow-list.ts";
import type { BalanceData, ProviderStatus, DrawStatus, QuotaEvent, Snapshot, TrendBucket, TokenStatus } from "../shared/wire.ts";

/** 可折叠 section 卡：全宽头部按钮 + 旋转 chevron；open/onToggle 由 props 进。 */
export function SectionCard({ title, open, onToggle, children, tt }: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children?: unknown;
  tt: Tt;
}): unknown {
  return h(
    "div",
    { style: S.sectionCard },
    h(
      "button",
      {
        type: "button",
        style: S.sectionHead,
        "aria-expanded": open,
        "aria-label": `${tt(open ? "section.collapse" : "section.expand")}: ${title}`,
        onClick: onToggle
      },
      h("span", { style: S.sectionHeadTitle }, title),
      h(
        "svg",
        { viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", style: open ? { ...S.chevron, ...S.chevronOpen } : S.chevron },
        h("path", { d: "M3 6l5 5 5-5" })
      )
    ),
    h("div", { style: S.sectionBody, hidden: !open }, open ? children : null)
  );
}

/** 官方魔粒余额头条：三格（可用/总额/冻结）+ 来源说明。null 渲染「—」。 */
export function BalanceCard({ balance, tt }: { balance: BalanceData | null; tt: Tt }): unknown {
  if (balance === null || typeof balance !== "object") return null;
  const row = balance;
  if (row.error !== null && row.error !== undefined) {
    return h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-error-primary)", margin: 0 } }, format(tt("balance.unavailable"), { error: row.error }));
  }
  if (row.available === null && row.total === null) return null;
  const tile = (label: string, value: unknown) =>
    h(
      "div",
      { style: S.statCard },
      h("div", { style: S.statValue }, typeof value === "number" && Number.isFinite(value) ? count(value) : "—"),
      h("div", { style: S.quotaLabel }, label)
    );
  return h(
    "div",
    { style: S.card },
    h(
      "div",
      { style: S.statGrid },
      tile(tt("balance.available"), row.available),
      tile(tt("balance.total"), row.total),
      tile(tt("balance.frozen"), row.frozen)
    ),
    h(
      "div",
      { style: S.trendLegend },
      row.fetchedAt !== null && row.fetchedAt !== undefined
        ? format(tt("balance.fetched"), { time: isoTime(row.fetchedAt) }) + " · "
        : "",
      tt("balance.note"),
      " ",
      h("a", { style: S.formNote, href: MODELSCOPE_USAGE_URL, target: "_blank", rel: "noreferrer" }, tt("balance.usagePage"))
    )
  );
}

/**
 * 本地调用卡：纯统计口径——今日次数 + 按模型分布 + 一句口径说明。
 * 刻意**不画**「推算剩余/参考上限」进度条：官方已改为魔粒计费，「2000 次」
 * 是次数口径的社区快照，与魔粒余额并排展示是误导（README「三条事实」#2）。
 * 本地计数回答的是官方余额回答不了的问题：哪个模型在烧、何时撞的 429。
 */
export function LocalDailyCard({ snapshot, tt }: { snapshot: Snapshot; tt: Tt }): unknown {
  // 与 BalanceCard / ModelUsageTable / EventsList 同一纪律：形状不对渲染「空」，
  // 绝不抛。曾经这里是裸解构，quota 一旦缺失就TypeError——而本文件头部就写着
  // 「形状不对的数据渲染『空』，绝不抛」，自己没做到。
  const quota = snapshot.quota;
  const daily = quota?.daily ?? { usedLocal: null };
  const perModel = Array.isArray(quota?.perModel) ? quota.perModel : [];
  // 读不到 ≠ 0：null（Host 那一路软失败）渲染「—」并附一行提示，原因在面板上方的
  // shapeWarnings 里（「daily source failed (…)」）。把「读不到」画成 0 会让操作者
  // 以为今天没调用过——真相是他不知道。
  const unknownUsed = !(typeof daily.usedLocal === "number" && Number.isFinite(daily.usedLocal));
  const usedText = unknownUsed ? "—" : count(daily.usedLocal as number);
  return h(
    "div",
    { style: S.card },
    h("div", { style: S.poolName }, format(tt("quota.headline"), { calls: usedText, models: count(perModel.length) })),
    unknownUsed ? h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("quota.unavailable")) : null,
    h(ModelUsageTable, { rows: perModel, tt }),
    h("div", { style: S.trendLegend }, tt("quota.note"))
  );
}

/** 今日单模型排行（相对最大者画条）。 */
export function ModelUsageTable({ rows, tt }: { rows: Array<{ modelId: string; calls: number; tokens: number | null }>; tt: Tt }): unknown {
  if (!Array.isArray(rows) || rows.length === 0) return h("div", { style: S.trendLegend }, tt("trend.none"));
  const max = Math.max(0, ...rows.map((r) => Math.max(0, Number(r.calls) || 0)));
  return h(
    "div",
    null,
    rows.map((row) => {
      const pct = max > 0 ? (row.calls / max) * 100 : 0;
      return h(
        "div",
        { key: row.modelId, style: S.trendRow },
        h(
          "div",
          { style: S.trendRowHead },
          h("span", { style: S.trendModel, title: row.modelId }, row.modelId),
          h("span", { style: S.trendCredits }, count(row.calls) + (row.tokens !== null ? ` · ${count(row.tokens)}t` : ""))
        ),
        pct >= 1 ? h("div", { style: S.trendBar, role: "progressbar", "aria-valuenow": Math.round(pct), "aria-valuemin": 0, "aria-valuemax": 100 }, h("div", { style: { ...S.barFill, width: `${pct}%` } })) : null
      );
    }),
    h("div", { style: S.trendLegend }, tt("trend.legend"))
  );
}

/**
 * 轴上的日期短标注：砍掉年份与补零（`2026-09-18` → `9-18`）。
 *
 * 轴的跨度最多 trendDays（默认 14，多在同年内），年份在刻度间重复出现，占掉的
 * 宽度全是从图的呼吸里匀来的；补零的 `09` 同样多占一格而没多给信息。不是
 * `YYYY-MM-DD` 形状时原样返回——宁可显示一个陌生字符串，也不按位置硬切。
 * @param {string} key - 天桶 dateKey（本地日期 YYYY-MM-DD）。
 * @returns {string} 短标注。
 */
function shortDateKey(key: string): string {
  const value = typeof key === "string" ? key : "";
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(value);
  return match === null ? value : `${Number(match[1])}-${Number(match[2])}`;
}

/** 轴上最多标几个日子（含首尾）。7 个是 Agnes 用量图的密度，窄面板下也不挤。 */
const MAX_TICKS = 7;

/**
 * 轴刻度落在哪些桶上（返回下标）。
 *
 * 桶数 ≤ {@link MAX_TICKS} 时逐日都标；否则按 `(n-1)/(MAX_TICKS-1)` 等距取点、
 * 首尾必含——与姊妹插件 Agnes 的用量图同一取法（它 30 天标 7 个）。等距取点是
 * 对**下标**取整而不是对像素分均，所以刻度与其柱子所属的区间大体对齐，只是轴
 * 用 `space-between` 铺开；两端的日期恒为真实首末日。
 * @param {number} count - 桶数。
 * @returns {number[]} 升序下标。
 */
function tickIndices(count: number): number[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  if (count <= MAX_TICKS) return Array.from({ length: count }, (_, index) => index);
  const step = (count - 1) / (MAX_TICKS - 1);
  const out: number[] = [];
  for (let tick = 0; tick < MAX_TICKS; tick += 1) {
    const index = Math.round(tick * step);
    // 取整可能撞车（桶数刚过 MAX_TICKS 时），去重保升序。
    if (index > (out[out.length - 1] ?? -1)) out.push(index);
  }
  return out;
}

/** 近 N 天本地调用趋势（天桶；缺桶 = 该日 0 次，真实零）——**竖向柱状图**。 */
export function TrendBars({ buckets, tt }: { buckets: TrendBucket[]; tt: Tt }): unknown {
  if (!Array.isArray(buckets) || buckets.length === 0) return h("div", { style: S.trendLegend }, tt("trend.none"));
  // 脏数据归一，与 ModelUsageTable 同口径：这里曾经直接 `Math.max(0, b.calls)` 与
  // `String(b.calls)`——一条 NaN 桶既把 max 变成 NaN（所有条都不画），又把字面量
  // "NaN" 画上屏。缺桶 = 该日 0 次是**真实零**，但 NaN 不是零，它是坏数据；归零是
  // 唯一安全的画法（Number.isFinite 顺带挡掉 Infinity，`Number(x) || 0` 挡不住）。
  const rows = buckets.map((bucket) => ({
    dateKey: bucket.dateKey,
    calls: Number.isFinite(bucket.calls) ? Math.max(0, bucket.calls) : 0
  }));
  const max = Math.max(0, ...rows.map((row) => row.calls));
  return h(
    "div",
    null,
    h(
      "div",
      { style: S.trendChartBars },
      rows.map((row) => {
        const pct = max > 0 ? (row.calls / max) * 100 : 0;
        return h(
          "div",
          { key: row.dateKey, style: S.trendChartBar, title: `${row.dateKey}: ${count(row.calls)}` },
          // 次数标签**骑在柱顶**（相对本柱绝对定位，bottom = 柱高 + 3px）：比另起
          // 一行数字更贴柱，也不必为最长的那根柱预留一条空白行。0 次不标——空柱
          // 没有高度可骑，标了只会堆在基线上（与姊妹插件 Agnes 同一处理）。
          row.calls > 0
            ? h("span", { style: { ...S.trendChartValue, bottom: `calc(${pct}% + 3px)` }, "aria-hidden": "true" }, count(row.calls))
            : null,
          h("div", {
            // 0 次 = 0% 高 + minHeight 的 2px 底座：天桶确实存在，不是空心缺柱。
            style: { ...S.trendChartFill, height: `${pct}%` },
            role: "progressbar",
            "aria-label": `${row.dateKey} ${count(row.calls)}`,
            "aria-valuenow": Math.round(pct),
            "aria-valuemin": 0,
            "aria-valuemax": 100
          })
        );
      })
    ),
    // 轴：约 7 个等距刻度（首尾必含），不是只有两端。title 给出完整日期，悬停可见。
    h(
      "div",
      { style: S.trendChartAxis },
      tickIndices(rows.length).map((index) => {
        const key = rows[index]?.dateKey ?? "";
        return h("span", { key, title: key, style: { whiteSpace: "nowrap" } }, shortDateKey(key));
      })
    ),
    h("div", { style: S.trendLegend }, tt("trend.legend"))
  );
}

// kind → 字典键。`Record<string, DictionaryKey>` 而非 string：这样 tt() 的参数
// 在编译期就是 DictionaryKey，不需要 as cast（原实现用 Record<string,string>，
// 逼着调用点写 `as Parameters<Tt>[0]`，把类型系统的最后一道防线让掉了）。
const EVENT_KIND_KEY: Record<string, DictionaryKey> = { quota: "events.quota", rate_limit: "events.rate_limit", error: "events.error" };

/** 事件流（429/错误），Newest-first。 */
export function EventsList({ events, tt }: { events: QuotaEvent[]; tt: Tt }): unknown {
  if (!Array.isArray(events) || events.length === 0) return h("div", { style: S.trendLegend }, tt("events.none"));
  return h(
    "div",
    null,
    events.map((event, index) => h(
      "div",
      { key: `${event.at}-${index}`, style: S.trendRowHead },
      h("span", { style: S.quotaUsed }, isoTime(event.at)),
      h("span", { style: S.modelTag }, tt(EVENT_KIND_KEY[event.kind] ?? "events.unknown")),
      h("span", { style: { ...S.trendModel, flex: "1" }, title: event.message }, event.message)
    ))
  );
}

/** 令牌表单：保存 / 忘掉 / 验令牌 + 状态行 + 外链。唯一持 state 的展示组件。 */
export function TokenForm({ token, busy, error, onSave, onForget, onVerify, verifyTitle, tt }: {
  token: TokenStatus | null;
  busy: boolean;
  error: string | null;
  onSave: (token: string) => void;
  onForget: () => void;
  /** 验令牌（validity probe，零额度）；缺省 = 没有可用的 model id，不渲染按钮。 */
  onVerify?: (() => void) | undefined;
  /** 提示实际探的是哪个模型（validity 只关心鉴权，任意模型皆可）。 */
  verifyTitle?: string | undefined;
  tt: Tt;
}): unknown {
  const [value, setValue] = useState("");
  // 守卫必须用 `== null` 而不是 `=== null`：调用点是 `data?.token ?? null`，
  // 而 `??` 只在null/undefined 之间桥接——`data` 存在但 `token` 键缺失时
  // `data?.token` 是 undefined，喂进来就把这里带进崩路径（读 undefined.source）。
  const source = token?.source ?? "none";
  const sourceKey = (source === "credentials" ? "source.credentials" : source === "env" ? "source.env" : source === "memory" ? "source.memory" : "source.none") as Parameters<Tt>[0];
  // `valid` 的三个态各自有一句话，不能合并：`true` = 探过且令牌好、`false` = 探过
  // 且令牌坏（401/403）、`null` = **没探过**。把 false 并进「未校验」等于把已知的
  // 坏说成不知道——与「读不到画成 0」同一类谎。`validity.no` 的措辞本就是「未校验」
  // 而非「无效」，它只服务 null。
  const validKey = (
    token?.valid === true ? "validity.yes" : token?.valid === false ? "validity.bad" : "validity.no"
  ) as Parameters<Tt>[0];
  return h(
    "div",
    null,
    // 读不到凭据存储时**不**渲染「状态：无（来源 无）」——那是对「没配令牌」的断言，
    // 而我们并不知道（见 wire.ts TokenStatus.readError）。这一行代替它，并说清它不
    // 代表没配令牌。
    token?.readError
      ? h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, format(tt("token.readError"), { error: token.readError }))
      : h("div", { style: S.quotaUsed }, format(tt("token.status"), {
          present: token?.present ? tt("present.yes") : tt("present.no"),
          source: tt(sourceKey),
          valid: tt(validKey)
        })),
    token?.ephemeral ? h("div", { style: S.formNote }, tt("token.ephemeral")) : null,
    h(
      "div",
      { style: S.rosterTools },
      h("input", { style: S.input, type: "password", placeholder: tt("token.placeholder"), "aria-label": tt("token.ariaLabel"), value, onChange: (event: unknown) => setValue(String((event as { target: { value: string } }).target.value ?? "")) }),
      h("button", { type: "button", style: S.primary, disabled: busy, onClick: () => { onSave(value); setValue(""); } }, tt("token.save")),
      token?.present ? h("button", { type: "button", style: S.button, disabled: busy, onClick: onForget }, tt("token.forget")) : null,
      onVerify !== undefined ? h("button", { type: "button", style: S.button, disabled: busy, onClick: onVerify, title: verifyTitle }, tt("probe.validity")) : null
    ),
    error !== null ? h("div", { style: S.formError, role: "alert" }, error) : null,
    h("div", { style: S.formNote }, tt("token.hint")),
    h("a", { style: S.formNote, href: MODELSCOPE_TOKEN_URL, target: "_blank", rel: "noreferrer" }, tt("token.link"))
  );
}

/**
 * 接入为 DSH 模型的区块（开关 + 注册状态 + 允许清单）。
 *
 * 这是 M4 把抽象「试调」升级成真接入的落点：开关翻转即 POST provider 路由，
 * Host 在同一次请求里落盘并重注册适配器；允许清单勾完点「保存清单」即 POST
 * roster 路由。写盘（开关/清单）失败必须让面板看见，所以失败由调用方传进
 * `error` 一行渲染出来，不做乐观更新。
 *
 * 只有 ProviderCard 持 draft 状态（勾选清单），其余都是展示组件——与 TokenForm
 * 同一类 hook 边界，Node 渲染套件可以驱动无状态的部分。draft 在 Host 值真正
 * 变化时才跟过去（用 JSON 串做稳定信号，避免每次轮询都用新数组把在编辑的勾选
 * 冲掉）；保存后由调用方 `load()` 刷新，快照回显的就是已落盘的值。
 *
 * 允许清单的语义（路由 §9 钉死）：空清单 = 不过滤 = 全部提供，所以「全部」
 * 发 `[]`；「全部隐藏」发哨兵 `HIDE_ALL_MODELS`（「什么都不提供」）。哨兵
 * 是**独占态**：draft 含哨兵时整个清单就是「全部隐藏」——勾一个真实模型会
 * 退出哨兵态（剔除哨兵），Host 落盘值带哨兵时只保留哨兵。**不能**让哨兵与
 * 真实 id 混排：Host 的 resolveAllowedList 判「含哨兵即 none（全隐藏）」，而
 * 面板若把混排清单里的真实 id 画成勾中、计数为 N，UI 就与落盘撒谎了。
 * 曾踩过：点「全部隐藏」后复选框仍可勾，勾出的混排清单保存后「已启用 1/N」
 * 而实际提供 0 个。
 *
 * 额度耗尽的模型保留在清单里（灰显、勾选框禁用），这是故意的：roster 是目录
 * 事实，picker 那边由 Host 自己丢掉它们，面板不替它删。
 */
export function ProviderCard({ provider, busy, error, onToggle, onSaveList, onSaveContextWindow, onReset, tokenPresent, tt }: {
  provider: ProviderStatus | null;
  busy: boolean;
  /** 上一次开关/清单/窗口写盘的失败（调用方持有 busy 与错误，ProviderCard 只渲染）。 */
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onSaveList: (ids: string[]) => void;
  /** 保存全局上下文窗口覆盖；`null` = 跟随目录（清除覆盖）。 */
  onSaveContextWindow?: (contextWindow: number | null) => void;
  onReset: () => void;
  /** 面板是否已有令牌；缺省 = 未知，不渲染「先去配置」提示。 */
  tokenPresent?: boolean | undefined;
  tt: Tt;
}): unknown {
  // providerOf 再归一一次是防御：路由 GET 的结果也走这条，两端形状一致。
  const status = providerOf(provider);
  const enabled = status.enabled === true;
  const hostIds = status.enabledIds;
  const hostKey = useMemo(() => JSON.stringify(hostIds), [hostIds]);
  const [draft, setDraft] = useState<string[]>(() => hostIds.slice());
  // 哨兵态是独占态：draft 经 shared/allow-list.ts 的 parseAllowedList 解释，
  // mode === "none" 时整个清单就是「全部隐藏」（Host 同一份解释）。勾选、
  // 计数与保存都按这个口径，混排（哨兵 + 真实 id）不会出现。
  const hideAllMode = parseAllowedList(draft).mode === "none";
  // 只在 Host 值真正移动时跟过去（保存后由调用方 load() 回显，不靠本地乐观）。
  useEffect(() => {
    // 归一：Host 落盘值若带哨兵（旧版混排残留），只保留哨兵，别把真实 id
    // 画成勾中——面板显示必须与 Host 的「含哨兵即 none」一致（同一份
    // normalizeRosterSave，序列化规则只有一处）。
    setDraft(normalizeRosterSave(hostIds));
    // 刻意只依赖 hostKey：hostIds 每次轮询都是新数组，列它会在每帧覆盖在编辑的勾选。
  }, [hostKey]);

  const roster = status.roster;
  const rosterIds = roster.map((row) => row.id);
  // 勾一个真实模型 = 退出「全部隐藏」：哨兵是独占态，不能被真实 id 稀释成
  // 混排清单（Host 会把混排判成 none，而面板会把它画成勾中——UI 与落盘撒谎）。
  const toggleOne = (id: string) => setDraft((current) => {
    const ids = parseAllowedList(current);
    const kept = ids.mode === "list" ? [...ids.ids] : [];
    return kept.includes(id) ? kept.filter((x) => x !== id) : [...kept, id];
  });
  const ticked = hideAllMode ? 0 : roster.filter((row) => draft.includes(row.id)).length;

  // 状态行，顺序即优先级：具体失败 > 能力缺口 > 已注册 > 未注册。
  const degraded = status.error === "unavailable";
  let statusNode: unknown;
  if (!degraded && typeof status.error === "string" && status.error !== "") {
    statusNode = h("div", { style: S.formError, role: "alert" }, format(tt("provider.error"), { error: status.error }));
  } else if (status.registered === true) {
    statusNode = h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, role: "status" }, tt("provider.registered"));
  } else if (status.llmAvailable !== true) {
    statusNode = h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("provider.llmMissing"));
  } else {
    statusNode = h("div", { style: { ...S.muted, fontSize: 12 }, role: "status" }, tt("provider.notRegistered"));
  }

  // 开关开着但还没有令牌：注册一定到不了位，明确指向「接入」tab，别让它
  // 看起来像「开了等一会儿就好」。
  const tokenHint = enabled && tokenPresent === false
    ? h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("provider.notConfigured"))
    : null;

  // 源标注：面板保存的值 / patch 的默认。
  const sourceKey = status.source === "panel" ? "provider.source.panel" : "provider.source.config";

  // 全局上下文窗口选择器（作用于目录未声明窗口的模型）。
  //
  // 档位值用 2 的幂（模型界惯例的 K=1024）：128K=131072 … 1M=1048576。选中态
  // 直接读 `status.contextWindow`（保存后由调用方刷快照回显落盘值，select 是
  // 受控的，不需要本地 draft）；落盘值不在档位里（例如手动改过 provider.json）
  // 时落到 value 与任何 option 都不匹配 → 浏览器显示第一项，但下一发 onChange
  // 仍发正确的值——可接受的边缘表现，不为它造一个「自定义」档位。
  const CONTEXT_TIERS: readonly { value: number; label: string }[] = [
    { value: 131072, label: "128K" },
    { value: 262144, label: "256K" },
    { value: 524288, label: "512K" },
    { value: 1048576, label: "1M" }
  ];
  const contextNode = onSaveContextWindow === undefined
    ? null
    : h(
        "div",
        { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "0 0 8px" } },
        h("label", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, htmlFor: "provider-context-window" }, tt("provider.contextWindow")),
        h(
          "select",
          {
            id: "provider-context-window",
            style: { ...S.rosterBulk, width: "auto" },
            disabled: busy,
            // 受控 select：选中态写在 select 的 `value` 上（React 对 <option
            // selected> 发告警），null = 「默认」档（value=""）。保存后调用方刷
            // 快照回显落盘值；落盘值不在档位里时 value 不匹配任何 option，浏览器
            // 显示第一项，但下一发 onChange 仍发正确的值——可接受的边缘表现。
            value: status.contextWindow === null ? "" : String(status.contextWindow),
            onChange: (event: unknown) => {
              const value = String((event as { target?: { value?: string | null } }).target?.value ?? "");
              onSaveContextWindow(value === "" ? null : Number(value));
            }
          },
          h("option", { value: "", key: "default" }, tt("provider.contextDefault")),
          CONTEXT_TIERS.map((tier) => h("option", { value: String(tier.value), key: String(tier.value) }, tier.label))
        ),
        h("span", { style: { ...S.muted, fontSize: 11 }, title: tt("provider.contextHint") }, tt("provider.contextHint"))
      );

  const switchRow = h(
    "div",
    { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "0 0 8px" } },
    h(ToggleSwitch, {
      checked: enabled,
      onChange: () => onToggle(!enabled),
      busy,
      label: tt(enabled ? "provider.on" : "provider.off"),
      busyLabel: tt("provider.busy"),
      title: tt("provider.enable")
    }),
    h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, tt(sourceKey))
  );

  const rosterBlock = roster.length === 0
    ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 6 } }, tt("provider.rosterHint"))
    : h(
        "div",
        { style: S.modelPanel },
        h(
          "div",
          { style: S.rosterTools },
          h("span", {
            style: S.rosterCount,
            title: format(tt("provider.enabledCount"), { count: ticked, total: roster.length })
          }, format(tt("provider.enabledCount"), { count: ticked, total: roster.length })),
          h("button", {
            type: "button", style: S.rosterBulk, disabled: busy,
            onClick: () => { setDraft(rosterIds.slice()); onSaveList(rosterIds.slice()); }
          }, tt("provider.allowAll")),
          h("button", {
            type: "button", style: S.rosterBulk, disabled: busy,
            onClick: () => { const none = hideAllRoster(); setDraft(none); onSaveList(none); }
          }, tt("provider.hideAll")),
          h("button", {
            type: "button", style: S.primary, disabled: busy,
            onClick: () => onSaveList(draft.slice())
          }, tt("provider.saveList"))
        ),
        h(
          "ul",
          { style: S.modelList, role: "list" },
          roster.map((row) => {
            const id = row.id;
            const unusable = row.available === false || row.quotaExhausted === true;
            return h(
              "li",
              { key: id, style: unusable ? { ...S.modelRow, ...S.modelRowOff } : S.modelRow },
              h(
                "div",
                { style: S.modelRowHead },
                h(
                  "label",
                  { style: { display: "flex", alignItems: "center", gap: 10, flex: "1 1 auto", minWidth: 0, cursor: busy || unusable ? "default" : "pointer" } },
                  h("input", {
                    type: "checkbox", checked: !hideAllMode && draft.includes(id), disabled: busy || unusable,
                    onChange: () => toggleOne(id), style: S.modelCheck, "aria-label": id
                  }),
                  h("span", { style: S.modelName, title: id }, row.name)
                ),
                row.vision === true ? h("span", { style: S.modelBadge }, tt("provider.vision")) : null,
                typeof row.contextWindow === "number"
                  ? h(
                    "span",
                    // 策展值带来源标记：同一窗口数字，「策展」与「覆盖/目录」的
                    // 可信度不同——面板把它点出来，用户才知道 262144 是查表得
                    // 来、平台没亲口说。title 说全文案，badge 文本走短词。
                    {
                      style: row.contextSource === "curated" ? { ...S.modelBadge, color: "var(--dsw-alias-label-secondary)" } : S.modelBadge,
                      title: row.contextSource === "curated" ? tt("provider.contextCuratedTitle") : tt("provider.contextWindow")
                    },
                    row.contextSource === "curated" ? formatWindow(row.contextWindow) + " *" : formatWindow(row.contextWindow)
                  )
                  : null,
                (FEATURED_OWNERS as readonly string[]).includes(catalogOwner(row.id))
                  ? h("span", { style: S.modelBadgeFeatured, title: tt("models.featuredTitle") }, tt("provider.featured"))
                  : null,
                row.quotaExhausted === true
                  ? h("span", { style: { ...S.modelBadge, color: "var(--dsw-alias-state-error-primary)" } }, tt("provider.quotaExhausted"))
                  : null,
                h("a", { style: { ...S.formNote, margin: 0, marginLeft: "auto" }, href: modelscopeModelUrl(row.id), target: "_blank", rel: "noreferrer", title: tt("models.viewOnSiteTitle") }, tt("models.viewOnSite"))
              )
            );
          })
        ),
        h("div", { style: S.rosterFoot }, h("button", { type: "button", style: S.button, disabled: busy, onClick: onReset }, tt("provider.reset")))
      );

  return h(
    "div",
    null,
    switchRow,
    statusNode,
    tokenHint,
    contextNode,
    h("div", { style: { ...S.sectionTitle, margin: "18px 0 8px" } }, tt("provider.models")),
    rosterBlock,
    error !== null ? h("div", { style: S.formError, role: "alert" }, error) : null
  );
}

/**
 * 出图工具卡：开关、候选模型、挂载状态。
 *
 * **与 ProviderCard 的关键差异，也是这张卡存在的主要理由**：provider 开关翻转会
 * 立即重注册，而出图工具的开关翻转**要等下次 Host 启动**——peer 的 tools registry
 * 没有 unregister。所以这张卡必须把这件事说出来（`draw.restartHint`），否则用户
 * 翻开关后看不到任何变化，会以为坏了。
 *
 * 缺席原因是**分开渲染**的：`no-tools-service` 是「这个 Host 没提供该服务」（正常），
 * 另两种是 Host 缺陷。三种都给出各自的一句话，因为「开关开着但工具不在」如果没有
 * 解释，用户没有任何办法自己诊断。
 * @param {object} props - 渲染参数。
 * @returns {unknown} 卡片节点。
 */
export function DrawCard({ draw, busy, error, onToggle, onReset, tokenPresent, tt }: {
  draw: DrawStatus | null;
  busy: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onReset: () => void;
  tokenPresent?: boolean | undefined;
  tt: Tt;
}): unknown {
  const status = drawOf(draw);
  const enabled = status.enabled === true;
  const candidates = status.candidateIds;
  const sourceKey = status.source === "panel" ? "draw.source.panel" : "draw.source.config";

  const switchRow = h(
    "div",
    { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "0 0 8px" } },
    h(ToggleSwitch, {
      checked: enabled,
      onChange: () => onToggle(!enabled),
      busy,
      label: tt(enabled ? "draw.on" : "draw.off"),
      busyLabel: tt("draw.busy"),
      title: tt("draw.enable")
    }),
    h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, tt(sourceKey))
  );

  // 挂载状态：缺席原因优先于「已挂载」——它是用户唯一能拿到的诊断线索。
  let statusNode: unknown;
  if (status.absentReason !== null) {
    const key: DictionaryKey = DRAW_ABSENT_KEY[status.absentReason] ?? "draw.absent.unknown";
    const severe = status.absentReason !== "no-tools-service";
    statusNode = h(
      "div",
      {
        style: severe
          ? { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" }
          : S.formNote,
        role: "status"
      },
      tt(key)
    );
  } else if (enabled) {
    statusNode = h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, role: "status" }, format(tt("draw.mounted"), { tool: status.toolName }));
  } else {
    statusNode = h("div", { style: { ...S.muted, fontSize: 12 }, role: "status" }, tt("draw.notMounted"));
  }

  // 挂载发生在下次 Host 启动——开关翻转后本次不生效。只在开关为开时提示。
  const restartHint = enabled
    ? h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("draw.restartHint"))
    : null;

  const tokenHint = enabled && tokenPresent === false
    ? h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("draw.needsKey"))
    : null;

  const candidateBlock = candidates.length === 0
    ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 6 } }, tt("draw.noCandidates"))
    : h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 4 } },
      candidates.map((id) =>
        h(
          "div",
          { key: id, style: S.modelRowHead },
          h("code", { style: S.modelName, title: id }, id),
          h("span", { style: S.modelBadge }, tt("draw.badge")),
          h("a", { style: { ...S.formNote, margin: 0, marginLeft: "auto" }, href: modelscopeModelUrl(id), target: "_blank", rel: "noreferrer", title: tt("models.viewOnSiteTitle") }, tt("models.viewOnSite"))
        )
      )
    );

  return h(
    "div",
    null,
    switchRow,
    statusNode,
    restartHint,
    tokenHint,
    h("div", { style: { ...S.sectionTitle, margin: "18px 0 8px" } }, tt("draw.models")),
    candidateBlock,
    h("div", { style: S.rosterFoot }, h("button", { type: "button", style: S.button, disabled: busy, onClick: onReset }, tt("draw.reset"))),
    error !== null ? h("div", { style: S.formError, role: "alert" }, error) : null
  );
}

/**
 * 缺席原因码 → 字典键。新增原因码而忘了配文案时，`DrawCard` 兜底到
 * `draw.absent.unknown`，不会渲染出一个空白。
 */
const DRAW_ABSENT_KEY: Record<string, DictionaryKey> = {
  "no-tools-service": "draw.absent.noTools",
  "peer-load-failed": "draw.absent.peerLoad",
  "registry-refused": "draw.absent.registry"
};
