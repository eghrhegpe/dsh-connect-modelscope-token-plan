/**
 * 出图工具「开关开着但工具缺席」的原因——仅内存，不落盘。
 *
 * 为什么需要它：开关状态（`draw-store.ts`）与工具的**实际挂载结果**是两件事。
 * 开关开着不代表工具真的注册上了——它可能在三个地方折戟：Host 没有 tools 服务、
 * tools peer 模块加载失败、registry 拒收。这三种情况下面板如果只显示「开关：开」，
 * 用户会以为出图可用，然后在工具调用失败时找不到原因。本模块让面板能说出**为什么**。
 *
 * 三种缺席里只有 `no-tools-service` 是「正常」的（Host 本来就没提供该服务，不是
 * 故障、不记日志）；另两种是 Host 侧缺陷，`draw-register.ts` 除了在这里登记原因，
 * 还会 `logger.warn`。
 *
 * 写入者是唯一的：`draw-register.ts` 的 `registerDrawTool` 每次挂载尝试时重算
 * （先清空再按结果设置），因此一个迟到的 tools 服务最终注册成功时，面板上那句
 * 过期的「缺席」会被**清掉**而不是继续挂着。读取者只有快照聚合。
 *
 * 不落盘的理由：它是**本次挂载**的结果，重启即重算；落盘反而会让一次成功挂载后
 * 残留旧原因。peer-free。
 *
 * @module dsh-connect-modelscope-token-plan/draw-tool-state
 */

/**
 * 出图工具缺席的原因码。`null` = 没缺席（或开关没开）。
 * - `no-tools-service`：开关开着，但这个 Host 没有 tools 服务（正常，非故障）；
 * - `peer-load-failed`：tools peer 模块加载失败，或加载了却不带 `defineTool`；
 * - `registry-refused`：tools registry 拒收这次注册。
 */
export type DrawToolAbsentReason = "no-tools-service" | "peer-load-failed" | "registry-refused";

/** 当前缺席原因（`null` = 未登记 / 已清掉）。 */
let note: DrawToolAbsentReason | null = null;

/**
 * 记下缺席原因（`null` 清空）。
 * @param {DrawToolAbsentReason|null} reason - 原因码。
 * @returns {void}
 */
export function setDrawToolNote(reason: DrawToolAbsentReason | null): void {
  note = reason;
}

/**
 * 读当前缺席原因。
 * @returns {DrawToolAbsentReason|null} 原因码。
 */
export function drawToolNote(): DrawToolAbsentReason | null {
  return note;
}

/**
 * 清空（卸载时调用：下一个 Host 生命周期从干净的「未登记」开始）。
 * @returns {void}
 */
export function resetDrawToolNote(): void {
  note = null;
}
