/**
 * 目录条目 → pi-ai model descriptor 的映射层——魔搭 provider 注册的**纯函数半边**。
 *
 * 本模块刻意不 import 任何 Host peer（`@earendil-works/pi-ai`、
 * `@deepseek-ai/dsh-llm-pi-ai`）：它只产普通对象，所以这些映射决策可以在一个
 * 干净的 checkout 上离线测。peer 依赖的另一半（把这些 descriptor 交给
 * `createProvider`）在 `llm-adapter.ts`。
 *
 * 这里携带的三条决策是承重的，不是装饰：
 *
 * 1. `compat.supportsDeveloperRole: false`。pi-ai 在缺省时会**自动探测**这个
 *    标志，对非标准 provider 一律猜 `true`，于是每条请求都用 `developer`
 *    角色——魔搭这个多模型代理不认识，会 400 或 403。qoder 路由证明必须
 *    显式写 false。
 * 2. `maxTokens` 只在目录**声明了**上限时声明。harness 对未声明的 maxTokens
 *    用 `defaultMaxTokens ?? 32768` 兜底，所以「不声明」不是「没有上限」，而是
 *    「平台没说」的诚实处理；别猜数字填。
 * 3. `reasoning: false` + **不设** `thinkingLevelMap`。魔搭 API-Inference 是
 *    多模型代理，是否吃 `reasoning_effort` 取决于背后那个具体模型，本插件
 *    无法离线得知每个 id 的档位表（sensenova 那份是拿真令牌逐模型探测才
 *    钉出来的）。真实障碍**不是**「发错档位会整条请求 400」——该理由于
 *    2026-10-05 被真机证伪（`"bogus"` 同样 200，值不被校验）——而是无法区分
 *    「参数生效」与「被静默忽略」（两者都 200），且该端点会在真响应与空壳 200
 *    之间摇摆，档位表做不出来。理由与实测见 PROVIDER-M4.md §4。
 *
 * @module dsh-connect-modelscope-token-plan/llm-models
 */

import { str, num } from "./util.ts";

/**
 * 一条归一后的目录条目。
 *
 * 刻意保留原字段的可索引形状（`[k: string]: unknown`）：`/v1/models` 的 data[]
 * 条目由 `inference-client.ts` 整条透传，`normalizeEntry` 只补上派生字段并把
 * 原始对象挂到 `raw` 上，所以平台将来新增的字段不需要改解析器就能被这里读到。
 */
export interface CatalogEntry {
  id?: unknown;
  name?: unknown;
  [k: string]: unknown;
}

/**
 * 本插件注册 provider 用的 id。
 *
 * **绝不能**是裸 `"modelscope"`：操作者可能已手写一条 `llm-pi-ai`
 * （apiKeyEnv `MODELSCOPE_API_KEY`、base `https://api-inference.modelscope.cn/v1`），
 * `registerAdapter` 对冲突 id 直接拒绝。自有 slug 形 id 不会撞。
 */
export const LLM_PROVIDER_ID = "modelscope-token-plan";

/** DSH 模型选择器里显示的 provider 名。 */
export const LLM_DISPLAY_NAME = "ModelScope Token Plan";

/** pi-ai 展示的凭据名（静态令牌，形如 `ms-…`）。 */
export const LLM_API_KEY_NAME = "ModelScope token";

/**
 * 代表「什么都不提供」的 id。
 *
 * 空的允许清单已经表示「不过滤」，所以还得有第二种写法表示「过滤结果为空」：
 * 一个永远不可能成为真实模型 id 的字符串，作为清单里唯一的项。`filterByEnabled`
 * 按一个匹配不到任何东西的 id 过滤，这就是用户要的 offer。裸 `[]` 不能同时表示
 * 「全部模型」与「没有模型」。
 *
 * provider 路由与快照用同一个字面量（浏览器 bundle 无法 import 本模块，所以
 * `client.js` 里还有一份）——两侧改名必须一起改，否则面板的「全部隐藏」会
 * 静默变成「全部提供」。
 */
export const HIDE_ALL_MODELS = "__hide_all__";

