/**
 * 出图的 **peer-dependent 半边**：真正发起请求、驱动异步两段式、注册成 agent 工具。
 *
 * 与 `llm-adapter.ts` 同一个处境——import Host 发行的 peer（`@deepseek-ai/dsh-tools`
 * 的 `defineTool` 由调用方惰性注入），**不能由离线单测套件导入**。纯逻辑全部住在
 * `draw.ts`（已由 `test/draw.test.mjs` 覆盖 39 组），本文件只做「接线 + I/O」：
 * 轮询循环、fetch、工具定义。
 *
 * **覆盖边界**（2026-10-16 复核）：`runDrawOnce` / `pickDrawModel` / `drawModelIds` /
 * `splitImageUrls` / `buildGenerationsEndpoint` / `buildTasksEndpoint` /
 * `DRAW_TOOL_NAME` 由 `test/draw-runtime.test.mjs` 钉住；**没被覆盖的是
 * `defineDrawTool` 落到 peer registry 的那一段**（真 `defineTool` 形状与注册结果）
 * ——只改那一段不会让任何门禁变红。本文件此前整段自称「无覆盖」，该陈述在补上
 * 这个套件之后已经过时。
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
  DRAW_WAIT_BUDGET_MS,
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
import { isImageGenModel, imageGenModelIds, textToImageModelIds, KNOWN_T2I_MODEL_ID } from "./llm-models.ts";
import { createDrawJobs, type DrawJob, type DrawJobs } from "./draw-jobs.ts";
import { str } from "./util.ts";

/** agent 工具名。带插件前缀，避免与 `dsh-draw-router` 的 `draw_image` 撞名。 */
export const DRAW_TOOL_NAME = "modelscope_draw_image";

// KNOWN_T2I_MODEL_ID 已移至 llm-models.ts，与 KNOWN_VISION_IDS 放在一起——所有
// 「哪些模型能做什么」的策展知识集中一处，不会漂。这里再导出保持 import 路径不变。
export { KNOWN_T2I_MODEL_ID };

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

/** 提交一次出图所需的全部入参（两段式里第一段的输入）。 */
export interface DrawSubmitInput {
  fetchImpl: DrawFetch;
  apiBase: string;
  /** 访问令牌（绝不出现在返回文本里）。 */
  apiKey: string;
  model: string;
  prompt: string;
  imageUrl?: string | string[];
  size?: string;
  steps?: number;
  guidance?: number;
  seed?: number;
  negativePrompt?: string;
}

/**
 * **第一段**：提交一次出图，只要 `task_id`。
 *
 * 提交必须带 `X-ModelScope-Async-Mode`（实测可省但官方示例都带，带上无害）。
 * 响应里的 `task_status` **一律忽略**——实测恒为 `SUCCEED`，连最终 `FAILED` 的那次
 * 也是，所以成功与否只看轮询终态（这条由 `readTaskId` 钉在纯逻辑层）。
 * @param {DrawSubmitInput} input - 提交参数。
 * @returns {Promise<{taskId: string}>} 上游任务 id（= 续查用的 jobId）。
 * @throws {Error} 提交失败——消息已过 `describeDrawFailure`。
 */
export async function submitDrawTask({
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
  negativePrompt
}: DrawSubmitInput): Promise<{ taskId: string }> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };

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
  return { taskId };
}

/**
 * 一次等待的三种结局。
 *
 * `pending` 是两段式的**正常中间态**，不是失败：它只表示「在这次调用愿意等的
 * 时间里没等到终态」。把它当失败会让 agent 失去续查的把手（也会误进冷却门）。
 * @typedef {{kind:"done", images: string[], polls: number}
 *          |{kind:"failed", message: string}
 *          |{kind:"pending", polls: number}} DrawAwait
 */
export type DrawAwait =
  | { kind: "done"; images: string[]; polls: number }
  | { kind: "failed"; message: string }
  | { kind: "pending"; polls: number };

