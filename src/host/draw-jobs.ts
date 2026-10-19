/**
 * 出图作业的**会话内登记表**——两段式工具的第二段靠它把「上次那个任务」找回来。
 *
 * ## 为什么需要一张表
 *
 * 上游的异步任务只要 `task_id` + 令牌就能查，所以严格来说 agent 把 `task_id`
 * 原样带回来就行——本表真正补的是**上游不知道的两件事**：
 *
 *   1. `submittedAt`：任务从什么时候开始算「等了多久」。没有它就没法判断有没有
 *      越过总放弃线（`drawTimeoutMs`），而「无限续查一张永远不出图的任务」正是
 *      分段查询要防的东西；
 *   2. `polls`：跨多次调用的累计轮询次数，诊断「上游慢」还是「我方查得密」时，
 *      单次调用里的计数是看不见全貌的。
 *
 * ## jobId 为什么就是上游 taskId
 *
 * 刻意不另发明一套 id：agent 拿到的字符串可以直接与面板提示、上游日志、超时
 * 文案里的 `task …` 对上；少一层映射就少一处漂移。代价是 `taskId` 由上游决定
 * ——这里只把它当不透明键用，不解析它。
 *
 * ## 生命周期
 *
 * 表只在**本进程内**有效：插件重启后 `get` 会落空，调用方据此给一条可操作的
 * 错误（见 `draw-runtime.ts`）——这是刻意的诚实，而不是假装还能续查。因为上游
 * 的终态记录**会被回收**（`docs/SPIKE-image-gen.md` §坑 5：事后查可能变成
 * FAILED），「我不记得这个 job」与「这张图还能取回来」本来就不能划等号。
 *
 * 容量有上限：每出一张图就多一条，无限增长会把长跑会话的内存慢慢吃成泄漏。
 * 淘汰分两级（2026-10-19 评审落地）：
 *
 *   1. **软上限**（`maxJobs`）只淘汰**已过续查保护窗**的作业——年龄 ≥
 *      `resumeWindowMs` 的作业即便被 agent 找回来，也早已越过总放弃线，
 *      续查只会换来「超过总预算」，留着没有意义；
 *   2. **硬上限**（`hardMaxJobs`）保底：全是保护窗内的作业也绝不无界，
 *      超过它淘汰最旧。保护窗回答「该不该留」，硬上限回答「最多留多少」。
 *
 * 保护窗的默认值 15 分钟 = 出图默认总放弃线（`drawTimeoutMs`）；装配处
 * （`index.ts`）传 `settings.drawTimeoutMs` 覆盖，于是「还能续查」与工具侧
 * 的放弃线是同一条线，不会出现「表还记得、工具已经放弃」的中间态。
 *
 * peer-free、不碰 I/O、不碰时间以外的环境——可进离线 `npm test`。
 *
 * @module dsh-connect-modelscope-token-plan/draw-jobs
 */

/** 一条出图作业。 */
export interface DrawJob {
  /** 作业 id（= 上游 `task_id`），回给 agent 用于续查。 */
  jobId: string;
  /** 上游任务 id（与 `jobId` 同值，留字段名是为了读侧不必靠这个巧合）。 */
  taskId: string;
  /** 出图用的模型。 */
  model: string;
  /** 提示词（续查时回显，agent 不必自己记）。 */
  prompt: string;
  /** 提交时刻（墙钟毫秒），总放弃线的起点。 */
  submittedAt: number;
  /** 累计轮询次数。 */
  polls: number;
}

/** 建表参数。 */
export interface DrawJobsOptions {
  /** 最多保留多少条作业，超出淘汰最旧的。 */
  maxJobs?: number;
  /**
   * 续查保护窗（毫秒）：年龄小于它的作业仍可能被 agent 带 jobId 续查，
   * 软上限淘汰时优先跳过。默认 15 分钟（= 出图默认总放弃线 drawTimeoutMs；
   * 装配处传 settings.drawTimeoutMs 覆盖，见文件头）。
   */
  resumeWindowMs?: number;
  /** 硬上限（默认 2 × maxJobs）：超过它无条件淘汰最旧，保护窗不放弃有界性。 */
  hardMaxJobs?: number;
}

/** 作业表。 */
export interface DrawJobs {
  create(input: { taskId: string; model: string; prompt: string; now?: number }): DrawJob;
  get(jobId: string): DrawJob | null;
  notePolls(jobId: string, polls: number): void;
  drop(jobId: string): void;
  dispose(): void;
  size(): number;
}

/**
 * 建一张出图作业表。
 * @param {DrawJobsOptions} [options] - 容量与保护窗参数。
 * @returns {DrawJobs} 作业表。
 */
export function createDrawJobs(options: DrawJobsOptions = {}): DrawJobs {
  const maxJobs = Math.max(1, Math.floor(options.maxJobs ?? 64));
  const resumeWindowMs = Math.max(1, Math.floor(options.resumeWindowMs ?? 900_000));
  const hardMaxJobs = Math.max(maxJobs, Math.floor(options.hardMaxJobs ?? maxJobs * 2));
  /** @type {Map<string, DrawJob>} 插入顺序即淘汰顺序（Map 保序）。 */
  const jobs = new Map<string, DrawJob>();

  /**
   * 超容时的两级淘汰（判据见文件头「生命周期」）：
   *   软上限只淘汰已过续查保护窗的（越过总放弃线，续查只换来「超过总预算」）；
   *   硬上限保底——全是保护窗内的作业也绝不无界。
   * @param {number} now - 当前墙钟毫秒（`create` 的 `now` 缝传进来，测试可造旧作业）。
   */
  const evictIfNeeded = (now: number): void => {
    if (jobs.size <= maxJobs) return;
    for (const [id, job] of jobs) {
      if (jobs.size <= maxJobs) return;
      if (now - job.submittedAt >= resumeWindowMs) jobs.delete(id);
    }
    while (jobs.size > hardMaxJobs) {
      const oldest = jobs.keys().next();
      if (oldest.done === true) return;
      jobs.delete(oldest.value);
    }
  };

  return {
    create({ taskId, model, prompt, now }) {
      const jobId = taskId;
      const at = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
      const job: DrawJob = {
        jobId,
        taskId,
        model,
        prompt,
        submittedAt: at,
        polls: 0
      };
      // 同一个 taskId 重复登记（理论上不会：taskId 由上游现发）→ 以新代旧，
      // 但保留累计轮询数，避免「重建作业」把诊断计数清零。
      const previous = jobs.get(jobId);
      if (previous !== undefined) job.polls = previous.polls;
      jobs.set(jobId, job);
      evictIfNeeded(at);
      return { ...job };
    },
    get(jobId) {
      const found = jobs.get(jobId);
      return found === undefined ? null : { ...found };
    },
    notePolls(jobId, polls) {
      const found = jobs.get(jobId);
      if (found === undefined) return;
      found.polls += Math.max(0, Math.floor(polls));
    },
    drop(jobId) {
      jobs.delete(jobId);
    },
    dispose() {
      jobs.clear();
    },
    size() {
      return jobs.size;
    }
  };
}
