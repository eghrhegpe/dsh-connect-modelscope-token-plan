/**
 * 配置默认值。`CONFIG_DEFAULTS` 与 `cordis.patch.yml` 由 test/config.test.mjs
 * 双向钉住，代码与文档不会静默漂移。
 *
 * 这里**没有**额度常数（社区快照的「每日 N 次 / 单模型 N 次」）：官方改用
 * 「魔粒」计费后，面板头条是官方魔粒余额，次数口径的推算条已删除（见 README
 * 「三条事实」第2 条），而本插件的独家数据是分布 / 趋势 / 429 事件流——没有
 * 「上限」可与之相比。留着两个无人消费的常数只会在有人读配置时以为面板会拿它
 * 算「剩余次数」。真要加阈值提醒时，那应该是读官方余额的差值，不是这两个数。
 * @module dsh-connect-modelscope-token-plan/host-config
 */
import { str, obj, num, errMsg, redactSecrets } from "./util.ts";

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
export const PLUGIN_VERSION = "0.4.0";

/**
 * 默认值。刻意不含额度常数——理由见本文件头。
 * 面板头条是官方魔粒余额，次数口径的推算已在面板收敛时删除，这里若留着
 * dailyQuotaTotal 之类的社区快照，只会成为「看起来能算剩余次数」的假线索。
 */
export const CONFIG_DEFAULTS = Object.freeze({
  /** OpenAI 兼容推理源站（模型目录 + probe + provider 直连）。 */
  apiBase: "https://api-inference.modelscope.cn/v1",
  /** 站点源站，只用于面板外链（访问令牌页 / 文档）。 */
  siteBase: "https://modelscope.cn",
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
  /** provider 注册的 patch 默认值（面板保存值优先于它）。 */
  registerProvider: false,
  /**
   * 出图工具的 patch 默认值（面板保存值优先于它）。
   *
   * **与 `registerProvider` 是两个独立开关**：前者是「把魔搭当 chat provider」，
   * 后者是「给 agent 一个出图工具」。默认同为 false（opt-in），但互不牵连。
   * 实测依据见 docs/SPIKE-image-gen.md。
   */
  drawEnabled: false,
  /** 出图默认模型（空 = 自动挑目录里第一个出图模型）。 */
  drawModelId: "",
  /**
   * 单次出图的总预算（毫秒），含提交与全部轮询。
   *
   * 默认 **15 分钟**。这是本字段第三次调整，每次都有实测依据：
   *  1. 最初据「任务慢」定 10 分钟，后归因为「轮询太密」，改为 5 分钟；
   *  2. 该归因**已被推翻**——2026-10-10 同一模型、同样 15s 轮询连测三次，
   *     耗时 61s → 261s → **537s**，单调恶化。是上游免费池的**排队时长在波动**，
   *     与轮询间隔无关（那次 5s 轮询的 >185s 观测不能再当作证据）；
   *  3. 5 分钟预算因此**实测被击穿**：一次真实 e2e 在 300s 处放弃，而任务仍活着。
   *
   * 取 15 分钟：覆盖已观测到的最慢一次（537s）并留一倍余量。**注意超时放弃不等于
   * 任务死亡**——上游任务会继续跑（且记录最终会被回收，见 docs/SPIKE-image-gen.md
   * §坑 5）。宁可多等，不要把一张已经在生成的图扔掉。
   *
   * 「15 分钟够不够」我们**没有把握**（上面的实测还在恶化），所以夹取的上界
   * `DRAW_TIMEOUT_MAX_MS` 取 30 分钟，严格高于本默认值——觉得不够就往上调，
   * 别把它当上限用。
   */
  drawTimeoutMs: 900_000,
  /**
   * 一次出图**工具调用**愿意等的时间（毫秒）。
   *
   * 与 `drawTimeoutMs`（总放弃线）是两件事：那个回答「这张图值不值得继续等」，
   * 这个回答「一轮对话该被占住多久」。两者混为同一个数，就是把上游排队的代价
   * 转嫁成 agent 的停顿——实测排队 61s–537s，一次调用 await 到底等于让整轮
   * 对话陪着排队。
   *
   * 取 90s：能一次拿完实测最快那一档（61s）；更慢的本来就必须分段查（工具返回
   * `status: pending` + `jobId`，带它再调用即续查），再往上加只是把「等得久」
   * 换成「卡得久」。
   */
  drawWaitMs: 90_000,
  /** Host 应答的默认主机名；操作者的列表是「只增不替」。 */
  admittedHosts: ["localhost", "127.0.0.1", "[::1]", "::1"]
});

