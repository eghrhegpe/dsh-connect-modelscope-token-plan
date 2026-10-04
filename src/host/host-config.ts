/**
 * 配置契约与 Host 信任围栏（与姊妹插件同构；auth 覆盖块不存在——魔搭只有
 * 一把静态令牌，没有可配置的登录流）。
 *
 * `CONFIG_DEFAULTS` 与 `cordis.patch.yml` 由 test/config.test.mjs 双向钉住，
 * 代码与文档不会静默漂移。
 * @module dsh-connect-modelscope-token-plan/host-config
 */
import { str, obj, num, errMsg } from "./util.ts";

/**
 * 本插件所有可寻址面的唯一 slug：/api 路由前缀、状态目录名、凭据记录命名
 * 空间都从它派生。改名必须连着用户已存的数据一起搬，不是改文本。
 * test/config.test.mjs 钉住 package.json#name 与 patch 行的 id/name 字面量。
 */
export const name = "dsh-connect-modelscope-token-plan";
/** Cordis 硬依赖：没有 webServer 本插件保持不活动。 */
export const inject = ["webServer"];

/**
 * 快照里的插件版本。单一来源本可以是 package.json，但 lib 打包把它内联进
 * 产物反而引入第二份真源；这里用常量、由 test/config.test.mjs 钉住与
 * package.json 一致。
 */
export const PLUGIN_VERSION = "0.1.0";

/**
 * 额度常数的漂移史只进配置不进代码（README「三条事实」）：官方调整时改
 * patch 行即可，改完重装/重载生效。默认值是 2026-10 的社区快照
 * （约 2000/天、单模型约 500/天），非官方数据。
 */
export const CONFIG_DEFAULTS = Object.freeze({
  /** OpenAI 兼容推理源站（模型目录 + probe）。 */
  apiBase: "https://api-inference.modelscope.cn/v1",
  /** 站点源站，只用于面板外链（访问令牌页 / 文档）。 */
  siteBase: "https://modelscope.cn",
  /** 每日调用额度常数（账户级，本地推算的减数）。 */
  dailyQuotaTotal: 2000,
  /** 单模型每日上限常数。 */
  dailyQuotaPerModel: 500,
  /** 本地趋势保留天数（usage-store 天桶数量；超出即修剪）。 */
  trendDays: 14,
  /** Host 侧对 /v1/models 的缓存秒数。 */
  cacheSeconds: 60,
  /** 面板轮询间隔——由 Host 下发、面板跟随，两端不各自假设。 */
  pollSeconds: 30,
  /** 单次魔搭请求超时（毫秒）。 */
  inferenceTimeoutMs: 30_000,
  /** 事件流保留条数（429/错误事件的环形上限）。 */
  maxEvents: 50,
  /** provider 注册占位（v0.1 未实现，字段先钉住形状）。 */
  registerProvider: false,
  /** Host 应答的默认主机名；操作者的列表是「只增不替」。 */
  admittedHosts: ["localhost", "127.0.0.1", "[::1]", "::1"]
});

/** 把原始数值夹到有效整数（floor → 下限 → 上限；非正/非有限回退 def）。 */
export function clampInt(raw: unknown, def: number, min: number, max = Infinity): number {
  return Math.min(max, Math.max(min, Math.floor(num(raw, def))));
}

/**
 * 端点必须是合法的 http(s) 绝对地址；不是就在**挂载时**抛（resolveSettings
 * 捕获后转成 configError 经快照呈现），而不是等到第一次轮询才变成莫名其妙的
 * 网络失败。
 */
