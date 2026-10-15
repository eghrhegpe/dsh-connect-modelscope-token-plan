/**
 * 出图的 **peer-dependent 半边**：真正发起请求、驱动异步两段式、注册成 agent 工具。
 *
 * 与 `llm-adapter.ts` 同一个处境——import Host 发行的 peer（`@deepseek-ai/dsh-tools`
 * 的 `defineTool` 由调用方惰性注入），**不能由离线单测套件导入**。纯逻辑全部住在
 * `draw.ts`（已由 `test/draw.test.mjs` 覆盖 39 组），本文件只做「接线 + I/O」：
 * 轮询循环、fetch、工具定义。改错本文件**不会让任何门禁变红**。
 *
 * 与姊妹插件的关键差异（形状不兼容，不能照抄）：
 * `sensenova` 的出图是**同步单发**——一次 `fetch` 拿 `data[0].url` 就结束。魔搭是
 * **异步两段式**：提交拿 `task_id`，再轮询到终态取 `output_images[0]`。所以这里多
 * 一个 `pollTask` 循环，且它必须带 `X-ModelScope-Task-Type`（漏了 = 假失败）。
 *
 * 三条承重纪律：
 * 1. 提交响应的 `task_status` **一律忽略**（实测恒为 SUCCEED，连最终 FAILED 的那次
 *    也是），成功与否只看轮询终态。`readTaskId` 已把这条钉在纯逻辑层。
 * 2. 轮询间隔 15s（`DRAW_POLL_INTERVAL_MS`），**不是**社区常见的 5s——实测更密的
 *    轮询只与更慢相关。
 * 3. 失败原因实测可能**不可知**（`errors.code:0` + 空 message）。`describeDrawFailure`
 *    因此明说「未给出原因」，本文件也**不从空错误里编造**。
 *
 * @module dsh-connect-modelscope-token-plan/draw-runtime
 */
import {
  DRAW_POLL_DEADLINE_MS,
  DRAW_POLL_INTERVAL_MS,
  DRAW_TIMEOUT_MS,
  TASK_TYPE_HEADER,
  TASK_TYPE_IMAGE_GENERATION,
  buildDrawBody,
  createDrawCooldown,
  describeDrawFailure,
  isTerminalStatus,
  normalizeImageUrlInput,
  readOutputImages,
  readTaskId,
  readTaskStatus
} from "./draw.ts";
import { isImageGenModel, imageGenModelIds } from "./llm-models.ts";
import { str } from "./util.ts";

/** agent 工具名。带插件前缀，避免与 `dsh-draw-router` 的 `draw_image` 撞名。 */
export const DRAW_TOOL_NAME = "modelscope_draw_image";

/** 一次失败的冷却窗：出图慢，失败后立刻重试既易撞限流又白等。 */
const DRAW_FAILURE_COOLDOWN_MS = 60_000;

/** fetch 的最小形状（只声明本模块用到的字段，不绑死运行时类型）。 */
export interface DrawFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
export type DrawFetch = (url: string, options: object) => Promise<DrawFetchResponse>;

/**
 * 把 OpenAI 兼容 base 拼成出图端点。
 *
 * `…/v1` → `…/v1/images/generations`；已带该后缀则原样；更深路径回卷到 `/v1`。
 * 与 sensenova 的同名函数同源（那是受控复制：endpoint 拼接与上游是谁无关）。
 * @param {string} apiBase - 配置里的 apiBase。
 * @returns {string} 完整端点。
 */
