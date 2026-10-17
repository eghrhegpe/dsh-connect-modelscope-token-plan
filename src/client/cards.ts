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
import { MODELSCOPE_TOKEN_URL, MODELSCOPE_USAGE_URL, modelscopeModelUrl, FEATURED_OWNERS, catalogOwner, trimOwnerPrefix, formatWindow } from "./const.ts";
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
          // 两个读数分别走字典（`{calls} 次` / `{tokens} token`），不拼裸后缀：
          // 单位跟着语言走，也顺带保住「读不到 token 时整段不画」这条——token 为
          // null 只画次数，不画 `0 token`（读不到 ≠ 0）。
          h(
            "span",
            { style: S.trendCredits },
            format(tt("quota.rowCalls"), { calls: count(row.calls) }) +
              (row.tokens !== null ? ` · ${format(tt("quota.rowTokens"), { tokens: count(row.tokens) })}` : "")
          )
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

/** 档位：只列这些（都被 host-config 的保留窗口过滤一次）。 */
const TREND_WINDOW_TIERS: readonly number[] = [7, 14, 30, 90];

/**
 * 趋势显示窗口选择器：默认（跟随 `trendDays` 配置）/ 7 / 14 / 30 / 90 天。
 *
 * 它改的是**画多少天**，不是**留多少天**（保留窗口是 host-config 的
 * `retentionDays`）——所以档位只列到 `trend.maxDays` 为止：画得比留得多会把已剪的
 * 日子画成 0，那个组合在 Host 侧已被夹掉，这里也不给它入口。
 *
 * 保存成功后由调用方 `load()` 回显 Host 落盘的值（不做乐观更新，与 provider /
 * draw 的写路径同一纪律）。当前值不在档位里（例如手动改过 usage-prefs.json）时
 * value 与任何 option 都不匹配 → 浏览器显示第一项，但下一发 onChange 仍发正确的
 * 值——与上下文窗口选择器同一处可接受的边缘表现，不为它造「自定义」档位。
 */
export function TrendWindowPicker({ trend, busy, error, onChange, tt }: {
  trend: { windowDays: number | null; days: number; maxDays: number } | undefined;
  busy: boolean;
  error: string | null;
  onChange: (windowDays: number | null) => void;
  tt: Tt;
}): unknown {
  if (trend === undefined) return null;
  const maxDays = typeof trend.maxDays === "number" && Number.isFinite(trend.maxDays) && trend.maxDays > 0 ? Math.floor(trend.maxDays) : 0;
  const tiers = TREND_WINDOW_TIERS.filter((tier) => maxDays === 0 || tier <= maxDays);
  const current = trend.windowDays;
  return h(
    "div",
    { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 } },
    h("label", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, htmlFor: "trend-window" }, tt("trend.window")),
    h(
      "select",
      {
        id: "trend-window",
        style: { ...S.rosterBulk, height: 28, width: "auto" },
        disabled: busy,
        value: current === null || current === undefined ? "" : String(current),
        onChange: (event: unknown) => {
          const value = String((event as { target?: { value?: string | null } }).target?.value ?? "");
          onChange(value === "" ? null : Number(value));
        }
      },
      h("option", { value: "", key: "default" }, tt("trend.windowDefault")),
      tiers.map((tier) => h("option", { value: String(tier), key: String(tier) }, format(tt("trend.windowDays"), { days: tier })))
    ),
    h("span", { style: { ...S.muted, fontSize: 11 } }, tt("trend.windowHint")),
    error !== null ? h("span", { style: S.formError, role: "alert" }, error) : null
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

/** 清单里的一行（`ProviderStatus.roster` 的元素）。 */
type RosterRow = ProviderStatus["roster"][number];

