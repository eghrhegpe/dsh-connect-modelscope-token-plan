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
//#region src/client/const.ts
	function modelscopeModelUrl(id) {
		return `${MODELSCOPE_MODEL_URL_BASE}/${encodeURI(id)}`;
	}
	var NS, PANEL_ID, SNAPSHOT_PATH, MODELS_PATH, TOKEN_PATH, TOKEN_FORGET_PATH, PROBE_PATH, PROVIDER_PATH, PROVIDER_ROSTER_PATH, PROVIDER_RESET_PATH, HIDE_ALL_MODELS, MODELSCOPE_TOKEN_URL, MODELSCOPE_USAGE_URL, MODELSCOPE_MODEL_URL_BASE;
	var init_const = __esmMin((() => {
		NS = "dsh-connect-modelscope-token-plan";
		PANEL_ID = NS;
		SNAPSHOT_PATH = `/api/${NS}/snapshot`;
		MODELS_PATH = `/api/${NS}/models`;
		TOKEN_PATH = `/api/${NS}/token`;
		TOKEN_FORGET_PATH = `/api/${NS}/token/forget`;
		PROBE_PATH = `/api/${NS}/probe`;
		PROVIDER_PATH = `/api/${NS}/provider`;
		PROVIDER_ROSTER_PATH = `/api/${NS}/provider/roster`;
		PROVIDER_RESET_PATH = `/api/${NS}/provider/reset`;
		HIDE_ALL_MODELS = "__hide_all__";
		MODELSCOPE_TOKEN_URL = "https://modelscope.cn/my/myaccesstoken";
		MODELSCOPE_USAGE_URL = "https://modelscope.cn/magicube/usage?tab=consume";
		MODELSCOPE_MODEL_URL_BASE = "https://www.modelscope.cn/models";
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
			"panel.authError": "令牌被拒绝（401/403）。请到「接入」tab 更换访问令牌。",
			"panel.noToken": "还没有配置魔搭访问令牌。到「接入」tab 粘贴一枚 ms-… 令牌即可。",
			"panel.shapeDrift": "上游返回的结构可能有变：{detail}",
			"tab.quota": "额度",
			"tab.models": "模型",
			"tab.access": "接入",
			"section.balance": "魔粒余额（官方数据）",
			"section.local": "本地调用（仅经本插件的调用）",
			"section.trend": "近 {days} 天本地调用趋势",
			"section.events": "限流与错误事件",
			"section.catalog": "模型目录（免认证，不耗额度）",
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
			"models.count": "{count} 个模型",
			"models.none": "目录暂不可读：{error}",
			"models.loading": "读取目录中…",
			"models.fetched": "读取于 {time}",
			"models.probeUsage": "试调",
			"probe.usage": "测试一次调用（消耗 1 次额度）",
			"probe.validity": "验令牌（零额度）",
			"probe.busy": "请求中…",
			"probe.ok": "调用成功：{tokens} tokens / {ms}ms",
			"probe.validOk": "令牌有效（HTTP {status}）",
			"probe.fail": "失败：{error}",
			"models.probeKept": "试调（单次，消耗 1 次免费额度）",
			"models.viewOnSite": "在魔搭查看 →",
			"models.viewOnSiteTitle": "打开模型详情页（魔粒单价等只在网页展示）",
			"section.provider": "接入为 DSH 模型",
			"provider.enable": "把魔搭模型接入 DSH 模型选择器",
			"provider.on": "已接入",
			"provider.off": "未接入",
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
			"trend.none": "还没有本地调用记录。",
			"trend.legend": "柱长相对区间内最大值，仅本地口径。",
			"events.none": "暂无事件。",
			"events.quota": "额度",
			"events.rate_limit": "限频",
			"events.error": "错误",
			"token.status": "状态：{present}（来源 {source}，校验 {valid}）",
			"token.save": "保存",
			"token.forget": "忘掉已保存",
			"token.placeholder": "粘贴 ms-… 访问令牌",
			"token.hint": "在魔搭「访问令牌」页生成；面板默认读取凭据服务中的 MODELSCOPE_API_KEY，环境变量为回退。",
			"token.ephemeral": "此 Host 没有凭据服务：面板保存的令牌重启即丢，请改用凭据服务或环境变量。",
			"token.link": "打开魔搭访问令牌页 →",
			"source.credentials": "凭据服务",
			"source.env": "环境变量",
			"source.memory": "内存",
			"source.none": "无",
			"present.yes": "已配置",
			"present.no": "未配置",
			"validity.yes": "有效",
			"validity.no": "未校验"
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
			"panel.authError": "Token rejected (401/403). Replace the access token in the Access tab.",
			"panel.noToken": "No ModelScope access token configured yet. Paste an ms-… token in the Access tab.",
			"panel.shapeDrift": "Upstream shape may have changed: {detail}",
			"tab.quota": "Quota",
			"tab.models": "Models",
			"tab.access": "Access",
			"section.balance": "Magicube balance (official)",
			"section.local": "Local calls (only through this plugin)",
			"section.trend": "Local call trend, last {days} days",
			"section.events": "Rate-limit and error events",
			"section.catalog": "Model catalog (unauthenticated, free)",
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
			"models.count": "{count} models",
			"models.none": "Catalog unavailable: {error}",
			"models.loading": "Loading catalog…",
			"models.fetched": "read at {time}",
			"models.probeUsage": "Try",
			"probe.usage": "Test one call (consumes 1 free call)",
			"probe.validity": "Verify token (free)",
			"probe.busy": "Working…",
			"probe.ok": "Call succeeded: {tokens} tokens / {ms}ms",
			"probe.validOk": "Token valid (HTTP {status})",
			"probe.fail": "Failed: {error}",
			"models.probeKept": "Test call (consumes one free call)",
			"models.viewOnSite": "View on ModelScope →",
			"models.viewOnSiteTitle": "Open the model page (per-model Magicube price is web-only)",
			"section.provider": "Register as a DSH model",
			"provider.enable": "Register ModelScope models in the DSH model picker",
			"provider.on": "On",
			"provider.off": "Off",
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
			"trend.none": "No local call records yet.",
			"trend.legend": "Bar lengths are relative to the maximum in the range (local scope only).",
			"events.none": "No events.",
			"events.quota": "Quota",
			"events.rate_limit": "Rate limit",
			"events.error": "Error",
			"token.status": "Status: {present} (source {source}, check {valid})",
			"token.save": "Save",
			"token.forget": "Forget saved",
			"token.placeholder": "Paste an ms-… access token",
			"token.hint": "Generate one on the ModelScope access-token page; the panel reads MODELSCOPE_API_KEY from the credentials service first, environment as fallback.",
			"token.ephemeral": "This Host has no credentials service: a token saved in the panel is lost on restart. Use the credentials service or an environment variable.",
			"token.link": "Open the ModelScope access-token page →",
			"source.credentials": "credentials",
			"source.env": "environment",
			"source.memory": "memory",
			"source.none": "none",
			"present.yes": "configured",
			"present.no": "not configured",
			"validity.yes": "verified",
			"validity.no": "unverified"
		};
	}));