export function buildGenerationsEndpoint(apiBase: string): string {
  const trimmed = str(apiBase, "").replace(/\/+$/, "");
  if (/\/images\/generations$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/images/generations`;
  if (/\/v1\//.test(trimmed)) return trimmed.replace(/\/v1\/.*$/, "/v1/images/generations");
  return `${trimmed}/v1/images/generations`;
}

/**
 * 拼轮询端点。task_id 上游是 UUID（实测失败态出现过短 id），一律走 path。
 * @param {string} apiBase - 配置里的 apiBase。
 * @param {string} taskId - 任务 id。
 * @returns {string} 完整端点。
 */
export function buildTasksEndpoint(apiBase: string, taskId: string): string {
  const base = buildGenerationsEndpoint(apiBase).replace(/\/images\/generations$/, "");
  return `${base}/tasks/${encodeURIComponent(taskId)}`;
}

/**
 * 一个响应体到底是不是「终态」——读不到就当还没好，继续等。
 *
 * 与 `isTerminalStatus` 的分工：那个管状态语义，这个管「响应本身能不能读」。
 * 上游偶发返回非 JSON（CDN 错误页）时，当作暂时性抖动继续等，而不是判失败——
 * 实测过一个 task 在正常轮询下始终 SUCCEED，没有理由把一次解析失败升级成终局。
 * @param {unknown} data - 已解析的 JSON。
 * @returns {boolean} 是否终态。
 */
export function isTerminalPayload(data: unknown): boolean {
  return isTerminalStatus(readTaskStatus(data));
}

/** 一次出图调用的结果。 */
export interface DrawOutcome {
  /** 选中的模型 id。 */
  model: string;
  /** 产出图片 URL，按上游顺序。 */
  images: string[];
  /** 上游任务 id。 */
  taskId: string;
  /** 我方统计的轮询次数（诊断用：区分「上游慢」与「间隔设太密」）。 */
  polls: number;
}

/**
 * 真正跑一次出图：提交 + 轮询到终态。
 *
 * 两段都必须带各自必需的头：提交带 `X-ModelScope-Async-Mode`（实测可省但官方示例
 * 都带，带上无害），轮询带 `X-ModelScope-Task-Type`（**必需**，漏了必假失败）。
 * @param {object} options - 调用参数。
 * @param {DrawFetch} options.fetchImpl - 注入的 fetch。
 * @param {string} options.apiBase - apiBase。
 * @param {string} options.apiKey - 访问令牌（绝不出现在返回文本里）。
 * @param {string} options.model - 模型 id。
 * @param {string} options.prompt - 提示词。
 * @param {string|string[]} [options.imageUrl] - 输入图（图生图 / 多图编辑）。
 * @param {string} [options.size] - `"宽x高"`。
 * @param {number} [options.steps] - 采样步数。
 * @param {number} [options.guidance] - 引导系数。
 * @param {number} [options.seed] - 种子。
 * @param {string} [options.negativePrompt] - 负向提示词。
 * @param {number} [options.pollDeadlineMs] - 轮询截止。
 * @param {number} [options.pollIntervalMs] - 轮询间隔（测试可缩短）。
 * @returns {Promise<DrawOutcome>} 出图结果。
 * @throws {Error} 提交失败、任务 FAILED、或超时——消息已过 `describeDrawFailure`。
 */
export async function runDrawOnce({
  fetchImpl,
  apiBase,
  apiKey,
  model,
  prompt,
  imageUrl,
  size,
  steps,
  guidance,
  seed,
  negativePrompt,
  pollDeadlineMs = DRAW_POLL_DEADLINE_MS,
  pollIntervalMs = DRAW_POLL_INTERVAL_MS
}: {
  fetchImpl: DrawFetch;
  apiBase: string;
  apiKey: string;
  model: string;
  prompt: string;
  imageUrl?: string | string[];
  size?: string;
  steps?: number;
  guidance?: number;
  seed?: number;
  negativePrompt?: string;
  pollDeadlineMs?: number;
  pollIntervalMs?: number;
}): Promise<DrawOutcome> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };

  // ── 提交 ──
  // 逐个条件展开而不是直接传可选值：本仓库开了 `exactOptionalPropertyTypes`，
  // 显式传 `undefined` 不等于「省略该属性」。
  const body = buildDrawBody({
    model,
    prompt,
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(guidance !== undefined ? { guidance } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(negativePrompt !== undefined ? { negativePrompt } : {})
  });
  let submitted: DrawFetchResponse;
  try {
    submitted = await fetchImpl(buildGenerationsEndpoint(apiBase), {
      method: "POST",
      headers: { ...headers, "X-ModelScope-Async-Mode": "true" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(describeDrawFailure({ cause: `提交请求失败：${error instanceof Error ? error.message : String(error)}` }));
  }
  const submitText = await safeText(submitted);
  if (!submitted.ok) {
    throw new Error(describeDrawFailure({ status: submitted.status, bodyText: submitText }));
  }
  const taskId = readTaskId(await safeJson(submitted, submitText));
  if (taskId === null) {
    // 提交没给 id：**不用** task_status 兜底（实测它恒为 SUCCEED，不可信）。
    throw new Error(describeDrawFailure({ bodyText: submitText, cause: "提交响应里没有 task_id" }));
  }

  // ── 轮询 ──
  const deadline = Date.now() + Math.max(1_000, Math.floor(pollDeadlineMs));
  const interval = Math.max(1, Math.floor(pollIntervalMs));
  let polls = 0;
  let lastStatus: string | undefined;
  for (;;) {
    if (Date.now() >= deadline) {
      // 超时**不等于任务死亡**：上游任务会继续跑完（实测一次 900s 放弃时任务仍活着，
      // 同期另一任务 859s 成功）。文案必须说清这一点，否则用户会以为出图失败了。
      // 另注意终态不幂等（任务记录会被回收，事后再查变成 FAILED），所以也不要
      // 暗示「稍后可以用 task_id 取回」——取回的可能是 FAILED 而不是图。
      throw new Error(
        describeDrawFailure({
          cause:
            `超过截止时间（${Math.round(pollDeadlineMs / 1000)}s，${polls} 次轮询）仍未拿到结果。` +
            `上游任务（${taskId}）**可能仍在生成**——实测排队时长在 1–15 分钟间大幅波动，` +
            `与请求本身无关。稍后可重试；注意超时后原任务的结果不保证还能取回`
        })
      );
    }
    await sleep(interval);
    polls++;
    let polled: DrawFetchResponse;
    try {
      polled = await fetchImpl(buildTasksEndpoint(apiBase, taskId), {
        method: "GET",
        // 缺这个头 = 上游一律回 task not found + FAILED（假失败）。承重。
        headers: { ...headers, [TASK_TYPE_HEADER]: TASK_TYPE_IMAGE_GENERATION }
      });
    } catch {
      continue; // 传输层抖动：不升级为终局，等下一轮
    }
    const pollText = await safeText(polled);
    if (!polled.ok) {
      throw new Error(
        describeDrawFailure({
          ...(polled.status !== undefined ? { status: polled.status } : {}),
          ...(pollText !== "" ? { bodyText: pollText } : {}),
          ...(lastStatus !== undefined ? { taskStatus: lastStatus } : {})
        })
      );
    }
    const data = await safeJson(polled, pollText);
    const status = readTaskStatus(data);
    if (status !== null) lastStatus = status;
    if (!isTerminalPayload(data)) continue;

    if (status === "FAILED") {
      throw new Error(describeDrawFailure({ taskStatus: "FAILED", bodyText: pollText }));
    }
    const images = readOutputImages(data);
    if (images.length === 0) {
      throw new Error(describeDrawFailure({ taskStatus: "SUCCEED", bodyText: pollText, cause: "任务报 SUCCEED 但没有可用图片" }));
    }
    return { model, images, taskId, polls };
  }
}

/**
 * 从目录里挑一个出图模型。
 *
 * 显式请求优先（即使不在目录里——那是手工覆盖，上游会自己报错）；否则取目录里
 * **平台声明**为出图模型的第一个（`isImageGenModel` 的严格方向：只认明确声明，
 * 缺字段不算）。目录为空且没显式请求 → `null`，由调用方给出可操作的错误，
 * 而不是发一个注定失败的请求。
 * @param {unknown} entries - 归一目录条目。
 * @param {string} [requested] - 工具调用里显式给的 model。
 * @returns {string|null} 选中的 id。
 */
export function pickDrawModel(entries: unknown, requested?: string): string | null {
  const want = str(requested, "");
  if (want !== "") return want;
  const ids = imageGenModelIds(entries);
  return ids.length > 0 ? (ids[0] ?? null) : null;
}

/**
 * 目录里可用于出图的模型 id（工具结果里回显，方便 agent 与用户看到实际候选）。
 * @param {unknown} entries - 归一目录条目。
 * @returns {string[]} id 列表。
 */
export function drawModelIds(entries: unknown): string[] {
  return imageGenModelIds(entries);
}

/** 与纯逻辑层同一份判定，导出给工具装配复用，防止两处口径漂移。 */
export { isImageGenModel };

/**
 * 装配 agent 工具定义。
 *
 * 工具只做「参数归一 → 跑一次 → 组装结果文本」，所有判定都委托给 `draw.ts` 的纯函数。
 * @param {object} options - 装配参数。
 * @param {(definition: object) => unknown} options.defineTool - peer 的工厂。
 * @param {DrawFetch} options.fetchImpl - 注入的 fetch。
 * @param {() => Promise<string>} options.resolveApiKey - 每次调用现读令牌。
 * @param {() => unknown|Promise<unknown>} [options.getEntries] - 目录条目读取器。
 * @param {object} [options.settings] - `{ apiBase, drawModelId, drawTimeoutMs }`。
 * @param {ReturnType<typeof createDrawCooldown>} [options.cooldown] - 冷却门。
 * @param {() => boolean} [options.isDisposed] - 卸载闸。
 * @returns {unknown} 已定义的 agent 工具。
 */
export function defineDrawTool({
  defineTool,
  fetchImpl,
  resolveApiKey,
  getEntries,
  settings,
  cooldown = createDrawCooldown(DRAW_FAILURE_COOLDOWN_MS),
  isDisposed = () => false
}: {
  defineTool: (definition: object) => unknown;
  fetchImpl: DrawFetch;
  resolveApiKey: () => Promise<string>;
  getEntries?: () => unknown | Promise<unknown>;
  settings?: { apiBase?: unknown; drawModelId?: unknown; drawTimeoutMs?: unknown };
  cooldown?: ReturnType<typeof createDrawCooldown>;
  isDisposed?: () => boolean;
}) {
  const timeoutMs = Math.max(30_000, Math.floor(Number(settings?.drawTimeoutMs) > 0 ? Number(settings?.drawTimeoutMs) : DRAW_TIMEOUT_MS));
  const apiBase = str(settings?.apiBase, "https://api-inference.modelscope.cn/v1");
  const preferred = str(settings?.drawModelId, "");

  return defineTool({
    name: DRAW_TOOL_NAME,
    description:
      "Generate or edit an image with the ModelScope (魔搭) API-Inference token. " +
      "Text-to-image by default; pass `imageUrl` to edit an existing image (image-to-image), or an array of URLs for multi-image editing. " +
      "Omit `model` to use the catalogue's image model. " +
      "This call is ASYNCHRONOUS upstream and typically takes 1-3 minutes; it polls until the task reaches a terminal state. " +
      "Available image model ids are reported in the result.",
    parameters: {
      prompt: { type: "string", required: true, description: "Image prompt; describe the target image (for edits, describe the intended change)" },
      model: { type: "string", description: "ModelScope image model id; defaults to the catalogue's image model" },
      imageUrl: {
        type: "string",
        description: "Input image URL for editing (public http(s) or data:image/...;base64). For multi-image editing pass several URLs separated by newlines — order is significant."
      },
      size: { type: "string", description: "Image size as WIDTHxHEIGHT, e.g. 1024x1024 (64-aligned)" },
      steps: { type: "number", description: "Sampling steps (platform range 1-100)" },
      guidance: { type: "number", description: "Prompt guidance scale (platform range 1.5-20)" },
      seed: { type: "number", description: "Random seed" },
      negativePrompt: { type: "string", description: "Negative prompt" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string" },
          model: { type: "string" },
          url: { type: "string" },
          prompt: { type: "string" },
          hint: { type: "string" }
        }
      },
      // 两参数 + 数组返回：与 sensenova 同一形状（渲染器先吃调用参数、再吃结果）。
      render: (_args: unknown, result: { hint?: unknown } | null | undefined) => [{ type: "text", text: result?.hint || "图片已生成" }]
    },
    timeoutMs: timeoutMs + 10_000,
    async execute(params: Record<string, unknown> | undefined) {
      if (isDisposed()) throw new Error("modelscope draw tool is no longer mounted");
      const prompt = str(params?.prompt, "");
      if (prompt === "") throw new Error("prompt is required");
      const remaining = cooldown.remainingMs();
      if (remaining > 0) {
        throw new Error(`draw cooldown: 上一次出图失败，${Math.ceil(remaining / 1000)}s 后再试`);
      }
      const apiKey = await resolveApiKey();
      if (typeof apiKey !== "string" || apiKey.trim() === "") {
        throw new Error("MODELSCOPE_API_KEY 未配置：在面板粘贴 ms- 访问令牌，或设置该环境变量");
      }

      let picked: unknown = [];
      try {
        picked = (await getEntries?.()) ?? [];
      } catch {
        picked = [];
      }
      const entries = Array.isArray(picked) ? picked : [];
      const model = pickDrawModel(entries, str(params?.model, "")) ?? (preferred !== "" ? preferred : null);
      if (model === null) {
        throw new Error(
          "目录里没有出图模型（image-to-image / text-to-image 条目为空）：确认令牌已配置、面板已至少轮询一次，且套餐含该模型"
        );
      }

      // 输入图：归一后逐项过闸。上游取不到的形态（本地路径）在这里就拒掉——转发
      // 过去只会换回一个原因不可知的 FAILED，不如当场说清。
      const rawImages = splitImageUrls(params?.imageUrl);
      const images: string[] = [];
      for (const raw of rawImages) {
        const normalized = normalizeImageUrlInput(raw);
        if (normalized === null) {
          throw new Error(
            `imageUrl 不可用：${raw.slice(0, 80)} —— 只接受公网 http(s) 链接或 data:image/...;base64 内联数据（本地文件上游取不到，请先上传）`
          );
        }
        images.push(normalized);
      }

      try {
        const size = str(params?.size, "");
        const steps = toPositiveInt(params?.steps);
        const guidance = toPositiveNumber(params?.guidance);
        const seed = toNonNegativeInt(params?.seed);
        const negativePrompt = str(params?.negativePrompt, "");
        const outcome = await runDrawOnce({
          fetchImpl,
          apiBase,
          apiKey,
          model,
          prompt,
          ...(images.length > 0 ? { imageUrl: images } : {}),
          ...(size !== "" ? { size } : {}),
          ...(steps !== undefined ? { steps } : {}),
          ...(guidance !== undefined ? { guidance } : {}),
          ...(seed !== undefined ? { seed } : {}),
          ...(negativePrompt !== "" ? { negativePrompt } : {}),
          pollDeadlineMs: timeoutMs
        });
        const available = drawModelIds(entries);
        const urls = outcome.images.join("\n");
        return {
          source: "modelscope",
          model: outcome.model,
          url: outcome.images[0] ?? "",
          prompt,
          hint:
            `图片已生成（上游异步任务，${outcome.polls} 次轮询，task ${outcome.taskId}）\n` +
            `模型: ${outcome.model}\n${urls}` +
            (available.length > 0 ? `\n可用出图模型: ${available.join(", ")}` : "")
        };
      } catch (error) {
        // 失败进冷却：出图慢且贵，立刻重试既易撞限流又白等。
        cooldown.fail();
        throw error;
      }
    }
  });
}

/**
 * 把工具参数里的输入图拆成列表。
 *
 * 官方支持多图（数组形状），而 agent 工具的参数类型是标量，所以约定**用换行分隔**
 * 多张。同时容忍调用方直接传数组（内部调用与测试会这么用）。
 * @param {unknown} value - 原始参数。
 * @returns {string[]} 拆好的 URL（未归一，调用方逐项过闸）。
 */
export function splitImageUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.trim() !== "");
  const raw = str(value, "");
  if (raw === "") return [];
  return raw.split(/\r?\n/).map((v) => v.trim()).filter((v) => v !== "");
}

/** 读正整数，非法返回 undefined（不下发无意义参数）。 */
function toPositiveInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** 读非负整数（seed 可为 0）。 */
function toNonNegativeInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** 读正浮点（guidance 可为小数）。 */
function toPositiveNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 读 body 文本，读不到给空串（错误分诊不能因为读 body 失败而失败）。 */
async function safeText(response: DrawFetchResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** 解析 JSON；读不到就返回 `null`，由调用方按「非终态/无 id」处理。 */
async function safeJson(response: DrawFetchResponse, text: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // 有些 fetch 实现读不了第二次 body，用已读到的文本兜。
    try {
      return text === "" ? null : JSON.parse(text);
    } catch {
      return null;
    }
  }
}

/** 可注入的 sleep（测试可覆写；这里只提供默认实现）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
