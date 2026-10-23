/**
 * 「本机第一次见到这个模型是什么时候」——胶囊那句「· N 新模型」的唯一事实源。
 *
 * ## 它回答什么，不回答什么
 *
 * 只记**首见时间戳**：每个 id 第一次出现在本机拉到的目录里的那一刻。由此派生的
 * 那句话必须说成「本机首次见到的模型」，**不能**说成「网关新增」——上游的
 * `/v1/models` 不提供「上架时间」，本插件没有任何字段能证实某个模型是这周才上
 * 的。能证实的只有「本机从哪天开始看见它」，那就只说这一句。
 *
 * 也**不**记录活动/促销变化（限免、错峰、签到）：那些是实时读数，面板的余额块与
 * 胶囊 popover 已经直接画上游给的现值，再造一本「促销 diff 账」就是同一事实两本
 * 账，两本迟早说两套话（ADR-017 的口径）。
 *
 * ## 一次调用同时 diff 与落盘
 *
 * {@link RosterSeenStore.note} 不能拆成「先 diff 缓存、稍后再写」：那样两个并发
 * 的收敛轮可能都基于同一份旧 map 判断，后写的那次会把先写的那批模型再宣布一遍。
 * 读、算、写在一个调用里完成。
 *
 * ## 首次写入是**播种**，不是宣布
 *
 * 升级到带本文件的构建时，磁盘上没有历史——此时**知道**目录里有这些模型，但
 * **不知道**其中哪些是新的。把整个目录宣布成「刚上架」正是本文件要避免的谎，
 * 所以播种那一轮把每个 id 都盖成「已过期」的戳（`now - 窗口`），`newIds` 返回
 * 空。这个自愈是刻意的：某个 id 要先离开目录再回来，才配得到一个真实的首见戳。
 *
 * ## 200 个 id 以上是**形状漂移**，不是「保留最新 200」
 *
 * 按「保留最新」淘汰一个仍在目录里的 id，会让它下一轮看起来像没见过 → 重新盖戳
 * → 再被宣布一次；而被淘汰的集合每轮轮换，于是「新模型」计数会**震荡并变大**
 * （实测 250 个 id 对 200 上限：50 → 100 → …）。会自己发明新模型的历史文件比
 * 没有历史文件更糟，所以超限一律读作形状漂移：**不写、不宣布**，旧 map 原样
 * 保留，标记在异常期间消失，目录回到合理规模后自愈。
 *
 * ## 分段与 legacy
 *
 * 落点与 provider / draw / usage-prefs 同一套分段规则：
 * `$DSH_HOME/state/<profile>/<plugin>/roster-seen.json`（无 profile 时落共享目录）。
 * **不搬**：本文件晚于 profile 分段引入，共享目录里不存在它的旧布局可继承——
 * 与 usage-prefs-store 的「legacy 继承」相反，这里没有 legacy 缝，也不该长出一条。
 *
 * 完整性三件套与其余 store 同源（全部上收在 `state-store.ts`，本文件只做调用方，
 * 论述见 `draw-store.ts` 头注）：写串行化（{@link createStateWriteQueue}）、写守卫
 * （{@link guardStateWrite}，ADR-006）、读侧说明（{@link stateVersionNote}）。
 *
 * doctor 覆盖：{@link describeRosterSeenPayload} 给只读速览，`doctor.ts` 据此把
 * roster-seen.json 的「损坏 / 未知版本」报进症状表。
 *
 * @module dsh-connect-modelscope-token-plan/roster-seen-store
 */
import { obj } from "./util.ts";
import { join } from "node:path";
import { name } from "./host-config.ts";
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
export const ROSTER_SEEN_VERSION = 1;

/** 本 build 读得懂的版本集合（升级时把新号加进来，旧号保持可读）。 */
export const KNOWN_ROSTER_SEEN_VERSIONS: readonly number[] = Object.freeze([ROSTER_SEEN_VERSION]);

