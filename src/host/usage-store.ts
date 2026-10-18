/**
 * 本地用量存储——面板「额度」tab 的数据真源。
 *
 * 为什么存在：官方只给**总**魔粒余额（`/openapi/v1/magicubes/balance`），不给
 * 「哪个模型吃了多少、刚才谁在限频」。本 store 是那半边问题的答案——面板头条是
 * 官方余额（真实值），本文件供的是分布 / 趋势 / 429 事件流。**不提供**「剩余次数」
 * 推算：次数口径的上限是社区快照，与魔粒并排是误导，那条推算已从面板删除。
 *
 * 写入侧**只有** `usage-observer.ts`（在 provider 流出口观测真实对话）。面板上
 * 没有任何入口能直接记一笔用量——早先 probe 路由的 `kind:"usage"` 试调已删除。
 *
 * 持久化纪律（与姊妹插件同款）：`$DSH_HOME/state/[<profile>/]<name>/usage.json`
 * —— 按 profile 分段（它回答的是「这个 profile 的调用吃了多少额度」，与
 * catalog/provider 开关同侧；没有共享跨 profile 的理由）。原子写（0600 temp
 * + rename）、损坏即忽略、版本守卫拒覆写未知版本。进程内 1s 读缓存让一次
 * 快照聚合的多次问询自洽。
 *
 * 旧共享布局**不继承**（2026-10-18 补记的裱定）：profile 分段前写在共享目录里的
 * usage.json 不做一次性迁移——它回答「这个 profile 的调用吃了多少额度」，而无
 * profile 时期（宿主不提供 profileContext）的账不属于任何一个 profile，整段搬
 * 过来是把那段账算成这个 profile 的。宿主升级后开始提供该服务时，旧文件原地
 * 保留，由 `npm run doctor` 以 shared (legacy) 作用域报出——面板不搬历史，但操作者看得见
 * 它（诊断诚实性，见 doctor.ts）。（usage-prefs 的单值偏好反而继承，裱定见
 * usage-prefs-store.ts 头注）。
 *
 * 语义基线（wire.ts）：
 * - 天桶缺失 = 该日本插件没有记录到调用 = 真实的 0，不是数据丢失；
 * - models 的 `tokens` 可为 null（上游没给 usage 时），绝不把 null 写成 0；
 * - 事件流有界（maxEvents）， Newest-first。
 *
 * peer-free：纯 node:fs，离线可测（注入 dir 即可，见 test/usage-store.test.mjs）。
 *
 * @module dsh-connect-modelscope-token-plan/usage-store
 */
import { join } from "node:path";
import { stat } from "node:fs/promises";
import {
  ensureStateDir,
  isKnownStateVersion,
  createStateReadCache,
  createStateWriteQueue,
  profileStateDir,
  readStateJson,
  readStateVersion,
  temporaryOf,
  writeStateFile
} from "./state-store.ts";
import { pluginError, errMsg, redactSecrets } from "./util.ts";
import { CODE } from "./codes.ts";
import type { QuotaEvent, TrendBucket } from "../shared/wire.ts";

/** 本地日期键（ quota 按天重置，以 Host 本地时区为准）。 */
export function localDateKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 路径在不在（任何 fs 错误都读作「不在」——存在性问的是能不能 `ls` 到它。
 * EACCES 让 `stat` 失败时，真相其实是「在，只是看不见」，而对下面的判据来说
 * 那同样不能被当成「没有记录」）。
 */
async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** 单日桶。 */
interface DayBucket { calls: number; tokens: number; }

/**
 * 单模型计数；`day` 是 dayCalls/dayTokens 的归属日（跨日自动清零的依据）。
 * `tokens` 是历史累计（面板不看它，doctor/排查用）；对外口径（perModelToday）
 * 一律走 dayTokens——「今日」行里并排历史累计是误导（审核 2026-10-04）。
 */
interface ModelCounter { calls: number; tokens: number | null; lastAt: string | null; day: string; dayCalls: number; dayTokens: number; }

/** usage.json 的磁盘载荷。 */
interface UsagePayload {
  version: number;
  days: Record<string, DayBucket>;
  models: Record<string, ModelCounter>;
  events: QuotaEvent[];
}

const STATE_VERSION = 1;
const KNOWN_VERSIONS: readonly number[] = [STATE_VERSION];

