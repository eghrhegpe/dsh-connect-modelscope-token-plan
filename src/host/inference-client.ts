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
import { normalizeEntry } from "./llm-models.ts";
import { pluginError, errMsg, redactSecrets, str } from "./util.ts";
import type { ResolvedSettings } from "./host-config.ts";
import type { HostDeps } from "./types.ts";

/**
 * 有界并发 map：对 items 逐个跑 fn（异步），同时最多 limit 个在飞。
 * 用于目录加载时并行拉取各模型详情端点，避免一次性打爆主站。
 */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      const item = items[i];
      if (item === undefined) continue;
      results[i] = await fn(item);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

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
 * 归一后的目录条目（M4 §2 的消费形状）。
 *
 * llm-models.ts 的 `CatalogEntry` 按 §3 声明为宽形状（`{id?: unknown; name?:
 * unknown; [k: string]: unknown}`），是「条目被整条透传」的形态；本插件要喂给
 * 面板/roster 的是这份**已判定的投影**，所以在这里单独声明窄形状。运行时字段
 * 确实都是这个形状（`normalizeEntry` 产出的 id/name 是字符串、vision 是布尔），
 * 差异只在类型标注，故以 `as unknown as` 断言一次。
 */
export interface CatalogEntry {
  id: string;
  name: string;
  vision: boolean;
  contextWindow: number;
  maxOutputLength: number;
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

  /**
   * 丢弃一个我们不读的响应体。
   *
   * undici 里未消费的 body 会**占住连接**直到 GC。目录刷新会对 35 个模型并发打
   * 详情端点（`Promise.all` 分批），其中任何一条走「!ok」或「形状不符」分支，
   * 连接就一直挂着——短时间内连接池被这些挂起的响应吃满，后面的请求开始排队。
   *
   * `cancel()` 是显式的弃权：告诉 undici「这个 body 我不要了」，它会立刻释放
   * 连接而不是等GC。用 `void` 前缀是因为这是best-effort——取消失败不影响我们
   * 已经决定返回 `[]` 的结论。
   */
  const discardBody = (response: Response): void => {
    try {
      void response.body?.cancel();
    } catch {
      // body 已 locked / 已读完 / 不支持 cancel：无可做，也不该因此改结论。
    }
  };

  /** 读响应 body 里的 OpenAI 错误文案（形状漂移时返回空串，不抛）。 */
  const readErrorMessage = async (response: Response): Promise<string> => {
    try {
      const body = (await response.json()) as { error?: { message?: unknown }; message?: unknown };
      const message = body?.error?.message ?? body?.message;
      return typeof message === "string" ? message : "";
    } catch {
      // 解析失败时 body 可能**没被消费**（json() 抛在半路），连接会一直挂着。
      // 错误路径同样要弃权，否则上游反复 4xx 时连接池会被挂满。
      discardBody(response);
      return "";
    }
  };

  /**
   * 单个模型的详情端点任务标签（modelscope.cn/api/v1/models/{id}）。
   * 免认证 GET，零推理额度（实测匿名 200）。返回 `Data.Tasks[].Name`（+
   * `widgets[].task` 兜底）去重后的标签数组；任意失败 / 非预期形状返回空数组，
   * 调用方据此回退策展清单 + 名字启发。
   */
  const fetchTaskTags = async (id: string): Promise<string[]> => {
    const detailUrl = settings.siteBase + "/api/v1/models/" + encodeURI(id);
    const response = await fetchWithTimeout(detailUrl, { method: "GET", headers: { accept: "application/json" } });
    // 下面两条「不读 body 就返回」的路径都必须先弃权，否则连接被挂住不放。
    if (!response.ok) {
      discardBody(response);
      return [];
    }
    const json = (await response.json().catch(() => null)) as { Code?: unknown; Data?: { Tasks?: unknown; widgets?: unknown } } | null;
    if (json === null || typeof json !== "object" || json.Code !== 200) return [];
    const data = (json.Data ?? {}) as { Tasks?: unknown; widgets?: unknown };
    const tasks: string[] = [];
    for (const t of Array.isArray(data.Tasks) ? (data.Tasks as Record<string, unknown>[]) : []) {
      const name = str(t?.Name, "");
      if (name !== "") tasks.push(name);
    }
    for (const w of Array.isArray(data.widgets) ? (data.widgets as Record<string, unknown>[]) : []) {
      const task = str(w?.task, "");
      if (task !== "") tasks.push(task);
    }
    return Array.from(new Set(tasks));
  };

