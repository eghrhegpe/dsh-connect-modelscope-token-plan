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
import { resolveWindowDays } from "./usage-prefs-store.ts";
import { rosterWithAvailability, drawCandidates, resolveDrawModelChoice } from "./llm-models.ts";
import { parseAllowedList, enabledCountOf } from "../shared/allow-list.ts";
import { resolveSwitchEnabled, resolveSwitchValue, switchSource } from "./switch-precedence.ts";
import { drawToolMounted, drawToolNote } from "./draw-tool-state.ts";
import { CURATED_AS_OF, curatedCatalogAgeDays, curatedCatalogStale } from "./context-catalog.ts";
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

/** 聚合快照 body。wiring 子集见 routes/snapshot.ts 的 Pick。 */
export async function buildSnapshotBody(wiring: Pick<Wiring, "settings" | "tokenStore" | "usageStore" | "inference" | "providerStore" | "drawStore" | "usagePrefsStore" | "publisher" | "logger">): Promise<Snapshot> {
  const { settings, tokenStore, usageStore, inference, providerStore, drawStore, usagePrefsStore, publisher } = wiring;

  // 趋势的显示窗口**先**裁决出来：面板覆盖 > 配置默认，再夹进保留窗口
  // （resolveWindowDays 一处算完）。这一步必须排在拉 `trend` 之前——它是 trend()
  // 的**入参**，不是拿到桶之后再切：Host 只发生效窗口那些桶，面板不替它重算。
  //
  // 覆盖读失败按「未保存」降级（与 provider / draw 块里的偏好读同一条纪律）：
  // 回退方向是配置默认，不是丢数据；真正需要说出口的是版本漂移，那条由下面的
  // versionNote 负责。
  const panelWindow = await usagePrefsStore.windowDays().catch(() => null);
  const windowDays = resolveWindowDays(panelWindow, settings.trendDays, settings.retentionDays);

  const [tokenState, daily, perModel, trend, events, providerNote] = await Promise.all([
    soft(tokenStore.state()),
    soft(usageStore.daily()),
    soft(usageStore.perModelToday()),
    soft(usageStore.trend(windowDays)),
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
  // 目录取数带**当前窗口覆盖**：与轮询/写路由共用同一个带指纹的缓存键，面板
  // roster 与真实注册看到的是同一份打标条目，不会各说一套。覆盖读不到按目录
  // 原样取（null），不阻塞快照。
  const contextOverride = await providerStore.contextWindow().catch(() => null);
  const [balance, models] = await Promise.all([
    soft(inference.fetchBalance()),
    soft(inference.fetchModels(contextOverride))
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
  // draw.json 与 provider.json 同一条纪律（store 的 versionNote 注释详述）：
  // 未知版本宽容读作「没设过」，回退方向是 patch 默认（通常 = 关）——不说出口，
  // 「保存的出图开关与模型偏好被忽略」就是「从未保存过」。包一层异步 IIFE 是
  // 为了与下面的 draw 块同样宽容：装配缺桩（测试）时走 soft 的降级路径，
  // 不让一条注释外的 TypeError 把整条快照打掉。
  const drawNote = await soft((async () => drawStore.versionNote())());
  if (drawNote.ok && drawNote.value !== null) shapeWarnings.push(drawNote.value);
  // usage-prefs.json 与上面两份同一条纪律：未知版本宽容读作「没设过」，回退方向是
  // 配置默认——不说出口，「保存的显示窗口被忽略」就是「从未保存过」。
  const windowNote = await soft((async () => usagePrefsStore.versionNote())());
  if (windowNote.ok && windowNote.value !== null) shapeWarnings.push(windowNote.value);

  // 策展上下文窗口表是静态知识（context-catalog.ts），目录会上下架而表不会自己
  // 更新。过期不是错误——表里的值往往仍然正确——但「不再有核对背书」这件事该
  // 说出来，否则用户无从判断一个窗口值是三个月前还是三年前核的。
  if (curatedCatalogStale()) {
    const age = curatedCatalogAgeDays();
    shapeWarnings.push(
      `context-catalog: curated windows were last verified on ${CURATED_AS_OF}` +
      (age === null ? "" : ` (${age} days ago)`) +
      " — re-check them against the current catalogue"
    );
  }

  // ── provider 块（M4 §11）──
  // 开关（面板值优先，patch 默认兜底）+ 注册状态 + 目录 roster，整块软失败：
  // 任何一路读不到都走降级形状，绝不 ok:false。roster 用 llm-models 的
  // rosterWithAvailability——面板保留额度耗尽的模型（灰显），picker 才丢弃它们，
  // 两处口径不同是故意的。**耗尽集合的唯一生产者是 provider-reconciler**
  // （每轮从 429 事件流按纯函数 exhaustedModelIds 推断），这里读的是
  // publisher 最近一次发布的那份（state.unavailableIds）——面板灰显的与
  // picker 实际丢掉的因此永远同一批；没有 reconcile 跑过时它是 []（尚无证据）。
  const provider = await soft((async () => {
    const panel = await providerStore.enabled().catch(() => null);
    const enabled = resolveSwitchEnabled(panel, settings.registerProvider);
    const source = switchSource(panel);
    // 第三个参数是输出上限覆盖：面板 roster 与 picker 必须用**同一个**解析器
    // （llm-models.maxTokensFor），否则面板显示的 `maxOutputLength` 与线上真正发
    // 的 `max_tokens` 会各说一套——那正是这次要修的毛病（面板此前连这个字段都
    // 没投影给客户端）。
    const roster = rosterWithAvailability(modelEntries, publisher.state.unavailableIds ?? [], settings.maxTokensOverrides);
    // 允许清单是落盘的（provider-store，按 profile 分段）；判据走**共用**的
    // resolveEnabledIds：可读的清单（含空清单 = 不过滤）优先，只有读抛错才回退到
    // 内存里 publisher.state 最近一次 publish 的那份。三处消费者曾各写一套，其中
    // 轮询侧那套把「空清单」读成「没有答案」，于是面板与 Host 会各说一套。
    const stored = await providerStore.enabledIds().catch(() => null);
    const enabledIds = resolveEnabledIds(stored, publisher.state.enabledIds);
    // 允许清单的三态与启用数都从 shared/allow-list.ts 的联合上取——快照与
    // provider 路由共用同一份解释（各自写一套三元链的时代结束了）。
    const allowedList = parseAllowedList(enabledIds);
    const enabledCount = enabledCountOf(allowedList, roster.map((row) => row.id));
    // 窗口覆盖同样落盘（同一份 provider.json）；读抛错按「未设置」降级，与开关
    // 同一纪律——读不到不能把整块 provider 状态打掉。roster 行的 contextWindow
    // 已由 fetchModels 在归一前打上覆盖/策展标记（contextSource 随行透传），
    // 这里不再二次加工。
    const contextWindow = await providerStore.contextWindow().catch(() => null);
    // 目录读不到时**必须替操作者说出原因**：wire.ts 的 ProviderStatus 承诺「目录
    // 读不到时 modelCount 为 0、roster 为空、error 说明原因」，而 provider-reconcile
    // 在目录 fetch 失败时只 `logger.warn`、不写 `publisher.state.error`（那份 error
    // 只记 publish 失败）。2026-10-19 锐评实测：目录宕机那一刻面板呈现「已注册 +
    // 0 个模型 + 没有任何原因」，而旧 roster 其实还在服务——这正是红线 3
    // （读不到 ≠ 0）在 provider 块上的漏点。publish 自己的 error 优先（它更具体），
    // 没有再退回目录原因。**不复用 models 的 shapeWarnings 抑制规则**：那条抑制是
    // 为了不往形状漂移横幅里塞网络抖动，而这里正是用户在看的那个块。
    const catalogNote = models.ok ? null : `模型目录读不到：${models.error}`;
    return {
      enabled,
      source,
      llmAvailable: publisher.state.llmAvailable === true,
      registered: publisher.state.registered === true,
      error: typeof publisher.state.error === "string" ? publisher.state.error : catalogNote,
      modelCount: roster.length,
      enabledCount,
      allowed: allowedList.mode,
      enabledIds,
      contextWindow,
      roster
    } satisfies Snapshot["provider"];
  })());

  // ── 出图块 ──
  // 与 provider 块同一套纪律：整块软失败，任何一路读不到都走降级形状，绝不 ok:false。
  // 候选来自**目录**（平台声明的出图能力），不是 provider 的允许清单——用户裁剪
  // chat picker 不该波及出图工具的候选。
  const draw = await soft((async () => {
    const panel = await drawStore.enabled().catch(() => null);
    const panelModel = await drawStore.modelId().catch(() => null);
    // 候选明细（能力档 + 纯文生图标记）与「当前使用谁、为什么」都从同一份
    // llm-models 判定派生——面板每行徽章与顶部「当前使用」不可能对它说两套话。
    const candidates = drawCandidates(modelEntries);
    const preferred = resolveSwitchValue(panelModel, settings.drawModelId === "" ? undefined : settings.drawModelId) ?? null;
    const choice = resolveDrawModelChoice(modelEntries, undefined, preferred ?? undefined);
    return {
      enabled: resolveSwitchEnabled(panel, settings.drawEnabled),
      source: switchSource(panel),
      candidateIds: candidates.map((row) => row.id),
      candidateCount: candidates.length,
      candidates,
      preferredModel: preferred,
      preferredSource: switchSource(panelModel),
      effectiveModel: choice.id,
      effectiveSource: choice.source,
      // 缺席原因由 draw-register 在挂载时写入（仅内存）；开关未开时它也是 null，
      // 面板据 enabled 区分「没开」与「开了但不在」。
      absentReason: drawToolNote(),
      // 「待重启」的真判据是**本次挂载没注册上**，不是「有缺席原因」——两者恰好
      // 互补：缺席原因非 null = 注册尝试过且失败，而挂载那一刻开关是关的（用户
      // 之后才翻开）时 absentReason 是 null、却同样没注册上。用后者当判据会把
      // 最常见的「刚打开开关」场景漏掉。见 `draw-tool-state.ts` 文件头。
      mountPending: resolveSwitchEnabled(panel, settings.drawEnabled) === true && drawToolMounted() !== true,
      // 首选模型还在不在目录里。`false` = 目录读到了、它不在（模型下架/改名，
      // 但快照仍按「用户点了谁就是谁」照显这个 id）；`null` = 目录读不到或没设
      // 首选，不敢断言。红线 3：不知道 ≠ 不在。
      preferredInCatalog:
        preferred === null ? null : models.ok ? candidates.some((row) => row.id === preferred) : null,
      toolName: "modelscope_draw_image"
    } satisfies Snapshot["draw"];
  })());

  // 块级失败原因**必须进 shapeWarnings**：块本身被省略了（见下），若原因也跟着
  // 消失，操作者只看到面板「未接入」，而真相是「Host 读不到自己的状态」——那是
  // 可处置的信息，不能丢。格式与上面各路一致（label + code + error）。
  if (!provider.ok) shapeWarnings.push(`provider source failed (${provider.code}): ${provider.error}`);
  if (!draw.ok) shapeWarnings.push(`draw source failed (${draw.code}): ${draw.error}`);

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
      // 读不到 = null（读不到 ≠ 0，wire.ts quota.perModel 的语义）：perModelToday()
      // 自身的三态透上来，面板画「—」。曾经这里 `perModel.ok ? perModel.value : []`——
      // soft() 失败时降级成空数组，与「读到了、今天确实没有模型调用」同形，于是坏
      // 文件在今日计数上画「—」、在单模型排行上画「还没有本地调用记录。」（同一份坏
      // 数据两个答案，与 trend.buckets 同款）。
      perModel: perModel.ok ? perModel.value : null,
      countingNote: "local-counting"
    },
    // 同一红线：events() 三态透传，读不到 = null 而不是 []（wire.ts events 语义）。
    events: events.ok ? events.value : null,
    trend: {
      // 生效天数（已裁决 + 夹取）；面板标题与图上柱数都用它。
      days: windowDays,
      // 面板保存的覆盖值（`null` = 跟随配置默认），面板据此回显选择器。
      windowDays: panelWindow,
      // 可选窗口的上界 = 保留窗口。画得比它多会把已剪的日子画成 0。
      maxDays: settings.retentionDays,
      // 读不到 = null（读不到 ≠ 0，wire.ts TrendBucket 的语义）：`trend()` 自身
      // 的三态透上来，面板画「—」。曾经这里 `trend.ok ? trend.value : []`——soft()
      // 失败时降级成空数组，与「读到了、这些天确实一次都没有」同形，于是坏文件在
      // 今日计数上画「—」、在趋势图上画一片结实的零柱（同一份坏数据两个答案）。
      buckets: trend.ok ? trend.value : null
    },
    models: {
      available: models.ok,
      count: modelIds.length,
      sample: modelIds.slice(0, 20),
      error: models.ok ? null : models.error
    },
    // provider 块（M4 §11）：软失败，失败时**省略**整个块——与出图块同一条纪律
    // （wire 里两者都是可选）。
    //
    // 这里曾经塞一个填满默认值的「降级块」（开关关、roster 空、allowed:"all"），
    // 而那个形状**看起来就是一个答案**：面板据此认为块在，于是不再走
    // `GET /provider` 的兜底，只能拿编出来的值渲染——真相却是「读不到」。省略
    // 让兜底真的跑起来（兜底也失败才用 DEGRADED_PROVIDER），也让「降级形状」只剩
    // 客户端那一份，而不是 Host 编一份、客户端再编一份。
    ...(provider.ok ? { provider: provider.value } : {}),
    // 出图块：同一条纪律。失败时省略，面板走 drawOf 的降级形状——比硬塞一个可能
    // 误导的「未开启」更诚实。
    ...(draw.ok ? { draw: draw.value } : {}),
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
