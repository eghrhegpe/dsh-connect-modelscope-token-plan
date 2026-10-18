/**
 * 用量面板的**显示偏好**——目前只有一个字段：趋势图的显示窗口（画多少天）。
 *
 * ## 为什么单独一个文件
 *
 *  - `usage.json` 是**数据**（天桶 / 单模型 / 事件），写路径是观测热路径。把一个
 *    显示偏好混进去，会让「偏好读不到」与「计数文件损坏」共用一条降级语义；更要命
 *    的是版本漂移——旧构建重写那份 payload 时会**静默丢掉**它不认识的键。
 *  - `provider.json` 是 provider 注册的 desired state（开关 / 允许清单 / 窗口覆盖），
 *    与「趋势图画多少天」无关；合成一份 payload 会让两边的写入时序互相牵连。
 *
 * 落点与 provider / draw 同一套分段规则：`$DSH_HOME/state/<profile>/<plugin>/usage-prefs.json`
 * （无 profile 时落共享目录）。分段的意思是「这个 profile 想看多长」，两个 profile
 * 不互相覆盖。
 *
 * legacy 继承（2026-10-18 裁定）：pre-profile 共享目录里的 usage-prefs.json 在
 * 本 profile 自己的文件**不在场**时一次性继承——与 provider-store 同款手写缝
 *（读路径内触发、回填排进**本 store 的写队列**、显式清除不复活）。为什么这个
 * 搬而 usage.json 不搬：单值显示偏好回填无害，而历史计数是「本 profile 的账」，
 * 搬过来是把无 profile 时期的账算成这个 profile 的（usage-store.ts 头注的裁定）。
 *
 * 优先级与所有 opt-in 开关同一份裁决（`switch-precedence.ts`）：面板保存值赢，
 * 否则 `cordis.patch.yml` 的 `trendDays` 说了算；两者都会在 host-config 里被夹进
 * 保留窗口之内（`retentionDays`）——**画得比留得多**会把已剪的日子画成 0。
 *
 * 完整性三件套与 provider / usage / draw **同源**（全部上收在 `state-store.ts`，
 * 本文件只做调用方，论述见 `draw-store.ts` 头注，不在此重复）：写串行化
 * （{@link createStateWriteQueue}）、写守卫（{@link guardStateWrite}，ADR-006）、
 * 读侧说明（{@link stateVersionNote}）。
 *
 * doctor 覆盖：{@link describeUsagePrefsPayload} 给只读速览，`doctor.ts` 据此把
 * usage-prefs.json 的「损坏 / 未知版本」报进症状表。
 *
 * @module dsh-connect-modelscope-token-plan/usage-prefs-store
 */
import { obj } from "./util.ts";
import { join } from "node:path";
import { name } from "./host-config.ts";
import { resolveSwitchNumber } from "./switch-precedence.ts";
import {
  ensureStateDir,
  temporaryOf,
  writeStateFile,
  readStateJson,
  createStateReadCache,
  guardStateWrite,
  stateVersionNote,
  createStateWriteQueue,
  STATE_READ_TTL_MS,
  profileStateDir,
  stateDir as sharedStateDir
} from "./state-store.ts";

/** 本 store 落盘 payload 的版本。 */
export const USAGE_PREFS_VERSION = 1;

/** 本 build 读得懂的版本集合（升级时把新号加进来，旧号保持可读）。 */
export const KNOWN_USAGE_PREFS_VERSIONS: readonly number[] = Object.freeze([USAGE_PREFS_VERSION]);

/** Store 构造参数。 */
interface StoreOptions {
  dir?: string;
  profile?: string | null;
  ttlMs?: number;
  logger?: { warn?: (m: string) => void };
}

/** 落盘 payload 形状。`null` 一律表示「没设过」。 */
interface UsagePrefsPayload {
  windowDays: number | null;
  version: number | null;
}

const EMPTY_PAYLOAD: UsagePrefsPayload = { windowDays: null, version: null };

/**
 * 本 build 读不读得懂这个版本。
 *
 * 与 provider / draw 的 `isKnown*Version` 同形：**白名单**判据，不与
 * {@link USAGE_PREFS_VERSION} 比较——升级后旧号仍要可读。读侧、报告侧
 * （versionNote / describeUsagePrefsPayload）问的都是这一个函数，三者不可能就
 * 「什么是未知版本」说两套话。写侧问的是 `state-store` 的 `isKnownStateVersion`
 * （它额外放行 `null` = 没有文件，那是唯一该写的情形）。
 * @param {unknown} version - 盘上读到的值（可能根本不是数字）。
 * @returns {boolean}
 */
export function isKnownUsagePrefsVersion(version: unknown): boolean {
  return typeof version === "number" && KNOWN_USAGE_PREFS_VERSIONS.includes(version);
}

