var dsh_connect_modelscope_token_plan_client = (function() {

//#region \0rolldown/runtime.js
	var __esmMin = (fn, res, err) => () => {
		if (err) throw err[0];
		try {
			return fn && (res = fn(fn = 0)), res;
		} catch (e) {
			throw err = [e], e;
		}
	};
	var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);

//#endregion
//#region src/shared/wire.ts
	var HIDE_ALL_MODELS, SNAPSHOT_REQUIRED_KEYS;
	var init_wire = __esmMin((() => {
		HIDE_ALL_MODELS = "__hide_all__";
		SNAPSHOT_REQUIRED_KEYS = Object.freeze([
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
			"provider",
			"shapeWarnings",
			"quotaError"
		]);
	}));

//#endregion
//#region src/client/const.ts
	function modelscopeModelUrl(id) {
		return `${MODELSCOPE_MODEL_URL_BASE}/${id.split("/").map(encodeURIComponent).join("/")}`;
	}
	/** 从 `owner/model` 取 owner（无斜杠时整段作 owner）。 */
	function catalogOwner(id) {
		const slash = id.indexOf("/");
		return slash >= 0 ? id.slice(0, slash) : id;
	}
	/**
	* 徽章用的窗口短标注（tokens → "128K" / "1M"）。
	*
	* K=1024、M=1024²，与档位值（131072…1048576）同一把尺。**不美化**：目录声明的
	* 128000 显示成 "125K" 而不是 "128K"——标签必须能从数值反推出来，四舍五入到
	* 好看的整数是撒谎。≥1M 用 M（`1.25M` 保留至多一位小数，去掉尾随 .0），
	* ≥1024 用 K，更小的原样显示。
	* @param {number} tokens - 窗口大小（tokens）。
	* @returns {string} 短标注。
	*/
	function formatWindow(tokens) {
		if (tokens >= 1048576) {
			const m = tokens / 1048576;
			return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : Math.round(m * 10) / 10}M`;
		}
		if (tokens >= 1024) return `${Math.round(tokens / 1024)}K`;
		return String(tokens);
	}
	var NS, PANEL_ID, SNAPSHOT_PATH, MODELS_PATH, TOKEN_PATH, TOKEN_FORGET_PATH, PROBE_PATH, PROVIDER_PATH, PROVIDER_ROSTER_PATH, PROVIDER_CONTEXT_PATH, PROVIDER_RESET_PATH, DRAW_PATH, DRAW_RESET_PATH, MODELSCOPE_TOKEN_URL, MODELSCOPE_USAGE_URL, MODELSCOPE_MODEL_URL_BASE, FEATURED_OWNERS;
	var init_const = __esmMin((() => {
		init_wire();
		NS = "dsh-connect-modelscope-token-plan";
		PANEL_ID = NS;
		SNAPSHOT_PATH = `/api/${NS}/snapshot`;
		MODELS_PATH = `/api/${NS}/models`;
		TOKEN_PATH = `/api/${NS}/token`;
		TOKEN_FORGET_PATH = `/api/${NS}/token/forget`;
		PROBE_PATH = `/api/${NS}/probe`;
		PROVIDER_PATH = `/api/${NS}/provider`;
		PROVIDER_ROSTER_PATH = `/api/${NS}/provider/roster`;
		PROVIDER_CONTEXT_PATH = `/api/${NS}/provider/context`;
		PROVIDER_RESET_PATH = `/api/${NS}/provider/reset`;
		DRAW_PATH = `/api/${NS}/draw`;
		DRAW_RESET_PATH = `/api/${NS}/draw/reset`;
		MODELSCOPE_TOKEN_URL = "https://modelscope.cn/my/myaccesstoken";
		MODELSCOPE_USAGE_URL = "https://modelscope.cn/magicube/usage?tab=consume";
		MODELSCOPE_MODEL_URL_BASE = "https://www.modelscope.cn/models";
		FEATURED_OWNERS = Object.freeze([
			"deepseek-ai",
			"ZhipuAI",
			"Qwen"
		]);
	}));

//#endregion
//#region src/client/i18n.ts
	var zh, en;
	var init_i18n = __esmMin((() => {
		zh = {
			"panel.title": "魔搭接入 · 额度面板",
			"panel.refresh": "刷新",
			"panel.updated": "更新于 {time}",
			"panel.loading": "加载中…",
			"panel.error": "读取失败：{error}",
			"panel.configError": "插件配置有误：{error}",
			"panel.networkError": "无法连接本机 Host，通常是临时故障，下一轮自动刷新即可恢复。",
			"panel.timeout": "请求超时，下一轮自动刷新即可恢复。",
			"panel.upstream": "魔搭暂时无法读取，通常下一次自动刷新即可恢复。",
			"panel.internalError": "插件内部错误，不是令牌或配置问题；请查看 DSH 日志中的插件名。",
			"panel.authError": "令牌被拒绝（401/403）。请到「接入」tab 更换访问令牌。",
			"panel.noToken": "还没有配置魔搭访问令牌。到「接入」tab 粘贴一枚 ms-… 令牌即可。",
			"panel.shapeDrift": "上游返回的结构可能有变：{detail}",
			"panel.payloadError": "Host 返回了无法读取的响应（可能页面被登录墙或代理截获）。",
			"shape.missingKeys": "Host 快照缺少必需的顶层键：{keys}",
			"common.httpError": "无法读取 Host 响应（非预期响应，可能页面被登录墙截获）。",
			"common.timeout": "请求超时，请重试。",
			"tab.quota": "额度",
			"tab.models": "模型",
			"tab.access": "接入",
			"section.balance": "魔粒余额（官方数据）",
			"section.local": "本地调用（仅经本插件的调用）",
			"section.trend": "近 {days} 天本地调用趋势",
			"section.events": "限流与错误事件",
			"section.token": "访问令牌",
			"section.expand": "展开",
			"section.collapse": "折叠",
			"balance.available": "可用魔粒",
			"balance.total": "总额",
			"balance.frozen": "冻结",
			"balance.fetched": "读取于 {time}",
			"balance.note": "魔粒是魔搭 API-Inference 的官方额度单位，此数字来自官方接口（openapi/v1/magicubes/balance），是真实余额。预扣 = 进行中任务未返回结果时的暂扣额度。",
			"balance.usagePage": "官方用量明细（网页）→",
			"balance.unavailable": "魔粒余额暂不可读：{error}",
			"quota.headline": "今日 {calls} 次 · {models} 个模型",
			"quota.note": "本地口径：只统计经本插件的调用，直连魔搭的其它客户端不计入；消耗总量以官方魔粒余额为准。",
			"quota.unavailable": "本地计数本次读不到（原因见上方提示）",
			"probe.validity": "验令牌（零额度）",
			"probe.validOk": "令牌有效（HTTP {status}）",
			"probe.fail": "失败：{error}",
			"models.viewOnSite": "在魔搭查看 →",
			"models.viewOnSiteTitle": "打开模型详情页（魔粒单价等只在网页展示）",
			"models.featuredTitle": "推荐系列（深度求索 / 智谱 / 通义千问）",
			"provider.featured": "推荐",
			"section.provider": "接入为 DSH 模型",
			"provider.enable": "把魔搭模型接入 DSH 模型选择器",
			"provider.on": "已接入",
			"provider.off": "未接入",
			"provider.busy": "切换中…",
			"provider.registered": "已注册（模型可在选择器里选用）",
			"provider.notRegistered": "未注册",
			"provider.llmMissing": "本机 Host 未提供 LLM 注册服务",
			"provider.error": "接入失败：{error}",
			"provider.models": "启用哪些模型",
			"provider.allowAll": "全部",
			"provider.hideAll": "全部隐藏",
			"provider.saveList": "保存清单",
			"provider.reset": "回到默认",
			"provider.enabledCount": "已启用 {count} / {total}",
			"provider.rosterHint": "勾选要进入 DSH 模型选择器的模型；不勾 = 全部提供",
			"provider.quotaExhausted": "额度耗尽",
			"provider.vision": "视觉",
			"provider.notConfigured": "还没有访问令牌，先到「接入」tab 配置",
			"provider.source.panel": "面板",
			"provider.source.config": "配置",
			"provider.contextWindow": "上下文窗口",
			"provider.contextDefault": "默认（跟随目录）",
			"provider.contextHint": "目录没声明窗口的模型按此值生效；保存后立即重新注册",
			"provider.contextCuratedTitle": "窗口来自内置策展表（models.dev 交叉真值），平台未亲口声明；带 * 标记",
			"section.draw": "出图工具",
			"draw.enable": "给 agent 注册 modelscope_draw_image 工具",
			"draw.on": "已开启",
			"draw.off": "未开启",
			"draw.busy": "切换中…",
			"draw.mounted": "已注册：{tool}",
			"draw.notMounted": "未注册——勾选上方开关即可开启。",
			"draw.restartHint": "开关立即保存，但工具的挂载发生在**下次 Host 启动**（工具注册无法撤销）。",
			"draw.models": "出图将使用以下模型",
			"draw.badge": "出图",
			"draw.noCandidates": "当前目录里没有出图模型（平台声明 image-to-image / text-to-image 的条目为空）；出图不可用。",
			"draw.needsKey": "还没有访问令牌，先到「接入」tab 配置。",
			"draw.reset": "回到默认",
			"draw.error": "出图设置保存失败：{error}",
			"draw.source.panel": "面板",
			"draw.source.config": "配置",
			"draw.absent.noTools": "开关已开，但本机 Host 未提供 agent tools 服务，出图工具缺席（Host 侧限制，非配置问题）。",
			"draw.absent.peerLoad": "开关已开，但 tools 模块加载失败，出图工具缺席（Host 问题，非配置）。",
			"draw.absent.registry": "开关已开，但工具注册被 Host 拒绝，出图工具缺席（Host 问题，非配置）。",
			"draw.absent.unknown": "开关已开，但出图工具未挂载，原因未知。",
			"trend.none": "还没有本地调用记录。",
			"trend.legend": "柱长相对区间内最大值，仅本地口径。",
			"events.none": "暂无事件。",
			"events.quota": "额度",
			"events.rate_limit": "限频",
			"events.error": "错误",
			"events.unknown": "未知",
			"token.status": "状态：{present}（来源 {source}，校验 {valid}）",
			"token.save": "保存",
			"token.forget": "忘掉已保存",
			"token.placeholder": "粘贴 ms-… 访问令牌",
			"token.ariaLabel": "魔搭访问令牌",
			"token.hint": "在魔搭「访问令牌」页生成。保存即生效（写入 DSH 凭据服务，不依赖重启）。环境变量 MODELSCOPE_API_KEY 只在 DSH 启动时读一次，且优先级高于此处保存的值——设了它就别再用面板存。",
			"token.ephemeral": "此 Host 没有凭据服务：面板保存的令牌重启即丢，请改用凭据服务或环境变量。",
			"token.readError": "读不到凭据存储，无法确认令牌状态（不代表没配令牌）：{error}",
			"token.link": "打开魔搭访问令牌页 →",
			"source.credentials": "凭据服务",
			"source.env": "环境变量",
			"source.memory": "内存",
			"source.none": "无",
			"present.yes": "已配置",
			"present.no": "未配置",
			"validity.yes": "有效",
			"validity.no": "未校验",
			"validity.bad": "无效",
			"composer.prefix": "魔搭",
			"composer.pillTitle": "魔搭额度：官方魔粒余额 + 今日本地调用次数",
			"composer.balanceUnit": "魔粒",
			"composer.localCalls": "今日本地 {calls} 次",
			"composer.stale": "上次数据"
		};
		en = {
			"panel.title": "ModelScope Access · Quota",
			"panel.refresh": "Refresh",
			"panel.updated": "Updated {time}",
			"panel.loading": "Loading…",
			"panel.error": "Read failed: {error}",
			"panel.configError": "Plugin misconfiguration: {error}",
			"panel.networkError": "Cannot reach the local Host — usually transient, the next auto-refresh will recover.",
			"panel.timeout": "Request timed out; the next auto-refresh will recover.",
			"panel.upstream": "ModelScope is temporarily unreadable; the next auto-refresh usually recovers.",
			"panel.internalError": "Internal plugin error — not a token or configuration problem. Check the DSH log for the plugin name.",
			"panel.authError": "Token rejected (401/403). Replace the access token in the Access tab.",
			"panel.noToken": "No ModelScope access token configured yet. Paste an ms-… token in the Access tab.",
			"panel.shapeDrift": "Upstream shape may have changed: {detail}",
			"panel.payloadError": "Host returned an unreadable response (a login wall or proxy may have intercepted it).",
			"shape.missingKeys": "Host snapshot omitted required top-level key(s): {keys}",
			"common.httpError": "Unexpected Host response (a login wall or proxy may have intercepted it).",
			"common.timeout": "Request timed out; please retry.",
			"tab.quota": "Quota",
			"tab.models": "Models",
			"tab.access": "Access",
			"section.balance": "Magicube balance (official)",
			"section.local": "Local calls (only through this plugin)",
			"section.trend": "Local call trend, last {days} days",
			"section.events": "Rate-limit and error events",
			"section.token": "Access token",
			"section.expand": "Expand",
			"section.collapse": "Collapse",
			"balance.available": "Available Magicube",
			"balance.total": "Total",
			"balance.frozen": "Frozen",
			"balance.fetched": "read at {time}",
			"balance.note": "Magicube is the official unit of ModelScope API-Inference quota; this number comes from the official endpoint (openapi/v1/magicubes/balance) and is the real balance. Frozen = held for in-flight tasks.",
			"balance.usagePage": "Official usage details (web) →",
			"balance.unavailable": "Magicube balance temporarily unreadable: {error}",
			"quota.headline": "Today {calls} calls · {models} models",
			"quota.note": "Local scope: only calls through this plugin are counted; clients calling ModelScope directly are not. Total consumption is governed by the official Magicube balance.",
			"quota.unavailable": "Local counters could not be read this time (reason in the notices above)",
			"probe.validity": "Verify token (free)",
			"probe.validOk": "Token valid (HTTP {status})",
			"probe.fail": "Failed: {error}",
			"models.viewOnSite": "View on ModelScope →",
			"models.viewOnSiteTitle": "Open the model page (per-model Magicube price is web-only)",
			"models.featuredTitle": "Recommended family (DeepSeek / Zhipu / Qwen)",
			"provider.featured": "Recommended",
			"section.provider": "Register as a DSH model",
			"provider.enable": "Register ModelScope models in the DSH model picker",
			"provider.on": "On",
			"provider.off": "Off",
			"provider.busy": "Switching…",
			"provider.registered": "Registered (models selectable in the picker)",
			"provider.notRegistered": "Not registered",
			"provider.llmMissing": "This Host exposes no LLM service",
			"provider.error": "Provider error: {error}",
			"provider.models": "Which models to enable",
			"provider.allowAll": "All",
			"provider.hideAll": "Hide all",
			"provider.saveList": "Save list",
			"provider.reset": "Reset",
			"provider.enabledCount": "{count} / {total} enabled",
			"provider.rosterHint": "Tick the models to offer; unticked = offer all",
			"provider.quotaExhausted": "Quota exhausted",
			"provider.vision": "vision",
			"provider.notConfigured": "No token yet — configure it in the Access tab",
			"provider.source.panel": "panel",
			"provider.source.config": "config",
			"provider.contextWindow": "Context window",
			"provider.contextDefault": "Default (catalog)",
			"provider.contextHint": "Applies to models whose catalog entry declares no window; re-registers immediately",
			"provider.contextCuratedTitle": "Window from the built-in curated table (models.dev cross-check), not declared by the platform; marked with *",
			"section.draw": "Draw tool",
			"draw.enable": "Register the modelscope_draw_image tool for the agent",
			"draw.on": "On",
			"draw.off": "Off",
			"draw.busy": "Switching…",
			"draw.mounted": "Registered: {tool}",
			"draw.notMounted": "Not registered — tick the switch above.",
			"draw.restartHint": "The switch saves at once, but the tool mounts at the NEXT Host start (a tool registration cannot be undone).",
			"draw.models": "Draw calls will use the models below",
			"draw.badge": "image",
			"draw.noCandidates": "This catalogue declares no image model (no entry with image-to-image / text-to-image); drawing is unavailable.",
			"draw.needsKey": "No token yet — configure it in the Access tab.",
			"draw.reset": "Reset",
			"draw.error": "Saving the draw settings failed: {error}",
			"draw.source.panel": "panel",
			"draw.source.config": "config",
			"draw.absent.noTools": "The switch is on, but this Host exposes no agent tools service; the draw tool is absent (a Host limitation, not config).",
			"draw.absent.peerLoad": "The switch is on, but the tools module failed to load; the draw tool is absent (a Host fault, not config).",
			"draw.absent.registry": "The switch is on, but the Host refused the tool registration; the draw tool is absent (a Host fault, not config).",
			"draw.absent.unknown": "The switch is on, but the draw tool is not mounted; the reason is unknown.",
			"trend.none": "No local call records yet.",
			"trend.legend": "Bar lengths are relative to the maximum in the range (local scope only).",
			"events.none": "No events.",
			"events.quota": "Quota",
			"events.rate_limit": "Rate limit",
			"events.error": "Error",
			"events.unknown": "Unknown",
			"token.status": "Status: {present} (source {source}, check {valid})",
			"token.save": "Save",
			"token.forget": "Forget saved",
			"token.placeholder": "Paste an ms-… access token",
			"token.ariaLabel": "ModelScope access token",
			"token.hint": "Generate one on the ModelScope access-token page. Saving takes effect immediately (written to the DSH credentials service, no restart needed). The MODELSCOPE_API_KEY environment variable is read once at DSH launch and ranks ABOVE a value saved here — set it and stop using the panel.",
			"token.ephemeral": "This Host has no credentials service: a token saved in the panel is lost on restart. Use the credentials service or an environment variable.",
			"token.readError": "Could not read the credential store, so the token state is unknown (this does NOT mean no token is configured): {error}",
			"token.link": "Open the ModelScope access-token page →",
			"source.credentials": "credentials",
			"source.env": "environment",
			"source.memory": "memory",
			"source.none": "none",
			"present.yes": "configured",
			"present.no": "not configured",
			"validity.yes": "verified",
			"validity.no": "unverified",
			"validity.bad": "invalid",
			"composer.prefix": "ModelScope",
			"composer.pillTitle": "ModelScope quota: official Magicube balance + today's local call count",
			"composer.balanceUnit": "Magicubes",
			"composer.localCalls": "local today {calls}",
			"composer.stale": "stale data"
		};
	}));

//#endregion
//#region src/client/format.ts
/**
	* Time and number formatters（与 sensenova 的 format.ts 同源、按需裁剪——去注释后
	* 代码行重叠 73%，与 agnes 那份已分家（45%）。2026-10-16 实测，复核
	* `node tools/dev/cross-repo-drift.mjs`）。
	*/
	/**
	* Host 声明的 cadence（秒）转毫秒；无可用数字时回退。Host 在源头已 clamp，
	* 面板不做第二次 opinion；亚秒值向上取整到 1s（setInterval 的 0 = 尽快）。
	*/
	function statedCadenceMs(seconds, fallbackMs) {
		if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
		return Math.max(1, Math.floor(seconds)) * 1e3;
	}
	/** `MM-DD HH:mm`（事件时间戳用）。 */
	function clockLong(epoch) {
		if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
		const date = /* @__PURE__ */ new Date(epoch * 1e3);
		const pad = (value) => String(value).padStart(2, "0");
		return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}
	/** ISO 字符串 → `MM-DD HH:mm`；非法输入返回 "—"。 */
	function isoTime(iso) {
		if (typeof iso !== "string" || iso === "") return "—";
		const epoch = Date.parse(iso);
		return Number.isNaN(epoch) ? "—" : clockLong(epoch / 1e3);
	}
	/** 数字文本：≥10000 整数千分位，否则最多两位小数。 */
	function count(value) {
		const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
		if (number >= 1e4) return Math.round(number).toLocaleString();
		return String(Math.round(number * 100) / 100);
	}
	/** 填 `{key}` 模板：vars 的每个键对应模板里的同名占位符。 */
	function format(template, vars) {
		let text = template;
		for (const [key, value] of Object.entries(vars || {})) text = text.split(`{${key}}`).join(String(value));
		return text;
	}
	/** catch 到的值 → 面板唯一错误行；绝不 `[object Object]`。 */
	function errorText(why) {
		if (why instanceof Error) return why.message;
		if (typeof why === "string") return why;
		if (why === null || why === void 0) return String(why);
		try {
			return JSON.stringify(why) ?? String(why);
		} catch {
			return String(why);
		}
	}
	var init_format = __esmMin((() => {}));

//#endregion
//#region src/client/runtime.ts
/** Hand the loader-provided React to the rest of the client. One-shot. */
	function provideClientReact(value) {
		if (typeof value !== "object" || value === null) throw new Error("client: the loader did not hand over a react module");
		api = value;
	}
	function reactApi() {
		if (api === null) throw new Error("client: react used before clientFactory ran");
		return api;
	}
	var api, h, useState, useEffect, useCallback, useMemo, useRef;
	var init_runtime = __esmMin((() => {
		api = null;
		h = (type, props, ...children) => reactApi().createElement(type, props, ...children);
		useState = (initial) => reactApi().useState(initial);
		useEffect = (effect, deps) => reactApi().useEffect(effect, deps);
		useCallback = (callback, deps) => reactApi().useCallback(callback, deps);
		useMemo = (factory, deps) => reactApi().useMemo(factory, deps);
		useRef = (initial) => reactApi().useRef(initial);
	}));

//#endregion
//#region src/client/styles.ts
	var BRAND, BUTTON, S;
	var init_styles = __esmMin((() => {
		BRAND = "var(--modelscope-brand, #7B3FF2)";
		BUTTON = {
			height: 30,
			padding: "0 12px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			cursor: "pointer"
		};
		S = {
			page: {
				flex: "1 1 auto",
				height: "100%",
				minHeight: 0,
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
				color: "var(--dsw-alias-label-primary)",
				fontSize: 14,
				lineHeight: "22px"
			},
			headerBar: {
				flex: "none",
				background: "var(--dsw-alias-bg-base)",
				position: "relative",
				zIndex: 1
			},
			header: {
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "16px 0 12px"
			},
			scroll: {
				flex: 1,
				minHeight: 0,
				overflowY: "auto",
				overflowX: "hidden"
			},
			content: { padding: "6px 0 56px" },
			tabBar: {
				display: "flex",
				gap: 4,
				borderBottom: "1px solid var(--dsw-alias-border-l1)",
				marginBottom: 4
			},
			tab: {
				appearance: "none",
				background: "none",
				border: "none",
				borderBottom: "2px solid transparent",
				padding: "8px 12px",
				fontSize: 13,
				color: "var(--dsw-alias-label-secondary)",
				cursor: "pointer",
				outlineOffset: -2
			},
			tabActive: {
				color: "var(--dsw-alias-label-primary)",
				fontWeight: 600,
				borderBottom: `2px solid ${BRAND}`
			},
			title: {
				margin: 0,
				fontSize: 20,
				fontWeight: 600,
				lineHeight: "28px"
			},
			updated: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 12
			},
			spacer: { flex: 1 },
			cluster: {
				display: "inline-flex",
				alignItems: "center",
				gap: 12,
				flexWrap: "wrap",
				justifyContent: "flex-end"
			},
			button: BUTTON,
			sectionTitle: {
				margin: "22px 0 10px",
				fontSize: 13,
				fontWeight: 600,
				color: "var(--dsw-alias-label-secondary)"
			},
			sectionCard: {
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 12,
				background: "var(--dsw-alias-bg-layer-1)",
				overflow: "hidden",
				marginTop: 22
			},
			sectionHead: {
				display: "flex",
				alignItems: "center",
				gap: 12,
				width: "100%",
				padding: "12px 16px",
				background: "none",
				border: "none",
				cursor: "pointer",
				textAlign: "left"
			},
			sectionHeadTitle: {
				flex: 1,
				minWidth: 0,
				fontSize: 15,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)"
			},
			chevron: {
				display: "inline-flex",
				flex: "none",
				transition: "transform 0.15s ease",
				color: "var(--dsw-alias-label-secondary)"
			},
			chevronOpen: { transform: "rotate(180deg)" },
			sectionBody: {
				borderTop: "1px solid var(--dsw-alias-border-l1)",
				margin: "0 16px",
				padding: "12px 0 16px"
			},
			card: {
				background: "var(--dsw-alias-bg-layer-1)",
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 12,
				padding: 16
			},
			poolName: {
				fontSize: 15,
				fontWeight: 600
			},
			quotaLabel: {
				fontSize: 12,
				fontWeight: 500,
				color: "var(--dsw-alias-label-secondary)"
			},
			statGrid: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 110px), 1fr))",
				gap: 10,
				marginTop: 12
			},
			statCard: {
				display: "flex",
				flexDirection: "column",
				gap: 4,
				minWidth: 0,
				padding: "10px 12px",
				borderRadius: 10,
				background: "var(--dsw-alias-bg-layer-2)"
			},
			statValue: {
				fontSize: 16,
				fontWeight: 600,
				lineHeight: "20px",
				fontVariantNumeric: "tabular-nums"
			},
			quotaUsed: {
				fontSize: 11,
				lineHeight: "15px",
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums"
			},
			barFill: {
				height: "100%",
				borderRadius: 3,
				background: BRAND
			},
			modelTag: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 11,
				padding: "2px 6px",
				borderRadius: 6,
				background: "var(--dsw-alias-bg-layer-2)",
				border: "1px solid var(--dsw-alias-border-l1)"
			},
			trendRow: {
				display: "flex",
				flexDirection: "column",
				gap: 8,
				padding: "10px 0",
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			trendRowHead: {
				display: "flex",
				alignItems: "baseline",
				justifyContent: "space-between",
				gap: 12,
				minWidth: 0
			},
			trendModel: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12,
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			trendCredits: {
				fontSize: 13,
				fontWeight: 600,
				fontVariantNumeric: "tabular-nums"
			},
			trendBar: {
				height: 6,
				borderRadius: 3,
				background: "var(--dsw-alias-bg-layer-2)",
				overflow: "hidden"
			},
			trendLegend: {
				marginTop: 10,
				fontSize: 11,
				lineHeight: "16px",
				color: "var(--dsw-alias-label-secondary)"
			},
			trendChartBars: {
				display: "flex",
				alignItems: "flex-end",
				gap: 2,
				height: 96,
				padding: "0 1px"
			},
			trendChartBar: {
				flex: 1,
				minWidth: 2,
				height: "100%",
				display: "flex",
				alignItems: "flex-end",
				position: "relative"
			},
			trendChartFill: {
				width: "100%",
				minHeight: 2,
				borderRadius: 2,
				background: BRAND
			},
			trendChartValue: {
				position: "absolute",
				left: 0,
				right: 0,
				fontSize: 9,
				lineHeight: 1,
				textAlign: "center",
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums",
				pointerEvents: "none"
			},
			trendChartAxis: {
				display: "flex",
				justifyContent: "space-between",
				gap: 12,
				marginTop: 6,
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary)"
			},
			muted: { color: "var(--dsw-alias-label-secondary)" },
			error: { color: "var(--dsw-alias-state-error-primary)" },
			empty: {
				color: "var(--dsw-alias-label-secondary)",
				padding: "18px 0"
			},
			input: {
				height: 32,
				padding: "0 10px",
				borderRadius: 8,
				fontSize: 13,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-primary)"
			},
			/** Real shell tokens — replaces the color-mix hack that faked "on-primary". */
			primary: {
				height: 32,
				padding: "0 16px",
				borderRadius: 8,
				fontSize: 13,
				fontWeight: 500,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-button-primary-fill)",
				color: "var(--dsw-alias-label-primary-foreground)",
				cursor: "pointer"
			},
			formError: {
				color: "var(--dsw-alias-state-error-primary)",
				fontSize: 12,
				margin: "10px 0 0"
			},
			formNote: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 12,
				margin: "10px 0 0"
			},
			rosterTools: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				flexWrap: "wrap",
				marginBottom: 10
			},
			rosterCount: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums",
				marginLeft: "auto"
			},
			rosterBulk: {
				...BUTTON,
				height: 32
			},
			modelList: {
				display: "flex",
				flexDirection: "column",
				margin: 0,
				padding: 0,
				listStyle: "none"
			},
			modelRow: {
				display: "flex",
				flexDirection: "column",
				gap: 2,
				padding: "8px 4px",
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			modelRowHead: {
				display: "flex",
				alignItems: "center",
				gap: 8
			},
			modelRowOff: { opacity: .55 },
			modelCheck: {
				flex: "none",
				width: 15,
				height: 15,
				cursor: "pointer",
				accentColor: BRAND,
				margin: 0
			},
			modelName: {
				flex: "0 1 auto",
				minWidth: 0,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			modelBadge: {
				flex: "none",
				fontSize: 11,
				padding: "1px 7px",
				borderRadius: 999,
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-secondary)"
			},
			modelBadgeFeatured: {
				flex: "none",
				fontSize: 11,
				padding: "1px 7px",
				borderRadius: 999,
				background: "var(--dsw-alias-bg-layer-2)",
				color: BRAND,
				fontWeight: 600
			},
			rosterFoot: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				marginTop: 10
			},
			modelPanel: {
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 12,
				background: "var(--dsw-alias-bg-layer-1)",
				padding: "12px 14px"
			},
			pillTrigger: {
				appearance: "none",
				WebkitAppearance: "none",
				height: 28,
				borderStyle: "none",
				borderWidth: 0,
				background: "none",
				color: "inherit",
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				padding: "0 10px",
				borderRadius: 999,
				fontSize: 12,
				fontWeight: 600,
				lineHeight: "18px",
				cursor: "default",
				flexShrink: 0,
				whiteSpace: "nowrap"
			},
			pillDot: {
				width: 8,
				height: 8,
				borderRadius: 999,
				flex: "none",
				background: "var(--dsw-alias-label-secondary)"
			},
			pillPlan: { opacity: .72 },
			pillStale: {
				opacity: .62,
				fontStyle: "italic"
			},
			pillTierOk: "#22c55e",
			pillTierExhausted: "#ef4444",
			pillTierUnknown: "#9ca3af",
			pillTierExhaustedText: { color: "var(--dsw-alias-state-error-primary)" }
		};
	}));

//#endregion
//#region src/shared/codes.ts
	var CODE;
	var init_codes = __esmMin((() => {
		CODE = Object.freeze({
			CONFIG_ERROR: "config_error",
			NETWORK_ERROR: "network_error",
			TIMEOUT_ERROR: "timeout_error",
			AUTH_ERROR: "auth_error",
			RATE_LIMITED: "rate_limited",
			QUOTA_EXCEEDED: "quota_exceeded",
			UPSTREAM_ERROR: "upstream_error",
			/**
			* 插件自身抛错（聚合器、状态层、路由之外的意外）。
			*
			* 曾经只作为 `soft()` / `failureCode()` 的兜底字符串出现在快照里，没进这张
			* 表——于是 Client 的 `GUIDANCE_BY_CODE` 也没法映射它（那份映射被测试钉住
			* 「每个键必须在 CODE 里」），最需要人看的内部错误反而没有引导文案。
			* 正式收进码表，两端从此同一份真源。
			*/
			INTERNAL_ERROR: "internal_error",
			/**
			* Client 自产码：Host 响应无法解读成快照（非 JSON / 缺 ok 字段）时，
			* 面板用它走引导文案，而不是把裸英文串（"unexpected payload"）上屏。
			*
			* 本表是 `GUIDANCE_BY_CODE` 的键集真源——新增 client 码必须同时进
			* 这张表，两侧才同步。
			*/
			PAYLOAD_ERROR: "payload_error"
		});
	}));

//#endregion
//#region src/client/snapshot.ts
/**
	* 缺失块的空形状，**逐字对齐 Host 的降级实现**（`snapshot-aggregate.ts` 各
	* `soft()` 失败分支、TokenStatus 的失败分支）。
	*
	* `provider` 块现在是**省略**而不是由 Host 塞一个降级块（2026-10-17）：Host 那份
	* 降级形状「看起来就是一个答案」，面板据此认为块在、不再走 `GET /provider` 兜底，
	* 于是只能拿编出来的值渲染。省略之后，兜底真的跑起来，降级形状只剩这里一份。
	*
	* 这里的每一条都是「Host 那一路失败时真的产出的形状」，不是随手捏的：面板渲染
	* 的每一个字段都必须有一个与 Host 同构的空值，否则补出来的空块自己就会炸——
	* 那正是本函数存在的原因。
	*/
	function emptyBlock(key) {
		switch (key) {
			case "token": return {
				present: false,
				source: "none",
				valid: null,
				checkedAt: null,
				ephemeral: true,
				readError: null
			};
			case "balance": return {
				available: null,
				total: null,
				frozen: null,
				fetchedAt: null,
				error: null
			};
			case "quota": return {
				daily: { usedLocal: null },
				perModel: [],
				countingNote: "local-counting"
			};
			case "events": return [];
			case "trend": return {
				days: 0,
				buckets: []
			};
			case "models": return {
				available: false,
				count: 0,
				sample: [],
				error: null
			};
			case "provider": return DEGRADED_PROVIDER;
			case "shapeWarnings":
			case "quotaError": return key === "quotaError" ? null : [];
			default: return;
		}
	}
	/** 把缺失的顶层键补成空形状（不改原body，返回新对象）。 */
	function withEmptyBlocks(raw, missingKeys) {
		const out = { ...raw };
		for (const key of missingKeys) out[key] = emptyBlock(key);
		return out;
	}
	/**
	* 读一个快照应答。HTTP 恒 200，成败看 body.ok。
	*
	* `ok:true` 的body **必须**带齐 {@link SNAPSHOT_REQUIRED_KEYS} 的每个顶层键，
	* 缺一个都在这里被归一，而不是留到渲染期炸掉。曾经这里是裸 cast，于是
	* `panel-page.ts` 里 `data?.models.sample[0]` 这类解引用会抛 TypeError 把整个面板
	* 炸掉——`data?.` 只护住了 `data` 本身，护不住它下面的 `models`。而那一行在
	* **所有 tab 上都执行**，所以任意一个键缺失都不止炸当前 tab。
	*
	* 缺键走两件事：把确实缺的那个块补成同构的空形状（让面板渲染「空」而不是
	* 崩），并把缺失名单带进 `shapeWarnings` 的等价物——`SnapshotRead` 上的
	* `missingKeys`，由 `viewOf` 呈现给用户。**不**静默：Host 少给键是双端契约
	* 漂移，用户该看见。
	*/
	function interpretSnapshot(body) {
		const payload = body;
		if (payload && payload.ok === false) {
			const code = typeof payload.code === "string" && payload.code !== "" ? payload.code : CODE.PAYLOAD_ERROR;
			return {
				data: null,
				error: {
					message: typeof payload.error === "string" && payload.error !== "" ? payload.error : null,
					code
				}
			};
		}
		if (!payload || payload.ok !== true) return {
			data: null,
			error: {
				message: null,
				code: CODE.PAYLOAD_ERROR
			}
		};
		const raw = payload;
		const missingKeys = SNAPSHOT_REQUIRED_KEYS.filter((key) => raw[key] === void 0);
		return {
			data: missingKeys.length === 0 ? raw : withEmptyBlocks(raw, missingKeys),
			error: null,
			missingKeys
		};
	}
	/**
	* 把 wire/路由返回的 provider 块归一成 `ProviderStatus`；不合法一律降级。
	* 形状由 wire.ts 钉死，本函数只做防御性归一（旧 Host 可能缺字段）。
	*/
	function providerOf$1(raw) {
		if (raw === null || typeof raw !== "object") return DEGRADED_PROVIDER;
		const p = raw;
		const ids = Array.isArray(p.enabledIds) ? p.enabledIds.map((id) => String(id ?? "")).filter((id) => id !== "") : [];
		const roster = Array.isArray(p.roster) ? p.roster.map((entry) => {
			const row = entry ?? {};
			const id = String(row.id ?? "");
			const w = row.contextWindow;
			const contextSource = row.contextSource === "override" || row.contextSource === "curated" ? row.contextSource : "catalog";
			return {
				id,
				name: typeof row.name === "string" && row.name !== "" ? row.name : id,
				vision: row.vision === true,
				available: row.available !== false,
				quotaExhausted: row.quotaExhausted === true,
				contextSource,
				...typeof w === "number" && Number.isFinite(w) && w > 0 ? { contextWindow: w } : {}
			};
		}).filter((entry) => entry.id !== "") : [];
		return {
			enabled: p.enabled === true,
			source: p.source === "panel" ? "panel" : "config",
			llmAvailable: p.llmAvailable === true,
			registered: p.registered === true,
			error: typeof p.error === "string" ? p.error : null,
			modelCount: typeof p.modelCount === "number" && Number.isFinite(p.modelCount) ? p.modelCount : roster.length,
			enabledCount: typeof p.enabledCount === "number" && Number.isFinite(p.enabledCount) ? p.enabledCount : 0,
			allowed: p.allowed === "none" ? "none" : p.allowed === "list" ? "list" : "all",
			enabledIds: ids,
			contextWindow: typeof p.contextWindow === "number" && Number.isFinite(p.contextWindow) && p.contextWindow > 0 ? p.contextWindow : null,
			roster
		};
	}
	/** 非 2xx 响应的降级读法（无 body，状态码是唯一线索）。 */
	function errorOfStatus(status) {
		if (status === 401 || status === 403) return {
			message: `HTTP ${status}`,
			code: "auth_error"
		};
		return `HTTP ${status}`;
	}
	/**
	* 把 wire/路由返回的出图块归一成 `DrawStatus`；不合法一律降级。
	*
	* 与 `providerOf` 同一套防御性归一（旧 Host 可能缺字段）。`absentReason` 只认三个
	* 已知码——上游若新增第四个，归一到 `null` 而不是把它透传成渲染不出的值；面板的
	* 「缺席」措辞有兜底键，但**状态本身**宁可显示「未知」也不假装认识它。
	* @param {unknown} raw - 原始块。
	* @returns {DrawStatus} 归一后的状态。
	*/
	function drawOf(raw) {
		if (raw === null || typeof raw !== "object") return DEGRADED_DRAW;
		const d = raw;
		const candidates = Array.isArray(d.candidateIds) ? d.candidateIds.map((id) => String(id ?? "")).filter((id) => id !== "") : [];
		const reason = d.absentReason;
		const absentReason = reason === "no-tools-service" || reason === "peer-load-failed" || reason === "registry-refused" ? reason : null;
		return {
			enabled: d.enabled === true,
			source: d.source === "panel" ? "panel" : "config",
			candidateIds: candidates,
			candidateCount: typeof d.candidateCount === "number" && Number.isFinite(d.candidateCount) ? d.candidateCount : candidates.length,
			preferredModel: typeof d.preferredModel === "string" && d.preferredModel !== "" ? d.preferredModel : null,
			preferredSource: d.preferredSource === "panel" ? "panel" : "config",
			absentReason,
			mountPending: d.mountPending === true,
			toolName: typeof d.toolName === "string" && d.toolName !== "" ? d.toolName : "modelscope_draw_image"
		};
	}
	/**
	* 面板决策：这张快照意味着什么。纯函数，Node 套件驱动同一个函数。
	*
	* `missingKeys` 是 `interpretSnapshot` 查出的缺失顶层键（非空 = 双端契约漂移）。
	* 它**不**把面板变成错误态——数据能渲染就渲染——但会作为一条 shapeWarning
	* 冒到面板上，因为「Host 少给了键」是维护者要修的事，用户该看见而不是面对
	* 一个悄悄少了一半信息的界面。
	*/
	function viewOf(data, error, tt, missingKeys = []) {
		const failure = error === null || error === void 0 ? null : typeof error === "string" ? {
			message: error,
			code: null
		} : error;
		const needsSetup = data === null && !FORM_EXCLUDED_CODES.has(failure?.code ?? null);
		const guidanceKey = failure === null ? null : GUIDANCE_BY_CODE[failure.code] ?? null;
		const guidance = guidanceKey === null ? null : guidanceKey === "panel.configError" ? format(tt(guidanceKey), { error: failure?.message }) : tt(guidanceKey);
		const shapeWarnings = Array.isArray(data?.shapeWarnings) ? [...data.shapeWarnings] : [];
		if (missingKeys.length > 0) shapeWarnings.push(format(tt("shape.missingKeys"), { keys: missingKeys.join(", ") }));
		return {
			failure,
			needsSetup,
			guidanceKey,
			guidance,
			shapeWarnings
		};
	}
	var DEGRADED_PROVIDER, DEGRADED_DRAW, GUIDANCE_BY_CODE, FORM_EXCLUDED_CODES;
	var init_snapshot = __esmMin((() => {
		init_format();
		init_wire();
		init_codes();
		DEGRADED_PROVIDER = Object.freeze({
			enabled: false,
			source: "config",
			llmAvailable: false,
			registered: false,
			error: "unavailable",
			modelCount: 0,
			enabledCount: 0,
			allowed: "all",
			enabledIds: [],
			contextWindow: null,
			roster: []
		});
		DEGRADED_DRAW = Object.freeze({
			enabled: false,
			source: "config",
			candidateIds: [],
			candidateCount: 0,
			preferredModel: null,
			preferredSource: "config",
			absentReason: null,
			mountPending: false,
			toolName: "modelscope_draw_image"
		});
		GUIDANCE_BY_CODE = Object.freeze({
			auth_error: "panel.authError",
			config_error: "panel.configError",
			network_error: "panel.networkError",
			timeout_error: "panel.timeout",
			upstream_error: "panel.upstream",
			rate_limited: "panel.upstream",
			quota_exceeded: "panel.upstream",
			internal_error: "panel.internalError",
			payload_error: "panel.payloadError"
		});
		FORM_EXCLUDED_CODES = Object.freeze(/* @__PURE__ */ new Set([
			"config_error",
			"network_error",
			"timeout_error",
			"upstream_error",
			"rate_limited",
			"quota_exceeded",
			"internal_error",
			"payload_error"
		]));
	}));

//#endregion
//#region src/client/toggle-switch.ts
/**
	* 滑杆开关 + 短标签 + tooltip。
	* @param props - 见 {@link ToggleSwitchProps}。
	* @returns 包着真 checkbox input 的 `<label>` 树。
	*/
	function ToggleSwitch({ checked, onChange, label, busyLabel, busy = false, title }) {
		const on = checked === true;
		const text = busy && busyLabel !== void 0 ? busyLabel : label;
		return h("label", {
			style: {
				display: "inline-flex",
				alignItems: "center",
				gap: 8,
				position: "relative",
				cursor: busy ? "wait" : "pointer",
				opacity: busy ? .55 : 1,
				verticalAlign: "middle"
			},
			...title !== void 0 && title !== "" ? { title } : {}
		}, h("span", { style: {
			position: "relative",
			display: "inline-block",
			width: TRACK_W,
			height: TRACK_H,
			flex: "none"
		} }, h("input", {
			type: "checkbox",
			checked: on,
			disabled: busy,
			onChange,
			style: {
				position: "absolute",
				inset: 0,
				width: TRACK_W,
				height: TRACK_H,
				margin: 0,
				opacity: 0,
				cursor: busy ? "wait" : "pointer"
			}
		}), h("span", {
			"aria-hidden": "true",
			style: {
				position: "absolute",
				inset: 0,
				borderRadius: 999,
				pointerEvents: "none",
				border: `1px solid ${on ? BRAND : "var(--dsw-alias-border-l2, #36373b)"}`,
				background: on ? BRAND : "var(--dsw-alias-bg-layer-2, #2a2b31)",
				transition: "background .15s, border-color .15s"
			}
		}, h("span", { style: {
			position: "absolute",
			top: 1.5,
			left: 1.5,
			width: THUMB,
			height: THUMB,
			borderRadius: "50%",
			background: on ? "#fff" : "var(--dsw-alias-label-tertiary, #999)",
			transform: on ? `translateX(${TRAVEL}px)` : "translateX(0)",
			transition: "transform .15s, background .15s"
		} }))), h("span", { style: {
			fontSize: 13,
			color: "var(--dsw-alias-label-primary, #e6e6e6)"
		} }, text));
	}
	var TRACK_W, TRACK_H, THUMB, TRAVEL;
	var init_toggle_switch = __esmMin((() => {
		init_runtime();
		init_styles();
		TRACK_W = 30;
		TRACK_H = 17;
		THUMB = 12;
		TRAVEL = 13;
	}));

//#endregion
//#region src/shared/allow-list.ts
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
	* 面板草稿 → 落盘清单的归一：哨兵独占态。
	*
	* 草稿含哨兵（「全部隐藏」）时落盘值只保留哨兵——不能让它与真实 id 混排：
	* Host 把混排判 `none`，而面板会把混排里的真实 id 画成勾中，「已启用 N」
	* 与实际提供 0 个撒谎（踩过，见 cards.ts 的注释）。其余情况剥掉哨兵、
	* 滤掉空串后原样落盘。
	* @param {readonly unknown[]} draft - 面板勾选的草稿。
	* @returns {string[]} 落盘的 `enabledIds`。
	*/
	function normalizeRosterSave(draft) {
		return rosterSaveOf(parseAllowedList(draft));
	}
	/**
	* 联合 → 落盘清单（{@link parseAllowedList} 的逆运算）：`none` 序列化成
	* 哨兵清单，`all` 序列化成空清单（「不过滤」的拼写），`list` 原样带出 id。
	* @param {AllowedList} list - 联合。
	* @returns {string[]} 线编码的 `enabledIds`。
	*/
	function rosterSaveOf(list) {
		switch (list.mode) {
			case "all": return [];
			case "none": return [HIDE_ALL_MODELS];
			case "list": return [...list.ids];
		}
	}
	/** 「全部隐藏」的落盘清单（{@link rosterSaveOf} 的 `none` 特例；每次新数组）。 */
	function hideAllRoster() {
		return rosterSaveOf({ mode: "none" });
	}
	var init_allow_list = __esmMin((() => {
		init_wire();
	}));

//#endregion
//#region src/client/cards.ts
/** 可折叠 section 卡：全宽头部按钮 + 旋转 chevron；open/onToggle 由 props 进。 */
	function SectionCard({ title, open, onToggle, children, tt }) {
		return h("div", { style: S.sectionCard }, h("button", {
			type: "button",
			style: S.sectionHead,
			"aria-expanded": open,
			"aria-label": `${tt(open ? "section.collapse" : "section.expand")}: ${title}`,
			onClick: onToggle
		}, h("span", { style: S.sectionHeadTitle }, title), h("svg", {
			viewBox: "0 0 16 16",
			width: 14,
			height: 14,
			fill: "none",
			stroke: "currentColor",
			strokeWidth: "1.5",
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
			style: open ? {
				...S.chevron,
				...S.chevronOpen
			} : S.chevron
		}, h("path", { d: "M3 6l5 5 5-5" }))), h("div", {
			style: S.sectionBody,
			hidden: !open
		}, open ? children : null));
	}
	/** 官方魔粒余额头条：三格（可用/总额/冻结）+ 来源说明。null 渲染「—」。 */
	function BalanceCard({ balance, tt }) {
		if (balance === null || typeof balance !== "object") return null;
		const row = balance;
		if (row.error !== null && row.error !== void 0) return h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-error-primary)",
			margin: 0
		} }, format(tt("balance.unavailable"), { error: row.error }));
		if (row.available === null && row.total === null) return null;
		const tile = (label, value) => h("div", { style: S.statCard }, h("div", { style: S.statValue }, typeof value === "number" && Number.isFinite(value) ? count(value) : "—"), h("div", { style: S.quotaLabel }, label));
		return h("div", { style: S.card }, h("div", { style: S.statGrid }, tile(tt("balance.available"), row.available), tile(tt("balance.total"), row.total), tile(tt("balance.frozen"), row.frozen)), h("div", { style: S.trendLegend }, row.fetchedAt !== null && row.fetchedAt !== void 0 ? format(tt("balance.fetched"), { time: isoTime(row.fetchedAt) }) + " · " : "", tt("balance.note"), " ", h("a", {
			style: S.formNote,
			href: MODELSCOPE_USAGE_URL,
			target: "_blank",
			rel: "noreferrer"
		}, tt("balance.usagePage"))));
	}
	/**
	* 本地调用卡：纯统计口径——今日次数 + 按模型分布 + 一句口径说明。
	* 刻意**不画**「推算剩余/参考上限」进度条：官方已改为魔粒计费，「2000 次」
	* 是次数口径的社区快照，与魔粒余额并排展示是误导（README「三条事实」#2）。
	* 本地计数回答的是官方余额回答不了的问题：哪个模型在烧、何时撞的 429。
	*/
	function LocalDailyCard({ snapshot, tt }) {
		const quota = snapshot.quota;
		const daily = quota?.daily ?? { usedLocal: null };
		const perModel = Array.isArray(quota?.perModel) ? quota.perModel : [];
		const unknownUsed = !(typeof daily.usedLocal === "number" && Number.isFinite(daily.usedLocal));
		const usedText = unknownUsed ? "—" : count(daily.usedLocal);
		return h("div", { style: S.card }, h("div", { style: S.poolName }, format(tt("quota.headline"), {
			calls: usedText,
			models: count(perModel.length)
		})), unknownUsed ? h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, tt("quota.unavailable")) : null, h(ModelUsageTable, {
			rows: perModel,
			tt
		}), h("div", { style: S.trendLegend }, tt("quota.note")));
	}
	/** 今日单模型排行（相对最大者画条）。 */
	function ModelUsageTable({ rows, tt }) {
		if (!Array.isArray(rows) || rows.length === 0) return h("div", { style: S.trendLegend }, tt("trend.none"));
		const max = Math.max(0, ...rows.map((r) => Math.max(0, Number(r.calls) || 0)));
		return h("div", null, rows.map((row) => {
			const pct = max > 0 ? row.calls / max * 100 : 0;
			return h("div", {
				key: row.modelId,
				style: S.trendRow
			}, h("div", { style: S.trendRowHead }, h("span", {
				style: S.trendModel,
				title: row.modelId
			}, row.modelId), h("span", { style: S.trendCredits }, count(row.calls) + (row.tokens !== null ? ` · ${count(row.tokens)}t` : ""))), pct >= 1 ? h("div", {
				style: S.trendBar,
				role: "progressbar",
				"aria-valuenow": Math.round(pct),
				"aria-valuemin": 0,
				"aria-valuemax": 100
			}, h("div", { style: {
				...S.barFill,
				width: `${pct}%`
			} })) : null);
		}), h("div", { style: S.trendLegend }, tt("trend.legend")));
	}
	/**
	* 轴上的日期短标注：砍掉年份与补零（`2026-09-18` → `9-18`）。
	*
	* 轴的跨度最多 trendDays（默认 14，多在同年内），年份在刻度间重复出现，占掉的
	* 宽度全是从图的呼吸里匀来的；补零的 `09` 同样多占一格而没多给信息。不是
	* `YYYY-MM-DD` 形状时原样返回——宁可显示一个陌生字符串，也不按位置硬切。
	* @param {string} key - 天桶 dateKey（本地日期 YYYY-MM-DD）。
	* @returns {string} 短标注。
	*/
	function shortDateKey(key) {
		const value = typeof key === "string" ? key : "";
		const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(value);
		return match === null ? value : `${Number(match[1])}-${Number(match[2])}`;
	}
	/**
	* 轴刻度落在哪些桶上（返回下标）。
	*
	* 桶数 ≤ {@link MAX_TICKS} 时逐日都标；否则按 `(n-1)/(MAX_TICKS-1)` 等距取点、
	* 首尾必含——与姊妹插件 Agnes 的用量图同一取法（它 30 天标 7 个）。等距取点是
	* 对**下标**取整而不是对像素分均，所以刻度与其柱子所属的区间大体对齐，只是轴
	* 用 `space-between` 铺开；两端的日期恒为真实首末日。
	* @param {number} count - 桶数。
	* @returns {number[]} 升序下标。
	*/
	function tickIndices(count) {
		if (!Number.isFinite(count) || count <= 0) return [];
		if (count <= MAX_TICKS) return Array.from({ length: count }, (_, index) => index);
		const step = (count - 1) / 6;
		const out = [];
		for (let tick = 0; tick < MAX_TICKS; tick += 1) {
			const index = Math.round(tick * step);
			if (index > (out[out.length - 1] ?? -1)) out.push(index);
		}
		return out;
	}
	/** 近 N 天本地调用趋势（天桶；缺桶 = 该日 0 次，真实零）——**竖向柱状图**。 */
	function TrendBars({ buckets, tt }) {
		if (!Array.isArray(buckets) || buckets.length === 0) return h("div", { style: S.trendLegend }, tt("trend.none"));
		const rows = buckets.map((bucket) => ({
			dateKey: bucket.dateKey,
			calls: Number.isFinite(bucket.calls) ? Math.max(0, bucket.calls) : 0
		}));
		const max = Math.max(0, ...rows.map((row) => row.calls));
		return h("div", null, h("div", { style: S.trendChartBars }, rows.map((row) => {
			const pct = max > 0 ? row.calls / max * 100 : 0;
			return h("div", {
				key: row.dateKey,
				style: S.trendChartBar,
				title: `${row.dateKey}: ${count(row.calls)}`
			}, row.calls > 0 ? h("span", {
				style: {
					...S.trendChartValue,
					bottom: `calc(${pct}% + 3px)`
				},
				"aria-hidden": "true"
			}, count(row.calls)) : null, h("div", {
				style: {
					...S.trendChartFill,
					height: `${pct}%`
				},
				role: "progressbar",
				"aria-label": `${row.dateKey} ${count(row.calls)}`,
				"aria-valuenow": Math.round(pct),
				"aria-valuemin": 0,
				"aria-valuemax": 100
			}));
		})), h("div", { style: S.trendChartAxis }, tickIndices(rows.length).map((index) => {
			const key = rows[index]?.dateKey ?? "";
			return h("span", {
				key,
				title: key,
				style: { whiteSpace: "nowrap" }
			}, shortDateKey(key));
		})), h("div", { style: S.trendLegend }, tt("trend.legend")));
	}
	/** 事件流（429/错误），Newest-first。 */
	function EventsList({ events, tt }) {
		if (!Array.isArray(events) || events.length === 0) return h("div", { style: S.trendLegend }, tt("events.none"));
		return h("div", null, events.map((event, index) => h("div", {
			key: `${event.at}-${index}`,
			style: S.trendRowHead
		}, h("span", { style: S.quotaUsed }, isoTime(event.at)), h("span", { style: S.modelTag }, tt(EVENT_KIND_KEY[event.kind] ?? "events.unknown")), h("span", {
			style: {
				...S.trendModel,
				flex: "1"
			},
			title: event.message
		}, event.message))));
	}
	/** 令牌表单：保存 / 忘掉 / 验令牌 + 状态行 + 外链。唯一持 state 的展示组件。 */
	function TokenForm({ token, busy, error, onSave, onForget, onVerify, verifyTitle, tt }) {
		const [value, setValue] = useState("");
		const source = token?.source ?? "none";
		const sourceKey = source === "credentials" ? "source.credentials" : source === "env" ? "source.env" : source === "memory" ? "source.memory" : "source.none";
		const validKey = token?.valid === true ? "validity.yes" : token?.valid === false ? "validity.bad" : "validity.no";
		return h("div", null, token?.readError ? h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, format(tt("token.readError"), { error: token.readError })) : h("div", { style: S.quotaUsed }, format(tt("token.status"), {
			present: token?.present ? tt("present.yes") : tt("present.no"),
			source: tt(sourceKey),
			valid: tt(validKey)
		})), token?.ephemeral ? h("div", { style: S.formNote }, tt("token.ephemeral")) : null, h("div", { style: S.rosterTools }, h("input", {
			style: S.input,
			type: "password",
			placeholder: tt("token.placeholder"),
			"aria-label": tt("token.ariaLabel"),
			value,
			onChange: (event) => setValue(String(event.target.value ?? ""))
		}), h("button", {
			type: "button",
			style: S.primary,
			disabled: busy,
			onClick: () => {
				onSave(value);
				setValue("");
			}
		}, tt("token.save")), token?.present ? h("button", {
			type: "button",
			style: S.button,
			disabled: busy,
			onClick: onForget
		}, tt("token.forget")) : null, onVerify !== void 0 ? h("button", {
			type: "button",
			style: S.button,
			disabled: busy,
			onClick: onVerify,
			title: verifyTitle
		}, tt("probe.validity")) : null), error !== null ? h("div", {
			style: S.formError,
			role: "alert"
		}, error) : null, h("div", { style: S.formNote }, tt("token.hint")), h("a", {
			style: S.formNote,
			href: MODELSCOPE_TOKEN_URL,
			target: "_blank",
			rel: "noreferrer"
		}, tt("token.link")));
	}
	/**
	* 接入为 DSH 模型的区块（开关 + 注册状态 + 允许清单）。
	*
	* 这是 M4 把抽象「试调」升级成真接入的落点：开关翻转即 POST provider 路由，
	* Host 在同一次请求里落盘并重注册适配器；允许清单勾完点「保存清单」即 POST
	* roster 路由。写盘（开关/清单）失败必须让面板看见，所以失败由调用方传进
	* `error` 一行渲染出来，不做乐观更新。
	*
	* 只有 ProviderCard 持 draft 状态（勾选清单），其余都是展示组件——与 TokenForm
	* 同一类 hook 边界，Node 渲染套件可以驱动无状态的部分。draft 在 Host 值真正
	* 变化时才跟过去（用 JSON 串做稳定信号，避免每次轮询都用新数组把在编辑的勾选
	* 冲掉）；保存后由调用方 `load()` 刷新，快照回显的就是已落盘的值。
	*
	* 允许清单的语义（路由 §9 钉死）：空清单 = 不过滤 = 全部提供，所以「全部」
	* 发 `[]`；「全部隐藏」发哨兵 `HIDE_ALL_MODELS`（「什么都不提供」）。哨兵
	* 是**独占态**：draft 含哨兵时整个清单就是「全部隐藏」——勾一个真实模型会
	* 退出哨兵态（剔除哨兵），Host 落盘值带哨兵时只保留哨兵。**不能**让哨兵与
	* 真实 id 混排：Host 的 resolveAllowedList 判「含哨兵即 none（全隐藏）」，而
	* 面板若把混排清单里的真实 id 画成勾中、计数为 N，UI 就与落盘撒谎了。
	* 曾踩过：点「全部隐藏」后复选框仍可勾，勾出的混排清单保存后「已启用 1/N」
	* 而实际提供 0 个。
	*
	* 额度耗尽的模型保留在清单里（灰显、勾选框禁用），这是故意的：roster 是目录
	* 事实，picker 那边由 Host 自己丢掉它们，面板不替它删。
	*/
	function ProviderCard({ provider, busy, error, onToggle, onSaveList, onSaveContextWindow, onReset, tokenPresent, tt }) {
		const status = providerOf$1(provider);
		const enabled = status.enabled === true;
		const hostIds = status.enabledIds;
		const hostKey = useMemo(() => JSON.stringify(hostIds), [hostIds]);
		const [draft, setDraft] = useState(() => hostIds.slice());
		const hideAllMode = parseAllowedList(draft).mode === "none";
		useEffect(() => {
			setDraft(normalizeRosterSave(hostIds));
		}, [hostKey]);
		const roster = status.roster;
		const rosterIds = roster.map((row) => row.id);
		const toggleOne = (id) => setDraft((current) => {
			const ids = parseAllowedList(current);
			const kept = ids.mode === "list" ? [...ids.ids] : [];
			return kept.includes(id) ? kept.filter((x) => x !== id) : [...kept, id];
		});
		const ticked = hideAllMode ? 0 : roster.filter((row) => draft.includes(row.id)).length;
		const degraded = status.error === "unavailable";
		let statusNode;
		if (!degraded && typeof status.error === "string" && status.error !== "") statusNode = h("div", {
			style: S.formError,
			role: "alert"
		}, format(tt("provider.error"), { error: status.error }));
		else if (status.registered === true) statusNode = h("div", {
			style: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			role: "status"
		}, tt("provider.registered"));
		else if (status.llmAvailable !== true) statusNode = h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, tt("provider.llmMissing"));
		else statusNode = h("div", {
			style: {
				...S.muted,
				fontSize: 12
			},
			role: "status"
		}, tt("provider.notRegistered"));
		const tokenHint = enabled && tokenPresent === false ? h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, tt("provider.notConfigured")) : null;
		const sourceKey = status.source === "panel" ? "provider.source.panel" : "provider.source.config";
		const CONTEXT_TIERS = [
			{
				value: 131072,
				label: "128K"
			},
			{
				value: 262144,
				label: "256K"
			},
			{
				value: 524288,
				label: "512K"
			},
			{
				value: 1048576,
				label: "1M"
			}
		];
		const contextNode = onSaveContextWindow === void 0 ? null : h("div", { style: {
			display: "flex",
			gap: 8,
			alignItems: "center",
			flexWrap: "wrap",
			margin: "0 0 8px"
		} }, h("label", {
			style: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			htmlFor: "provider-context-window"
		}, tt("provider.contextWindow")), h("select", {
			id: "provider-context-window",
			style: {
				...S.rosterBulk,
				width: "auto"
			},
			disabled: busy,
			value: status.contextWindow === null ? "" : String(status.contextWindow),
			onChange: (event) => {
				const value = String(event.target?.value ?? "");
				onSaveContextWindow(value === "" ? null : Number(value));
			}
		}, h("option", {
			value: "",
			key: "default"
		}, tt("provider.contextDefault")), CONTEXT_TIERS.map((tier) => h("option", {
			value: String(tier.value),
			key: String(tier.value)
		}, tier.label))), h("span", {
			style: {
				...S.muted,
				fontSize: 11
			},
			title: tt("provider.contextHint")
		}, tt("provider.contextHint")));
		const switchRow = h("div", { style: {
			display: "flex",
			gap: 10,
			alignItems: "center",
			flexWrap: "wrap",
			margin: "0 0 8px"
		} }, h(ToggleSwitch, {
			checked: enabled,
			onChange: () => onToggle(!enabled),
			busy,
			label: tt(enabled ? "provider.on" : "provider.off"),
			busyLabel: tt("provider.busy"),
			title: tt("provider.enable")
		}), h("span", { style: {
			fontSize: 11,
			color: "var(--dsw-alias-label-secondary)"
		} }, tt(sourceKey)));
		const rosterBlock = roster.length === 0 ? h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 6
		} }, tt("provider.rosterHint")) : h("div", { style: S.modelPanel }, h("div", { style: S.rosterTools }, h("span", {
			style: S.rosterCount,
			title: format(tt("provider.enabledCount"), {
				count: ticked,
				total: roster.length
			})
		}, format(tt("provider.enabledCount"), {
			count: ticked,
			total: roster.length
		})), h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: busy,
			onClick: () => {
				setDraft(rosterIds.slice());
				onSaveList(rosterIds.slice());
			}
		}, tt("provider.allowAll")), h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: busy,
			onClick: () => {
				const none = hideAllRoster();
				setDraft(none);
				onSaveList(none);
			}
		}, tt("provider.hideAll")), h("button", {
			type: "button",
			style: S.primary,
			disabled: busy,
			onClick: () => onSaveList(draft.slice())
		}, tt("provider.saveList"))), h("ul", {
			style: S.modelList,
			role: "list"
		}, roster.map((row) => {
			const id = row.id;
			const unusable = row.available === false || row.quotaExhausted === true;
			return h("li", {
				key: id,
				style: unusable ? {
					...S.modelRow,
					...S.modelRowOff
				} : S.modelRow
			}, h("div", { style: S.modelRowHead }, h("label", { style: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				flex: "1 1 auto",
				minWidth: 0,
				cursor: busy || unusable ? "default" : "pointer"
			} }, h("input", {
				type: "checkbox",
				checked: !hideAllMode && draft.includes(id),
				disabled: busy || unusable,
				onChange: () => toggleOne(id),
				style: S.modelCheck,
				"aria-label": id
			}), h("span", {
				style: S.modelName,
				title: id
			}, row.name)), row.vision === true ? h("span", { style: S.modelBadge }, tt("provider.vision")) : null, typeof row.contextWindow === "number" ? h("span", {
				style: row.contextSource === "curated" ? {
					...S.modelBadge,
					color: "var(--dsw-alias-label-secondary)"
				} : S.modelBadge,
				title: row.contextSource === "curated" ? tt("provider.contextCuratedTitle") : tt("provider.contextWindow")
			}, row.contextSource === "curated" ? formatWindow(row.contextWindow) + " *" : formatWindow(row.contextWindow)) : null, FEATURED_OWNERS.includes(catalogOwner(row.id)) ? h("span", {
				style: S.modelBadgeFeatured,
				title: tt("models.featuredTitle")
			}, tt("provider.featured")) : null, row.quotaExhausted === true ? h("span", { style: {
				...S.modelBadge,
				color: "var(--dsw-alias-state-error-primary)"
			} }, tt("provider.quotaExhausted")) : null, h("a", {
				style: {
					...S.formNote,
					margin: 0,
					marginLeft: "auto"
				},
				href: modelscopeModelUrl(row.id),
				target: "_blank",
				rel: "noreferrer",
				title: tt("models.viewOnSiteTitle")
			}, tt("models.viewOnSite"))));
		})), h("div", { style: S.rosterFoot }, h("button", {
			type: "button",
			style: S.button,
			disabled: busy,
			onClick: onReset
		}, tt("provider.reset"))));
		return h("div", null, switchRow, statusNode, tokenHint, contextNode, h("div", { style: {
			...S.sectionTitle,
			margin: "18px 0 8px"
		} }, tt("provider.models")), rosterBlock, error !== null ? h("div", {
			style: S.formError,
			role: "alert"
		}, error) : null);
	}
	/**
	* 出图工具卡：开关、候选模型、挂载状态。
	*
	* **与 ProviderCard 的关键差异，也是这张卡存在的主要理由**：provider 开关翻转会
	* 立即重注册，而出图工具的开关翻转**要等下次 Host 启动**——peer 的 tools registry
	* 没有 unregister。所以这张卡必须把这件事说出来（`draw.restartHint`），否则用户
	* 翻开关后看不到任何变化，会以为坏了。
	*
	* 缺席原因是**分开渲染**的：`no-tools-service` 是「这个 Host 没提供该服务」（正常），
	* 另两种是 Host 缺陷。三种都给出各自的一句话，因为「开关开着但工具不在」如果没有
	* 解释，用户没有任何办法自己诊断。
	* @param {object} props - 渲染参数。
	* @returns {unknown} 卡片节点。
	*/
	function DrawCard({ draw, busy, error, onToggle, onReset, tokenPresent, tt }) {
		const status = drawOf(draw);
		const enabled = status.enabled === true;
		const candidates = status.candidateIds;
		const sourceKey = status.source === "panel" ? "draw.source.panel" : "draw.source.config";
		const switchRow = h("div", { style: {
			display: "flex",
			gap: 10,
			alignItems: "center",
			flexWrap: "wrap",
			margin: "0 0 8px"
		} }, h(ToggleSwitch, {
			checked: enabled,
			onChange: () => onToggle(!enabled),
			busy,
			label: tt(enabled ? "draw.on" : "draw.off"),
			busyLabel: tt("draw.busy"),
			title: tt("draw.enable")
		}), h("span", { style: {
			fontSize: 11,
			color: "var(--dsw-alias-label-secondary)"
		} }, tt(sourceKey)));
		let statusNode;
		if (status.absentReason !== null) {
			const key = DRAW_ABSENT_KEY[status.absentReason] ?? "draw.absent.unknown";
			const severe = status.absentReason !== "no-tools-service";
			statusNode = h("div", {
				style: severe ? {
					...S.formNote,
					color: "var(--dsw-alias-state-warn-primary)"
				} : S.formNote,
				role: "status"
			}, tt(key));
		} else if (enabled) statusNode = h("div", {
			style: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			role: "status"
		}, format(tt("draw.mounted"), { tool: status.toolName }));
		else statusNode = h("div", {
			style: {
				...S.muted,
				fontSize: 12
			},
			role: "status"
		}, tt("draw.notMounted"));
		const restartHint = enabled ? h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, tt("draw.restartHint")) : null;
		const tokenHint = enabled && tokenPresent === false ? h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, tt("draw.needsKey")) : null;
		const candidateBlock = candidates.length === 0 ? h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 6
		} }, tt("draw.noCandidates")) : h("div", { style: {
			display: "flex",
			flexDirection: "column",
			gap: 4
		} }, candidates.map((id) => h("div", {
			key: id,
			style: S.modelRowHead
		}, h("code", {
			style: S.modelName,
			title: id
		}, id), h("span", { style: S.modelBadge }, tt("draw.badge")), h("a", {
			style: {
				...S.formNote,
				margin: 0,
				marginLeft: "auto"
			},
			href: modelscopeModelUrl(id),
			target: "_blank",
			rel: "noreferrer",
			title: tt("models.viewOnSiteTitle")
		}, tt("models.viewOnSite")))));
		return h("div", null, switchRow, statusNode, restartHint, tokenHint, h("div", { style: {
			...S.sectionTitle,
			margin: "18px 0 8px"
		} }, tt("draw.models")), candidateBlock, h("div", { style: S.rosterFoot }, h("button", {
			type: "button",
			style: S.button,
			disabled: busy,
			onClick: onReset
		}, tt("draw.reset"))), error !== null ? h("div", {
			style: S.formError,
			role: "alert"
		}, error) : null);
	}
	var MAX_TICKS, EVENT_KIND_KEY, DRAW_ABSENT_KEY;
	var init_cards = __esmMin((() => {
		init_format();
		init_runtime();
		init_styles();
		init_const();
		init_snapshot();
		init_toggle_switch();
		init_allow_list();
		MAX_TICKS = 7;
		EVENT_KIND_KEY = {
			quota: "events.quota",
			rate_limit: "events.rate_limit",
			error: "events.error"
		};
		DRAW_ABSENT_KEY = {
			"no-tools-service": "draw.absent.noTools",
			"peer-load-failed": "draw.absent.peerLoad",
			"registry-refused": "draw.absent.registry"
		};
	}));

//#endregion
//#region src/client/http.ts
/** 一次带超时的 fetch；内部 controller，调用方无需传 signal。 */
	async function fetchWithTimeout(url, init) {
		const controller = typeof AbortController === "function" ? new AbortController() : null;
		const timer = controller === null ? null : setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			return await fetch(url, {
				...init,
				...controller === null ? {} : { signal: controller.signal }
			});
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}
	/**
	* POST 并解析 body；非 JSON 响应返回 null。
	*
	* 这里**故意不**检查 `response.ok`（与 {@link getJson} 不同）：host 的写操作错误
	* 响应体是 `{ok:false, code, error}`，调用方靠 `body.error` 给用户看具体原因
	* （令牌格式错、额度耗尽、上游超时）。丢掉它就只能显示一句通用的「操作失败」，
	* 用户无从下手。getJson 可以直接返回 null——读操作没有错误详情可展示。
	*/
	async function postJson(path, payload) {
		return await (await fetchWithTimeout(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json"
			},
			cache: "no-store",
			body: JSON.stringify(payload)
		})).json().catch(() => null);
	}
	/** GET 同源 JSON；非 2xx 或非 JSON 返回 null（调用方决定怎么降级）。 */
	async function getJson(path) {
		const response = await fetchWithTimeout(path, {
			headers: { accept: "application/json" },
			cache: "no-store"
		});
		if (!response.ok) return null;
		return await response.json().catch(() => null);
	}
	/**
	* 写路径的成败判定收口：失败返回 Error，成功返回 null。
	*
	* `postJson` 只把「HTTP/解析失败」折成 `null`，域失败是 `{ok:false, error}`（Host 对
	* 写操作恒回 HTTP 200，成败看 body）。三个写回调曾各判一次，而**「忘掉令牌」漏判**——
	* 它直接 `await postJson(...)` 就往下走，于是 Host 侧刻意传播的失败（凭据文件只读时
	* `ms-auth.forget` 抛错，见其文件头「谎报成功比失败更糟」）在界面上表现为「什么都没
	* 发生」：没有错误行、busy 清掉、刷新后的快照里令牌还在。判据收在这里一份，三个调用
	* 方（开关/清单、保存令牌、忘掉令牌）不可能再各自漂移。
	* @param {ApiBody|null} body - postJson 的返回值。
	* @param {string} fallback - body 里没有可读原因时的一句话。
	* @returns {Error|null} 失败原因；`null` = 成功。
	*/
	function writeFailure(body, fallback) {
		if (body !== null && body.ok === true) return null;
		const reason = typeof body?.error === "string" && body.error.trim() !== "" ? body.error : fallback;
		return new Error(reason);
	}
	var FETCH_TIMEOUT_MS;
	var init_http = __esmMin((() => {
		FETCH_TIMEOUT_MS = 2e4;
	}));

//#endregion
//#region src/client/use-polling-interval.ts
/**
	* Run `run()` on an interval that stops while the page is hidden, and slows
	* down while `failed` is true.
	*
	* @param run - the poll body; must be stable (wrap it in `useCallback`), since
	*   it is an effect dependency and a fresh identity would restart the loop on
	*   every render.
	* @param intervalMs - the healthy cadence, in milliseconds.
	* @param options - loop control.
	* @param options.enabled - when false the loop does not run at all (the caller
	*   has decided polling is not wanted); defaults to true.
	* @param options.failed - when true the loop backs off to
	*   {@link ERROR_BACKOFF_MS}, never faster than `intervalMs`.
	*/
	function usePollingInterval(run, intervalMs, options = {}) {
		const { enabled = true, failed = false } = options;
		const healthy = Math.max(1, Math.floor(intervalMs));
		const effective = failed ? Math.max(healthy, ERROR_BACKOFF_MS) : healthy;
		const runRef = useRef(run);
		runRef.current = run;
		useEffect(() => {
			if (!enabled) return;
			let alive = true;
			let timer = null;
			const fire = () => {
				if (alive) runRef.current();
			};
			const start = () => {
				if (timer === null) timer = setInterval(fire, effective);
			};
			const stop = () => {
				if (timer !== null) {
					clearInterval(timer);
					timer = null;
				}
			};
			const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
			if (!hidden()) {
				fire();
				start();
			}
			const onVisibility = () => {
				if (!alive) return;
				if (hidden()) stop();
				else {
					fire();
					start();
				}
			};
			if (typeof document !== "undefined" && "addEventListener" in document) document.addEventListener("visibilitychange", onVisibility);
			return () => {
				alive = false;
				stop();
				if (typeof document !== "undefined" && "addEventListener" in document) document.removeEventListener("visibilitychange", onVisibility);
			};
		}, [effective, enabled]);
	}
	var ERROR_BACKOFF_MS;
	var init_use_polling_interval = __esmMin((() => {
		init_runtime();
		ERROR_BACKOFF_MS = 6e4;
	}));

//#endregion
//#region src/client/use-snapshot-polling.ts
	function useSnapshotPolling(defaultCadenceMs = 3e4) {
		const [data, setData] = useState(null);
		const [error, setError] = useState(null);
		const [loadedOnce, setLoadedOnce] = useState(false);
		const [updatedAt, setUpdatedAt] = useState(0);
		const [cadenceMs, setCadenceMs] = useState(defaultCadenceMs);
		/** Host 少给的顶层键（契约漂移）；透给面板当 shapeWarning，不静默。 */
		const [missingKeys, setMissingKeys] = useState([]);
		/**
		* 每一次轮询尝试都加一，成功与失败都算。`updatedAt` 只在成功时变，而
		* 面板的 provider 兜底 GET 需要的是「下一轮还会再来」这个信号——快照本身
		* 失败的那一轮，恰好是兜底路径也应该再试的一轮。
		*/
		const [pollRevision, setPollRevision] = useState(0);
		const generation = useRef(0);
		const inFlight = useRef(null);
		const cadenceRef = useRef(cadenceMs);
		cadenceRef.current = cadenceMs;
		const load = useCallback(async () => {
			generation.current += 1;
			setPollRevision((revision) => revision + 1);
			const mine = generation.current;
			const isCurrent = () => generation.current === mine;
			inFlight.current?.abort?.();
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			inFlight.current = controller;
			try {
				const response = await fetch(SNAPSHOT_PATH, {
					headers: { accept: "application/json" },
					cache: "no-store",
					...controller ? { signal: controller.signal } : {}
				});
				if (!isCurrent()) return;
				if (!response.ok) {
					setError(errorOfStatus(response.status));
					return;
				}
				const body = await response.json().catch(() => null);
				if (!isCurrent()) return;
				const read = interpretSnapshot(body);
				if (read.data === null) {
					setData(null);
					setMissingKeys([]);
					setError(read.error);
					return;
				}
				setData(read.data);
				setMissingKeys(read.missingKeys ?? []);
				setError(null);
				setUpdatedAt(Date.now());
				const stated = read.data?.pollSeconds;
				if (typeof stated === "number" && Number.isFinite(stated)) setCadenceMs(statedCadenceMs(stated, cadenceRef.current));
			} catch (reason) {
				if (!isCurrent()) return;
				setError(errorText(reason));
			} finally {
				if (isCurrent()) setLoadedOnce(true);
				if (inFlight.current === controller) inFlight.current = null;
			}
		}, []);
		usePollingInterval(load, cadenceMs, { failed: error !== null });
		useEffect(() => () => {
			generation.current += 1;
			inFlight.current?.abort?.();
		}, []);
		return {
			data,
			error,
			loadedOnce,
			updatedAt,
			load,
			missingKeys,
			pollRevision
		};
	}
	var init_use_snapshot_polling = __esmMin((() => {
		init_runtime();
		init_snapshot();
		init_format();
		init_use_polling_interval();
		init_const();
	}));

//#endregion
//#region src/client/panel-page.ts
	function PanelPage({ tt, localeSubscribe }) {
		const { data, error, updatedAt, load, missingKeys, pollRevision } = useSnapshotPolling();
		const [, setLocaleRevision] = useState(0);
		const [openSections, setOpenSections] = useState({
			balance: true,
			local: true,
			trend: true,
			events: false,
			provider: true,
			draw: true,
			token: true
		});
		const [activeTab, setActiveTab] = useState("quota");
		useEffect(() => {
			if (typeof localeSubscribe !== "function") return void 0;
			return localeSubscribe(() => setLocaleRevision((revision) => revision + 1));
		}, [localeSubscribe]);
		const toggleSection = useCallback((key) => {
			setOpenSections((current) => ({
				...current,
				[key]: !current[key]
			}));
		}, []);
		const { failure, guidance, shapeWarnings } = viewOf(data, error, tt, missingKeys);
		const rawProvider = data?.provider;
		const hasProviderBlock = rawProvider !== void 0 && rawProvider !== null;
		const [fetchedProvider, setFetchedProvider] = useState(null);
		const provider = hasProviderBlock ? providerOf$1(rawProvider) : fetchedProvider ?? DEGRADED_PROVIDER;
		useEffect(() => {
			if (hasProviderBlock) return void 0;
			let cancelled = false;
			getJson(PROVIDER_PATH).then((body) => {
				if (!cancelled && body !== null && body.ok === true) setFetchedProvider(providerOf$1(body));
			}).catch(() => {});
			return () => {
				cancelled = true;
			};
		}, [hasProviderBlock, pollRevision]);
		const rawDraw = data?.draw;
		const hasDrawBlock = rawDraw !== void 0 && rawDraw !== null;
		const [fetchedDraw, setFetchedDraw] = useState(null);
		const draw = hasDrawBlock ? drawOf(rawDraw) : fetchedDraw ?? DEGRADED_DRAW;
		useEffect(() => {
			if (hasDrawBlock) return void 0;
			let cancelled = false;
			getJson(DRAW_PATH).then((body) => {
				if (!cancelled && body !== null && body.ok === true) setFetchedDraw(drawOf(body));
			}).catch(() => {});
			return () => {
				cancelled = true;
			};
		}, [hasDrawBlock, pollRevision]);
		const [providerBusy, setProviderBusy] = useState(false);
		const [providerError, setProviderError] = useState(null);
		const writeErrorText = (reason, t) => reason instanceof Error && reason.name === "AbortError" ? t("common.timeout") : errorText(reason);
		/**
		* POST 一个写路径，并把 body 里的域失败抛出去（Host 对写操作恒回 HTTP 200，成败
		* 看 body）。判据只有 `http.ts#writeFailure` 一份——三个写回调曾各判一次，而
		* 「忘掉令牌」那条漏了，于是凭据文件只读时界面表现为「什么都没发生」。
		*/
		const postWrite = useCallback(async (path, payload) => {
			const failure = writeFailure(await postJson(path, payload), tt("common.httpError"));
			if (failure !== null) throw failure;
		}, [tt]);
		const runProviderWrite = useCallback(async (path, payload) => {
			setProviderBusy(true);
			setProviderError(null);
			try {
				await postWrite(path, payload);
				load();
			} catch (reason) {
				setProviderError(format(tt("provider.error"), { error: writeErrorText(reason, tt) }));
			} finally {
				setProviderBusy(false);
			}
		}, [
			load,
			postWrite,
			tt
		]);
		const toggleProvider = useCallback((enabled) => void runProviderWrite(PROVIDER_PATH, { enabled }), [runProviderWrite]);
		const saveRoster = useCallback((enabledIds) => {
			runProviderWrite(PROVIDER_ROSTER_PATH, { enabledIds: normalizeRosterSave(enabledIds) });
		}, [runProviderWrite]);
		const resetProvider = useCallback(() => void runProviderWrite(PROVIDER_RESET_PATH, {}), [runProviderWrite]);
		const saveContextWindow = useCallback((contextWindow) => {
			runProviderWrite(PROVIDER_CONTEXT_PATH, { contextWindow });
		}, [runProviderWrite]);
		const [drawBusy, setDrawBusy] = useState(false);
		const [drawError, setDrawError] = useState(null);
		const runDrawWrite = useCallback(async (path, payload) => {
			setDrawBusy(true);
			setDrawError(null);
			try {
				await postWrite(path, payload);
				load();
			} catch (reason) {
				setDrawError(format(tt("draw.error"), { error: writeErrorText(reason, tt) }));
			} finally {
				setDrawBusy(false);
			}
		}, [
			load,
			postWrite,
			tt
		]);
		const toggleDraw = useCallback((enabled) => void runDrawWrite(DRAW_PATH, { enabled }), [runDrawWrite]);
		const resetDraw = useCallback(() => void runDrawWrite(DRAW_RESET_PATH, {}), [runDrawWrite]);
		const [tokenBusy, setTokenBusy] = useState(false);
		const [tokenError, setTokenError] = useState(null);
		const saveToken = useCallback(async (value) => {
			setTokenBusy(true);
			setTokenError(null);
			try {
				await postWrite(TOKEN_PATH, { token: value });
				load();
			} catch (reason) {
				setTokenError(writeErrorText(reason, tt));
			} finally {
				setTokenBusy(false);
			}
		}, [
			load,
			postWrite,
			tt
		]);
		const forgetToken = useCallback(async () => {
			setTokenBusy(true);
			setTokenError(null);
			try {
				await postWrite(TOKEN_FORGET_PATH, {});
				load();
			} catch (reason) {
				setTokenError(writeErrorText(reason, tt));
			} finally {
				setTokenBusy(false);
			}
		}, [
			load,
			postWrite,
			tt
		]);
		const tokenState = data?.token ?? null;
		const sampleModel = data?.models?.sample?.[0] ?? null;
		const [verifyBusy, setVerifyBusy] = useState(false);
		const [verifyNote, setVerifyNote] = useState(null);
		const [verifyError, setVerifyError] = useState(null);
		const runValidity = useCallback(async (modelId) => {
			setVerifyBusy(true);
			setVerifyNote(null);
			setVerifyError(null);
			try {
				const body = await postJson(PROBE_PATH, { modelId });
				if (body !== null) load();
				if (body !== null && body.ok === true) setVerifyNote(format(tt("probe.validOk"), { status: Number(body.status ?? 0) }));
				else setVerifyError(typeof body?.error === "string" ? body.error : tt("common.httpError"));
			} catch (reason) {
				setVerifyError(writeErrorText(reason, tt));
			} finally {
				setVerifyBusy(false);
			}
		}, [load, tt]);
		const quotaBody = () => {
			if (data === null) return h("div", { style: S.empty }, failure === null ? tt("panel.loading") : h("div", { role: "alert" }, guidance ?? format(tt("panel.error"), { error: failure.message })));
			const snap = data;
			return h("div", null, snap.token?.present === false ? h("div", {
				style: S.formNote,
				role: "status"
			}, tt("panel.noToken")) : null, h(SectionCard, {
				title: tt("section.balance"),
				open: openSections.balance,
				onToggle: () => toggleSection("balance"),
				tt
			}, h(BalanceCard, {
				balance: snap.balance,
				tt
			})), h(SectionCard, {
				title: tt("section.local"),
				open: openSections.local,
				onToggle: () => toggleSection("local"),
				tt
			}, h(LocalDailyCard, {
				snapshot: snap,
				tt
			})), h(SectionCard, {
				title: format(tt("section.trend"), { days: snap.trend?.days ?? 0 }),
				open: openSections.trend,
				onToggle: () => toggleSection("trend"),
				tt
			}, h(TrendBars, {
				buckets: snap.trend?.buckets ?? [],
				tt
			})), h(SectionCard, {
				title: tt("section.events"),
				open: openSections.events,
				onToggle: () => toggleSection("events"),
				tt
			}, h(EventsList, {
				events: snap.events ?? [],
				tt
			})));
		};
		const modelsBody = () => h("div", null, h(SectionCard, {
			title: tt("section.provider"),
			open: openSections.provider,
			onToggle: () => toggleSection("provider"),
			tt
		}, h(ProviderCard, {
			provider,
			busy: providerBusy,
			error: providerError,
			onToggle: toggleProvider,
			onSaveList: saveRoster,
			onSaveContextWindow: saveContextWindow,
			onReset: resetProvider,
			tokenPresent: data?.token?.present === true,
			tt
		})), h(SectionCard, {
			title: tt("section.draw"),
			open: openSections.draw,
			onToggle: () => toggleSection("draw"),
			tt
		}, h(DrawCard, {
			draw,
			busy: drawBusy,
			error: drawError,
			onToggle: toggleDraw,
			onReset: resetDraw,
			tokenPresent: data?.token?.present === true,
			tt
		})));
		const accessBody = () => h("div", null, h(SectionCard, {
			title: tt("section.token"),
			open: openSections.token,
			onToggle: () => toggleSection("token"),
			tt
		}, h(TokenForm, {
			token: tokenState,
			busy: tokenBusy || verifyBusy,
			error: tokenError,
			onSave: (value) => void saveToken(value),
			onForget: () => void forgetToken(),
			onVerify: sampleModel === null ? void 0 : () => void runValidity(sampleModel),
			verifyTitle: sampleModel ?? void 0,
			tt
		}), verifyNote !== null ? h("div", {
			style: S.formNote,
			role: "status"
		}, verifyNote) : null, verifyError !== null ? h("div", {
			style: S.formError,
			role: "alert"
		}, format(tt("probe.fail"), { error: verifyError })) : null));
		return h("div", {
			style: S.page,
			"data-dsh-plugin": PANEL_ID
		}, h("div", { style: S.headerBar }, h("div", { style: S.header }, h("h1", { style: S.title }, tt("panel.title")), h("span", { style: S.spacer }), h("span", { style: S.cluster }, data !== null ? h("span", { style: S.updated }, format(tt("panel.updated"), { time: isoTime(new Date(updatedAt).toISOString()) })) : null, failure !== null && data !== null ? h("span", {
			style: S.error,
			role: "status",
			title: failure.message
		}, format(tt("panel.error"), { error: failure.message })) : null, h("button", {
			type: "button",
			style: S.button,
			onClick: () => void load()
		}, tt("panel.refresh"))))), h("div", { style: S.scroll }, h("div", { style: S.content }, h("div", null, h("div", {
			style: S.tabBar,
			role: "tablist"
		}, h("button", {
			type: "button",
			role: "tab",
			"aria-selected": activeTab === "quota",
			style: {
				...S.tab,
				...activeTab === "quota" ? S.tabActive : {}
			},
			onClick: () => setActiveTab("quota")
		}, tt("tab.quota")), h("button", {
			type: "button",
			role: "tab",
			"aria-selected": activeTab === "models",
			style: {
				...S.tab,
				...activeTab === "models" ? S.tabActive : {}
			},
			onClick: () => setActiveTab("models")
		}, tt("tab.models")), h("button", {
			type: "button",
			role: "tab",
			"aria-selected": activeTab === "access",
			style: {
				...S.tab,
				...activeTab === "access" ? S.tabActive : {}
			},
			onClick: () => setActiveTab("access")
		}, tt("tab.access"))), data !== null && shapeWarnings.length > 0 ? h("div", {
			style: S.formError,
			role: "status"
		}, format(tt("panel.shapeDrift"), { detail: shapeWarnings.join("; ") })) : null, activeTab === "quota" ? quotaBody() : activeTab === "models" ? modelsBody() : accessBody()))));
	}
	var init_panel_page = __esmMin((() => {
		init_cards();
		init_const();
		init_format();
		init_http();
		init_snapshot();
		init_use_snapshot_polling();
		init_runtime();
		init_styles();
		init_allow_list();
	}));

//#endregion
//#region src/client/composer-usage-pill.ts
/**
	* 一个候选自带的 provider，空串算「没有」。
	*
	* `typeof provider === "string"` 是不够的判据：`""` 也是字符串。照类型判定会让
	* `{ provider: "" }` 被当成一个「可用的 next」，于是它遮住仍然可用的 `lastUsed`
	* ——切模型那一帧胶囊就消失。所以这里判的是**非空字符串**。
	*/
	function providerOf(candidate) {
		const provider = candidate?.provider;
		return typeof provider === "string" && provider !== "" ? provider : void 0;
	}
	/**
	* 会话当前指向的 provider。
	*
	* `next` 优先于 `lastUsed`（切换已落地但还没发出去时，选择器显示的就是 `next`），
	* 但**只在 `next` 真的带了一个非空 provider 时**才优先：picker 刚切完、新选择还没
	* 落到 `next` 上的那几帧 `next` 是 `{}` 或 `{ provider: "" }`，照「有 next 就用
	* next」读会得到 `undefined`，于是归属模型在「切换」这个动作本身上把胶囊藏起来。
	* 两侧都没有可用 provider 时返回 `undefined`——那才是真的判不出来。
	*/
	function selectedProviderOf(projection) {
		const source = projection ?? {};
		return providerOf(source.next) ?? providerOf(source.lastUsed);
	}
	/**
	* 余额读数；`null` 表示**不知道**（没读到 / 上游没给 / 字段不是有限数）。
	*
	* 特意不接受 `error` 参数做二次判断：错误文本只影响 tooltip 的措辞，不影响
	* 「数字可不可信」。把两者揉在一个判定里，会让「上次读到的 143 仍然有效」这种
	* 情形（`error` 非空但 `available` 有值）被误打成未知。
	*/
	function availableOf(balance) {
		const available = balance?.available;
		return typeof available === "number" && Number.isFinite(available) ? available : null;
	}
	/** 今日本地调用次数；`null` 同上，表示读不到（不是 0）。 */
	function usedTodayOf(snapshot) {
		const used = snapshot?.quota?.daily?.usedLocal;
		return typeof used === "number" && Number.isFinite(used) ? used : null;
	}
	/** 由余额读数定档；`null`（未读到）与 `0`（读到了、就是零）在此分道。 */
	function tierOf(available) {
		if (available === null) return "unknown";
		return available > 0 ? "ok" : "exhausted";
	}
	/** 「余额」段的正文：读不到画「—」+ 单位，读到了画数字 + 单位。 */
	function balanceText(available, tt) {
		return `${available === null ? "—" : count(available)} ${tt("composer.balanceUnit")}`;
	}
	/** 「今日本地」段的正文：读不到画「—」，读到了画次数。 */
	function callsText(usedToday, tt) {
		return format(tt("composer.localCalls"), { calls: usedToday === null ? "—" : count(usedToday) });
	}
	/**
	* 胶囊正文：余额段 + 本地次数段，各带各的口径。两段都必须出现——只画有值的那
	* 一段会让「哪一段是空的」变成排版事故（读者分不清是没读到还是这一栏根本不在），
	* 而「—」明确说了是前者。
	*/
	function readingText(available, usedToday, tt) {
		return `${balanceText(available, tt)} · ${callsText(usedToday, tt)}`;
	}
	/**
	* 数字是否已经算「上次数据」。
	*
	* 两个触发条件各自独立：读失败（`error` 非空，上一轮的数值还留在屏幕上）本身就是
	* 陈旧；而长时间没有**成功**的读（`updatedAt` 不动）说明定时轮询没在按时回来
	* ——失败退避或页面被挂起都会这样。取 3 个声明周期而不是 1 个：一次偶发失败就会
	* 拉长间隔，卡在 1 个周期上会让每一次抖动都把读数打成陈旧的。
	*
	* `updatedAt === 0` 表示**从没读到过**，那不是「陈旧」而是「还没有」——调用方据此
	* 决定不标；本函数只在有读数的前提下判断，故返回 false。
	*/
	function staleOf(input) {
		if (input.error !== null && input.error !== void 0) return input.updatedAt > 0;
		return input.updatedAt > 0 && input.now - input.updatedAt > input.cadenceMs * STALE_CADENCES;
	}
	/**
	* tooltip 的一行：只把**读者下一步会问的**事实拼进来——数字是哪来的（前缀）、
	* 余额为什么没有（错误原文）、什么时候读的（fetchedAt）、本地计数为什么没有
	* （quota 那一路的提示）、以及数字是不是旧的。逐段 `filter` 掉空值，不留下
	* 「 ·  · 」这样的空槽。
	*/
	function titleOf(props) {
		const { tt, balance, usedToday, stale } = props;
		const parts = [tt("composer.pillTitle")];
		const failure = balance?.error;
		parts.push(typeof failure === "string" && failure !== "" ? format(tt("balance.unavailable"), { error: failure }) : null);
		const fetchedAt = balance?.fetchedAt;
		parts.push(typeof fetchedAt === "string" && fetchedAt !== "" ? format(tt("balance.fetched"), { time: isoTime(fetchedAt) }) : null);
		parts.push(usedToday === null ? tt("quota.unavailable") : null);
		parts.push(stale ? tt("composer.stale") : null);
		return parts.filter((part) => part !== null).join(" · ");
	}
	/**
	* 内层：只在会话选中本插件的模型时挂载。轮询 hook 在这里，被挂/摘即起停——
	* 非归属 provider 的会话不发任何请求。
	*/
	function ModelscopePill(props) {
		const { tt } = props;
		const { data, error, loadedOnce, updatedAt } = useSnapshotPolling();
		const balance = data?.balance ?? null;
		const available = availableOf(balance);
		const usedToday = usedTodayOf(data);
		const cadenceMs = statedCadenceMs(data?.pollSeconds, DEFAULT_CADENCE_MS);
		const stale = staleOf({
			error,
			updatedAt,
			now: Date.now(),
			cadenceMs
		});
		const pending = !loadedOnce && data === null;
		const tier = tierOf(available);
		const title = titleOf({
			tt,
			balance,
			usedToday,
			stale
		});
		return h("button", {
			type: "button",
			className: "dsh-modelscope-composer-pill",
			title,
			"aria-label": title,
			style: S.pillTrigger
		}, h("span", {
			className: "dsh-modelscope-composer-pill-dot",
			"aria-hidden": "true",
			style: {
				...S.pillDot,
				background: TIER_INK[tier]
			}
		}), h("span", {
			className: "dsh-modelscope-composer-pill-plan",
			style: S.pillPlan
		}, `${tt("composer.prefix")} · `), h("span", {
			className: "dsh-modelscope-composer-pill-text",
			style: tier === "exhausted" ? S.pillTierExhaustedText : void 0
		}, pending ? "…" : readingText(available, usedToday, tt)), stale ? h("span", {
			className: "dsh-modelscope-composer-pill-stale",
			style: S.pillStale
		}, ` · ${tt("composer.stale")}`) : null);
	}
	/**
	* 外层门控：固定一处调 `useProjection`，再决定内层挂谁。非归属 provider 返回
	* `null`（不渲染任何东西，也不跑任何请求）。
	*/
	function ComposerUsagePill(props) {
		const selection = props.useProjection?.("modelSelection");
		if (selectedProviderOf(selection) !== "modelscope-token-plan") return null;
		return h(ModelscopePill, { tt: props.tt });
	}
	var MODELSCOPE_PROVIDER, DEFAULT_CADENCE_MS, STALE_CADENCES, TIER_INK;
	var init_composer_usage_pill = __esmMin((() => {
		init_runtime();
		init_styles();
		init_format();
		init_use_snapshot_polling();
		MODELSCOPE_PROVIDER = "modelscope-token-plan";
		DEFAULT_CADENCE_MS = 3e4;
		STALE_CADENCES = 3;
		TIER_INK = {
			ok: S.pillTierOk,
			exhausted: S.pillTierExhausted,
			unknown: S.pillTierUnknown
		};
	}));

//#endregion
//#region src/client/apply.ts
/**
	* 注册字典与配置卡。卡片由 Host 的 renderSlot("plugins.bundle.config", …)
	* 渲染；本卡无关闭按钮——导航归 Plugins 页所有。
	*/
	function apply(ctx) {
		ctx.effect(() => {
			try {
				return ctx.locale.register(NS, {
					zh,
					en
				});
			} catch {
				return () => {};
			}
		}, `${NS}: dictionaries`);
		let translate = (key) => key;
		try {
			translate = ctx.locale.bind(NS);
		} catch {}
		const tt = (key) => {
			try {
				return translate(key);
			} catch {
				return key;
			}
		};
		const disposers = [];
		try {
			disposers.push(ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: NS,
				locale: NS,
				inject: () => ({
					tt,
					localeSubscribe: ctx.locale.subscribe.bind(ctx.locale)
				})
			}, PanelPage)));
		} catch (error) {
			console.warn(`[${NS}] config card registration failed:`, error);
		}
		try {
			disposers.push(ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: `${NS}-composer-pill`,
				locale: NS,
				order: 4,
				inject: () => ({ tt })
			}, ComposerUsagePill)));
		} catch (error) {
			console.warn(`[${NS}] composer pill registration failed:`, error);
		}
		ctx.effect(() => () => {
			for (const dispose of disposers.splice(0)) try {
				dispose();
			} catch {}
		}, `${NS}: ui mounts`);
	}
	var inject;
	var init_apply = __esmMin((() => {
		init_const();
		init_i18n();
		init_panel_page();
		init_composer_usage_pill();
		inject = ["slots", "locale"];
	}));