/**
 * **第二段**：在给定预算内轮询一个任务，直到终态或预算耗尽。
 *
 * 与 `runDrawOnce` 的差别只有一处：预算耗尽时**返回 `pending` 而不是抛错**——
 * 抛错是「这件事做不成了」，`pending` 是「还没成，可以再查」。同一段循环因此
 * 同时服务于两种调用形状（一次性跑完 / 分段续查），不写两份。
 *
 * 轮询带 `X-ModelScope-Task-Type`（**必需**，漏了必假失败）；传输层抖动与非
 * JSON 响应体都**不升级为终局**，继续等下一轮。
 * @param {object} options - 等待参数。
 * @param {DrawFetch} options.fetchImpl - 注入的 fetch。
 * @param {string} options.apiBase - apiBase。
 * @param {string} options.apiKey - 访问令牌。
 * @param {string} options.taskId - 上游任务 id。
 * @param {number} [options.waitMs] - 本次调用的等待预算。
 * @param {number} [options.pollIntervalMs] - 轮询间隔（测试可缩短）。
 * @returns {Promise<DrawAwait>} 三种结局之一。
 */
export async function awaitDrawTask({
  fetchImpl,
  apiBase,
  apiKey,
  taskId,
  waitMs = DRAW_WAIT_BUDGET_MS,
  pollIntervalMs = DRAW_POLL_INTERVAL_MS,
  signal
}: {
  fetchImpl: DrawFetch;
  apiBase: string;
  apiKey: string;
  taskId: string;
  waitMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}): Promise<DrawAwait> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  const deadline = Date.now() + Math.max(1, Math.floor(waitMs));
  const interval = Math.max(1, Math.floor(pollIntervalMs));
  let polls = 0;
  let lastStatus: string | undefined;
  for (;;) {
    if (Date.now() >= deadline) return { kind: "pending", polls };
    try {
      await sleep(interval, signal);
    } catch {
      // abort 信号触发：立即返回 pending，让调用方决定下一步。
      return { kind: "pending", polls };
    }
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
      return {
        kind: "failed",
        message: describeDrawFailure({
          ...(polled.status !== undefined ? { status: polled.status } : {}),
          ...(pollText !== "" ? { bodyText: pollText } : {}),
          ...(lastStatus !== undefined ? { taskStatus: lastStatus } : {})
        })
      };
    }
    const data = await safeJson(polled, pollText);
    const status = readTaskStatus(data);
    if (status !== null) lastStatus = status;
    if (!isTerminalPayload(data)) continue;

    if (status === "FAILED") {
      return { kind: "failed", message: describeDrawFailure({ taskStatus: "FAILED", bodyText: pollText }) };
    }
    const images = readOutputImages(data);
    if (images.length === 0) {
      return {
        kind: "failed",
        message: describeDrawFailure({ taskStatus: "SUCCEED", bodyText: pollText, cause: "任务报 SUCCEED 但没有可用图片" })
      };
    }
    return { kind: "done", images, polls };
  }
}

