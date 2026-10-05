import { C as redactSecrets, _ as reclassifyStream, c as LLM_PROVIDER_ID, i as name, l as buildDescriptors, m as CODE, o as LLM_API_KEY_NAME, s as LLM_DISPLAY_NAME } from "./host-config-DBCiZOBW.js";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";

//#region src/host/llm-retry.ts
/**
* The directly-registered ModelScope provider's 429 retry policy — the peer-FREE
* half of the 429 self-healing work.
*
* The *decision* (which failure classes this shared-pool provider retries, and
* how gently) is pure, so it lives here — importable on a clean checkout where
* the `@deepseek-ai/dsh-llm` peer is not resolvable — and is handed to the peer's
* `resolveRetryPolicy` from `llm-adapter.ts`. `test/retry.test.mjs` pins its
* shape without importing that peer.
*
* The peer classifies a ModelScope 429 into two codes (`isQuotaExceededError` →
* `rate.?limit` inside `classifyPiAiError`, pinned against the real source by
* `test/peer-contract.test.mjs`):
*
*   - `QUOTA` / `ACCOUNT_QUOTA` — the Token Plan pool is depleted. Retrying
*     cannot refill it, and the pool is SHARED across every model on this key,
*     so hammering it only extends the cool-down (the same lesson `st-rotator`
*     bakes into its AIMD limiter). Deliberately NOT retried: fast-fail and let
*     the panel say why.
*   - `RATE_LIMIT` — a transient throttle that self-clears. Retried, with a
*     backoff biased longer than the peer default so one shared pool is not
*     re-hit immediately: ModelScope's daytime rpm/tpm ceiling is aggressive
*     (`llm-error-fix.ts`: its `quota_exceeded_error` code 8 is really a
*     per-minute rate cap), so we ride it out with more attempts and a gentler
*     first step.
*
* @module dsh-connect-modelscope-token-plan/llm-retry
*/
/**
* The failure-class codes this provider reasons about, in peer-canonical
* spelling.
*
* The strings mirror the `@deepseek-ai/dsh-llm` peer's error-code constants
* (`QUOTA_EXCEEDED_CODE = "QUOTA"`, `ACCOUNT_QUOTA_EXCEEDED_CODE =
* "ACCOUNT_QUOTA"`, `EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE"`). They are stable
* protocol codes, not implementation details, so pinning them here is what the
* qoder route does too; `llm-adapter.ts` still imports the live constants from
* the peer and passes them through `resolveRetryPolicy`, so a peer rename would
* surface at the adapter, not silently drift here.
*/
const QUOTA_CODES = Object.freeze({
	/** Depleted Token Plan pool (per-pool quota). Not retried. */
	quota: "QUOTA",
	/** Depleted account-level quota. Not retried. */
	accountQuota: "ACCOUNT_QUOTA",
	/** Empty/truncated response. Retried. */
	emptyResponse: "EMPTY_RESPONSE",
	/** Transient throttle (429 rate). Retried with backoff. */
	rateLimit: "RATE_LIMIT",
	/** Upstream 5xx. Retried. */
	server: "SERVER",
	/** Request deadline exceeded. Retried. */
	timeout: "TIMEOUT",
	/** Connection-level failure. Retried. */
	transport: "TRANSPORT"
});
/**
* The failure classes this provider retries, in peer-canonical order.
*
* Excludes both quota codes on purpose: a depleted pool cannot be retried into
* health, and retrying it against a shared credit pool only prolongs the
* cool-down. `RATE_LIMIT` stays — transient throttles self-clear.
* @returns {string[]} the retryable code list (no duplicates, non-empty).
*/
function retryableCodes() {
	return [
		QUOTA_CODES.emptyResponse,
		QUOTA_CODES.rateLimit,
		QUOTA_CODES.server,
		QUOTA_CODES.timeout,
		QUOTA_CODES.transport
	];
}
/**
* Build the provider's retry-policy config.
*
* The shape is exactly what `@deepseek-ai/dsh-llm`'s `resolveRetryPolicy`
* accepts (`mode: "normal"` → `{ mode, maxRetries, retryableCodes, backoff }`).
* We pin it explicitly rather than passing `undefined` so a future change to
* the peer's default policy cannot silently alter this provider's behaviour.
* This module's shape is pinned by `test/retry.test.mjs`; the live peer's
* `resolveRetryPolicy` contract is covered by `test/peer-contract.test.mjs`,
* which needs the runtime peer (not vendored here) and is outside the offline
* `npm test` gate.
*
* Tuned for ModelScope's daytime rate ceiling (rpm/tpm), which the peer mislabels
* as `QUOTA` — `llm-error-fix.ts` pulls those back to `RATE_LIMIT` so they
* reach this policy. The numbers: more attempts (8) and a gentler, longer
* backoff than the peer default (initial 1.5s → cap 20s, jitter 0.25) so a
* single shared credit pool is not stampeded while the rate window refills.
* Still bounded: a genuine outage fails after ~90s of backed-off retries rather
* than spinning forever. QUOTA stays excluded (a depleted pool cannot be retried
* into health; retrying it only prolongs the cool-down — ROADMAP §1).
* @returns {{mode: "normal", maxRetries: number, retryableCodes: string[], backoff: {initialDelayMs: number, maxDelayMs: number, jitterRatio: number}}}
*/
function buildRetryPolicyConfig() {
	return {
		mode: "normal",
		maxRetries: 8,
		retryableCodes: retryableCodes(),
		backoff: {
			initialDelayMs: 1500,
			maxDelayMs: 2e4,
			jitterRatio: .25
		}
	};
}

