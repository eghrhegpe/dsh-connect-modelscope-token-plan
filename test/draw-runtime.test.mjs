// 出图**运行时**的可测半边（`src/host/draw-runtime.ts`）。
//
// 该模块整体是 peer-dependent 的（`defineTool` 由 Host 注入），但它的核心——
// `runDrawOnce` 的两段式流程、轮询循环、终态判定、失败分诊——**全部可以通过注入
// 的 fetch 完整测到**。不需要真 Host、不需要网络、不需要工具注册服务。
//
// 这套件因此是 docs/ROADMAP.md 那条「peer 契约零覆盖」缺口的一个**部分**解法：
// 它钉住本插件自己的异步状态机。仍未覆盖的是 peer 真正的 `defineTool` 形状与
// tools registry 的注册结果（那需要 vendored 假 peer 或真 Host e2e）。
//
// 最重要的两个用例是「假失败」与「提交态不可信」——两者都曾导致真实误判：
//   · 缺 X-ModelScope-Task-Type → 上游回 task not found + FAILED，任务其实正常；
//   · 提交响应恒为 SUCCEED → 连最终 FAILED 的 FLUX 那次提交也报 SUCCEED。

import { strict as assert } from "node:assert";
import { DRAW_WAIT_BUDGET_MS } from "../src/host/draw.ts";
import {
  DRAW_TOOL_NAME,
  buildGenerationsEndpoint,
  buildTasksEndpoint,
  pickDrawModel,
  drawModelIds,
  splitImageUrls,
  runDrawOnce,
  submitDrawTask,
  awaitDrawTask,
  defineDrawTool
} from "../src/host/draw-runtime.ts";
import { createDrawJobs } from "../src/host/draw-jobs.ts";

const checks = [];
function section(name, body) {
  checks.push([name, body]);
}

/** 造一个假的 fetch 响应。 */
function res(status, body, ok = status >= 200 && status < 300) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    async text() {
      return text;
    },
    async json() {
      return typeof body === "string" ? JSON.parse(body) : body;
    }
  };
}

/** 造一个按脚本应答的假 fetch，并记录收到的请求。 */
function scriptedFetch(steps) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, headers: options?.headers ?? {}, body: options?.body });
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if (typeof step === "function") return step(url, options);
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchImpl, calls };
}

/** 极短的轮询间隔，让测试跑得快（真实值是 15s）。 */
const FAST = { pollIntervalMs: 1, pollDeadlineMs: 5_000 };
const BASE = { apiBase: "https://api-inference.modelscope.cn/v1", apiKey: "ms-test-key", model: "Qwen/Qwen-Image-Edit", prompt: "a cat" };

// ── endpoint 拼接 ─────────────────────────────────────────────────────────────
section("buildGenerationsEndpoint 处理各种 base 形态", () => {
  assert.equal(buildGenerationsEndpoint("https://x/v1"), "https://x/v1/images/generations");
  assert.equal(buildGenerationsEndpoint("https://x/v1/"), "https://x/v1/images/generations");
  assert.equal(buildGenerationsEndpoint("https://x/v1/images/generations"), "https://x/v1/images/generations");
  assert.equal(buildGenerationsEndpoint("https://x/v1/other"), "https://x/v1/images/generations", "更深的路径回卷到 /v1");
  assert.equal(buildGenerationsEndpoint("https://x"), "https://x/v1/images/generations");
});

section("buildTasksEndpoint 从 generations 端点回卷", () => {
  assert.equal(buildTasksEndpoint("https://x/v1", "abc"), "https://x/v1/tasks/abc");
  assert.equal(buildTasksEndpoint("https://x/v1/images/generations", "abc"), "https://x/v1/tasks/abc");
  assert.equal(buildTasksEndpoint("https://x/v1", "a/b"), "https://x/v1/tasks/a%2Fb", "id 进 path 要转义");
});

// ── 选模型 ────────────────────────────────────────────────────────────────────
section("pickDrawModel 显式请求优先，即使不在目录里", () => {
  const entries = [{ id: "Qwen/Qwen-Image-Edit", tasks: ["image-to-image"] }];
  assert.equal(pickDrawModel(entries, "custom/model"), "custom/model", "手工覆盖应放行，上游会自己报错");
});

