/**
 * 出图工具的挂载副作用：读开关 → 解析目录 → 注册 agent 工具；开关翻转时**现挂现卸**。
 *
 * 与 `provider-publish.ts` 的分工：那个管「魔搭作为 chat provider 的注册」，本文件
 * 管「给 agent 一个出图工具」。两者是**独立的开关**——回答的是不同问题，合并没有
 * 好处（用户可能想用工具出图但不想把魔搭塞进模型选择器，反之亦然）。
 *
 * 承重契约：peer 的 tools.register 返回 disposer（`() => void` 注销句柄，见
 * `@deepseek-ai/dsh-tools` 的 `ToolsService.register`）。所以
 *  - 开关翻转可以在**本次 Host 生命周期内**生效：`sync()` 读一次开关，要开就注册、
 *    要关就调 disposer 摘掉，不需要等下次启动；
 *  - 句柄必须**存住**：丢掉它 = 插件卸载后注册残留（僵尸工具），而 registry 对重名
 *    insert 会抛错，下一次挂载直接失败（错误文本形如 `tool "<name>" is already
 *    registered`）。旧版把返回的 `unknown` 直接丢弃，正是这条缺口的来源；
 *  - 目录变化**不需要**重注册：工具在**调用时**才读目录（`getEntries` 是个函数），
 *    所以一次目录刷新会自然被下一次出图看到。
 *
 * 并发：`sync()` 串行排队（`chain`），每次执行时**现读**开关，所以快速连点开关
 * 最终收敛到最后一次保存的值；重复 sync 幂等（已注册就跳过——真去重复注册会撞
 * registry 的重名保护，把它当正常分支会把「开关开着」误报成缺席）。
 *
 * 失败一律降级为「工具缺席」，绝不炸掉插件：tools 服务缺失、peer 加载失败、registry
 * 拒收——三种都由 `draw-tool-state.ts` 记下原因供面板显示。另有一种**非缺席**的
 * 降级：registry 收下了却**没返回 disposer**（旧 Host / 旧 peer）。工具能用但关不
 * 掉，记 `not-removable` 让面板说实话——否则用户关掉开关、面板显示「已关闭」而
 * 工具还在。
 *
 * 本文件不吞错误（那会让「工具为什么不在」无从诊断），只把它们翻译成可展示的原因码。
 *
 * peer-dependent：`@deepseek-ai/dsh-tools` 由 `deps.loadToolsModule` 惰性注入。
 *
 * **测试覆盖**：`test/draw-register.test.mjs`（2026-10-17 补上，此前这里是零引用）
 * 用 `deps.loadToolsModule` 这条现成的缝注入伪 `defineTool`，让真装配链原样跑起来
 * ——**不需要** peer-stub-loader。教训是：本文件此前把「peer-dependent」直接读成
 * 「测不了」，而缝早就留好了；同处境的 `llm-adapter.ts` / `draw-runtime.ts` 用
 * `test/helpers/peer-stub-loader.mjs` 证明过另一条路（那条 loader 是给**没有缝**
 * 的直连 import 用的）。`tools/dev/mutate-spec.json` 里有本文件的一组变异，用来
 * 保证那套测试真的会红——第一版测试里 `mount` 助手自己清了缺席原因，于是「过期
 * 原因会不会被清掉」那条断言是测试自己满足的，是变异测试把它抓出来的。
 *
 * @module dsh-connect-modelscope-token-plan/draw-register
 */
import { defineDrawTool } from "./draw-runtime.ts";
import { setDrawToolNote, setDrawToolMounted, drawToolMounted } from "./draw-tool-state.ts";
import { resolveSwitchEnabled, resolveSwitchValue } from "./switch-precedence.ts";
import { errMsg, redactSecrets } from "./util.ts";
import { name } from "./host-config.ts";

/**
 * tools 服务的最小形状。
 *
 * 返回类型是**注销句柄**（Cordis effect 的 disposer）。类型上必须写出来：写成
 * `void` 会让接线层把返回值直接丢掉，而丢掉它正是「工具注册不可撤销」那个假前提
 * 的来源。
 */
type ToolsService = { register?: (definition: unknown) => (() => void) | void };

/**
 * 出图工具的挂载控制器。
 *
 * 一个实例 = 一次插件挂载。路由与挂载共用**同一个**实例，所以「注册」与「注销」
 * 不会各持一份状态（那会重复注册或摘错句柄）。
 */
export interface DrawToolMount {
  /**
   * 按当前开关值收敛一次（幂等、串行）。
   * @returns {Promise<void>} 本次收敛完成（失败也 resolve，原因记在 draw-tool-state）。
   */
  sync(): Promise<void>;
  /**
   * 卸载：摘掉已注册的工具并停止后续 sync（幂等）。
   * @returns {void}
   */
  dispose(): void;
  /**
   * 当前是否已挂载（读 draw-tool-state 的注册位）。
   * @returns {boolean} true = 工具此刻在 registry 里。
   */
  mounted(): boolean;
}

