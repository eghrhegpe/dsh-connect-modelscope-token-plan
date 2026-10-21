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
import { DRAW_TIMEOUT_MAX_MS } from "../src/host/host-config.ts";
import { drawCandidates, resolveDrawModelChoice } from "../src/host/llm-models.ts";

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

section("选择理由（面板「当前使用」显示的来源）：id 与 source 一一对应", () => {
  // 面板必须能说清「用哪个、为什么」——只报 id 不报理由，用户看到两个
  // Qwen-Image-Edit 无从判断哪个在生效。
  const t2i = [
    { id: "Qwen/Qwen-Image-Edit", tasks: ["image-to-image"] },
    { id: "q/real-t2i", tasks: ["text-to-image-synthesis"] }
  ];
  assert.deepEqual(resolveDrawModelChoice(t2i), { id: "q/real-t2i", source: "declared-text-to-image" });

  const both = [
    { id: "MusePublic/Qwen-Image-Edit", tasks: ["image-to-image"] },
    { id: "Qwen/Qwen-Image-Edit", tasks: ["image-to-image"] }
  ];
  assert.deepEqual(resolveDrawModelChoice(both), { id: "Qwen/Qwen-Image-Edit", source: "known-text-to-image" });

  // 已知可纯文生图的 id 不在目录时：第一个候选，理由如实说是「目录第一个」。
  const noKnown = [{ id: "other/Edit", tasks: ["image-to-image"] }];
  assert.deepEqual(resolveDrawModelChoice(noKnown), { id: "other/Edit", source: "catalog-first" });

  // 指定（面板/配置）压过一切；工具显式请求同样记作 preferred。
  assert.deepEqual(resolveDrawModelChoice(both, undefined, "MusePublic/Qwen-Image-Edit"), { id: "MusePublic/Qwen-Image-Edit", source: "preferred" });
  assert.deepEqual(resolveDrawModelChoice(both, "req/x", "pref/y"), { id: "req/x", source: "preferred" });
  // 空目录：id 与理由都是 null（面板渲染「没有候选」，不编一个选中值）。
  assert.deepEqual(resolveDrawModelChoice([]), { id: null, source: null });
});

section("候选明细：能力档 + 纯文生图标记（Qwen 可纯文生图，MusePublic 需要输入图）", () => {
  const entries = [
    { id: "some/chat", tasks: ["text-generation"] },
    { id: "MusePublic/Qwen-Image-Edit", tasks: ["image-to-image"] },
    { id: "Qwen/Qwen-Image-Edit", tasks: ["image-to-image"] },
    { id: "q/t2i", tasks: ["text-to-image-synthesis"] }
  ];
  assert.deepEqual(drawCandidates(entries), [
    { id: "MusePublic/Qwen-Image-Edit", capability: "image-to-image", textToImage: false },
    { id: "Qwen/Qwen-Image-Edit", capability: "image-to-image", textToImage: true },
    { id: "q/t2i", capability: "text-to-image", textToImage: true }
  ], "平台声明的能力档 + 已知可纯文生图的实测标记");
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

section("被拒的 imageUrl 回显必须先脱敏（凭据永不入消息）", async () => {
  // 被拒的 URL 仍可能带签名查询串（`?token=…`）或别的键值对。原样回显就会把它
  // 带进日志与面板——红线 1（凭据永不入日志）要防的正是这一条，而这一处曾是没
  // 过脱敏闸的唯一一个错误面（docs/PROVIDER-M4.md 的红线「redactSecrets 过所有
  // 日志/错误/响应体」）。
  const { def, calls } = makeTool({ steps: [res(200, { task_id: "t1" })] });
  await assert.rejects(
    () => def.execute({ prompt: "a cat", imageUrl: "ftp://files.example/pic.png?token=sk-abcdef1234567890" }),
    (error) => {
      assert.doesNotMatch(error.message, /abcdef1234567890/, "凭据不许出现在错误消息里");
      assert.match(error.message, /\[REDACTED\]/, "脱敏后的样子要留在消息里，诊断才有料");
      return true;
    },
    "被拒的 URL 必须先过脱敏闸再回显"
  );
  assert.equal(calls.length, 0, "输入图不合格就不该提交");
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

section("轮询阶段 4xx 错误带出状态码分诊（终局：等下去也不会变）", async () => {
  const { fetchImpl } = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(400, "bad id")
  ]);
  await assert.rejects(() => runDrawOnce({ fetchImpl, ...BASE, ...FAST }), /轮询请求失败/);
  const unauthorized = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(401, "unauthorized")
  ]);
  await assert.rejects(() => runDrawOnce({ fetchImpl: unauthorized.fetchImpl, ...BASE, ...FAST }), /令牌无效/);
});

