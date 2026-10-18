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
 * 除了「为什么缺席」，这里还记**本次挂载到底注册上了没有**（`drawToolMounted()`）。
 * 这两个位是互补的，缺一不可：
 *
 * - `absentReason !== null` = 开关当时就开着、注册折戟了——**注册已尝试且失败**；
 * - `absentReason === null && mounted === false` = 挂载那一刻开关是关的，压根没
 *   走到注册（或还没走完）。用户随后翻开关，工具不会凭空出现——要下次 Host 启动。
 *
 * 曾有版本用 `absentReason !== null` 当作「待重启」的判据，恰好把两类场景搞反了：
 * 真正需要提示重启的是**第二种**（开关刚打开、本次没注册），而它 absentReason
 * 是 null，于是面板什么都不说。见 `routes/draw.ts` 与 `snapshot-aggregate.ts` 的
 * `mountPending`。
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
 * 本次挂载是否真的把工具注册上了。
 *
 * 与 `note` 的区别见文件头：`note` 是「注册尝试过且失败的原因」，这一位是「注册
 * 成功与否」。开关在挂载后才翻开的场景，两者都是「没有缺席原因 + 没注册上」，
 * 只有这一位能把它认出来。
 */
let mounted = false;

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
 * 记下「本次挂载已注册上」。只有注册路径走完才置 true；缺席与「开关没开」都是
 * false。
 * @param {boolean} value - 是否注册成功。
 * @returns {void}
 */
export function setDrawToolMounted(value: boolean): void {
  mounted = value === true;
}

/**
 * 读「本次挂载是否注册上了」。
 * @returns {boolean} true = 注册成功。
 */
export function drawToolMounted(): boolean {
  return mounted;
}

/**
 * 清空（卸载时调用：下一个 Host 生命周期从干净的「未登记」开始）。
 * @returns {void}
 */
export function resetDrawToolNote(): void {
  note = null;
  mounted = false;
}
