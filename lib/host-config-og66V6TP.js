//#region src/host/util.ts
/** 读一个有限的正数，否则回退值。 */
function num(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
/** 读一个非空字符串，否则回退值。 */
function str(value, fallback) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}
/** 读一个普通对象，否则 `{}`。 */
function obj(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
/** catch 点统一的一行错误消息。 */
function errMsg(value) {
	return value instanceof Error ? value.message : String(value);
}
/** 原样读字符串（凭据专用：trim 是用户看不见的改动）。 */
function verbatim(value, fallback) {
	return typeof value === "string" ? value : fallback;
}
/**
* 凭据形状字符串的脱敏闸：任何可能进日志/错误消息/面板响应的文本都先过这里。
* 家规（AGENTS.md 红线 1）：凭据永不进日志。魔搭访问令牌的裸值形态
* （`ms-` + UUID）与 `sk-` 推理键、Bearer/Basic 头、常见密钥键值对都在闸内。
*/
function redactSecrets(text) {
	return (typeof text === "string" ? text : "").replace(/(["']?[Aa]uthorization["']?\s*[:=]\s*["']?)(?!Bearer\s)[^"',;\s]+/g, "$1[REDACTED]").replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]").replace(/\bms-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "ms-[REDACTED]").replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-[REDACTED]").replace(/(["']?(?:password|access_token|refresh_token|api[_-]?key|token)["']?\s*:\s*["'])[^"']+(?=["'])/gi, "$1[REDACTED]").replace(/\b(password|access_token|refresh_token|api[_-]?key|token)\s*=\s*[^&;\s]+/gi, "$1=[REDACTED]");
}
/**
* 吞掉失败但留下痕迹。opt-in 模块按设计降级，但降级的理由必须落日志
* （warn 而非 debug——debug 在默认 Host 上被滤掉等于零日志）。错误消息先
* 脱敏。返回 fallback，两种静默 catch 形态都能用。
*/
function degrade(reason, error, logger, fallback) {
	const detail = error == null ? "" : redactSecrets(errMsg(error));
	logger?.warn?.(detail === "" ? `degraded: ${reason}` : `degraded: ${reason}: ${detail}`);
	return fallback;
}
/**
* Await 一个 OPTIONAL 的 store 调用：值缺失与 promise 拒绝都读作 fallback。
* 注意守卫要套在**值**上而不是调用结果上（见 sensenova util.ts 的 PITFALLS §33）。
*/
function optional(value, fallback = null) {
	return Promise.resolve(value).catch(() => fallback);
}
/** 带 code 的 Error：本插件所有失败的唯一构造点。 */
function pluginError(code, message, extra = {}) {
	const error = new Error(message);
	error.code = code;
	if (extra.retryAfterMs !== void 0) error.retryAfterMs = extra.retryAfterMs;
	if (extra.detail !== void 0) error.detail = extra.detail;
	return error;
}

