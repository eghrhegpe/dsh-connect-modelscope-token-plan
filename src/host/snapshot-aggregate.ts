/**
 * 快照聚合：把 token 状态、本地用量、模型目录三路数据软失败地拼成
 * `Snapshot`（src/shared/wire.ts 的契约）。
 *
 * `soft()` 家规：任何一路失败都不许白屏——部分失败呈现为该路的降级形状
 * （models.available=false / shapeWarnings 一条），而不是整条快照 ok:false。
 * 快照路由只在**配置坏**（configError）或聚合器自身抛错时才回 ok:false。
 *
 * 严格区分 null 与 0（wire.ts 语义基线）：本地计数器没记录 = 真实 0；模型
 * 目录读不到 = available:false + error，绝不伪装成「0 个模型」。
 *
 * @module dsh-connect-modelscope-token-plan/snapshot-aggregate
 */
import { PLUGIN_VERSION, name } from "./host-config.ts";
import { rosterWithAvailability, resolveAllowedList } from "./llm-models.ts";
import { resolveSwitchEnabled, switchSource } from "./switch-precedence.ts";
import { errMsg } from "./util.ts";
import type { Snapshot } from "../shared/wire.ts";
import type { Wiring } from "./types.ts";

/** 软失败包装：成功给 value，失败给 {error, code}——从不 reject。 */
async function soft<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string; code: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      ok: false,
      error: errMsg(error),
      code: typeof code === "string" ? code : "internal_error"
    };
  }
}

/**
 * Provider 状态块降级形状：读不到开关/注册状态/目录时，面板仍然得到一个完整
 * 可渲染的块（开关关、roster 空、error 说明原因），绝不让整条快照失败。
 */
function providerDegraded(error: string): Snapshot["provider"] {
  return {
    enabled: false,
    source: "config",
    llmAvailable: false,
    registered: false,
    error,
    modelCount: 0,
    enabledCount: 0,
    allowed: "all",
    enabledIds: [],
    roster: []
  };
}

/** 聚合快照 body。wiring 子集见 routes/snapshot.ts 的 Pick。 */
export async function buildSnapshotBody(wiring: Pick<Wiring, "settings" | "tokenStore" | "usageStore" | "inference" | "providerStore" | "publisher" | "logger">): Promise<Snapshot> {
  const { settings, tokenStore, usageStore, inference, providerStore, publisher } = wiring;

  const [tokenState, daily, perModel, trend, events] = await Promise.all([
    soft(tokenStore.state()),
    soft(usageStore.daily()),
    soft(usageStore.perModelToday()),
    soft(usageStore.trend(settings.trendDays)),
    soft(usageStore.events())
  ]);

  const shapeWarnings: string[] = [];
  const usageAnomaly = usageStore.anomaly();
  if (usageAnomaly !== null) shapeWarnings.push(usageAnomaly);
  for (const path of [tokenState, daily, perModel, trend, events]) {
    if (!path.ok) shapeWarnings.push(`usage-source failed (${path.code}): ${path.error}`);
  }

  // 官方魔粒余额（头条数据源）：需要令牌；无令牌时静默缺席（error 置 null，
  // 面板在「接入」tab 引导配令牌，而不是在「额度」tab 报一条假故障）。
  const tokenPresent = tokenState.ok ? tokenState.value.present : false;
  const balance = await soft(inference.fetchBalance());
  // 模型目录：免认证、零额度；失败降级为 available:false + error。
  const models = await soft(inference.fetchModels());
  const modelIds = models.ok ? models.value.ids : [];
  const modelEntries = models.ok ? models.value.entries : [];
  if (!models.ok && models.code !== "network_error") {
    // 网络抖动不值得一条常驻警告（下一轮轮询自愈）；形状漂移值得。
    shapeWarnings.push(`models: ${models.error}`);
  }
  if (tokenPresent && !balance.ok && balance.code !== "network_error") {
    shapeWarnings.push(`balance: ${balance.error}`);
  }

  // ── provider 块（M4 §11）──
  // 开关（面板值优先，patch 默认兜底）+ 注册状态 + 目录 roster，整块软失败：
  // 任何一路读不到都走降级形状，绝不 ok:false。roster 用 llm-models 的
  // rosterWithAvailability——面板保留额度耗尽的模型（灰显），picker 才丢弃它们，
  // 两处口径不同是故意的。M4 阶段 unavailableIds 传 []（本插件暂无额度耗尽聚合）。
  const provider = await soft((async () => {
    const panel = await providerStore.enabled().catch(() => null);
    const enabled = resolveSwitchEnabled(panel, settings.registerProvider);
    const source = switchSource(panel);
    const roster = rosterWithAvailability(modelEntries, []);
    // 允许清单是落盘的（provider-store，按 profile 分段）；优先从持久层读，否则回退到
    // 内存里 publisher.state 最近一次 publish 用的那份（fix A/E）。重启后内存那份清空，
    // 落盘读能保住用户的清单不丢。
    const stored = await providerStore.enabledIds().catch(() => null);
    const enabledIds = Array.isArray(stored) ? stored
      : (Array.isArray(publisher.state.enabledIds) ? publisher.state.enabledIds : []);
    const allowed = resolveAllowedList(enabledIds);
    const allowSet = new Set(enabledIds);
    const enabledCount = allowed === "all"
      ? roster.length
      : allowed === "list"
        ? roster.filter((row) => allowSet.has(row.id)).length
        : 0;
    return {
      enabled,
      source,
      llmAvailable: publisher.state.llmAvailable === true,
      registered: publisher.state.registered === true,
      error: typeof publisher.state.error === "string" ? publisher.state.error : null,
      modelCount: roster.length,
      enabledCount,
      allowed,
      enabledIds,
      roster
    } satisfies Snapshot["provider"];
  })());

  const usedLocal = daily.ok ? daily.value.calls : 0;

  return {
    ok: true,
    name,
    version: PLUGIN_VERSION,
    now: new Date().toISOString(),
    pollSeconds: settings.pollSeconds,
    cacheSeconds: settings.cacheSeconds,
    token: tokenState.ok
      ? tokenState.value
      : { present: false, source: "none", valid: null, checkedAt: null, ephemeral: true },
    balance: balance.ok
      ? { available: balance.value.available, total: balance.value.total, frozen: balance.value.frozen, fetchedAt: balance.value.fetchedAt, error: null }
      : { available: null, total: null, frozen: null, fetchedAt: null, error: tokenPresent ? balance.error : null },
    quota: {
      // 只有本地次数，没有「上限」也没有「剩余」：官方改魔粒计费后，次数口径的
      // 推算是误导（README「三条事实」第 2 条）。头条数字是上面的 balance。
      daily: { usedLocal },
      perModel: perModel.ok ? perModel.value : [],
      countingNote: "local-counting"
    },
    events: events.ok ? events.value : [],
    trend: { days: settings.trendDays, buckets: trend.ok ? trend.value : [] },
    models: {
      available: models.ok,
      count: modelIds.length,
      sample: modelIds.slice(0, 20),
      error: models.ok ? null : models.error
    },
    // provider 块（M4 §11）：软失败，失败给降级形状而非整条快照失败。
    provider: provider.ok ? provider.value : providerDegraded(provider.error),
    shapeWarnings,
    // quotaError 为 M4 预留（wire.ts 语义）；v0.1 的失败都走 shapeWarnings /
    // balance.error 呈现，此字段恒 null。
    quotaError: null
  };
}

/** 聚合器自身抛错时的失败码（快照路由的 ok:false 分支用）。 */
export function failureCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "internal_error";
}