  return {
    /**
     * 模型目录：GET apiBase/models，免认证、零额度，coalesced 缓存
     * cacheSeconds。返回归一后的目录条目（entries，M4 用来建 descriptor）与
     * 派生的 id 列表（ids，旧消费方继续可用）——两条路线读同一份条目，不会漂移；
     * 形状漂移抛 UPSTREAM_ERROR 并带 detail。
     */
    async fetchModels(): Promise<{ entries: CatalogEntry[]; ids: string[]; fetchedAt: string }> {
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
        const raws = json.data as unknown[];
        // 并行拉取每个模型的详情端点任务标签（modelscope.cn/api/v1/models/{id}），
        // 免认证、零推理额度；有界并发避免打爆主站。单模型失败不影响整体，tags 留空 →
        // 该模型回退策展清单 + 名字启发。标签随目录一起被 cacheSeconds 缓存。
        const ids = (raws as Record<string, unknown>[]).map((r) => str(r.id, "")).filter((id) => id !== "");
        const tagArrays = await mapWithConcurrency(ids, 6, (id) => fetchTaskTags(id).catch(() => [] as string[]));
        const tagsById = new Map<string, string[]>();
        ids.forEach((id, i) => tagsById.set(id, tagArrays[i] ?? []));
        // 判断集中一份：inference-client 只透传原始条目（附带详情标签），vision/窗口/
        // 输出上限全由 llm-models.normalizeEntry 判（§2），本文件不做第二次判断。
        const entries = raws
          .map((raw) => {
            const id = str((raw as Record<string, unknown>).id, "");
            const tags = tagsById.get(id) ?? [];
            return normalizeEntry({ ...(raw as Record<string, unknown>), tasks: tags.length > 0 ? tags : undefined });
          })
          .filter((entry) => entry.id !== "");
        const ids2 = entries.map((entry) => entry.id);
        return { entries, ids: ids2, fetchedAt: new Date().toISOString() };
      }, settings.cacheSeconds * 1000) as { entries: CatalogEntry[]; ids: string[]; fetchedAt: string };
      return body;
    },

    /**
     * 官方「魔粒」余额：GET siteBase/openapi/v1/magicubes/balance（Bearer
     * 令牌；2026-10-04 实测可用，匿名 401，SPIKE.md §魔粒）。coalesced 缓存
     * cacheSeconds，缓存键带令牌指纹——换令牌 ≤1 个 TTL 内必然读到新身份。
     */
    async fetchBalance(): Promise<{ available: number | null; total: number | null; frozen: number | null; fetchedAt: string }> {
      const { value: token } = await tokenStore.resolve();
      if (token === "") {
        throw pluginError(CODE.AUTH_ERROR, "no ModelScope token configured — set MODELSCOPE_API_KEY or save one in the panel");
      }
      const url = settings.siteBase + "/openapi/v1/magicubes/balance";
      const key = "balance#" + token.slice(-6);
      return await read(key, async () => {
        const response = await fetchWithTimeout(url, {
          method: "GET",
          headers: { authorization: "Bearer " + token, accept: "application/json" }
        });
        if (!response.ok) {
          const message = await readErrorMessage(response);
          const code = classifyStatus(response.status);
          throw pluginError(code, redactSecrets("magicube balance failed with HTTP " + String(response.status) + (message === "" ? "" : ": " + message)));
        }
        const json = (await response.json().catch(() => null)) as { success?: unknown; data?: unknown } | null;
        const data = json !== null && typeof json === "object" ? (json as { data?: unknown }).data : null;
        if (json === null || typeof json !== "object" || json.success !== true || data === null || typeof data !== "object") {
          throw pluginError(CODE.UPSTREAM_ERROR, "magicube balance shape drifted (expected {success:true, data:{total_balance,available_balance,frozen_amount}})");
        }
        const numOr = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
        const row = data as { total_balance?: unknown; available_balance?: unknown; frozen_amount?: unknown };
        return {
          available: numOr(row.available_balance),
          total: numOr(row.total_balance),
          frozen: numOr(row.frozen_amount),
          fetchedAt: new Date().toISOString()
        };
      }, settings.cacheSeconds * 1000) as { available: number | null; total: number | null; frozen: number | null; fetchedAt: string };
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