/**
 * 归一一个保存的显示窗口：正整数（向下取整），或 `null`（= 跟随配置默认）。
 *
 * **不在这里夹上界**：上界是保留窗口（`retentionDays`），那是 host-config 的事，
 * 此模块不该知道它。传进来的越界值由调用方（host-config / 快照聚合 / 路由）夹。
 * @param {unknown} value - 原始值。
 * @returns {number|null} 归一后的天数或 `null`。
 */
export function normalizeWindowDays(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const days = Math.floor(value);
  return days > 0 ? days : null;
}

/** 本 store 的目录（与 provider / draw 同一套分段规则）。 */
export function usagePrefsDir(profile: string | null, dir?: string): string {
  if (typeof dir === "string" && dir !== "") return dir;
  return profile ? profileStateDir(name, profile) : sharedStateDir(name);
}

/**
 * 显示窗口的**唯一**裁决 + 夹取：面板保存值优先（沿用全仓唯一方言
 * {@link resolveSwitchNumber}），否则配置默认；随后落进 `[1, maxDays]`。
 *
 * 夹取放在这里而不是 store 里，是因为 store 不该知道上界；放在**本模块**而不是
 * 两个调用方各写一遍，是因为「面板值 vs 默认」和「夹到保留窗口」加起来只有一条
 * 正确算法——路由保存时与快照聚合渲染时各写一份，就会出现「面板显示 90 天、
 * 图里只画了 14 天」这类两处不一致。
 * @param {number|null} panel - 面板保存值（`null` = 未保存）。
 * @param {number} fallback - 配置默认（已由 host-config 夹过）。
 * @param {number} maxDays - 上界（保留窗口，`retentionDays`）。
 * @returns {number} 生效天数。
 */
export function resolveWindowDays(panel: number | null, fallback: number, maxDays: number): number {
  const want = resolveSwitchNumber(panel, fallback);
  return Math.min(Math.max(1, Math.floor(want)), Math.max(1, Math.floor(maxDays)));
}

/**
 * 文件支撑的用量显示偏好。
 * @param {StoreOptions} [options] - `{ dir, profile, ttlMs, logger }`。
 * @returns {object} store 句柄。
 */
