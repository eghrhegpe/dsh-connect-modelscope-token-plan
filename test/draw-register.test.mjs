// draw-register.test.mjs —— 出图工具装配层的**第一条**测试。
//
// 补的是一条被文件头自己承认的缺口：`draw-register.ts` 的头注释写着「本文件目前
// 没有测试覆盖——`registerDrawTool` 在 test/ 里零引用」，并把 `llm-adapter.ts` 的
// peer-stub-loader 当作「这类模块离线可测」的例证。那条例证成立，但它其实**过谦**
// 了：本文件根本不需要 loader——`registerDrawTool` 早就留了 `deps.loadToolsModule`
// 这条缝（`deps.loadToolsModule ? … : import("@deepseek-ai/dsh-tools")`），伪一个
// `{ defineTool }` 即可让真装配链原样跑起来。所以这里不用 module hooks，只注入。
//
// 钉住的都是**承重纪律**，不是实现细节：
//   · 开关裁决（面板赢配置，两个方向）；
//   · 目录/偏好必须**调用时现读**（文件头承诺的「目录变化不需要重注册」全靠这条）；
//   · 缺席原因三态各归各位，且只有 Host 侧缺陷才 warn；
//   · 迟到的 tools 服务最终注册时必须**清掉**过期的缺席原因（否则面板一直挂着谎）。

import { strict as assert } from "node:assert";
import { registerDrawTool } from "../src/host/draw-register.ts";
import { drawToolNote, setDrawToolNote } from "../src/host/draw-tool-state.ts";
import { DRAW_TOOL_NAME } from "../src/host/draw-runtime.ts";
import { DRAW_TIMEOUT_MS, DRAW_WAIT_BUDGET_MS } from "../src/host/draw.ts";
import { createDrawJobs } from "../src/host/draw-jobs.ts";
import { CONFIG_DEFAULTS, name } from "../src/host/host-config.ts";

const IMAGE_ENTRY = { id: "Qwen/Qwen-Image-Edit", tasks: ["image-to-image"] };

/** 记录式 tools 服务：只记注册了什么，不模拟 peer 行为。 */
function toolsService(sink) {
  return {
    register(definition) {
      sink.push(definition);
    }
  };
}

/**
 * 离线默认：任何没被显式装桩的出图请求都拒绝。
 *
 * 这不是洁癖，是本套件第一版踩到的坑：`registerDrawTool` 的 `deps.drawFetch` 缺省
 * 是**真的全局 fetch**，于是「isDisposed 为真时 execute 必须拒绝」那节写错了前置
 * 条件（传的是未卸载的 publisher），execute 就一路走到提交，对本机网络打了一次
 * 真实请求并拿回上游 401——测试仍然「通过」到下一行才因为断言不符而失败。离线
 * 门禁里混进真网络请求，是比断言写错更值得修的问题：它让套件依赖网络、把别人的
 * 401 当成自己的红灯。`routes.test.mjs` 用同一个立场（NO_NETWORK 默认断网）。
 */
const NO_NETWORK = () => Promise.reject(new Error("no network in this test"));

/** 一次装配所需的全部缝；每节只覆盖它关心的那几个字段。 */
function wiringFor(overrides = {}) {
  return {
    settings: {
      apiBase: "https://api-inference.modelscope.cn/v1",
      drawEnabled: false,
      drawModelId: "",
      drawTimeoutMs: CONFIG_DEFAULTS.drawTimeoutMs,
      drawWaitMs: CONFIG_DEFAULTS.drawWaitMs
    },
    configError: null,
    tokenStore: { resolve: async () => ({ value: "ms-test-token", source: "memory" }) },
    inference: { fetchModels: async () => ({ entries: [IMAGE_ENTRY], ids: [IMAGE_ENTRY.id] }) },
    drawStore: { enabled: async () => null, modelId: async () => null },
    publisher: { isDisposed: () => false },
    logger: { warn: () => {} },
    ...overrides
  };
}

/**
 * 开关**开着**的 wiring。
 *
 * 需要它是因为 `registerDrawTool` 的第一道闸就是开关：开关没开时后面所有分支都走
 * 不到，缺席原因也一律不记（那时工具「不缺席」，只是「没被要」）。下面每一节想验
 * 的东西都在闸门之后，所以必须先过闸——第一版这里漏了，于是「没有 tools 服务」
 * 那节读到的是 `null`。
 */
function onWiring(overrides = {}) {
  const base = wiringFor(overrides);
  return { ...base, settings: { ...base.settings, drawEnabled: true } };
}

