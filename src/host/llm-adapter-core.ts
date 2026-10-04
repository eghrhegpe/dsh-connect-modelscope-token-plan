/**
 * `PiAiAdapter` 装配的共享半边——魔搭 provider 的 inert pi-ai auth 平面、
 * profile 行与流重分类 Proxy 都从这里来。
 *
 * 姊妹插件的两个适配器（Token Plan provider 的 `llm-adapter.ts`、小浣熊的
 * `raccoon-llm-adapter.ts`）最初是抄写的两份：同样的 inert auth 平面、同样的
 * profile 行、同样的 `PiAiAdapter` 装配、同样的流重分类 Proxy。那是**对运行时
 * peer 的装配**，不是领域逻辑——两份之间的差异买不到任何东西，代价却是要修两
 * 次（429 误分类层是修正，每一处修正都必须到达两条路由，否则其中一条会静默停
 * 止退避）。魔搭复用同一份，理由完全一样：装配与上游是谁无关。
 *
 * 留在各适配器里的：descriptor 构建（每个上游映自己的 roster/catalog）与各路由
 * 读取的凭据解析器。
 *
 * peer-dependent：import `pi-ai` / `dsh-llm` / `dsh-llm-pi-ai`，它们随 Host
 * 发行。与适配器本身一样，不能由离线单测套件导入，由 wiring/e2e 检查来测。
 *
 * @module dsh-connect-modelscope-token-plan/llm-adapter-core
 */
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy, resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm";
import { name } from "./host-config.ts";
import { buildRetryPolicyConfig } from "./llm-retry.ts";
import { reclassifyStream } from "./llm-error-fix.ts";

/** 一次流读取在途时的空闲上限（dsh-llm-pi-ai 默认）。 */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

/** `dsh-llm-pi-ai` 默认的像素预算（魔搭 provider 直接沿用）。 */
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4_194_304;

/** `fs` 服务面：图片 hook 读的单个 host-path 映射器。 */
type FsService = { processPathFromHostPath?: (hostPath: string) => unknown };

/**
 * `dsh-llm-pi-ai` 默认的图片预算，像素预算可覆盖。
 * @param {number} [requestImagePixelBudget] - 像素预算覆盖值。
 * @returns {{maxRequestImageBytes: number, requestImagePixelBudget: number,
 *   requestImageMaxBytes: number}} profile 的图片预算行。
 */
export function imageBudgets(requestImagePixelBudget = DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET) {
  return {
    maxRequestImageBytes: 20_971_520,
    requestImagePixelBudget,
    requestImageMaxBytes: 1_048_576
  };
}

/**
 * inert pi-ai auth 平面。
 *
 * 认证走各路由提供的凭据解析器（存着的 `MODELSCOPE_API_KEY` 引用），每次请求现
 * 读。pi-ai 自己的凭据生命周期绝不能为这条路制造凭据，所以所有环境性问题都答
 * 「没存、没设」。
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    // 刻意 no-op 而非 throw：pi-ai 可能在一次正常请求里把 `modify` 当作可选的
    // 「持久化最新凭据」hook 调一次，那里抛异常会把一条本来正常的对话 500。
    // 这些路由的凭据生命周期住在插件自己的 store（`ms-auth.ts`）里，不在这里。
    async modify() {},
    async delete() {}
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false;
    }
  }
};

/**
 * 给适配器包一层，让两个流出口都把被误判的 429 重分类。
 *
 * peer 的 `classifyPiAiError` 会把「budget/credits」措辞的 429 读成 QUOTA（不重
 * 试）；这一层在流离开前把这样的 body 改回 RATE_LIMIT，`llm-retry.ts` 的退避才
 * 真的会触发。只拦流出口，不碰 peer 内部，也不改普通数据块。见 `llm-error-fix.ts`。
 * @param {object} inner - 要包的 `PiAiAdapter`。
 * @returns {object} 包好的适配器。
 */
function withReclassifiedStream(inner: object): object {
  return new Proxy(inner, {
    get(target: object, prop: string | symbol, receiver: object) {
      const value = Reflect.get(target, prop, receiver);
      // `stream(...)` 与 `prepareCall(...).stream` 都返回 async iterable，都在这
      // 里包；其余（image、resolveApiKey 等）原样透传。
      if (prop === "stream") {
        const stream = (target as { stream: (options: unknown) => AsyncIterableIterator<unknown> }).stream;
        return (options: unknown) => reclassifyStream(stream(options));
      }
      if (typeof value === "function" && prop === "prepareCall") {
        const prepare = (target as { prepareCall: (...args: unknown[]) => unknown }).prepareCall;
        return (...args: unknown[]) => {
          const prepared = prepare.apply(target, args);
          // prepared 可能是 call handle 的 promise，也可能是 handle 本身；两者都
          // 带 `.stream`。索引签名把读法从 unknown 上脱下来，而不钉死 peer 的确切
          // 类型。
          const handle = prepared as { stream?: (o: unknown) => AsyncIterableIterator<unknown>; then?: (fn: (p: unknown) => unknown) => unknown } | null;
          if (handle !== null && typeof handle.then === "function") {
            return handle.then((p: unknown) => {
              const inner = p as { stream?: (o: unknown) => AsyncIterableIterator<unknown> } | null;
              return inner !== null && typeof inner.stream === "function"
                ? { ...inner, stream: (o: unknown) => reclassifyStream(inner.stream!(o)) }
                : p;
            });
          }
          return handle !== null && typeof handle.stream === "function"
            ? { ...handle, stream: (o: unknown) => reclassifyStream(handle.stream!(o)) }
            : prepared;
        };
      }
      return value;
    }
  });
}