//#endregion
//#region src/host/llm-models.ts
/**
* 目录条目 → pi-ai model descriptor 的映射层——魔搭 provider 注册的**纯函数半边**。
*
* 本模块刻意不 import 任何 Host peer（`@earendil-works/pi-ai`、
* `@deepseek-ai/dsh-llm-pi-ai`）：它只产普通对象，所以这些映射决策可以在一个
* 干净的 checkout 上离线测。peer 依赖的另一半（把这些 descriptor 交给
* `createProvider`）在 `llm-adapter.ts`。
*
* 这里携带的三条决策是承重的，不是装饰：
*
* 1. `compat.supportsDeveloperRole: false`。pi-ai 在缺省时会**自动探测**这个
*    标志，对非标准 provider 一律猜 `true`，于是每条请求都用 `developer`
*    角色——魔搭这个多模型代理不认识，会 400 或 403。qoder 路由证明必须
*    显式写 false。
* 2. `maxTokens` 只在目录**声明了**上限时声明。harness 对未声明的 maxTokens
*    用 `defaultMaxTokens ?? 32768` 兜底，所以「不声明」不是「没有上限」，而是
*    「平台没说」的诚实处理；别猜数字填。
* 3. `reasoning: false` + **不设** `thinkingLevelMap`。魔搭 API-Inference 是
*    多模型代理，是否吃 `reasoning_effort` 取决于背后那个具体模型，本插件
*    无法离线得知每个 id 的档位表（sensenova 那份是拿真令牌逐模型探测 200/400
*    才钉出来的）。「宁可不选，不可错发」：发错档位会整条请求 400，比不发
*    差得多。M4 之后的迭代（探测出档位表）再按模型开启。
*
* @module dsh-connect-modelscope-token-plan/llm-models
*/
/**
* 本插件注册 provider 用的 id。
*
* **绝不能**是裸 `"modelscope"`：操作者可能已手写一条 `llm-pi-ai`
* （apiKeyEnv `MODELSCOPE_API_KEY`、base `https://api-inference.modelscope.cn/v1`），
* `registerAdapter` 对冲突 id 直接拒绝。自有 slug 形 id 不会撞。
*/
const LLM_PROVIDER_ID = "modelscope-token-plan";
/** DSH 模型选择器里显示的 provider 名。 */
const LLM_DISPLAY_NAME = "ModelScope Token Plan";
/** pi-ai 展示的凭据名（静态令牌，形如 `ms-…`）。 */
const LLM_API_KEY_NAME = "ModelScope token";
/**
* 代表「什么都不提供」的 id。
*
* 空的允许清单已经表示「不过滤」，所以还得有第二种写法表示「过滤结果为空」：
* 一个永远不可能成为真实模型 id 的字符串，作为清单里唯一的项。`filterByEnabled`
* 按一个匹配不到任何东西的 id 过滤，这就是用户要的 offer。裸 `[]` 不能同时表示
* 「全部模型」与「没有模型」。
*
* provider 路由与快照用同一个字面量（浏览器 bundle 无法 import 本模块，所以
* `client.js` 里还有一份）——两侧改名必须一起改，否则面板的「全部隐藏」会
* 静默变成「全部提供」。
*/
const HIDE_ALL_MODELS = "__hide_all__";
/**
* 每 token 单价对额度制路由不可知，四处一律报零。
*
* ⚠️ 零是**哨兵**，不是「免费」。魔搭 Token Plan 是次数/额度池计费，按 token
* 的美元单价在这条路上根本不存在——但模型照样烧额度。面板行显示 "$0.00" 说的是
* 「按 token 单价未知」，永远不是「这模型不花钱」。注释就贴在这组值旁边，免得
* 后来人「好心」改成真价，或更糟改成 `null`（pi-ai 会把它当未知成本行渲染，
* 弄坏选择器的成本算术）。
*/
const NO_COST = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
});
/**
* 目录没声明可用窗口时的兜底窗口。
*
* pi-ai 的 options 构建器会对 `model.contextWindow` 做算术，所以 undefined 被
* 当 0 算而不是「未知」，会把 max-token 计算算坏；qoder 路由因此总是给正数。
* 128k 是保守的通用默认；目录真的声明了窗口时，那个值永远赢。
*/
const FALLBACK_CONTEXT_WINDOW = 128e3;
/** 判 vision 时优先读的结构化模态字段（平台拼写 + 常见别称）。 */
const INPUT_MODALITY_KEYS = Object.freeze([
	"input_modalities",
	"modalities",
	"inputTypes",
	"modality",
	"capabilities"
]);
/**
* 无结构化字段时的名字启发。
*
* 多模态模型名里 `vl` 很常见，这条启发是社区惯例。漏判 = 模型收图时报
* `UNSUPPORTED_CONTENT`，面板能看见，不算静默失败（所以方向偏「松」）。
*/
const VISION_NAME_PATTERN = /(vl|vision|qwen2?\.?\d*-?vl|glm.*v|internvl|llava|pixtral)/i;
/**
* 明确是图像**生成**模型的 id/名字才排除。
*
* 魔搭目录里这些是纯生图模型，打 `/chat/completions` 会 404。没标注的一律算
* chat——缺失字段不等于不能用。
*/
const IMAGE_GEN_NAME_PATTERN = /(wanx|qwen-image|cogview|flux|stable-diffusion|sdxl|sd3|txt2img|text-to-image|draw|seedream|kolors|hunyuan-?image|imagen)/i;
/**
* 把原始 `/v1/models` data 条目变成归一目录条目。
*
* 只做投影与回退，不做判断：`id` 必取，`name` 回退 id，`vision`/`contextWindow`/
* `maxOutputLength` 由下面的判断函数产出。`raw` 保留整条原始对象，且原始字段
* 一并展开在条目上，所以 `context_length` 这类字段下游仍能直读——平台新增字段
* 不需要改解析器。
* @param {unknown} raw - `/v1/models` `data[]` 里的一条。
* @returns {CatalogEntry} 归一后的条目。
*/
function normalizeEntry(raw) {
	const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const id = str(source.id, "");
	return {
		...source,
		id,
		name: str(source.name, id),
		vision: isVisionModel(source),
		contextWindow: contextWindowOf(source),
		maxOutputLength: maxOutputLengthOf(source),
		raw: source
	};
}
/**
* 读一条目录条目首个模态字段，取不到返回 undefined。
*
* 魔搭 `/v1/models` 是否声明 `input_modalities` 需真机核实；这里把平台拼写与
* 常见别称一并列出，字符串/数组都能吃，平台换拼写不用改解析器。
* @param {Record<string, unknown>} source - 一条目录条目。
* @returns {string[]|undefined} 模态名列表，取不到为 undefined。
*/
function inputModalitiesOf(source) {
	for (const key of INPUT_MODALITY_KEYS) {
		const value = source[key];
		if (Array.isArray(value)) return value.map((modality) => String(modality));
		if (typeof value === "string" && value !== "") return value.split(/[,|]/).map((modality) => modality.trim()).filter((m) => m !== "");
	}
}
/**
* 一条目录条目能否吃图（vision）。
*
* 优先读结构化字段 `input_modalities`/`modalities`（含 `image`/`vision` 即真）；
* 无结构化字段时回退名字启发（`VISION_NAME_PATTERN`）。多模态模型名里 `vl` 很
* 常见，这条启发是社区惯例；漏判 = 模型收图时报 `UNSUPPORTED_CONTENT`，面板能
* 看见，不算静默失败。
* @param {object} entry - 一条归一目录条目。
* @returns {boolean} 是否吃图。
*/
function isVisionModel(entry) {
	const modalities = inputModalitiesOf(entry ?? {});
	if (modalities !== void 0) return modalities.some((modality) => /image|vision/i.test(modality));
	const idOrName = `${str(entry?.id, "")} ${str(entry?.name, "")}`;
	return VISION_NAME_PATTERN.test(idOrName);
}
/**
* 一条目录条目能否作为 chat 模型寻址。
*
* **宽松方向**。只有明确是图像**生成**模型的 id/名字（`IMAGE_GEN_NAME_PATTERN`）
* 或 `output_modalities` 只含 `image` 才排除：魔搭目录里这些是纯生图模型，打
* `/chat/completions` 会 404。没标注的一律算 chat——缺失字段不等于不能用。
* @param {object} entry - 一条归一目录条目。
* @returns {boolean} 是否可用作 chat 模型。
*/
function isChatModel(entry) {
	const out = (entry ?? {}).output_modalities;
	if (Array.isArray(out) && out.length > 0) {
		if (out.every((modality) => String(modality).toLowerCase() === "image")) return false;
	}
	const idOrName = `${str(entry?.id, "")} ${str(entry?.name, "")}`;
	return !IMAGE_GEN_NAME_PATTERN.test(idOrName);
}
/**
* 读目录声明的上下文窗口，取不到用兜底。
*
* 命中一个正数就用；否则 `FALLBACK_CONTEXT_WINDOW`——pi-ai 对 undefined 的
* contextWindow 当 0 算，会坏掉 max-token 计算。与 `contextWindowOf` 同一份
* 拼写策略：只认已知拼写，缺字段回退，不猜数字。
* @param {object} entry - 一条归一目录条目。
* @returns {number} 声明的窗口，或兜底值。
*/
function contextWindowOf(entry) {
	for (const key of [
		"context_length",
		"context_window",
		"contextWindow",
		"max_context_tokens"
	]) {
		const value = Math.floor(num(entry?.[key], 0));
		if (value > 0) return value;
	}
	return FALLBACK_CONTEXT_WINDOW;
}
/**
* 读目录声明的单次输出上限，0 = 未声明。
*
* 这个数**只用于展示/投影**。descriptor 只在 >0 时声明 `maxTokens`（见模块头注
* 第 2 条），所以它从不变成请求参数——它说的是平台至多能吐多少，让用户明白为什么
* 长回答仍会以 `finish_reason: length` 停住。
* @param {object} entry - 一条归一目录条目。
* @returns {number} 声明的上限，未声明为 0。
*/
function maxOutputLengthOf(entry) {
	for (const key of [
		"max_output_length",
		"maxOutputLength",
		"max_output_tokens"
	]) {
		const value = Math.floor(num(entry?.[key], 0));
		if (value > 0) return value;
	}
	return 0;
}
/**
* 把一条目录条目映射成适配器交给 pi-ai 的 model descriptor。
*
* vision 用的是与快照/roster 完全相同的判定（`isVisionModel`），所以模型选择器
* 不可能与面板的 vision 清单就「哪些模型能吃图」意见相反。
* @param {object} entry - 一条归一目录条目（必须带 `id`）。
* @param {object} [options] - 装配参数。
* @param {string} [options.providerId] - 该 descriptor 所属的 provider id。
* @param {string} [options.baseUrl] - OpenAI 兼容源站。
* @returns {object} pi-ai descriptor。
*/
function toPiDescriptor(entry, options = {}) {
	const { providerId = LLM_PROVIDER_ID, baseUrl } = options;
	const id = str(entry?.id, "");
	if (id === "") throw new Error("toPiDescriptor: catalog entry has no id");
	const vision = isVisionModel(entry);
	const maxOutputLength = maxOutputLengthOf(entry);
	return {
		id,
		name: str(entry.name, id),
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: vision ? ["text", "image"] : ["text"],
		reasoning: false,
		cost: { ...NO_COST },
		contextWindow: contextWindowOf(entry),
		...maxOutputLength > 0 ? { maxTokens: maxOutputLength } : {},
		compat: {
			maxTokensField: "max_tokens",
			supportsDeveloperRole: false
		}
	};
}
/**
* 把目录缩到用户允许的模型子集。
*
* **空清单 = 不过滤**：新装没做过选择，仍应提供全部模型。一旦非空就是严格白
* 名单；名单里点名了本目录没有的 id 也无害——它只是匹配不到东西。
*
* `HIDE_ALL_MODELS` 哨兵靠「匹配不到任何真实 id」表达「什么都不提供」，因为空
* 清单已经被「不过滤」占用了。
* @param {object[]} entries - 归一目录条目。
* @param {string[]} [enabledIds] - 允许清单；空/缺省关闭过滤。
* @returns {object[]} 仍被提供的条目，按目录顺序。
*/
function filterByEnabled(entries, enabledIds) {
	const list = Array.isArray(enabledIds) ? enabledIds : [];
	if (list.length === 0) return Array.isArray(entries) ? entries : [];
	const allow = new Set(list.map((id) => str(id, "")));
	return (Array.isArray(entries) ? entries : []).filter((entry) => allow.has(str(entry?.id, "")));
}
/**
* 为一份目录构建整份 descriptor 列表。
*
* 没有 id 的条目丢弃（线上没法寻址），重复 id 保留末次出现，与 `rosterOf` 的
* 去重一致。`unavailableModelIds` 里的（额度耗尽的）模型丢弃——面板经
* `rosterWithAvailability` 仍显示它们，灰显加原因，但 picker 不提供注定 429 的
* 请求；两处口径不同是故意的，别统一。
* @param {object[]} entries - 归一目录条目。
* @param {object} options - `{ providerId, baseUrl, enabledIds, unavailableModelIds }`。
* @returns {object[]} pi-ai descriptor，按首见顺序。
*/
function buildDescriptors(entries, options = {}) {
	const { providerId = LLM_PROVIDER_ID, baseUrl, enabledIds = [], unavailableModelIds = [] } = options;
	const filtered = filterByEnabled(entries, enabledIds).filter((entry) => isChatModel(entry));
	const blocked = new Set(Array.isArray(unavailableModelIds) ? unavailableModelIds : []);
	const seen = /* @__PURE__ */ new Map();
	const out = [];
	for (const entry of Array.isArray(filtered) ? filtered : []) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const catalogEntry = entry;
		const id = str(catalogEntry.id, "");
		if (id === "") continue;
		if (blocked.has(id)) continue;
		if (!seen.has(id)) {
			seen.set(id, out.length);
			out.push(void 0);
		}
		out[seen.get(id)] = toPiDescriptor({
			...catalogEntry,
			id
		}, {
			providerId,
			...baseUrl !== void 0 ? { baseUrl } : {}
		});
	}
	return out;
}
/**
* 带额度可用性的面板 roster。
*
* 与 {@link rosterOf} 一样每 chat 模型 id 一行，但每行还带该模型额度池是否耗尽。
* 与 **picker**（`buildDescriptors` 直接丢弃耗尽模型，避免发注定 429 的请求）不同，
* 面板保留它们在清单里、灰显，让用户看得见「为什么模型从选择器里不见了」。
* @param {object[]} entries - 归一目录条目。
* @param {string[]} unavailableIds - 额度耗尽的模型 id；空数组 = 全部可用。
* @returns {{id: string, name: string, vision: boolean, available: boolean, quotaExhausted: boolean, contextWindow: number, maxOutputLength: number}[]}
*/
function rosterWithAvailability(entries, unavailableIds) {
	const blocked = new Set(Array.isArray(unavailableIds) ? unavailableIds : []);
	const position = /* @__PURE__ */ new Map();
	const out = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!isChatModel(entry)) continue;
		const id = str(entry?.id, "");
		if (id === "") continue;
		const row = {
			id,
			name: str(entry?.name, id),
			vision: isVisionModel(entry),
			available: !blocked.has(id),
			quotaExhausted: blocked.has(id),
			contextWindow: contextWindowOf(entry),
			maxOutputLength: maxOutputLengthOf(entry)
		};
		if (position.has(id)) out[position.get(id)] = row;
		else {
			position.set(id, out.length);
			out.push(row);
		}
	}
	return out;
}

