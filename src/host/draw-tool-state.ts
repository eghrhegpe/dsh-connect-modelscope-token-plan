/**
 * 出图工具「开关开着但工具缺席」的原因——仅内存，不落盘。
 *
 * 为什么需要它：开关状态（`draw-store.ts`）与工具的**实际挂载结果**是两件事。
 * 开关开着不代表工具真的注册上了——它可能在三个地方折戟：Host 没有 tools 服务、
 * tools peer 模块加载失败、registry 拒收。这三种情况下面板如果只显示「开关：开」，
 * 用户会以为出图可用，然后在工具调用失败时找不到原因。本模块让面板能说出**为什么**。
 *
 * 四种缺席里只有 `no-tools-service` 是「正常」的（Host 本来就没提供该服务，不是
 * 故障；`not-removable` 是「能用但摘不掉」的降级，仍记一条 warn）。其余是 Host
 * 侧缺陷，`draw-register.ts` 除了在这里登记原因，还会 `logger.warn`。
 *
 * 写入者是唯一的：`draw-register.ts` 的挂载控制器每次收敛时重算（先清空再按结果
 * 设置），因此一个迟到的 tools 服务最终注册成功时，面板上那句过期的「缺席」会被
 * **清掉**而不是继续挂着。读取者只有快照聚合与出图路由。
 *
 * 除了「为什么缺席」，这里还记**此刻到底注册上了没有**（`drawToolMounted()`）。
 * 这两个位是互补的，缺一不可：
 *
 * - `absentReason !== null` = 开关开着、但这次没挂成（或挂上了却摘不掉）；
 * - `absentReason === null && mounted === false` = 此刻没注册：开关关着（正常），
 *   或者正在挂载（`sync()` 还没跑完）。
 *
 * 旧版这两个位是**静态**的（挂载一次定终身，只能提示「下次启动」）。现在开关翻转
 * 会当场重算，所以 `mounted` 只是「此刻」的读数：一次成功的 `sync()` 之后它一定
 * 与开关一致，除非注册折戟（那时 `absentReason` 非 null 说明原因）。
 *
 * 不落盘的理由：它是**本次运行**的结果，重启即重算；落盘反而会让一次成功挂载后
 * 残留旧原因。peer-free。
 *
 * @module dsh-connect-modelscope-token-plan/draw-tool-state
 */

/**
 * 出图工具缺席的原因码。`null` = 没缺席（或开关没开）。
 * - `no-tools-service`：开关开着，但这个 Host 没有 tools 服务（正常，非故障）；
 * - `peer-load-failed`：tools peer 模块加载失败，或加载了却不带 `defineTool`；
 * - `registry-refused`：tools registry 拒收这次注册；
 * - `not-removable`：注册成功但返回的不是注销句柄（旧 Host）——工具能用，但关掉
 *   开关摘不掉它。这是**非缺席**的降级，面板要照实说，不能让用户以为已经关了。
 */
export type DrawToolAbsentReason = "no-tools-service" | "peer-load-failed" | "registry-refused" | "not-removable";

/** 当前缺席原因（`null` = 未登记 / 已清掉）。 */
let note: DrawToolAbsentReason | null = null;

/**
 * 此刻工具是否真的在 registry 里。
 *
 * 与 `note` 的区别见文件头：`note` 是「为什么没成」，这一位是「此刻在不在」。
 * 开关翻转会当场重算这一位，所以它是动态读数，不是「本次挂载」的存档。
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
