/**
 * Host 半边共用的小读取器与错误构造器（与姊妹插件 util.ts 同源，受控复制）。
 * 集中一份防漂移；相对 sensenova 版本的差异只有一处：redactSecrets 增加了对
 * 魔搭访问令牌裸值（`ms-` + UUID）的脱敏——本插件的凭据就是它。
 * @module dsh-connect-modelscope-token-plan/util
 */
import type { PluginError } from "./types.ts";
import type { CodeValue } from "./codes.ts";

/** 读一个有限的正数，否则回退值。 */
export function num(value: any, fallback?: any): any {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 读一个非空字符串，否则回退值。 */
export function str(value: any, fallback?: any): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/** 读一个普通对象，否则 `{}`。 */
export function obj(value?: any): any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** catch 点统一的一行错误消息。 */
export function errMsg(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** 读一个有限数字，否则 `null`。 */
export function numOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** 原样读字符串（凭据专用：trim 是用户看不见的改动）。 */
export function verbatim(value: any, fallback?: any): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * 凭据形状字符串的脱敏闸：任何可能进日志/错误消息/面板响应的文本都先过这里。
 * 家规（AGENTS.md 红线 1）：凭据永不进日志。魔搭访问令牌的裸值形态
 * （`ms-` + UUID）与 `sk-` 推理键、Bearer/Basic 头、常见密钥键值对都在闸内。
 */
export function redactSecrets(text: unknown) {
  const raw = typeof text === "string" ? text : "";
  return (
    raw
      // 1) Header 值优先：整个 "authorization":"..." 一次吞掉。
      .replace(/(["']?[Aa]uthorization["']?\s*[:=]\s*["']?)(?!Bearer\s)[^"',;\s]+/g, "$1[REDACTED]")
      // 2) Bearer / Basic 令牌。
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
      // 3) 魔搭访问令牌裸值：ms- + 至少 16 位十六进制（连字符可有可无）。
      //    这条闸曾经硬编码 UUID 的 `8-4-4-4-12` 分组形状，于是紧凑写法
      //    `ms-3f2a1b8c1111222233334444555566` 整条漏网。而 `ms-auth.save()`
      //    过去不做形状校验，任何非空字符串都会被存下来并作为
      //    `Authorization: Bearer …` 发出——「非标准形状的令牌」是**可达状态**，
      //    上游一旦把它回显进错误消息（inference-client 的几处都把上游 body
      //    拼进错误文本），凭据就进日志与面板响应。撞红线 1。
      //    现在两头都堵：这里放宽到「ms- + 16 位以上的十六进制/连字符」，入口
      //    （ms-auth.isPlausibleToken）拒收遮不住的短值。脱敏闸宁可宽——漏遮的
      //    代价（凭据外泄）远大于误遮（一条日志里的长hex 被替换掉）。
      .replace(/\bms-[0-9a-f-]{16,}\b/gi, "ms-[REDACTED]")
      // 4) 裸推理键 sk-…。
      .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-[REDACTED]")
      // 5) 已知密钥 JSON 键值对。
      .replace(/(["']?(?:password|access_token|refresh_token|api[_-]?key|token)["']?\s*:\s*["'])[^"']+(?=["'])/gi, "$1[REDACTED]")
      // 6) 已知密钥 key=value 对。
      .replace(/\b(password|access_token|refresh_token|api[_-]?key|token)\s*=\s*[^&;\s]+/gi, "$1=[REDACTED]")
  );
}

/**
 * 吞掉失败但留下痕迹。opt-in 模块按设计降级，但降级的理由必须落日志
 * （warn 而非 debug——debug 在默认 Host 上被滤掉等于零日志）。错误消息先
 * 脱敏。返回 fallback，两种静默 catch 形态都能用。
 */
export function degrade<T>(reason: string, error: unknown, logger: { warn?: (message: string) => void } | undefined, fallback: T): T {
  const detail = error == null ? "" : redactSecrets(errMsg(error));
  logger?.warn?.(detail === "" ? `degraded: ${reason}` : `degraded: ${reason}: ${detail}`);
  return fallback;
}

/**
 * 等一个可能迟到的服务，窗口有界。挂载时读可选服务（credentials/settings）
 * 的唯一循环；窗口长度由调用方定。
 */
export async function retryBounded({ attempts, delayMs, run }: {
  attempts: number;
  delayMs: number;
  run: (attempt: number) => boolean | Promise<boolean>;
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await run(attempt)) return true;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  return false;
}

/**
 * Await 一个 OPTIONAL 的 store 调用：值缺失与 promise 拒绝都读作 fallback。
 * 注意守卫要套在**值**上（`Promise.resolve(value).catch(...)`）而不是调用结果上
 * ——`try { await value } catch` 漏掉「value 本身是 undefined」这条。
 */
export function optional<T, F = null>(value: T | Promise<T> | null | undefined, fallback: F = null as F): Promise<T | F> {
  return Promise.resolve(value).catch(() => fallback) as Promise<T | F>;
}

/** 省略 null/undefined 字段，返回新对象。 */
export function pickDefined<T extends Record<string, unknown>>(fields: T): Partial<{ [K in keyof T]: Exclude<T[K], null | undefined> }> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out as Partial<{ [K in keyof T]: Exclude<T[K], null | undefined> }>;
}

/** 带 code 的 Error：本插件所有失败的唯一构造点。 */
export function pluginError(code: CodeValue, message: string, extra: { retryAfterMs?: number; detail?: string } = {}): PluginError {
  const error = new Error(message) as PluginError;
  error.code = code;
  if (extra.retryAfterMs !== undefined) error.retryAfterMs = extra.retryAfterMs;
  if (extra.detail !== undefined) error.detail = extra.detail;
  return error;
}
