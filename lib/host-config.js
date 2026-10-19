//#region src/host/util.ts
/** 读一个有限的正数，否则回退值（调用方一律传 number 回退，返回值不再 any）。 */
function num(value, fallback = 0) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
/** 读一个非空字符串，否则回退值（调用方一律传 string 回退，返回值收窄为 string）。 */
function str(value, fallback = "") {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}
/** 读一个普通对象，否则 `{}`（返回值给具体形状：点号访问合法、赋值不再绕过检查）。 */
function obj(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
/** catch 点统一的一行错误消息。 */
function errMsg(value) {
	return value instanceof Error ? value.message : String(value);
}
/** 原样读字符串（凭据专用：trim 是用户看不见的改动）。 */
function verbatim(value, fallback = "") {
	return typeof value === "string" ? value : fallback;
}
/**
* 凭据形状字符串的脱敏闸：任何可能进日志/错误消息/面板响应的文本都先过这里。
* 家规（AGENTS.md 红线 1）：凭据永不进日志。魔搭访问令牌的裸值形态
* （`ms-` + UUID）与 `sk-` 推理键、Bearer/Basic 头、常见密钥键值对都在闸内。
*/
function redactSecrets(text) {
	return (typeof text === "string" ? text : "").replace(/(["']?[Aa]uthorization["']?\s*[:=]\s*["']?)(?!Bearer\s)[^"',;\s]+/g, "$1[REDACTED]").replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]").replace(/\bms-[0-9a-f-]{16,}\b/gi, "ms-[REDACTED]").replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-[REDACTED]").replace(/(["']?(?:password|access_token|refresh_token|api[_-]?key|token)["']?\s*:\s*["'])[^"']+(?=["'])/gi, "$1[REDACTED]").replace(/\b(password|access_token|refresh_token|api[_-]?key|token)\s*=\s*[^&;\s]+/gi, "$1=[REDACTED]");
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
* 注意守卫要套在**值**上（`Promise.resolve(value).catch(...)`）而不是调用结果上
* ——`try { await value } catch` 漏掉「value 本身是 undefined」这条。
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
//#region src/host/llm-error-fix.ts
/**
* 429 误判纠正层 —— host 侧对 peer 分类器的安全覆盖。
*
* 根因（对照 peer 源码 `@deepseek-ai/dsh-llm-pi-ai` 的 `classifyPiAiError`
* 与 `@deepseek-ai/dsh-llm` 的 `isQuotaExceededError`，二者均为**非行号锚**
* 的稳定符号。**注意：peer 的判定顺序与措辞命中面目前没有任何测试钉死**——验证
* 它需要运行时 peer，而 peer 未 vendored 进本仓库，所以进不了 `npm test` 离线
* 门禁（见 docs/ROADMAP.md 的 Backlog）。本模块自身的纠正判定由
* `test/error-fix.test.mjs` 钉死；那只能证明「给定这样的 peer 行为，我们的纠正
* 是对的」，证明不了 peer 的行为本身没有漂移）：
*   `classifyPiAiError` **先**跑 `isQuotaExceededError`（命中面极宽：`out of
*   ... budget`、`balance/credits exhausted` 等），**后**才跑纯限频分支
*   （`\b429\b|rate.?limit`）。凡是魔搭 429 体里带上一两个 “budget/credits/
*   limit” 字眼，就被前一行抢判成 `QUOTA`；于是 `llm-retry.ts` 的
*   `retryableCodes()`（刻意排除 QUOTA）对这类 429 不重试，面板又把模型按
*   `exhaustedModelIds` 静默下线，对用户呈现“额度耗尽”。
*
* 本模块在 host 侧把“看似限频却被误判为 QUOTA 的 429”纠正回 `RATE_LIMIT`，
* 让退避重试真正生效；真配额耗尽（明确余额/积分耗尽的硬额度措辞）保留
* `QUOTA`（那是共享 Token Plan 池的硬耗尽，重试只会延长冷却窗口，见
* ROADMAP §1 纪律）。
*
* 设计约束（对应 AGENTS.md 红线与并行纪律）：
*   - 不动 vendor peer：peer 不在此插件 git 内，也不可被改。
*   - 零 peer 依赖：纯函数 + 稳定协议字符串；peer 缺席（干净 checkout）时
*     模块仍加载、测试仍跑，不破坏 `npm test` 离线门禁。
*   - 只重写 `finish` chunk 的 `failure.code`，保留原始 `message` 以便排查，
*     不触碰任何正常数据流，幂等（已是 RATE_LIMIT / 非 QUOTA 原样放行）。
*
* 阅读顺序：本文件自上而下是「判据词表 → 两个纯判据 → 决策组合 → 流出口
* 改写」。对外契约在底部（`reclassifyStream` / `reclassifyFinish`），想找它
* 依赖了哪些判据，就从底部逆着依赖链往上读。
*
* @module dsh-connect-modelscope-token-plan/llm-error-fix
*/
/**
* 与 peer 协议对齐的失败类（稳定字符串，不 import peer 也成立）。
* `QUOTA` 来自 `@deepseek-ai/dsh-llm` 的 `QUOTA_EXCEEDED_CODE`，`RATE_LIMIT`
* 来自 peer `classifyPiAiError` 的返回字面量。
*/
const CODE = Object.freeze({
	/** 共享 Token Plan 池耗尽（peer 不重试，本层默认也不纠正）。 */
	QUOTA: "QUOTA",
	/**
	* 账户级配额耗尽。peer 的 `classifyPiAiError` 目前不产生此类（它只返回
	* `QUOTA_EXCEEDED_CODE`），列在此处纯为协议对齐与防御；本层不纠正它。
	*/
	ACCOUNT_QUOTA: "ACCOUNT_QUOTA",
	/** 瞬时限频：本层把误判体拉回这里，由本 provider 自己的显式 retryPolicy 退避重试。 */
	RATE_LIMIT: "RATE_LIMIT"
});
/** 纯文本层面的限频信号（v1 启发用）。 */
const RATE_SIGNAL = [
	/\b429\b/,
	/rate[_\s-]?limit/i,
	/too many requests?/i,
	/requests?\s+(?:per|rate|freq)/i,
	/\b(?:rpm|tpm)\b/,
	/throttl/i,
	/请求过于频繁|限流|频率/
];
/**
* 硬额度措辞：命中即相信是配额耗尽，不纠正（避免把真耗尽也拉去重试）。
*
* 最后两条是被 `codes.ts#classifyRateLimit` 的回归用例逼出来的：那张表的旧词表
* 里有 `"daily"`，而这里没有，于是 `"You have reached your daily limit"`（真日额度
* 耗尽）被共用后的新判据读成限频。两处现在共用这一份，缺口不会再各漂各的。
*/
const HARD_QUOTA_WORDING = [
	/\b(?:balance|credits?)\s+(?:exhausted|depleted)\b/i,
	/\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i,
	/额度\s*(?:已)?\s*(?:用尽|耗尽|不足)/,
	/quota\s*(?:exceeded|exhausted|reached)/i,
	/\b(?:daily|per[\s_-]?day|monthly|per[\s_-]?month)\b[^\n]{0,24}?\blimit\b/i,
	/(?:每日|每月)\s*(?:调用)?\s*(?:上限|额度|配额)/
];
/** 结构化 type 分支认的「速率上限」信号：rpm/tpm/每分钟/限流/频率。 */
const RATE_CAP_WORDING = /\brpm\b|\btpm\b|rate[_\s-]?limit|per[\s_-]?(?:min|minute|sec|second)|too many|限流|频率|请求过于频繁/i;
/** 从错误文本里回捞魔搭结构化 `type` 字段（如 `"type":"quota_exceeded_error"`）。 */
const STRUCTURED_TYPE = /"type"\s*:\s*"([^"]+)"/i;
/**
* 文本是否含硬额度措辞（真耗尽，不纠正）。
*
* 导出给 `codes.ts` 的 `classifyRateLimit`——那张表曾自己维护一份同组正则，
* 于是「限频被误判成耗尽」和「耗尽被误判成限频」两个方向的漂移都可能发生。
* 词表只有这一份，改它时 `test/error-fix.test.mjs` 与 `test/provider.test.mjs`
* 会一起红。
* @param message - 平台错误文本。
* @returns `true` 表示命中硬额度措辞。
*/
function hasHardQuotaWordingIn(message) {
	if (typeof message !== "string" || message.length === 0) return false;
	return HARD_QUOTA_WORDING.some((re) => re.test(message));
}
/**
* 一个 429 体是否“更可能是限频而非真配额耗尽”——纯文本启发（v1）。
*
* 判据：消息里出现显式限频信号（{@link RATE_SIGNAL} 任一），且**没有**命中
* 硬额度措辞（{@link HARD_QUOTA_WORDING}）。
*
* 关键区分：“out of **rate** budget” / “rate limit budget” 是限频体，不在硬
* 额度措辞里，所以仍判为限频——这正是误判的核心。
* @param {string} message - 平台错误文本（可能含状态码与 JSON）。
* @returns {boolean} true 表示应纠正为 RATE_LIMIT。
*/
function looksLikeRateLimit(message) {
	if (typeof message !== "string" || message.length === 0) return false;
	const m = message.toLowerCase();
	if (!RATE_SIGNAL.some((re) => re.test(m))) return false;
	return !hasHardQuotaWordingIn(message);
}
/**
* 从错误文本里抽出魔搭结构化 `type` 字段。
*
* peer 把整条错误 JSON 拼进 `failure.message`，所以这里能从文本回捞结构信
* 号，而不依赖 peer 是否单独透传了 `type`。抓不到返回 null。
* @param {string} message
* @returns {string|null}
*/
function extractStructuredType(message) {
	if (typeof message !== "string" || message.length === 0) return null;
	const match = STRUCTURED_TYPE.exec(message);
	return match ? match[1] ?? null : null;
}
/**
* 一个被 peer 判为 QUOTA 的失败，按哪条判据路径处理——429 重分类的**可观测
* 理由**。纯函数，复用同一批判据（模块私有的 {@link RATE_SIGNAL} /
* {@link RATE_CAP_WORDING}、{@link hasHardQuotaWordingIn}、结构化 type），不
* 引入第二份词表；返回稳定短串（非自由文本），供面板/日志/测试引用“为什么
* 这么判”。
*
* 这是修正 v1（纯文本启发）漏判的核心：`{"message":"rpm exhausted",
* "type":"quota_exceeded_error","code":"8"}` 这种体——魔搭把**请求速率上限**
* 复用 `quota_exceeded_error` 这个名字，纯文本里没有 rate limit 字样，v1 的
* `looksLikeRateLimit` 既没命中限频信号也没命中硬额度，于是留在 QUOTA、不重试、
* 直接失败。本函数改读结构化 `type` 逐层收窄，每个返回串对应一条路径：
*
*   - `"not_quota_code"`             失败为空或 code≠QUOTA，纠正层不适用。
*   - `"structured:rate_limit_type"`  结构化 type 含 rate_limit，本就是限频（防御，纠正）。
*   - `"structured:quota_rate_cap"`   结构化 type 含 quota 且命中 {@link RATE_CAP_WORDING}
*                                     （rpm/tpm/每分钟/限流…）→ 错命名，纠正。
*   - `"structured:quota_no_cap"`     结构化 type 含 quota 且无速率信号（token/credit/
*                                     balance 真耗尽）→ 保留 QUOTA。
*   - `"structured:other_type"`       结构化 type 是其它非 quota 值 → 保守不纠正。
*   - `"text:rate_signal"`            无结构化 type，纯文本命中 {@link RATE_SIGNAL} 且
*                                     无硬额度字样 → 纠正。
*   - `"text:hard_quota"`             无结构化 type，命中硬额度字样 → 保留 QUOTA。
*   - `"text:no_rate_signal"`         无结构化 type 也无限频信号 → 保留 QUOTA。
*
* 不纠正真配额耗尽：那是共享 Token Plan 池的硬耗尽，重试只会延长冷却窗口
* （ROADMAP §1 纪律），所以宁可快失败。
* @param {{code?: string, message?: string}} failure
* @returns {string} 标记处理路径的稳定短串。
*/
function reclassifyReason(failure) {
	if (!failure || failure.code !== CODE.QUOTA) return "not_quota_code";
	const message = typeof failure.message === "string" ? failure.message : "";
	const type = extractStructuredType(message);
	if (type !== null) {
		const t = type.toLowerCase();
		if (/rate[_\s-]?limit/.test(t)) return "structured:rate_limit_type";
		if (/quota/.test(t)) return RATE_CAP_WORDING.test(message) ? "structured:quota_rate_cap" : "structured:quota_no_cap";
		return "structured:other_type";
	}
	if (!RATE_SIGNAL.some((re) => re.test(message.toLowerCase()))) return "text:no_rate_signal";
	return hasHardQuotaWordingIn(message) ? "text:hard_quota" : "text:rate_signal";
}
/** 判为「应纠正为 RATE_LIMIT」的理由集合——{@link shouldReclassifyQuotaToRate} 的唯一真源。 */
const RECLASSIFY_TRUE_REASONS = /* @__PURE__ */ new Set([
	"structured:rate_limit_type",
	"structured:quota_rate_cap",
	"text:rate_signal"
]);
/**
* 一个被 peer 判为 QUOTA 的失败，是否其实是限频、应纠正为 RATE_LIMIT。
* 布尔判定单一真源：读 {@link reclassifyReason} 是否落在「应纠正」集合里，分支
* 逻辑不再写第二遍；可观测“为什么这么判”见 {@link reclassifyReason} 的返回串。
* @param {{code?: string, message?: string}} failure
* @returns {boolean} true 表示应纠正为 RATE_LIMIT。
*/
function shouldReclassifyQuotaToRate(failure) {
	return RECLASSIFY_TRUE_REASONS.has(reclassifyReason(failure));
}
/**
* 把单个流 chunk 里的失败码在误判时纠正。
*
* 非 finish、非 error 终止、非 QUOTA，或已判为限频的，一律原样返回（新对象
* 仅在确有纠正时创建，保持调用方对引用相等的预期）。
* @param {object} chunk - harness 流协议 chunk。
* @returns {object} 原 chunk 或 code 被纠正后的新 chunk。
*/
function reclassifyFinish(chunk) {
	if (!isErrorFinish(chunk)) return chunk;
	const errorChunk = chunk;
	const reason = errorChunk.reason;
	const failure = reason?.failure;
	if (failure === void 0 || !shouldReclassifyQuotaToRate(failure)) return chunk;
	return {
		...errorChunk,
		reason: {
			...reason,
			failure: {
				...failure,
				code: CODE.RATE_LIMIT
			}
		}
	};
}
/** 是否为「带 failure 的 error 型 finish chunk」——纠正层唯一关心的形状。 */
function isErrorFinish(chunk) {
	if (chunk === null || typeof chunk !== "object") return false;
	const candidate = chunk;
	return candidate.type === "finish" && candidate.reason !== null && typeof candidate.reason === "object" && candidate.reason.kind === "error" && candidate.reason.failure != null;
}
/**
* 包裹一个 adapter 的 async iterator 流：对每个 finish chunk 做重判。
* @param {AsyncIterableIterator<object>} source - 内层 adapter 的流。
* @returns {AsyncGenerator<object>} 纠正后的流。
*/
async function* reclassifyStream(source) {
	for await (const chunk of source) yield reclassifyFinish(chunk);
}

