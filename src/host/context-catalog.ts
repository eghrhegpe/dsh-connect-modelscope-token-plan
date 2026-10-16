/**
 * 内置上下文窗口策展表——魔搭目录不声明窗口时的第三方真值来源。
 *
 * 魔搭 `/v1/models`（及模型详情端点）只回基础标识字段（id/object/owned_by/
 * created + Tasks 标签），没有窗口字段；未声明窗口的条目会一路落到
 * `FALLBACK_CONTEXT_WINDOW`（128k）。这张表在「用户全局档位」之外补第三级
 * 真值：目录声明 > 用户覆盖 > **策展表** > 兜底。
 *
 * 数据来自 models.dev 聚合（github.com/anomalyco/models.dev，MIT；api.json
 * 构建产物）。魔搭 provider 自身在 api.json 只有 7 个不在当前目录的旧模型，
 * 所以每条真值取的是**同 id 模型在各厂自家 host 下的主流 limit.context**——
 * 跨 host 抄写的开量窗口是模型出厂规格，不是各网关的部署配额，取多数而非
 * 最大值：个别网关把窗口抄大（如 openrouter 抄 1M）不代表魔搭侧真开那么宽。
 *
 * 维护纪律：
 * 1. 只收**当前魔搭目录里真实存在**的 id（2026-10-16 实拉 `/v1/models` 全集
 *    37 个中筛出 22 个）；目录下架的条目应随手删除，表不是历史档案。
 * 2. 每条注明来源 host 与核对日期；有多个数据源时写主流值并留离群说明。
 * 3. 覆盖优先级由 `curatedWindowOf` 的调用方（inference-client 打标）保证：
 *    目录声明过窗口的条目不进打标，策展表永不推翻平台声明。
 * 4. 生图/语音模型（Qwen-Image-Edit、ACE-Step 等）无对话上下文，不收。
 */

/** id → 标称上下文窗口（tokens）。键必须与魔搭目录 id 逐字一致。 */
export const CURATED_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  // deepseek-ai：models.dev 多数 host（deepseek 官方、openrouter、novita 等）
  // limit.context = 1048576；nebius 个别 979000~1048000 为离群。2026-10-16 核。
  "deepseek-ai/DeepSeek-V4-Flash-0731": 1048576,
  "deepseek-ai/DeepSeek-V4-Pro": 1048576,
  "deepseek-ai/DeepSeek-V4-Pro-0813": 1048576,
  "deepseek-ai/DeepSeek-V4.1-Flash": 1048576,
  // meituan-longcat：models.dev 仅 qiniu-ai 收录 LongCat-Flash-Lite（256000）。
  // 2026-10-16 核。
  "meituan-longcat/LongCat-Flash-Lite": 256000,
  // MiniMax-M1-80k：全部 host 一致 1000000（id 自含 "80k" 指输出余量口径，
  // 聚合上下文一律 1M）。2026-10-16 核。
  "MiniMax/MiniMax-M1-80k": 1000000,
  // MiniMax-M3：models.dev 多数 host 1048576（ambient 262144 离群）。
  // 2026-10-16 核。
  "MiniMax/MiniMax-M3": 1048576,
  // nex-agi：models.dev kilo/openrouter 两 host 一致 262144。2026-10-16 核。
  "nex-agi/Nex-N2.5-mini": 262144,
  "nex-agi/Nex-N2.5-Pro": 262144,
  // Qwen3.5 系：models.dev 主流 262144（ofox 256000、merge-gateway 131072 为
  // 离群）。2026-10-16 核。
  "Qwen/Qwen3.5-122B-A10B": 262144,
  "Qwen/Qwen3.5-27B": 262144,
  "Qwen/Qwen3.5-35B-A3B": 262144,
  "Qwen/Qwen3.5-397B-A17B": 262144,
  // Qwen3.8：主流 262144（openrouter/novita 抄 1000000 为离群）；
  // Qwen3.8-Flash-Next 仅 tensorx 收录（262144）。2026-10-16 核。
  "Qwen/Qwen3.8-27B": 262144,
  "Qwen/Qwen3.8-Flash-Next": 262144,
  // stepfun-ai：models.dev 主流 262144。2026-10-16 核。
  "stepfun-ai/Step-3.5-Flash": 262144,
  "stepfun-ai/Step-3.7-Flash": 262144,
  // ZhipuAI：取智谱官方 host（zhipuai provider）数值——GLM-5.2 = 1000000、
  // GLM-4.7-Flash = 200000；第三方网关多抄 205000/131000 为离群。
  // 2026-10-16 核。
  "ZhipuAI/GLM-4.7-Flash": 200000,
  "ZhipuAI/GLM-5.2": 1000000
};

/**
 * 查策展窗口：命中返回正数，未命中返回 null（调用方继续走兜底）。
 *
 * 只认逐字 id——不做大小写/前后缀模糊匹配，宁可查不到落兜底，也不把
 * 相近 id 的窗口张冠李戴。值合法性再挡一道（表内只应出现正数）。
 * @param {string} id - 模型 id（魔搭目录原样拼写）。
 * @returns {number|null} 标称窗口，未收录为 null。
 */
export function curatedWindowOf(id: string): number | null {
  if (typeof id !== "string" || id === "") return null;
  const value = CURATED_CONTEXT_WINDOWS[id];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
