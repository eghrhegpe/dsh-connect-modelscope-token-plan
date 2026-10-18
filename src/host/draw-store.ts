/**
 * 出图工具的开关与模型偏好——本插件**自己的**状态文件，与 provider 那条开关分开。
 *
 * 为什么不是第二个字段塞进 `provider.json`：两者回答的是不同问题。
 * `provider.json` 说「这个 profile 要不要把魔搭作为 **chat provider** 提供」；
 * 本文件说「要不要给 agent 一个**出图工具**」。用户完全可能只要其一（用工具出图但
 * 不污染模型选择器，或反之）。合成一个 payload 会让「关掉出图」连带改掉 provider
 * 清单的写入时序——provider-store 的注释已说明为什么它的两个字段必须同生共死，
 * 而那组理由**不适用于**这两个开关（它们之间没有 atomicity 要求）。
 *
 * 落点与 `provider-store.ts` 一致：`$DSH_HOME/state/<plugin>/draw.json`（无 profile
 * 时）或 `$DSH_HOME/state/<profile>/<plugin>/draw.json`。profile 分段的意思是
 * 「这个 profile 要不要暴露出图工具」，两个 profile 不能互相覆盖。
 *
 * 优先级与所有 opt-in 开关同一份裁决（`switch-precedence.ts`）：面板保存值赢，
 * 否则 `cordis.patch.yml` 的 `drawEnabled` 默认值说了算。
 *
 * 完整性三件套（与 provider / usage 同源，全部上收在 `state-store.ts`，本文件只做
 * 调用方——2026-10-17 收敛：此前这里**三件全缺**，并发 `saveEnabled` +
 * `saveModelId` 会丢一次保存、磁盘 version 比本构建新时降级覆写、读侧静默读作
 * 「没设过」，正是 provider-store 注释里记着「咬过三次」的那类漂移的第四条）：
 *   - **写串行化**（{@link createStateWriteQueue}）：读-改-写整体排队，临界区内
 *     从磁盘重读基线（不用 TTL 缓存—— provider §8d 的回归用例），链吞自己的
 *     失败继续走；
 *   - **写守卫**（{@link guardStateWrite}，ADR-006）：盘上版本本构建读不懂时
 *     拒写并给出理由，绝不降级覆写；「文件在场却读不出来」同样拒写（读不到 ≠
 *     没有东西要保护）；
 *   - **读侧说明**（{@link stateVersionNote}）：未知版本宽容读作「没设过」，但
 *     {@link createFileDrawStore} 的 `versionNote()` 把「保存的开关与模型偏好
 *     被忽略」说出口，快照聚合把它转进 `shapeWarnings`——不说，面板就把「保存的
 *     值被忽略」呈现成「从未保存过」。
 *
 * 与 provider-store 的一处**有意差异**：没有 legacy（pre-profile 共享目录）继承。
 * draw.json 随出图工具一起诞生，晚于按 profile 分段（git 史上成立），且宿主一直提供
 * profileContext 的机器上不存在共享布局里的旧 draw.json；provider.json 则需要
 * （§23 之前它一直在共享目录）。
 * 前提修正（2026-10-18）：「市面上不存在」只对宿主一直提供 profileContext 的机器成立。
 * 宿主不提供时 profile 恒为 null，draw.json 今至仍写共享目录；宿主升级后提供该服务
 * 时，同一个迁移窗口在 draw.json 上一模一样——那种窗口里旧 draw.json 不继承不搬，
 * doctor 以 shared (legacy) 作用域报出，出图开关与模型偏好回 patch 默认（与 usage.json 同侧：
 * 诊断可见 > 静默搬运）。
 *
 * doctor 覆盖：`describeDrawPayload` 给只读速览，`doctor.ts` 据此把 draw.json
 * 的「损坏 / 未知版本」报进症状表——写侧守卫挡覆盖，doctor 报静默降级。
 *
 * @module dsh-connect-modelscope-token-plan/draw-store
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
export const DRAW_STORE_VERSION = 1;

/** 本 build 读得懂的版本集合（升级时把新号加进来，旧号保持可读）。 */
export const KNOWN_DRAW_VERSIONS: readonly number[] = Object.freeze([DRAW_STORE_VERSION]);

/** Store 构造参数。 */
interface StoreOptions {
  dir?: string;
  profile?: string | null;
  ttlMs?: number;
  logger?: { warn?: (m: string) => void };
}

/** 落盘 payload 形状。`null` 一律表示「没设过」。 */
interface DrawPayload {
  enabled: boolean | null;
  modelId: string | null;
  version: number | null;
}

const EMPTY_PAYLOAD: DrawPayload = { enabled: null, modelId: null, version: null };

