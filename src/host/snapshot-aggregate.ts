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

/** 聚合快照 body。wiring 子集见 routes/snapshot.ts 的 Pick。 */
export async function buildSnapshotBody(wiring: Pick<Wiring, "settings" | "tokenStore" | "usageStore" | "inference" | "logger">): Promise<Snapshot> {
  const { settings, tokenStore, usageStore, inference } = wiring;

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
  if (!models.ok && models.code !== "network_error") {
    // 网络抖动不值得一条常驻警告（下一轮轮询自愈）；形状漂移值得。
    shapeWarnings.push(`models: ${models.error}`);
  }
  if (tokenPresent && !balance.ok && balance.code !== "network_error") {
    shapeWarnings.push(`balance: ${balance.error}`);
  }

  const usedLocal = daily.ok ? daily.value.calls : 0;
  const dailyLimit = settings.dailyQuotaTotal;

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
      daily: {
        limit: dailyLimit,
        usedLocal,
        remainingComputed: Math.max(0, dailyLimit - usedLocal)
      },
      perModelLimit: settings.dailyQuotaPerModel,
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
