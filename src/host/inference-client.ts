/**
 * 魔搭 API-Inference 的 HTTP 出口：模型目录（零额度）与 probe 调用。
 *
 * 两条纪律来自 SPIKE.md：
 * - **上游不带额度头**——所以本模块只解析 status / body / Retry-After，
 *   不假装能从响应里读到余额；
 * - **models 免认证可读**——目录轮询走无凭据 GET，零额度成本，也因此
 *   令牌变化不需要失效目录缓存（一个省掉整类失效 bug 的简化）。
 *   （注释纪律：块注释里写以斜杠开头的路径必须用反引号包住，否则
 *   「两个星号加斜杠」会把注释提前关掉——本次 typecheck 亲手踩的。）
 *
 * 429 分诊按 body 文案（codes.ts classifyRateLimit）：quota → 快速失败，
 * rate_limit → 带 retryAfterMs 的退避。401/403 → AUTH_ERROR（换令牌能修，
 * 调用方绝不自动重试）。所有错误经 pluginError 带稳定 code，消息过
 * redactSecrets。
 *
 * @module dsh-connect-modelscope-token-plan/inference-client
 */
import { createCoalescedFetch } from "./coalesced-fetch.ts";
import { CODE, classifyRateLimit, classifyStatus, parseRetryAfterMs } from "./codes.ts";
import { pluginError, errMsg, redactSecrets } from "./util.ts";
import type { ResolvedSettings } from "./host-config.ts";
import type { HostDeps } from "./types.ts";

/** probe 的两种形态（SPIKE.md §结论 5）。 */
export type ProbeKind = "usage" | "validity";

/** probe 成功时的回报；失败以 pluginError 抛出，由 probe 路由记账。 */
export interface ProbeSuccess {
  ok: true;
  kind: ProbeKind;
  status: number;
  modelId: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  elapsedMs: number;
}

/**
 * 构造推理 client。
 * @param {object} options
 * @param {ResolvedSettings} options.settings - resolveSettings 的产物。
 * @param {object} options.tokenStore - ms-auth 的 store（resolve() 取令牌）。
 * @param {HostDeps} [options.deps] - 测试缝（fetchImpl）。
 * @param {{warn?: (message: string) => void}} [options.logger] - ctx.logger。
 */