section("pickDrawModel 默认挑「已知能纯文生图」的模型，而不是目录第一个（回归）", () => {
  // 真实目录顺序（2026-10-16 实名拉取 /v1/models，36 条）：MusePublic 在 Qwen 之前。
  // 而 MusePublic/Qwen-Image-Edit 纯文生图被上游拒绝（image_url is required）——
  // 照旧「取目录第一个」的逻辑，纯文生图必挂。回归钉住：默认偏向 KNOWN_T2I_MODEL_ID。
  const entries = [
    { id: "some/chat-model", tasks: ["text-generation"] },
    { id: "MusePublic/Qwen-Image-Edit", tasks: ["image-to-image"] },
    { id: "Qwen/Qwen-Image-Edit", tasks: ["image-to-image"] }
  ];
  assert.equal(pickDrawModel(entries), "Qwen/Qwen-Image-Edit");
  assert.deepEqual(drawModelIds(entries), ["MusePublic/Qwen-Image-Edit", "Qwen/Qwen-Image-Edit"]);
});

section("pickDrawModel 首选模型（面板/配置）压过默认，目录外 id 也放行", () => {
  const entries = [
    { id: "MusePublic/Qwen-Image-Edit", tasks: ["image-to-image"] },
    { id: "Qwen/Qwen-Image-Edit", tasks: ["image-to-image"] }
  ];
  assert.equal(pickDrawModel(entries, undefined, "MusePublic/Qwen-Image-Edit"), "MusePublic/Qwen-Image-Edit", "用户点了谁就用谁，上游会自己报错");
  assert.equal(pickDrawModel(entries, undefined, "off-catalog/m"), "off-catalog/m", "首选模型不在目录里也放行（用户可能先配好、等模型上线）");
  assert.equal(pickDrawModel(entries, "requested/x", "preferred/y"), "requested/x", "工具显式请求压过首选配置");
  assert.equal(pickDrawModel(entries, undefined, ""), "Qwen/Qwen-Image-Edit", "空白首选 = 没配，回到默认偏向");
});

section("pickDrawModel 平台声明 text-to-image 的条目优先于 image-to-image（向前兼容）", () => {
  const entries = [
    { id: "MusePublic/Qwen-Image-Edit", tasks: ["image-to-image"] },
    { id: "q/real-t2i", tasks: ["text-to-image-synthesis"] },
    { id: "Qwen/Qwen-Image-Edit", tasks: ["image-to-image"] }
  ];
  assert.equal(pickDrawModel(entries), "q/real-t2i", "将来目录补上真文生图模型时自动优先生效");
});

section("pickDrawModel 已知能纯文生图的模型不在目录时，退回目录第一个", () => {
  const entries = [
    { id: "MusePublic/Qwen-Image-Edit", tasks: ["image-to-image"] },
    { id: "other/Edit", tasks: ["image-to-image"] }
  ];
  assert.equal(pickDrawModel(entries), "MusePublic/Qwen-Image-Edit", "没有更好的信息只能给第一个");
});

section("pickDrawModel 目录里没有出图模型时返回 null（不发注定失败的请求）", () => {
  assert.equal(pickDrawModel([{ id: "a/b", tasks: ["text-generation"] }]), null);
  assert.equal(pickDrawModel([]), null);
  assert.equal(pickDrawModel(null), null);
});

section("目录里 unknown 能力的条目不进候选（宁可漏，不肯猜）", () => {
  const entries = [{ id: "mystery/model" }];
  assert.deepEqual(drawModelIds(entries), [], "无信号 = 不猜");
});

// ── 输入图拆分 ────────────────────────────────────────────────────────────────
section("splitImageUrls 按换行拆多图（官方多图编辑）", () => {
  assert.deepEqual(splitImageUrls("https://a/1.png\nhttps://a/2.png"), ["https://a/1.png", "https://a/2.png"]);
  assert.deepEqual(splitImageUrls("https://a/1.png\r\nhttps://a/2.png"), ["https://a/1.png", "https://a/2.png"]);
  assert.deepEqual(splitImageUrls("  https://a/1.png  \n\n "), ["https://a/1.png"], "空行剔除、逐项 trim");
  assert.deepEqual(splitImageUrls(["a", "b"]), ["a", "b"], "也容忍直接给数组");
  assert.deepEqual(splitImageUrls(""), []);
  assert.deepEqual(splitImageUrls(undefined), []);
});

