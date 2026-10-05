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
import {
  ensureStateDir,
  isKnownStateVersion,
  createStateReadCache,
  profileStateDir,
  readStateJson,
  readStateVersion,
  stateDir,
  temporaryOf,
  writeStateFile
} from "./state-store.ts";
import { pluginError } from "./util.ts";
import { CODE } from "./codes.ts";
import type { QuotaEvent } from "../shared/wire.ts";

/** 本地日期键（ quota 按天重置，以 Host 本地时区为准）。 */
export function localDateKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
 * @param {number} [options.trendDays] - 天桶保留数（超出修剪；从配置注入，
 *   让「配置改小」在下次写入时生效，而不是等一个固定的内部常数）。
 * @param {number} [options.maxEvents] - 事件流上限。
 * @param {() => Date} [options.now] - 时钟源；测试注入。
 * @param {{warn?: (message: string) => void}} [options.logger] - ctx.logger。
 */
export function createFileUsageStore({ name, profile = null, trendDays = 14, maxEvents = 50, now = () => new Date(), logger }: {
  name: string;
  profile?: string | null;
  trendDays?: number;
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
  /** 写串行化：读-改-写必须排队，两个并发 recordCall 不能互相覆盖。 */
  let writeChain: Promise<void> = Promise.resolve();

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
    const onDisk = await readStateVersion(file);
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

  /** 排队执行一次读-改-写；只读闸置位时整个变更是 no-op。 */
  const enqueue = (mutate: (payload: UsagePayload) => void) => {
    const run = writeChain.then(async () => {
      // 守卫在这里**自己**读盘，而不是依赖 readThrough 的副作用——见
      // diskVersionBlocksWrites 的注释：这个 await 之后才可能发生写入，所以
      // 判据必须落在同一个 await 链上，中间不能隔任何东西。
      if (await diskVersionBlocksWrites()) return;
      const fromDisk = loaded ? current : ((await cache.read()) ?? null);
      const payload: UsagePayload = fromDisk ?? { version: STATE_VERSION, days: {}, models: {}, events: [] };
      mutate(payload);
      current = payload;
      loaded = true;
      await persist(payload);
    });
    // 链必须吞掉自己的失败继续走，否则一次只读 Home 上的写失败会毒化后续所有计数。
    writeChain = run.catch(() => {});
    return run;
  };

  /** 修剪：只留最近 trendDays 个天桶（按 dateKey 排序，今天不删）。 */
  const pruneDays = (payload: UsagePayload, todayKey: string) => {
    const keep = new Set(
      Object.keys(payload.days)
        .sort()
        .slice(-Math.max(1, trendDays))
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

    /** 今天（本地时区）的账户级计数；没有任何记录时是 0，不是 null。 */
    async daily() {
      const payload = await cache.read();
      const day = payload?.days[localDateKey(now())] ?? null;
      return day === null ? { dateKey: localDateKey(now()), calls: 0, tokens: 0 } : { ...day, dateKey: localDateKey(now()) };
    },

    /** 今天的单模型计数（只含有记录的模型，dayCalls/dayTokens 口径，均跨日清零）。 */
    async perModelToday() {
      const payload = await cache.read();
      const todayKey = localDateKey(now());
      const out: Array<{ modelId: string; calls: number; tokens: number | null; lastAt: string | null }> = [];
      for (const [modelId, counter] of Object.entries(payload?.models ?? {})) {
        if (counter.day !== todayKey) continue;
        out.push({ modelId, calls: counter.dayCalls, tokens: counter.dayTokens, lastAt: counter.lastAt });
      }
      out.sort((a, b) => b.calls - a.calls);
      return out;
    },

    /** 最近 N 天趋势（含今天；缺桶 = 该日 0 次，真实零不是数据丢失）。 */
    async trend(days = trendDays) {
      const payload = await cache.read();
      const out: Array<{ dateKey: string; calls: number; tokens: number }> = [];
      const cursor = now();
      for (let offset = Number(days) - 1; offset >= 0; offset -= 1) {
        const date = new Date(cursor);
        date.setDate(date.getDate() - offset);
        const key = localDateKey(date);
        const bucket = payload?.days[key];
        out.push({ dateKey: key, calls: bucket?.calls ?? 0, tokens: bucket?.tokens ?? 0 });
      }
      return out;
    },

    /** 事件流（Newest-first，已截断）。 */
    async events() {
      const payload = await cache.read();
      return [...(payload?.events ?? [])];
    },

    /** 最近一次解析异常（无异常为 null）——快照转 shapeWarnings。 */
    anomaly() {
      return anomaly;
    },

    /** 无秘密的状态（doctor 用）。 */
    async state() {
      const payload = await cache.read();
      return {
        file: profile === null ? join(stateDir(name), "usage.json") : file,
        hasRecord: payload !== null,
        days: Object.keys(payload?.days ?? {}).length,
        events: payload?.events.length ?? 0,
        readOnly
      };
    }
  };
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