/**
 * 一条上游给共享装配贡献的部分——两条路由**不同的**那部分，以及它们共享的
 * 那部分之外的一切。
 */
export interface PiAiAdapterParts {
  /** 本适配器拥有的 id。 */
  providerId: string;
  /** picker 行的展示名。 */
  displayName: string;
  /** pi-ai 展示的凭据名。 */
  apiKeyName: string;
  /** 构建好的待提供 descriptor。 */
  models: object[];
  /** 每次请求现读的活凭据。 */
  resolveCredential: () => Promise<string>;
  /** 图片 hook 的服务解析器（`attachments`、`fs`）。 */
  get?: (service: string) => unknown;
  /** profile 钉住的思考档位。 */
  reasoning?: string;
  /** 像素预算覆盖（`imageBudgets`）。 */
  requestImagePixelBudget?: number;
}

/**
 * 装配一个 provider 的适配器：pi-ai provider、它的单条 profile 行、承载它们的
 * `PiAiAdapter`。
 *
 * 每次重建都换新实例是刻意的：`PiAiAdapter` 内部 memoize profiles 快照，所以目录
 * 或凭据变化时调用方**替换**注册的适配器并 emit `llm/adapters-updated`。
 * @param {PiAiAdapterParts} options - 每条上游的事实。
 * @returns {{adapter: object, providerIds: string[]}} 适配器与它拥有的 ids。
 */
export function assemblePiAiAdapter({
  providerId,
  displayName,
  apiKeyName,
  models,
  resolveCredential,
  get,
  reasoning,
  requestImagePixelBudget
}: PiAiAdapterParts) {
  const provider = {
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: apiKeyName,
          /**
           * pi-ai 会把它解析到的凭据递过来；这些路由自己不存，所以参数只为了给
           * 「从它上面读什么」一个名字。
           * @param {{credential?: {key?: string}}} [options]
           */
          async resolve({ credential }: { credential?: { key?: string } } = {}) {
            const key = credential?.key;
            return key === undefined || key.length === 0
              ? undefined
              : { auth: { apiKey: key }, source: displayName };
          }
        }
      },
      models,
      api: openAICompletionsApi()
    }),
    // 适配器的解析器会重读 provider 来发现它的模型；这里返回本次构建注册时的
    // 不可变 descriptor 集合。
    getModels: () => models
  };

  const profiles = new Map([
    [
      providerId,
      {
        provider: providerId,
        displayName,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        // 配额感知的重试策略：显式（不是 `undefined`），免得将来 peer 改默认
        // 会静默改变本 provider。排除配额类 code（耗尽的池重试也回不到健康；见
        // `llm-retry.ts`），保留 `RATE_LIMIT` 配一个温和的共享池退避。
        retryPolicy: resolveRetryPolicy(buildRetryPolicyConfig(), `${name}.${providerId}.retryPolicy`),
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...imageBudgets(requestImagePixelBudget),
        piProvider: provider
      }
    ]
  ]);

  const inner = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // 存着的凭据引用是本路由呈现的唯一凭据；每次请求现读，所以轮换凭据不需要
    // 重新注册。
    resolveApiKey: async () => resolveCredential(),
    // 图片输入是 pi-ai 的硬要求，不是可选加分项：`streamWithSnapshot` 只要消息
    // 里带图而 `resolveAttachments()` 给出 undefined 就会抛 UNSUPPORTED_CONTENT。
    // 两个 hook 都按官方 `llm-pi-ai` 插件的接法接。
    resolveAttachments: () => get?.("attachments"),
    // 通过 `get("fs")` 惰性解析，因为该服务可能在本适配器构建之后才注册。
    resolveImageAccess: (attachments: unknown, ref: unknown) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath: string) => (get?.("fs") as FsService | undefined)?.processPathFromHostPath?.(hostPath),
        ref
      )
  });

  return { adapter: withReclassifiedStream(inner), providerIds: [providerId] };
}