/**
 * 跑一次装配；返回注册到的工具定义与 warn 列表。
 *
 * `keepNote` 是**必要的**：本助手默认先清一次缺席原因，好让每节从一个干净基线
 * 出发；但 §4 要验的恰恰是「被测代码自己会不会清掉过期原因」。第一版这里无条件
 * 清空，于是那条断言由**测试自己**满足——把 `draw-register.ts` 里那行
 * `setDrawToolNote(null)` 删掉，测试照样全绿。这是本仓库自己的变异测试
 * （`tools/dev/mutate-spec.json`）抓出来的，不是靠眼睛看出来的：
 * 「缺席原因不再清空」那个变异第一轮是 STILL-GREEN。
 */
async function mount({ wiring = wiringFor(), tools = toolsService, deps = {}, getService, keepNote = false } = {}) {
  const warnings = [];
  const registered = [];
  const sink = tools === null ? null : tools(registered);
  const ctx = {
    get: (key) => {
      if (key !== "tools") return undefined;
      return typeof getService === "function" ? getService(sink) : sink;
    },
    logger: { warn: (message) => warnings.push(message) }
  };
  const effectiveWiring = { ...wiring, logger: { warn: (message) => warnings.push(message) } };
  if (!keepNote) setDrawToolNote(null);
  await registerDrawTool(ctx, effectiveWiring, {
    loadToolsModule: async () => ({ defineTool: (definition) => definition }),
    // 默认断网（见 NO_NETWORK 的注释）；要验提交形状的节自己装桩。
    drawFetch: NO_NETWORK,
    ...deps
  });
  return { registered, warnings };
}

// ── §1 开关裁决：面板保存值赢配置，两个方向都要成立 ──
{
  const offByDefault = await mount();
  assert.equal(offByDefault.registered.length, 0, "配置默认 false + 面板没存过 → 不注册");
  assert.equal(drawToolNote(), null, "开关没开不是「缺席」，不该记原因");
}
{
  const onByConfig = await mount({
    wiring: onWiring()
  });
  assert.equal(onByConfig.registered.length, 1, "配置默认 true 且面板没存过 → 注册");
  assert.equal(drawToolNote(), null, "注册成功不该留下任何缺席原因");
}
{
  const panelOnConfigOff = await mount({
    wiring: wiringFor({ drawStore: { enabled: async () => true, modelId: async () => null } })
  });
  assert.equal(panelOnConfigOff.registered.length, 1, "面板 true 必须压过配置 false");
}
{
  // 反方向是这条裁决真正咬人的地方：用户关掉了工具，不能因为配置默认是 true 就复活。
  const panelOffConfigOn = await mount({
    wiring: onWiring({ drawStore: { enabled: async () => false, modelId: async () => null } })
  });
  assert.equal(panelOffConfigOn.registered.length, 0, "面板 false 必须压过配置 true（关掉的工具不得复活）");
}
{
  // 面板 store 读失败 → 回退配置默认（不能因为一次读失败就把工具吞掉）。
  const storeThrows = await mount({
    wiring: onWiring({
      drawStore: { enabled: async () => { throw new Error("state unreadable"); }, modelId: async () => null }
    })
  });
  assert.equal(storeThrows.registered.length, 1, "面板开关读不到 → 回退配置默认值，不是「关」");
}

// ── §2 注册出去的定义形状：名字、必需参数、硬护栏 ──
{
  const { registered } = await mount({
    wiring: onWiring()
  });
  const definition = registered[0];
  assert.equal(definition.name, DRAW_TOOL_NAME, "工具名是协议面，不能改");
  assert.equal(definition.parameters.prompt.required, true, "prompt 必需");
  assert.equal("jobId" in definition.parameters, true, "两段式的续查把手必须出现在参数表里（否则 agent 看不见这条路）");
  // 硬护栏 = 单次等待 + 余量，**不是**总放弃线：回到总放弃线等于一次调用又把整轮
  // 对话卡满（draw-runtime.test.mjs 已有一条同名变异守着，这里守的是装配层真的
  // 把 drawWaitMs 传下去了）。
  assert.equal(
    definition.timeoutMs,
    CONFIG_DEFAULTS.drawWaitMs + 10_000,
    "工具硬护栏必须绑单次等待预算，不是总放弃线"
  );
  assert.ok(
    definition.timeoutMs < CONFIG_DEFAULTS.drawTimeoutMs,
    "硬护栏必须明显小于总放弃线（否则「一次调用不堵整轮对话」不成立）"
  );
  assert.notEqual(DRAW_WAIT_BUDGET_MS, DRAW_TIMEOUT_MS, "两个预算常量本身不能又合并回去");
}

