/**
 * 展示组件：魔粒余额头条、本地计数卡、单模型用量、天桶趋势、事件流、
 * 令牌表单、可折叠 section。形状不对的数据渲染「空」，绝不抛——一行坏数据
 * 不许白屏整个面板。仅 TokenForm 持有 state（输入框），其余无 hook。
 * @module dsh-connect-modelscope-token-plan/client/cards
 */
import { count, format, isoTime } from "./format.ts";
import { h, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { S } from "./styles.ts";
import { MODELSCOPE_TOKEN_URL, MODELSCOPE_USAGE_URL } from "./const.ts";
import type { BalanceData, QuotaEvent, Snapshot, TrendBucket, TokenStatus } from "../shared/wire.ts";

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
export function BalanceCard({ balance, tt }: { balance: BalanceData | null | unknown; tt: Tt }): unknown {
  if (balance === null || typeof balance !== "object") return null;
  const row = balance as BalanceData;
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

/** 本地计数卡：今日调用 vs 参考上限的推算条 + 口径说明。 */
export function LocalDailyCard({ snapshot, tt }: { snapshot: Snapshot; tt: Tt }): unknown {
  const { daily, perModelLimit } = snapshot.quota;
  const pct = daily.limit > 0 ? Math.min(100, (daily.usedLocal / daily.limit) * 100) : null;
  const tone = pct !== null && pct >= 90 ? S.barFillError : pct !== null && pct >= 70 ? S.barFillWarn : S.barFill;
  return h(
    "div",
    { style: S.card },
    h("div", { style: S.poolName }, `${tt("quota.dailyUsed")} · ${count(daily.usedLocal)}`),
    h("div", { style: S.bar, role: "progressbar", "aria-valuenow": pct === null ? 0 : Math.round(pct), "aria-valuemin": 0, "aria-valuemax": 100 }, h("div", { style: { ...tone, width: `${pct ?? 0}%` } })),
    h(
      "div",
      { style: S.quotaTop },
      h("span", { style: S.quotaUsed }, `${tt("quota.remaining")} ${count(daily.remainingComputed)} · ${tt("quota.dailyLimit")} ${count(daily.limit)} · ${tt("section.perModel")} ≤${count(perModelLimit)}`),
      pct !== null && pct >= 100 ? h("span", { style: S.error }, tt("quota.exhausted")) : null
    ),
    h("div", { style: S.trendLegend }, tt("quota.countingNote"))
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

/** 近 N 天本地调用趋势（天桶；缺桶 = 该日 0 次，真实零）。 */
export function TrendBars({ buckets, tt }: { buckets: TrendBucket[]; tt: Tt }): unknown {
  if (!Array.isArray(buckets) || buckets.length === 0) return h("div", { style: S.trendLegend }, tt("trend.none"));
  const max = Math.max(0, ...buckets.map((b) => Math.max(0, b.calls)));
  return h(
    "div",
    null,
    buckets.map((bucket) => h(
      "div",
      { key: bucket.dateKey, style: S.trendRowHead },
      h("span", { style: S.trendModel }, bucket.dateKey),
      h("div", { style: { ...S.trendBar, flex: "1", marginLeft: 10 }, "aria-hidden": "true" }, max > 0 && bucket.calls > 0 ? h("div", { style: { ...S.barFill, width: `${(bucket.calls / max) * 100}%` } }) : null),
      h("span", { style: S.quotaUsed }, String(bucket.calls))
    )),
    h("div", { style: S.trendLegend }, tt("trend.legend"))
  );
}

const EVENT_KIND_KEY: Record<string, string> = { quota: "events.quota", rate_limit: "events.rate_limit", error: "events.error" };

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
      h("span", { style: S.modelTag }, tt(EVENT_KIND_KEY[event.kind] as Parameters<Tt>[0])),
      h("span", { style: { ...S.trendModel, flex: "1" }, title: event.message }, event.message)
    ))
  );
}

/** 令牌表单：保存 / 忘掉 + 状态行 + 外链。唯一持 state 的展示组件。 */
export function TokenForm({ token, busy, error, onSave, onForget, tt }: {
  token: TokenStatus | null;
  busy: boolean;
  error: string | null;
  onSave: (token: string) => void;
  onForget: () => void;
  tt: Tt;
}): unknown {
  const [value, setValue] = useState("");
  const source = token === null ? "none" : token.source;
  const sourceKey = (source === "credentials" ? "source.credentials" : source === "env" ? "source.env" : source === "memory" ? "source.memory" : "source.none") as Parameters<Tt>[0];
  return h(
    "div",
    null,
    h("div", { style: S.quotaUsed }, format(tt("token.status"), {
      present: token !== null && token.present ? tt("present.yes") : tt("present.no"),
      source: tt(sourceKey)
    })),
    token !== null && token.ephemeral ? h("div", { style: S.formNote }, tt("token.ephemeral")) : null,
    h(
      "div",
      { style: S.rosterTools },
      h("input", { style: S.input, type: "password", placeholder: tt("token.placeholder"), value, onChange: (event: unknown) => setValue(String((event as { target: { value: string } }).target.value ?? "")) }),
      h("button", { type: "button", style: S.primary, disabled: busy, onClick: () => { onSave(value); setValue(""); } }, tt("token.save")),
      token !== null && token.present ? h("button", { type: "button", style: S.button, disabled: busy, onClick: onForget }, tt("token.forget")) : null
    ),
    error !== null ? h("div", { style: S.formError, role: "alert" }, error) : null,
    h("div", { style: S.formNote }, tt("token.hint")),
    h("a", { style: S.formNote, href: MODELSCOPE_TOKEN_URL, target: "_blank", rel: "noreferrer" }, tt("token.link"))
  );
}