export function createInferenceClient({ settings, tokenStore, deps = {}, logger }: {
  settings: ResolvedSettings;
  tokenStore: { resolve: () => Promise<{ value: string; source: string | null }> };
  deps?: HostDeps;
  logger?: { warn?: (message: string) => void };
}) {
  void logger;
  const doFetch = deps.fetchImpl ?? fetch;
  const { read } = createCoalescedFetch();

  /** 带超时的一次 fetch（AbortController；abort → TIMEOUT_ERROR）。 */
  const fetchWithTimeout = async (url: string, init: RequestInit) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.inferenceTimeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw pluginError(CODE.TIMEOUT_ERROR, "modelscope request timed out");
      }
      throw pluginError(CODE.NETWORK_ERROR, redactSecrets(errMsg(error)));
    } finally {
      clearTimeout(timer);
    }
  };

  /** 读响应 body 里的 OpenAI 错误文案（形状漂移时返回空串，不抛）。 */
  const readErrorMessage = async (response: Response): Promise<string> => {
    try {
      const body = (await response.json()) as { error?: { message?: unknown }; message?: unknown };
      const message = body?.error?.message ?? body?.message;
      return typeof message === "string" ? message : "";
    } catch {
      return "";
    }
  };

  return {
    /**
     * 模型目录：GET apiBase/models，免认证、零额度，coalesced 缓存
     * cacheSeconds。返回 id 列表；形状漂移抛 UPSTREAM_ERROR 并带 detail。
     */
    async fetchModels(): Promise<{ ids: string[]; fetchedAt: string }> {
      const url = settings.apiBase + "/models";
      const body = await read("models", async () => {
        const response = await fetchWithTimeout(url, { method: "GET" });
        if (!response.ok) {
          const message = await readErrorMessage(response);
          const code = classifyStatus(response.status);
          throw pluginError(code, redactSecrets("model catalog failed with HTTP " + String(response.status) + (message === "" ? "" : ": " + message)));
        }
        const json = (await response.json().catch(() => null)) as { object?: unknown; data?: unknown } | null;
        if (json === null || typeof json !== "object" || json.object !== "list" || !Array.isArray(json.data)) {
          throw pluginError(CODE.UPSTREAM_ERROR, "model catalog shape drifted (expected {object:'list', data:[...]})");
        }
        const ids = (json.data as unknown[])
          .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : null))
          .filter((id): id is string => typeof id === "string" && id !== "");
        return { ids, fetchedAt: new Date().toISOString() };
      }, settings.cacheSeconds * 1000) as { ids: string[]; fetchedAt: string };
      return body;
    },

    /**
     * 一次 probe 调用。
     *
     * - usage：真调用（1 个 max_tokens 的 ping），**消耗 1 次免费额度**，
     *   换回 usage 计数——面板「测试一次调用」与计数演示的来源；
     * - validity：故意缺 messages 的请求，预期 401（令牌坏）先于 400
     *   （请求坏）返回，**零额度**鉴权探针（语义待真机回填，SPIKE.md）。
     *
     * 失败抛 pluginError；调用方（probe 路由）负责把它记进事件流。
     */
    async probe({ modelId, kind }: { modelId: string; kind: ProbeKind }): Promise<ProbeSuccess> {
      if (typeof modelId !== "string" || modelId.trim() === "") {
        throw pluginError(CODE.CONFIG_ERROR, "probe: modelId is required");
      }
      const { value: token } = await tokenStore.resolve();
      if (token === "") {
        throw pluginError(CODE.AUTH_ERROR, "no ModelScope token configured — set MODELSCOPE_API_KEY or save one in the panel");
      }
      const startedAt = Date.now();
      const payload: Record<string, unknown> = { model: modelId, stream: false };
      if (kind === "usage") {
        payload.messages = [{ role: "user", content: "ping" }];
        payload.max_tokens = 1;
      }
      // validity 故意不带 messages：鉴权先于校验时返回 401，否则 400。
      const response = await fetchWithTimeout(settings.apiBase + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify(payload)
      });
      const elapsedMs = Date.now() - startedAt;
      // validity 的语义（2026-10-04 真机实测，SPIKE.md 已回填）：魔搭**不先
      // 校验 messages**——缺 messages 返回 200（created:0 的空壳补全）。所以
      // 401/403 = 令牌坏；200/400 = 令牌好（先鉴权后校验的顺序使 400 也只
      // 可能是校验层拒绝）；429 = 限频中（令牌存疑，照常退避）。
      if (kind === "validity") {
        if (response.status === 401 || response.status === 403) {
          const message = await readErrorMessage(response);
          throw pluginError(CODE.AUTH_ERROR, redactSecrets(message === "" ? "token rejected (HTTP 401/403)" : message));
        }
        if (response.status === 429) {
          const message = await readErrorMessage(response);
          const retryAfterMs = parseRetryAfterMs(response.headers, message);
          throw pluginError(CODE.RATE_LIMITED, redactSecrets(message === "" ? "modelscope returned 429 (validity probe)" : message), retryAfterMs === null ? {} : { retryAfterMs });
        }
        if (response.status >= 500) {
          throw pluginError(CODE.UPSTREAM_ERROR, "modelscope returned HTTP " + String(response.status) + " (validity probe)");
        }
        return { ok: true, kind, status: response.status, modelId, usage: null, elapsedMs };
      }
      if (!response.ok) {
        const message = await readErrorMessage(response);
        if (response.status === 429) {
          const retryAfterMs = parseRetryAfterMs(response.headers, message);
          const triage = classifyRateLimit(message);
          // exactOptionalPropertyTypes：absent 与 undefined 是两回事，条件取对象。
          const extra = retryAfterMs !== null && retryAfterMs !== undefined ? { retryAfterMs } : {};
          throw pluginError(
            triage === "quota" ? CODE.QUOTA_EXCEEDED : CODE.RATE_LIMITED,
            redactSecrets(message === "" ? "modelscope returned 429 (probe on " + modelId + ")" : message),
            extra
          );
        }
        throw pluginError(classifyStatus(response.status), redactSecrets(message === "" ? "modelscope returned HTTP " + String(response.status) : message));
      }
      const json = (await response.json().catch(() => null)) as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } } | null;
      const usage = json === null ? null : json.usage;
      const positive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
      return {
        ok: true,
        kind,
        status: response.status,
        modelId,
        usage: usage === undefined || usage === null ? null : {
          promptTokens: positive(usage.prompt_tokens) ?? 0,
          completionTokens: positive(usage.completion_tokens) ?? 0,
          totalTokens: positive(usage.total_tokens) ?? 0
        },
        elapsedMs
      };
    }
  };
}