/**
 * 一次性跑完一次出图：提交 + 轮询到终态（或耗尽 `pollDeadlineMs`）。
 *
 * 现在是 {@link submitDrawTask} 与 {@link awaitDrawTask} 的组合——循环只有一份，
 * 分段续查与一次性跑完共用它。行为与拆分前一致（含超时抛错与文案），
 * `test/draw-runtime.test.mjs` 的断言不因此改变。
 *
 * 一次性形状只适合「调用方能接受被阻塞」的场合；agent 工具那一条路径走
 * {@link defineDrawTool} 的两段式，不再用本函数。
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
  const { taskId } = await submitDrawTask({
    fetchImpl,
    apiBase,
    apiKey,
    model,
    prompt,
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(guidance !== undefined ? { guidance } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(negativePrompt !== undefined ? { negativePrompt } : {})
  });

  // ── 轮询 ──
  // 一次性形状没有「分段」这回事：整个预算一次交给等待循环，耗尽即失败。
  const awaited = await awaitDrawTask({
    fetchImpl,
    apiBase,
    apiKey,
    taskId,
    waitMs: pollDeadlineMs,
    pollIntervalMs
  });
  if (awaited.kind === "done") {
    return { model, images: awaited.images, taskId, polls: awaited.polls };
  }
  if (awaited.kind === "failed") throw new Error(awaited.message);

  // 预算耗尽 = 旧行为里的超时。文案一字不改：**超时不等于任务死亡**——上游任务
  // 会继续跑完（实测一次 900s 放弃时任务仍活着，同期另一任务 859s 成功）。
  // 另注意终态不幂等（任务记录会被回收，事后再查变成 FAILED），所以也不要
  // 暗示「稍后可以用 task_id 取回」——取回的可能是 FAILED 而不是图。
  throw new Error(
    describeDrawFailure({
      cause:
        `超过截止时间（${Math.round(pollDeadlineMs / 1000)}s，${awaited.polls} 次轮询）仍未拿到结果。` +
        `上游任务（${taskId}）**可能仍在生成**——实测排队时长在 1–15 分钟间大幅波动，` +
        `与请求本身无关。稍后可重试；注意超时后原任务的结果不保证还能取回`
    })
  );
}

/**
 * 从目录里挑一个出图模型。
 *
 * 优先级（高 → 低）：
 * 1. **工具显式请求**——即使不在目录里也放行（手工覆盖，上游会自己报错）；
 * 2. **首选模型**（面板保存的模型偏好，或配置 `drawModelId`）——用户点了谁就是
 *    谁，同样不校验在不在目录（用户可能先配好、等模型上线）。此前这个偏好只在
 *    `pickDrawModel` 返回 null 时才生效，目录非空时等于死配置——面板显示的
 *    preferredModel 与实际挑中的模型会说两套话；
 * 3. 目录里**平台声明**为 `text-to-image` 的条目（`textToImageModelIds`，将来目录
 *    补上真文生图模型时自动优先生效）；
 * 4. **已知能纯文生图**的模型（`KNOWN_T2I_MODEL_ID`）——今天目录的坑位，见该
 *    常量的注释：真实目录里它是第二个，照旧取「第一个」会挑中纯文生图必挂的
 *    `MusePublic/…`；
 * 5. 目录里第一个出图模型（`isImageGenModel` 的严格方向：只认明确声明，缺字段
 *    不算）。
 *
 * 目录为空且既无显式请求也无首选模型 → `null`，由调用方给出可操作的错误，
 * 而不是发一个注定失败的请求。
 * @param {unknown} entries - 归一目录条目。
 * @param {string} [requested] - 工具调用里显式给的 model。
 * @param {string} [preferred] - 首选模型 id（面板偏好或配置 `drawModelId`）。
 * @returns {string|null} 选中的 id。
 */
