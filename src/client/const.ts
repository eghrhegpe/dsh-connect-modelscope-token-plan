/** Ids and same-origin routes the client half talks to. */

/** Dictionary namespace this plugin owns. */
export const NS = "dsh-connect-modelscope-token-plan";

/**
 * The plugin slug：REGISTRATION.id、日志前缀、data-dsh-plugin 标记、以及下面
 * 每条路由都从它派生——slug 改名只有这一个家。这些字面量由 test/panel.test.mjs
 * §6/§6b 双向钉住与 Host 半边的 paths.ts 一致（config.test.mjs 钉的是
 * host-config ↔ cordis.patch.yml 的配置面，不是路由面）。
 */
export const PANEL_ID = NS;

/** Host 快照路由（相对、同源）。 */
export const SNAPSHOT_PATH = `/api/${NS}/snapshot`;
/**
 * Host 模型目录路由。**面板已不消费**（模型清单由快照的 provider 块承担，
 * 见 panel-page.ts modelsBody 注释）——Host 侧仍注册、test/routes.test.mjs 仍
 * 钉着，此处保留以兼容任何旧面。别误以为它是活的消费方。
 */
export const MODELS_PATH = `/api/${NS}/models`;
/** 令牌保存路由。 */
export const TOKEN_PATH = `/api/${NS}/token`;
/** 令牌忘掉路由。 */
export const TOKEN_FORGET_PATH = `/api/${NS}/token/forget`;
/** probe 路由（零额度鉴权探针，只传 modelId）。 */
export const PROBE_PATH = `/api/${NS}/probe`;
/** 接入为 DSH 模型 provider 的开关/状态路由。 */
export const PROVIDER_PATH = `/api/${NS}/provider`;
/** provider 允许清单（enabledIds）保存路由。 */
export const PROVIDER_ROSTER_PATH = `/api/${NS}/provider/roster`;
/** provider 开关 + 清单回到 patch 默认的路由。 */
export const PROVIDER_RESET_PATH = `/api/${NS}/provider/reset`;
/**
 * 「什么都不提供」的哨兵 id：与 host/llm-models.ts 的 `HIDE_ALL_MODELS`
 * 同一个字面量。空清单的语义是「不过滤（全部提供）」，所以「全部隐藏」
 * 只能走这个哨兵——两端拼错一处就是「点隐藏反而全放出来」。
 */
export const HIDE_ALL_MODELS = "__hide_all__";

/**
 * 魔搭访问令牌页：用户在这里生成/重置令牌。纯公开 URL——客户端只在新标签页
 * 打开它，绝不随凭据请求发出。
 */
export const MODELSCOPE_TOKEN_URL = "https://modelscope.cn/my/myaccesstoken";

/**
 * 官方「魔粒用量明细」网页（消费记录只在这，OpenAPI 没有记录端点——
 * 见 docs/REFERENCES.md 的 userscripts 上游）。纯公开 URL，仅外链。
 */
export const MODELSCOPE_USAGE_URL = "https://modelscope.cn/magicube/usage?tab=consume";

/**
 * 模型详情页：魔粒单价（每 1K token 多少魔粒）只在**网页**展示，不在官方
 * OpenAPI 里（抓网页/模型卡脆弱且会漂移，不进主数据源，见 docs/REFERENCES.md）。
 * 纯公开 URL，仅外链——面板每个模型行拼出它，让用户在网页快速查「这个模型
 * 烧多少魔粒」。id 即 `owner/model` 标准格式。逐段 `encodeURIComponent` 后
 * 再用 `/` 拼回：`encodeURI` 不转义 `#` 与 `?`，id 里带这些字符会破坏 URL
 * 语义（被当成 fragment 或 query）。
 */
export const MODELSCOPE_MODEL_URL_BASE = "https://www.modelscope.cn/models";
export function modelscopeModelUrl(id: string): string {
  return `${MODELSCOPE_MODEL_URL_BASE}/${id.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * 用户认可「好用」的三家（按 owner）。模型目录原先是 API 原始返回序，这三家被拆散
 * （deepseek 在顶、Qwen 在中间、glm/ZhipuAI 在底），既没排序也不突出。置顶分组 +
 * 高亮让好模型一眼可见。数组顺序即置顶内的展示序。
 */
export const FEATURED_OWNERS = Object.freeze(["deepseek-ai", "ZhipuAI", "Qwen"]);

/** 从 `owner/model` 取 owner（无斜杠时整段作 owner）。 */
export function catalogOwner(id: string): string {
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(0, slash) : id;
}