// ── 成功路径 ──────────────────────────────────────────────────────────────────
section("runDrawOnce 提交 → 轮询 → 拿到图片", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    res(200, { task_id: "t1", task_status: "SUCCEED" }),
    res(200, { task_status: "RUNNING", output_images: [] }),
    res(200, { task_status: "SUCCEED", output_images: ["https://oss/a.png"] })
  ]);
  const out = await runDrawOnce({ fetchImpl, ...BASE, ...FAST });
  assert.equal(out.taskId, "t1");
  assert.deepEqual(out.images, ["https://oss/a.png"]);
  assert.equal(out.polls, 2, "第一次 RUNNING，第二次终端");
  assert.equal(calls.length, 3);
});

section("提交带 Async-Mode 头，轮询带必需的 Task-Type 头", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(200, { task_status: "SUCCEED", output_images: ["u"] })
  ]);
  await runDrawOnce({ fetchImpl, ...BASE, ...FAST });
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].headers["X-ModelScope-Async-Mode"], "true");
  assert.match(calls[0].headers.Authorization, /^Bearer /);
  assert.equal(calls[1].options.method, "GET");
  assert.equal(calls[1].headers["X-ModelScope-Task-Type"], "image_generation", "缺这个头 = 假失败");
});

section("请求体发 image_url 数组（多图编辑）", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(200, { task_status: "SUCCEED", output_images: ["u"] })
  ]);
  await runDrawOnce({ fetchImpl, ...BASE, ...FAST, imageUrl: ["https://a/1.png", "https://a/2.png"] });
  const sent = JSON.parse(calls[0].body);
  assert.deepEqual(sent.image_url, ["https://a/1.png", "https://a/2.png"]);
});

section("成功结果保持上游返回的全部图片", async () => {
  const { fetchImpl } = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(200, { task_status: "SUCCEED", output_images: ["u1", "u2"] })
  ]);
  const out = await runDrawOnce({ fetchImpl, ...BASE, ...FAST });
  assert.deepEqual(out.images, ["u1", "u2"]);
});

// ── 提交态不可信 ──────────────────────────────────────────────────────────────
section("提交响应的 task_status 一律忽略，只认 task_id", async () => {
  // 实测形状：提交恒回 SUCCEED，连最终 FAILED 的那次也是。
  const { fetchImpl } = scriptedFetch([
    res(200, { task_status: "SUCCEED", task_id: "t1" }),
    res(200, { task_status: "FAILED", errors: { code: 0, message: "" } })
  ]);
  await assert.rejects(
    () => runDrawOnce({ fetchImpl, ...BASE, ...FAST }),
    /FAILED/,
    "提交说 SUCCEED 也不算成功——终态说了才算"
  );
});

section("提交没给 task_id 就是提交失败（不拿 task_status 兜底）", async () => {
  const { fetchImpl, calls } = scriptedFetch([res(200, { task_status: "SUCCEED" })]);
  await assert.rejects(() => runDrawOnce({ fetchImpl, ...BASE, ...FAST }), /没有 task_id/);
  assert.equal(calls.length, 1, "没 id 就不该去轮询");
});

// ── 失败路径 ──────────────────────────────────────────────────────────────────
section("任务 FAILED 时抛错，且承认原因不可知", async () => {
  const { fetchImpl } = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(200, { task_status: "FAILED", errors: { code: 0, message: "" } })
  ]);
  await assert.rejects(() => runDrawOnce({ fetchImpl, ...BASE, ...FAST }), /未给出失败原因/);
});

section("SUCCEED 但图片为空 → 报错而不是报一张不存在的图", async () => {
  const { fetchImpl } = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(200, { task_status: "SUCCEED", output_images: [] })
  ]);
  await assert.rejects(() => runDrawOnce({ fetchImpl, ...BASE, ...FAST }), /没有可用图片/);
});

section("提交阶段 401/403 走账号态分诊", async () => {
  const { fetchImpl } = scriptedFetch([res(401, "unauthorized")]);
  await assert.rejects(() => runDrawOnce({ fetchImpl, ...BASE, ...FAST }), /令牌无效/);
  const second = scriptedFetch([res(403, '{"errors":{"message":"please complete your profile via email verification"}}')]);
  await assert.rejects(() => runDrawOnce({ fetchImpl: second.fetchImpl, ...BASE, ...FAST }), /邮箱验证/);
});

