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
 * 完整性沿用 `state-store.ts`：版本化 payload、临时文件 + 原子改名 + fsync、属主
 * 可读、「认不出的内容一律读作没设过」。写入侧拒绝覆盖本版本读不懂的版本（ADR-006）。
 *
 * @module dsh-connect-modelscope-token-plan/draw-store
 */
import { obj, degrade } from "./util.ts";
import { join } from "node:path";
import { name } from "./host-config.ts";
import {
  ensureStateDir,
  temporaryOf,
  writeStateFile,
  readStateJson,
  isKnownStateVersion,
  createStateReadCache,
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

/** 本 build 读不读得懂这个版本。 */
function isKnownDrawVersion(version: number | null): boolean {
  return isKnownStateVersion(version, KNOWN_DRAW_VERSIONS);
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

  /** 解析一份 payload；认不出的版本读作「没设过」但**记住**版本号。 */
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
  const current = async (): Promise<DrawPayload> => (await cache.read()) ?? EMPTY_PAYLOAD;

  /**
   * 写一份补丁并落盘。
   * @param {{enabled?: boolean|null, modelId?: string|null}} patch - 要改的字段。
   * @returns {Promise<string|null>} 拒绝原因（`null` = 已写入）。
   */
  const patchPayload = async (patch: { enabled?: boolean | null; modelId?: string | null }): Promise<string | null> => {
    const before = await current();
    const enabled = patch.enabled === undefined ? before.enabled : patch.enabled;
    const modelId = patch.modelId === undefined ? before.modelId : patch.modelId;
    try {
      await ensureStateDir(stateDir);
      const body: Record<string, unknown> = { version: DRAW_STORE_VERSION };
      if (enabled !== null) body.enabled = enabled;
      if (modelId !== null) body.modelId = modelId;
      body.updatedAt = new Date().toISOString();
      await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary: temporaryOf(stateDir, "draw.json") });
      cache.remember({ enabled, modelId, version: DRAW_STORE_VERSION });
      return null;
    } catch (error) {
      return degrade("draw store write failed", error, logger, "draw store write failed");
    }
  };

  return {
    /** 面板保存的出图开关；`null` = 回退 patch 默认值。 */
    async enabled(): Promise<boolean | null> {
      return (await current()).enabled;
    },
    /** 面板保存的模型偏好；`null` = 自动。 */
    async modelId(): Promise<string | null> {
      return (await current()).modelId;
    },
    /** 这个 profile 是否被显式配置过。 */
    async isConfigured(): Promise<boolean> {
      const payload = await current();
      return payload.enabled !== null || payload.modelId !== null;
    },
    /** 保存开关。 */
    async saveEnabled(enabled: boolean): Promise<string | null> {
      if (typeof enabled !== "boolean") throw new TypeError("draw switch expects a boolean");
      return patchPayload({ enabled });
    },
    /** 保存模型偏好（`null` = 清掉，回到自动）。 */
    async saveModelId(modelId: string | null): Promise<string | null> {
      if (modelId !== null && (typeof modelId !== "string" || modelId.trim() === "")) {
        throw new TypeError("draw model expects a non-empty string or null");
      }
      return patchPayload({ modelId });
    },
    /** 清掉两个字段（回到「没配过」）。 */
    async reset(): Promise<string | null> {
      return patchPayload({ enabled: null, modelId: null });
    },
    /** 落盘路径（诊断与测试用）。 */
    filePath
  };
}