/**
 * 「新」的时效窗口：首见戳落在这个窗口内就算新。
 *
 * 7 天是有意的尺度——它要盖住「用户几天没开面板、回来时发现多了两个模型」这个
 * 真实场景，又不能长到让一次批量上架在半个月后还挂着标记。窗口在这里是**常量**
 * 而不是配置：一个能被调成 365 天的「新模型」标记等于没有语义。
 */
export const ROSTER_SEEN_NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 目录规模上限。超过即视为形状漂移（不是淘汰队列，理由见模块头注）。
 *
 * 取值与姊妹插件的同类实现一致：真实目录在数百个模型以内，200 给「这一侧目录
 * 突然返回了整站列表」这类事故留出足够间距。
 */
export const ROSTER_SEEN_MAX_IDS = 200;

/** Store 构造参数。 */
interface StoreOptions {
  dir?: string;
  profile?: string | null;
  ttlMs?: number;
  logger?: { warn?: (m: string) => void };
}

/** 首见表：id → 首次见到的 epoch 毫秒。 */
export type RosterSeen = Record<string, number>;

/** 落盘 payload 形状。`version: null` 只出现在「文件缺失/损坏」的读结果里。 */
interface RosterSeenPayload {
  seen: RosterSeen;
  version: number | null;
}

const EMPTY_PAYLOAD: RosterSeenPayload = { seen: {}, version: null };

/**
 * 本 build 读不读得懂这个版本。
 *
 * 与其余 store 的 `isKnown*Version` 同形：**白名单**判据，不与
 * {@link ROSTER_SEEN_VERSION} 比较——升级后旧号仍要可读。读侧、报告侧问的都是
 * 这一个函数。
 * @param {unknown} version - 盘上读到的值（可能根本不是数字）。
 * @returns {boolean}
 */
export function isKnownRosterSeenVersion(version: unknown): boolean {
  return typeof version === "number" && KNOWN_ROSTER_SEEN_VERSIONS.includes(version);
}

/**
 * 归一一张首见表：只留「id 是非空字符串、戳是有限正数」的项。
 *
 * 丢掉而不是修补坏项是有意的：一个戳为 0 或负数的项会让 `now - stamp` 变成
 * 几十年，那个 id 于是永远算「新」；宁可让它下次出现时重新盖一个真实戳。
 * @param {unknown} raw - 盘上读到的 `seen` 值。
 * @returns {RosterSeen} 归一后的表（可能是空对象）。
 */
export function normalizeRosterSeen(raw: unknown): RosterSeen {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: RosterSeen = {};
  for (const [id, stamp] of Object.entries(raw as Record<string, unknown>)) {
    if (id === "") continue;
    if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) continue;
    out[id] = stamp;
  }
  return out;
}

/** 本 store 的目录（与 provider / draw / usage-prefs 同一套分段规则）。 */
export function rosterSeenDir(profile: string | null, dir?: string): string {
  if (typeof dir === "string" && dir !== "") return dir;
  return profile ? profileStateDir(name, profile) : sharedStateDir(name);
}

/**
 * 从一张首见表里挑出「还算新」的 id，按首见时间升序（最老的在前）。
 *
 * 升序是有意的：调用方只展示前几个名字（胶囊 tooltip / popover 的预算），先看到
 * 的应该是**最早**变成新的那几个——它们离过期最近，也是读者最可能已经见过、
 * 需要被告知「其实才刚出现」的那批。
 * @param {RosterSeen} seen - 归一后的首见表。
 * @param {number} nowMs - 当前时刻。
 * @returns {string[]} 窗口内的 id 列表。
 */
export function freshIdsOf(seen: RosterSeen, nowMs: number): string[] {
  return Object.entries(seen)
    .filter(([, first]) => nowMs - first < ROSTER_SEEN_NEW_WINDOW_MS)
    .sort((left, right) => left[1] - right[1])
    .map(([id]) => id);
}

/**
 * 文件支撑的首见表。
 * @param {StoreOptions} [options] - `{ dir, profile, ttlMs, logger }`。
 * @returns {object} store 句柄。
 */