function assertHttpUrl(value: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} is not an absolute URL: ${JSON.stringify(value)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must be an http(s) URL, got ${parsed.protocol}`);
  }
}

/** resolveSettings 的产物形状，消费方照此读。 */
export interface ResolvedSettings {
  apiBase: string;
  siteBase: string;
  dailyQuotaTotal: number;
  dailyQuotaPerModel: number;
  trendDays: number;
  cacheSeconds: number;
  pollSeconds: number;
  inferenceTimeoutMs: number;
  maxEvents: number;
  registerProvider: boolean;
  allowedHosts: Set<string>;
}

/**
 * 把 patch 行的原始配置解析成有效设置。
 *
 * 坏行不许从这里抛出去——apply 在挂载期跑，抛错等于整机插件消失。问题以
 * `configError` 返回，经快照路由呈现为一个能自我解释的面板。
 */
export function resolveSettings(config: unknown): { settings: ResolvedSettings; configError: string | null } {
  const source = obj(config);
  try {
    const apiBase = str(source.apiBase, CONFIG_DEFAULTS.apiBase).replace(/\/+$/, "");
    const siteBase = str(source.siteBase, CONFIG_DEFAULTS.siteBase).replace(/\/+$/, "");
    assertHttpUrl(apiBase, "apiBase");
    assertHttpUrl(siteBase, "siteBase");
    return {
      settings: {
        apiBase,
        siteBase,
        dailyQuotaTotal: clampInt(source.dailyQuotaTotal, CONFIG_DEFAULTS.dailyQuotaTotal, 1),
        dailyQuotaPerModel: clampInt(source.dailyQuotaPerModel, CONFIG_DEFAULTS.dailyQuotaPerModel, 1),
        trendDays: clampInt(source.trendDays, CONFIG_DEFAULTS.trendDays, 1, 365),
        cacheSeconds: clampInt(source.cacheSeconds, CONFIG_DEFAULTS.cacheSeconds, 5),
        pollSeconds: clampInt(source.pollSeconds, CONFIG_DEFAULTS.pollSeconds, 5),
        inferenceTimeoutMs: clampInt(source.inferenceTimeoutMs, CONFIG_DEFAULTS.inferenceTimeoutMs, 1_000),
        maxEvents: clampInt(source.maxEvents, CONFIG_DEFAULTS.maxEvents, 1, 1_000),
        registerProvider: source.registerProvider === true,
        // 允许主机名：默认集只增不替（typo 不能把面板锁在外面）。
        allowedHosts: resolveAllowedHosts(source)
      },
      configError: null
    };
  } catch (error) {
    // 兜底形状与 happy path 同构（消费方分不出两个分支），原因进 configError。
    return {
      settings: {
        apiBase: CONFIG_DEFAULTS.apiBase,
        siteBase: CONFIG_DEFAULTS.siteBase,
        dailyQuotaTotal: CONFIG_DEFAULTS.dailyQuotaTotal,
        dailyQuotaPerModel: CONFIG_DEFAULTS.dailyQuotaPerModel,
        trendDays: CONFIG_DEFAULTS.trendDays,
        cacheSeconds: CONFIG_DEFAULTS.cacheSeconds,
        pollSeconds: CONFIG_DEFAULTS.pollSeconds,
        inferenceTimeoutMs: CONFIG_DEFAULTS.inferenceTimeoutMs,
        maxEvents: CONFIG_DEFAULTS.maxEvents,
        registerProvider: false,
        allowedHosts: new Set(CONFIG_DEFAULTS.admittedHosts)
      },
      configError: errMsg(error)
    };
  }
}

/**
 * 收集本 Host 应答的主机名。操作者列表 **加** 到默认集上，绝不替换。
 */
export function resolveAllowedHosts(source: Record<string, unknown>): Set<string> {
  const admitted = new Set(CONFIG_DEFAULTS.admittedHosts);
  const extra = Array.isArray(source.allowedHosts) ? source.allowedHosts : [];
  for (const entry of extra) {
    const name = str(entry, "").trim().toLowerCase();
    if (name !== "") admitted.add(name);
  }
  return admitted;
}

/** 从 Host 头里剥端口；IPv6 字面量保留方括号。 */
export function hostName(host: string): string {
  // "[::1]:8080" 保留方括号；"localhost:8080" 剥掉端口。
  if (host.startsWith("[") && host.includes("]")) {
    return host.slice(0, host.indexOf("]") + 1);
  }
  // 裸 IPv6 字面量带多个冒号。仅当倒数第二段与最后一段**都是纯数字**时，
  // 最后一段才是端口（"::1:3080" → "::1"；"::1" 的 ":1" 不是端口）。
  // 没认出来的名字原样返回 → 被 isAdmitted 拒绝，这是安全的方向。
  const colons = host.split(":");
  if (colons.length > 2) {
    const penultimate = colons[colons.length - 2] ?? "";
    const last = colons[colons.length - 1] ?? "";
    if (/^\d+$/.test(penultimate) && /^\d+$/.test(last)) {
      return host.slice(0, host.lastIndexOf(":"));
    }
    return host;
  }
  return colons.length > 1 ? host.slice(0, host.lastIndexOf(":")) : host;
}

/**
 * 路由的信任围栏。两攻击两事实：
 * 1. DNS rebinding——攻击页把域名 rebind 到 127.0.0.1，此时 Origin 与 Host
 *    互相一致，比较两者无意义；Host 头是浏览器唯一伪造不了的，对白名单查。
 * 2. 跨站伪造——Host 本来就合法，暴露它的是 Origin。
 * 所以：Host 必须在白名单内，且带 Origin 时必须与 Host 一致；无 Origin 的
 * 普通同源 GET 放行。围栏的边界是**浏览器**不是本机——本机进程两者都能伪造。
 */
export function isAdmitted(request: { headers?: { host?: unknown; origin?: unknown } }, allowedHosts: Set<string>): boolean {
  const host = str(request.headers?.host, "").toLowerCase();
  if (host === "" || !allowedHosts.has(hostName(host))) return false;
  const origin = request.headers?.origin;
  if (typeof origin !== "string" || origin === "") return true;
  if (origin === "null") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