section("轮询阶段 HTTP 错误带出状态码分诊", async () => {
  const { fetchImpl } = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(503, "upstream down")
  ]);
  await assert.rejects(() => runDrawOnce({ fetchImpl, ...BASE, ...FAST }), /上游服务异常/);
});

section("未知状态继续等，不误判失败", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(200, { task_status: "SOMETHING_NEW" }),
    res(200, { task_status: "SUCCEED", output_images: ["u"] })
  ]);
  const out = await runDrawOnce({ fetchImpl, ...BASE, ...FAST });
  assert.deepEqual(out.images, ["u"]);
  assert.equal(calls.length, 3, "未知状态应继续轮询到真终态");
});

section("传输层抖动不升级为终局，继续轮询", async () => {
  const { fetchImpl } = scriptedFetch([
    res(200, { task_id: "t1" }),
    new Error("ECONNRESET"),
    res(200, { task_status: "SUCCEED", output_images: ["u"] })
  ]);
  const out = await runDrawOnce({ fetchImpl, ...BASE, ...FAST });
  assert.deepEqual(out.images, ["u"]);
});

section("非 JSON 响应体也继续等（不因一次解析失败判死）", async () => {
  const { fetchImpl } = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(200, "<html>CDN error</html>"),
    res(200, { task_status: "SUCCEED", output_images: ["u"] })
  ]);
  const out = await runDrawOnce({ fetchImpl, ...BASE, ...FAST });
  assert.deepEqual(out.images, ["u"]);
});

section("超过截止时间抛超时，并报告轮询次数", async () => {
  const { fetchImpl } = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(200, { task_status: "RUNNING" })
  ]);
  await assert.rejects(
    () => runDrawOnce({ fetchImpl, ...BASE, pollDeadlineMs: 12, pollIntervalMs: 5 }),
    /超过截止时间/
  );
});

section("超时文案必须说清「任务可能仍在生成」，不能让人以为出图失败", async () => {
  // 实测：一次 900s 超时放弃时任务仍活着，同期另一任务 859s 成功。
  const { fetchImpl } = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(200, { task_status: "RUNNING" })
  ]);
  const err = await runDrawOnce({ fetchImpl, ...BASE, pollDeadlineMs: 12, pollIntervalMs: 5 }).then(
    () => null,
    (e) => e
  );
  assert.ok(err !== null, "应当抛错");
  assert.match(err.message, /可能仍在生成/, "必须点明超时 ≠ 任务死亡");
  assert.match(err.message, /task|任务/, "应带上 task_id 便于排查");
});

// ── 两段式原语 ────────────────────────────────────────────────────────────────
// 这两个函数是「一次调用不再阻塞整轮对话」的承重：提交与等待能分开，工具才可能
// 在 waitMs 处返回 pending 而不是 await 到底。
section("submitDrawTask 只认 task_id，忽略提交响应的 task_status", async () => {
  const { fetchImpl } = scriptedFetch([res(200, { task_id: "t1", task_status: "SUCCEED" })]);
  const out = await submitDrawTask({ fetchImpl, ...BASE });
  assert.deepEqual(out, { taskId: "t1" });
});

section("submitDrawTask 提交失败直接抛，不带 task_id 就不该有第二段", async () => {
  const { fetchImpl, calls } = scriptedFetch([res(401, '{"message":"nope"}')]);
  await assert.rejects(() => submitDrawTask({ fetchImpl, ...BASE }), /令牌无效/);
  assert.equal(calls.length, 1);
});

section("awaitDrawTask 三种结局：done / failed / pending", async () => {
  const done = await awaitDrawTask({
    ...BASE,
    taskId: "t1",
    fetchImpl: scriptedFetch([res(200, { task_status: "RUNNING" }), res(200, { task_status: "SUCCEED", output_images: ["u"] })]).fetchImpl,
    waitMs: 5_000,
    pollIntervalMs: 1
  });
  assert.equal(done.kind, "done");
  assert.deepEqual(done.images, ["u"]);

  const failed = await awaitDrawTask({
    ...BASE,
    taskId: "t1",
    fetchImpl: scriptedFetch([res(200, { task_status: "FAILED", errors: { code: 0, message: "" } })]).fetchImpl,
    waitMs: 5_000,
    pollIntervalMs: 1
  });
  assert.equal(failed.kind, "failed");
  assert.match(failed.message, /未给出失败原因/, "失败文案沿用纯逻辑层的诚实边界");

  // 预算耗尽 = pending，**不是失败**：这是两段式能成立的那一句话。
  const pending = await awaitDrawTask({
    ...BASE,
    taskId: "t1",
    fetchImpl: scriptedFetch([res(200, { task_status: "RUNNING" })]).fetchImpl,
    waitMs: 3,
    pollIntervalMs: 1
  });
  assert.equal(pending.kind, "pending", "预算耗尽必须返回 pending，不能抛错");
  assert.ok(pending.polls >= 1, "pending 也要报轮询次数（诊断用）");
});