//#endregion
//#region src/shared/wire.ts
/**
* 代表「什么都不提供」的哨兵 id——`ProviderStatus.enabledIds` 线编码的一部分。
*
* 空的允许清单已经表示「不过滤（全部提供）」，所以「全部隐藏」只能走这个哨兵：
* 一个永远不可能成为真实模型 id 的字符串，作为清单里唯一的项。裸 `[]` 不能同时
* 表示「全部模型」与「没有模型」。两侧（Host 的 `llm-models.ts` 与 Client 的
* `const.ts`）都从本模块再导出——它曾经是两边各写一份的字面量，拼错一处就是
* 「点隐藏反而全放出来」。
*/
const HIDE_ALL_MODELS = "__hide_all__";
/**
* 钉死清单：任何新增顶层字段都必须先过 test/wire.test.mjs。
*
* **可选块不得进这份清单**——这不是排版洁癖，是 53c9902 的修复曾经被它架空的
* 事故的结论：`provider` 改成可选（Host 软失败时省略）之后仍留在这里，于是客户端
* 把「Host 按契约省略」当成契约破裂，先把 `DEGRADED_PROVIDER` 补进 body，再据此
* 判定「块在」，**兜底 `GET /provider` 一次都没跑**，还给用户挂一条假的漂移警告。
* `draw` 先可选、也先移出清单，所以它没有这个问题——两个块走同一条纪律，清单里
* 就必须同样缺席。
*
* 判据：`Snapshot` 接口里带 `?` 的顶层字段，这里**必须**没有。
* test/wire.test.mjs 机械解析该接口做三向交叉：必给字段集合 === 本清单、可选
* 字段 ∩ 清单 = ∅、可选字段集合 === 可选块名字清单——清单腐化或漏登记都判红。
*/
const SNAPSHOT_REQUIRED_KEYS = Object.freeze([
	"ok",
	"name",
	"version",
	"now",
	"pollSeconds",
	"cacheSeconds",
	"token",
	"balance",
	"quota",
	"events",
	"trend",
	"models",
	"shapeWarnings",
	"quotaError"
]);

