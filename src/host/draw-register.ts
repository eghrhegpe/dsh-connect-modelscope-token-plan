/**
 * 出图工具的挂载副作用：读开关 → 解析目录 → 注册 agent 工具。
 *
 * 与 `provider-publish.ts` 的分工：那个管「魔搭作为 chat provider 的注册」，本文件
 * 管「给 agent 一个出图工具」。两者是**独立的开关**——回答的是不同问题，合并没有
 * 好处（用户可能想用工具出图但不想把魔搭塞进模型选择器，反之亦然）。
 *
 * 承重约束：**peer 的 tools registry 没有 unregister**。所以
 *  - 注册只在挂载时尝试**一次**，不在任何轮询/路由里重复调用；
 *  - 开关在挂载后翻转，要到下次 Host 启动才生效（面板文案必须说这句，否则用户
 *    会以为开关坏了）；
 *  - 目录变化**不需要**重注册：工具在**调用时**才读目录（`getEntries` 是个函数），
 *    所以一次目录刷新会自然被下一次出图看到。
 *
 * 失败一律降级为「工具缺席」，绝不炸掉插件：tools 服务缺失、peer 加载失败、
 * registry 拒收——三种都由 `draw-tool-state.ts` 记下原因供面板显示。本文件不吞
 * 错误（那会让「工具为什么不在」无从诊断），只把它们翻译成可展示的原因码。
 *
 * peer-dependent：`@deepseek-ai/dsh-tools` 由 `deps.loadToolsModule` 惰性注入。
 *
 * **本文件目前没有测试覆盖**——`registerDrawTool` 在 `test/` 里零引用
 * （docs/ROADMAP.md Backlog 记着这条缺口）。但**这不是「不能」**：同一处境的
 * `llm-adapter.ts` / `draw-runtime.ts` 已经用 `test/helpers/peer-stub-loader.mjs`
 * 证明这类模块能在离线套件里原样加载执行。此前的措辞把 `llm-adapter.ts` 当作
 * 「同样无法导入」的例证拉来作证，那条类比在补上那个 loader 之后已经失效。
 *
 * @module dsh-connect-modelscope-token-plan/draw-register
 */
import { defineDrawTool } from "./draw-runtime.ts";
import { setDrawToolNote } from "./draw-tool-state.ts";
import { resolveSwitchEnabled, resolveSwitchValue } from "./switch-precedence.ts";
import { errMsg, redactSecrets } from "./util.ts";
import { name } from "./host-config.ts";

/** tools 服务的最小形状。 */
type ToolsService = { register?: (definition: unknown) => void };

/**
 * 解析一个可选服务，允许它稍后才注册。
 *
 * 承 sensenova 同名函数的纪律：**重试的是读，不是注册**——工具不能注销，重复注册
 * 比缺席更糟。这里只做有限次立即读取，不做长退避（服务要么已注册，要么这次挂载
 * 就没有）。
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
 * 读一次开关，决定是否注册出图工具。
 * @param {object} ctx - Host 上下文。
 * @param {object} wiring - `{ settings, configError, tokenStore, inference, providerStore, publisher, logger }`。
 * @param {object} deps - 测试缝（`loadToolsModule`、`drawFetch`）。
 * @returns {Promise<void>}
 */
export async function registerDrawTool(
  ctx: { get?: (key: string) => unknown; logger?: { warn?: (message: string) => void } },
  wiring: any,
  deps: any = {}
): Promise<void> {
  const { settings, configError, tokenStore, inference, drawStore, publisher, logger } = wiring;
  const loggerFor = logger ?? ctx.logger;

  // 每次尝试都重算缺席原因：一个迟到的 tools 服务最终注册时，必须**清掉**面板上
  // 那句过期的「缺席」，而不是让它挂着。
  setDrawToolNote(null);

  try {
    if (configError !== null) return;

    // 开关优先级由唯一裁决者决定（`switch-precedence.ts`），不手抄 `?? settings.x`
    // 方言。工具没有「来源」可报（不像面板快照要说明哪一侧说了算），所以只取生效值。
    const panelValue = drawStore ? await drawStore.enabled().catch(() => null) : null;
    const effective = resolveSwitchEnabled(panelValue, settings.drawEnabled === true);
    if (effective !== true) return;

    const isDisposed = () => publisher?.isDisposed?.() === true;

    const tools = (await resolveService(ctx, "tools", isDisposed)) as ToolsService | null;
    if (tools === null || typeof tools.register !== "function") {
      // 唯一「正常」的缺席：开关开了但这个 Host 没有 tools 服务。不是 bug，但必须
      // 让面板说清楚，否则用户只看到开关开着、工具却不在。
      setDrawToolNote("no-tools-service");
      return;
    }

    // 目录只用来「挑默认模型」，所以这里不阻塞注册：工具在调用时才读（见 getEntries），
    // 一次目录刷新会被下一次出图自然看到，不需要重注册。
    let defineTool: ((definition: object) => unknown) | null = null;
    try {
      const mod = (await Promise.resolve(
        deps.loadToolsModule ? deps.loadToolsModule() : import("@deepseek-ai/dsh-tools")
      )) as { defineTool?: (definition: object) => unknown; default?: { defineTool?: (definition: object) => unknown } };
      defineTool = mod?.defineTool ?? mod?.default?.defineTool ?? null;
    } catch (error) {
      setDrawToolNote("peer-load-failed");
      loggerFor?.warn?.(
        `${name}: draw tool peer module failed to load (${redactSecrets(errMsg(error))}) — the tool is absent`
      );
      return;
    }
    if (typeof defineTool !== "function") {
      // 加载成功却不带 defineTool = 同一个 Host 问题（peer 版本不对）。
      setDrawToolNote("peer-load-failed");
      return;
    }

    const drawFetch =
      deps.drawFetch ?? ((url: string, options: object) => fetch(url, options) as unknown as Promise<any>);

    tools.register(
      defineDrawTool({
        defineTool,
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
          drawTimeoutMs: settings.drawTimeoutMs
        },
        isDisposed
      })
    );
  } catch (error) {
    // registry 拒收与上面两种同性质：工具缺席、面板完好，且是 Host 问题不是配置问题。
    setDrawToolNote("registry-refused");
    loggerFor?.warn?.(
      `${name}: draw tool registration refused (${redactSecrets(errMsg(error))}) — the tool is absent`
    );
  }
}