// ── §3 三种缺席原因各归各位，且只有 Host 侧缺陷才 warn ──
{
  const noTools = await mount({ tools: null, wiring: onWiring() });
  assert.equal(noTools.registered.length, 0);
  assert.equal(drawToolNote(), "no-tools-service", "没有 tools 服务 → 记可展示的原因");
  assert.equal(noTools.warnings.length, 0, "Host 本来就没提供该服务，不是故障，不该 warn");
}
{
  const peerBoom = await mount({
    wiring: onWiring(),
    deps: { loadToolsModule: async () => { throw new Error("peer exploded"); } }
  });
  assert.equal(peerBoom.registered.length, 0);
  assert.equal(drawToolNote(), "peer-load-failed");
  assert.equal(peerBoom.warnings.length, 1, "peer 加载失败是 Host 侧缺陷，必须 warn（不能只在面板上说）");
  assert.ok(peerBoom.warnings[0].includes(name), "日志要带插件名，否则用户翻日志找不到是谁");
}
{
  // 加载成功却不带 defineTool —— 同一个「Host 问题」的另一副面孔（peer 版本不对）。
  const noDefine = await mount({ wiring: onWiring(), deps: { loadToolsModule: async () => ({}) } });
  assert.equal(noDefine.registered.length, 0);
  assert.equal(drawToolNote(), "peer-load-failed", "加载成功但缺 defineTool 同样是 peer-load-failed");
}
{
  const refused = await mount({
    wiring: onWiring(),
    tools: () => ({ register() { throw new Error("registry said no"); } })
  });
  assert.equal(drawToolNote(), "registry-refused");
  assert.equal(refused.warnings.length, 1, "registry 拒收是 Host 侧缺陷，必须 warn");
}
{
  const badConfig = await mount({ wiring: wiringFor({ configError: "apiBase is not a URL" }) });
  assert.equal(badConfig.registered.length, 0, "配置坏 → 不注册（原因由 configError 呈现）");
  assert.equal(badConfig.warnings.length, 0, "配置错误不是装配失败，不该在这里 warn");
}

// ── §4 迟到的 tools 服务：过期缺席原因必须被清掉 ──
{
  // 第一次挂载 tools 还没注册（面板于是说「没有 tools 服务」），第二次它到了。
  // 第二次刻意 `keepNote`：那句过期的原因必须由**被测代码**清掉，测试不能替它清
  // ——否则这条断言是测试自己满足的（见 mount 的注释）。
  let arrived = false;
  const late = await mount({ wiring: onWiring(), getService: (sink) => (arrived ? sink : undefined) });
  assert.equal(late.registered.length, 0);
  assert.equal(drawToolNote(), "no-tools-service");
  arrived = true;
  const again = await mount({
    wiring: onWiring(),
    getService: (sink) => (arrived ? sink : undefined),
    keepNote: true
  });
  assert.equal(again.registered.length, 1, "服务迟到之后第二次挂载必须注册成功");
  assert.equal(drawToolNote(), null, "注册成功后，面板上那句过期的「缺席」必须被清掉而不是继续挂着");
}