/** 把原始数值夹到有效整数（floor → 下限 → 上限；非正/非有限回退 def）。 */
export function clampInt(raw: unknown, def: number, min: number, max = Infinity): number {
  return Math.min(max, Math.max(min, Math.floor(num(raw, def))));
}

/**
 * `drawTimeoutMs` 的**上界**——必须严格大于它的默认值。
 *
 * 这个上界曾经与默认值同为 900_000，于是该字段只能调小、不能调大。而「15 分钟
 * 够不够」恰恰是本文件自己承认**没有把握**的问题：上面的注释记着同模型连测
 * 61s→261s→**537s** 的单调恶化、5 分钟预算被实测击穿，docs/SPIKE-image-gen.md
 * 还记着一次 900s 预算的 e2e 在 905s 放弃。把一个**已知可能不够用**的数值同时
 * 写成默认值与硬上限，等于在用户最需要「多等一会儿」的时刻把旋钮焊死——而且
 * 焊死在一个已被实测证伪的数上。
 *
 * 取 30 分钟：仍是有界的（不会让一次工具调用无限期挂着），但比默认值高出一倍，
 * 慢档用户有可调空间。它同时是 `drawWaitMs` 的上界来源（见 resolveSettings）。
 */
export const DRAW_TIMEOUT_MAX_MS = 1_800_000;

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
  trendDays: number;
  cacheSeconds: number;
  pollSeconds: number;
  inferenceTimeoutMs: number;
  maxEvents: number;
  registerProvider: boolean;
  /** 出图工具开关（面板保存值优先于它）。 */
  drawEnabled: boolean;
  /** 出图默认模型（空串 = 自动）。 */
  drawModelId: string;
  /** 单次出图总预算（毫秒）：从提交算起的总放弃线，跨多次工具调用累计。 */
  drawTimeoutMs: number;
  /** 单次工具调用愿意等的时间（毫秒）；等不到就返回 pending 让 agent 稍后续查。 */
  drawWaitMs: number;
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
    // 出图总预算先算出来：它是单次等待预算的**上界**（下面那条）。两个数必须在
    // 一处派生，否则「等待不该超过总放弃线」这条不变量就在两个地方各写一遍，
    // 改一处忘一处。
    const drawTimeoutMs = clampInt(source.drawTimeoutMs, CONFIG_DEFAULTS.drawTimeoutMs, 30_000, DRAW_TIMEOUT_MAX_MS);
    return {
      settings: {
        apiBase,
        siteBase,
        trendDays: clampInt(source.trendDays, CONFIG_DEFAULTS.trendDays, 1, 365),
        // 三个时长都必须有上界。`clampInt` 的 max 默认 Infinity，而这三个值直接
        // 喂给定时器与超时：
        //   · pollSeconds × 1000 交给 setInterval，超过 2^31-1 ms 时 Node 把延时
        //     **钳到 1ms**（TimeoutOverflowWarning）——插件变成每毫秒打一次魔搭
        //     目录，顺手把单飞缓存也打穿（缓存 TTL 60s，请求每 1ms 一次）。
        //     实测 pollSeconds=3000000 → _idleTimeout=1。
        //   · inferenceTimeoutMs 同理：3e9 会让每一次上游请求**立刻**超时。
        //   · cacheSeconds 无定时器，但同样要有界（缓存半永久 = 配置写错却看不出来）。
        // 上界按语义取：轮询 1 小时、缓存 10 分钟、单请求超时 10 分钟。
        cacheSeconds: clampInt(source.cacheSeconds, CONFIG_DEFAULTS.cacheSeconds, 5, 600),
        pollSeconds: clampInt(source.pollSeconds, CONFIG_DEFAULTS.pollSeconds, 5, 3_600),
        inferenceTimeoutMs: clampInt(source.inferenceTimeoutMs, CONFIG_DEFAULTS.inferenceTimeoutMs, 1_000, 600_000),
        maxEvents: clampInt(source.maxEvents, CONFIG_DEFAULTS.maxEvents, 1, 1_000),
        registerProvider: source.registerProvider === true,
        // 出图三件套。超时同样夹上界：它直接喂给轮询截止，3e9 会让每一次出图
        // 立刻超时（与 pollSeconds / inferenceTimeoutMs 同一类坑）。下界 30s——
        // 低于实测最快的一次出图（61s）没有意义；上界 DRAW_TIMEOUT_MAX_MS 严格
        // 高于默认值，见那个常数的注释（这里曾写成 900_000 = 默认值本身，字段
        // 只能调小不能调大）。
        drawEnabled: source.drawEnabled === true,
        drawModelId: str(source.drawModelId, CONFIG_DEFAULTS.drawModelId),
        drawTimeoutMs,
        // 单次等待预算：下界 10s（再低就没必要分段了），上界 = 刚算出的总放弃线
        // （超过它的等待没有意义，draw-runtime 里还会再夹一次）。
        drawWaitMs: clampInt(source.drawWaitMs, CONFIG_DEFAULTS.drawWaitMs, 10_000, drawTimeoutMs),
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
        trendDays: CONFIG_DEFAULTS.trendDays,
        cacheSeconds: CONFIG_DEFAULTS.cacheSeconds,
        pollSeconds: CONFIG_DEFAULTS.pollSeconds,
        inferenceTimeoutMs: CONFIG_DEFAULTS.inferenceTimeoutMs,
        maxEvents: CONFIG_DEFAULTS.maxEvents,
        registerProvider: false,
        drawEnabled: false,
        drawModelId: CONFIG_DEFAULTS.drawModelId,
        drawTimeoutMs: CONFIG_DEFAULTS.drawTimeoutMs,
        drawWaitMs: CONFIG_DEFAULTS.drawWaitMs,
        allowedHosts: new Set(CONFIG_DEFAULTS.admittedHosts)
      },
      configError: redactSecrets(errMsg(error))
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

/**
 * 从 Host 头里剥端口；非法形状返回空串（被 {@link isAdmitted} 拒绝）。
 *
 * IPv6 字面量必须**整体**匹配 `[...]` 或 `[...]:port`：方括号闭合之后只允许空
 * 或 `:端口`，其余一律拒绝。曾经这里只「截断到第一个 `]` 就返回」，于是
 * `Host: [::1]evil.com` 读成 `[::1]` 并**通过**围栏——白名单是精确集合，前缀
 * 匹配等于把它放宽成「以白名单成员开头」。
 */
export function hostName(host: string): string {
  // 裸 IPv6 字面量带多个冒号。仅当倒数第二段与最后一段**都是纯数字**时，
  // 最后一段才是端口（"::1:3080" → "::1"；"::1" 的 ":1" 不是端口）。
  // 没认出来的名字原样返回 → 被 isAdmitted 拒绝，这是安全的方向。
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    // 没有闭合的 `]`：不是合法的 IPv6 字面量，也不是主机名 → 拒绝。
    if (end < 0) return "";
    const rest = host.slice(end + 1);
    // 闭合后只允许空或 `:port`（1–5 位数字）。`evil.com` / `:8080@evil.com` 走这里。
    if (rest !== "" && !/^:\d{1,5}$/.test(rest)) return "";
    return host.slice(0, end + 1);
  }
  if (host.includes("]")) return "";   // 闭合括号出现在非开头：形状不对
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