/**
 * 本 build 读不读得懂这个版本。
 *
 * 与 provider-store 的 {@link isKnownProviderVersion} 同形：**白名单**判据，
 * 不与 {@link DRAW_STORE_VERSION} 比较——升级后旧号仍要可读。读侧（parseAt）、
 * 报告侧（versionNote / describeDrawPayload）问的都是这一个函数，三者不可能就
 * 「什么是未知版本」说两套话。写侧问的是 `state-store` 的
 * `isKnownStateVersion`（它额外放行 `null` = 没有文件，那是唯一该写的情形）。
 * @param {unknown} version - 盘上读到的值（可能根本不是数字）。
 * @returns {boolean}
 */
export function isKnownDrawVersion(version: unknown): boolean {
  return typeof version === "number" && KNOWN_DRAW_VERSIONS.includes(version);
}

/**
 * 归一一个保存的模型偏好：非空字符串，或 `null`（= 自动挑——具体挑谁由
 * `draw-runtime.ts` 的 `pickDrawModel` 优先级决定，不是简单取目录第一个）。
 *
 * 不校验「这个 id 是否真存在」——目录会变，存一个暂时不在目录里的 id 是合法的
 * （用户可能先配好、等模型上线）。调用侧解析不出来时退回自动。
 * @param {unknown} value - 原始值。
 * @returns {string|null} 归一后的 id 或 `null`。
 */
export function normalizeDrawModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 归一保存的开关值：只有真正的 boolean 才算数，其余读作「没设过」。
 * @param {unknown} value - 原始值。
 * @returns {boolean|null} 归一后的开关。
 */
export function normalizeDrawEnabled(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** 本 store 的目录（与 provider-store 同一套分段规则）。 */
export function drawStoreDir(profile: string | null, dir?: string): string {
  if (typeof dir === "string" && dir !== "") return dir;
  return profile ? profileStateDir(name, profile) : sharedStateDir(name);
}

/**
 * 文件支撑的出图开关 + 模型偏好。
 * @param {StoreOptions} [options] - `{ dir, profile, ttlMs, logger }`。
 * @returns {object} store 句柄。
 */
export function createFileDrawStore(options: StoreOptions = {}) {
  const { dir, profile = null, ttlMs = STATE_READ_TTL_MS, logger } = options;
  const stateDir = drawStoreDir(profile, dir);
  const filePath = join(stateDir, "draw.json");

  /**
   * 写一份补丁并落盘（内部用；对调用方暴露的是 saveEnabled / saveModelId / reset）。
   *
   * ADR-006 写守卫（{@link guardStateWrite}）先问盘：版本不认或文件读不出 →
   * 返回拒绝理由（已 degrade 记录），不落笔。守卫与随后的写入在同一个临界区里
   * （由 patchPayload 的链保证），判据与执行之间不隔任何 await。
   * @param {object} body - 要持久化的 JSON 体。
   * @returns {Promise<string|null>} 拒绝原因，或 `null` = 已写入。
   */
  const writePayload = async (body: object): Promise<string | null> => {
    const refusal = await guardStateWrite(filePath, KNOWN_DRAW_VERSIONS, { label: "draw-state", logger });
    if (refusal !== null) return refusal;
    await ensureStateDir(stateDir);
    await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary: temporaryOf(stateDir, "draw.json") });
    return null;
  };

  /** 写串行化：读-改-写必须排队（详见{@link createStateWriteQueue}与文件头）。 */
  const writeQueue = createStateWriteQueue();

  /**
   * 解析一份 payload；认不出的版本读作「没设过」但**记住**版本号——读侧宽容、
   * versionNote 负责把宽容说出口（写侧守卫已挡住覆盖，两半合起来才是 ADR-006）。
   */
  const parsePayload = async (): Promise<DrawPayload> => {
    const source = obj(await readStateJson(filePath));
    const version = typeof source.version === "number" ? source.version : null;
    if (!isKnownDrawVersion(version)) return { enabled: null, modelId: null, version };
    return {
      enabled: normalizeDrawEnabled(source.enabled),
      modelId: normalizeDrawModelId(source.modelId),
      version
    };
  };

  // 短 TTL 读缓存：另一个进程改了要在一个 tick 内可见，但一次工具调用不该重读多次。
  const cache = createStateReadCache<DrawPayload>(parsePayload, { ttlMs });

  /**
   * 读当前 payload。
   * @returns {Promise<DrawPayload>}
   */
  const readPayload = async (): Promise<DrawPayload> => (await cache.read()) ?? EMPTY_PAYLOAD;

  /**
   * 读-改-写一份补丁，**整段排队**。
   *
   * 基线每次从磁盘重读（`parsePayload` 直读，不走 TTL 缓存）：两个 Host 进程
   * 共享一个状态目录，而缓存里可能是写入前的值——provider §8d 的回归用例
   * （两个写入者共享一个目录，回读把较新的缓存顶成旧值）在 draw 上同样成立。
   * 写成功即 `cache.remember`，调用方不必各自回读一遍。
   *
   * 失败语义与 provider-store 对齐：拒绝原因与 IO 失败都**向上抛**（save 抛、
   * 路由 catch 后 `respondError` 呈报），链自己吞掉失败继续走后面的保存。
   *
   * @param {{enabled?: boolean|null, modelId?: string|null}} patch - 要改的字段；
   *   `undefined` = 保留盘上的值，`null` = 清除（回到「没设过」）。
   * @returns {Promise<void>}
   */
  const patchPayload = (patch: { enabled?: boolean | null; modelId?: string | null }): Promise<void> =>
    writeQueue.enqueue(async () => {
      const current = await parsePayload();
      const enabled = patch.enabled === undefined ? current.enabled : patch.enabled;
      const modelId = patch.modelId === undefined ? current.modelId : patch.modelId;
      const body: Record<string, unknown> = { version: DRAW_STORE_VERSION };
      if (enabled !== null) body.enabled = enabled;
      if (modelId !== null) body.modelId = modelId;
      body.updatedAt = new Date().toISOString();
      const refusal = await writePayload(body);
      if (refusal !== null) throw new Error(refusal);
      cache.remember({ enabled, modelId, version: DRAW_STORE_VERSION });
    });

  return {
    /** 面板保存的出图开关；`null` = 回退 patch 默认值。 */
    async enabled(): Promise<boolean | null> {
      return (await readPayload()).enabled;
    },
    /** 面板保存的模型偏好；`null` = 自动。 */
    async modelId(): Promise<string | null> {
      return (await readPayload()).modelId;
    },
    /** 这个 profile 是否被显式配置过。 */
    async isConfigured(): Promise<boolean> {
      const payload = await readPayload();
      return payload.enabled !== null || payload.modelId !== null;
    },
    /**
     * 盘上带着本构建读不懂的版本时的一句说明，否则 `null`。
     *
     * 读侧宽容（未知版本读作「没设过」）的另一半：快照聚合把它转进
     * `shapeWarnings`，doctor 报同一份文件。没有它，「保存的开关与模型偏好
     * 被忽略」在面板上就是「从未保存过」——而回退方向是 patch 默认（通常=关）。
     * @returns {Promise<string|null>}
     */
    async versionNote(): Promise<string | null> {
      const version = (await readPayload()).version;
      // `null` = 没有版本号可报（文件缺失/损坏），与「版本不符」是两件事，
      // 必须分开——写侧把 `null` 读作「没有文件，写 belongs」。
      if (version === null || isKnownDrawVersion(version)) return null;
      return stateVersionNote({
        label: "draw-state",
        file: filePath,
        version,
        known: KNOWN_DRAW_VERSIONS,
        consequence:
          "the saved draw switch and model preference are being answered as \"not set\"," +
          " so the switch falls back to the config default and the model back to automatic selection."
      });
    },
    /** 保存开关。 */
    async saveEnabled(enabled: boolean): Promise<void> {
      if (typeof enabled !== "boolean") throw new TypeError("draw switch expects a boolean");
      await patchPayload({ enabled });
    },
    /** 保存模型偏好（`null` = 清掉，回到自动）。 */
    async saveModelId(modelId: string | null): Promise<void> {
      if (modelId !== null && (typeof modelId !== "string" || modelId.trim() === "")) {
        throw new TypeError("draw model expects a non-empty string or null");
      }
      await patchPayload({ modelId });
    },
    /** 清掉两个字段（回到「没配过」）。 */
    async reset(): Promise<void> {
      await patchPayload({ enabled: null, modelId: null });
    },
    /** 落盘路径（诊断与测试用）。 */
    filePath
  };
}