/**
 * 按 owner 把清单分组，**推荐的三家置顶**（组内保持目录首见序）。
 *
 * 分组的理由只有一个：`owner/model` 的 owner 前缀在每一行里重复，而面板一屏能放
 * 十几行——同一个 owner 说十几遍既占宽度又不提供任何信息。置顶沿用「推荐」徽章的
 * 同一份 `FEATURED_OWNERS`，两处不可能对「哪三家值得置顶」说两套话。
 * @param {RosterRow[]} rows - 归一后的清单行。
 * @returns {{owner: string, rows: RosterRow[]}[]} 分组（置顶 owner 在前）。
 */
export function groupByOwner(rows: RosterRow[]): { owner: string; rows: RosterRow[] }[] {
  const order: string[] = [];
  const byOwner = new Map<string, RosterRow[]>();
  for (const row of rows) {
    const owner = catalogOwner(row.id);
    const bucket = byOwner.get(owner);
    if (bucket === undefined) {
      byOwner.set(owner, [row]);
      order.push(owner);
    } else {
      bucket.push(row);
    }
  }
  const featured = FEATURED_OWNERS.filter((owner) => byOwner.has(owner));
  const rest = order.filter((owner) => !(FEATURED_OWNERS as readonly string[]).includes(owner));
  return [...featured, ...rest].map((owner) => ({ owner, rows: byOwner.get(owner) ?? [] }));
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
  // 搜索词与折叠的 owner。两者都是**视图态**——与 draft 不同（draft 是要写盘的
  // 值），它们只影响当下怎么画，所以不随 Host 值刷新、也不进任何 POST。
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
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

  // 状态拆成**两件不同的事**：失败单独一行、显眼（role=alert）；一句话状态并进
  // 开关那一行（见 switchRow）。原来「已接入」「已注册」「未注册」各占一行，
  // 三行说的是同一件事的三个阶段，读起来像三件不同的事。
  // 优先级不变：具体失败 > 能力缺口 > 已注册 > 未注册。
  const degraded = status.error === "unavailable";
  const alertNode = !degraded && typeof status.error === "string" && status.error !== ""
    ? h("div", { style: S.formError, role: "alert" }, format(tt("provider.error"), { error: status.error }))
    : null;
  // 有 alert 时不再重复一句话状态：否则「接入失败：…」旁边挂着「已注册」，两句
  // 话自相矛盾（error 与 registered 可以同时为真——那是回滚到旧对的状态）。
  const statusPhrase: { key: DictionaryKey; warn: boolean } | null = alertNode !== null
    ? null
    : status.registered === true
      ? { key: "provider.registered", warn: false }
      : status.llmAvailable !== true
        ? { key: "provider.llmMissing", warn: true }
        : { key: "provider.notRegistered", warn: false };

  // 开关开着但还没有令牌：注册一定到不了位，明确指向「接入」tab，别让它
  // 看起来像「开了等一会儿就好」。
  const tokenHint = enabled && tokenPresent === false
    ? h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("provider.notConfigured"))
    : null;

  // 源标注：面板保存的值 / patch 的默认。
  const sourceKey = status.source === "panel" ? "provider.source.panel" : "provider.source.config";

  // 全局上下文窗口**覆盖**。放在卡片最底：插件自带策展表（19 个模型的交叉真值），
  // 这个值只在目录未声明窗口时套用，却会盖过策展表——它是「覆盖」而不是「跟随」，
  // 所以不该出现在开关旁边冒充主流程。
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
        { style: S.advancedBlock },
        h(
          "div",
          { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
          h("label", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, htmlFor: "provider-context-window" }, tt("provider.contextWindowOverride")),
          h(
            "select",
            {
              id: "provider-context-window",
              style: { ...S.rosterBulk, width: "auto" },
              disabled: busy,
              // 受控 select：选中态写在 select 的 `value` 上（React 对 <option
              // selected> 发告警），null = 「不覆盖」档（value=""）。保存后调用方刷
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
          )
        ),
        // 提示另起一行：它是这个值的适用面（谁会被盖、谁不会），塞在选择器右边
        // 会把它挤成第二条标签，读起来像两个并列的控件。
        h("div", { style: S.advancedHint }, tt("provider.contextHint"))
      );

  // 开关行 = 一行话：「已接入 · 已注册（模型可在选择器里选用） · 面板」。开关的
  // 文案是**开关自己的状态**，注册状态是**Host 里的落地情况**，两者可以不一致
  // （开关开着但注册还没完成），所以两个词都留着，只用中圆点让它们读成一句话。
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
    // 中圆点分隔符各在**每一段之前**（第一段除外）。段落数随状态变——有 alert
    // 时状态短语整段缺席，只剩「开关 · 来源」两段——所以点的位置必须跟着段走，
    // 写死在某一处会在另一种组合下变成一个孤零零的「·」。
    statusPhrase === null ? null : h("span", { style: S.dotSep, "aria-hidden": "true" }, "·"),
    statusPhrase === null
      ? null
      : h(
          "span",
          {
            role: "status",
            style: {
              fontSize: 12,
              color: statusPhrase.warn ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-label-secondary)"
            }
          },
          tt(statusPhrase.key)
        ),
    h("span", { style: S.dotSep, "aria-hidden": "true" }, "·"),
    h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, tt(sourceKey))
  );

  // 一行清单。抽成局部函数是因为分组后要按组各画一遍。
  const renderRosterRow = (row: RosterRow) => {
    const id = row.id;
    const unusable = row.available === false || row.quotaExhausted === true;
    return h(
      "li",
      { key: id, style: unusable ? { ...S.modelRow, ...S.modelRowGrouped, ...S.modelRowOff } : { ...S.modelRow, ...S.modelRowGrouped } },
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
          // 名字切掉组头已经说过的 `owner/` 前缀；完整 id 留在 title 与复选框的
          // aria-label 上，所以切掉的信息没丢（见 const.ts 的 trimOwnerPrefix）。
          h("span", { style: S.modelName, title: id }, trimOwnerPrefix(id, row.name))
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
        // 「推荐」不在这里——它是**厂商级**的标记，挂在组头（见下方 group head）。
        // `FEATURED_OWNERS` 列的是 owner，挂到每一行上会让同名 owner 的十几行各说
        // 一遍，而组头也在说：同一件事说十几遍，还把那十几行的宽度吃掉。
        row.quotaExhausted === true
          ? h("span", { style: { ...S.modelBadge, color: "var(--dsw-alias-state-error-primary)" } }, tt("provider.quotaExhausted"))
          : null,
        // 外链保留**可读的**「在魔搭查看 →」：缩成一枚 ↗ 省了宽度，却让第一次看到
        // 它的人猜不出它干什么。省下的那点宽度不值得这个代价（2026-10-17）。
        h("a", { style: { ...S.formNote, margin: 0, marginLeft: "auto", whiteSpace: "nowrap" }, href: modelscopeModelUrl(row.id), target: "_blank", rel: "noreferrer", title: tt("models.viewOnSiteTitle") }, tt("models.viewOnSite"))
      )
    );
  };

  // 搜索先过滤、再分组。搜索时**忽略折叠态**——匹配到的东西被折叠藏着，会让人以为
  // 「搜不到」；`query` 只归一一次，后面的判空都看它。
  const query = search.trim().toLowerCase();
  const visibleRows = query === "" ? roster : roster.filter((row) => `${row.id} ${String(row.name ?? "")}`.toLowerCase().includes(query));
  const ownerGroups = groupByOwner(visibleRows);

  const rosterBlock = roster.length === 0
    ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 6 } }, tt("provider.rosterHint"))
    : h(
        "div",
        { style: S.modelPanel },
        h(
          "div",
          { style: S.rosterTools },
          // `name` + autoComplete 是给浏览器的口令：这枚框不是让密码管理器往里填
          // 已保存账号的地方（同 Agnes 的搜索框处理）。
          h("input", {
            type: "search",
            name: "provider-model-search",
            autoComplete: "off",
            style: { ...S.input, flex: "1 1 160px", minWidth: 0 },
            placeholder: tt("provider.search"),
            "aria-label": tt("provider.search"),
            value: search,
            disabled: busy,
            onChange: (event: unknown) => setSearch(String((event as { target?: { value?: string } }).target?.value ?? ""))
          }),
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
        visibleRows.length === 0
          ? h("div", { style: { ...S.muted, fontSize: 12, padding: "10px 4px" } }, tt("provider.noMatch"))
          : h(
              "ul",
              { style: S.modelList, role: "list" },
              ownerGroups.map((group) => {
                // 折叠只在「没在搜索」时生效（见上）。
                const isCollapsed = query === "" && collapsed.includes(group.owner);
                const groupTicked = hideAllMode ? 0 : group.rows.filter((row) => draft.includes(row.id)).length;
                return h(
                  "li",
                  { key: group.owner },
                  h(
                    "button",
                    {
                      type: "button",
                      style: S.modelGroup,
                      "aria-expanded": !isCollapsed,
                      "aria-label": `${tt(isCollapsed ? "section.expand" : "section.collapse")}: ${group.owner}`,
                      onClick: () => setCollapsed((current) => (current.includes(group.owner) ? current.filter((owner) => owner !== group.owner) : [...current, group.owner]))
                    },
                    // 折叠时转 -90°（▸），展开时是基础的下箭头（▾）——树的常规读法。
                    h(
                      "svg",
                      {
                        viewBox: "0 0 16 16", width: 12, height: 12, fill: "none", stroke: "currentColor",
                        strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
                        style: isCollapsed ? { ...S.chevron, transform: "rotate(-90deg)" } : S.chevron
                      },
                      h("path", { d: "M3 6l5 5 5-5" })
                    ),
                    h("span", { style: S.modelGroupOwner }, group.owner),
                    // 「推荐」是**厂商级**标记（`FEATURED_OWNERS` 是 owner 列表，
                    // 见 const.ts 头注），所以每个 owner 只在组头挂一枚；同时它也是
                    // 这一组被置顶的原因——只靠位置置顶，读者看不出凭什么是它。
                    (FEATURED_OWNERS as readonly string[]).includes(group.owner)
                      ? h("span", { style: S.modelBadgeFeatured, title: tt("models.featuredTitle") }, tt("provider.featured"))
                      : null,
                    h("span", { style: S.modelGroupCount }, format(tt("provider.groupCount"), { count: group.rows.length })),
                    groupTicked > 0 ? h("span", { style: S.modelGroupCount }, format(tt("provider.groupSelected"), { count: groupTicked })) : null
                  ),
                  isCollapsed ? null : h("ul", { style: S.modelList, role: "list" }, group.rows.map(renderRosterRow))
                );
              })
            ),
        h("div", { style: S.rosterFoot }, h("button", { type: "button", style: S.button, disabled: busy, onClick: onReset }, tt("provider.reset")))
      );

  return h(
    "div",
    null,
    switchRow,
    alertNode,
    tokenHint,
    h("div", { style: { ...S.sectionTitle, margin: "18px 0 8px" } }, tt("provider.models")),
    rosterBlock,
    contextNode,
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
export function DrawCard({ draw, busy, error, onToggle, onReset, onSelectModel, onAutoModel, tokenPresent, tt }: {
  draw: DrawStatus | null;
  busy: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onReset: () => void;
  /** 把某个候选设为默认（面板保存值）。 */
  onSelectModel: (id: string) => void;
  /** 清掉默认，回到自动选择。 */
  onAutoModel: () => void;
  tokenPresent?: boolean | undefined;
  tt: Tt;
}): unknown {
  const status = drawOf(draw);
  const enabled = status.enabled === true;
  const candidates = status.candidateIds;
  const sourceKey = status.source === "panel" ? "draw.source.panel" : "draw.source.config";
  // 生效模型与候选明细都是**可选**的（旧 Host 不给）：缺席就整块不渲染，
  // 而不是编一个「自动选中第一个」——那会把「不知道」画成「知道」。
  const effectiveModel = status.effectiveModel;
  const hasEffectiveKey = effectiveModel !== undefined;
  const candidateDetails = status.candidates;
  // 自动选择的理由只描述**自动**这一档（用户指定时不需要解释为什么是指定的）。
  const autoReasonKey: DictionaryKey | null =
    status.effectiveSource === "declared-text-to-image" ? "draw.currentSrc.declaredTextToImage"
      : status.effectiveSource === "known-text-to-image" ? "draw.currentSrc.knownTextToImage"
        : status.effectiveSource === "catalog-first" ? "draw.currentSrc.catalogFirst"
          : null;

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

  // ── 「自动选择」这一项自己的说明 ──
  // 之前这段信息被拆到三处（顶部「当前使用」行 + 小标题括号 + 单选项本身），
  // 单词「自动」出现三次、而单选项又什么解释都没有。现在只在这里说一次：
  // 选中它会发生什么、当前会选谁、为什么是它。
  // 仅在**自动确实生效**（preferredModel === null）时给这句——指定了模型时
  // 「自动会挑谁」不是当前事实，说出来只会与勾选状态打架。
  const autoDescription = !hasEffectiveKey || status.preferredModel !== null
    ? null
    : effectiveModel === null || effectiveModel === ""
      ? h("div", { style: { ...S.muted, fontSize: 11, lineHeight: "16px", paddingLeft: 25 } }, tt("draw.currentNone"))
      : h(
        "div",
        { style: { ...S.muted, fontSize: 11, lineHeight: "16px", paddingLeft: 25 } },
        autoReasonKey === null
          ? format(tt("draw.autoHint"), { model: effectiveModel })
          : format(tt("draw.autoHintReason"), { model: effectiveModel, reason: tt(autoReasonKey) })
      );

  // 单选框的名字：一个表单里只能有一组生效模型，`name` 让浏览器管住「单选」这
  // 件事（不用自己记哪个被点过）。aria-label 用模型 id，与 roster 的复选框同款
  // 约定（真 DOM 里的可辨认性由此而来）。
  const RADIO_NAME = "modelscope-draw-model";
  /**
   * 一个候选的能力徽章（**正向各给一枚**，不是「能力减项 + 警告」）。
   *
   * 之前写成「平台能力档一枚 + 不能纯文生图时再加警告」是不对称的：能吃纯文生图
   * 是**加项优势**，却在 UI 上完全不可见，于是两个 Qwen-Image-Edit 看起来一样，
   * 其中一个还莫名带着警告。现在两个事实各画一枚：
   *   - `图生图`——平台声明的 image-to-image（改图/图生图）；
   *   - `文生图`——能吃纯文生图（平台声明的 text-to-image，或实测已知的那个 id）。
   * 只给「图生图」的模型，徽章上挂 title 说明它必须给输入图（把警告从第二枚
   * 徽章降级成悬停说明，列表不再被警告噪声占满）。
   * 旧 Host 没有候选明细时退化为通用「出图」徽章——不猜能力。
   */
  const capabilityBadges = (row: { id: string; capability: "text-to-image" | "image-to-image" | "other" | null; textToImage: boolean | null }): unknown[] => {
    if (row.capability === null) return [h("span", { key: "badge", style: S.modelBadge }, tt("draw.badge"))];
    const badges: unknown[] = [];
    if (row.capability === "image-to-image") {
      badges.push(h("span", {
        key: "badge-i2i",
        style: S.modelBadge,
        // 能吃纯文生图时无需解释；不能时把这枚徽章变成那句说明。
        title: row.textToImage === true ? undefined : tt("draw.imageOnlyTitle")
      }, tt("draw.badge.imageToImage")));
    }
    if (row.textToImage === true) {
      badges.push(h("span", { key: "badge-t2i", style: S.modelBadge }, tt("draw.badge.textToImage")));
    }
    if (badges.length === 0) badges.push(h("span", { key: "badge", style: S.modelBadge }, tt("draw.badge")));
    return badges;
  };

  const candidateRows: { id: string; capability: "text-to-image" | "image-to-image" | "other" | null; textToImage: boolean | null }[] =
    Array.isArray(candidateDetails)
      ? candidateDetails.map((row) => ({ id: row.id, capability: row.capability, textToImage: row.textToImage }))
      : candidates.map((id) => ({ id, capability: null, textToImage: null }));

  /**
   * 一行广播的骨架：单选框 + 名字（+ 其余徽章由调用方给），可选第二行说明。
   *
   * `description` 是「这一项是什么」的地方（只有「自动选择」需要），缩进对齐到
   * 文字起点（复选框 15px + gap 10px = 25px），读起来是该项的注脚而不是新一行。
   */
  const radioRow = (key: string, checked: boolean, label: string, labelText: string, disabled: boolean, onChange: () => void, extra: unknown[], description?: unknown) =>
    h(
      "li",
      { key, style: S.modelRow },
      h(
        "div",
        { style: S.modelRowHead },
        h(
          "label",
          { style: { display: "flex", alignItems: "center", gap: 10, flex: "1 1 auto", minWidth: 0, cursor: disabled ? "default" : "pointer" } },
          h("input", {
            type: "radio",
            name: RADIO_NAME,
            checked,
            disabled,
            onChange,
            style: S.modelCheck,
            "aria-label": label
          }),
          h("span", { style: S.modelName, title: label }, labelText)
        ),
        ...extra
      ),
      ...(description === undefined ? [] : [description])
    );

  const candidateBlock = candidateRows.length === 0
    ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 6 } }, tt("draw.noCandidates"))
    : h(
      "div",
      { style: S.modelPanel },
      h(
        "ul",
        { style: S.modelList, role: "radiogroup", "aria-label": tt("draw.models") },
        // 「自动选择」也是一枚单选项，占第一行：单选组必须能表达「不指定」，
        // 否则用户指定过一次就再也回不到自动（那是「设为默认」按钮表达不了的）。
        radioRow(
          "__auto__",
          status.preferredModel === null,
          tt("draw.auto"),
          tt("draw.auto"),
          busy,
          () => onAutoModel(),
          [],
          autoDescription === null ? undefined : autoDescription
        ),
        ...candidateRows.map((row) =>
          radioRow(
            row.id,
            status.preferredModel === row.id,
            row.id,
            row.id,
            busy,
            () => onSelectModel(row.id),
            [
              ...capabilityBadges(row),
              h("a", { key: "link", style: { ...S.formNote, margin: 0, marginLeft: "auto", whiteSpace: "nowrap" }, href: modelscopeModelUrl(row.id), target: "_blank", rel: "noreferrer", title: tt("models.viewOnSiteTitle") }, tt("models.viewOnSite"))
            ]
          )
        )
      )
    );

  // 信息层级：**状态 → 选择 → 操作 → 说明**。说明性文字（重启提示、缺令牌提示）
  // 一律沉到卡片底部，不夹在标题与列表之间——它们解释的是「为什么现在还没生效」，
  // 而用户先是来看「当前用什么、能改成什么」。
  return h(
    "div",
    null,
    switchRow,
    statusNode,
    h("div", { style: { ...S.sectionTitle, margin: "18px 0 8px" } }, tt("draw.models")),
    candidateBlock,
    // 只剩「回到默认」一个按钮：「自动选择」已是单选项（在上面的单选组里），
    // 一颗按钮再表达一次同一件事只会让人怀疑两者不等价。
    h(
      "div",
      { style: S.rosterFoot },
      h("button", { type: "button", style: S.button, disabled: busy, onClick: onReset }, tt("draw.reset"))
    ),
    error !== null ? h("div", { style: S.formError, role: "alert" }, error) : null,
    restartHint,
    tokenHint
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