section("abort 立即中断轮询中的 sleep（不必等满间隔）", async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = scriptedFetch([res(200, { task_status: "RUNNING" })]);
  const started = Date.now();
  setTimeout(() => controller.abort(), 20);
  const out = await awaitDrawTask({
    ...BASE,
    taskId: "t1",
    fetchImpl,
    // 间隔远大于 abort 时刻：没有 abort 支持时这里要等 30s 才会走到预算检查。
    waitMs: 60_000,
    pollIntervalMs: 30_000,
    signal: controller.signal
  });
  const elapsed = Date.now() - started;
  assert.equal(out.kind, "pending", "abort 是「还没好」，不是失败");
  assert.ok(elapsed < 5_000, `abort 必须立即生效（实测 ${elapsed}ms，间隔 30s）`);
  assert.equal(calls.length, 0, "sleep 被中断，第一轮轮询都没发出");
});

// ── 两段式工具：一次调用不再阻塞整轮对话 ──────────────────────────────────────
/** 装配一个工具（捕获 peer 的 defineTool 入参，直接调它的 execute）。 */
function makeTool({ steps, settings = {}, jobs, getEntries, cooldown }) {
  const { fetchImpl, calls } = scriptedFetch(steps);
  let def = null;
  defineDrawTool({
    defineTool: (d) => { def = d; return d; },
    fetchImpl,
    resolveApiKey: async () => "ms-test-key",
    getEntries: getEntries ?? (async () => [{ id: "Qwen/Qwen-Image-Edit", tasks: ["image-to-image"] }]),
    settings: {
      apiBase: BASE.apiBase,
      drawModelId: "",
      drawTimeoutMs: 900_000,
      drawWaitMs: 5,
      ...settings
    },
    ...(jobs !== undefined ? { jobs } : {}),
    ...(cooldown !== undefined ? { cooldown } : {}),
    pollIntervalMs: 1
  });
  return { def, calls };
}

section("第一段：等不到终态就返回 pending + jobId，不把整轮对话堵在 await 上", async () => {
  const { def, calls } = makeTool({
    steps: [res(200, { task_id: "t1" }), res(200, { task_status: "RUNNING" })]
  });
  const out = await def.execute({ prompt: "a cat" });
  assert.equal(out.status, "pending");
  assert.equal(out.jobId, "t1", "jobId 就是上游 task_id——可直接与上游日志对上");
  assert.equal(out.url, "", "还没出图就不该给 URL");
  assert.match(out.hint, /仍在生成中/);
  assert.match(out.hint, /jobId t1/, "必须把续查的把手写在明面上");
  // 一次调用只发「一次提交 + 若干次轮询」，且轮询都在极短预算内结束了。
  assert.equal(calls[0].options.method, "POST");
  assert.ok(calls.length < 60, `等待预算必须被遵守（实测 ${calls.length} 次请求）`);
});

section("第二段：带 jobId 只查询，不重复提交（续查不产生新任务）", async () => {
  const jobs = createDrawJobs();
  jobs.create({ taskId: "t1", model: "Qwen/Qwen-Image-Edit", prompt: "a cat" });
  const { def, calls } = makeTool({
    jobs,
    // 预算要够跑两轮（RUNNING → SUCCEED），否则这一遍会以 pending 收场。
    settings: { drawWaitMs: 300 },
    steps: [res(200, { task_status: "RUNNING" }), res(200, { task_status: "SUCCEED", output_images: ["https://oss/a.png"] })]
  });
  const out = await def.execute({ jobId: "t1" });
  assert.equal(out.status, "done", "续查等到终态就直接给图");
  assert.deepEqual([out.url, out.prompt], ["https://oss/a.png", "a cat"]);
  assert.ok(
    calls.every((c) => c.options.method === "GET"),
    `续查不得再发提交（实测方法：${calls.map((c) => c.options.method).join(",")}）`
  );
});