//#endregion
//#region src/client/index.ts
	var require_client = /* @__PURE__ */ __commonJSMin(((exports, module) => {
		init_apply();
		init_const();
		init_snapshot();
		init_format();
		init_runtime();
		init_i18n();
		init_styles();
		init_cards();
		init_panel_page();
		init_composer_usage_pill();
		init_use_polling_interval();
		init_use_snapshot_polling();
		init_http();
		function clientFactory(loaderRequire) {
			provideClientReact(loaderRequire("react"));
			/** 测试面：浏览器用的真实定义，没有一件只为测试而存在。 */
			const panel = Object.freeze({
				interpretSnapshot,
				viewOf,
				providerOf: providerOf$1,
				errorOfStatus,
				dictionaries: Object.freeze({
					zh,
					en
				}),
				tables: Object.freeze({
					GUIDANCE_BY_CODE,
					FORM_EXCLUDED_CODES
				}),
				styles: S,
				helpers: Object.freeze({
					clockLong,
					count,
					errorText,
					format,
					isoTime,
					statedCadenceMs,
					usePollingInterval,
					useSnapshotPolling,
					getJson,
					postJson,
					writeFailure,
					MODELSCOPE_PROVIDER,
					selectedProviderOf,
					availableOf,
					usedTodayOf,
					tierOf,
					balanceText,
					callsText,
					readingText,
					staleOf
				}),
				components: Object.freeze({
					BalanceCard,
					ComposerUsagePill,
					EventsList,
					LocalDailyCard,
					ModelscopePill,
					ModelUsageTable,
					PanelPage,
					ProviderCard,
					SectionCard,
					TokenForm,
					TrendBars
				})
			});
			return {
				inject,
				apply,
				panel
			};
		}
		/** Host 加载的注册物：id + 工厂。 */
		const REGISTRATION = {
			id: NS,
			factory: clientFactory
		};
		if (typeof window !== "undefined") {
			const loader = window.__ModuleLoader__;
			if (loader !== void 0) loader.load(REGISTRATION);
		}
		if (typeof module !== "undefined" && module !== null && module.exports !== void 0) module.exports = REGISTRATION;
	}));

//#endregion
return require_client();

})();