section("轮询 5xx/429 是瞬态不判死刑：同一个抖动不因表现为 503 就被杀掉", async () => {
  // 2026-10-19 评审落地：传输层抛错（ECONNRESET）本来就「继续等」，而同一种
  // CDN 边缘抖动以 5xx **响应**出现时，旧写法直接判作业死刑 + 进冷却——同一个
  // 物理故障两种判法不成立（判据见 draw-runtime.ts 的 isTransientPollStatus）。
  const { fetchImpl } = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(503, "upstream down"),
    res(429, "slow down"),
    res(200, { task_status: "SUCCEED", output_images: ["u"] })
  ]);
  const out = await runDrawOnce({ fetchImpl, ...BASE, ...FAST });
  assert.deepEqual(out.images, ["u"], "瞬态之后还要继续等，不能把作业杀掉");
});

section("全程瞬态不会永远转：耗尽等待预算后按 pending 收场（续查把手不丢）", async () => {
  // scriptedFetch 把最后一步无限重复 → 整个预算都在 502 里度过。
  const { fetchImpl } = scriptedFetch([res(200, { task_id: "t1" }), res(502, "bad gateway")]);
  const awaited = await awaitDrawTask({
    ...BASE,
    taskId: "t1",
    fetchImpl,
    waitMs: 300,
    pollIntervalMs: 1
  });
  assert.equal(awaited.kind, "pending", "瞬态持续 = 还没好，不是失败");
  assert.ok(awaited.polls >= 2, `预算内应轮询多轮（实测 ${awaited.polls} 轮）`);
});

section("非 2xx（4xx）的轮询不拿上一轮读数当终态证据（截止时间可能根本没到）", async () => {
  // 旧写法把 `lastStatus`（上一轮的 RUNNING）塞进 taskStatus，于是 400 会被报成
  // 「任务停在 RUNNING（非终态），已超过截止时间」——这里的 waitMs 才 5s，第一轮
  // 轮询刚回来就报「超过截止时间」是凭空的因果。
  const { fetchImpl } = scriptedFetch([
    res(200, { task_id: "t1" }),
    res(200, { task_status: "RUNNING" }),
    res(400, '{"errors":{"message":"invalid task id"}}')
  ]);
  const err = await runDrawOnce({ fetchImpl, ...BASE, ...FAST }).then(() => null, (e) => e);
  assert.ok(err !== null, "非 2xx 轮询要报错，不能静默继续等");
  assert.match(err.message, /轮询请求失败/, "要说清是「本轮没读到」，而不是「任务卡住了」");
  assert.match(err.message, /400/, "状态码必须带出来");
  assert.match(err.message, /上一轮读到 RUNNING/, "上一轮读数只作为上下文出现");
  assert.doesNotMatch(err.message, /已超过截止时间/, "截止时间没到就不能这么说");
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

section("abort 也取消在途的轮询请求，不只在 sleep 里", async () => {
  const controller = new AbortController();
  const calls = [];
  // 慢档上游：请求发出去就不回。只有拿到 signal 才可能被取消。
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return await new Promise((_, reject) => {
      // 兜底：万一 signal 没传进来（回归），2s 后自己失败，测试红在断言上而不是挂死。
      const fallback = setTimeout(() => reject(new Error("stub: 上游没回")), 2_000);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(fallback);
          reject(new Error("aborted"));
        },
        { once: true }
      );
    });
  };
  const started = Date.now();
  setTimeout(() => controller.abort(), 20);
  const out = await awaitDrawTask({
    ...BASE,
    taskId: "t1",
    fetchImpl,
    waitMs: 60_000,
    pollIntervalMs: 1,
    signal: controller.signal
  });
  const elapsed = Date.now() - started;
  assert.equal(
    calls[0].options.signal,
    controller.signal,
    "轮询请求必须带上 signal，否则在途请求取消不了（修过：docs/archive/2026-10-19-0.6.3-process.md §七 表行 1）"
  );
  assert.equal(out.kind, "pending", "abort 是「还没好」，不是失败");
  assert.ok(elapsed < 1_500, `abort 必须中断在途请求（实测 ${elapsed}ms）`);
});