section("pending 不进冷却：续查这条路不能被上一次「还没好」堵死", async () => {
  const jobs = createDrawJobs();
  const cooldown = { fail: () => { throw new Error("pending 不该进冷却"); }, remainingMs: () => 0, clear: () => {} };
  const { def } = makeTool({
    jobs,
    cooldown,
    steps: [res(200, { task_id: "t1" }), res(200, { task_status: "RUNNING" })]
  });
  const out = await def.execute({ prompt: "a cat" });
  assert.equal(out.status, "pending", "pending 若进冷却，这里会抛而不是返回");
});

section("真失败才进冷却（上游 FAILED）", async () => {
  let failed = 0;
  const cooldown = { fail: () => { failed += 1; }, remainingMs: () => 0, clear: () => {} };
  const { def } = makeTool({
    cooldown,
    steps: [res(200, { task_id: "t1" }), res(200, { task_status: "FAILED", errors: { code: 0, message: "" } })]
  });
  await assert.rejects(() => def.execute({ prompt: "a cat" }), /未给出失败原因/);
  assert.equal(failed, 1, "真失败必须记一次冷却");
});

section("jobId 不在作业表里 → 可操作错误，且不冒充出图失败", async () => {
  const { def } = makeTool({ steps: [] });
  await assert.rejects(
    () => def.execute({ jobId: "not-a-job" }),
    /不在本次会话的作业表里/,
    "插件重启后作业表是空的，必须说清而不是报个莫名的上游错误"
  );
});

section("越过总放弃线才放弃，且仍说清「任务可能仍在生成」", async () => {
  const jobs = createDrawJobs();
  // 手工塞一条「16 分钟前提交的」作业：总放弃线是从提交算起跨调用累计的，
  // 默认总预算 15 分钟，所以它已经越线（不必真的等 15 分钟来测这条）。
  jobs.create({ taskId: "t-old", model: "Qwen/Qwen-Image-Edit", prompt: "a cat", now: Date.now() - 960_000 });
  const { def } = makeTool({ jobs, steps: [res(200, { task_status: "RUNNING" })] });
  const err = await def.execute({ jobId: "t-old" }).then(() => null, (e) => e);
  assert.ok(err !== null, "越过总放弃线应当抛错（放弃这张图）");
  assert.match(err.message, /超过总预算/);
  assert.match(err.message, /可能仍在生成/, "放弃 ≠ 任务死亡，这条仍然要说清");
});

section("工具硬护栏按 waitMs 设，不再是 15 分钟的总放弃线", async () => {
  const { def } = makeTool({ steps: [res(200, { task_id: "t1" })] });
  assert.ok(
    def.timeoutMs < 60_000,
    `一次调用最多只能占住 waitMs 量级（实测 ${def.timeoutMs}ms）；等于总放弃线 = 又把 agent 卡回 15 分钟`
  );
  assert.ok(DRAW_WAIT_BUDGET_MS >= 60_000, "默认等待预算应能一次拿完实测最快那一档（61s）");
});

// ── 工具定义 ──────────────────────────────────────────────────────────────────
section("工具名带插件前缀，不与 dsh-draw-router 撞名", () => {
  assert.equal(DRAW_TOOL_NAME, "modelscope_draw_image");
});

section("两段式的参数与输出契约：jobId 进参、status/jobId 出参", async () => {
  const { def } = makeTool({ steps: [res(200, { task_id: "t1" })] });
  assert.equal(def.parameters.jobId?.type, "string", "jobId 必须是显式参数，agent 才知道怎么续查");
  assert.match(def.parameters.prompt.description, /jobId/, "prompt 在续查时被忽略，说明里要写");
  assert.deepEqual(Object.keys(def.output.schema.properties).sort(), ["hint", "jobId", "model", "prompt", "source", "status", "url"]);
  assert.match(def.description, /TWO-PHASE|pending/, "工具描述必须说清是两段式");
});

// ── 跑 ────────────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, body] of checks) {
  try {
    await body();
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`  NOT OK - ${name}`);
    console.error(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed > 0) {
  console.error(`draw-runtime.test.mjs: ${failed} 组断言失败`);
  process.exit(1);
}
console.log(`draw-runtime.test.mjs 全部通过（${checks.length} 组）`);