//#endregion
//#region src/shared/allow-list.ts
/**
* provider 允许清单的**三态判别联合**——`enabledIds` 线编码的唯一解释者。
*
* 线格式（`shared/wire.ts` 的 `ProviderStatus.enabledIds`）是一个字符串数组，
* 用哨兵编码三态：
*
*   - `[]`                       → `all`（不过滤，提供全部模型）；
*   - `[HIDE_ALL_MODELS, ...]`   → `none`（什么都不提供；哨兵语义优先）；
*   - `[id, ...]`                → `list`（严格白名单）。
*
* 这个编码曾经在六个地方被各自解释一遍（`resolveAllowedList` / `filterByEnabled` /
* `isModelEnabled` / 快照的 `enabledCount` / 路由的 `enabledCount` / 客户端
* `saveRoster` 归一），而且解释得不完全一致——`filterByEnabled` 会把
* `[哨兵, "a/A"]` 过滤成「提供 a/A」，而 `resolveAllowedList` 同时说那是
* `none`：同一个清单，「提供什么」有两个答案。联合把六种解释塌缩成一次
* `parseAllowedList`，其余操作都是联合上的模式匹配——新增第四态或改哨兵
* 语义时， TypeScript 会把每个没跟上的 `switch` 标红。
*
* 纯函数、零依赖（只读 `wire.ts` 的哨兵字面量），双端同 import。
*
* @module dsh-connect-modelscope-token-plan/allow-list
*/
/**
* 把线编码的 `enabledIds` 解析成联合——**全插件只有这一处解释**。
*
* 判据（与旧 `resolveAllowedList` 的承诺一致，且现在 `filterByEnabled` 等
* 消费者也真的按它做）：
*   1. 非数组或空数组            → `all`（新装没做过选择，仍提供全部）；
*   2. 含哨兵（哪怕还混着别的 id）→ `none`（哨兵是独占态，优先于任何真实 id）；
*   3. 其余非空清单              → `list`（严格白名单；条目滤掉非字符串与空串、
*      去重保序——落盘前 `provider-store` 已归一遍，这里是解释不是归一）。
*
* 注意 `[""]` 这类「滤完什么都不剩」的脏清单归 `list` 且 `ids: []`：过滤
* 结果为空，与旧行为一致（它匹配不到任何真实 id）。
* @param {unknown} enabledIds - 线编码的允许清单。
* @returns {AllowedList} 联合。
*/
function parseAllowedList(enabledIds) {
	if (!Array.isArray(enabledIds) || enabledIds.length === 0) return { mode: "all" };
	if (enabledIds.includes("__hide_all__")) return { mode: "none" };
	const ids = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of enabledIds) {
		const id = typeof entry === "string" ? entry : "";
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return {
		mode: "list",
		ids
	};
}
/**
* 「已启用数」：roster 里真正会被提供的行数。
*
* 快照与 provider 路由的 `enabledCount` 共用这一份（旧实现各写一遍三元
* 链，且 `none` 分支的 0 与 `all` 分支的 roster 长度靠注释对齐）。过期 id
* 不虚增计数——roster 里没有它，就数不到它。
* @param {AllowedList} list - 联合。
* @param {readonly string[]} rosterIds - roster 各行的 id（目录序）。
* @returns {number}
*/
function enabledCountOf(list, rosterIds) {
	switch (list.mode) {
		case "all": return rosterIds.length;
		case "none": return 0;
		case "list": {
			const allow = new Set(list.ids);
			let count = 0;
			for (const id of rosterIds) if (allow.has(id)) count += 1;
			return count;
		}
	}
}