export function createFileRosterSeenStore(options: StoreOptions = {}) {
  const { dir, profile = null, ttlMs = STATE_READ_TTL_MS, logger } = options;
  const stateDir = rosterSeenDir(profile, dir);
  const filePath = join(stateDir, "roster-seen.json");

  /**
   * 写一份 payload 并落盘。
   *
   * ADR-006 写守卫（{@link guardStateWrite}）先问盘：版本不认或文件读不出 →
   * 返回拒绝理由（已 degrade 记录），不落笔。
   * @param {object} body - 要持久化的 JSON 体。
   * @returns {Promise<string|null>} 拒绝原因，或 `null` = 已写入。
   */
  const writePayload = async (body: object): Promise<string | null> => {
    const refusal = await guardStateWrite(filePath, KNOWN_ROSTER_SEEN_VERSIONS, { label: "roster-seen-state", logger });
    if (refusal !== null) return refusal;
    await ensureStateDir(stateDir);
    await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary: temporaryOf(stateDir, "roster-seen.json") });
    return null;
  };

  /** 写串行化：读-改-写必须排队（详见{@link createStateWriteQueue}）。 */
  const writeQueue = createStateWriteQueue();

  /**
   * 解析一份路径上的 payload；认不出的版本读作「空表」但**记住**版本号——读侧
   * 宽容、versionNote 负责把宽容说出口（写侧守卫已挡住覆盖，两半合起来才是
   * ADR-006）。
   */
  const parseAt = async (path: string): Promise<RosterSeenPayload> => {
    const source = obj(await readStateJson(path));
    const version = typeof source.version === "number" ? source.version : null;
    if (!isKnownRosterSeenVersion(version)) return { seen: {}, version };
    return { seen: normalizeRosterSeen(source.seen), version };
  };

  // 短 TTL 读缓存：另一个进程改了要在一个 tick 内可见，但一次快照聚合不该重读多次。
  const cache = createStateReadCache<RosterSeenPayload>(() => parseAt(filePath), { ttlMs });

  /** 读当前 payload。 */
  const readPayload = async (): Promise<RosterSeenPayload> => (await cache.read()) ?? EMPTY_PAYLOAD;

  return {
    /**
     * 记下这一轮的完整目录，并回答「其中哪些还在新窗口内」。
     *
     * 一次调用同时 diff 与落盘（理由见模块头注）。首轮写入是**播种**：把每个 id
     * 盖成已过期的戳、返回空 `newIds`。
     * @param {readonly string[]} ids - 上游这一轮列出的**完整**目录 id。
     * @param {number} [nowMs] - 时钟（测试注入）。
     * @returns {Promise<{newIds: string[]}>} 窗口内的 id，升序；播种那轮为空。
     */
    async note(ids: readonly string[], nowMs: number = Date.now()): Promise<{ newIds: string[] }> {
      const list = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id !== "") : [];
      const unique = [...new Set(list)];
      // 空目录 = 没有可记的事。尤其**不许**把空目录当成「全部下架」写下去——
      // 一次瞬时的空目录会把整张表清空，下一轮全部重新盖戳、全部宣布成新。
      if (unique.length === 0) return { newIds: [] };
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      return writeQueue.enqueue(async () => {
        const current = await parseAt(filePath);
        // 未知版本：读侧宽容成空表，而写侧守卫（ADR-006）会拒。这里**先**停下，
        // 不写也不宣布——否则空表 + `seeded = false` 会把整个目录当成新上架。
        // 「保存的首见表被忽略」这件事由 `versionNote` 在面板上说出来（与
        // provider / draw / usage-prefs 同一条纪律），不是在这里静默。
        if (current.version !== null && !isKnownRosterSeenVersion(current.version)) return { newIds: [] };
        // 只保留这一轮**仍在**目录里的 id：下架的 id 被丢掉，将来再上架就算重新
        // 首见（那正是读者会关心的「它又回来了」）。
        const previous = current.seen;
        const seeded = current.version === null;
        const next: RosterSeen = {};
        for (const id of unique) {
          const first = previous[id];
          // 未来戳（时钟回拨、手改文件）夹到 now：否则 `now - stamp` 为负，标记
          // 会一直亮着。
          next[id] = typeof first === "number" && first > 0 ? Math.min(first, now) : seeded ? now - ROSTER_SEEN_NEW_WINDOW_MS : now;
        }
        if (Object.keys(next).length > ROSTER_SEEN_MAX_IDS) {
          // 形状漂移：不写、不宣布，旧 map 原样保留（理由见模块头注）。
          return { newIds: [] };
        }
        const changed =
          seeded ||
          Object.keys(previous).length !== Object.keys(next).length ||
          Object.keys(next).some((id) => previous[id] !== next[id]);
        if (changed) {
          const refusal = await writePayload({
            version: ROSTER_SEEN_VERSION,
            seen: next,
            updatedAt: new Date().toISOString()
          });
          // 拒绝（ADR-006）与 IO 失败都向上抛：调用方（收敛器）只 warn，但原因
          // 不许被吞成「这一轮没有新模型」——那是两条完全不同的事实。
          if (refusal !== null) throw new Error(refusal);
          cache.remember({ seen: next, version: ROSTER_SEEN_VERSION });
        }
        return { newIds: seeded ? [] : freshIdsOf(next, now) };
      });
    },
    /**
     * 只读：此刻还算「新」的 id（升序）。
     *
     * **不写盘**：快照与 provider 路由都是读路径，写只发生在收敛器的 `note`。
     * 读路径若顺手补戳，一次面板轮询就能把「谁是新模型」这件事改写掉。
     * @param {number} [nowMs] - 时钟（测试注入）。
     * @returns {Promise<string[]>}
     */
    async fresh(nowMs: number = Date.now()): Promise<string[]> {
      const payload = await readPayload();
      return freshIdsOf(payload.seen, Number.isFinite(nowMs) ? nowMs : Date.now());
    },
    /** 这张表有没有写过（区分「播种」与「真的没有新模型」）。 */
    async isSet(): Promise<boolean> {
      return (await readPayload()).version !== null;
    },
    /**
     * 盘上带着本构建读不懂的版本时的一句说明，否则 `null`。
     *
     * 读侧宽容（未知版本读作空表）的另一半：快照聚合把它转进 `shapeWarnings`，
     * doctor 报同一份文件。没有它，「首见表被忽略」在面板上就是「没有新模型」。
     * @returns {Promise<string|null>}
     */
    async versionNote(): Promise<string | null> {
      const version = (await readPayload()).version;
      if (version === null || isKnownRosterSeenVersion(version)) return null;
      return stateVersionNote({
        label: "roster-seen-state",
        file: filePath,
        version,
        known: KNOWN_ROSTER_SEEN_VERSIONS,
        consequence: "the first-sighting history is being answered as empty, so the pill shows no new-model marker."
      });
    },
    /** 落盘路径（诊断与测试用）。 */
    filePath
  };
}

/**
 * doctor 的只读速览：不构造 store、不碰缓存，直接解析一份 roster-seen.json 载荷。
 * 整个载荷不认识时是 `null`；认识但版本未知时 `versionKnown:false` —— doctor
 * 据此区分「损坏」与「更新构建写的」两种提示。
 * @param {unknown} raw - 盘上读到的 JSON。
 * @returns {object|null}
 */
export function describeRosterSeenPayload(raw: unknown): { versionKnown: boolean; ids: number; fresh: number } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const version = source.version;
  if (typeof version !== "number") return null;
  const seen = normalizeRosterSeen(source.seen);
  return {
    versionKnown: isKnownRosterSeenVersion(version),
    ids: Object.keys(seen).length,
    fresh: freshIdsOf(seen, Date.now()).length
  };
}

export type RosterSeenStore = ReturnType<typeof createFileRosterSeenStore>;