export function pickDrawModel(entries: unknown, requested?: string, preferred?: string): string | null {
  const want = str(requested, "");
  if (want !== "") return want;
  const preferredId = str(preferred, "");
  if (preferredId !== "") return preferredId;
  const ids = imageGenModelIds(entries);
  if (ids.length === 0) return null;
  const t2i = textToImageModelIds(entries);
  if (t2i.length > 0) return t2i[0] ?? null;
  if (ids.includes(KNOWN_T2I_MODEL_ID)) return KNOWN_T2I_MODEL_ID;
  return ids[0] ?? null;
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

/** 工具返回给 agent 的结果（两段式的两种结局）。 */
export interface DrawToolResult {
  source: "modelscope";
  /** `done` = 图已出；`pending` = 还在排队，带 `jobId` 再调用即可续查。 */
  status: "done" | "pending";
  /** 上游任务 id，也是续查的把手。 */
  jobId: string;
  model: string;
  /** 首图 URL；`pending` 时为空串。 */
  url: string;
  prompt: string;
  /** 一行人类可读说明（渲染器直接吃这个）。 */
  hint: string;
}

/**
 * 装配 agent 工具定义——**两段式**，一次调用不再阻塞整轮对话。
 *
 * ## 为什么是两段式
 *
 * 上游出图要排队，实测 61s–537s（免费池）。旧形状是「一次调用 await 到终态」，
 * 于是 `drawTimeoutMs`（15 分钟）既是「这张图值不值得等」的上限，也成了「一轮
 * 对话被卡多久」的上限——把上游排队的代价直接转嫁成对话停顿。
 *
 * 现在一次调用只做两件事之一：
 *   - **不带 `jobId`** → 提交任务，然后只在 `waitMs`（默认 {@link DRAW_WAIT_BUDGET_MS}）
 *     内等；等到就返回 `done`，没等到就返回 `pending` + `jobId`；
 *   - **带 `jobId`** → 只查那个任务，同样最多等 `waitMs`。
 *
 * `drawTimeoutMs` 因此回到它本来的语义：**从提交算起的总放弃线**（跨调用累计），
 * 越过它才报「放弃」。
 *
 * ## 两个刻意的判定
 *
 *   - `pending` **不是失败**：不抛错、不进冷却门。它只表示「这次调用愿意等的时间里
 *     没等到」，进冷却就会把续查这条路堵死——那正是分段查询的目的所在。
 *   - 只有**真失败**（提交失败 / 上游 `FAILED` / 越过总放弃线）才 `cooldown.fail()`。
 *
 * 工具仍只做「参数归一 → 跑一次 → 组装结果文本」，所有判定都委托给 `draw.ts` 的纯函数。
 * @param {object} options - 装配参数。
 * @param {(definition: object) => unknown} options.defineTool - peer 的工厂。
 * @param {DrawFetch} options.fetchImpl - 注入的 fetch。
 * @param {() => Promise<string>} options.resolveApiKey - 每次调用现读令牌。
 * @param {() => unknown|Promise<unknown>} [options.getEntries] - 目录条目读取器。
 * @param {object} [options.settings] - `{ apiBase, drawModelId, drawTimeoutMs, drawWaitMs }`。
 * @param {ReturnType<typeof createDrawCooldown>} [options.cooldown] - 冷却门。
 * @param {DrawJobs} [options.jobs] - 作业表（可注入，便于测试）。
 * @param {() => boolean} [options.isDisposed] - 卸载闸。
 * @returns {unknown} 已定义的 agent 工具。
 */
export function defineDrawTool({
  defineTool,
  fetchImpl,
  resolveApiKey,
  getEntries,
  settings,
  getPreferredModelId,
  cooldown = createDrawCooldown(DRAW_FAILURE_COOLDOWN_MS),
  jobs = createDrawJobs(),
  pollIntervalMs = DRAW_POLL_INTERVAL_MS,
  isDisposed = () => false
}: {
  defineTool: (definition: object) => unknown;
  fetchImpl: DrawFetch;
  resolveApiKey: () => Promise<string>;
  getEntries?: () => unknown | Promise<unknown>;
  settings?: { apiBase?: unknown; drawModelId?: unknown; drawTimeoutMs?: unknown; drawWaitMs?: unknown };
  /** 首选模型读取器（面板保存的偏好）；每次调用现读，读不到回退 `settings.drawModelId`。 */
  getPreferredModelId?: () => Promise<string | null>;
  cooldown?: ReturnType<typeof createDrawCooldown>;
  /** 作业表（默认现建一张）；注入是为了让两段式可在离线套件里测。 */
  jobs?: DrawJobs;
  /** 轮询间隔（默认 15s）；装配缝——离线测试要把它压到毫秒级。 */
  pollIntervalMs?: number;
  isDisposed?: () => boolean;
}) {
  /** 总放弃线：从提交算起，跨多次调用累计。 */
  const timeoutMs = Math.max(30_000, Math.floor(Number(settings?.drawTimeoutMs) > 0 ? Number(settings?.drawTimeoutMs) : DRAW_TIMEOUT_MS));
  /**
   * 单次调用愿意等的时间。
   *
   * 只夹**上界**（不该超过总放弃线，超过它的等待没有意义）；下界交给
   * `host-config` 的 `drawWaitMs` clamp——同一个数在两处各夹一次，上限/下限就会
   * 各说一套话（`drawTimeoutMs` 的 clamp 早已是本仓库的教训）。
   */
  const waitMs = Math.min(
    timeoutMs,
    Math.max(1, Math.floor(Number(settings?.drawWaitMs) > 0 ? Number(settings?.drawWaitMs) : DRAW_WAIT_BUDGET_MS))
  );
  const apiBase = str(settings?.apiBase, "https://api-inference.modelscope.cn/v1");

  // AbortController：插件 dispose 时立即中断轮询中的 sleep，而不是等它自然结束。
  // 默认 15s 的间隔意味着用户点「停止」后最多要等 15s 才真正停——abort 让停止
  // 信号立即生效。每次进入等待前检查一次；等待循环本身在 abort 时返回 pending。
  const abortController = new AbortController();
  const abortIfDisposed = () => {
    if (isDisposed()) abortController.abort();
  };

  /**
   * 等一个作业，把 {@link awaitDrawTask} 的三种结局翻译成工具结果或错误。
   *
   * 两段共用这一段——「刚提交的」与「续查的」在等待这件事上没有区别，唯一的区别
   * 是作业表里那条记录从哪来。
   * @param {string} apiKey - 访问令牌。
   * @param {DrawJob} job - 作业（含提交时刻与累计轮询数）。
   * @param {string[]} available - 目录里的出图模型（续查时为空，不必再拉目录）。
   * @returns {Promise<DrawToolResult>} 工具结果。
   * @throws {Error} 真失败（上游 FAILED / 轮询 HTTP 失败）或越过总放弃线。
   */
  const waitAndReport = async (apiKey: string, job: DrawJob, available: string[]): Promise<DrawToolResult> => {
    abortIfDisposed();
    const awaited = await awaitDrawTask({
      fetchImpl,
      apiBase,
      apiKey,
      taskId: job.taskId,
      waitMs,
      pollIntervalMs,
      signal: abortController.signal
    });
    if (awaited.kind === "failed") {
      // 终态失败：这张图不会再出，作业出表（留着只占容量）。
      jobs.drop(job.jobId);
      throw new Error(awaited.message);
    }
    jobs.notePolls(job.jobId, awaited.polls);
    const polls = job.polls + awaited.polls;

    if (awaited.kind === "done") {
      // 出图即出表：这条作业已经没有「继续查」的意义了，留着只占容量。
      jobs.drop(job.jobId);
      const urls = awaited.images.join("\n");
      return {
        source: "modelscope",
        status: "done",
        jobId: job.jobId,
        model: job.model,
        url: awaited.images[0] ?? "",
        prompt: job.prompt,
        hint:
          `图片已生成（上游异步任务，${polls} 次轮询，task ${job.taskId}）\n` +
          `模型: ${job.model}\n${urls}` +
          (available.length > 0 ? `\n可用出图模型: ${available.join(", ")}` : "")
      };
    }

    // pending：这次调用愿意等的时间里没等到终态。**不是失败**——不抛错、不进冷却。
    // 但要先看有没有越过总放弃线（从提交算起，跨调用累计）：越过就是「这张图放弃」。
    const elapsedMs = Date.now() - job.submittedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        describeDrawFailure({
          cause:
            `超过总预算（${Math.round(timeoutMs / 1000)}s，${polls} 次轮询）仍未拿到结果。` +
            `上游任务（${job.taskId}）**可能仍在生成**——实测排队时长在 1–15 分钟间大幅波动，` +
            `与请求本身无关；注意放弃后原任务的结果不保证还能取回`
        })
      );
    }
    return {
      source: "modelscope",
      status: "pending",
      jobId: job.jobId,
      model: job.model,
      url: "",
      prompt: job.prompt,
      hint:
        `仍在生成中（已等 ${Math.round(elapsedMs / 1000)}s，${polls} 次轮询，task ${job.taskId}）：` +
        `上游排队通常 1–15 分钟。稍后带 jobId ${job.jobId} 再调用本工具即可继续查询` +
        `（只查询、不会重复出图）`
    };
  };

  return defineTool({
    name: DRAW_TOOL_NAME,
    description:
      "Generate or edit an image with the ModelScope (魔搭) API-Inference token. " +
      "Text-to-image by default; pass `imageUrl` to edit an existing image (image-to-image), or an array of URLs for multi-image editing. " +
      "Omit `model` to use the catalogue's image model. " +
      "TWO-PHASE: upstream generation queues, so latency varies from ~1 minute to 15+ minutes. " +
      "Call without `jobId` to submit and wait briefly; if the result is `status: pending`, call again with the returned `jobId` to keep polling. " +
      "A pending result is NOT a failure — the image is still being generated. " +
      "Available image model ids are reported in the result.",
    parameters: {
      prompt: { type: "string", required: true, description: "Image prompt; describe the target image (for edits, describe the intended change). Ignored when resuming with `jobId`." },
      jobId: { type: "string", description: "Resume an earlier task: pass the `jobId` returned by a previous call to keep polling it (no new image is submitted)" },
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
          status: { type: "string" },
          jobId: { type: "string" },
          model: { type: "string" },
          url: { type: "string" },
          prompt: { type: "string" },
          hint: { type: "string" }
        }
      },
      // 两参数 + 数组返回：与 sensenova 同一形状（渲染器先吃调用参数、再吃结果）。
      render: (_args: unknown, result: { hint?: unknown } | null | undefined) => [{ type: "text", text: result?.hint || "图片已生成" }]
    },
    // 硬护栏：一次调用只允许占住 waitMs（+ 一点余量），不再是总放弃线。它兜的是
    // 「实现里出现了意外的等待」，正常情况下等待循环自己会在 waitMs 处返回。
    timeoutMs: waitMs + 10_000,
    async execute(params: Record<string, unknown> | undefined): Promise<DrawToolResult> {
      if (abortController.signal.aborted || isDisposed()) throw new Error("modelscope draw tool is no longer mounted");
      // 令牌两条路径都要（续查也要带 Authorization），所以提到分支之前。
      const apiKey = await resolveApiKey();
      if (typeof apiKey !== "string" || apiKey.trim() === "") {
        throw new Error("MODELSCOPE_API_KEY 未配置：在面板粘贴 ms- 访问令牌，或设置该环境变量");
      }

      // ── 第二段：带 jobId 只查，不新建任务 ──
      const resumeId = str(params?.jobId, "");
      if (resumeId !== "") {
        const job = jobs.get(resumeId);
        if (job === null) {
          // 作业表只在本进程内有效：不在表里 = 插件重启过，或这个 id 不是本插件发的。
          // 诚实到此为止——上游的终态记录会被回收，所以**不承诺**「换个方式还能取回」。
          throw new Error(
            `jobId ${resumeId} 不在本次会话的作业表里（插件重启过，或该 id 不是本插件发出的）：` +
              `原任务可能仍在生成，但它的结果不保证还能取回（上游终态记录会被回收），请重新出图`
          );
        }
        try {
          return await waitAndReport(apiKey, job, []);
        } catch (error) {
          cooldown.fail();
          throw error;
        }
      }

      // ── 第一段：提交一个新任务 ──
      const prompt = str(params?.prompt, "");
      if (prompt === "") throw new Error("prompt is required");
      const remaining = cooldown.remainingMs();
      if (remaining > 0) {
        throw new Error(`draw cooldown: 上一次出图失败，${Math.ceil(remaining / 1000)}s 后再试`);
      }

      let picked: unknown = [];
      try {
        picked = (await getEntries?.()) ?? [];
      } catch {
        picked = [];
      }
      const entries = Array.isArray(picked) ? picked : [];
      // 首选模型**每次调用现读**：面板里改过的偏好对下一次出图就生效（与
      // getEntries 同一个「调用时读」的纪律）。读失败退回配置 drawModelId，
      // 不因此打断出图。
      const configuredPreferred = str(settings?.drawModelId, "");
      const panelPreferred = typeof getPreferredModelId === "function" ? await getPreferredModelId().catch(() => null) : null;
      const preferred =
        typeof panelPreferred === "string" && panelPreferred.trim() !== "" ? panelPreferred : configuredPreferred;
      const model = pickDrawModel(entries, str(params?.model, ""), preferred);
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
        const { taskId } = await submitDrawTask({
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
          ...(negativePrompt !== "" ? { negativePrompt } : {})
        });
        const job = jobs.create({ taskId, model, prompt });
        return await waitAndReport(apiKey, job, drawModelIds(entries));
      } catch (error) {
        // 真失败才进冷却：出图慢且贵，立刻重试既易撞限流又白等。pending 不走到这里
        // ——它是「还没好」，把它算成失败会把续查这条路堵死。
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

/**
 * 可注入的 sleep（测试可覆写；这里只提供默认实现）。
 *
 * 支持 `AbortSignal`：插件 dispose 时可以立即中断等待，而不是等 sleep 自然结束。
 * 默认 15s 的轮询间隔意味着用户点「停止」后最多要等 15s 才真正停——abort 让
 * 停止信号立即生效。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("sleep aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("sleep aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