//#endregion
//#region src/host/host-config.ts
/**
* 配置契约与 Host 信任围栏（与姊妹插件同构；auth 覆盖块不存在——魔搭只有
* 一把静态令牌，没有可配置的登录流）。
*
* `CONFIG_DEFAULTS` 与 `cordis.patch.yml` 由 test/config.test.mjs 双向钉住，
* 代码与文档不会静默漂移。
* @module dsh-connect-modelscope-token-plan/host-config
*/
/**
* 本插件所有可寻址面的唯一 slug：/api 路由前缀、状态目录名、凭据记录命名
* 空间都从它派生。改名必须连着用户已存的数据一起搬，不是改文本。
* test/config.test.mjs 钉住 package.json#name 与 patch 行的 id/name 字面量。
*/
const name = "dsh-connect-modelscope-token-plan";
/** Cordis 硬依赖：没有 webServer 本插件保持不活动。 */
const inject = ["webServer"];
/**
* 快照里的插件版本。单一来源本可以是 package.json，但 lib 打包把它内联进
* 产物反而引入第二份真源；这里用常量、由 test/config.test.mjs 钉住与
* package.json 一致。
*/
const PLUGIN_VERSION = "0.1.0";
/**
* 额度常数的漂移史只进配置不进代码（README「三条事实」）：官方调整时改
* patch 行即可，改完重装/重载生效。默认值是 2026-10 的社区快照
* （约 2000/天、单模型约 500/天），非官方数据。
*/
const CONFIG_DEFAULTS = Object.freeze({
	/** OpenAI 兼容推理源站（模型目录 + probe）。 */
	apiBase: "https://api-inference.modelscope.cn/v1",
	/** 站点源站，只用于面板外链（访问令牌页 / 文档）。 */
	siteBase: "https://modelscope.cn",
	/** 每日调用额度常数（次数口径，社区快照；面板已不展示，M4 阈值提醒预留）。 */
	dailyQuotaTotal: 2e3,
	/** 单模型每日上限常数（次数口径，同上）。 */
	dailyQuotaPerModel: 500,
	/** 本地趋势保留天数（usage-store 天桶数量；超出即修剪）。 */
	trendDays: 14,
	/** Host 侧对 /v1/models 的缓存秒数。 */
	cacheSeconds: 60,
	/** 面板轮询间隔——由 Host 下发、面板跟随，两端不各自假设。 */
	pollSeconds: 30,
	/** 单次魔搭请求超时（毫秒）。 */
	inferenceTimeoutMs: 3e4,
	/** 事件流保留条数（429/错误事件的环形上限）。 */
	maxEvents: 50,
	/** provider 注册占位（v0.1 未实现，字段先钉住形状）。 */
	registerProvider: false,
	/** Host 应答的默认主机名；操作者的列表是「只增不替」。 */
	admittedHosts: [
		"localhost",
		"127.0.0.1",
		"[::1]",
		"::1"
	]
});
/** 把原始数值夹到有效整数（floor → 下限 → 上限；非正/非有限回退 def）。 */
function clampInt(raw, def, min, max = Infinity) {
	return Math.min(max, Math.max(min, Math.floor(num(raw, def))));
}
/**
* 端点必须是合法的 http(s) 绝对地址；不是就在**挂载时**抛（resolveSettings
* 捕获后转成 configError 经快照呈现），而不是等到第一次轮询才变成莫名其妙的
* 网络失败。
*/
function assertHttpUrl(value, field) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`${field} is not an absolute URL: ${JSON.stringify(value)}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${field} must be an http(s) URL, got ${parsed.protocol}`);
}
/**
* 把 patch 行的原始配置解析成有效设置。
*
* 坏行不许从这里抛出去——apply 在挂载期跑，抛错等于整机插件消失。问题以
* `configError` 返回，经快照路由呈现为一个能自我解释的面板。
*/
function resolveSettings(config) {
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
				inferenceTimeoutMs: clampInt(source.inferenceTimeoutMs, CONFIG_DEFAULTS.inferenceTimeoutMs, 1e3),
				maxEvents: clampInt(source.maxEvents, CONFIG_DEFAULTS.maxEvents, 1, 1e3),
				registerProvider: source.registerProvider === true,
				allowedHosts: resolveAllowedHosts(source)
			},
			configError: null
		};
	} catch (error) {
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
function resolveAllowedHosts(source) {
	const admitted = new Set(CONFIG_DEFAULTS.admittedHosts);
	const extra = Array.isArray(source.allowedHosts) ? source.allowedHosts : [];
	for (const entry of extra) {
		const name = str(entry, "").trim().toLowerCase();
		if (name !== "") admitted.add(name);
	}
	return admitted;
}
/** 从 Host 头里剥端口；IPv6 字面量保留方括号。 */
function hostName(host) {
	if (host.startsWith("[") && host.includes("]")) return host.slice(0, host.indexOf("]") + 1);
	const colons = host.split(":");
	if (colons.length > 2) {
		const penultimate = colons[colons.length - 2] ?? "";
		const last = colons[colons.length - 1] ?? "";
		if (/^\d+$/.test(penultimate) && /^\d+$/.test(last)) return host.slice(0, host.lastIndexOf(":"));
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
function isAdmitted(request, allowedHosts) {
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

//#endregion
export { pluginError as _, resolveSettings as a, verbatim as b, LLM_DISPLAY_NAME as c, normalizeEntry as d, rosterWithAvailability as f, optional as g, obj as h, name as i, LLM_PROVIDER_ID as l, errMsg as m, inject as n, HIDE_ALL_MODELS as o, degrade as p, isAdmitted as r, LLM_API_KEY_NAME as s, PLUGIN_VERSION as t, buildDescriptors as u, redactSecrets as v, str as y };