//#endregion
//#region src/client/format.ts
/** Time and number formatters（与姊妹插件 format.ts 受控复制，按需裁剪）。 */
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
	/**
	* 同日的时刻显示 `HH:MM`，跨日带日期——头部「更新于」必须能熬过隔天，
	* 否则次日早上读「更新于 20:39」像 20 分钟前。
	*/
	function when(epoch) {
		if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
		const date = /* @__PURE__ */ new Date(epoch * 1e3);
		const now = /* @__PURE__ */ new Date();
		if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) {
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}
		return clockLong(epoch);
	}
	/** 数字文本：≥10000 整数千分位，否则最多两位小数。 */
	function count(value) {
		const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
		if (number >= 1e4) return Math.round(number).toLocaleString();
		return String(Math.round(number * 100) / 100);
	}
	/** 填 `{token}` 模板。 */
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
				outline: "none"
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
			poolsGrid: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
				gap: 12,
				alignItems: "start"
			},
			cardHead: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				flexWrap: "wrap"
			},
			poolName: {
				fontSize: 15,
				fontWeight: 600
			},
			chip: {
				display: "inline-flex",
				alignItems: "center",
				height: 22,
				padding: "0 8px",
				borderRadius: 999,
				fontSize: 12,
				border: "1px solid var(--dsw-alias-border-l1)",
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-secondary)"
			},
			grantChip: {
				display: "inline-flex",
				alignItems: "center",
				fontSize: 13,
				color: "var(--dsw-alias-label-primary)",
				fontVariantNumeric: "tabular-nums"
			},
			quotas: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))",
				gap: 10,
				marginTop: 14
			},
			quota: {
				display: "flex",
				flexDirection: "column",
				gap: 8,
				minWidth: 0,
				padding: "12px 14px",
				borderRadius: 10,
				background: "var(--dsw-alias-bg-layer-2)"
			},
			quotaTop: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 8,
				flexWrap: "wrap"
			},
			quotaLabel: {
				fontSize: 12,
				fontWeight: 500,
				color: "var(--dsw-alias-label-secondary)"
			},
			statHeadline: {
				fontSize: 18,
				lineHeight: "22px",
				fontWeight: 650,
				letterSpacing: "-0.02em",
				fontVariantNumeric: "tabular-nums"
			},
			statCaption: {
				fontSize: 11,
				lineHeight: "15px",
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums"
			},
			statError: { color: "var(--dsw-alias-state-error-primary)" },
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
			quotaReset: {
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary)"
			},
			quotaRemaining: {
				fontSize: 18,
				lineHeight: "22px",
				fontWeight: 650,
				letterSpacing: "-0.02em",
				fontVariantNumeric: "tabular-nums"
			},
			quotaUsed: {
				fontSize: 11,
				lineHeight: "15px",
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums"
			},
			bar: {
				height: 6,
				borderRadius: 3,
				background: "var(--dsw-alias-bg-layer-1)",
				overflow: "hidden"
			},
			barFill: {
				height: "100%",
				borderRadius: 3,
				background: BRAND
			},
			barFillWarn: { background: "var(--dsw-alias-state-warn-primary)" },
			barFillError: { background: "var(--dsw-alias-state-error-primary)" },
			details: {
				marginTop: 12,
				paddingTop: 10,
				borderTop: "1px solid var(--dsw-alias-border-l1)"
			},
			detailsSummary: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				cursor: "pointer",
				userSelect: "none"
			},
			detailsBody: {
				display: "flex",
				flexDirection: "column",
				gap: 10,
				marginTop: 10
			},
			grant: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			models: {
				display: "flex",
				flexWrap: "wrap",
				gap: 6
			},
			modelTag: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 11,
				padding: "2px 6px",
				borderRadius: 6,
				background: "var(--dsw-alias-bg-layer-2)",
				border: "1px solid var(--dsw-alias-border-l1)"
			},
			trendHead: {
				display: "flex",
				alignItems: "baseline",
				justifyContent: "space-between",
				gap: 12,
				paddingBottom: 6,
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			trendHeadLabel: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				fontWeight: 500
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
			muted: { color: "var(--dsw-alias-label-secondary)" },
			error: { color: "var(--dsw-alias-state-error-primary)" },
			empty: {
				color: "var(--dsw-alias-label-secondary)",
				padding: "18px 0"
			},
			field: {
				display: "flex",
				flexDirection: "column",
				gap: 6,
				marginBottom: 12
			},
			fieldLabel: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
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
			primaryHover: { background: "var(--dsw-alias-button-primary-hover)" },
			primaryBusy: {
				opacity: .6,
				cursor: "default"
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
			modelRate: {
				flex: "none",
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums"
			},
			modelBadge: {
				flex: "none",
				fontSize: 11,
				padding: "1px 7px",
				borderRadius: 999,
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-secondary)"
			},
			modelMeta: {
				paddingLeft: 25,
				fontSize: 11,
				lineHeight: "15px",
				color: "var(--dsw-alias-label-secondary)"
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
			}
		};
	}));

