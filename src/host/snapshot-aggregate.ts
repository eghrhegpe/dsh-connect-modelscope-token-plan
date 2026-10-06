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
import { CODE } from "./codes.ts";
import { resolveEnabledIds } from "./provider-store.ts";
import { rosterWithAvailability, resolveAllowedList } from "./llm-models.ts";
import { resolveSwitchEnabled, switchSource } from "./switch-precedence.ts";
import { errMsg, redactSecrets } from "./util.ts";
import type { Snapshot } from "../shared/wire.ts";
import type { Wiring } from "./types.ts";

/**
 * 软失败包装：成功给 value，失败给 {error, code}——从不 reject。
 *
 * **`error` 在这里脱敏，这是本模块唯一的安全收口。** 这个字符串会一路流进
 * `shapeWarnings`、`balance.error`、`models.error`（面板可见）与快照路由的响应体，
 * 所以「下游每个 promise 都已自行脱敏」这个假设一旦有任何一个遵守者，令牌就直达
 * 面板。契约不该靠下游的自觉：**收口处自己脱敏**，下游脱敏是纵深防御而不是前提。
 *
 * 代价是重复脱敏（上游多已脱敏过一次）——`redactSecrets` 是幂等的（已替换成
 * `ms-[REDACTED]` 的内容再过一次仍是它），这点开销换掉「凭据可能外泄」这个尾部
 * 风险划算。
 */
async function soft<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string; code: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      ok: false,
      error: redactSecrets(errMsg(error)),
      code: typeof code === "string" ? code : CODE.INTERNAL_ERROR
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

  const [tokenState, daily, perModel, trend, events, providerNote] = await Promise.all([
    soft(tokenStore.state()),
    soft(usageStore.daily()),
    soft(usageStore.perModelToday()),
    soft(usageStore.trend(settings.trendDays)),
    soft(usageStore.events()),
    soft(providerStore.versionNote())
  ]);

  const shapeWarnings: string[] = [];
  const usageAnomaly = usageStore.anomaly();
  if (usageAnomaly !== null) shapeWarnings.push(usageAnomaly);
  // 逐路标注来源：token 不是「用量源」，混进同一句会让操作者去查错文件。
  for (const [label, path] of [
    ["token", tokenState],
    ["daily", daily],
    ["per-model", perModel],
    ["trend", trend],
    ["events", events]
  ] as const) {
    if (!path.ok) shapeWarnings.push(`${label} source failed (${path.code}): ${path.error}`);
  }

  // 官方魔粒余额（头条数据源）：需要令牌；**确定没有令牌**时才静默缺席（error 置
  // null，面板在「接入」tab 引导配令牌，而不是在「额度」tab 报一条假故障）。
  //
  // 判据只能是「读到了令牌状态、且它说没有」：令牌状态**读不到**时我们并不知道
  // 有没有令牌，此时压掉余额错误等于替操作者断言「你没配令牌」——那是伪造，不是
  // 降级（旧写法 `tokenState.ok ? present : false` 正是这样）。
  const tokenKnownAbsent = tokenState.ok && tokenState.value.present === false;
  // 余额与目录互不依赖（余额要令牌、目录免认证），一起发。理由不是省延迟——
  // 目录走缓存键 coalescing，命中时近乎瞬时；真正的问题是**依赖方向反了**：
  // 免认证的目录取数原先排在要鉴权的余额取数之后，而后者最坏是整段 inference
  // 超时。令牌一过期，一条免费的请求就被拖满整个超时窗口。
  const [balance, models] = await Promise.all([
    soft(inference.fetchBalance()),
    soft(inference.fetchModels())
  ]);
  const modelIds = models.ok ? models.value.ids : [];
  const modelEntries = models.ok ? models.value.entries : [];
  if (!models.ok && models.code !== "network_error") {
    // 网络抖动不值得一条常驻警告（下一轮轮询自愈）；形状漂移值得。
    shapeWarnings.push(`models: ${models.error}`);
  }
  if (!tokenKnownAbsent && !balance.ok && balance.code !== "network_error") {
    shapeWarnings.push(`balance: ${balance.error}`);
  }
  if (providerNote.ok && providerNote.value !== null) {
    // provider.json 由更新的构建写入时，读侧是宽容的（读作「未设置」），所以这里
    // 必须说出来：不说，面板会把「保存的开关与清单被忽略」呈现成「从未保存过」。
    // 而「空清单 = 不过滤」恰好是那个方向上最危险的答案——用户勾了隐藏清单，
    // 重启后变成全部提供，且没有任何一条警告能提示他。写侧的 ADR-006 守卫挡的是
    // 覆盖，这条警告补的是读侧。
    shapeWarnings.push(providerNote.value);
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
    // 允许清单是落盘的（provider-store，按 profile 分段）；判据走**共用**的
    // resolveEnabledIds：可读的清单（含空清单 = 不过滤）优先，只有读抛错才回退到
    // 内存里 publisher.state 最近一次 publish 的那份。三处消费者曾各写一套，其中
    // 轮询侧那套把「空清单」读成「没有答案」，于是面板与 Host 会各说一套。
    const stored = await providerStore.enabledIds().catch(() => null);
    const enabledIds = resolveEnabledIds(stored, publisher.state.enabledIds);
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

  // 读不到就是 null（不是 0）：0 是可信的日常值，把「读不到」渲成 0 会让操作者以为
  // 今天没调用过，而真相是他不知道。面板对 null 渲染「—」（见 wire.ts DailyUsage）。
  const usedLocal = daily.ok ? daily.value.calls : null;

  return {
    ok: true,
    name,
    version: PLUGIN_VERSION,
    now: new Date().toISOString(),
    pollSeconds: settings.pollSeconds,
    cacheSeconds: settings.cacheSeconds,
    token: tokenState.ok
      ? { ...tokenState.value, readError: null }
      : { present: false, source: "none", valid: null, checkedAt: null, ephemeral: true, readError: tokenState.error },
    balance: balance.ok
      ? { available: balance.value.available, total: balance.value.total, frozen: balance.value.frozen, fetchedAt: balance.value.fetchedAt, error: null }
      : { available: null, total: null, frozen: null, fetchedAt: null, error: tokenKnownAbsent ? null : balance.error },
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
  return typeof code === "string" ? code : CODE.INTERNAL_ERROR;
}