/**
 * 解析一个可选服务，允许它稍后才注册。
 *
 * 承 sensenova 同名函数的纪律：**重试的是读，不是写**。这里只做有限次立即读取，
 * 不做长退避（服务要么已注册，要么这次就没有）。
 * @param {object} ctx - Host 上下文。
 * @param {string} service - 服务名。
 * @param {() => boolean} isDisposed - 卸载闸。
 * @returns {Promise<object|null>} 服务实例或 `null`。
 */
async function resolveService(ctx: { get?: (key: string) => unknown }, service: string, isDisposed: () => boolean): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (isDisposed()) return null;
    const found = ctx.get?.(service);
    if (found !== null && found !== undefined) return found;
    // 三次之间给一个极短的让位窗口：模块加载顺序不保证本插件晚于 tools 注册。
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/**
 * 建一个出图工具挂载控制器（不产生副作用，`sync()` 才读开关/注册）。
 * @param {object} ctx - Host 上下文。
 * @param {object} wiring - `{ settings, configError, tokenStore, inference, drawStore, publisher, logger }`。
 * @param {object} deps - 测试缝（`loadToolsModule`、`drawFetch`、`pollIntervalMs`）。
 * @returns {DrawToolMount} 控制器。
 */
export function createDrawToolMount(
  ctx: { get?: (key: string) => unknown; logger?: { warn?: (message: string) => void } },
  wiring: any,
  deps: any = {}
): DrawToolMount {
  const { settings, configError, tokenStore, inference, drawStore, publisher, logger } = wiring;
  const loggerFor = logger ?? ctx.logger;

  /** 当前已注册工具的注销句柄；`null` = 没挂上（或已摘掉）。 */
  let disposeTool: (() => void) | null = null;
  /** peer 的 `defineTool` 只解析一次：成功后就缓存，失败留到下次 sync 重试。 */
  let defineTool: ((definition: object) => unknown) | null = null;
  /** 卸载闸：`dispose()` 之后任何在途/后续 sync 都不再注册。 */
  let closed = false;
  /** 串行链：保证「读开关 → 挂/卸」不会被两次 sync 交错执行。 */
  let chain: Promise<void> = Promise.resolve();

  const isDisposed = () => closed || publisher?.isDisposed?.() === true;

  /**
   * 摘掉已注册的工具（幂等）。
   *
   * 先清注册位再调 disposer：即使 disposer 抛了，面板也不该继续显示「已注册」。
   * @returns {void}
   */
  function unmount(): void {
    const dispose = disposeTool;
    disposeTool = null;
    setDrawToolMounted(false);
    if (dispose !== null) {
      try {
        dispose();
      } catch (error) {
        loggerFor?.warn?.(`${name}: draw tool dispose failed (${redactSecrets(errMsg(error))})`);
      }
    }
    // 关掉之后「为什么缺席」不再成立：缺席原因只对「要开却没开成」有意义。
    setDrawToolNote(null);
  }

  /**
   * 解析 peer 的 `defineTool`（成功后缓存）。
   * @returns {Promise<Function|null>} `defineTool` 或 `null`（失败已记原因）。
   */
  async function loadDefineTool(): Promise<((definition: object) => unknown) | null> {
    if (defineTool !== null) return defineTool;
    try {
      const mod = (await Promise.resolve(
        deps.loadToolsModule ? deps.loadToolsModule() : import("@deepseek-ai/dsh-tools")
      )) as { defineTool?: (definition: object) => unknown; default?: { defineTool?: (definition: object) => unknown } };
      const found = mod?.defineTool ?? mod?.default?.defineTool ?? null;
      if (typeof found === "function") {
        defineTool = found;
        return found;
      }
      // 加载成功却不带 defineTool = 同一个 Host 问题（peer 版本不对）。
    } catch (error) {
      loggerFor?.warn?.(
        `${name}: draw tool peer module failed to load (${redactSecrets(errMsg(error))}) — the tool is absent`
      );
    }
    return null;
  }

  /**
   * 一次收敛：读开关，要开就注册、要关就注销。
   * @returns {Promise<void>}
   */
  async function apply(): Promise<void> {
    if (closed) return;
    try {
      if (configError !== null) return;

      // 开关优先级由唯一裁决者决定（`switch-precedence.ts`），不手抄 `?? settings.x`
      // 方言。工具没有「来源」可报（不像面板快照要说明哪一侧说了算），所以只取生效值。
      const panelValue = drawStore ? await drawStore.enabled().catch(() => null) : null;
      const effective = resolveSwitchEnabled(panelValue, settings.drawEnabled === true);

      if (effective !== true) {
        // 开关关掉 = 当场摘掉。这就是旧版做不到、只能等下次启动的那一步。
        unmount();
        return;
      }

      if (disposeTool !== null) {
        // 已经挂着：幂等返回。这里**不能**再 register 一次——registry 对重名 insert
        // 会抛错，而一次正常轮询/重复 POST 不该把工具打成「缺席」。
        setDrawToolNote(null);
        setDrawToolMounted(true);
        return;
      }

      const tools = (await resolveService(ctx, "tools", isDisposed)) as ToolsService | null;
      if (tools === null || typeof tools.register !== "function") {
        // 唯一「正常」的缺席：开关开了但这个 Host 没有 tools 服务。不是 bug，但必须
        // 让面板说清楚，否则用户只看到开关开着、工具却不在。
        setDrawToolNote("no-tools-service");
        setDrawToolMounted(false);
        return;
      }

      const found = await loadDefineTool();
      if (found === null) {
        setDrawToolNote("peer-load-failed");
        setDrawToolMounted(false);
        return;
      }

      const drawFetch =
        deps.drawFetch ?? ((url: string, options: object) => fetch(url, options) as unknown as Promise<any>);

      const dispose = tools.register(
        defineDrawTool({
          defineTool: found,
          fetchImpl: drawFetch,
          resolveApiKey: async () => (await tokenStore.resolve()).value,
          // 目录在**调用时**读：一次刷新自动生效，且不依赖 provider 开关——「能把魔搭
          // 当 chat provider」与「能列出魔搭的出图模型」是两件事，用 provider 的允许
          // 清单筛出图候选会把用户裁剪 picker 的动作错误地波及出图工具。
          getEntries: async () => {
            const fetched = await inference.fetchModels().catch(() => null);
            return fetched?.entries ?? [];
          },
          // 首选模型：面板保存值赢、否则配置 drawModelId——与 routes/draw.ts 的
          // effectiveModelId 同一份裁决（resolveSwitchValue），面板显示什么、工具
          // 就挑什么，不会说两套话。每次调用现读，面板改完下次出图即生效。
          getPreferredModelId: async () => {
            const panelValue = drawStore ? await drawStore.modelId().catch(() => null) : null;
            return resolveSwitchValue(panelValue, settings.drawModelId === "" ? undefined : settings.drawModelId) ?? null;
          },
          settings: {
            apiBase: settings.apiBase,
            drawModelId: settings.drawModelId,
            // 两个预算各归各位：总放弃线 vs 单次调用愿意等的时间（两段式）。
            drawTimeoutMs: settings.drawTimeoutMs,
            drawWaitMs: settings.drawWaitMs
          },
          // 作业表由 wiring 提供（index.ts 建、index.ts 的卸载清理销毁）。条件展开：
          // 测试的 `wiringFor()` 不带这张表，缺省由 `defineDrawTool` 现建一张，
          // 于是那条「注入作业表」的现成缝仍然照旧可用。
          ...(wiring.drawJobs !== undefined ? { jobs: wiring.drawJobs } : {}),
          // 轮询间隔同样是装配缝（`defineDrawTool` 的注释写着「离线测试要把它压到
          // 毫秒级」）：默认 15s 会让本套件的每个 execute 至少睡一次 15s。
          ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
          isDisposed
        })
      );

      // registry 收下了。返回值就是注销句柄：存住它，开关关掉时才有东西可摘。
      if (typeof dispose === "function") {
        disposeTool = dispose;
        // 走到这里 = 注册成功。置位必须放在 register 返回之后：抛了就是拒收，由下面
        // 的 catch 处理，不能谎报成功。清掉上一次尝试留下的过期原因（迟到的 tools
        // 服务最终到位时，面板上那句「缺席」必须消失）。
        setDrawToolNote(null);
        setDrawToolMounted(true);
      } else {
        // 旧 Host / 旧 peer：收下了定义却不给注销句柄。工具能用，但**关不掉**——
        // 面板必须说实话，否则用户关掉开关、面板显示「已关闭」而工具还在。
        disposeTool = null;
        setDrawToolNote("not-removable");
        setDrawToolMounted(true);
        loggerFor?.warn?.(
          `${name}: draw tool registered without a disposer — turning the switch off cannot unmount it on this host`
        );
      }
    } catch (error) {
      // registry 拒收与上面两种同性质：工具缺席、面板完好，且是 Host 问题不是配置问题。
      setDrawToolNote("registry-refused");
      setDrawToolMounted(false);
      loggerFor?.warn?.(
        `${name}: draw tool registration refused (${redactSecrets(errMsg(error))}) — the tool is absent`
      );
    }
  }

  return {
    sync(): Promise<void> {
      chain = chain.then(apply).catch((error) => {
        loggerFor?.warn?.(`${name}: draw tool sync failed (${redactSecrets(errMsg(error))})`);
      });
      return chain;
    },
    dispose(): void {
      closed = true;
      unmount();
    },
    mounted(): boolean {
      return drawToolMounted();
    }
  };
}