/** 解析并校验磁盘载荷；形状不对读作 null（损坏即忽略），并标记异常。 */
function parsePayload(raw: unknown): { payload: UsagePayload | null; anomaly: string | null } {
  if (raw === null) return { payload: null, anomaly: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { payload: null, anomaly: "usage-state: payload is not an object" };
  }
  const source = raw as Record<string, unknown>;
  const version = source.version;
  if (typeof version !== "number" || !KNOWN_VERSIONS.includes(version)) {
    return { payload: null, anomaly: `usage-state: unknown version ${String(version)}` };
  }
  const days: Record<string, DayBucket> = {};
  const rawDays = source.days;
  if (rawDays !== undefined && rawDays !== null) {
    if (typeof rawDays !== "object" || Array.isArray(rawDays)) {
      return { payload: null, anomaly: "usage-state: days is not an object" };
    }
    for (const [key, value] of Object.entries(rawDays as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const bucket = value as Record<string, unknown>;
        const calls = typeof bucket.calls === "number" && Number.isFinite(bucket.calls) ? bucket.calls : 0;
        const tokens = typeof bucket.tokens === "number" && Number.isFinite(bucket.tokens) ? bucket.tokens : 0;
        days[key] = { calls, tokens };
      }
    }
  }
  const models: Record<string, ModelCounter> = {};
  const rawModels = source.models;
  if (rawModels !== undefined && rawModels !== null) {
    if (typeof rawModels !== "object" || Array.isArray(rawModels)) {
      return { payload: null, anomaly: "usage-state: models is not an object" };
    }
    for (const [key, value] of Object.entries(rawModels as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const counter = value as Record<string, unknown>;
        models[key] = {
          calls: typeof counter.calls === "number" && Number.isFinite(counter.calls) ? counter.calls : 0,
          tokens: typeof counter.tokens === "number" && Number.isFinite(counter.tokens) ? counter.tokens : null,
          lastAt: typeof counter.lastAt === "string" ? counter.lastAt : null,
          day: typeof counter.day === "string" ? counter.day : "",
          dayCalls: typeof counter.dayCalls === "number" && Number.isFinite(counter.dayCalls) ? counter.dayCalls : 0,
          // v1 加性字段：旧载荷缺失按 0 起（与 dayCalls 同窗的今日 token 数）。
          dayTokens: typeof counter.dayTokens === "number" && Number.isFinite(counter.dayTokens) ? counter.dayTokens : 0
        };
      }
    }
  }
  const events = Array.isArray(source.events)
    ? (source.events as unknown[]).filter((entry): entry is QuotaEvent =>
        Boolean(entry) && typeof entry === "object" &&
        typeof (entry as QuotaEvent).at === "string" &&
        typeof (entry as QuotaEvent).modelId === "string" &&
        typeof (entry as QuotaEvent).kind === "string" &&
        typeof (entry as QuotaEvent).message === "string"
      )
    : [];
  return { payload: { version: STATE_VERSION, days, models, events }, anomaly: null };
}

/**
 * 构造文件用量 store。
 * @param {object} options
 * @param {string} options.name - 插件 slug（状态目录名，来自 host-config）。
 * @param {string|null} [options.profile] - profile 名；null = 共享目录。
 * @param {number} [options.retentionDays] - 天桶**保留**数（超出即修剪；从配置注入，
 *   让「配置改小」在下次写入时生效，而不是等一个固定的内部常数）。与「显示多少天」
 *   是两件事——显示窗口由调用方传给 `trend(days)`，保留窗口恒 ≥ 它（host-config 夹）。
 * @param {number} [options.maxEvents] - 事件流上限。
 * @param {() => Date} [options.now] - 时钟源；测试注入。
 * @param {{warn?: (message: string) => void}} [options.logger] - ctx.logger。
 */
