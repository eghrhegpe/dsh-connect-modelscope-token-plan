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
/** provider 全局上下文窗口覆盖保存路由（null = 跟随目录）。 */
export const PROVIDER_CONTEXT_PATH = `/api/${NS}/provider/context`;
/** provider 开关 + 清单回到 patch 默认的路由。 */
export const PROVIDER_RESET_PATH = `/api/${NS}/provider/reset`;
/**
 * 出图工具的开关/状态路由。
 *
 * **与 PROVIDER_PATH 是两条独立路由**：那个管「魔搭作为 chat provider」，这个管
 * 「给 agent 一个出图工具」。实测依据见 docs/SPIKE-image-gen.md。
 */
export const DRAW_PATH = `/api/${NS}/draw`;
/** 出图开关与模型偏好回到 patch 默认的路由。 */
export const DRAW_RESET_PATH = `/api/${NS}/draw/reset`;
/** 趋势图显示窗口（画多少天）的保存/读取路由。 */
export const TREND_WINDOW_PATH = `/api/${NS}/trend/window`;
/**
 * 「什么都不提供」的哨兵 id。字面量住在 `shared/wire.ts`（`enabledIds` 线编码的
 * 一部分，Host 的 `llm-models.ts` 同源再导出），这里再导出——Client 侧 import
 * 路径与旧版一致。空清单的语义是「不过滤（全部提供）」，所以「全部隐藏」
 * 只能走这个哨兵——两端拼错一处就是「点隐藏反而全放出来」。
 */
export { HIDE_ALL_MODELS } from "../shared/wire.ts";

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

/**
 * 徽章用的窗口短标注（tokens → "128K" / "1M"）——按**这个数被写出来时用的那个
 * 进制**渲染，不把它换算到另一把尺上。
 *
 * 为什么不「一律除以 1024」：上游自己混用两种写法。档位表与模型的出厂规格是 2 的
 * 幂（131072、262144、1048576），而目录声明与 models.dev / 策展表报的是十进制
 * （128000、200000、256000、1000000——见 `context-catalog.ts` 里逐条抄下来的那些
 * 数）。一律除 1024 会把后一类印成 125K / 195K / 250K / 977K：与上游自己写的名字
 * 全都对不上。LongCat-Flash-Lite 上游就叫 256K，面板印 250K 是另一种撒谎；
 * GLM-5.2 的 1M 印成 977K，读起来像「比档位里的 1M 小一截」——而档位里那个 1M 是
 * 1048576，跟 1000000 差 4.6%，本来就是同一个市场叫法。
 *
 * 判据（与姊妹插件 Agnes 的 `tokenSize` 同一条规则，她那份头注记着同一个坑）：
 *   1. ≥ 1M 走 M——十进制的 1,000,000 与二进制的 1,048,576 都读 "1M"；
 *   2. 能整除 1000 的按十进制（128000 → "128K"、200000 → "200K"）；
 *   3. 能整除 1024 的按二进制（131072 → "128K"、262144 → "256K"）；
 *   4. 两者都不整除的零散声明按十进制取整（123456 → "123K"）；取整进位到四位数
 *      就交给 M 档（999,999 读 "1M"，不读 "1000K"）。
 *
 * 代价说在明处：第 2、3 条会**撞车**——128000（两个进制都整除，走十进制）与
 * 131072 都印 "128K"。这是有意的：窗口徽章回答的是「大概能放多少上下文」，而
 * 128K / 256K / 1M 是上游与市场共用的叫法，跟它一致比区分那 2.4% 更有用。
 *
 * `tokens` 由调用方保证是正的有限数（`providerOf` 已挡），所以这里不再兜一次底。
 * @param {number} tokens - 窗口大小（tokens）。
 * @returns {string} 短标注。
 */
export function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) return millionLabel(tokens);
  if (tokens >= 1024) {
    const k = tokens % 1000 === 0
      ? tokens / 1000
      : tokens % 1024 === 0
        ? tokens / 1024
        : Math.round(tokens / 1000);
    // 四位数 K（只可能出现在 999,500…999,999 那一小段）说明该进位了——与 Agnes
    // 头注里「十亿级不许印成四位 M」是同一条纪律：宁可进位，不印没人那么写的数。
    return k >= 1000 ? millionLabel(tokens) : `${k}K`;
  }
  return String(tokens);
}

/** M 档读数：≥10 只留整数，否则至多一位小数（`1048576` → "1M"、`2500000` → "2.5M"）。 */
function millionLabel(tokens: number): string {
  const m = tokens / 1_000_000;
  return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : Math.round(m * 10) / 10}M`;
}
