/**
 * 本地计数的**写入侧**——把 DSH 真实对话（经本插件注册的 provider）折算成
 * usage-store 的天桶/单模型计数与 429 事件流。
 *
 * 为什么不是「在 adapter 里随便挂个钩子」，而是独立一层：M4 之前
 * `usageStore.recordCall` 的唯一生产者是 `routes/probe.ts` 的 usage 试调，而那个
 * 按钮已随目录表删除、validity 探针按设计不记调用——于是本地计数层在接入
 * provider 之后**没有任何生产者**，「今日次数 / 单模型分布 / 趋势 /
 * 429 事件流」四块面板恒为 0 与空。本模块补上这条缺失的生产者，也就成了**唯一**
 * 的常驻写入侧（`probe` 路由的 `kind:"usage"` 分支随后一并删除，见 probe.ts）。
 *
 * ## 与 harness 自己的账本的分工（别再造第二本账）
 *
 * DSH 有 `@linxin666/dsh-usage`，它按 `days → provider → model` 折 token
 * （`~/.dsh/dsh-usage/usage-ledger.json`），数据源是 session 的
 * `assistant/message` 事件。因此：
 *
 * - **成功调用的 token 已有主**。本模块**不重复记 token 总量**去和它抢一个
 *   真源；本插件面板的「今日次数 / 分布 / 趋势」是**本插件口径**的独立观测
 *   （回答「经本插件的调用分布」，与全局账本的回答不同，两者可以并存）。
 * - **失败调用没有主**。`assistant/message` 只在成功时发出，429/错误一次都
 *   不进那本账——而「哪个模型刚才在限频/额度耗尽」恰恰是魔搭面板唯一能给出
 *   独家答案的问题（官方只给总额度余额）。所以**事件流是本模块存在的核心理由**。
 *
 * 换句话说：能用官方魔粒余额回答的，本插件不重复回答；只有本地计数能回答的
 * （分布 / 趋势 / 失败事件），才由这里生产。
 *
 * ## 观察点选在「流出口」，不是 HTTP 层
 *
 * harness 的流协议（`@deepseek-ai/dsh-llm` 的 `StreamChunk`）自带
 * `{type:'usage', usage: TokenUsage}` chunk 与 `finish` chunk：
 *
 * - 成功：末尾先 `usage`（累计值）再 `finish`；
 * - 失败：`finish` 且 `reason.kind === 'error'`（或 `aborted`），带
 *   `reason.failure.{code,message}`——429 的 code/message 就在这里。
 *
 * 所以一次遍历就能同时拿到 token 与失败分类，不必碰 provider 的私有 API，
 * 也不必改 vendor peer。`llm-error-fix.ts` 的重分类层已在同一位置改写 code，
 * 事件分诊**读改写后的 code**，于是「被误判成 QUOTA 的 rpm 限频」在本插件的
 * 事件流里也记成 `rate_limit` 而不是 `quota`——面板与重试策略说同一件事。
 *
 * ## 记账口径
 *
 * 每次流**结束就记一次 call**（含失败、含用户中断）：魔搭按**次数**计费，
 * 一次被打上限频的请求同样是一次上游调用。token 数在上游给出时带上，给不出
 * 时传 `null`（wire 语义基线：null 是「上游没给」，绝不写成 0）。
 *
 * 已知偏差（不是「少记」，是「按流计次」）：重试不在一条流内部发生，而在
 * `dsh-agent-loop` 消费完流之后由 `agent/request-error` 瀑布决定
 * （`dsh-agent-loop/lib/index.js:1116-1134`），`dsh-llm-retry` 据此**重新发起一次
 * 请求**、产生**新的流**。观察器套在流出口上，于是**每次重试各记一次 call**——
 * 按「魔搭按次数计费」的口径这反而是对的（每次重发都真打了一次上游），但它与
 * 早先本文件「重试掉的那些次不单独计」的说法相反，故此处一并更正。
 * 2026-10-05 读 peer 源码（`@deepseek-ai/dsh-llm-retry`、`dsh-agent-loop`）核实。
 *
 * peer-free：只 import 本仓库的 peer-free 模块（`llm-error-fix` / `util`）与
 * `shared/wire` 的类型，离线可测——与 `llm-error-fix` 同一纪律。
 *
 * @module dsh-connect-modelscope-token-plan/usage-observer
 */

import { CODE } from "./llm-error-fix.ts";
import { redactSecrets } from "./util.ts";
import type { QuotaEvent } from "../shared/wire.ts";

/**
 * 观察器的两个写入口——`usage-store` 的对应方法（结构上兼容，测试可传假实现）。
 *
 * 两者都返回 void/promise 且**永不抛**：本模块在流出口调用它们，计数失败
 * 绝不能打断一次正在进行的对话。
 */