export function createFileUsageStore({ name, profile = null, retentionDays = 90, maxEvents = 50, now = () => new Date(), logger }: {
  name: string;
  profile?: string | null;
  retentionDays?: number;
  maxEvents?: number;
  now?: () => Date;
  logger?: { warn?: (message: string) => void };
}) {
  const dir = profileStateDir(name, profile);
  const file = join(dir, "usage.json");
  /** 最近一次解析异常（损坏即忽略的痕迹），快照转 shapeWarnings。 */
  let anomaly: string | null = null;
  /** 只读闸：磁盘版本比本构建新时置位——读照常、写拒绝，绝不 clobber。 */
  let readOnly = false;

  /** 最近一次确认过的内存态；读路径拿它，写路径以它为基线。 */
  let current: UsagePayload = { version: STATE_VERSION, days: {}, models: {}, events: [] };
  let loaded = false;
  /** 写串行化：读-改-写必须排队，两个并发 recordCall 不能互相覆盖。
     队列实现在 state-store（{@link createStateWriteQueue}）——provider / draw
     同款，三份私有副本正是 draw-store 曾经三件全缺的入口。 */
  const writeQueue = createStateWriteQueue();

  /**
   * 磁盘版本闸 —— 读路径与写路径**各自**调用，不共享副作用。
   *
   * 为什么必须两边都直接调（而不是让读路径置位、写路径顺带检查）：这个函数
   * 早先只在 `readThrough` 里被调用，而写路径的守卫写在 `enqueue` 开头——那时
   * `readOnly` 还没被置位（置位发生在随后的 `cache.read()` 内部），于是**守卫永远
   * 比真正的探测晚一步**，旧构建会用一个空载荷把新构建的 usage.json 降级覆写
   * （实测：version 2 → 1，110 次历史归零，而日志还在说 "recording disabled to
   * avoid clobbering"——日志与磁盘状态互相撒谎）。
   *
   * 现在写路径在 mutate 之前**自己**读一次盘，判据与执行之间不再隔着一个 await。
   *
   * @returns `true` = 磁盘版本比本构建新（写必须拒绝）；`false` = 可以写。
   */
  const diskVersionBlocksWrites = async (): Promise<boolean> => {
    let onDisk: number | null;
    try {
      onDisk = await readStateVersion(file);
    } catch (error) {
      // 文件存在却读不出来（EACCES/EBUSY/EIO）：**不能**当成「没有文件」放行写入，
      // 那正是这个闸要拦的降级覆盖。置只读闸并说明原因——它与版本闸共用同一个
      // 闩锁，所以文件恢复可读（或操作者按 doctor 的建议删掉它）时，下面那段
      // 「复位」逻辑会把记录恢复上来。
      const note = `usage-state: usage.json exists but cannot be read (${redactSecrets(errMsg(error))})`;
      if (!readOnly) logger?.warn?.(`${name}: ${note} — recording disabled to avoid clobbering`);
      anomaly = note;
      readOnly = true;
      return true;
    }
    if (onDisk !== null && !isKnownStateVersion(onDisk, KNOWN_VERSIONS)) {
      const note = `usage-state: on-disk version ${onDisk} is newer than this build knows`;
      if (!readOnly) logger?.warn?.(`${name}: ${note} — recording disabled to avoid clobbering`);
      anomaly = note;
      readOnly = true;
      return true;
    }
    // 版本已知（或文件不存在）→ 闸可以开。**复位**是这里的关键：闩锁曾经只置位
    // 不复位，于是用户按doctor 的建议删掉 usage.json 之后，readOnly 永远停在
    // true——文件永不重建、每次写入静默丢弃，而面板还在显示内存里的残留数字，
    // 唯一出路是重启 Host。删文件是用户可见的恢复手段，闩锁必须认。
    if (readOnly) {
      logger?.warn?.(`${name}: usage-state: version guard lifted (on-disk version ${onDisk ?? "none"}) — recording resumed`);
      readOnly = false;
    }
    return false;
  };

  /** 读盘（缓存穿透）；返回 null = 无记录或损坏。 */
  const readThrough = async (): Promise<UsagePayload | null> => {
    // 版本守卫先于解析：未知版本是**更新构建**写的，读作空并进入只读——
    // 只挡读不挡写的话，下一次 recordCall 会用一个空载荷覆写新版文件。
    if (await diskVersionBlocksWrites()) return null;
    const parsed = parsePayload(await readStateJson(file));
    anomaly = parsed.anomaly;
    if (parsed.anomaly !== null) logger?.warn?.(`${name}: ${parsed.anomaly} — starting from empty`);
    return parsed.payload;
  };

  const cache = createStateReadCache<UsagePayload>(readThrough, { now: () => Date.now() });

  /** 把内存态写盘（原子），失败不抛——计数是尽力而为的观测，不是事务。 */
  const persist = async (payload: UsagePayload) => {
    await ensureStateDir(dir);
    await writeStateFile(file, JSON.stringify(payload), { temporary: temporaryOf(dir, "usage.json") });
    cache.remember(payload);
  };

  /**
   * 排队执行一次读-改-写；版本冲突时整个变更是 no-op。
   *
   * 闸在**临界区内部**由 diskVersionBlocksWrites 现读磁盘判定，不读内存里的
   * readOnly——那个变量只用于日志去重与「闸已抬起」通知，删掉它不会让任何一次
   * 写入被放行或拦住（2026-10-18 变异实证：删掉复位块后「删文件后写入必须恢复」
   * 与「新计数落盘」两条断言仍然全绿）。
   *
   * 注释曾写「只读闸置位时整个变更是 no-op」——把判定归给内存闩锁。a61db2f（10-04，
   * 首次提交）起就是这么写的，那时磁盘闸还没长出来，那句话是真的；403bfbc（10-05）
   * 把守卫改成临界区内现读磁盘之后它就过期了，一直没被发现——因为没有任何断言
   * 读它，它只是一句注释。
   */
  const enqueue = (mutate: (payload: UsagePayload) => void) =>
    writeQueue.enqueue(async () => {
      // 守卫在这里**自己**读盘，而不是依赖 readThrough 的副作用——见
      // diskVersionBlocksWrites 的注释：这个 await 之后才可能发生写入，所以
      // 判据必须落在同一个 await 链上，中间不能隔任何东西。
      if (await diskVersionBlocksWrites()) return;
      // 写基线**每次都从磁盘重读**（readThrough 直读，不走 TTL 缓存），也不复用内存里
      // 的 `current`：两个 Host 进程可以共用一个状态目录（本仓自己的前提，见
      // state-store / provider-store 的文件头），而把基线钉在内存里的写法会让后写者用
      // 一整份陈旧载荷覆盖对方——丢的不只是计数，还有 events 与趋势天桶。这与
      // provider-store 的 patchPayload 是同一条纪律：读-改-写必须在临界区里重新读。
      // 读盘失败/损坏时回退内存态：宁可退回旧行为，也不让一次坏读把计数清零。
      const fromDisk = (await readThrough()) ?? (loaded ? current : null);
      const payload: UsagePayload = fromDisk ?? { version: STATE_VERSION, days: {}, models: {}, events: [] };
      mutate(payload);
      current = payload;
      loaded = true;
      await persist(payload);
    });

  /** 修剪：只留最近 retentionDays 个天桶（按 dateKey 排序，今天不删）。 */
  const pruneDays = (payload: UsagePayload, todayKey: string) => {
    const keep = new Set(
      Object.keys(payload.days)
        .sort()
        .slice(-Math.max(1, retentionDays))
    );
    keep.add(todayKey);
    for (const key of Object.keys(payload.days)) {
      if (!keep.has(key)) delete payload.days[key];
    }
  };

  return {
    /** 记一次调用（今天 +1；模型计数跨日清零；tokens 可为 null）。 */
    async recordCall({ modelId, tokens = null, at = now() }: { modelId: string; tokens?: number | null; at?: Date }) {
      if (typeof modelId !== "string" || modelId.trim() === "") {
        throw pluginError(CODE.CONFIG_ERROR, "recordCall: modelId is required");
      }
      const dayKey = localDateKey(at);
      await enqueue((payload) => {
        const day = payload.days[dayKey] ?? { calls: 0, tokens: 0 };
        day.calls += 1;
        if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) day.tokens += tokens;
        payload.days[dayKey] = day;
        const counter = payload.models[modelId] ?? { calls: 0, tokens: null, lastAt: null, day: dayKey, dayCalls: 0, dayTokens: 0 };
        if (counter.day !== dayKey) {
          // 跨日：总累计保留，当日计数清零（「今日单模型用量」的口径）。
          counter.day = dayKey;
          counter.dayCalls = 0;
          counter.dayTokens = 0;
        }
        counter.calls += 1;
        counter.dayCalls += 1;
        if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
          counter.tokens = (counter.tokens ?? 0) + tokens;
          counter.dayTokens += tokens;
        }
        counter.lastAt = at.toISOString();
        payload.models[modelId] = counter;
        pruneDays(payload, dayKey);
      });
    },

    /** 记一条事件（429/错误），Newest-first，截断到 maxEvents。 */
    async recordEvent({ modelId, kind, message, at = now() }: { modelId: string; kind: QuotaEvent["kind"]; message: string; at?: Date }) {
      await enqueue((payload) => {
        payload.events = [
          { at: at.toISOString(), modelId: String(modelId), kind, message: String(message).slice(0, 500) },
          ...payload.events
        ].slice(0, maxEvents);
      });
    },

    /**
     * 今天（本地时区）的账户级计数。
     *
     * 三种答案，三种含义，**不可合并**（wire.ts DailyUsage 的语义基线）：
     *   - `0` —— 确实一次都没有（没记录，或今天还没有桶）；这是可信的日常值；
     *   - `null` —— **读不到**：文件在，但本构建看不懂它（损坏 / 形状不对 / 更新
     *     构建写的版本 / 存在却不可读）。面板渲染「—」；
     *   - 数字 —— 今日次数。
     *
     * 判据是「文件在不在」而不是「载荷读没读出来」：**文件不存在**才是真实的 0
     * （这台 Host 从未经本插件调用过，不是数据丢失），而**文件在却读成空**代表
     * 我们失去了那部分信息——把它报成 0 会让操作者以为今天没调用过，真相是他
     * 不知道。
     *
     * 这是 2026-10-16 补上的一块拼图：`routes.test.mjs` 早有一条
     * 「本地计数读不到 → null，绝不是 0」的断言，但它只能用一个**会抛错的桩**
     * 造出那条路径（注释原话：「挂载的真实 store 造不出『读的时候抛』」）——
     * 真实 store 把所有读失败都吞成了空载荷。于是 null 那份语义在 wire.ts、
     * `cards.ts`、`snapshot-aggregate.ts` 里写了三遍，却从未在本机真的产出过。
     *
     * @returns {{dateKey: string, calls: number|null, tokens: number|null}}
     */
    async daily(): Promise<{ dateKey: string; calls: number | null; tokens: number | null }> {
      const payload = await cache.read();
      const dateKey = localDateKey(now());
      if (payload === null) {
        // 这发 stat 只发生在「载荷读不出来」的异常路径上——正常循环由读缓存命中
        // 短路，零额外 IO。
        const stored = await pathExists(file);
        return { dateKey, calls: stored ? null : 0, tokens: stored ? null : 0 };
      }
      const day = payload.days[dateKey] ?? null;
      return day === null ? { dateKey, calls: 0, tokens: 0 } : { ...day, dateKey };
    },

    /**
     * 今天的单模型计数（只含有记录的模型，dayCalls/dayTokens 口径，均跨日清零）。
     *
     * 三种答案，与 {@link daily} / {@link trend} 同一条红线（wire.ts：读不到 ≠ 0）：
     *   - 数组 —— 今天的单模型记录（只含有记录的模型；空数组 = 今天确实没有记录，
     *     是**真实零**）；
     *   - `null` —— **读不到**：载荷读不出来（损坏 / 形状不对 / 更新构建写的版本 /
     *     存在却不可读）。面板渲染「—」，不是空排行。
     *
     * 这是 2026-10-18 补上的最后一块拼图：daily() 三态在 2026-10-16、trend() 在
     * 本轮都补上了，perModelToday() 一直停在 `payload?.models ?? {}`——同一个坏文件
     * 在头条画「—」、在单模型排行却画「还没有本地调用记录。」，同一份坏数据在
     * 同一个卡片里给出两种答案。判据与 daily() 逐字一致：文件不存在才是真实的零，
     * 文件在却读成空是信息丢失。
     *
     * @returns {Array<{modelId: string, calls: number, tokens: number|null, lastAt: string|null}> | null}
     */
    async perModelToday(): Promise<Array<{ modelId: string; calls: number; tokens: number | null; lastAt: string | null }> | null> {
      const payload = await cache.read();
      if (payload === null) {
        // 与 daily() 同一发 stat：只发生在「载荷读不出来」的异常路径上（正常循环
        // 由读缓存命中短路，零额外 IO）。文件不在 = 从未记录过 = 真实零；
        // 文件在 = 我们失去了那些信息 = 不知道。
        const stored = await pathExists(file);
        return stored ? null : [];
      }
      const todayKey = localDateKey(now());
      const out: Array<{ modelId: string; calls: number; tokens: number | null; lastAt: string | null }> = [];
      for (const [modelId, counter] of Object.entries(payload.models ?? {})) {
        if (counter.day !== todayKey) continue;
        out.push({ modelId, calls: counter.dayCalls, tokens: counter.dayTokens, lastAt: counter.lastAt });
      }
      out.sort((a, b) => b.calls - a.calls);
      return out;
    },

    /**
     * 最近 N 天趋势（含今天）。
     *
     * 三种答案，与 {@link daily} 同一条红线（wire.ts：读不到 ≠ 0）：
     *   - `TrendBucket[]` —— 逐日桶，缺桶 = 该日 0 次（**真实零**：那天确实没有
     *     记录，是已知答案）；
     *   - `null` —— **读不到**：载荷读不出来（损坏 / 形状不对 / 更新构建写的
     *     版本 / 存在却不可读）。面板渲染「—」，不是一片零柱。
     *
     * 判据与 daily() 逐字一致：**文件不存在**才是真实的零（这台 Host 从未经本
     * 插件调用过），**文件在却读成空**是信息丢失。缺桶补 0 与整份读空补 0 是两件
     * 完全不同的事，前者是数据，后者是伪造。
     *
     * 这是 2026-10-18 补上的一块拼图：daily() 早在 2026-10-16 就有了三态，
     * trend() 一直只做了一半——`payload === null` 时照样逐日 push `{calls: 0}`，
     * 于是「usage.json 被写坏」在今日计数上画「—」、在趋势图上却画 14 根结实的
     * 零柱，同一份坏数据在两个区块给出两种答案。shapeWarnings 里那条 anomaly
     * 确实会出现，但它说「usage.json 有问题」，不说「你看到的这条趋势线是假的」。
     *
     * @returns {TrendBucket[] | null}
     */
    async trend(days = retentionDays): Promise<TrendBucket[] | null> {
      const payload = await cache.read();
      if (payload === null) {
        // 与 daily() 同一发 stat：只发生在「载荷读不出来」的异常路径上（正常循环
        // 由读缓存命中短路，零额外 IO）。文件不在 = 从未记录过 = 真实零；
        // 文件在 = 我们失去了那些信息 = 不知道。
        const stored = await pathExists(file);
        return stored ? null : [];
      }
      const out: TrendBucket[] = [];
      const cursor = now();
      for (let offset = Number(days) - 1; offset >= 0; offset -= 1) {
        const date = new Date(cursor);
        date.setDate(date.getDate() - offset);
        const key = localDateKey(date);
        const bucket = payload.days[key];
        out.push({ dateKey: key, calls: bucket?.calls ?? 0, tokens: bucket?.tokens ?? 0 });
      }
      return out;
    },

    /**
     * 事件流（Newest-first，已截断）。
     *
     * 三种答案，与 {@link daily} / {@link trend} 同一条红线（wire.ts：读不到 ≠ 0）：
     *   - 数组 —— 读到的事件（空数组 = 确实没有事件，是**真实零**）；
     *   - `null` —— **读不到**：载荷读不出来（损坏 / 形状不对 / 更新构建写的版本 /
     *     存在却不可读）。面板渲染「—」，不是「暂无事件」。
     *
     * 与 perModelToday() 同一块拼图（2026-10-18）：`payload?.events ?? []` 把
     * 「读不到」和「确实没有」合成同一种答案，坏文件在事件卡上假装岁月静好。
     *
     * @returns {QuotaEvent[] | null}
     */
    async events(): Promise<QuotaEvent[] | null> {
      const payload = await cache.read();
      if (payload === null) {
        // 与 daily() 同一发 stat：只发生在「载荷读不出来」的异常路径上（正常循环
        // 由读缓存命中短路，零额外 IO）。文件不在 = 从未记录过 = 真实零；
        // 文件在 = 我们失去了那些信息 = 不知道。
        const stored = await pathExists(file);
        return stored ? null : [];
      }
      return [...(payload.events ?? [])];
    },

    /** 最近一次解析异常（无异常为 null）——快照转 shapeWarnings。 */
    anomaly() {
      return anomaly;
    },

  };
}