//#endregion
//#region src/client/snapshot.ts
/** 读一个快照应答。HTTP 恒 200，成败看 body.ok。 */
	function interpretSnapshot(body) {
		const payload = body;
		if (payload && payload.ok === false) return {
			data: null,
			error: {
				message: payload.error || "unexpected payload",
				code: payload.code
			}
		};
		if (!payload || payload.ok !== true) return {
			data: null,
			error: "unexpected payload"
		};
		return {
			data: payload,
			error: null
		};
	}
	/**
	* 把 wire/路由返回的 provider 块归一成 `ProviderStatus`；不合法一律降级。
	* 形状由 wire.ts 钉死，本函数只做防御性归一（旧 Host 可能缺字段）。
	*/
	function providerOf(raw) {
		if (raw === null || typeof raw !== "object") return DEGRADED_PROVIDER;
		const p = raw;
		const ids = Array.isArray(p.enabledIds) ? p.enabledIds.map((id) => String(id ?? "")).filter((id) => id !== "") : [];
		const roster = Array.isArray(p.roster) ? p.roster.map((entry) => {
			const row = entry ?? {};
			const id = String(row.id ?? "");
			return {
				id,
				name: typeof row.name === "string" && row.name !== "" ? row.name : id,
				vision: row.vision === true,
				available: row.available !== false,
				quotaExhausted: row.quotaExhausted === true
			};
		}).filter((entry) => entry.id !== "") : [];
		return {
			enabled: p.enabled === true,
			source: p.source === "panel" ? "panel" : "config",
			llmAvailable: p.llmAvailable === true,
			registered: p.registered === true,
			error: typeof p.error === "string" ? p.error : null,
			modelCount: typeof p.modelCount === "number" ? p.modelCount : roster.length,
			enabledCount: typeof p.enabledCount === "number" ? p.enabledCount : 0,
			allowed: p.allowed === "none" ? "none" : p.allowed === "list" ? "list" : "all",
			enabledIds: ids,
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
	/** 面板决策：这张快照意味着什么。纯函数，Node 套件驱动同一个函数。 */
	function viewOf(data, error, tt) {
		const failure = error === null || error === void 0 ? null : typeof error === "string" ? {
			message: error,
			code: null
		} : error;
		const needsSetup = data === null && !FORM_EXCLUDED_CODES.has(failure?.code ?? null);
		const guidanceKey = failure === null ? null : GUIDANCE_BY_CODE[failure.code] ?? null;
		return {
			failure,
			needsSetup,
			guidanceKey,
			guidance: guidanceKey === null ? null : guidanceKey === "panel.configError" ? format(tt(guidanceKey), { error: failure?.message }) : tt(guidanceKey),
			shapeWarnings: Array.isArray(data?.shapeWarnings) ? data.shapeWarnings : []
		};
	}
	var DEGRADED_PROVIDER, GUIDANCE_BY_CODE, FORM_EXCLUDED_CODES;
	var init_snapshot = __esmMin((() => {
		init_format();
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
			roster: []
		});
		GUIDANCE_BY_CODE = Object.freeze({
			auth_error: "panel.authError",
			config_error: "panel.configError",
			network_error: "panel.networkError",
			timeout_error: "panel.timeout",
			upstream_error: "panel.upstream",
			rate_limited: "panel.upstream",
			quota_exceeded: "panel.upstream"
		});
		FORM_EXCLUDED_CODES = Object.freeze(/* @__PURE__ */ new Set([
			"config_error",
			"network_error",
			"timeout_error",
			"upstream_error",
			"rate_limited",
			"quota_exceeded"
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
				border: `1px solid ${on ? "var(--modelscope-brand, #7B3FF2)" : "var(--dsw-alias-border-l2, #36373b)"}`,
				background: on ? "var(--modelscope-brand, #7B3FF2)" : "var(--dsw-alias-bg-layer-2, #2a2b31)",
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
		TRACK_W = 30;
		TRACK_H = 17;
		THUMB = 12;
		TRAVEL = 13;
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
		const { daily, perModel } = snapshot.quota;
		return h("div", { style: S.card }, h("div", { style: S.poolName }, format(tt("quota.headline"), {
			calls: count(daily.usedLocal),
			models: count(perModel.length)
		})), h(ModelUsageTable, {
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
	/** 近 N 天本地调用趋势（天桶；缺桶 = 该日 0 次，真实零）。 */
	function TrendBars({ buckets, tt }) {
		if (!Array.isArray(buckets) || buckets.length === 0) return h("div", { style: S.trendLegend }, tt("trend.none"));
		const max = Math.max(0, ...buckets.map((b) => Math.max(0, b.calls)));
		return h("div", null, buckets.map((bucket) => h("div", {
			key: bucket.dateKey,
			style: S.trendRowHead
		}, h("span", { style: S.trendModel }, bucket.dateKey), h("div", {
			style: {
				...S.trendBar,
				flex: "1",
				marginLeft: 10
			},
			"aria-hidden": "true"
		}, max > 0 && bucket.calls > 0 ? h("div", { style: {
			...S.barFill,
			width: `${bucket.calls / max * 100}%`
		} }) : null), h("span", { style: S.quotaUsed }, String(bucket.calls)))), h("div", { style: S.trendLegend }, tt("trend.legend")));
	}
	/** 事件流（429/错误），Newest-first。 */
	function EventsList({ events, tt }) {
		if (!Array.isArray(events) || events.length === 0) return h("div", { style: S.trendLegend }, tt("events.none"));
		return h("div", null, events.map((event, index) => h("div", {
			key: `${event.at}-${index}`,
			style: S.trendRowHead
		}, h("span", { style: S.quotaUsed }, isoTime(event.at)), h("span", { style: S.modelTag }, tt(EVENT_KIND_KEY[event.kind])), h("span", {
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
		const source = token === null ? "none" : token.source;
		const sourceKey = source === "credentials" ? "source.credentials" : source === "env" ? "source.env" : source === "memory" ? "source.memory" : "source.none";
		const validKey = token !== null && token.valid === true ? "validity.yes" : "validity.no";
		return h("div", null, h("div", { style: S.quotaUsed }, format(tt("token.status"), {
			present: token !== null && token.present ? tt("present.yes") : tt("present.no"),
			source: tt(sourceKey),
			valid: tt(validKey)
		})), token !== null && token.ephemeral ? h("div", { style: S.formNote }, tt("token.ephemeral")) : null, h("div", { style: S.rosterTools }, h("input", {
			style: S.input,
			type: "password",
			placeholder: tt("token.placeholder"),
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
		}, tt("token.save")), token !== null && token.present ? h("button", {
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
	* 不是任何真实模型 id，所以同一套 `draft.includes(id)` 的勾选判断天然不会把
	* 它画成勾中——不需要特判。
	*
	* 额度耗尽的模型保留在清单里（灰显、勾选框禁用），这是故意的：roster 是目录
	* 事实，picker 那边由 Host 自己丢掉它们，面板不替它删。
	*/
	function ProviderCard({ provider, busy, error, onToggle, onSaveList, onReset, tokenPresent, tt }) {
		const status = providerOf(provider);
		const enabled = status.enabled === true;
		const hostIds = status.enabledIds;
		const hostKey = useMemo(() => JSON.stringify(hostIds), [hostIds]);
		const [draft, setDraft] = useState(() => hostIds.slice());
		useEffect(() => {
			setDraft(hostIds);
		}, [hostKey]);
		const roster = status.roster;
		const rosterIds = roster.map((row) => row.id);
		const toggleOne = (id) => setDraft((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
		const ticked = roster.filter((row) => draft.includes(row.id)).length;
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
				setDraft([HIDE_ALL_MODELS]);
				onSaveList([HIDE_ALL_MODELS]);
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
				checked: draft.includes(id),
				disabled: busy || unusable,
				onChange: () => toggleOne(id),
				style: S.modelCheck,
				"aria-label": id
			}), h("span", {
				style: S.modelName,
				title: id
			}, row.name)), row.vision === true ? h("span", { style: S.modelBadge }, tt("provider.vision")) : null, row.quotaExhausted === true ? h("span", { style: {
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
		return h("div", null, switchRow, statusNode, tokenHint, h("div", { style: {
			...S.sectionTitle,
			margin: "18px 0 8px"
		} }, tt("provider.models")), rosterBlock, error !== null ? h("div", {
			style: S.formError,
			role: "alert"
		}, error) : null);
	}
	var EVENT_KIND_KEY;
	var init_cards = __esmMin((() => {
		init_format();
		init_runtime();
		init_styles();
		init_const();
		init_snapshot();
		init_toggle_switch();
		EVENT_KIND_KEY = {
			quota: "events.quota",
			rate_limit: "events.rate_limit",
			error: "events.error"
		};
	}));

//#endregion
//#region src/client/http.ts
/** POST 并解析 body；非 JSON 响应返回 null。 */
	async function postJson(path, payload) {
		return await (await fetch(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json"
			},
			cache: "no-store",
			body: JSON.stringify(payload)
		})).json().catch(() => null);
	}
	/** POST 并要求 ok:true；否则抛 Host 自己的 error 文案。 */
	async function postJsonOrThrow(path, payload) {
		const response = await fetch(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json"
			},
			cache: "no-store",
			body: JSON.stringify(payload)
		});
		const body = await response.json().catch(() => null);
		if (body === null || body.ok !== true) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
		return body;
	}
	/** GET 同源 JSON；非 2xx 或非 JSON 返回 null（调用方决定怎么降级）。 */
	async function getJson(path) {
		const response = await fetch(path, {
			headers: { accept: "application/json" },
			cache: "no-store"
		});
		if (!response.ok) return null;
		return await response.json().catch(() => null);
	}
	var init_http = __esmMin((() => {}));

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
		const generation = useRef(0);
		const inFlight = useRef(null);
		const load = useCallback(async () => {
			generation.current += 1;
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
				const body = await response.json();
				if (!isCurrent()) return;
				const read = interpretSnapshot(body);
				if (read.data === null) {
					setData(null);
					setError(read.error);
					return;
				}
				setData(read.data);
				setError(null);
				setUpdatedAt(Date.now());
				const stated = read.data?.pollSeconds;
				if (typeof stated === "number" && Number.isFinite(stated)) setCadenceMs(statedCadenceMs(stated, cadenceMs));
			} catch (reason) {
				if (!isCurrent()) return;
				setError(errorText(reason));
			} finally {
				if (isCurrent()) setLoadedOnce(true);
				if (inFlight.current === controller) inFlight.current = null;
			}
		}, [cadenceMs]);
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
			load
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
		const { data, error, loadedOnce, updatedAt, load } = useSnapshotPolling();
		const [, setLocaleRevision] = useState(0);
		const [openSections, setOpenSections] = useState({
			balance: true,
			local: true,
			trend: true,
			events: false,
			catalog: true,
			provider: true,
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
		const { failure, needsSetup, guidance, shapeWarnings } = viewOf(data, error, tt);
		const showSetup = needsSetup && loadedOnce;
		const [catalog, setCatalog] = useState(null);
		const [catalogError, setCatalogError] = useState(null);
		const loadCatalog = useCallback(async () => {
			try {
				const body = await getJson(MODELS_PATH);
				if (body !== null && body.ok === true && Array.isArray(body.models)) {
					setCatalog({
						ids: body.models.map((m) => String(m.id ?? "")).filter((id) => id !== ""),
						fetchedAt: typeof body.fetchedAt === "string" ? body.fetchedAt : ""
					});
					setCatalogError(null);
				} else setCatalogError(typeof body?.error === "string" ? body.error : "HTTP error");
			} catch (reason) {
				setCatalogError(errorText(reason));
			}
		}, []);
		useEffect(() => {
			if (activeTab === "models" && catalog === null) loadCatalog();
		}, [
			activeTab,
			catalog,
			loadCatalog
		]);
		const rawProvider = data?.provider;
		const hasProviderBlock = rawProvider !== void 0 && rawProvider !== null;
		const [fetchedProvider, setFetchedProvider] = useState(null);
		const provider = hasProviderBlock ? providerOf(rawProvider) : fetchedProvider ?? DEGRADED_PROVIDER;
		useEffect(() => {
			if (hasProviderBlock) return void 0;
			let cancelled = false;
			getJson(PROVIDER_PATH).then((body) => {
				if (!cancelled && body !== null && body.ok === true) setFetchedProvider(providerOf(body));
			}).catch(() => {});
			return () => {
				cancelled = true;
			};
		}, [hasProviderBlock]);
		const [providerBusy, setProviderBusy] = useState(false);
		const [providerError, setProviderError] = useState(null);
		const runProviderWrite = useCallback(async (path, payload) => {
			setProviderBusy(true);
			setProviderError(null);
			try {
				const body = await postJson(path, payload);
				if (body === null || body.ok !== true) throw new Error(typeof body?.error === "string" ? body.error : "HTTP error");
				load();
			} catch (reason) {
				setProviderError(format(tt("provider.error"), { error: errorText(reason) }));
			} finally {
				setProviderBusy(false);
			}
		}, [load, tt]);
		const toggleProvider = useCallback((enabled) => void runProviderWrite(PROVIDER_PATH, { enabled }), [runProviderWrite]);
		const saveRoster = useCallback((enabledIds) => void runProviderWrite(PROVIDER_ROSTER_PATH, { enabledIds }), [runProviderWrite]);
		const resetProvider = useCallback(() => void runProviderWrite(PROVIDER_RESET_PATH, {}), [runProviderWrite]);
		const [probeBusy, setProbeBusy] = useState(false);
		const [probeResult, setProbeResult] = useState(null);
		const [probeError, setProbeError] = useState(null);
		const runProbe = useCallback(async (modelId, kind) => {
			setProbeBusy(true);
			setProbeResult(null);
			setProbeError(null);
			try {
				const body = await postJson(PROBE_PATH, {
					modelId,
					kind
				});
				if (body !== null && body.ok === true) {
					const usage = body.usage;
					setProbeResult(kind === "usage" && usage !== null && usage !== void 0 ? format(tt("probe.ok"), {
						tokens: usage.totalTokens ?? 0,
						ms: Number(body.elapsedMs ?? 0)
					}) : format(tt("probe.validOk"), { status: Number(body.status ?? 0) }));
					load();
				} else setProbeError(typeof body?.error === "string" ? body.error : "HTTP error");
			} catch (reason) {
				setProbeError(errorText(reason));
			} finally {
				setProbeBusy(false);
			}
		}, [tt, load]);
		const [tokenBusy, setTokenBusy] = useState(false);
		const [tokenError, setTokenError] = useState(null);
		const saveToken = useCallback(async (value) => {
			setTokenBusy(true);
			setTokenError(null);
			try {
				const body = await postJson(TOKEN_PATH, { token: value });
				if (body === null || body.ok !== true) throw new Error(typeof body?.error === "string" ? body.error : "HTTP error");
				load();
			} catch (reason) {
				setTokenError(errorText(reason));
			} finally {
				setTokenBusy(false);
			}
		}, [load]);
		const forgetToken = useCallback(async () => {
			setTokenBusy(true);
			setTokenError(null);
			try {
				await postJson(TOKEN_FORGET_PATH, {});
				load();
			} catch (reason) {
				setTokenError(errorText(reason));
			} finally {
				setTokenBusy(false);
			}
		}, [load]);
		const tokenState = data?.token ?? null;
		const sampleModel = data?.models.sample[0] ?? null;
		const [verifyBusy, setVerifyBusy] = useState(false);
		const [verifyNote, setVerifyNote] = useState(null);
		const [verifyError, setVerifyError] = useState(null);
		const runValidity = useCallback(async (modelId) => {
			setVerifyBusy(true);
			setVerifyNote(null);
			setVerifyError(null);
			try {
				const body = await postJson(PROBE_PATH, {
					modelId,
					kind: "validity"
				});
				if (body !== null && body.ok === true) setVerifyNote(format(tt("probe.validOk"), { status: Number(body.status ?? 0) }));
				else setVerifyError(typeof body?.error === "string" ? body.error : "HTTP error");
			} catch (reason) {
				setVerifyError(errorText(reason));
			} finally {
				setVerifyBusy(false);
			}
		}, [tt]);
		const quotaBody = () => {
			if (data === null) return h("div", { style: S.empty }, failure === null ? tt("panel.loading") : h("div", { role: "alert" }, guidance ?? format(tt("panel.error"), { error: failure.message })));
			if (showSetup && failure !== null) return h("div", {
				style: S.empty,
				role: "alert"
			}, guidance ?? format(tt("panel.error"), { error: failure.message }));
			const snap = data;
			return h("div", null, snap.token.present === false ? h("div", {
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
				title: format(tt("section.trend"), { days: snap.trend.days }),
				open: openSections.trend,
				onToggle: () => toggleSection("trend"),
				tt
			}, h(TrendBars, {
				buckets: snap.trend.buckets,
				tt
			})), h(SectionCard, {
				title: tt("section.events"),
				open: openSections.events,
				onToggle: () => toggleSection("events"),
				tt
			}, h(EventsList, {
				events: snap.events,
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
			onReset: resetProvider,
			tokenPresent: data?.token.present === true,
			tt
		})), h(SectionCard, {
			title: catalog !== null ? `${tt("section.catalog")} · ${format(tt("models.count"), { count: catalog.ids.length })}` : tt("section.catalog"),
			open: openSections.catalog,
			onToggle: () => toggleSection("catalog"),
			tt
		}, catalog === null && catalogError === null ? h("div", { style: S.trendLegend }, tt("models.loading")) : null, catalogError !== null ? h("div", {
			style: S.formNote,
			role: "status"
		}, format(tt("models.none"), { error: catalogError })) : null, catalog !== null ? h("div", null, h("div", { style: S.trendLegend }, format(tt("models.fetched"), { time: isoTime(catalog.fetchedAt) })), catalog.ids.map((id) => h("div", {
			key: id,
			style: S.trendRowHead
		}, h("span", {
			style: S.trendModel,
			title: id
		}, id), h("button", {
			type: "button",
			style: S.button,
			disabled: probeBusy,
			onClick: () => void runProbe(id, "usage"),
			title: tt("probe.usage")
		}, tt("models.probeKept")), h("a", {
			style: {
				...S.formNote,
				margin: 0
			},
			href: modelscopeModelUrl(id),
			target: "_blank",
			rel: "noreferrer",
			title: tt("models.viewOnSiteTitle")
		}, tt("models.viewOnSite"))))) : null, probeBusy ? h("div", { style: S.formNote }, tt("probe.busy")) : null, probeResult !== null ? h("div", {
			style: S.formNote,
			role: "status"
		}, probeResult) : null, probeError !== null ? h("div", {
			style: S.formError,
			role: "alert"
		}, format(tt("probe.fail"), { error: probeError })) : null));
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
		init_use_polling_interval();
		init_use_snapshot_polling();
		init_http();
		function clientFactory(loaderRequire) {
			provideClientReact(loaderRequire("react"));
			/** 测试面：浏览器用的真实定义，没有一件只为测试而存在。 */
			const panel = Object.freeze({
				interpretSnapshot,
				viewOf,
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
					when,
					usePollingInterval,
					useSnapshotPolling,
					getJson,
					postJson,
					postJsonOrThrow
				}),
				components: Object.freeze({
					BalanceCard,
					EventsList,
					LocalDailyCard,
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