export interface UsageSinks {
  /** 记一次调用；`tokens` 为 null 表示上游没给用量（不是 0）。 */
  recordCall: (input: { modelId: string; tokens: number | null }) => void | Promise<void>;
  /** 记一条事件（429 / 错误）。 */
  recordEvent: (input: { modelId: string; kind: QuotaEvent["kind"]; message: string }) => void | Promise<void>;
}

/** harness 流 chunk 的最小读取形状（本模块只认这三个字段，不 import peer 类型）。 */
interface StreamChunkLike {
  type?: unknown;
  usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown };
  reason?: { kind?: unknown; failure?: { code?: unknown; message?: unknown } | null } | null;
}

/**
 * 读一个流 chunk 的 token 总量，取不到返回 `null`。
 *
 * 优先 `totalTokens`（peer 保留的上游精确总量）；它缺失时退回
 * `inputTokens + outputTokens`——**不含** cache 字段，因为本插件的账是
 * 「次数 + 大致 token」口径，与全局账本的可加总口径刻意不同。
 * @param {unknown} chunk - 一个流 chunk。
 * @returns {number|null} 正整数 token 数，或 null。
 */
export function tokensOfChunk(chunk: unknown): number | null {
  if (chunk === null || typeof chunk !== "object") return null;
  const usage = (chunk as StreamChunkLike).usage;
  if (usage === null || typeof usage !== "object") return null;
  const total = usage.totalTokens;
  if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const sum =
    (typeof input === "number" && Number.isFinite(input) && input > 0 ? input : 0) +
    (typeof output === "number" && Number.isFinite(output) && output > 0 ? output : 0);
  return sum > 0 ? sum : null;
}

/**
 * 读一个流 chunk 的失败事件，取不到返回 `null`（成功 chunk、空 chunk、非
 * error 终止都返回 null）。
 *
 * 分诊读的是**重分类之后**的 `failure.code`（`llm-error-fix` 与本层跑在同一个
 * 包装链上，改写先于观察发生）：
 *
 * - `QUOTA` / `ACCOUNT_QUOTA` → `quota`（真耗尽，快失败，不重试）；
 * - `RATE_LIMIT` → `rate_limit`（瞬时限频，会退避重试）；
 * - 其它 code（含空 code）→ `error`。
 *
 * message 过 `redactSecrets` 后再返回：上游错误体是外来文本，事件流会进面板
 * 与 state 文件，凭据形状必须先脱敏。
 * @param {unknown} chunk - 一个流 chunk。
 * @returns {{kind: QuotaEvent["kind"], message: string}|null} 事件，或 null。
 */
export function eventOfChunk(chunk: unknown): { kind: QuotaEvent["kind"]; message: string } | null {
  if (chunk === null || typeof chunk !== "object") return null;
  const reason = (chunk as StreamChunkLike).reason;
  if (reason === null || typeof reason !== "object") return null;
  // `aborted`（用户中断）带 failure 但不是上游失败：不进事件流——用户自己
  // 按的停止键不是 quota 信号。计数仍会发生（见 observeStream）。
  if (reason.kind !== "error") return null;
  const failure = reason.failure;
  if (failure === null || typeof failure !== "object") return null;
  const code = typeof failure.code === "string" ? failure.code : "";
  const kind: QuotaEvent["kind"] =
    code === CODE.QUOTA || code === CODE.ACCOUNT_QUOTA
      ? "quota"
      : code === CODE.RATE_LIMIT
        ? "rate_limit"
        : "error";
  const raw = typeof failure.message === "string" ? failure.message : "";
  const message = redactSecrets(raw === "" ? "stream failed (" + code + ")" : raw);
  return { kind, message };
}

/**
 * 包一条流：透传所有 chunk，同时在流结束时把这一次调用记进 sinks。
 *
 * 三个刻意的行为：
 *
 * 1. **结束即记账，且只记一次**。正常结束、消费者提前 `break`、内层抛错都走
 *    同一个 `finally`（async generator 的 `finally` 至多执行一次，所以不需要
 *    额外的幂等闸）；魔搭按次数计费，这三种都是一次真实的上游调用。多个
 *    `usage` chunk 取最后一个（peer 的 usage 是累计值，不是增量）。
 * 2. **失败也记账，但 token 为 null**。429/错误没有 usage chunk，计数照记、
 *    事件另记；「没有 token 数」与「token 是 0」在 wire 里是两件事。
 * 3. **写 sinks 永不抛**。`safe()` 把同步抛与异步拒一并吞掉：观测层不能成为
 *    对话失败的原因。
 *
 * @param {AsyncIterableIterator<unknown>} source - 内层流。
 * @param {string} modelId - 本次调用的模型 id（由出口处的 options 捕获）。
 * @param {UsageSinks} sinks - 写入口。
 * @returns {AsyncGenerator<unknown>} 透传后的流。
 */