/**
 * 从 429/错误事件流推断「哪些模型当前额度耗尽」——**纯函数**，判定规则的唯一真源。
 *
 * 为什么需要它：官方只给**账户级**魔粒余额（`/openapi/v1/magicubes/balance`），
 * 没有 per-model 额度端点；而「哪个模型刚才在限频」恰恰是面板独家能答的问题。
 * 证据只有两类：事件流（`kind` 已按 llm-error-fix **重分类后**的口径，见
 * `usage-observer.ts` 头注）与单模型今日计数，本函数只用前者——计数分不清
 * 成功与失败（`recordCall` 按流计次、含失败），拿它当证据会猜。
 *
 * 判定规则（三条，全部可机械复现）：
 *   1. **只有 `kind:"quota"` 算证据**。`rate_limit` 是瞬时限频（peer 会退避
 *      重试，请求打得出去），`error` 是未知——把任何 429 都当耗尽是 0.2.0
 *      已修掉的误判（QUOTA 快速失败 vs RATE_LIMIT 退避，两条路不同）。
 *   2. **只在推断窗口内有效**：事件 `at` 落在 `[now - windowMinutes, +∞)`。
 *      窗口外的旧证据不算——免费额度按天重置，昨天的耗尽不该关掉今天的模型。
 *   3. **不推断恢复**：成功的流不发事件，所以「模型已恢复」在这份数据里
 *      **不可观测**。已恢复的模型最多灰显满一个窗口——方向是保守的（宁可少
 *      提供一会，不把注定 429 的模型放进选择器），且面板灰显带着原因，
 *      不是静默消失。
 *
 * 总量语义：`events` 是环形缓冲（`maxEvents` 截断、Newest-first），所以「窗口
 * 内没有证据」可能是**真没有**、也可能是**证据被截掉了**——后者只发生在
 * 极端刷屏（50 条以内）时。**方向是假阴性，不是保守**：证据被挤掉 → 集合收缩
 * → 一个仍耗尽的模型可能提前回灰、被重新放进选择器。以前这里写的是「保守收敛」，
 * 把危险方向说成了安全方向（下一轮会话会据此放松，所以改掉）。它之所以还能接受，
 * 是因为失败面很小且自限：窗口最长 1440min、事件天然会滑出，`reconcile` 每轮
 * 现算，下一个 quota 事件会立刻把它重新灰掉。时间戳解析不出的事件跳过，不猜。
 *
 * @param {readonly QuotaEvent[]|null|undefined} events - 事件流（任意顺序）。
 * @param {Date|number} [now] - 时钟源（测试注入）。
 * @param {number} [windowMinutes] - 推断窗口（分钟）。非正/非有限时返回空集
 *   ——总量防御：host-config 已把配置夹到 [5, 1440]，走到这里就是编程错误，
 *   「没有证据」比按坏窗口算出一个莫名的集合诚实。
 * @returns {string[]} 当前应视为额度耗尽的模型 id（去重、排序，稳定快照）。
 */
