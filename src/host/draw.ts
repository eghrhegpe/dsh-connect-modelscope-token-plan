/**
 * 魔搭出图（`/v1/images/generations`）的**纯逻辑半边**——协议形状的解析与判定。
 *
 * 为什么是这个形状：魔搭的生图是**异步两段式**（提交得 `task_id`，轮询才出图），
 * 与姊妹插件 `dsh-connect-sensenova-token-plan/src/host/draw.ts` 的**同步单发**
 * （`drawOnce` 一次 fetch 即 `parseDrawResponse` 取 `data[0].url`）形状不兼容，
 * **不能照抄**。可复用的只有外壳（endpoint 拼接、冷却门、失败文案），核心必须新写。
 * 协议依据全部来自 `docs/SPIKE-image-gen.md` 的真机实测，非文档转述。
 *
 * 本模块**只做纯函数**：endpoint 构造、请求体构造、响应解析、状态判定、失败分诊。
 * 它**不发起任何请求、不碰凭据、不注册工具**——那半边（fetch 注入、Host 工具注册）
 * 与 `llm-adapter.ts` 一样 peer-dependent，测试覆盖同样是零（docs/ROADMAP.md Backlog）。
 * 刻意 peer-free：纯函数部分能进离线 `npm test` 门禁，`test/draw.test.mjs` 钉住形状。
 *
 * 三条承重结论（全部实测，推翻了几条广泛流传的错误写法）：
 *
 * 1. **轮询必须带 `X-ModelScope-Task-Type: image_generation`**，否则上游一律返回
 *    `task not found` + `task_status: FAILED`——**那是假失败**，任务实际正常。
 *    缺这个头的实现会在第一次轮询就误判失败并放弃一张已经能出的图。
 * 2. **提交响应的 `task_status` 不可信**：实测每次提交都回 `SUCCEED`，包括最终确实
 *    `FAILED` 的那次。所以提交只认 `task_id`，**成功与否只看轮询终态**。
 * 3. **`FAILED` 没有可分诊的形状**：`errors.code` 实测为 `0`、`errors.message` 为
 *    空串，没有顶层 `message`。任何「从错误里读出原因」的承诺都是编造——本模块的
 *    `describeDrawFailure` 因此**明确承认原因不可知**，只报可确定的形态差异。
 *
 * 关于两个小工具（`str` / `redactSecrets`）：它们曾以**本地私有副本**的形式活在
 * 本文件里，理由是「避免为 3 行代码引 util 的依赖面」。那条理由不成立——util.ts
 * 自己只有 type-only import（peer-free），同包的 `draw-runtime.ts` 早就 import 它；
 * 而私有副本已经漂移：脱敏正则少了 `sk-` 与密码键值对两组、`ms-` 的 charset 与
 * util 版不一致（`[A-Za-z0-9-]` vs `[0-9a-f-]`）——脱敏闸漏一条就是凭据外泄
 * （红线 1）。现在一律用 util 的单一副本。
 *
 * @module dsh-connect-modelscope-token-plan/draw
 */
import { redactSecrets, str } from "./util.ts";

/**
 * 出图请求的截止时间（墙钟毫秒）。
 *
 * **15 分钟**：实测同一模型的耗时在 61s–537s 之间大幅波动（免费池排队），
 * 且**超时放弃不等于任务死亡**——上游任务会继续跑完（记录之后还会被回收，
 * 见 docs/SPIKE-image-gen.md §坑 5）。宁可多等，不要扔掉一张已在生成的图。
 */
export const DRAW_TIMEOUT_MS = 900_000;

/**
 * 两次轮询之间的间隔（毫秒）。
 *
 * 取 15s 的**真正理由**是「够用且不浪费」：实测最慢一次 537s，15s 间隔意味着
 * 最多几十次查询，代价可忽略；而更密（社区示例的 5s）没有观测收益。
 *
 * ⚠️ 早先曾写「更密的轮询拖慢任务」，**该归因已推翻**——后续对照显示同一模型、
 * 同样 15s 轮询的耗时是 61s → 261s → 537s 单调恶化，是**上游排队时长在波动**。
 * 那次构成「证据」的 5s vs 30s 对照，控制变量没做，不足以支撑因果。
 * 详见 docs/SPIKE-image-gen.md §坑 4（含撤回记录）。
 */
