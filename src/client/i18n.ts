/**
 * 两份字典，跨语言保持键一致（en 类型钉为 typeof zh，缺键即编译错）。
 * @module dsh-connect-modelscope-token-plan/client/i18n
 */
import type { Tt } from "./runtime.ts";

/** 简体中文（键集的真源）。 */
export const zh = {
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
  "section.local": "本地调用（本客户端 · 仅经本插件）",
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
  // 单模型排行榜的两个读数各自带单位。裸后缀 `t`（`2 · 21,695t`）既不是 K/M 那样
  // 的量级后缀，也不是任何语言的单位词，第一次看到只能猜。平台自己的叫法就是
  // token（目录键叫 `max_context_tokens`），照抄它。
  "quota.rowCalls": "{calls} 次",
  "quota.rowTokens": "{tokens} token",
  "quota.note": "本地口径：只统计本客户端经本插件的调用（桌面端与 Web 端各记各的）；直连魔搭的其它客户端不计入。消耗总量以官方魔粒余额为准。",
  "quota.unavailable": "本地计数本次读不到（原因见上方提示）",

  // 目录表与其行内 usage 试调已删除（见 panel-page.ts modelsBody 注释），
  // 所以只留 token 管理用的零额度 validity probe；models.none / models.loading
  // 两个旧键已随之删除（无消费方）。
  "probe.validity": "验令牌（零额度）",
  "probe.validOk": "令牌有效（HTTP {status}）",
  "probe.fail": "失败：{error}",

  // 模型 tab 顶部「接入为 DSH 模型」区块（provider 注册 + 允许清单）。
  // 目录表与它的行内 usage 试调一并删除（见 panel-page.ts modelsBody 注释），
  // 所以只剩 token 管理用的零额度 validity probe。
  "models.viewOnSite": "在魔搭查看 →",
  "models.viewOnSiteTitle": "打开模型详情页（魔粒单价等只在网页展示）",
  "models.featuredTitle": "推荐厂商（深度求索 / 智谱 / 通义千问）——它们的模型置顶显示",
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
  "provider.search": "搜索模型名或 ID",
  "provider.noMatch": "没有匹配的模型。",
  "provider.groupCount": "{count} 个",
  "provider.groupSelected": "已选 {count}",
  "provider.quotaExhausted": "额度耗尽",
  "provider.vision": "视觉",
  "provider.notConfigured": "还没有访问令牌，先到「接入」tab 配置",
  "provider.source.panel": "面板",
  "provider.source.config": "配置",
  // 清单行徽章的 tooltip 用 `contextWindow`（泛称「上下文窗口」）；底部那个
  // 选择器是**覆盖**开关，配 `contextDefault` 读成一对「覆盖 / 不覆盖」——
  // 旧文案「默认（跟随目录）」把「不覆盖」说成了「跟随目录」，而它恰恰是盖过
  // 目录与策展表的那一级，名不副实。
  "provider.contextWindow": "上下文窗口",
  "provider.contextWindowOverride": "上下文窗口覆盖",
  "provider.contextDefault": "不覆盖（默认）",
  "provider.contextHint": "目录未声明窗口时套用此值（会盖过内置策展表）；保存后立即重新注册",
  "provider.contextCuratedTitle": "窗口来自内置策展表（models.dev 交叉真值），平台未亲口声明；带 * 标记",
  // 输出上限三件套。与窗口那一组刻意分开命名：窗口有「覆盖 / 策展 / 兜底」三级，
  // 输出上限只有「覆盖 / 目录声明」两级（目录从不返回它，所以实际上只有覆盖一级），
  // 复用 context* 的措辞会把两条真值链说成一条。
  "provider.maxOutput": "最大输出",
  "provider.maxOutputOverrideTitle": "最大输出：来自 maxTokensOverrides 里你写的值（盖过目录声明）",
  // 常驻说明。它回答的正是「为什么一个模型都没带徽章」——徽章缺席 ≠ 没有上限，
  // 而是**32768 的 harness 兜底正在生效**。这是本面板最容易读反的一处。
  "provider.maxOutputHint": "魔搭目录不返回输出上限，未覆盖的模型按 harness 默认（32768）截断；要更大就在 maxTokensOverrides 里逐模型写实测值（面板徽章用「最大输出」显示生效值）",

  "section.draw": "出图工具",
  "draw.enable": "开启后，agent 可在对话里用 modelscope_draw_image 生成或编辑图片",
  "draw.on": "已开启",
  "draw.off": "未开启",
  "draw.busy": "切换中…",
  "draw.mounted": "已注册：{tool}",
  "draw.notMounted": "未注册——打开上方开关即可开启。",
  "draw.restartHint": "开关立即保存；工具要到下次启动 DSH 才挂载（挂载后无法撤销）。",
  "draw.currentNone": "当前目录里没有可出图的模型——出图会失败（先确认访问令牌已配置、目录已拉到）。",
  "draw.currentSrc.declaredTextToImage": "平台声明为文生图",
  "draw.currentSrc.knownTextToImage": "已知可纯文生图",
  "draw.currentSrc.catalogFirst": "目录里的第一个出图模型",
  "draw.autoHint": "由插件按能力挑；当前会选 {model}",
  "draw.autoHintReason": "由插件按能力挑；当前会选 {model}（{reason}）",
  "draw.models": "出图模型",
  "draw.badge": "出图",
  "draw.badge.textToImage": "文生图",
  "draw.badge.imageToImage": "图生图",
  "draw.imageOnlyTitle": "该模型只能图生图/改图：必须通过 imageUrl 传一张输入图，不能纯文生图。",
  "draw.auto": "自动选择",
  "draw.noCandidates": "当前目录里没有可出图的模型，这个工具暂时用不了。",
  "draw.needsKey": "还没有访问令牌，先到「接入」tab 配置。",
  "draw.reset": "回到默认",
  "draw.error": "出图设置保存失败：{error}",
  "draw.source.panel": "面板",
  "draw.source.config": "配置",
  "draw.absent.noTools": "开关已开，但本机没有 tools 服务，工具没挂上（Host 侧限制，不是配置问题）。",
  "draw.absent.peerLoad": "开关已开，但 tools 模块加载失败，出图工具缺席（Host 问题，非配置）。",
  "draw.absent.registry": "开关已开，但工具注册被 Host 拒绝，出图工具缺席（Host 问题，非配置）。",
  "draw.absent.unknown": "开关已开，但出图工具未挂载，原因未知。",

  "trend.none": "还没有本地调用记录。",
  "trend.legend": "柱长相对区间内最大值，仅本地口径。",
  "trend.metric": "趋势指标",
  "trend.metricCalls": "调用次数",
  "trend.metricTokens": "token 数",
  // token 口径的两处既有歧义，明说出来：①失败调用不计 token（上游没给 usage），
  // ②旧数据的天桶缺字段时补的是 0。两者在图上都读作「0 token」，与真的用了 0 分不开。
  "trend.legendTokens": "按 token 数相对区间内最大值画柱，仅本地口径；失败调用没有用量记录，与「该日无数据」一样显示为 0。",
  "trend.window": "显示天数",
  "trend.windowDefault": "默认（跟随配置）",
  "trend.windowDays": "{days} 天",
  "trend.windowHint": "只决定画多少天；能回看多久另有一个保留窗口（留得比画得多才画得出更远）。",

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

  // 对话框用量胶囊（输入框工具栏 `conversation.input.right` 座席）。两个读数的
  // 来源不同，所以正文里必须各带各的口径：魔粒来自官方接口
  // （`composer.balanceUnit`），次数来自 Host 侧的本地日桶——`composer.localCalls`
  // 里的「本地」不是修饰语，是「这个数字官方查不到」的说明。别把两句并成一句。
  "composer.prefix": "魔搭",
  "composer.pillTitle": "魔搭额度：官方魔粒余额 + 今日本地调用次数",
  "composer.balanceUnit": "魔粒",
  "composer.localCalls": "今日本地 {calls} 次",
  "composer.stale": "上次数据"
};