// ── §5 目录与偏好必须**调用时现读**（这正是「目录变化不需要重注册」的全部依据）──
//
// 这条纪律无法从返回的定义上断言——`getEntries` / `getPreferredModelId` 都在
// `defineDrawTool` 的闭包里，不在定义对象上。所以这里**驱动 execute**：用一个
// 提交即失败的 drawFetch 把调用停在提交那一步，然后看目录/偏好是**什么时候**被读的。
// 注册时一次都不能读（那一刻目录可能还没轮询过），调用时必须各读一次。
{
  let entriesReads = 0;
  let preferredReads = 0;
  const calls = [];
  const { registered } = await mount({
    wiring: onWiring({
      settings: { ...onWiring().settings, drawModelId: "config/model" },
      drawStore: { enabled: async () => null, modelId: async () => { preferredReads += 1; return "panel/model"; } },
      inference: {
        fetchModels: async () => { entriesReads += 1; return { entries: [IMAGE_ENTRY], ids: [IMAGE_ENTRY.id] }; }
      }
    }),
    deps: {
      loadToolsModule: async () => ({ defineTool: (definition) => definition }),
      drawFetch: (url, options) => {
        calls.push({ url, options });
        return Promise.resolve({ ok: false, status: 500, text: async () => "upstream boom", json: async () => ({}) });
      }
    }
  });

  assert.equal(entriesReads, 0, "注册时不得读目录（那一刻目录可能还没轮询过）");
  assert.equal(preferredReads, 0, "注册时不得读偏好");

  let error = null;
  try {
    await registered[0].execute({ prompt: "a cat" });
  } catch (e) {
    error = e;
  }
  assert.ok(error !== null, "提交 500 时 execute 必须失败（不是静默成功）");
  assert.equal(entriesReads, 1, "调用时必须现读目录一次");
  assert.equal(preferredReads, 1, "调用时必须现读偏好一次");
  assert.equal(calls.length, 1, "提交失败即终止，不该继续轮询");
  assert.equal(
    calls[0].url,
    "https://api-inference.modelscope.cn/v1/images/generations",
    "出图端点由 apiBase 派生（/v1 → /v1/images/generations）"
  );
  assert.equal(
    JSON.parse(calls[0].options.body).model,
    "panel/model",
    "面板偏好必须一路走到请求体里——这正是「面板显示什么、工具就挑什么」的证据"
  );
  assert.equal(
    calls[0].options.headers["X-ModelScope-Async-Mode"],
    "true",
    "提交必须带异步模式头（否则上游按同步语义处理，两段式塌掉）"
  );
}
{
  // 偏好两侧都没有 → 回退「目录里第一个出图模型」。
  const calls = [];
  const { registered } = await mount({
    wiring: onWiring(),
    deps: {
      loadToolsModule: async () => ({ defineTool: (definition) => definition }),
      drawFetch: (url, options) => {
        calls.push({ url, options });
        return Promise.resolve({ ok: false, status: 500, text: async () => "", json: async () => ({}) });
      }
    }
  });
  await registered[0].execute({ prompt: "a cat" }).catch(() => {});
  assert.equal(JSON.parse(calls[0].options.body).model, IMAGE_ENTRY.id, "无偏好 → 用目录里第一个出图模型");
}
{
  // 偏好读失败 → 回退配置的 drawModelId（与开关同一个回退纪律），不是「无偏好」。
  const calls = [];
  const { registered } = await mount({
    wiring: onWiring({
      settings: { ...onWiring().settings, drawModelId: "config/model" },
      drawStore: { enabled: async () => null, modelId: async () => { throw new Error("boom"); } }
    }),
    deps: {
      loadToolsModule: async () => ({ defineTool: (definition) => definition }),
      drawFetch: (url, options) => {
        calls.push({ url, options });
        return Promise.resolve({ ok: false, status: 500, text: async () => "", json: async () => ({}) });
      }
    }
  });
  await registered[0].execute({ prompt: "a cat" }).catch(() => {});
  assert.equal(JSON.parse(calls[0].options.body).model, "config/model", "偏好读失败 → 回退配置默认");
}
{
  // 目录读失败 + 无偏好 → 给出可操作的报错，而不是拿空目录去撞上游。
  const { registered } = await mount({
    wiring: onWiring({ inference: { fetchModels: async () => { throw new Error("catalog down"); } } }),
    deps: { loadToolsModule: async () => ({ defineTool: (definition) => definition }) }
  });
  await assert.rejects(
    () => registered[0].execute({ prompt: "a cat" }),
    /目录里没有出图模型/,
    "目录读失败 + 无偏好 → 明确说「没有出图模型」（令牌/轮询两条排查路径都在文案里）"
  );
}