export function createFileUsagePrefsStore(options: StoreOptions = {}) {
  const { dir, profile = null, ttlMs = STATE_READ_TTL_MS, logger } = options;
  const stateDir = usagePrefsDir(profile, dir);
  const filePath = join(stateDir, "usage-prefs.json");

  /**
   * 写一份 payload 并落盘。
   *
   * ADR-006 写守卫（{@link guardStateWrite}）先问盘：版本不认或文件读不出 →
   * 返回拒绝理由（已 degrade 记录），不落笔。守卫与随后的写入在同一个临界区里
   * （由 patchPayload 的链保证），判据与执行之间不隔任何 await。
   * @param {object} body - 要持久化的 JSON 体。
   * @returns {Promise<string|null>} 拒绝原因，或 `null` = 已写入。
   */
  const writePayload = async (body: object): Promise<string | null> => {
    const refusal = await guardStateWrite(filePath, KNOWN_USAGE_PREFS_VERSIONS, { label: "usage-prefs-state", logger });
    if (refusal !== null) return refusal;
    await ensureStateDir(stateDir);
    await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary: temporaryOf(stateDir, "usage-prefs.json") });
    return null;
  };

  /** 写串行化：读-改-写必须排队（详见{@link createStateWriteQueue}）。 */
  const writeQueue = createStateWriteQueue();

  /**
   * 解析一份路径上的 payload；认不出的版本读作「没设过」但**记住**版本号——读侧
   * 宽容、versionNote 负责把宽容说出口（写侧守卫已挡住覆盖，两半合起来才是
   * ADR-006）。
   */
  const parseAt = async (path: string): Promise<UsagePrefsPayload> => {
    const source = obj(await readStateJson(path));
    const version = typeof source.version === "number" ? source.version : null;
    if (!isKnownUsagePrefsVersion(version)) return { windowDays: null, version };
    return { windowDays: normalizeWindowDays(source.windowDays), version };
  };

  /** 读本 profile 自己的文件。 */
  const parsePayload = async (): Promise<UsagePrefsPayload> => parseAt(filePath);

  // Pre-profile 机器把这个偏好写在**共享**目录里；profile 作用域的 store 在自己
  // 的文件不在场时一次性继承（与 provider-store 同款裁定：读路径内触发、回填过
  // **本 store 的写队列**、显式清除不复活）。显式 `dir`（测试）从不继承——它
  // 从来不是共享布局的一部分。
  //
  // 与 usage.json 的差异是有意的：单值显示偏好回填无害，而历史计数是「本
  // profile 的账」，整段搬过来是把无 profile 时期的账算成这个 profile 的
  // （裁定见 usage-store.ts 头注）。
  const legacyFile = dir === undefined && profile ? join(sharedStateDir(name), "usage-prefs.json") : null;

  // 短 TTL 读缓存：另一个进程改了要在一个 tick 内可见，但一次快照聚合不该重读多次。
  //
  // legacy 回填是**读路径内**触发的写，所以它也走 `writeQueue`：否则它与并发的
  // save 竞争——用户刚点的「90 天」会被旧布局的继承值盖掉（而继承只发生一次，
  // 所以那次覆盖是永久的）。判据与 provider-store 同款：自己的文件带版本号时
  // 不继承（foreign 版本写了也被 ADR-006 守卫拒，省掉注定失败的尝试；本构建
  // 写的空文件 = `saveWindowDays(null)` 的显式清除，不该被复活）。
  const cache = createStateReadCache<UsagePrefsPayload>(async () => {
    const own = await parsePayload();
    if (own.windowDays !== null || legacyFile === null || own.version !== null) return own;
    const legacy = await parseAt(legacyFile);
    if (legacy.windowDays === null) return own;
    await writeQueue.enqueue(() =>
      writePayload({
        version: USAGE_PREFS_VERSION,
        windowDays: legacy.windowDays,
        updatedAt: new Date().toISOString()
      }).then(
        () => undefined,
        () => undefined
      )
    );
    return legacy;
  }, { ttlMs });

  /**
   * 读当前 payload。
   * @returns {Promise<UsagePrefsPayload>}
   */
  const readPayload = async (): Promise<UsagePrefsPayload> => (await cache.read()) ?? EMPTY_PAYLOAD;

  /**
   * 读-改-写，**整段排队**。
   *
   * 基线每次从磁盘重读（`parsePayload` 直读，不走 TTL 缓存）：两个 Host 进程共享
   * 一个状态目录，而缓存里可能是写入前的值（provider §8d 的回归用例在 draw 上
   * 同样成立，见 draw-store.ts）。写成功即 `cache.remember`。
   *
   * 失败语义与 provider / draw 对齐：拒绝原因与 IO 失败都**向上抛**（save 抛、
   * 路由 catch 后 `respondError` 呈报），链自己吞掉失败继续走后面的保存。
   *
   * @param {number|null} windowDays - 新的显示窗口；`null` = 清除（回到配置默认）。
   * @returns {Promise<void>}
   */
  const save = (windowDays: number | null): Promise<void> =>
    writeQueue.enqueue(async () => {
      const body: Record<string, unknown> = { version: USAGE_PREFS_VERSION };
      if (windowDays !== null) body.windowDays = windowDays;
      body.updatedAt = new Date().toISOString();
      const refusal = await writePayload(body);
      if (refusal !== null) throw new Error(refusal);
      cache.remember({ windowDays, version: USAGE_PREFS_VERSION });
    });

  return {
    /** 面板保存的显示窗口天数；`null` = 跟随配置默认。 */
    async windowDays(): Promise<number | null> {
      return (await readPayload()).windowDays;
    },
    /**
     * 盘上带着本构建读不懂的版本时的一句说明，否则 `null`。
     *
     * 读侧宽容（未知版本读作「没设过」）的另一半：快照聚合把它转进
     * `shapeWarnings`，doctor 报同一份文件。没有它，「保存的显示窗口被忽略」在
     * 面板上就是「从未保存过」——而回退方向是配置默认。
     * @returns {Promise<string|null>}
     */
    async versionNote(): Promise<string | null> {
      const version = (await readPayload()).version;
      // `null` = 没有版本号可报（文件缺失/损坏），与「版本不符」是两件事。
      if (version === null || isKnownUsagePrefsVersion(version)) return null;
      return stateVersionNote({
        label: "usage-prefs-state",
        file: filePath,
        version,
        known: KNOWN_USAGE_PREFS_VERSIONS,
        consequence:
          "the saved trend window is being answered as \"not set\"," +
          " so the chart falls back to the config default."
      });
    },
    /** 保存显示窗口（`null` = 清掉，回到配置默认）。 */
    async saveWindowDays(windowDays: number | null): Promise<void> {
      if (windowDays !== null && !(typeof windowDays === "number" && Number.isFinite(windowDays) && Math.floor(windowDays) > 0)) {
        throw new TypeError("trend window expects a positive integer or null");
      }
      await save(windowDays === null ? null : Math.floor(windowDays));
    },
    /** 落盘路径（诊断与测试用）。 */
    filePath
  };
}

/**
 * doctor 的只读速览：不构造 store、不碰缓存，直接解析一份 usage-prefs.json 载荷，
 * 回答「这份文件本构建还认不认、里面存了什么」。整个载荷不认识时是 `null`；
 * 认识但版本未知时 `versionKnown:false` —— doctor 据此区分「损坏」与「更新构建
 * 写的」两种提示。版本判据同源（都问 {@link KNOWN_USAGE_PREFS_VERSIONS}）。
 */
export function describeUsagePrefsPayload(
  raw: unknown
): { versionKnown: boolean; windowDays: number | null } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const version = source.version;
  if (typeof version !== "number") return null;
  return { versionKnown: isKnownUsagePrefsVersion(version), windowDays: normalizeWindowDays(source.windowDays) };
}