export const DRAW_POLL_INTERVAL_MS = 15_000;

/** 轮询的总截止时间；与 `DRAW_TIMEOUT_MS` 同量级但独立可调（诊断时可放宽）。 */
export const DRAW_POLL_DEADLINE_MS = DRAW_TIMEOUT_MS;

/**
 * 轮询必须携带的头名与取值。
 *
 * 漏掉它 → 上游返回 `task not found` + `FAILED`，而任务其实在正常跑。这是本协议
 * 最贵的单点知识，也是第一份外部资料缺失的那一块。
 */
export const TASK_TYPE_HEADER = "X-ModelScope-Task-Type";
export const TASK_TYPE_IMAGE_GENERATION = "image_generation";

/**
 * 一次出图请求由几个 HTTP 请求组成：一次提交 + N 次轮询。
 * 只作为文档性常量，供工具描述与测试引用。
 */
export const DRAW_PHASE = Object.freeze({
  submit: "submit",
  poll: "poll"
});

/**
 * 轮询响应里 `task_status` 的四个已知取值。
 *
 * 前两个是进行中，后两个是终态。**终态只有这两个**——`buildEndpoint` 之外的任何
 * 未知值都必须被当作「继续等」，否则一个上游新增的状态值会被误读成失败。
 * @typedef {"PENDING"|"RUNNING"|"SUCCEED"|"FAILED"} DrawTaskStatus
 */
export type DrawTaskStatus = "PENDING" | "RUNNING" | "SUCCEED" | "FAILED";

/** 进行中的状态集合：命中即继续轮询。 */
const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(["PENDING", "RUNNING"]);

/**
 * 读一个响应的 `task_status`，取不到返回 `null`。
 *
 * 刻意**不猜**：字段缺失或类型不对都返回 `null`，由 `isTerminalStatus` 把它当作
 * 「非终态」继续等——这样一次形状漂移最多变成多轮轮询，不会变成误报失败。
 * @param {unknown} data - 已解析的 JSON。
 * @returns {DrawTaskStatus|null} 规范化状态，取不到为 `null`。
 */
export function readTaskStatus(data: unknown): DrawTaskStatus | null {
  if (data === null || typeof data !== "object") return null;
  const raw = (data as { task_status?: unknown }).task_status;
  if (typeof raw !== "string") return null;
  const upper = raw.trim().toUpperCase();
  if (upper === "PENDING" || upper === "RUNNING" || upper === "SUCCEED" || upper === "FAILED") {
    return upper;
  }
  return null;
}

/**
 * 一个状态是不是终态。
 *
 * **只有** `SUCCEED` / `FAILED` 是终态；`null`（读不到）与一切未知值都**不是**。
 * 「未知值继续等」是刻意的：把上游新增的状态误判成失败会丢掉一张已经能出的图，
 * 而误判成进行中最多多等几轮（受 `DRAW_POLL_DEADLINE_MS` 兜底）。
 * @param {DrawTaskStatus|null} status - 规范化状态。
 * @returns {boolean} 是否终态。
 */
export function isTerminalStatus(status: DrawTaskStatus | null): boolean {
  return status === "SUCCEED" || status === "FAILED";
}

/**
 * 一个状态是不是「还在跑」。
 * @param {DrawTaskStatus|null} status - 规范化状态。
 * @returns {boolean} 是否进行中。
 */
export function isInFlightStatus(status: DrawTaskStatus | null): boolean {
  return status !== null && IN_FLIGHT_STATUSES.has(status);
}

