/**
 * `plugins.bundle.config` 卡：轮询、决策门与三 tab（额度 / 模型 / 接入）的
 * 全部布局。渲染在 Plugins 页内、始终展开；轮询只在本卡挂载期间进行。
 * @module dsh-connect-modelscope-token-plan/client/panel-page
 */
import { SectionCard, BalanceCard, LocalDailyCard, TrendBars, EventsList, TokenForm, ProviderCard } from "./cards.ts";
import { PANEL_ID, TOKEN_PATH, TOKEN_FORGET_PATH, PROBE_PATH, PROVIDER_PATH, PROVIDER_ROSTER_PATH, PROVIDER_RESET_PATH } from "./const.ts";
import { format, errorText, isoTime } from "./format.ts";
import { getJson, postJson } from "./http.ts";
import { viewOf, providerOf, DEGRADED_PROVIDER } from "./snapshot.ts";
import { useSnapshotPolling } from "./use-snapshot-polling.ts";
import { h, useCallback, useEffect, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { S } from "./styles.ts";
import type { ProviderStatus, Snapshot } from "../shared/wire.ts";

/** 三个固定视角。 */
export type TabId = "quota" | "models" | "access";

export function PanelPage({ tt, localeSubscribe }: {
  tt: Tt;
  localeSubscribe?: unknown;
}): unknown {
  const { data, error, loadedOnce, updatedAt, load } = useSnapshotPolling();
  const [, setLocaleRevision] = useState(0);
  const [openSections, setOpenSections] = useState({ balance: true, local: true, trend: true, events: false, provider: true, token: true });
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

  // 接入为 DSH 模型：快照的 `provider` 块是首选；wire 已声明它，但旧 Host 或
  // 过渡期可能不给——所以读成 unknown，由 providerOf 归一，缺失时用 GET
  // PROVIDER_PATH 兜底一次。两者都读不到就走 DEGRADED_PROVIDER（ProviderCard
  // 渲染「未接入 / 无 LLM 服务」，面板不白屏）。
  const rawProvider: unknown = data?.provider;
  const hasProviderBlock = rawProvider !== undefined && rawProvider !== null;
  const [fetchedProvider, setFetchedProvider] = useState<ProviderStatus | null>(null);
  const provider: ProviderStatus = hasProviderBlock ? providerOf(rawProvider) : (fetchedProvider ?? DEGRADED_PROVIDER);
  useEffect(() => {
    if (hasProviderBlock) return undefined;
    let cancelled = false;
    getJson(PROVIDER_PATH)
      .then((body) => {
        if (!cancelled && body !== null && body.ok === true) setFetchedProvider(providerOf(body));
      })
      .catch(() => { /* 保持降级形状；快照轮询会再试。 */ });
    return () => { cancelled = true; };
  }, [hasProviderBlock]);

  // 写盘统一入口：开关、允许清单、回到默认都 POST 到 provider 路由族。失败
  // 必须传播到面板（不静默吞）——这是用户的显式操作。成功即刷新快照，回显
  // Host 实际落盘的值（不做乐观更新）。
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const runProviderWrite = useCallback(async (path: string, payload: Record<string, unknown>) => {
    setProviderBusy(true);
    setProviderError(null);
    try {
      const body = await postJson(path, payload);
      if (body === null || body.ok !== true) throw new Error(typeof body?.error === "string" ? body.error : "HTTP error");
      void load();
    } catch (reason) {
      setProviderError(format(tt("provider.error"), { error: errorText(reason) }));
    } finally {
      setProviderBusy(false);
    }
  }, [load, tt]);
  const toggleProvider = useCallback((enabled: boolean) => void runProviderWrite(PROVIDER_PATH, { enabled }), [runProviderWrite]);
  const saveRoster = useCallback((enabledIds: string[]) => void runProviderWrite(PROVIDER_ROSTER_PATH, { enabledIds }), [runProviderWrite]);
  const resetProvider = useCallback(() => void runProviderWrite(PROVIDER_RESET_PATH, {}), [runProviderWrite]);

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
  // 验令牌（validity probe）需要一个 model id——鉴权与模型无关，取目录样本的
  // 第一个即可；目录不可读时没有 id，按钮不渲染（诚实降级，不猜模型名）。
  const sampleModel = data?.models.sample[0] ?? null;

  // 验令牌：独立于 usage probe 的状态（两个 tab 不互相串结果）。
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const runValidity = useCallback(async (modelId: string) => {
    setVerifyBusy(true);
    setVerifyNote(null);
    setVerifyError(null);
    try {
      const body = await postJson(PROBE_PATH, { modelId, kind: "validity" });
      if (body !== null && body.ok === true) {
        setVerifyNote(format(tt("probe.validOk"), { status: Number(body.status ?? 0) }));
      } else {
        setVerifyError(typeof body?.error === "string" ? body.error : "HTTP error");
      }
    } catch (reason) {
      setVerifyError(errorText(reason));
    } finally {
      setVerifyBusy(false);
    }
  }, [tt]);

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
      snap.token.present === false
        ? h("div", { style: S.formNote, role: "status" }, tt("panel.noToken"))
        : null,
      h(SectionCard, { title: tt("section.balance"), open: openSections.balance, onToggle: () => toggleSection("balance"), tt }, h(BalanceCard, { balance: snap.balance, tt })),
      h(
        SectionCard,
        { title: tt("section.local"), open: openSections.local, onToggle: () => toggleSection("local"), tt },
        h(LocalDailyCard, { snapshot: snap, tt })
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

  // 模型 tab：只有「接入为 DSH 模型」（开关 + 允许清单）。
  //
  // 「模型目录（免认证，不耗额度）」那张表连同它的逐行试调按钮一起删掉了：
  // /models 是免认证的原始列表，而这一页由 Host 的 roster 承担——roster 是
  // 注册 provider 时实际会提供的模型（含可用性/额度/视觉标记），比一份裸 id
  // 列表更接近用户的问题「我能在选择器里用什么」。两份列表并排只会让人对着
  // 两个数字发愣。usage probe 不进 DSH 调用路径，只服务那张表，随表一起去掉；
  // 零额度的 validity probe（验令牌）留在「接入」tab。
  const modelsBody = () => h(
    "div",
    null,
    h(
      SectionCard,
      { title: tt("section.provider"), open: openSections.provider, onToggle: () => toggleSection("provider"), tt },
      h(ProviderCard, {
        provider,
        busy: providerBusy,
        error: providerError,
        onToggle: toggleProvider,
        onSaveList: saveRoster,
        onReset: resetProvider,
        tokenPresent: data?.token.present === true,
        tt
      })
    )
  );

  // 接入 tab：令牌管理（保存/忘掉/验令牌）+ 状态 + 说明。provider 注册在模型
  // tab 顶部（section.provider），令牌仍是它的前置条件——此 tab 只负责令牌。
  const accessBody = () => h(
    "div",
    null,
    h(
      SectionCard,
      { title: tt("section.token"), open: openSections.token, onToggle: () => toggleSection("token"), tt },
      h(TokenForm, {
        token: tokenState,
        busy: tokenBusy || verifyBusy,
        error: tokenError,
        onSave: (value: string) => void saveToken(value),
        onForget: () => void forgetToken(),
        onVerify: sampleModel === null ? undefined : () => void runValidity(sampleModel),
        verifyTitle: sampleModel ?? undefined,
        tt
      }),
      verifyNote !== null ? h("div", { style: S.formNote, role: "status" }, verifyNote) : null,
      verifyError !== null ? h("div", { style: S.formError, role: "alert" }, format(tt("probe.fail"), { error: verifyError })) : null
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
