/**
 * `plugins.bundle.config` 卡：轮询、决策门与三 tab（额度 / 模型 / 接入）的
 * 全部布局。渲染在 Plugins 页内、始终展开；轮询只在本卡挂载期间进行。
 * @module dsh-connect-modelscope-token-plan/client/panel-page
 */
import { SectionCard, BalanceCard, LocalDailyCard, ModelUsageTable, TrendBars, EventsList, TokenForm } from "./cards.ts";
import { PANEL_ID, MODELS_PATH, TOKEN_PATH, TOKEN_FORGET_PATH, PROBE_PATH } from "./const.ts";
import { format, errorText, isoTime } from "./format.ts";
import { getJson, postJson } from "./http.ts";
import { viewOf } from "./snapshot.ts";
import { useSnapshotPolling } from "./use-snapshot-polling.ts";
import { h, useCallback, useEffect, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { S } from "./styles.ts";
import type { Snapshot } from "../shared/wire.ts";

/** 三个固定视角。 */
export type TabId = "quota" | "models" | "access";

export function PanelPage({ tt, localeSubscribe }: {
  tt: Tt;
  localeSubscribe?: unknown;
}): unknown {
  const { data, error, loadedOnce, updatedAt, load } = useSnapshotPolling();
  const [, setLocaleRevision] = useState(0);
  const [openSections, setOpenSections] = useState({ balance: true, local: true, perModel: false, trend: true, events: false, catalog: true, token: true });
  const [activeTab, setActiveTab] = useState<TabId>("quota");

  useEffect(() => {
    if (typeof localeSubscribe !== "function") return undefined;
    return (localeSubscribe as (fn: () => void) => () => void)(() => setLocaleRevision((revision) => revision + 1));
  }, [localeSubscribe]);

  const toggleSection = useCallback((key: string) => {
    setOpenSections((current) => ({ ...current, [key]: !current[key as keyof typeof current] }));
  }, []);

  const { failure, needsSetup, guidance, shapeWarnings } = viewOf(data, error, tt);
  const showSetup = needsSetup && loadedOnce;

  // 模型目录：挂载时读一次 + 手动刷新。快照里只有 20 个样本，整表走 /models。
  const [catalog, setCatalog] = useState<{ ids: string[]; fetchedAt: string } | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const loadCatalog = useCallback(async () => {
    try {
      const body = await getJson(MODELS_PATH);
      if (body !== null && body.ok === true && Array.isArray(body.models)) {
        setCatalog({ ids: (body.models as Array<{ id?: unknown }>).map((m) => String(m.id ?? "")).filter((id) => id !== ""), fetchedAt: typeof body.fetchedAt === "string" ? body.fetchedAt : "" });
        setCatalogError(null);
      } else {
        setCatalogError(typeof body?.error === "string" ? body.error : "HTTP error");
      }
    } catch (reason) {
      setCatalogError(errorText(reason));
    }
  }, []);
  useEffect(() => {
    if (activeTab === "models" && catalog === null) void loadCatalog();
  }, [activeTab, catalog, loadCatalog]);

  // probe：usage / validity 两种形态的统一入口 + 一行结果。
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const runProbe = useCallback(async (modelId: string, kind: "usage" | "validity") => {
    setProbeBusy(true);
    setProbeResult(null);
    setProbeError(null);
    try {
      const body = await postJson(PROBE_PATH, { modelId, kind });
      if (body !== null && body.ok === true) {
        const usage = body.usage as { totalTokens?: number } | null;
        setProbeResult(kind === "usage" && usage !== null && usage !== undefined
          ? format(tt("probe.ok"), { tokens: usage.totalTokens ?? 0, ms: Number(body.elapsedMs ?? 0) })
          : format(tt("probe.validOk"), { status: Number(body.status ?? 0) }));
        void load();
      } else {
        setProbeError(typeof body?.error === "string" ? body.error : "HTTP error");
      }
    } catch (reason) {
      setProbeError(errorText(reason));
    } finally {
      setProbeBusy(false);
    }
  }, [tt, load]);

  // 令牌保存 / 忘掉。
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const saveToken = useCallback(async (value: string) => {
    setTokenBusy(true);
    setTokenError(null);
    try {
      const body = await postJson(TOKEN_PATH, { token: value });
      if (body === null || body.ok !== true) throw new Error(typeof body?.error === "string" ? body.error : "HTTP error");
      void load();
    } catch (reason) {
      setTokenError(errorText(reason));
    } finally {
      setTokenBusy(false);
    }
  }, [load]);
  const forgetToken = useCallback(async () => {
    setTokenBusy(true);
    setTokenError(null);
    try {
      await postJson(TOKEN_FORGET_PATH, {});
      void load();
    } catch (reason) {
      setTokenError(errorText(reason));
    } finally {
      setTokenBusy(false);
    }
  }, [load]);

  const tokenState = data?.token ?? null;

  // 额度 tab：官方魔粒余额（头条）→ 本地计数 → 单模型 → 趋势 → 事件。
  const quotaBody = () => {
    if (data === null) {
      return h("div", { style: S.empty },
        failure === null
          ? tt("panel.loading")
          : h("div", { role: "alert" }, guidance ?? format(tt("panel.error"), { error: failure.message })));
    }
    if (showSetup && failure !== null) {
      return h("div", { style: S.empty, role: "alert" }, guidance ?? format(tt("panel.error"), { error: failure.message }));
    }
    const snap: Snapshot = data;
    return h(
      "div",
      null,
      h(SectionCard, { title: tt("section.balance"), open: openSections.balance, onToggle: () => toggleSection("balance"), tt }, h(BalanceCard, { balance: snap.balance, tt })),
      h(
        SectionCard,
        { title: tt("section.local"), open: openSections.local, onToggle: () => toggleSection("local"), tt },
        h(LocalDailyCard, { snapshot: snap, tt })
      ),
      h(
        SectionCard,
        { title: tt("section.perModel"), open: openSections.perModel, onToggle: () => toggleSection("perModel"), tt },
        h(ModelUsageTable, { rows: snap.quota.perModel, tt })
      ),
      h(
        SectionCard,
        { title: format(tt("section.trend"), { days: snap.trend.days }), open: openSections.trend, onToggle: () => toggleSection("trend"), tt },
        h(TrendBars, { buckets: snap.trend.buckets, tt })
      ),
      h(
        SectionCard,
        { title: tt("section.events"), open: openSections.events, onToggle: () => toggleSection("events"), tt },
        h(EventsList, { events: snap.events, tt })
      )
    );
  };

  // 模型 tab：完整目录 + 每行试调（usage 形态，消耗 1 次免费额度，面板有标注）。
  const modelsBody = () => h(
    "div",
    null,
    h(
      SectionCard,
      {
        title: catalog !== null
          ? `${tt("section.catalog")} · ${format(tt("models.count"), { count: catalog.ids.length })}`
          : tt("section.catalog"),
        open: openSections.catalog,
        onToggle: () => toggleSection("catalog"),
        tt
      },
      catalog === null && catalogError === null
        ? h("div", { style: S.trendLegend }, tt("models.loading"))
        : null,
      catalogError !== null ? h("div", { style: S.formNote, role: "status" }, format(tt("models.none"), { error: catalogError })) : null,
      catalog !== null
        ? h("div", null,
            h("div", { style: S.trendLegend }, format(tt("models.fetched"), { time: isoTime(catalog.fetchedAt) })),
            catalog.ids.map((id) => h(
              "div",
              { key: id, style: S.trendRowHead },
              h("span", { style: S.trendModel, title: id }, id),
              h("button", { type: "button", style: S.button, disabled: probeBusy, onClick: () => void runProbe(id, "usage"), title: tt("probe.usage") }, tt("models.probeUsage"))
            )))
        : null,
      probeBusy ? h("div", { style: S.formNote }, tt("probe.busy")) : null,
      probeResult !== null ? h("div", { style: S.formNote, role: "status" }, probeResult) : null,
      probeError !== null ? h("div", { style: S.formError, role: "alert" }, format(tt("probe.fail"), { error: probeError })) : null
    )
  );

  // 接入 tab：令牌管理 + 状态 + 说明（provider 注册在路线图里，此处只读）。
  const accessBody = () => h(
    "div",
    null,
    h(
      SectionCard,
      { title: tt("section.token"), open: openSections.token, onToggle: () => toggleSection("token"), tt },
      h(TokenForm, { token: tokenState, busy: tokenBusy, error: tokenError, onSave: (value: string) => void saveToken(value), onForget: () => void forgetToken(), tt })
    )
  );

  return h(
    "div",
    { style: S.page, "data-dsh-plugin": PANEL_ID },
    h(
      "div",
      { style: S.headerBar },
      h(
        "div",
        { style: S.header },
        h("h1", { style: S.title }, tt("panel.title")),
        h("span", { style: S.spacer }),
        h(
          "span",
          { style: S.cluster },
          data !== null ? h("span", { style: S.updated }, format(tt("panel.updated"), { time: isoTime(new Date(updatedAt).toISOString()) })) : null,
          failure !== null && data !== null
            ? h("span", { style: S.error, role: "status", title: failure.message }, format(tt("panel.error"), { error: failure.message }))
            : null,
          h("button", { type: "button", style: S.button, onClick: () => void load() }, tt("panel.refresh"))
        )
      )
    ),
    h(
      "div",
      { style: S.scroll },
      h(
        "div",
        { style: S.content },
        h(
          "div",
          null,
          h(
            "div",
            { style: S.tabBar, role: "tablist" },
            h("button", { type: "button", role: "tab", "aria-selected": activeTab === "quota", style: { ...S.tab, ...(activeTab === "quota" ? S.tabActive : {}) }, onClick: () => setActiveTab("quota") }, tt("tab.quota")),
            h("button", { type: "button", role: "tab", "aria-selected": activeTab === "models", style: { ...S.tab, ...(activeTab === "models" ? S.tabActive : {}) }, onClick: () => setActiveTab("models") }, tt("tab.models")),
            h("button", { type: "button", role: "tab", "aria-selected": activeTab === "access", style: { ...S.tab, ...(activeTab === "access" ? S.tabActive : {}) }, onClick: () => setActiveTab("access") }, tt("tab.access"))
          ),
          data !== null && shapeWarnings.length > 0
            ? h("div", { style: S.formError, role: "status" }, format(tt("panel.shapeDrift"), { detail: shapeWarnings.join("; ") }))
            : null,
          activeTab === "quota" ? quotaBody() : activeTab === "models" ? modelsBody() : accessBody()
        )
      )
    )
  );
}