/**
 * 从提交响应里取 `task_id`。
 *
 * 提交响应里那个 `task_status: "SUCCEED"` **一律忽略**（见模块头第 2 条：它与终态
 * 无关）。本函数只认 `task_id`，所以一个「提交即失败」的上游只要给了 id 就仍会被
 * 轮询，而不给 id 会被当作提交失败——这两种都符合实测。
 * @param {unknown} data - 已解析的提交响应。
 * @returns {string|null} 任务 id，取不到为 `null`。
 */
export function readTaskId(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const raw = (data as { task_id?: unknown }).task_id;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * 从终态响应里取出成品图的 URL 列表。
 *
 * 实测形状是顶层 `output_images: string[]`。**刻意不读** `data[0].url`（OpenAI
 * 同步形状）与 `output.image_url`（外部资料误传的形状）——两者在魔搭上都不存在。
 * @param {unknown} data - 已解析的轮询响应。
 * @returns {string[]} 可用的图片 URL（保持上游顺序，已去空）。
 */
export function readOutputImages(data: unknown): string[] {
  if (data === null || typeof data !== "object") return [];
  const raw = (data as { output_images?: unknown }).output_images;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
  }
  return out;
}

/**
 * 一次成功的出图结果。
 */
export interface DrawResult {
  /** 任务 id（便于把面板提示与上游任务对上）。 */
  taskId: string;
  /** 产出图片的 URL，按上游顺序；至少一条。 */
  images: string[];
}

/**
 * 判定一个轮询响应是否产出可用图片。
 *
 * 要求**状态是 `SUCCEED` 且 `output_images` 非空**——两者都要。实测里 `SUCCEED` 时
 * 图片数组必然有值，但反过来不成立：一个空 `SUCCEED`（上游还在写 OSS、或形状漂移）
 * 应当被当作「没有结果」而不是成功，否则工具会向 agent 报一张不存在的图。
 * @param {unknown} data - 已解析的轮询响应。
 * @returns {boolean} 是否拿到了可用图片。
 */
export function hasUsableImages(data: unknown): boolean {
  return readTaskStatus(data) === "SUCCEED" && readOutputImages(data).length > 0;
}

/**
 * 解析一次成功的轮询响应。
 * @param {unknown} data - 已解析的轮询响应。
 * @param {string} taskId - 已知任务 id。
 * @returns {DrawResult} 结果。
 * @throws {Error} 状态非 `SUCCEED` 或没有可用图片时。
 */
export function parseDrawResult(data: unknown, taskId: string): DrawResult {
  if (readTaskStatus(data) !== "SUCCEED") {
    throw new Error(`draw: task ${taskId} 未成功（status=${readTaskStatus(data) ?? "unknown"}）`);
  }
  const images = readOutputImages(data);
  if (images.length === 0) {
    throw new Error(`draw: task ${taskId} 报 SUCCEED 但没有可用图片（output_images 为空）`);
  }
  return { taskId, images };
}

/**
 * 构造出图请求体。
 *
 * 只发上游**确认消费**的字段：`model` / `prompt` / `image_url` / `size` / `steps` /
 * `guidance` / `seed` / `negative_prompt` 均被实测接受（SPIKE 实测 #9）；`loras`
 * 也被确认消费（无效 LoRA id 在提交阶段直接 500，实测 #18）。**不发** `ref_image`
 * ——那是别家平台的写法，魔搭上不存在（SPIKE §对照）。
 *
 * `image_url` **一律发数组**，哪怕只有一张：官方示例的形状是数组（多图编辑要用），
 * 实测单张以数组发也通（#17）、以裸字符串发亦通（#8）。取数组是因为它的超集更贴近
 * 上游本意，也省掉一个分支。
 *
 * `n` 刻意**不作为请求字段**：实测目录里的出图模型都是单出模型，`n` 的支持度未
 * 逐项验证，传一个上游不认的参数比不传更危险。调用方要几张就发几次。
 * @param {object} options - 请求参数。
 * @param {string} options.model - 模型 id。
 * @param {string} options.prompt - 提示词。
 * @param {string|string[]} [options.imageUrl] - 输入图 URL，**字符串或数组均可**，
 *   内部一律归一为数组（官方形状；多图编辑要用数组）。
 * @param {string} [options.size] - `"宽x高"`，如 `"1024x1024"`（64 对齐）。
 * @param {number} [options.steps] - 采样步数。
 * @param {number} [options.guidance] - 引导系数。
 * @param {number} [options.seed] - 随机种子。
 * @param {string} [options.negativePrompt] - 负向提示词。
 * @param {string|Record<string, number>} [options.loras] - LoRA 配置：单个 repo id，
 *   或 `{id: weight}` 映射（官方：最多 6 个，权重和须为 1.0）。
 * @returns {object} 请求体。
 */
