/**
 * 魔搭 provider 注册的 peer-dependent 半边。
 *
 * 这里的一切都跑在 Host 发行的 peer 上（`pi-ai`、`dsh-llm`、`dsh-llm-pi-ai`）——这
 * 正是 descriptor 映射要住在 peer-free 的 `llm-models.ts` 的原因。本模块的装配链
 * 由 `test/llm-adapter.test.mjs` 用**记录式假 peer**（`test/helpers/peer-stub-loader.mjs`，
 * Node module customization hooks 拦截四个 peer 入口）钉住——断言的是「我们对 peer
 * 的调用形状」：descriptor 契约、retryPolicy 传参、PiAiAdapter 构造、usage 观察层
 * 包装与重分类顺序。**诚实边界**：假 peer 是我们写的，钉不住 peer 真身的漂移——peer
 * 升级改形状仍由 docs/ROADMAP.md Backlog 的 e2e / 真机冒烟去抓，本套件只保证
 * 这一侧不再静默改坏。
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
import { buildDescriptors, LLM_PROVIDER_ID, LLM_DISPLAY_NAME, LLM_API_KEY_NAME } from "./llm-models.ts";
import { assemblePiAiAdapter } from "./llm-adapter-core.ts";
import { withUsageObserver, type UsageSinks } from "./usage-observer.ts";

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
export function createModelScopeAdapter({ entries, enabledIds = [], baseUrl, resolveApiKey, get, unavailableModelIds = [], usage }: {
  entries: unknown;
  enabledIds?: string[];
  baseUrl: string;
  resolveApiKey: () => Promise<string>;
  get?: (service: string) => unknown;
  unavailableModelIds?: string[];
  usage?: UsageSinks;
}) {
  const models = buildDescriptors(entries, { providerId: LLM_PROVIDER_ID, baseUrl, enabledIds, unavailableModelIds });

  const built = assemblePiAiAdapter({
    providerId: LLM_PROVIDER_ID,
    displayName: LLM_DISPLAY_NAME,
    apiKeyName: LLM_API_KEY_NAME,
    models,
    // 存着的令牌引用是本路由呈现的唯一凭据；每次请求现读，所以轮换令牌不需要
    // 重新注册。
    resolveCredential: resolveApiKey,
    ...(get !== undefined ? { get } : {})
    // §4：不传 `reasoning`，profile 不钉 effort，picker 也不给思考强度选择器。
  });
  // 观察层套在装配结果**之外**：重分类层在内（改写 429 的 code），观察层在外
  // （读改写后的 code 记事件），顺序不能反——反了事件流会把限频记成额度耗尽。
  return {
    adapter: usage === undefined ? built.adapter : withUsageObserver(built.adapter, usage),
    providerIds: built.providerIds
  };
}