// ── 两段式工具：一次调用不再阻塞整轮对话 ──────────────────────────────────────
/** 装配一个工具（捕获 peer 的 defineTool 入参，直接调它的 execute）。 */
function makeTool({ steps, settings = {}, jobs, getEntries, cooldown, isDisposed }) {
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
    ...(isDisposed !== undefined ? { isDisposed } : {}),
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

section("工具层：全程瞬态 5xx 也返回 pending + jobId——边缘抖动不是出图失败", async () => {
  // 与「pending 不进冷却」同族：agent 视角下这张图「还没好」，重新提交才是错解。
  const jobs = createDrawJobs();
  const { def } = makeTool({
    jobs,
    settings: { drawWaitMs: 300 },
    steps: [res(200, { task_id: "t-flaky" }), res(503, "edge hiccup")]
  });
  const out = await def.execute({ prompt: "a cat" });
  assert.equal(out.status, "pending", "上游边缘持续 5xx = 还没好，不是失败");
  assert.equal(out.jobId, "t-flaky", "pending 必须交回 jobId（续查把手）");
  assert.match(out.hint, /仍在生成中/);
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

section("硬护栏恒不超过 DRAW_TIMEOUT_MAX_MS（含 wait == timeout 的边界）", async () => {
  // 配置允许 `drawWaitMs == drawTimeoutMs`（上限 DRAW_TIMEOUT_MAX_MS）。旧写法
  // `waitMs + 10_000` 在边界上让护栏到 1_810_000——越过 host-config 声明的上限，
  // 且「等待循环先返回」退化成「用户不会把两个值设成相等」的运气。现在 waitMs
  // 自己让出这段余量，不变式是 waitMs + margin <= timeoutMs <= MAX。
  const edge = makeTool({
    steps: [res(200, { task_id: "t1" })],
    settings: { drawTimeoutMs: DRAW_TIMEOUT_MAX_MS, drawWaitMs: DRAW_TIMEOUT_MAX_MS }
  });
  assert.ok(
    edge.def.timeoutMs <= DRAW_TIMEOUT_MAX_MS,
    `护栏 ${edge.def.timeoutMs}ms 越过 DRAW_TIMEOUT_MAX_MS (${DRAW_TIMEOUT_MAX_MS}ms)`
  );
  const huge = makeTool({ steps: [res(200, { task_id: "t1" })], settings: { drawTimeoutMs: 9_999_999, drawWaitMs: 5 } });
  assert.ok(
    huge.def.timeoutMs <= DRAW_TIMEOUT_MAX_MS,
    `直接传入超限的 drawTimeoutMs 也必须被夹住（实测 ${huge.def.timeoutMs}ms）`
  );
});

section("挂载被撤下：等待立即以 pending 收场并交回 jobId", async () => {
  let disposed = false;
  const { def, calls } = makeTool({
    // 提交成功那一刻插件被撤下（用户关了开关 / 热重载）：紧接着的等待必须立刻收场。
    steps: [
      (url, options) => {
        if (options.method === "POST") {
          disposed = true;
          return res(200, { task_id: "t1" });
        }
        return res(200, { task_status: "RUNNING" });
      }
    ],
    settings: { drawWaitMs: 3_000 },
    isDisposed: () => disposed
  });
  const started = Date.now();
  const out = await def.execute({ prompt: "a cat" });
  const elapsed = Date.now() - started;
  assert.equal(out.status, "pending", "撤下不是失败：任务还在上游，jobId 要交回去");
  assert.equal(out.jobId, "t1");
  assert.equal(calls.length, 1, "abort 立即生效，等待循环一次轮询都没发出");
  assert.ok(elapsed < 1_000, `撤下后不该继续占住调用（实测 ${elapsed}ms）`);
});

section("等待进行中被撤下：下一轮巡检就收场，不等预算耗尽", async () => {
  let disposed = false;
  const { def, calls } = makeTool({
    // 撤下发生在**等待进行中**（用户关开关 / 热重载），而不是提交刚回来那一刻：
    // 这只有等待循环里的巡检看得见——信号只能表达「已经中止」，问不出「刚刚被撤下」。
    steps: [
      res(200, { task_id: "t1" }),
      (url, options) => {
        void url;
        void options;
        disposed = true;
        return res(200, { task_status: "RUNNING" });
      },
      res(200, { task_status: "SUCCEED", output_images: ["https://oss/a.png"] })
    ],
    settings: { drawWaitMs: 60_000 },
    isDisposed: () => disposed
  });
  const started = Date.now();
  const out = await def.execute({ prompt: "a cat" });
  const elapsed = Date.now() - started;
  assert.equal(out.status, "pending", "撤下不是失败，也不是「已生成」");
  assert.equal(out.jobId, "t1", "jobId 要交回去：本次挂载内还能续查（重挂后作业表是新的一张）");
  assert.equal(calls.length, 2, "第二轮轮询不该发出（撤下后每轮先巡检）");
  assert.ok(elapsed < 2_000, `撤下后不该继续占住调用（实测 ${elapsed}ms，预算 60s）`);
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