export function buildDrawBody(options: {
  model: string;
  prompt: string;
  imageUrl?: string | string[];
  size?: string;
  steps?: number;
  guidance?: number;
  seed?: number;
  negativePrompt?: string;
  loras?: string | Record<string, number>;
}) {
  const model = str(options.model, "");
  const prompt = str(options.prompt, "");
  const body: Record<string, unknown> = { model, prompt };
  const imageUrl = normalizeImageUrlList(options.imageUrl);
  if (imageUrl.length > 0) body.image_url = imageUrl;
  const size = str(options.size, "");
  if (size !== "") body.size = size;
  if (Number.isFinite(options.steps)) body.steps = options.steps;
  if (Number.isFinite(options.guidance)) body.guidance = options.guidance;
  if (Number.isFinite(options.seed)) body.seed = options.seed;
  const negativePrompt = str(options.negativePrompt, "");
  if (negativePrompt !== "") body.negative_prompt = negativePrompt;
  const loras = options.loras;
  if (typeof loras === "string" && loras.trim() !== "") {
    body.loras = loras.trim();
  } else if (loras !== null && typeof loras === "object") {
    const entries = Object.entries(loras).filter(([id, weight]) => id.trim() !== "" && Number.isFinite(weight));
    if (entries.length > 0) body.loras = Object.fromEntries(entries);
  }
  return body;
}

/**
 * 把「一张或多张输入图」归一成 URL 数组。
 *
 * 单张给字符串上游也吃（实测 #8），但官方示例与多图编辑都用数组（#17 实测通），
 * 故一律归一为数组。逐项过滤空串，**保持调用方给定的顺序**——多图编辑里顺序即语义
 * （官方示例：「图一中的狗，去追图二中的飞盘」）。
 * @param {unknown} value - 单个 URL、URL 数组，或缺省。
 * @returns {string[]} 归一后的 URL 数组（可为空）。
 */
export function normalizeImageUrlList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
  }
  return out;
}

/**
 * 从任意配置里读出「可用作输入图」的 URL。
 *
 * 承接 agent 工具的 `image_url` 参数。**只接受 http(s) 与 data URL**——其它形态
 * （本地路径）上游取不到，转发过去只会换回一个原因不可知的 `FAILED`。实测尚未
 * 验证 data URL 是否被上游接受（SPIKE 待办），但**转发它不会更糟**，而拦掉它会让
 * 本地图片彻底不可用；故放行并在档案里留待验证。
 * @param {unknown} value - 原始参数。
 * @returns {string|null} 规范化后的 URL，不可用时为 `null`。
 */
export function normalizeImageUrlInput(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(raw)) return raw;
  return null;
}