/** English dictionary, key-parity pinned by the type. */
export const en: typeof zh = {
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
  "section.local": "Local calls (this client · only through this plugin)",
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
  "quota.rowCalls": "{calls} calls",
  "quota.rowTokens": "{tokens} tokens",
  "quota.note": "Local scope: only calls this client made through this plugin are counted (desktop and web keep separate ledgers); clients calling ModelScope directly are not. Total consumption is governed by the official Magicube balance.",
  "quota.unavailable": "Local counters could not be read this time (reason in the notices above)",

  // The catalog table and its per-row usage probe were removed (see the
  // panel-page.ts modelsBody comment), so models.none / models.loading were
  // deleted together with it (no consumers left).
  "probe.validity": "Verify token (free)",
  "probe.validOk": "Token valid (HTTP {status})",
  "probe.fail": "Failed: {error}",

  // The "register as a DSH model" block at the top of the Models tab.
  // The catalog table and its per-row usage probe were removed (see the
  // panel-page.ts modelsBody comment), leaving only the free validity probe
  // the token form uses.
  "models.viewOnSite": "View on ModelScope →",
  "models.viewOnSiteTitle": "Open the model page (per-model Magicube price is web-only)",
  "models.featuredTitle": "Recommended vendors (DeepSeek / Zhipu / Qwen) — their models are pinned to the top",
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
  "provider.search": "Search model name or ID",
  "provider.noMatch": "No matching models.",
  "provider.groupCount": "{count}",
  "provider.groupSelected": "{count} selected",
  "provider.quotaExhausted": "Quota exhausted",
  "provider.vision": "vision",
  "provider.notConfigured": "No token yet — configure it in the Access tab",
  "provider.source.panel": "panel",
  "provider.source.config": "config",
  "provider.contextWindow": "Context window",
  "provider.contextWindowOverride": "Context window override",
  "provider.contextDefault": "No override (default)",
  "provider.contextHint": "Applied when the catalog declares no window (it overrides the built-in curated table); re-registers immediately",
  "provider.contextCuratedTitle": "Window from the built-in curated table (models.dev cross-check), not declared by the platform; marked with *",
  "provider.maxOutput": "Max output",
  "provider.maxOutputOverrideTitle": "Max output: the value you wrote in maxTokensOverrides (it wins over the catalogue)",
  "provider.maxOutputHint": "The ModelScope catalogue returns no output ceiling, so models without an override are cut off at the harness default (32768); write per-model measured values in maxTokensOverrides for more (the badge shows the effective value)",

  "section.draw": "Draw tool",
  "draw.enable": "Once on, the agent can generate or edit images with modelscope_draw_image",
  "draw.on": "On",
  "draw.off": "Off",
  "draw.busy": "Switching…",
  "draw.mounted": "Registered: {tool}",
  "draw.notMounted": "Not registered — turn the switch above on.",
  "draw.restartHint": "The switch saves at once; the tool mounts the next time DSH starts (a mount cannot be undone).",
  "draw.currentNone": "No image model in the catalogue right now — drawing will fail (check the access token and that the catalogue has loaded).",
  "draw.currentSrc.declaredTextToImage": "platform-declared text-to-image",
  "draw.currentSrc.knownTextToImage": "known to accept text-to-image",
  "draw.currentSrc.catalogFirst": "first image model in the catalogue",
  "draw.autoHint": "Chosen by the plugin for capability; it would pick {model}",
  "draw.autoHintReason": "Chosen by the plugin for capability; it would pick {model} ({reason})",
  "draw.models": "Image model",
  "draw.badge": "image",
  "draw.badge.textToImage": "text-to-image",
  "draw.badge.imageToImage": "image-to-image",
  "draw.imageOnlyTitle": "Image-to-image only: an input image must be passed via imageUrl; pure text-to-image is not supported.",
  "draw.auto": "Auto",
  "draw.noCandidates": "No image model in the catalogue right now, so this tool cannot work yet.",
  "draw.needsKey": "No token yet — configure it in the Access tab.",
  "draw.reset": "Reset",
  "draw.error": "Saving the draw settings failed: {error}",
  "draw.source.panel": "panel",
  "draw.source.config": "config",
  "draw.absent.noTools": "The switch is on, but this Host has no tools service, so the tool is not mounted (a Host limitation, not a config problem).",
  "draw.absent.peerLoad": "The switch is on, but the tools module failed to load; the draw tool is absent (a Host fault, not config).",
  "draw.absent.registry": "The switch is on, but the Host refused the tool registration; the draw tool is absent (a Host fault, not config).",
  "draw.absent.unknown": "The switch is on, but the draw tool is not mounted; the reason is unknown.",

  "trend.none": "No local call records yet.",
  "trend.legend": "Bar lengths are relative to the maximum in the range (local scope only).",
  "trend.metric": "Trend metric",
  "trend.metricCalls": "Calls",
  "trend.metricTokens": "Tokens",
  "trend.legendTokens": "Bar lengths are relative to the largest token count in the range (local scope only). Failed calls record no usage, and days with no data also read as 0.",
  "trend.window": "Days shown",
  "trend.windowDefault": "Default (follow config)",
  "trend.windowDays": "{days} days",
  "trend.windowHint": "Only sets how many days are drawn; how far back history is kept is a separate retention window.",

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

  // Composer usage pill (the `conversation.input.right` seat). The two readings
  // come from different places, so each one names its own source: the balance is
  // the official figure, the count is this plugin's own local day bucket.
  "composer.prefix": "ModelScope",
  "composer.pillTitle": "ModelScope quota: official Magicube balance + today's local call count",
  "composer.balanceUnit": "Magicubes",
  "composer.localCalls": "local today {calls}",
  "composer.stale": "stale data"
};

export type DictionaryKey = keyof typeof zh;
export type { Tt };
