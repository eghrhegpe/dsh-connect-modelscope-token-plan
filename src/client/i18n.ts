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

  "trend.none": "还没有本地调用记录。",
  "trend.legend": "柱长相对区间内最大值，仅本地口径。",

  "events.none": "暂无事件。",
  "events.quota": "额度",
  "events.rate_limit": "限频",
  "events.error": "错误",

  "token.status": "状态：{present}（来源 {source}）",
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

  "trend.none": "No local call records yet.",
  "trend.legend": "Bar lengths are relative to the maximum in the range (local scope only).",

  "events.none": "No events.",
  "events.quota": "Quota",
  "events.rate_limit": "Rate limit",
  "events.error": "Error",

  "token.status": "Status: {present} (source {source})",
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

export type DictionaryKey = keyof typeof zh;
export type { Tt };