/**
 * 每 token 单价对额度制路由不可知，四处一律报零。
 *
 * ⚠️ 零是**哨兵**，不是「免费」。魔搭 Token Plan 是次数/额度池计费，按 token
 * 的美元单价在这条路上根本不存在——但模型照样烧额度。面板行显示 "$0.00" 说的是
 * 「按 token 单价未知」，永远不是「这模型不花钱」。注释就贴在这组值旁边，免得
 * 后来人「好心」改成真价，或更糟改成 `null`（pi-ai 会把它当未知成本行渲染，
 * 弄坏选择器的成本算术）。
 */
export const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * 目录没声明可用窗口时的兜底窗口。
 *
 * pi-ai 的 options 构建器会对 `model.contextWindow` 做算术，所以 undefined 被
 * 当 0 算而不是「未知」，会把 max-token 计算算坏；qoder 路由因此总是给正数。
 * 128k 是保守的通用默认；目录真的声明了窗口时，那个值永远赢。
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/** 判 vision 时优先读的结构化模态字段（平台拼写 + 常见别称）。 */
const INPUT_MODALITY_KEYS = Object.freeze(["input_modalities", "modalities", "inputTypes", "modality", "capabilities"]);

/**
 * 无结构化字段时的名字启发。
 *
 * 多模态模型名里 `vl` 很常见，这条启发是社区惯例。漏判 = 模型收图时报
 * `UNSUPPORTED_CONTENT`，面板能看见，不算静默失败（所以方向偏「松」）。
 */
const VISION_NAME_PATTERN = /(vl|vision|qwen2?\.?\d*-?vl|glm.*v|internvl|llava|pixtral)/i;

/**
 * 明确是图像**生成**模型的 id/名字才排除。
 *
 * 魔搭目录里这些是纯生图模型，打 `/chat/completions` 会 404。没标注的一律算
 * chat——缺失字段不等于不能用。
 */
const IMAGE_GEN_NAME_PATTERN = /(wanx|qwen-image|cogview|flux|stable-diffusion|sdxl|sd3|txt2img|text-to-image|draw|seedream|kolors|hunyuan-?image|imagen)/i;

/**
 * 人工策展的「已知多模态（能吃图）模型」清单——详情端点**不可达时**的离线兜底。
 *
 * 为什么还需要：魔搭 `/v1/models` 实测每条只返回 `id`/`object`/`owned_by`/`created`，
 * 零模态字段（不像 sensenova 有 `type` 字段可判），名字启发也会漏掉
 * `DeepSeek-V4.1-Flash` 这类「名字不含 vl/vision 但能吃图」的模型。详见 `isVisionModel`：
 * 首选详情端点 `Tasks[].Name` 精确判定（image-text-to-text 即真），此清单只在详情拉取
 * 失败（网络 / 限频）时兜底，避免面板在离线时完全失去视觉标签。
 *
 * 这份清单是「我们已知」（模型卡 / 用户反馈），不是平台声明；与名字启发一样，**不假装
 * 上游返回过**。真机若某模型吃图却不在清单，最坏只是收 `UNSUPPORTED_CONTENT`，不静默
 * 失败。新增已确知的多模态模型时在此追加 id 即可。
 *
 * 已按详情端点 `Tasks[].Name == image-text-to-text` 逐条真机核实补全（2026-10-04，api-inference
 * 当前 35 条目录里共 14 条吃图模型，下面就是全部）。这样即使详情端点整段拉不到，面板也能
 * 保留准确的视觉标签，不用靠名字猜——`MiniMax-M3`/`Intern-S1`/`Qwen3.5-397B-A17B`/`Step-3.7-Flash`
 * 这类名字不含 vl/vision 的模型，光靠 `VISION_NAME_PATTERN` 会漏。
 */