// ── §6 装配缝真的接到了工具上（execute 的闸，离线可验） ──
{
  // 挂载时就已经卸载（teardown 与挂载竞态）→ 连注册都不发生。
  //
  // 注意这里的**原因码**：卸载闸让 `resolveService` 立刻返回 null，于是记下的是
  // `no-tools-service`，而真因是「Host 已卸载」。这不算 bug、不值得为它加一个原因
  // 码：已卸载的 Host 没有面板，没人读得到这句话。如实钉住现状，免得后人以为
  // 「no-tools-service 只可能是没服务」。
  const calls = [];
  const { registered } = await mount({
    wiring: onWiring({ publisher: { isDisposed: () => true } }),
    deps: {
      loadToolsModule: async () => ({ defineTool: (definition) => definition }),
      drawFetch: (url, options) => {
        calls.push({ url, options });
        return Promise.resolve({ ok: false, status: 500, text: async () => "", json: async () => ({}) });
      }
    }
  });
  assert.equal(registered.length, 0, "已卸载的 Host 不该再注册工具");
  assert.equal(calls.length, 0, "更不该发上游请求");
}
{
  // 卸载闸必须是**每次调用现读**，不是挂载时捕获的快照（否则卸载后工具还能用）。
  let disposed = false;
  const calls = [];
  const { registered } = await mount({
    wiring: onWiring({ publisher: { isDisposed: () => disposed } }),
    deps: {
      loadToolsModule: async () => ({ defineTool: (definition) => definition }),
      drawFetch: (url, options) => {
        calls.push({ url, options });
        return Promise.resolve({ ok: false, status: 500, text: async () => "", json: async () => ({}) });
      }
    }
  });
  assert.equal(registered.length, 1, "挂载时未卸载 → 正常注册");
  disposed = true;
  await assert.rejects(
    () => registered[0].execute({ prompt: "a cat" }),
    /no longer mounted/,
    "publisher 在挂载之后才说已卸载 → 工具必须同步失效（闸是现读的）"
  );
  assert.equal(calls.length, 0, "卸载后不得再发上游请求");
}
{
  const calls = [];
  const { registered } = await mount({
    wiring: onWiring({ tokenStore: { resolve: async () => ({ value: "", source: null }) } }),
    deps: {
      loadToolsModule: async () => ({ defineTool: (definition) => definition }),
      drawFetch: (url, options) => {
        calls.push({ url, options });
        return Promise.resolve({ ok: false, status: 500, text: async () => "", json: async () => ({}) });
      }
    }
  });
  await assert.rejects(
    () => registered[0].execute({ prompt: "a cat" }),
    /未配置/,
    "没有令牌时要给出可操作的报错（面板/环境变量两条路），而不是打到上游换一个 401"
  );
  assert.equal(calls.length, 0, "没令牌就不该发请求（401 的排查成本比本地报错高得多）");
}
{
  // prompt 缺失：在提交之前就该拒（不必浪费一次上游请求去换一个 FAILED）。
  const calls = [];
  const { registered } = await mount({
    wiring: onWiring(),
    deps: {
      loadToolsModule: async () => ({ defineTool: (definition) => definition }),
      drawFetch: (url, options) => {
        calls.push({ url, options });
        return Promise.resolve({ ok: false, status: 500, text: async () => "", json: async () => ({}) });
      }
    }
  });
  await assert.rejects(() => registered[0].execute({}), /prompt is required/, "prompt 是必需参数，缺了要当场拒");
  assert.equal(calls.length, 0, "缺 prompt 不发请求");
}

{
  // 作业表由 wiring 提供（`index.ts` 建、`index.ts` 的卸载清理销毁）。缺这条线的话
  // `DrawJobs.dispose()` 一个调用方都没有（2026-10-19 锐评实锤，经过档案见
  // docs/archive/2026-10-19-0.6.3-process.md §七 作业表 2）。这里钉住**工具用的
  // 就是接线那张表**：提交后 pending 的记录留在表里，续查也读同一张（否则用户手里
  // 的 jobId 在新装配里查不到）。
  const jobs = createDrawJobs();
  const calls = [];
  const { registered } = await mount({
    wiring: onWiring({ drawJobs: jobs, settings: { ...onWiring().settings, drawWaitMs: 5 } }),
    deps: {
      // 默认 15s 的间隔会让每个 execute 至少睡一次 15s——这条缝就是为此存在的。
      pollIntervalMs: 1,
      drawFetch: (url, options) => {
        calls.push({ url, options });
        if (options.method === "POST") {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: async () => '{"task_id":"t-wired"}',
            json: async () => ({ task_id: "t-wired" })
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => '{"task_status":"RUNNING"}',
          json: async () => ({ task_status: "RUNNING" })
        });
      }
    }
  });
  const out = await registered[0].execute({ prompt: "a cat" });
  assert.equal(out.status, "pending", "等不到终态就该 pending（这一节只借它验作业表接线）");
  assert.ok(jobs.get("t-wired") !== null, "工具必须写进 wiring 上那张表：index.ts 才销毁得到");
  const resumed = await registered[0].execute({ jobId: "t-wired" });
  assert.equal(resumed.status, "pending", "续查读的也是同一张表（两张表就会「jobId 查不到」）");
  assert.ok(calls.length >= 2, "续查只发 GET 轮询，不重新提交");
}

console.log("draw-register.test.mjs: all checks passed");