//#endregion
//#region src/host/llm-adapter-core.ts
/**
* `PiAiAdapter` 装配的共享半边——魔搭 provider 的 inert pi-ai auth 平面、
* profile 行与流重分类 Proxy 都从这里来。
*
* 装配这一层（inert auth 平面、profile 行、`PiAiAdapter` 装配、流重分类 Proxy）
* 最初在姊妹插件里是抄写的多份：那是**对运行时 peer 的装配**，不是领域逻辑——
* 副本之间的差异买不到任何东西，代价却是要修多次（429 误分类层是修正，每一处
* 修正都必须到达每一条路由，否则其中一条会静默停止退避）。魔搭复用同一份，
* 理由完全一样：装配与上游是谁无关。
*
* 留在各适配器里的：descriptor 构建（每个上游映自己的 roster/catalog）与各路由
* 读取的凭据解析器——那是真正的领域差异。
*
* peer-dependent：import `pi-ai` / `dsh-llm` / `dsh-llm-pi-ai`，它们随 Host
* 发行。与适配器本身一样，不能由离线单测套件导入，由 wiring/e2e 检查来测。
*
* @module dsh-connect-modelscope-token-plan/llm-adapter-core
*/
/** 一次流读取在途时的空闲上限（dsh-llm-pi-ai 默认）。 */
const STREAM_IDLE_TIMEOUT_MS = 3e5;
/** `dsh-llm-pi-ai` 默认的像素预算（魔搭 provider 直接沿用）。 */
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4194304;
/**
* `dsh-llm-pi-ai` 默认的图片预算，像素预算可覆盖。
* @param {number} [requestImagePixelBudget] - 像素预算覆盖值。
* @returns {{maxRequestImageBytes: number, requestImagePixelBudget: number,
*   requestImageMaxBytes: number}} profile 的图片预算行。
*/
function imageBudgets(requestImagePixelBudget = DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET) {
	return {
		maxRequestImageBytes: 20971520,
		requestImagePixelBudget,
		requestImageMaxBytes: 1048576
	};
}
/**
* inert pi-ai auth 平面。
*
* 认证走各路由提供的凭据解析器（存着的 `MODELSCOPE_API_KEY` 引用），每次请求现
* 读。pi-ai 自己的凭据生命周期绝不能为这条路制造凭据，所以所有环境性问题都答
* 「没存、没设」。
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/**
* 给适配器包一层，让两个流出口都把被误判的 429 重分类。
*
* peer 的 `classifyPiAiError` 会把「budget/credits」措辞的 429 读成 QUOTA（不重
* 试）；这一层在流离开前把这样的 body 改回 RATE_LIMIT，`llm-retry.ts` 的退避才
* 真的会触发。只拦流出口，不碰 peer 内部，也不改普通数据块。见 `llm-error-fix.ts`。
* @param {object} inner - 要包的 `PiAiAdapter`。
* @returns {object} 包好的适配器。
*/
function withReclassifiedStream(inner) {
	return new Proxy(inner, { get(target, prop, receiver) {
		const value = Reflect.get(target, prop, receiver);
		if (prop === "stream") {
			const stream = target.stream;
			return (options) => reclassifyStream(stream(options));
		}
		if (typeof value === "function" && prop === "prepareCall") {
			const prepare = target.prepareCall;
			return (...args) => {
				const prepared = prepare.apply(target, args);
				const handle = prepared;
				if (handle !== null && typeof handle.then === "function") return handle.then((p) => {
					const inner = p;
					return inner !== null && typeof inner.stream === "function" ? {
						...inner,
						stream: (o) => reclassifyStream(inner.stream(o))
					} : p;
				});
				return handle !== null && typeof handle.stream === "function" ? {
					...handle,
					stream: (o) => reclassifyStream(handle.stream(o))
				} : prepared;
			};
		}
		return value;
	} });
}
/**
* 装配一个 provider 的适配器：pi-ai provider、它的单条 profile 行、承载它们的
* `PiAiAdapter`。
*
* 每次重建都换新实例是刻意的：`PiAiAdapter` 内部 memoize profiles 快照，所以目录
* 或凭据变化时调用方**替换**注册的适配器并 emit `llm/adapters-updated`。
* @param {PiAiAdapterParts} options - 每条上游的事实。
* @returns {{adapter: object, providerIds: string[]}} 适配器与它拥有的 ids。
*/
function assemblePiAiAdapter({ providerId, displayName, apiKeyName, models, resolveCredential, get, reasoning, requestImagePixelBudget }) {
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: apiKeyName,
				/**
				* pi-ai 会把它解析到的凭据递过来；这些路由自己不存，所以参数只为了给
				* 「从它上面读什么」一个名字。
				* @param {{credential?: {key?: string}}} [options]
				*/
				async resolve({ credential } = {}) {
					const key = credential?.key;
					return key === void 0 || key.length === 0 ? void 0 : {
						auth: { apiKey: key },
						source: displayName
					};
				}
			} },
			models,
			api: openAICompletionsApi()
		}),
		getModels: () => models
	};
	const profiles = /* @__PURE__ */ new Map([[providerId, {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(buildRetryPolicyConfig(), `${name}.${providerId}.retryPolicy`),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...reasoning !== void 0 ? { reasoning } : {},
		...imageBudgets(requestImagePixelBudget),
		piProvider: provider
	}]]);
	return {
		adapter: withReclassifiedStream(new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => resolveCredential(),
			resolveAttachments: () => get?.("attachments"),
			resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => (get?.("fs"))?.processPathFromHostPath?.(hostPath), ref)
		})),
		providerIds: [providerId]
	};
}