//#endregion
//#region src/host/llm-models.ts
/**
* 目录条目 → pi-ai model descriptor 的映射层——魔搭 provider 注册的**纯函数半边**。
*
* **TL;DR**：本模块只产普通对象、刻意不 import 任何 Host peer（`@earendil-works/pi-ai`、
* `@deepseek-ai/dsh-llm-pi-ai`），所以这些映射决策可以在一个干净的 checkout 上
* 离线测；peer 依赖的另一半（把 descriptor 交给 `createProvider`）在 `llm-adapter.ts`。
* 下面三条是**当前契约**，改动前请先读文末「演变记录」。
*
* 1. `compat.supportsDeveloperRole: false`——pi-ai 缺省会**自动探测**这个标志，
*    对非标准 provider 一律猜 `true`，于是每条请求都用 `developer` 角色，魔搭这个
*    多模型代理不认识，会 400 或 403。qoder 路由证明必须显式写 false。
* 2. `maxTokens` 由 `maxTokensFor` 一处决定，优先级 **`覆盖 > 目录声明 > 不声明`**：
*    目录没声明时不猜数字（harness 会用它的 `defaultMaxTokens ?? 32768` 兜底，那是
*    harness 的默认值，不是平台说的），但操作者可以在 `maxTokensOverrides` 里显式
*    填实测值。**本插件的目录（魔搭 `/v1/models`）从不返回这个字段**，所以「目录
*    说了算」在现实里等于「永远是 32768」——这条退路不是锦上添花，它是唯一出口。
*    完整回退顺序写在 `maxTokensFor` 上，此处不重复。
* 3. `reasoning: false` + **不设** `thinkingLevelMap`——魔搭 API-Inference 是
*    多模型代理，是否吃 `reasoning_effort` 取决于背后那个具体模型，本插件无法
*    离线得知每个 id 的档位表（sensenova 那份是拿真令牌逐模型探测才钉出来的）。
*
* ## 演变记录（历史，非契约）
* 关于第 3 条，真实障碍**不是**「发错档位会整条请求 400」——该理由于 2026-10-05
* 被真机证伪（`"bogus"` 同样 200，值不被校验）——而是无法区分「参数生效」与
* 「被静默忽略」（两者都 200），且该端点会在真响应与空壳 200 之间摇摆，档位表
* 做不出来。理由与实测见 PROVIDER-M4.md §4。
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
* 人工策展的「已知多模态（能吃图）模型」清单——详情端点**不可达时**的离线兜底。
*
* 为什么还需要：魔搭 `/v1/models` 实测每条只返回 `id`/`object`/`owned_by`/`created`，
* 零模态字段（不像 sensenova 有 `type` 字段可判），名字启发也会漏掉
* `DeepSeek-V4.1-Flash` 这类「名字不含 vl/vision 但能吃图」的模型。详见 `isVisionModel`：
* 首选详情端点 `Tasks[].Name` 精确判定（image-text-to-text 即真），此清单只在详情拉取
* 失败（网络 / 限频）时兜底，避免面板在离线时完全失去视觉标签。
*
* 这份清单是「我们已知」（模型卡 / 用户反馈），不是平台声明；与名字启发一样，**不假装
* 上游返回过**。真机若某模型吃图却不在清单，最坏只是收 `UNSUPPORTED_CONTENT`，不静默
* 失败。新增已确知的多模态模型时在此追加 id 即可。
*
* 已按详情端点 `Tasks[].Name == image-text-to-text` 逐条真机核实补全（2026-10-04，api-inference
* 当前 35 条目录里共 14 条吃图模型，下面就是全部）。这样即使详情端点整段拉不到，面板也能
* 保留准确的视觉标签，不用靠名字猜——`MiniMax-M3`/`Intern-S1`/`Qwen3.5-397B-A17B`/`Step-3.7-Flash`
* 这类名字不含 vl/vision 的模型，光靠 `VISION_NAME_PATTERN` 会漏。
*/
const KNOWN_VISION_IDS = Object.freeze(/* @__PURE__ */ new Set([
	"deepseek-ai/DeepSeek-V4.1-Flash",
	"Qwen/Qwen3.8-Flash-Next",
	"MiniMax/MiniMax-M3",
	"OpenGVLab/InternVL3_5-241B-A28B",
	"PaddlePaddle/ERNIE-4.5-VL-28B-A3B-PT",
	"Qwen/Qwen3.5-122B-A10B",
	"Qwen/Qwen3.5-27B",
	"Qwen/Qwen3.5-35B-A3B",
	"Qwen/Qwen3.5-397B-A17B",
	"Qwen/Qwen3.8-27B",
	"Shanghai_AI_Laboratory/Intern-S1",
	"Shanghai_AI_Laboratory/Intern-S1-mini",
	"Shanghai_AI_Laboratory/Intern-S2-Preview",
	"stepfun-ai/Step-3.7-Flash"
]));
/**
* 已知能**纯文生图**的目录内模型 id（2026-10-16 真机复核）。
*
* 为什么需要手工策展：api-inference 目录里至今**没有**平台声明的 `text-to-image`
* 条目，只有 2 条 `image-to-image`——而两者行为**不同**：
* `Qwen/Qwen-Image-Edit` 不带 `image_url` 纯文生图可用（本轮实测：提交成功、两次
* 15min 排队超时后于 9.7min 出图）；`MusePublic/Qwen-Image-Edit` 纯文生图被上游
* 直接拒绝（提交阶段 HTTP 4xx：`image_url is required for model: …`）。
* 能力枚举把两者都归为 `image-to-image`，区分不了这个差异，所以这里用实测知识兜底：
* 目录里没有 `text-to-image` 可挑时，默认偏向这个已知能用的 id，而不是「目录第一个」
* （真实目录顺序 `MusePublic/…` 在前，照旧逻辑纯文生图必挂）。
*
* 与 `KNOWN_VISION_IDS` 放在一起：所有「哪些模型能做什么」的策展知识集中一处，
* 不会漂。
*/
const KNOWN_T2I_MODEL_ID = "Qwen/Qwen-Image-Edit";
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
		capability: resolveModelCapability(source),
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
* 读一条目录条目从详情端点带来的任务标签（image-text-to-text 等）。
*
* `fetchModels` 会对每个 id 并行请求 modelscope.cn/api/v1/models/{id}，把响应的
* `Data.Tasks[].Name`（+ `widgets[].task` 兜底）收集后挂到 `entry.tasks`。取不到或
* 非数组返回 undefined，调用方据此回退策展清单 + 名字启发。
* @param {Record<string, unknown>} source - 一条目录条目。
* @returns {string[]|undefined} 任务标签列表，取不到为 undefined。
*/
function tasksOf(source) {
	const value = source.tasks;
	if (Array.isArray(value)) {
		const out = value.map((task) => String(task)).filter((task) => task !== "");
		return out.length > 0 ? out : void 0;
	}
}
/** 任务标签 → 能力。键为平台返回的小写任务名，词表见上方说明。 */
const TASK_TO_CAPABILITY = Object.freeze({
	"text-generation": "text",
	"text2text-generation": "text",
	"image-text-to-text": "vision-input",
	"visual-question-answering": "vision-input",
	"image-to-text": "image-to-text",
	"image-caption": "image-to-text",
	"image-to-image": "image-to-image",
	"text-to-image-synthesis": "text-to-image",
	"text-to-video-synthesis": "text-to-video"
});
/** 能力优先级：图像类信号比「纯文本」具体，多个标签时取最具体的一个。 */
const CAPABILITY_RANK = Object.freeze({
	unknown: 0,
	text: 1,
	"vision-input": 3,
	"image-to-text": 3,
	"image-to-image": 4,
	"text-to-image": 5,
	"text-to-video": 5
});
/** 从任务标签数组取能力；一个都不认识返回 undefined（调用方再走兜底）。 */
function capabilityFromTasks(tasks) {
	let best;
	let bestRank = -1;
	for (const task of tasks) {
		const capability = TASK_TO_CAPABILITY[task.trim().toLowerCase()];
		if (capability === void 0) continue;
		if (CAPABILITY_RANK[capability] > bestRank) {
			best = capability;
			bestRank = CAPABILITY_RANK[capability];
		}
	}
	return best;
}
/**
* 解析一条目录条目的能力类型。
*
* 判定顺序（权威 → 兜底）：结构化模态字段 → 详情端点任务标签 → 策展清单 → 名字启发。
* 前两级是平台声明，后两级是「我们已知 / 我们推断」，绝不混淆。
* @param {object} entry - 一条归一目录条目。
* @returns {ModelCapability} 能力类型。
*/
function resolveModelCapability(entry) {
	const source = entry ?? {};
	const modalities = inputModalitiesOf(source);
	if (modalities !== void 0) return modalities.some((modality) => /image|vision/i.test(modality)) ? "vision-input" : "text";
	const tasks = tasksOf(source);
	if (tasks !== void 0) {
		const capability = capabilityFromTasks(tasks);
		if (capability !== void 0) return capability;
		return "unknown";
	}
	const id = str(source.id, "");
	if (id !== "" && KNOWN_VISION_IDS.has(id)) return "vision-input";
	const idOrName = `${id} ${str(entry?.name, "")}`;
	if (VISION_NAME_PATTERN.test(idOrName)) return "vision-input";
	return "unknown";
}
/**
* 一条目录条目能否吃图（vision）。
*
* 是 `resolveModelCapability` 的布尔投影：图进文出（`vision-input`）或图出文
* （`image-to-text`/caption）算视觉模型；图出图（`image-to-image`）、文生图
* （`text-to-image`）**不算**——它们不吃图，别混进 vision 开关。
* 漏判 = 模型收图时报 `UNSUPPORTED_CONTENT`，面板能看见，不算静默失败。
* @param {object} entry - 一条归一目录条目。
* @returns {boolean} 是否吃图。
*/
function isVisionModel(entry) {
	const capability = resolveModelCapability(entry);
	return capability === "vision-input" || capability === "image-to-text";
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
* 这个条目的窗口数字从真值链哪一级来——与 contextWindowOf 配对的来源标记。
*
* catalog = 目录四键声明过（平台真值）；override = fetchModels 打标时写入的
* 用户覆盖；curated = 打标时写入的策展表值。后两者在归一条目上是不可区分的
* （都表现为 contextWindow 键有值），所以打标侧各自留指纹：覆盖命中时在
* source 上放 `__contextSource: "override"`，策展命中放 `"curated"`，本函数
* 只读指纹。都没有 → "catalog"（含义是「目录说了算」，包括目录没声明、值
* 就是 pi-ai 兜底 128k 的条目——面板把 128k 徽章留给这个状态，策展命中会
* 显示自己的数值）。
* @param {object} entry - 一条归一目录条目。
* @returns {"catalog"|"override"|"curated"} 来源标记。
*/
function contextWindowSourceOf(entry) {
	const mark = (entry?.raw)?.__contextSource;
	if (mark === "override" || mark === "curated") return mark;
	return "catalog";
}
/**
* 读目录声明的单次输出上限，0 = 未声明。
*
* 这个数**是请求参数**，不是纯展示值：`toPiDescriptor` 在它 >0 时声明为
* `maxTokens`（见模块头注第 2 条）。**但 `0` 有真实的代价**——魔搭目录从不返回
* 这个字段，所以它对本插件的每一个模型都是 0，harness 于是用 `defaultMaxTokens ??
* 32768` 兜底。「目录没说」在这里不等于「平台没限制」，只等于**我们不知道**；把它
* 当「不设上限」读会错得很远。操作者知道时用 `maxTokensFor` 的覆盖参数补上。
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
* 该条目**实际生效**的输出上限：`覆盖 > 目录声明 > 不声明(0)`——全插件唯一的
* 回退顺序，写在这里就只写一遍。
*
* 为什么覆盖必须排在目录**之前**（而不是「目录优先、覆盖只补空缺」）：目录说的是
* 「这个平台声称能吐多少」，覆盖说的是「我实测过这个模型能吐多少」。两者冲突时后者
* 是更新的事实——目录是我们**抓来的**（`/v1/models`，会随上游改动、也可能常年不
* 更新），覆盖是操作者**写的**。魔搭这条路上目录连这个字段都不返回，所以顺序在
* 多数情况下没有争议；把它写死仍然重要，因为「谁赢」这件事只能有一个答案。
*
* 返回 0 的含义与 `maxOutputLengthOf` 完全一致：**不声明** `maxTokens`，让 harness
* 用它的兜底值——不是「上限为 0」。`0` 因此不是一个可以配置的上限（
* `resolveMaxTokensOverrides` 会把 0 丢掉）。
* @param {object} entry - 一条归一目录条目。
* @param {object|null} [overrides] - 归一后的 id → 上限映射（`ResolvedSettings`）。
* @returns {number} 生效上限，未声明为 0。
*/
function maxTokensFor(entry, overrides) {
	const declared = maxOutputLengthOf(entry);
	if (overrides === void 0 || overrides === null) return declared;
	const id = str(entry?.id, "");
	if (id === "") return declared;
	const override = overrides[id];
	return typeof override === "number" && Number.isInteger(override) && override > 0 ? override : declared;
}
/**
* 这个条目的输出上限数字从真值链哪一级来——与 {@link maxTokensFor} 配对的来源标记，
* 形状与 {@link contextWindowSourceOf} 刻意保持同一套词汇。
*
* 只有两级，因为这里**没有策展表**：窗口有 `context-catalog.ts` 那份实测策展表，
* 输出上限没有（魔搭从不声明它，策展一张「猜每个模型能吐多少」的表没有依据）。
* `catalog` 的含义因此是「覆盖没命中」——包括目录没声明、值就是 0 的情况，面板据此
* 不画徽章。
* @param {object} entry - 一条归一目录条目。
* @param {object|null} [overrides] - 归一后的 id → 上限映射。
* @returns {"catalog"|"override"} 来源标记。
*/
function maxTokensSourceOf(entry, overrides) {
	if (overrides === void 0 || overrides === null) return "catalog";
	const id = str(entry?.id, "");
	if (id === "") return "catalog";
	const override = overrides[id];
	return typeof override === "number" && Number.isInteger(override) && override > 0 ? "override" : "catalog";
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
* @param {object} [options.maxTokensOverrides] - 逐模型输出上限覆盖（id → tokens），
*   经 `maxTokensFor` 决定 `maxTokens`。缺省 = 目录说了算（对本插件的目录即「不声
*   明」）。
* @returns {object} pi-ai descriptor。
*/
function toPiDescriptor(entry, options = {}) {
	const { providerId = LLM_PROVIDER_ID, baseUrl, maxTokensOverrides } = options;
	const id = str(entry?.id, "");
	if (id === "") throw new Error("toPiDescriptor: catalog entry has no id");
	const vision = isVisionModel(entry);
	const effectiveMaxTokens = maxTokensFor(entry, maxTokensOverrides);
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
		...effectiveMaxTokens > 0 ? { maxTokens: effectiveMaxTokens } : {},
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
* 三态判定走 {@link parseAllowedList}（与 `resolveAllowedList` / `isModelEnabled`
* 同一份解释）：含哨兵的清单属 `"none"`，过滤结果必然是空——包括「哨兵混排
* 真实 id」这种旧实现会漏成「提供那些真实 id」的形状（fix D 的收口：解释只有
* 一份，`switch` 漏分支是编译错误）。
* @param {object[]} entries - 归一目录条目。
* @param {string[]} [enabledIds] - 允许清单；空/缺省关闭过滤。
* @returns {object[]} 仍被提供的条目，按目录顺序。
*/
function filterByEnabled(entries, enabledIds) {
	const list = parseAllowedList(enabledIds);
	const all = Array.isArray(entries) ? entries : [];
	if (list.mode === "all") return all;
	if (list.mode === "none") return [];
	const allow = new Set(list.ids);
	return all.filter((entry) => allow.has(str(entry?.id, "")));
}
/**
* 面板用的 roster：每条可寻址 chat 条目一行。
*
* 刻意是投影而非原始条目：快照只带 picker 需要的（id、展示名、与 descriptor
* 相同的 vision 判定、以及供能力路由用的 capability），平台将来新增的目录字段
* 不会为了没理由泄到面板。
*
* 去重保留**末次出现**（与 {@link buildDescriptors} 一致）：同 id 更新的读取赢。
* 这里要是分叉了，面板清单和注册结果就会就「哪些模型存在」说两套话，勾选的模型
* 可能变成未注册的。
* @param {object[]} entries - 归一目录条目。
* @returns {{id: string, name: string, vision: boolean, capability: ModelCapability}[]}
*/
/**
* 构建一份去重 roster 的**共享循环骨架**：过滤 chat 模型 → 取 id → 投 row →
* position-map 去重（末次出现赢）。两个公开 roster 函数（rosterOf /
* rosterWithAvailability）只投各自的 row 形状，过滤/取 id/去重不再各写一遍
* ——它们曾各写一份相同的循环，jscpd 抓到 :493-504 ↔ :568-577。
*
* 语义承重，与 {@link buildDescriptors} 一致：同 id 末次出现赢；顺序为目录
* 首见序。这里分叉了，面板清单和注册结果就会就「哪些模型存在」说两套话。
* @template T - 一行 roster 的形状（由调用方投）。
* @param {object[]} entries - 归一目录条目。
* @param {(entry: CatalogEntry, id: string) => T} project - 条目 → 行。
* @returns {T[]}
*/
function buildRosterRows(entries, project) {
	const position = /* @__PURE__ */ new Map();
	const out = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const catalogEntry = entry;
		if (!isChatModel(catalogEntry)) continue;
		const id = str(catalogEntry.id, "");
		if (id === "") continue;
		const row = project(catalogEntry, id);
		if (position.has(id)) out[position.get(id)] = row;
		else {
			position.set(id, out.length);
			out.push(row);
		}
	}
	return out;
}
/**
* 为一份目录构建整份 descriptor 列表。
*
* 没有 id 的条目丢弃（线上没法寻址），重复 id 保留末次出现，与 `rosterOf` 的
* 去重一致。`unavailableModelIds` 里的（额度耗尽的）模型丢弃——面板经
* `rosterWithAvailability` 仍显示它们，灰显加原因，但 picker 不提供注定 429 的
* 请求；两处口径不同是故意的，别统一。
* @param {object[]} entries - 归一目录条目。
* @param {object} options - `{ providerId, baseUrl, enabledIds, unavailableModelIds, maxTokensOverrides }`。
* @returns {object[]} pi-ai descriptor，按首见顺序。
*/
function buildDescriptors(entries, options = {}) {
	const { providerId = LLM_PROVIDER_ID, baseUrl, enabledIds = [], unavailableModelIds = [], maxTokensOverrides } = options;
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
			...baseUrl !== void 0 ? { baseUrl } : {},
			...maxTokensOverrides !== void 0 ? { maxTokensOverrides } : {}
		});
	}
	return out;
}
/**
* 一条目录条目能不能**出图**。
*
* 判据是能力枚举里的两个出图档：`text-to-image`（文生图）与 `image-to-image`
* （图生图/改图）。**只认平台声明的能力**（详情端点 `Tasks[].Name` 或结构化模态
* 字段），不额外加名字正则——名字启发是 `resolveModelCapability` 里最后才用的兜底，
* 它把「说不清」的条目标成 `unknown`，那种条目**不**进候选。
*
* 与 `isVisionModel` 的严格方向同源：吃图判定宁可漏（漏了报 UNSUPPORTED_CONTENT，
* 面板看得见），出图判定同理宁可漏（漏了报「目录里没有出图模型」，可诊断）；反过来
* 猜错会把 agent 的请求发给一个出不了图的模型，换回一个原因不可知的 FAILED。
*
* 实测（2026-10-10）：api-inference 的 35 条目录里**没有 `text-to-image`**，只有 2 条
* `image-to-image`（`Qwen/Qwen-Image-Edit`、`MusePublic/Qwen-Image-Edit`），两者均
* 经 `/v1/images/generations` 出图成功。详见 docs/SPIKE-image-gen.md。
* @param {object} entry - 一条归一目录条目。
* @returns {boolean} 是否可用于出图。
*/
function isImageGenModel(entry) {
	const capability = resolveModelCapability(entry);
	return capability === "text-to-image" || capability === "image-to-image";
}
/**
* 一份目录里匹配某判定的模型 id，按首见顺序去重。
*
* 去重口径与 `buildDescriptors` / `rosterOf` 一致（保留末次出现的值、占首见位置），
* 这样出图候选列表与 chat roster 不会对「有哪些 id」各说一套。`imageGenModelIds`
* 与 `textToImageModelIds` 共用这一份骨架，避免两处各自写一份相同的循环。
* @param {unknown} entries - 归一目录条目。
* @param {(entry: CatalogEntry) => boolean} isMatch - 条目匹配判定。
* @returns {string[]} 匹配的模型 id。
*/
function idsOf(entries, isMatch) {
	const position = /* @__PURE__ */ new Map();
	const out = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		if (!isMatch(entry)) continue;
		const id = str(entry.id, "");
		if (id === "") continue;
		const seen = position.get(id);
		if (seen === void 0) {
			position.set(id, out.length);
			out.push(id);
		} else out[seen] = id;
	}
	return out;
}
/**
* 一份目录里可用于出图的模型 id，按首见顺序去重。
*
* 去重口径见 {@link idsOf}。**注意**：这里只保证「平台声明能出图」，不保证
* 「能纯文生图」——真实目录里唯一的出图条目是 `image-to-image`，其中
* `MusePublic/Qwen-Image-Edit` 纯文生图被上游拒绝（见 `draw-runtime.ts` 的
* `KNOWN_T2I_MODEL_ID`）。挑默认模型要走 `pickDrawModel` 的完整优先级，别直接
* 取这里的第一个。
* @param {unknown} entries - 归一目录条目。
* @returns {string[]} 出图模型 id。
*/
function imageGenModelIds(entries) {
	return idsOf(entries, isImageGenModel);
}
/**
* 一份目录里**平台声明为文生图**（`text-to-image`）的模型 id，按首见顺序去重。
*
* 与 `imageGenModelIds` 同一份去重骨架，只筛能力为 `text-to-image` 的条目。
* 真实目录至今为空集（api-inference 的 36 条里没有 `text-to-image`），但将来
* 目录补上真文生图模型时，`pickDrawModel` 应当优先挑它们——这个函数就是那个
* 「平台说了算」的优先通道。
* @param {unknown} entries - 归一目录条目。
* @returns {string[]} 文生图模型 id。
*/
function textToImageModelIds(entries) {
	return idsOf(entries, (entry) => resolveModelCapability(entry) === "text-to-image");
}
/**
* 一份目录里的出图候选，按首见顺序去重，带能力档与纯文生图标记。
*
* 与 {@link imageGenModelIds} 同一份判定（只认平台声明的出图能力），只是把
* `reference` 需要的两个附加位一起投出来——面板的每一行徽章与「当前使用」都从
* 这里派生，不各自再判一次。
* @param {unknown} entries - 归一目录条目。
* @returns {DrawCandidate[]} 出图候选。
*/
function drawCandidates(entries) {
	const position = /* @__PURE__ */ new Map();
	const out = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const e = entry;
		if (!isImageGenModel(e)) continue;
		const id = str(e.id, "");
		if (id === "") continue;
		const capability = resolveModelCapability(e);
		const row = {
			id,
			capability: capability === "text-to-image" ? "text-to-image" : capability === "image-to-image" ? "image-to-image" : "other",
			textToImage: capability === "text-to-image" || id === "Qwen/Qwen-Image-Edit"
		};
		const seen = position.get(id);
		if (seen === void 0) {
			position.set(id, out.length);
			out.push(row);
		} else out[seen] = row;
	}
	return out;
}
/**
* 从目录里挑一个出图模型，并说明**为什么是它**。
*
* 优先级（高 → 低），与 `draw-runtime.ts` 的 `pickDrawModel` 同一份：
* 1. `requested` —— 工具调用里显式给的 model（这里不投理由，调用方场景）；
* 2. `preferred` —— 面板保存 / 配置 `drawModelId`；用户点了谁就是谁，不校验在不在目录；
* 3. 平台声明为 `text-to-image` 的条目（将来目录补上真文生图模型时自动优先）；
* 4. 已知能纯文生图的 `KNOWN_T2I_MODEL_ID`（今天目录的坑位）；
* 5. 目录里第一个出图模型。
*
* `requested` 会以 `preferred` 的理由返回——它同样是「有人指定了」，面板不需要
* 为一次工具调用区分这两者。
* @param {unknown} entries - 归一目录条目。
* @param {string} [requested] - 工具调用显式指定的 id。
* @param {string} [preferred] - 面板/配置的默认 id。
* @returns {DrawModelChoice} 选中的 id 与理由。
*/
function resolveDrawModelChoice(entries, requested, preferred) {
	const want = str(requested, "");
	if (want !== "") return {
		id: want,
		source: "preferred"
	};
	const preferredId = str(preferred, "");
	if (preferredId !== "") return {
		id: preferredId,
		source: "preferred"
	};
	const ids = imageGenModelIds(entries);
	if (ids.length === 0) return {
		id: null,
		source: null
	};
	const t2i = textToImageModelIds(entries);
	if (t2i.length > 0) return {
		id: t2i[0] ?? null,
		source: "declared-text-to-image"
	};
	if (ids.includes("Qwen/Qwen-Image-Edit")) return {
		id: KNOWN_T2I_MODEL_ID,
		source: "known-text-to-image"
	};
	return {
		id: ids[0] ?? null,
		source: "catalog-first"
	};
}
/**
* 带额度可用性的面板 roster。
*
* 与 {@link rosterOf} 一样每 chat 模型 id 一行，但每行还带该模型额度池是否耗尽。
* 与 **picker**（`buildDescriptors` 直接丢弃耗尽模型，避免发注定 429 的请求）不同，
* 面板保留它们在清单里、灰显，让用户看得见「为什么模型从选择器里不见了」。
* @param {object[]} entries - 归一目录条目。
* @param {string[]} unavailableIds - 额度耗尽的模型 id；空数组 = 全部可用。
* @param {object} [maxTokensOverrides] - 逐模型输出上限覆盖（id → tokens）。**位置参数
*   而非 options 对象**：本函数的既有调用面就是两个位置参数，第三个在三个调用点都是
*   一次机械追加；改成对象会动三处签名与它们各自的测试假件，收益只是好看。窗口那边
*   （`contextSource`）**不**走这个参数——它在 fetchModels 归一时就被打标了，两条路
*   的机制不同，这里不假装统一。
* @returns {{id: string, name: string, vision: boolean, capability: ModelCapability, available: boolean, quotaExhausted: boolean, contextWindow: number, contextSource: "catalog"|"override"|"curated", maxOutputLength: number, maxOutputSource: "catalog"|"override"}[]}
*/
function rosterWithAvailability(entries, unavailableIds, maxTokensOverrides) {
	const blocked = new Set(Array.isArray(unavailableIds) ? unavailableIds : []);
	return buildRosterRows(entries, (entry, id) => ({
		id,
		name: str(entry.name, id),
		vision: isVisionModel(entry),
		capability: resolveModelCapability(entry),
		available: !blocked.has(id),
		quotaExhausted: blocked.has(id),
		contextWindow: contextWindowOf(entry),
		contextSource: contextWindowSourceOf(entry),
		maxOutputLength: maxTokensFor(entry, maxTokensOverrides),
		maxOutputSource: maxTokensSourceOf(entry, maxTokensOverrides)
	}));
}