/**
 * 把一次失败转成 agent 与面板都能读的一句话。
 *
 * **关于魔搭 `FAILED` 的诚实边界**：实测唯一的失败样本是
 * `{"errors":{"code":0,"message":""}, "task_status":"FAILED"}`——**原因不可知**。
 * 所以这里只报「可确定的形态事实」（HTTP 码 / 轮询未出终态 / 明确的原因文本），
 * **不从空错误里编造原因**，并在原因确实拿不到时明说「上游未给出原因」。这是本仓库
 * README「诚实声明」的要求。
 *
 * 凭据永不入消息：body 文本可能回显 `ms-` 令牌，过 `redactSecrets` 后再截断。
 * @param {object} failure - 失败信息。
 * @param {number} [failure.status] - HTTP 状态码（提交/轮询的传输层失败）。
 * @param {string} [failure.bodyText] - 上游 body 原文。
 * @param {string} [failure.taskStatus] - 轮询读到的状态。
 * @param {string} [failure.cause] - 已知原因（超时 / 没有可用图片 / 拿不到 task_id 等）。
 * @returns {string} 一行说明。
 */
export function describeDrawFailure(failure: {
  status?: number;
  bodyText?: string;
  taskStatus?: string;
  cause?: string;
}): string {
  const text = redactSecrets(typeof failure.bodyText === "string" ? failure.bodyText : "").slice(0, 300);
  const status = Number.isFinite(failure.status) ? Number(failure.status) : 0;
  const tail = text === "" ? "" : `; body: ${text}`;

  if (status === 401 || status === 403) {
    return `出图失败：HTTP ${status} —— 访问令牌无效、无权访问该模型，或账号未完成邮箱验证/实名（后者是实测遇到过的真实拦截）。请在面板确认令牌与账号状态${tail}`;
  }
  if (status === 404) {
    return `出图失败：HTTP 404 —— 端点或模型不存在（检查 apiBase 与模型 id）${tail}`;
  }
  if (status === 429) {
    return `出图失败：HTTP 429 —— 上游限流，请稍后重试${tail}`;
  }
  if (status >= 500) {
    return `出图失败：HTTP ${status} —— 上游服务异常，稍后重试${tail}`;
  }

  const cause = str(failure.cause, "");
  if (cause !== "") return `出图失败：${cause}${tail}`;

  const taskStatus = str(failure.taskStatus, "");
  if (taskStatus === "FAILED") {
    // 实测形态：errors.code=0、message 为空串，没有顶层 message。诚实报「未知」。
    return "出图失败：上游任务 FAILED，但未给出失败原因（实测 errors.code=0、message 为空），换模型或稍后重试";
  }
  if (taskStatus !== "") {
    return `出图失败：任务停在 ${taskStatus}（非终态），已超过截止时间`;
  }
  return `出图失败：上游未给出可诊断的失败信息${tail}`;
}

/**
 * 冷却门：一次失败后的一段时间内拒绝再试。
 *
 * 借 sensenova 那份的形状（它也从 `dsh-draw-router` 抄来）：出图慢且贵，一次失败
 * 后立刻重试既容易撞限流又浪费等待窗口。纯闭包，无依赖，可离线测。
 * @param {number} cooldownMs - 冷却窗口（毫秒）。
 * @returns {{fail: () => void, remainingMs: () => number, clear: () => void}} 冷却门。
 */
export function createDrawCooldown(cooldownMs: number) {
  const window = Math.max(0, Math.floor(cooldownMs));
  let until = 0;
  return {
    /** 记一次失败，从此刻起进入冷却。 */
    fail() {
      until = Date.now() + window;
    },
    /** 剩余冷却毫秒；0 表示可以发起。 */
    remainingMs() {
      return Math.max(0, until - Date.now());
    },
    /** 清掉冷却（例如面板里手动排障后）。 */
    clear() {
      until = 0;
    }
  };
}

/**
 * 本轮出图实际发起的轮询次数（诊断用）。
 *
 * 实测 61s 完成意味着 15s 间隔下典型是 2–4 次；这个数字进工具结果有助于区分
 * 「上游慢」与「我方间隔设太密」。
 * @returns {number} 次轮询。
 */
export function expectedPollCount(timeoutMs = DRAW_TIMEOUT_MS, intervalMs = DRAW_POLL_INTERVAL_MS): number {
  const span = Math.max(1, Math.floor(timeoutMs));
  const step = Math.max(1, Math.floor(intervalMs));
  return Math.max(1, Math.ceil(span / step));
}