export async function* observeStream(
  source: AsyncIterableIterator<unknown>,
  modelId: string,
  sinks: UsageSinks
): AsyncGenerator<unknown> {
  let tokens: number | null = null;
  try {
    for await (const chunk of source) {
      const seen = tokensOfChunk(chunk);
      if (seen !== null) tokens = seen;
      const event = eventOfChunk(chunk);
      if (event !== null) safe(() => sinks.recordEvent({ modelId, kind: event.kind, message: event.message }));
      yield chunk;
    }
  } finally {
    // 用户中断/内层抛错时 token 多半读不到；null 是诚实值。
    safe(() => sinks.recordCall({ modelId, tokens }));
  }
}

/** 调一个 sink 并吞掉它的任何失败（同步抛与异步拒都吞）。 */
function safe(run: () => void | Promise<void>): void {
  try {
    const result = run();
    if (result !== null && typeof result === "object" && typeof (result as Promise<void>).then === "function") {
      void (result as Promise<void>).then(undefined, () => {});
    }
  } catch {
    // 观测失败不是对话失败。
  }
}

/**
 * 读一条调用参数里的模型 id（`GenerateOptions.model`）。
 *
 * 缺失/空串一律读成 `""`，由调用方决定是否跳过记账——**不猜**：把 `unknown`
 * 填成某个模型 id 会让分布图出现凭空的一行。
 * @param {unknown} options - 流/调用的参数对象。
 * @returns {string} 模型 id，或空串。
 */
export function modelIdOfOptions(options: unknown): string {
  if (options === null || typeof options !== "object") return "";
  const model = (options as { model?: unknown }).model;
  return typeof model === "string" ? model : "";
}

/**
 * 给一个 adapter 套上观察层：包住两个流出口（`stream` 与
 * `prepareCall(...).stream`），与 `llm-adapter-core` 的重分类包装同构。
 *
 * 刻意**不**把这段塞进 `llm-adapter-core.ts`：那个文件是三族插件的受控复制
 * 共享层（sensenova/agnes 各有一份），往里加一个只有魔搭需要的观测钩子，等于
 * 给三份副本之间再造一个漂移面（`patchPayload`、签名比对、三态口径都栽在
 * 这类地方）。这里独立成文件、由魔搭自己的 `llm-adapter.ts` 组合。
 *
 * 无 sinks 时返回原对象（不套 Proxy）——没有观测者的路径零开销。
 *
 * @param {object} inner - 适配器实例。
 * @param {UsageSinks} sinks - 写入口。
 * @returns {object} 套好观察层的适配器。
 */
export function withUsageObserver(inner: object, sinks: UsageSinks): object {
  const wrapStream = (stream: (options: unknown) => AsyncIterableIterator<unknown>, options: unknown) => {
    const modelId = modelIdOfOptions(options);
    const source = stream(options);
    if (modelId === "") return source;
    return observeStream(source, modelId, sinks);
  };

  return new Proxy(inner, {
    get(target: object, prop: string | symbol, receiver: object) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "stream") {
        const stream = (target as { stream: (options: unknown) => AsyncIterableIterator<unknown> }).stream;
        return typeof stream === "function" ? (options: unknown) => wrapStream(stream, options) : value;
      }
      if (typeof value === "function" && prop === "prepareCall") {
        const prepare = (target as { prepareCall: (...args: unknown[]) => unknown }).prepareCall;
        return (...args: unknown[]) => {
          // prepareCall(provider, model, signal)：模型 id 在第二参，stream
          // 参数里未必还有它，所以从这一层就抓住。
          const modelId = modelIdOfOptions({ model: args[1] });
          const prepared = prepare.apply(target, args);
          const wrap = (handle: unknown): unknown => {
            if (handle === null || typeof handle !== "object" || modelId === "") return handle;
            const inner = handle as { stream?: (o: unknown) => AsyncIterableIterator<unknown> };
            if (typeof inner.stream !== "function") return handle;
            return { ...inner, stream: (o: unknown) => observeStream(inner.stream!(o), modelId, sinks) };
          };
          const promise = prepared as { then?: (fn: (p: unknown) => unknown) => unknown } | null;
          if (promise !== null && typeof promise.then === "function") {
            return promise.then((p: unknown) => wrap(p));
          }
          return wrap(prepared);
        };
      }
      return value;
    }
  });
}