//#endregion
//#region src/host/host-config.ts
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
const PLUGIN_VERSION = "0.6.4";
/**
* 默认值。刻意不含额度常数——理由见本文件头。
* 面板头条是官方魔粒余额，次数口径的推算已在面板收敛时删除，这里若留着
* dailyQuotaTotal 之类的社区快照，只会成为「看起来能算剩余次数」的假线索。
*/
const CONFIG_DEFAULTS = Object.freeze({
	/** OpenAI 兼容推理源站（模型目录 + probe + provider 直连）。 */
	apiBase: "https://api-inference.modelscope.cn/v1",
	/** 站点源站，只用于面板外链（访问令牌页 / 文档）。 */
	siteBase: "https://modelscope.cn",
	/**
	* 趋势图**显示**天数（面板标题「近 N 天」与图上柱数）——默认值，用户可在面板里
	* 改看多长。
	*
	* **与 retentionDays 是两件事**（2026-10-17 拆开）：这个数只决定「画多少」，
	* 不再决定「留多少」。曾经一个 trendDays 同时是保留窗口，于是「想多看几天」等于
	* 「改保留策略」，改小还会把历史当场剪掉——拆开正是为了消除这层耦合。
	*/
	trendDays: 14,
	/**
	* 本地趋势**保留**天数（usage-store 天桶的修剪窗口；超出即删）。
	*
	* 取 90：够回看一个季度，而每个天桶只是两个整数——留 90 天的磁盘代价可忽略。
	* 显示窗口恒被夹在它之内（见 resolveSettings），所以「画得比留得多」这个会把
	* 已剪的日子画成 0（与「那天真的没调用」在面板上无法区分）的组合不会出现。
	*/
	retentionDays: 90,
	/** Host 侧对 /v1/models 的缓存秒数。 */
	cacheSeconds: 60,
	/** 面板轮询间隔——由 Host 下发、面板跟随，两端不各自假设。 */
	pollSeconds: 30,
	/** 单次魔搭请求超时（毫秒）。 */
	inferenceTimeoutMs: 3e4,
	/** 事件流保留条数（429/错误事件的环形上限）。 */
	maxEvents: 50,
	/**
	* 单模型「额度耗尽」的推断窗口（分钟）。
	*
	* 官方只给**账户级**魔粒余额，没有 per-model 额度端点，所以「哪个模型刚才在
	* 限频」只能从本插件的 429 事件流推断（规则是纯函数 `exhaustedModelIds`，
	* usage-store.ts）：某模型最近在这个窗口内出现过 `kind:"quota"` 事件
	* （重分类后的 code，见 llm-error-fix），picker 就不再提供它、面板 roster
	* 灰显；事件移出窗口即恢复提供。
	*
	* 取 60 分钟：覆盖一次「耗尽 → 用户看到 → 换模型」的合理观察期，又不至于让
	* 一次深夜的耗尽事件把模型关一整天。**恢复不可观测是这条规则已知的代价**：
	* 成功的流不发事件，所以额度若在窗口内恢复（按天重置恰好在窗口内发生），
	* 模型最多灰显满一个窗口——方向是保守的（宁可少提供一会，不提供注定 429
	* 的模型），且面板灰显上写着原因，不是静默消失。
	*/
	exhaustionWindowMinutes: 60,
	/** provider 注册的 patch 默认值（面板保存值优先于它）。 */
	registerProvider: false,
	/**
	* 逐模型的单次输出上限覆盖（模型 id → tokens），空对象 = 目录说了算。
	*
	* **为什么需要它**：本插件对输出上限的原始策略是「目录声明了才声明」
	* （llm-models.ts 模块头注第 2 条），而魔搭 `/v1/models` **从不返回**这个字段
	* （docs/REFERENCES.md 实测：每条只有 `id`/`object`/`owned_by`/`created`）。
	* 两条合起来的结果是**每一个**模型的 descriptor 都不带 `maxTokens`，harness 于是
	* 走它的 `defaultMaxTokens ?? 32768` 兜底——32768 不是魔搭声明的数，也不是任何
	* 实测过的数，它只是 harness 的默认值。
	*
	* 目录给不出真值时，操作者是唯一的信息源：他知道某个模型实测能吐 64k。没有这个
	* 字段，这份知识**无处可写**——写进目录缓存会被下一轮轮询覆盖。于是他只能看着
	* 输出在 32768 处被截断，而手上明明有答案。
	*
	* **语义与优先级**：`覆盖 > 目录声明 > 不声明`。目录声明了时覆盖仍然赢（这是
	* 「覆盖」二字的全部含义）；目录没声明时覆盖就是唯一的真值来源。空对象（默认）
	* ＝ 完全维持旧行为，不改变任何已有部署的输出。
	*
	* **键是精确 id，不做子串匹配**——与 sensenova 那种「按名字包含」的倍率旋钮
	* 刻意不同：上限是**请求参数**，一个宽松的键会顺手改掉一批没被点名的模型
	* （键写 `flash` 会命中七八条）。只认整串相等。
	*
	* **值必须是正整数**：0 有保留含义（`maxOutputLengthOf` 里 0 = 未声明），所以
	* 非法值一律**丢弃**（非整数 / NaN / Infinity / 字符串数字 / 0 / 负数），不是夹取
	* ——夹取等于替用户声明一个他没说过的上限。
	*
	* 读取点只有一处：`llm-models.ts` 的 `maxTokensFor`。descriptor 构建与面板 roster
	* **都**调它，所以面板显示的数字与线上真正发的 `max_tokens` 不可能不一致。
	*/
	maxTokensOverrides: {},
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
	drawTimeoutMs: 9e5,
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
	drawWaitMs: 9e4,
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
const DRAW_TIMEOUT_MAX_MS = 18e5;
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
* 归一「逐模型输出上限覆盖」。
*
* 三个刻意的选择，都与姊妹插件的同类函数不同：
*
* 1. **键精确相等**，不做子串匹配。上限是请求参数，宽松匹配会改掉一批没被点名的
*    模型；倍率那种「按名字包含」的旋钮可以宽松，因为它只影响画图。
* 2. **值必须是正整数**，非法值**丢弃**而不是夹取。0 在 `maxOutputLengthOf` 里已经
*    表示「未声明」，把 `-5` 夹成 1 等于替用户声明了一个他没说过的上限；丢弃则
*    退回目录/兜底，方向是保守的。
* 3. **非对象一律回落到默认空对象**，不抛错——坏配置不能让 apply 抛出去（本文件的
*    既有纪律，见 resolveSettings 的 catch 分支）。
* @param {unknown} raw - patch 行里的原始值（加载器送来的未校验输入）。
* @returns {Record<string, number>} id → 上限，只含合法项。
*/
function resolveMaxTokensOverrides(raw) {
	if (raw === void 0 || raw === null) return CONFIG_DEFAULTS.maxTokensOverrides;
	if (typeof raw !== "object" || Array.isArray(raw)) return { ...CONFIG_DEFAULTS.maxTokensOverrides };
	const out = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === "") continue;
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) continue;
		out[key] = value;
	}
	return out;
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
		const drawTimeoutMs = clampInt(source.drawTimeoutMs, CONFIG_DEFAULTS.drawTimeoutMs, 3e4, DRAW_TIMEOUT_MAX_MS);
		const retentionDays = clampInt(source.retentionDays, CONFIG_DEFAULTS.retentionDays, 1, 365);
		return {
			settings: {
				apiBase,
				siteBase,
				trendDays: clampInt(source.trendDays, CONFIG_DEFAULTS.trendDays, 1, retentionDays),
				retentionDays,
				cacheSeconds: clampInt(source.cacheSeconds, CONFIG_DEFAULTS.cacheSeconds, 5, 600),
				pollSeconds: clampInt(source.pollSeconds, CONFIG_DEFAULTS.pollSeconds, 5, 3600),
				inferenceTimeoutMs: clampInt(source.inferenceTimeoutMs, CONFIG_DEFAULTS.inferenceTimeoutMs, 1e3, 6e5),
				maxEvents: clampInt(source.maxEvents, CONFIG_DEFAULTS.maxEvents, 1, 1e3),
				exhaustionWindowMinutes: clampInt(source.exhaustionWindowMinutes, CONFIG_DEFAULTS.exhaustionWindowMinutes, 5, 1440),
				registerProvider: source.registerProvider === true,
				maxTokensOverrides: resolveMaxTokensOverrides(source.maxTokensOverrides),
				drawEnabled: source.drawEnabled === true,
				drawModelId: str(source.drawModelId, CONFIG_DEFAULTS.drawModelId),
				drawTimeoutMs,
				drawWaitMs: clampInt(source.drawWaitMs, CONFIG_DEFAULTS.drawWaitMs, 1e4, drawTimeoutMs),
				allowedHosts: resolveAllowedHosts(source)
			},
			configError: null
		};
	} catch (error) {
		return {
			settings: {
				apiBase: CONFIG_DEFAULTS.apiBase,
				siteBase: CONFIG_DEFAULTS.siteBase,
				trendDays: CONFIG_DEFAULTS.trendDays,
				retentionDays: CONFIG_DEFAULTS.retentionDays,
				cacheSeconds: CONFIG_DEFAULTS.cacheSeconds,
				pollSeconds: CONFIG_DEFAULTS.pollSeconds,
				inferenceTimeoutMs: CONFIG_DEFAULTS.inferenceTimeoutMs,
				maxEvents: CONFIG_DEFAULTS.maxEvents,
				exhaustionWindowMinutes: CONFIG_DEFAULTS.exhaustionWindowMinutes,
				registerProvider: false,
				maxTokensOverrides: CONFIG_DEFAULTS.maxTokensOverrides,
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
function resolveAllowedHosts(source) {
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
function hostName(host) {
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		if (end < 0) return "";
		const rest = host.slice(end + 1);
		if (rest !== "" && !/^:\d{1,5}$/.test(rest)) return "";
		return host.slice(0, end + 1);
	}
	if (host.includes("]")) return "";
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
export { verbatim as A, degrade as C, pluginError as D, optional as E, redactSecrets as O, reclassifyStream as S, obj as T, enabledCountOf as _, name as a, hasHardQuotaWordingIn as b, LLM_DISPLAY_NAME as c, drawCandidates as d, imageGenModelIds as f, rosterWithAvailability as g, resolveDrawModelChoice as h, isAdmitted as i, str as k, LLM_PROVIDER_ID as l, normalizeEntry as m, PLUGIN_VERSION as n, resolveSettings as o, isVisionModel as p, inject as r, LLM_API_KEY_NAME as s, DRAW_TIMEOUT_MAX_MS as t, buildDescriptors as u, parseAllowedList as v, errMsg as w, looksLikeRateLimit as x, CODE as y };