export function exhaustedModelIds(events: readonly QuotaEvent[] | null | undefined, now: Date | number = Date.now(), windowMinutes = 60): string[] {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return [];
  const list = Array.isArray(events) ? events : [];
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return [];
  const since = nowMs - windowMinutes * 60_000;
  const out = new Set<string>();
  for (const event of list) {
    if (event === null || typeof event !== "object") continue;
    if (event.kind !== "quota") continue;
    const at = Date.parse(String(event.at));
    if (!Number.isFinite(at) || at < since) continue;
    const modelId = typeof event.modelId === "string" ? event.modelId : "";
    if (modelId !== "") out.add(modelId);
  }
  return [...out].sort();
}

/**
 * doctor 的只读速览：不构造 store、不碰缓存，直接解析一份 usage.json 载荷，
 * 回答「这份文件本构建还认不认、里面有多少天桶/事件」。整个载荷不认识时是
 * `null`；认识但版本未知时 `versionKnown:false`（doctor 据此区分「损坏」与
 * 「更新构建写的」两种提示）。解析规则与本 store 的 `parsePayload` 同源
 * （KNOWN_VERSIONS 单一真源），doctor 不另立一套。
 */
export function describeUsagePayload(raw: unknown): { versionKnown: boolean; days: number; events: number } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const version = source.version;
  if (typeof version !== "number") return null;
  const days = source.days !== null && typeof source.days === "object" && !Array.isArray(source.days)
    ? Object.keys(source.days as Record<string, unknown>).length
    : 0;
  const events = Array.isArray(source.events) ? source.events.length : 0;
  return { versionKnown: KNOWN_VERSIONS.includes(version), days, events };
}
