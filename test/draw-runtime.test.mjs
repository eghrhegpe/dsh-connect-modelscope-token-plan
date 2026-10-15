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
import {
  DRAW_TOOL_NAME,
  buildGenerationsEndpoint,
  buildTasksEndpoint,
  pickDrawModel,
  drawModelIds,
  splitImageUrls,
  runDrawOnce
} from "../src/host/draw-runtime.ts";

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

section("pickDrawModel 无请求时取目录里第一个出图模型", () => {
  const entries = [
    { id: "some/chat-model", tasks: ["text-generation"] },
    { id: "Qwen/Qwen-Image-Edit", tasks: ["image-to-image"] },
    { id: "MusePublic/Qwen-Image-Edit", tasks: ["image-to-image"] }
  ];
  assert.equal(pickDrawModel(entries), "Qwen/Qwen-Image-Edit");
  assert.deepEqual(drawModelIds(entries), ["Qwen/Qwen-Image-Edit", "MusePublic/Qwen-Image-Edit"]);
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

// ── 工具定义 ──────────────────────────────────────────────────────────────────
section("工具名带插件前缀，不与 dsh-draw-router 撞名", () => {
  assert.equal(DRAW_TOOL_NAME, "modelscope_draw_image");
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