//#endregion
//#region src/host/usage-observer.ts
/**
* 本地计数的**写入侧**——把 DSH 真实对话（经本插件注册的 provider）折算成
* usage-store 的天桶/单模型计数与 429 事件流。
*
* 为什么不是「在 adapter 里随便挂个钩子」，而是独立一层：M4 之前
* `usageStore.recordCall` 的**常规**生产者只有 `routes/probe.ts`，而面板的 usage
* 试调按钮已随目录表删除、validity 探针按设计不记调用——于是本地计数层在
* 接入 provider 之后**没有任何生产者**，「今日次数 / 单模型分布 / 趋势 /
* 429 事件流」四块面板恒为 0 与空。本模块补上这条缺失的生产者。
* （`routes/probe.ts` 的 `kind:"usage"` 分支仍在且仍会记账，但面板已无入口触发它，
* 所以本模块是当前唯一的常规写入侧。）
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
* 已知偏差（方向是少记，不是多记）：peer 的重试在同一条流**内部**重发 HTTP，
* 观察器只看到一条流，于是重试掉的那些次不单独计。宁可少记也不虚增。
*
* peer-free：只 import 本仓库的 peer-free 模块（`llm-error-fix` / `util`）与
* `shared/wire` 的类型，离线可测——与 `llm-error-fix` 同一纪律。
*
* @module dsh-connect-modelscope-token-plan/usage-observer
*/
/**
* 读一个流 chunk 的 token 总量，取不到返回 `null`。
*
* 优先 `totalTokens`（peer 保留的上游精确总量）；它缺失时退回
* `inputTokens + outputTokens`——**不含** cache 字段，因为本插件的账是
* 「次数 + 大致 token」口径，与全局账本的可加总口径刻意不同。
* @param {unknown} chunk - 一个流 chunk。
* @returns {number|null} 正整数 token 数，或 null。
*/
function tokensOfChunk(chunk) {
	if (chunk === null || typeof chunk !== "object") return null;
	const usage = chunk.usage;
	if (usage === null || typeof usage !== "object") return null;
	const total = usage.totalTokens;
	if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
	const input = usage.inputTokens;
	const output = usage.outputTokens;
	const sum = (typeof input === "number" && Number.isFinite(input) && input > 0 ? input : 0) + (typeof output === "number" && Number.isFinite(output) && output > 0 ? output : 0);
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
function eventOfChunk(chunk) {
	if (chunk === null || typeof chunk !== "object") return null;
	const reason = chunk.reason;
	if (reason === null || typeof reason !== "object") return null;
	if (reason.kind !== "error") return null;
	const failure = reason.failure;
	if (failure === null || typeof failure !== "object") return null;
	const code = typeof failure.code === "string" ? failure.code : "";
	const kind = code === CODE.QUOTA || code === CODE.ACCOUNT_QUOTA ? "quota" : code === CODE.RATE_LIMIT ? "rate_limit" : "error";
	const raw = typeof failure.message === "string" ? failure.message : "";
	return {
		kind,
		message: redactSecrets(raw === "" ? "stream failed (" + code + ")" : raw)
	};
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
async function* observeStream(source, modelId, sinks) {
	let tokens = null;
	try {
		for await (const chunk of source) {
			const seen = tokensOfChunk(chunk);
			if (seen !== null) tokens = seen;
			const event = eventOfChunk(chunk);
			if (event !== null) safe(() => sinks.recordEvent({
				modelId,
				kind: event.kind,
				message: event.message
			}));
			yield chunk;
		}
	} finally {
		safe(() => sinks.recordCall({
			modelId,
			tokens
		}));
	}
}
/** 调一个 sink 并吞掉它的任何失败（同步抛与异步拒都吞）。 */
function safe(run) {
	try {
		const result = run();
		if (result !== null && typeof result === "object" && typeof result.then === "function") result.then(void 0, () => {});
	} catch {}
}
/**
* 读一条调用参数里的模型 id（`GenerateOptions.model`）。
*
* 缺失/空串一律读成 `""`，由调用方决定是否跳过记账——**不猜**：把 `unknown`
* 填成某个模型 id 会让分布图出现凭空的一行。
* @param {unknown} options - 流/调用的参数对象。
* @returns {string} 模型 id，或空串。
*/
function modelIdOfOptions(options) {
	if (options === null || typeof options !== "object") return "";
	const model = options.model;
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
function withUsageObserver(inner, sinks) {
	const wrapStream = (stream, options) => {
		const modelId = modelIdOfOptions(options);
		const source = stream(options);
		if (modelId === "") return source;
		return observeStream(source, modelId, sinks);
	};
	return new Proxy(inner, { get(target, prop, receiver) {
		const value = Reflect.get(target, prop, receiver);
		if (prop === "stream") {
			const stream = target.stream;
			return typeof stream === "function" ? (options) => wrapStream(stream, options) : value;
		}
		if (typeof value === "function" && prop === "prepareCall") {
			const prepare = target.prepareCall;
			return (...args) => {
				const modelId = modelIdOfOptions({ model: args[1] });
				const prepared = prepare.apply(target, args);
				const wrap = (handle) => {
					if (handle === null || typeof handle !== "object" || modelId === "") return handle;
					const inner = handle;
					if (typeof inner.stream !== "function") return handle;
					return {
						...inner,
						stream: (o) => observeStream(inner.stream(o), modelId, sinks)
					};
				};
				const promise = prepared;
				if (promise !== null && typeof promise.then === "function") return promise.then((p) => wrap(p));
				return wrap(prepared);
			};
		}
		return value;
	} });
}

//#endregion
//#region src/host/llm-adapter.ts
/**
* 魔搭 provider 注册的 peer-dependent 半边。
*
* 这里的一切都跑在 Host 发行的 peer 上（`pi-ai`、`dsh-llm`、`dsh-llm-pi-ai`）——这
* 正是 descriptor 映射要住在 peer-free 的 `llm-models.ts` 的原因：本模块不能被离线
* 单测套件导入，所以它只装对运行时的装配，由 wiring/e2e 检查来测。
*
* 形状对齐已知可用的 qoder 适配器：
*
* - 一个 `PiAiAdapter` 承载一条 profile（本 provider 就一个源站——`apiBase`）；
* - inert pi-ai auth 平面——令牌每次请求现从插件自己的 store 解析，pi-ai 绝不能
*   自己造凭据；
* - 两个 IMAGE hook 都接上，否则吃图模型在消息带图的那一刻就会答
*   `UNSUPPORTED_CONTENT`；
* - profile 里不烤 API key：picker 在没钥匙的情况下照常展示模型，请求在解析时才
*   失败，而那里正是面板状态可见的地方。
*
* 装配与姊妹插件共用一份（`llm-adapter-core.ts`）；本 provider 贡献的是它的
* descriptor 构建与凭据解析器。**不传 `reasoning`**（§4：魔搭是多模型代理，档位表
* 无法离线得知，宁可「不选」也不「错发」——profile 不钉 effort）。
*
* @module dsh-connect-modelscope-token-plan/llm-adapter
*/
/**
* 为一份目录快照装配适配器实例。
*
* 每次重建换新实例是刻意的：`PiAiAdapter` 内部 memoize profiles 快照
* （`if (this.snapshot?.profiles === profiles)`），所以调用方在目录或钥匙变化时
* **替换**注册的适配器并 emit `llm/adapters-updated`，与 qoder 路由刷自己注册的
* 方式一致。
* @param {object} options - 装配参数。
* @param {object[]} options.entries - 归一目录条目。
* @param {string[]} [options.enabledIds] - 用户精选的允许清单；空 = 全部模型。
* @param {string} options.baseUrl - OpenAI 兼容源站。
* @param {() => Promise<string>} options.resolveApiKey - 每次请求解析活的 `ms-` 令牌。
* @param {(service: string) => unknown} [options.get] - 图片 hook（`attachments`、
*   `fs`）的服务解析器。
* @param {string[]} [options.unavailableModelIds] - 额度耗尽的模型 id，从 offer 里
*   排除，避免发出注定 429 的请求。
* @param {UsageSinks} [options.usage] - 本地计数的写入口（usage-store 的两条
*   方法）。**这是面板「今日次数 / 模型分布 / 趋势 / 429 事件流」唯一的生产
*   者**——probe 那条写入路径已随目录表删除，缺了它四块面板恒为 0 与空。
*   缺省不套观察层（零开销，见 `usage-observer.ts`）。
* @returns {{adapter: object, providerIds: string[]}} 适配器与它拥有的 ids。
*/
function createModelScopeAdapter({ entries, enabledIds = [], baseUrl, resolveApiKey, get, unavailableModelIds = [], usage }) {
	const models = buildDescriptors(entries, {
		providerId: LLM_PROVIDER_ID,
		baseUrl,
		enabledIds,
		unavailableModelIds
	});
	const built = assemblePiAiAdapter({
		providerId: LLM_PROVIDER_ID,
		displayName: LLM_DISPLAY_NAME,
		apiKeyName: LLM_API_KEY_NAME,
		models,
		resolveCredential: resolveApiKey,
		...get !== void 0 ? { get } : {}
	});
	return {
		adapter: usage === void 0 ? built.adapter : withUsageObserver(built.adapter, usage),
		providerIds: built.providerIds
	};
}

//#endregion
export { createModelScopeAdapter };