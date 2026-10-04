/** Ids and same-origin routes the client half talks to. */

/** Dictionary namespace this plugin owns. */
export const NS = "dsh-connect-modelscope-token-plan";

/**
 * The plugin slug：REGISTRATION.id、日志前缀、data-dsh-plugin 标记、以及下面
 * 每条路由都从它派生——slug 改名只有这一个家。test/config.test.mjs 钉住
 * 这些字面量与 Host 半边的 paths.ts 一致。
 */
export const PANEL_ID = NS;

/** Host 快照路由（相对、同源）。 */
export const SNAPSHOT_PATH = `/api/${NS}/snapshot`;
/** Host 模型目录路由。 */
export const MODELS_PATH = `/api/${NS}/models`;
/** 令牌保存路由。 */
export const TOKEN_PATH = `/api/${NS}/token`;
/** 令牌忘掉路由。 */
export const TOKEN_FORGET_PATH = `/api/${NS}/token/forget`;
/** probe 路由（usage / validity 两种形态）。 */
export const PROBE_PATH = `/api/${NS}/probe`;

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