const KNOWN_VISION_IDS = Object.freeze(new Set([
  "deepseek-ai/DeepSeek-V4.1-Flash",
  // 官方 OpenAI SDK 示例即以 image_url 调它（modelscope.cn 文档），名字无 vl/vision
  // 但确实能吃图；catalog 不返回模态字段，名字启发也漏，故显式策展。
  "Qwen/Qwen3.8-Flash-Next",
  // 以下 12 条均为 2026-10-04 详情端点实测 `image-text-to-text`（能吃图），其中 MiniMax-M3、
  // Intern-S1 系列、Step-3.7-Flash 名字不含 vl/vision，名字启发会漏，所以必须策展。
  "MiniMax/MiniMax-M3",
  "OpenGVLab/InternVL3_5-241B-A28B",
  "PaddlePaddle/ERNIE-4.5-VL-28B-A3B-PT",
  "Qwen/Qwen3.5-122B-A10B",
  "Qwen/Qwen3.5-27B",
  "Qwen/Qwen3.5-35B-A3B",
  "Qwen/Qwen3.5-397B-A17B",
  "Qwen/Qwen3.8-27B",
  "Shanghai_AI_Laboratory/Intern-S1",
  "Shanghai_AI_Laboratory/Intern-S1-mini",
  "Shanghai_AI_Laboratory/Intern-S2-Preview",
  "stepfun-ai/Step-3.7-Flash"
]));

/**
 * 把原始 `/v1/models` data 条目变成归一目录条目。
 *
 * 只做投影与回退，不做判断：`id` 必取，`name` 回退 id，`vision`/`contextWindow`/
 * `maxOutputLength` 由下面的判断函数产出。`raw` 保留整条原始对象，且原始字段
 * 一并展开在条目上，所以 `context_length` 这类字段下游仍能直读——平台新增字段
 * 不需要改解析器。
 * @param {unknown} raw - `/v1/models` `data[]` 里的一条。
 * @returns {CatalogEntry} 归一后的条目。
 */