/**
 * doctor 的只读速览：不构造 store、不碰缓存，直接解析一份 draw.json 载荷，
 * 回答「这份文件本构建还认不认、里面保存过什么」。整个载荷不认识时是 `null`；
 * 认识但版本未知时 `versionKnown:false` —— doctor 据此区分「损坏」与「更新
 * 构建写的」两种提示。
 *
 * 与 provider / usage 的 describe* 同形，版本判据同源（都问
 * {@link KNOWN_DRAW_VERSIONS}，都不问 {@link DRAW_STORE_VERSION}）——这条同源性
 * 是承重的：若读侧改成与当前版本比较，`DRAW_STORE_VERSION` 一旦升级，parseAt
 * 会把自家旧文件读作「未设置」而这里仍报 `versionKnown:true`，读侧与说明互相
 * 打脸。doctor 不另立第三套。
 *
 * `modelId` 回显保存的偏好 id（清单只报条数的规矩不适用于此：那是「列表噪声」，
 * 单个偏好值回显才答得上「我钉的是哪个模型」；它不是凭据，面板本来也展示它）。
 */
export function describeDrawPayload(
  raw: unknown
): { versionKnown: boolean; enabled: boolean | null; modelId: string | null } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const version = source.version;
  if (typeof version !== "number") return null;
  return {
    versionKnown: isKnownDrawVersion(version),
    enabled: normalizeDrawEnabled(source.enabled),
    modelId: normalizeDrawModelId(source.modelId)
  };
}