export function normalizeEntry(raw: unknown): CatalogEntry {
  const source = (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const id = str(source.id, "");
  return {
    ...source,
    id,
    name: str(source.name, id),
    capability: resolveModelCapability(source),
    vision: isVisionModel(source),
    contextWindow: contextWindowOf(source),
    maxOutputLength: maxOutputLengthOf(source),
    raw: source
  };
}

/**
 * 读一条目录条目首个模态字段，取不到返回 undefined。
 *
 * 魔搭 `/v1/models` 是否声明 `input_modalities` 需真机核实；这里把平台拼写与
 * 常见别称一并列出，字符串/数组都能吃，平台换拼写不用改解析器。
 * @param {Record<string, unknown>} source - 一条目录条目。
 * @returns {string[]|undefined} 模态名列表，取不到为 undefined。
 */
function inputModalitiesOf(source: Record<string, unknown>): string[] | undefined {
  for (const key of INPUT_MODALITY_KEYS) {
    const value = source[key];
    if (Array.isArray(value)) return value.map((modality) => String(modality));
    if (typeof value === "string" && value !== "") return value.split(/[,|]/).map((modality) => modality.trim()).filter((m) => m !== "");
  }
  return undefined;
}

/**
 * 读一条目录条目从详情端点带来的任务标签（image-text-to-text 等）。
 *
 * `fetchModels` 会对每个 id 并行请求 modelscope.cn/api/v1/models/{id}，把响应的
 * `Data.Tasks[].Name`（+ `widgets[].task` 兜底）收集后挂到 `entry.tasks`。取不到或
 * 非数组返回 undefined，调用方据此回退策展清单 + 名字启发。
 * @param {Record<string, unknown>} source - 一条目录条目。
 * @returns {string[]|undefined} 任务标签列表，取不到为 undefined。
 */
function tasksOf(source: Record<string, unknown>): string[] | undefined {
  const value = source.tasks;
  if (Array.isArray(value)) {
    const out = value.map((task) => String(task)).filter((task) => task !== "");
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

/**
 * 一条目录条目的**能力类型**——把「是不是视觉」这种二值判定升级为能力路由。
 *
 * 这是承重的方向性决策：魔搭 `/v1/models` 零模态字段，但详情端点
 * `Data.Tasks[].Name` 是平台声明的任务标签，能精确区分图入 / 图出 / 文生图 / 图生图。
 * 把能力存成枚举，下游（vision 开关、将来的出图 / 改图 / 视频工具）就能按能力路由，
 * 而不是各自写一套名字正则去猜。`unknown` 表示无信号，**绝不猜**。
 *
 * 词表全部来自真机核实（2026-10-04）：
 * - api-inference 的 35 条目录里出现 4 个——`text-generation`(16)、
 *   `image-text-to-text`(14)、`image-to-image`(2)、`text2text-generation`(1)；
 * - hub 详情端点对文生图模型返回 `text-to-image-synthesis`（`Qwen/Qwen-Image`、
 *   `black-forest-labs/FLUX.1-schnell`、`Tongyi-MAI/Z-Image-Turbo` 实测），
 *   文生视频返回 `text-to-video-synthesis`。
 *
 * ⚠️ 能力标签 ≠ 可用端点：`text-to-image-synthesis` 只说明 hub 上有这么个模型，
 * api-inference 的 35 条目录里**目前没有任何**文生图模型，所以出图工具的候选列表
 * 今天仍为空。本模块只做能力标注，不假装可寻址。
 * @typedef {"unknown"|"text"|"vision-input"|"image-to-text"|"image-to-image"|"text-to-image"|"text-to-video"} ModelCapability
 */
export type ModelCapability =
  | "unknown"
  | "text"            // text-generation / text2text-generation
  | "vision-input"    // image-text-to-text / vqa：图进文出，能吃图
  | "image-to-text"   // image-to-text / image-caption：图出文
  | "image-to-image"  // 图生图 / 改图
  | "text-to-image"   // 文生图（出图）
  | "text-to-video";  // 文生视频

/** 任务标签 → 能力。键为平台返回的小写任务名，词表见上方说明。 */
const TASK_TO_CAPABILITY: Record<string, ModelCapability> = Object.freeze({
  "text-generation": "text",
  "text2text-generation": "text",
  "image-text-to-text": "vision-input",
  "visual-question-answering": "vision-input",
  "image-to-text": "image-to-text",
  "image-caption": "image-to-text",
  "image-to-image": "image-to-image",
  "text-to-image-synthesis": "text-to-image",
  "text-to-video-synthesis": "text-to-video"
});

/** 能力优先级：图像类信号比「纯文本」具体，多个标签时取最具体的一个。 */
const CAPABILITY_RANK: Record<ModelCapability, number> = Object.freeze({
  unknown: 0,
  text: 1,
  "vision-input": 3,
  "image-to-text": 3,
  "image-to-image": 4,
  "text-to-image": 5,
  "text-to-video": 5
});

/** 从任务标签数组取能力；一个都不认识返回 undefined（调用方再走兜底）。 */
function capabilityFromTasks(tasks: string[]): ModelCapability | undefined {
  let best: ModelCapability | undefined;
  let bestRank = -1;
  for (const task of tasks) {
    const capability = TASK_TO_CAPABILITY[task.trim().toLowerCase()];
    if (capability === undefined) continue;
    if (CAPABILITY_RANK[capability] > bestRank) {
      best = capability;
      bestRank = CAPABILITY_RANK[capability];
    }
  }
  return best;
}

/**
 * 解析一条目录条目的能力类型。
 *
 * 判定顺序（权威 → 兜底）：结构化模态字段 → 详情端点任务标签 → 策展清单 → 名字启发。
 * 前两级是平台声明，后两级是「我们已知 / 我们推断」，绝不混淆。
 * @param {object} entry - 一条归一目录条目。
 * @returns {ModelCapability} 能力类型。
 */
export function resolveModelCapability(entry: CatalogEntry): ModelCapability {
  const source = (entry ?? {}) as Record<string, unknown>;
  // 1) 结构化字段是权威答案：字段里出现 image/vision 就是图像相关，别再用名字猜。
  const modalities = inputModalitiesOf(source);
  if (modalities !== undefined) {
    return modalities.some((modality) => /image|vision/i.test(modality)) ? "vision-input" : "text";
  }
  // 2) 详情端点（modelscope.cn/api/v1/models/{id}）的 Tasks[].Name 是精确信号。
  //    fetchModels 并行拉取详情、把标签挂到 entry.tasks；拉取失败则该模型 tasks 为空。
  const tasks = tasksOf(source);
  if (tasks !== undefined) {
    const capability = capabilityFromTasks(tasks);
    if (capability !== undefined) return capability;
    return "unknown"; // 有标签但一个都不认识——不猜。
  }
  // 3) 策展清单 KNOWN_VISION_IDS 是详情端点不可达时的离线兜底（我们确知，非平台声明）。
  const id = str(source.id, "");
  if (id !== "" && KNOWN_VISION_IDS.has(id)) return "vision-input";
  // 4) 名字启发最后才用——面板能说「按名字推断」，绝不假装平台声明过。
  const idOrName = `${id} ${str(entry?.name, "")}`;
  if (VISION_NAME_PATTERN.test(idOrName)) return "vision-input";
  return "unknown";
}

/**
 * 一条目录条目能否吃图（vision）。
 *
 * 是 `resolveModelCapability` 的布尔投影：图进文出（`vision-input`）或图出文
 * （`image-to-text`/caption）算视觉模型；图出图（`image-to-image`）、文生图
 * （`text-to-image`）**不算**——它们不吃图，别混进 vision 开关。
 * 漏判 = 模型收图时报 `UNSUPPORTED_CONTENT`，面板能看见，不算静默失败。
 * @param {object} entry - 一条归一目录条目。
 * @returns {boolean} 是否吃图。
 */
export function isVisionModel(entry: CatalogEntry): boolean {
  const capability = resolveModelCapability(entry);
  return capability === "vision-input" || capability === "image-to-text";
}

/**
 * 一条目录条目能否作为 chat 模型寻址。
 *
 * **宽松方向**。只有明确是图像**生成**模型的 id/名字（`IMAGE_GEN_NAME_PATTERN`）
 * 或 `output_modalities` 只含 `image` 才排除：魔搭目录里这些是纯生图模型，打
 * `/chat/completions` 会 404。没标注的一律算 chat——缺失字段不等于不能用。
 * @param {object} entry - 一条归一目录条目。
 * @returns {boolean} 是否可用作 chat 模型。
 */
export function isChatModel(entry: CatalogEntry): boolean {
  const source = (entry ?? {}) as Record<string, unknown>;
  const out = source.output_modalities;
  if (Array.isArray(out) && out.length > 0) {
    // 「只含 image」才是生图声明：空数组/含别的模态都不算，按 chat 放行。
    if (out.every((modality) => String(modality).toLowerCase() === "image")) return false;
  }
  const idOrName = `${str(entry?.id, "")} ${str(entry?.name, "")}`;
  return !IMAGE_GEN_NAME_PATTERN.test(idOrName);
}

/**
 * 读目录声明的上下文窗口，取不到用兜底。
 *
 * 命中一个正数就用；否则 `FALLBACK_CONTEXT_WINDOW`——pi-ai 对 undefined 的
 * contextWindow 当 0 算，会坏掉 max-token 计算。与 `contextWindowOf` 同一份
 * 拼写策略：只认已知拼写，缺字段回退，不猜数字。
 * @param {object} entry - 一条归一目录条目。
 * @returns {number} 声明的窗口，或兜底值。
 */
export function contextWindowOf(entry: CatalogEntry): number {
  for (const key of ["context_length", "context_window", "contextWindow", "max_context_tokens"]) {
    const value = Math.floor(num(entry?.[key], 0));
    if (value > 0) return value;
  }
  return FALLBACK_CONTEXT_WINDOW;
}

/**
 * 读目录声明的单次输出上限，0 = 未声明。
 *
 * 这个数**只用于展示/投影**。descriptor 只在 >0 时声明 `maxTokens`（见模块头注
 * 第 2 条），所以它从不变成请求参数——它说的是平台至多能吐多少，让用户明白为什么
 * 长回答仍会以 `finish_reason: length` 停住。
 * @param {object} entry - 一条归一目录条目。
 * @returns {number} 声明的上限，未声明为 0。
 */
export function maxOutputLengthOf(entry: CatalogEntry): number {
  for (const key of ["max_output_length", "maxOutputLength", "max_output_tokens"]) {
    const value = Math.floor(num(entry?.[key], 0));
    if (value > 0) return value;
  }
  return 0;
}

/**
 * 把一条目录条目映射成适配器交给 pi-ai 的 model descriptor。
 *
 * vision 用的是与快照/roster 完全相同的判定（`isVisionModel`），所以模型选择器
 * 不可能与面板的 vision 清单就「哪些模型能吃图」意见相反。
 * @param {object} entry - 一条归一目录条目（必须带 `id`）。
 * @param {object} [options] - 装配参数。
 * @param {string} [options.providerId] - 该 descriptor 所属的 provider id。
 * @param {string} [options.baseUrl] - OpenAI 兼容源站。
 * @returns {object} pi-ai descriptor。
 */
export function toPiDescriptor(entry: CatalogEntry, options: { providerId?: string; baseUrl?: string } = {}) {
  const { providerId = LLM_PROVIDER_ID, baseUrl } = options;
  const id = str(entry?.id, "");
  if (id === "") throw new Error("toPiDescriptor: catalog entry has no id");
  const vision = isVisionModel(entry);
  const maxOutputLength = maxOutputLengthOf(entry);
  return {
    id,
    // 优先用目录自己的展示名，回退 id。
    name: str(entry.name, id),
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    // 吃图是自动的：目录的模态字段决定，用户不用逐模型配置。
    input: vision ? ["text", "image"] : ["text"],
    // §4：魔搭是多模型代理，吃不吃 reasoning_effort 取决于背后那个模型；保守
    // 默认 false（不发该参数，模型用自己的默认），且不设 thinkingLevelMap
    // （picker 不提供思考强度选择器）。档位表不可行——理由见 §4。
    reasoning: false,
    cost: { ...NO_COST },
    contextWindow: contextWindowOf(entry),
    // 只在目录声明了输出上限时才声明 maxTokens——harness 对未声明会用
    // `defaultMaxTokens ?? 32768` 兜底，那是「平台没说」的诚实处理。
    ...(maxOutputLength > 0 ? { maxTokens: maxOutputLength } : {}),
    // `supportsDeveloperRole: false` 是承重墙——见模块头注第 1 条。
    compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false }
  };
}

/**
 * 允许清单的三态归一（§11 的 `allowed`）。
 *
 * 全插件只有这一处口径，快照（`snapshot-aggregate.ts`）与 provider 路由
 * （`routes/provider.ts`）都调它，杜绝两处各自写一套分类导致口径漂移：
 *
 *   - 空清单            → `"all"`（不过滤，提供全部模型）；
 *   - 含哨兵 `HIDE_ALL_MODELS` → `"none"`（什么都不提供）；
 *   - 其余非空清单      → `"list"`（严格白名单）。
 *
 * 空清单已经占用了「不过滤」，所以「什么都不提供」必须有第二种拼写——这正是
 * `HIDE_ALL_MODELS` 存在的原因。注意「含哨兵但还塞了别的 id」仍按 `"none"` 处理
 * （哨兵语义优先，与 `filterByEnabled` 的「匹配不到任何真实 id」完全一致）。
 * @param {string[]} enabledIds - 允许清单。
 * @returns {"all"|"none"|"list"}
 */
export function resolveAllowedList(enabledIds: string[]): "all" | "none" | "list" {
  if (!Array.isArray(enabledIds) || enabledIds.length === 0) return "all";
  if (enabledIds.includes(HIDE_ALL_MODELS)) return "none";
  return "list";
}

/**
 * 把目录缩到用户允许的模型子集。
 *
 * **空清单 = 不过滤**：新装没做过选择，仍应提供全部模型。一旦非空就是严格白
 * 名单；名单里点名了本目录没有的 id 也无害——它只是匹配不到东西。
 *
 * `HIDE_ALL_MODELS` 哨兵靠「匹配不到任何真实 id」表达「什么都不提供」，因为空
 * 清单已经被「不过滤」占用了。这里直接走 {@link resolveAllowedList} 的三态：
 * 含哨兵的清单属 `"none"`，过滤结果必然是空（哨兵不是真实 id），与
 * `isModelEnabled` 的口径一致（fix D）。
 * @param {object[]} entries - 归一目录条目。
 * @param {string[]} [enabledIds] - 允许清单；空/缺省关闭过滤。
 * @returns {object[]} 仍被提供的条目，按目录顺序。
 */
export function filterByEnabled(entries: unknown, enabledIds?: unknown): object[] {
  const list = Array.isArray(enabledIds) ? enabledIds : [];
  if (list.length === 0) return Array.isArray(entries) ? entries : [];
  const allow = new Set(list.map((id) => str(id, "")));
  return (Array.isArray(entries) ? entries : []).filter((entry) => allow.has(str((entry as CatalogEntry)?.id, "")));
}

/**
 * 某个模型 id 在给定允许清单下会不会被提供。
 *
 * 与 {@link filterByEnabled} 同一套语义：空清单提供一切，含 `HIDE_ALL_MODELS`
 * 哨兵（= `"none"`）什么都不提供，其余非空清单是严格白名单（fix D）。
 * @param {string[]|undefined} enabledIds - 允许清单。
 * @param {string} id - 要问的模型 id。
 * @returns {boolean}
 */
export function isModelEnabled(enabledIds: string[] | undefined, id: string): boolean {
  const list = Array.isArray(enabledIds) ? enabledIds : [];
  if (list.length === 0) return true;
  if (list.includes(HIDE_ALL_MODELS)) return false; // 哨兵 = 什么都不提供
  return list.includes(str(id, ""));
}

/**
 * 面板用的 roster：每条可寻址 chat 条目一行。
 *
 * 刻意是投影而非原始条目：快照只带 picker 需要的（id、展示名、与 descriptor
 * 相同的 vision 判定、以及供能力路由用的 capability），平台将来新增的目录字段
 * 不会为了没理由泄到面板。
 *
 * 去重保留**末次出现**（与 {@link buildDescriptors} 一致）：同 id 更新的读取赢。
 * 这里要是分叉了，面板清单和注册结果就会就「哪些模型存在」说两套话，勾选的模型
 * 可能变成未注册的。
 * @param {object[]} entries - 归一目录条目。
 * @returns {{id: string, name: string, vision: boolean, capability: ModelCapability}[]}
 */
export function rosterOf(entries: unknown): { id: string; name: string; vision: boolean; capability: ModelCapability }[] {
  const position = new Map<string, number>();
  const out: { id: string; name: string; vision: boolean; capability: ModelCapability }[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    // 生图模型不是 chat 模型，不进 roster——与注册的 offer 保持一致，否则勾选的
    // 模型可能变成未注册的。
    if (!isChatModel(entry as CatalogEntry)) continue;
    const id = str((entry as CatalogEntry)?.id, "");
    if (id === "") continue;
    const row = {
      id,
      name: str((entry as CatalogEntry)?.name, id),
      vision: isVisionModel(entry as CatalogEntry),
      capability: resolveModelCapability(entry as CatalogEntry)
    };
    if (position.has(id)) {
      out[position.get(id)!] = row;
    } else {
      position.set(id, out.length);
      out.push(row);
    }
  }
  return out;
}

/**
 * 为一份目录构建整份 descriptor 列表。
 *
 * 没有 id 的条目丢弃（线上没法寻址），重复 id 保留末次出现，与 `rosterOf` 的
 * 去重一致。`unavailableModelIds` 里的（额度耗尽的）模型丢弃——面板经
 * `rosterWithAvailability` 仍显示它们，灰显加原因，但 picker 不提供注定 429 的
 * 请求；两处口径不同是故意的，别统一。
 * @param {object[]} entries - 归一目录条目。
 * @param {object} options - `{ providerId, baseUrl, enabledIds, unavailableModelIds }`。
 * @returns {object[]} pi-ai descriptor，按首见顺序。
 */
export function buildDescriptors(entries: unknown, options: { providerId?: string; baseUrl?: string; enabledIds?: string[]; unavailableModelIds?: string[] } = {}) {
  const { providerId = LLM_PROVIDER_ID, baseUrl, enabledIds = [], unavailableModelIds = [] } = options;
  // 生图模型（`output_modalities` 只含 image）不能当 chat 模型寻址，在允许清单
  // **之前**排除——这样 enabledIds 里的过期 id 匹配不到东西，而不是把生图模型
  // 复活成 chat。
  const filtered = filterByEnabled(entries, enabledIds).filter((entry) => isChatModel(entry as CatalogEntry));
  const blocked = new Set(Array.isArray(unavailableModelIds) ? unavailableModelIds : []);
  const seen = new Map<string, number>();
  // `undefined` 槽位短暂存在：首见先占位（push），descriptor 落地在同一索引——
  // 洞在返回 `out` 前一定被填满。
  const out: (object | undefined)[] = [];
  for (const entry of Array.isArray(filtered) ? filtered : []) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const catalogEntry = entry as CatalogEntry;
    const id = str(catalogEntry.id, "");
    if (id === "") continue;
    // 额度耗尽的模型对每个请求都会答 `429 quota_exceeded`，所以 picker 不提供它
    // ——注定失败的请求干脆不发。
    if (blocked.has(id)) continue;
    if (!seen.has(id)) {
      seen.set(id, out.length);
      out.push(undefined);
    }
    out[seen.get(id)!] = toPiDescriptor({ ...catalogEntry, id }, { providerId, ...(baseUrl !== undefined ? { baseUrl } : {}) });
  }
  return out as object[];
}

/**
 * 带额度可用性的面板 roster。
 *
 * 与 {@link rosterOf} 一样每 chat 模型 id 一行，但每行还带该模型额度池是否耗尽。
 * 与 **picker**（`buildDescriptors` 直接丢弃耗尽模型，避免发注定 429 的请求）不同，
 * 面板保留它们在清单里、灰显，让用户看得见「为什么模型从选择器里不见了」。
 * @param {object[]} entries - 归一目录条目。
 * @param {string[]} unavailableIds - 额度耗尽的模型 id；空数组 = 全部可用。
 * @returns {{id: string, name: string, vision: boolean, capability: ModelCapability, available: boolean, quotaExhausted: boolean, contextWindow: number, maxOutputLength: number}[]}
 */
export function rosterWithAvailability(entries: unknown, unavailableIds: string[]): { id: string; name: string; vision: boolean; capability: ModelCapability; available: boolean; quotaExhausted: boolean; contextWindow: number; maxOutputLength: number }[] {
  const blocked = new Set(Array.isArray(unavailableIds) ? unavailableIds : []);
  const position = new Map<string, number>();
  const out: { id: string; name: string; vision: boolean; capability: ModelCapability; available: boolean; quotaExhausted: boolean; contextWindow: number; maxOutputLength: number }[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isChatModel(entry as CatalogEntry)) continue;
    const id = str((entry as CatalogEntry)?.id, "");
    if (id === "") continue;
    const row = {
      id,
      name: str((entry as CatalogEntry)?.name, id),
      vision: isVisionModel(entry as CatalogEntry),
      capability: resolveModelCapability(entry as CatalogEntry),
      available: !blocked.has(id),
      quotaExhausted: blocked.has(id),
      // descriptor 自己会用的窗口：目录声明了就用，否则用 pi-ai 拿到的同一个
      // 128k 兜底——徽章不会跟实际行为矛盾。
      contextWindow: contextWindowOf(entry as CatalogEntry),
      // 平台声明的输出上限（0 = 未知）。刻意把投影加宽：原始条目留在 Host 侧，
      // 面板只引这两个参数值与 vision 判定。
      maxOutputLength: maxOutputLengthOf(entry as CatalogEntry)
    };
    if (position.has(id)) {
      out[position.get(id)!] = row;
    } else {
      position.set(id, out.length);
      out.push(row);
    }
  }
  return out;
}

/**
 * provider 注册状态要报告的量：目录提供了多少模型、其中多少能吃图。
 *
 * vision 用与 descriptor 相同的判定（`isVisionModel`），所以面板数与注册结果
 * 不会就「vision 模型有几个」说两套话。
 * @param {object[]} entries - 归一目录条目。
 * @returns {{modelCount: number, visionCount: number, visionIds: string[]}}
 */
export function summarizeCatalog(entries: unknown): { modelCount: number; visionCount: number; visionIds: string[] } {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => isChatModel(entry as CatalogEntry));
  const ids = list.map((entry) => str((entry as CatalogEntry)?.id, "")).filter((id) => id !== "");
  const visionIds = ids.filter((id) => isVisionModel({ ...((list.find((e) => str((e as CatalogEntry)?.id, "") === id) as CatalogEntry) ?? {}), id }));
  return {
    modelCount: ids.length,
    visionCount: visionIds.length,
    visionIds
  };
}