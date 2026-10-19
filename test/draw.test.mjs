// 出图纯逻辑的形状门禁（`src/host/draw.ts`）。
//
// 本套件钉住的是**协议形状**——魔搭异步两段式的每个字段、每个陷阱。它们全部来自
// docs/SPIKE-image-gen.md 的真机实测：每个断言背后都有一次真机请求，不是从文档
// 转述，也不是从姊妹插件抄来的（sensenova 那份是同步单发，形状不兼容）。
//
// 覆盖不到的部分要说清楚：真正的 fetch / 轮询循环 / Host 工具注册不在本模块内
// （那半边 peer-dependent），因此**端到端没有测试**——见 docs/ROADMAP.md Backlog。
// 本套件钉住的是「给定上游响应，解析与判定是否正确」。
//
// 另：本仓库的测试全是**离线**脚本、用 `node:assert`、直接 import `.ts` 源文件
// （Node 24 的类型剥离），不引 jest/vitest/@testing-library。唯一的 devDependency
// 类依赖是 `test/dom-render.test.mjs` 用的 jsdom（真 DOM，仍不联网）；其余套件都是
// 裸 node。

import { strict as assert } from "node:assert";
import {
  DRAW_POLL_INTERVAL_MS,
  DRAW_TIMEOUT_MS,
  TASK_TYPE_HEADER,
  TASK_TYPE_IMAGE_GENERATION,
  buildDrawBody,
  createDrawCooldown,
  describeDrawFailure,
  expectedPollCount,
  hasUsableImages,
  isInFlightStatus,
  isTerminalStatus,
  normalizeImageUrlInput,
  normalizeImageUrlList,
  parseDrawResult,
  readOutputImages,
  readTaskId,
  readTaskStatus
} from "../src/host/draw.ts";

const checks = [];
/** 记一个断言组，跑完统一报数（与本仓库其它套件的收尾风格一致）。 */
function section(name, body) {
  checks.push([name, body]);
}

// ── 轮询必需的头 ─────────────────────────────────────────────────────────────
//
// 这是本协议最贵的单点知识：缺它上游一律回 `task not found` + FAILED，而任务其实
// 正常在跑（实测 A/B：同一 task，只差这个头，一个假失败一个真成功）。把它钉死，
// 防止有人「顺手清理」掉这个看起来多余的 header。
section("轮询必需的头常量", () => {
  assert.equal(TASK_TYPE_HEADER, "X-ModelScope-Task-Type");
  assert.equal(TASK_TYPE_IMAGE_GENERATION, "image_generation");
});

// ── 状态读取：未知值必须继续等，不能误判失败 ──────────────────────────────────
section("readTaskStatus 规范化大小写与空白", () => {
  assert.equal(readTaskStatus({ task_status: "SUCCEED" }), "SUCCEED");
  assert.equal(readTaskStatus({ task_status: "succeed" }), "SUCCEED");
  assert.equal(readTaskStatus({ task_status: "  RUNNING  " }), "RUNNING");
});

section("readTaskStatus 对缺失/怪值返回 null 而不是猜", () => {
  assert.equal(readTaskStatus({}), null);
  assert.equal(readTaskStatus(null), null);
  assert.equal(readTaskStatus("SUCCEED"), null, "裸字符串不是响应对象");
  assert.equal(readTaskStatus({ task_status: 42 }), null);
  assert.equal(readTaskStatus({ task_status: "" }), null);
  assert.equal(readTaskStatus({ task_status: "CANCELLED" }), null, "上游若新增状态，不许臆造");
});

section("只有 SUCCEED/FAILED 是终态；null 与未知值都不是", () => {
  assert.equal(isTerminalStatus("SUCCEED"), true);
  assert.equal(isTerminalStatus("FAILED"), true);
  assert.equal(isTerminalStatus("RUNNING"), false);
  assert.equal(isTerminalStatus("PENDING"), false);
  assert.equal(isTerminalStatus(null), false, "读不到状态不等于失败");
});

section("未知状态判为进行中——宁可多等，不肯丢图", () => {
  assert.equal(isInFlightStatus("RUNNING"), true);
  assert.equal(isInFlightStatus("PENDING"), true);
  assert.equal(isInFlightStatus(null), false);
});

// ── task_id：提交态不可信，只认 id ────────────────────────────────────────────
section("readTaskId 取提交响应里的 id（含实测的短 id）", () => {
  assert.equal(readTaskId({ task_id: "6543e546-03ca-43f7-b9a9-0fb40a594e8b" }), "6543e546-03ca-43f7-b9a9-0fb40a594e8b");
  assert.equal(readTaskId({ task_id: "8179954" }), "8179954", "FLUX 那种短 id 也得认");
});

section("readTaskId 对空/缺失返回 null——不能拿 task_status 当成功依据", () => {
  assert.equal(readTaskId({ task_status: "SUCCEED" }), null);
  assert.equal(readTaskId({ task_id: "" }), null);
  assert.equal(readTaskId({ task_id: "   " }), null);
  assert.equal(readTaskId({ task_id: 123 }), null);
  assert.equal(readTaskId(null), null);
});

// ── 结果读取：只认 output_images ──────────────────────────────────────────────
section("readOutputImages 读实测形状 output_images[]", () => {
  assert.deepEqual(readOutputImages({ output_images: ["https://oss.example/a.png"] }), ["https://oss.example/a.png"]);
});

section("readOutputImages 过滤空项并保持上游顺序", () => {
  const body = { output_images: ["https://oss.example/a.png", "", "  ", "https://oss.example/b.png"] };
  assert.deepEqual(readOutputImages(body), ["https://oss.example/a.png", "https://oss.example/b.png"]);
});

section("readOutputImages 不读 OpenAI 同步形状与外部资料误传形状", () => {
  assert.deepEqual(readOutputImages({ data: [{ url: "https://oss.example/x.png" }] }), [], "OpenAI 同步形状在魔搭不存在");
  assert.deepEqual(readOutputImages({ output: { image_url: "https://oss.example/x.png" } }), [], "output.image_url 也不存在");
  assert.deepEqual(readOutputImages({}), []);
  assert.deepEqual(readOutputImages(null), []);
});

// ── 成功判定：状态与图片都要齐 ────────────────────────────────────────────────
section("hasUsableImages 要求 SUCCEED 且图片非空", () => {
  assert.equal(hasUsableImages({ task_status: "SUCCEED", output_images: ["u"] }), true);
  assert.equal(hasUsableImages({ task_status: "SUCCEED", output_images: [] }), false, "空 SUCCEED 是没有结果，不是成功");
  assert.equal(hasUsableImages({ task_status: "SUCCEED" }), false);
  assert.equal(hasUsableImages({ task_status: "RUNNING", output_images: ["u"] }), false, "还在跑就算有 url 也不是结果");
});

section("parseDrawResult 成功时给出 taskId 与图片", () => {
  const r = parseDrawResult({ task_status: "SUCCEED", output_images: ["https://oss.example/a.png"] }, "t1");
  assert.equal(r.taskId, "t1");
  assert.deepEqual(r.images, ["https://oss.example/a.png"]);
});

section("parseDrawResult 对空 SUCCEED 抛错——不许报一张不存在的图", () => {
  assert.throws(() => parseDrawResult({ task_status: "SUCCEED", output_images: [] }, "t1"), /没有可用图片/);
});

section("parseDrawResult 对非成功状态抛错", () => {
  assert.throws(() => parseDrawResult({ task_status: "FAILED", output_images: [] }, "t1"), /未成功/);
  assert.throws(() => parseDrawResult({}, "t1"), /未成功/);
});

// ── 请求体：只发实测确认的字段 ────────────────────────────────────────────────
section("buildDrawBody 最小形状只有 model 与 prompt", () => {
  assert.deepEqual(buildDrawBody({ model: "Qwen/Qwen-Image-Edit", prompt: "a cat" }), {
    model: "Qwen/Qwen-Image-Edit",
    prompt: "a cat"
  });
});

section("buildDrawBody 带 imageUrl 时一律发数组（官方形状）", () => {
  const single = buildDrawBody({ model: "m", prompt: "p", imageUrl: "https://oss.example/in.png" });
  assert.deepEqual(single.image_url, ["https://oss.example/in.png"], "单张也发数组，省掉一个分支");
  const multi = buildDrawBody({ model: "m", prompt: "p", imageUrl: ["https://oss.example/a.png", "https://oss.example/b.png"] });
  assert.deepEqual(multi.image_url, ["https://oss.example/a.png", "https://oss.example/b.png"]);
});

section("buildDrawBody 多图保持调用方顺序（多图编辑里顺序即语义）", () => {
  const body = buildDrawBody({ model: "m", prompt: "图一中的狗去追图二中的飞盘", imageUrl: ["dog.png", "frisbee.png"] });
  assert.deepEqual(body.image_url, ["dog.png", "frisbee.png"], "顺序不可重排");
});

section("normalizeImageUrlList 归一单张/多张/空值", () => {
  assert.deepEqual(normalizeImageUrlList("u"), ["u"]);
  assert.deepEqual(normalizeImageUrlList(["a", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeImageUrlList(["a", "", "  ", "b"]), ["a", "b"], "空项过滤但保序");
  assert.deepEqual(normalizeImageUrlList(undefined), []);
  assert.deepEqual(normalizeImageUrlList(null), []);
  assert.deepEqual(normalizeImageUrlList(42), []);
});

section("buildDrawBody 的 loras：字符串与权重映射两种形状", () => {
  const single = buildDrawBody({ model: "m", prompt: "p", loras: "owner/lora" });
  assert.equal(single.loras, "owner/lora");
  const weighted = buildDrawBody({ model: "m", prompt: "p", loras: { "owner/a": 0.6, "owner/b": 0.4 } });
  assert.deepEqual(weighted.loras, { "owner/a": 0.6, "owner/b": 0.4 });
});

section("buildDrawBody 的 loras：空值与非法权重不发该字段", () => {
  assert.equal(buildDrawBody({ model: "m", prompt: "p", loras: "" }).loras, undefined);
  assert.equal(buildDrawBody({ model: "m", prompt: "p", loras: "   " }).loras, undefined);
  assert.equal(buildDrawBody({ model: "m", prompt: "p", loras: {} }).loras, undefined);
  const mixed = buildDrawBody({ model: "m", prompt: "p", loras: { "ok/a": 0.5, "bad/b": Number.NaN } });
  assert.deepEqual(mixed.loras, { "ok/a": 0.5 }, "NaN 权重的条目应被剔除");
});

section("buildDrawBody 用上游确认的字段名", () => {
  const body = buildDrawBody({
    model: "m",
    prompt: "p",
    size: "1024x1024",
    steps: 20,
    guidance: 3.5,
    seed: 42,
    negativePrompt: "blurry"
  });
  assert.equal(body.size, "1024x1024", "size 是「宽x高」字符串，不是分开的宽高");
  assert.equal(body.steps, 20);
  assert.equal(body.guidance, 3.5);
  assert.equal(body.seed, 42);
  assert.equal(body.negative_prompt, "blurry");
  assert.equal(body.num_inference_steps, undefined, "别用别家的字段名");
  assert.equal(body.guidance_scale, undefined);
});

section("buildDrawBody 不发 ref_image，也不发未验证的 n", () => {
  const body = buildDrawBody({ model: "m", prompt: "p" });
  assert.equal(body.ref_image, undefined, "ref_image 是别家平台的写法");
  assert.equal(body.n, undefined, "n 的支持度未验证，传上游不认的字段更危险");
});

section("buildDrawBody 忽略空串与 NaN 参数", () => {
  const body = buildDrawBody({
    model: "m",
    prompt: "p",
    imageUrl: "   ",
    size: "",
    steps: Number.NaN,
    guidance: Number.NaN,
    negativePrompt: ""
  });
  assert.deepEqual(Object.keys(body).sort(), ["model", "prompt"]);
});

// ── 输入图 URL 归一 ───────────────────────────────────────────────────────────
section("normalizeImageUrlInput 放行 http(s)", () => {
  assert.equal(normalizeImageUrlInput("https://oss.example/a.png"), "https://oss.example/a.png");
  assert.equal(normalizeImageUrlInput("http://oss.example/a.png"), "http://oss.example/a.png");
});

section("normalizeImageUrlInput 放行 data URL（上游支持度待验证，但不拦）", () => {
  assert.equal(normalizeImageUrlInput("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
});

section("normalizeImageUrlInput 拒绝本地路径等上游取不到的形态", () => {
  assert.equal(normalizeImageUrlInput("C:\\temp\\a.png"), null);
  assert.equal(normalizeImageUrlInput("/tmp/a.png"), null);
  assert.equal(normalizeImageUrlInput(""), null);
  assert.equal(normalizeImageUrlInput(null), null);
  assert.equal(normalizeImageUrlInput(42), null);
});

// ── 失败分诊：原因不可知就明说不可知 ──────────────────────────────────────────
section("describeDrawFailure 对空错误明确承认原因不可知", () => {
  // 实测唯一失败样本：errors.code=0、message 空串，没有顶层 message。
  const msg = describeDrawFailure({ taskStatus: "FAILED", bodyText: '{"errors":{"code":0,"message":""}}' });
  assert.match(msg, /未给出失败原因/);
  assert.match(msg, /FAILED/);
});

section("describeDrawFailure 对非终态卡住给不同说法", () => {
  const msg = describeDrawFailure({ taskStatus: "RUNNING" });
  assert.match(msg, /非终态/);
  assert.match(msg, /截止时间/);
});

section("describeDrawFailure 的 401/403 不替上游编造账号态", () => {
  assert.match(describeDrawFailure({ status: 401 }), /令牌无效/);
  const neutral = describeDrawFailure({ status: 403 });
  assert.match(neutral, /令牌无效/);
  // 这条断言在 2026-10-19 之前是反的（要求 /邮箱验证/ 必须出现）。当时的依据是
  // 「实测真遇到过的拦截是邮箱未验证」——但那次实测的 401 只证明端点存在
  // （docs/SPIKE-image-gen.md:74），body 里没有任何账号态线索。把一次偶遇写成
  // 状态码的语义，等于对每一个 401 都断言「你没实名」。
  assert.ok(
    !/邮箱验证/.test(neutral),
    `body 没提账号态时不得替上游断言账号态：${neutral}`
  );
});

section("describeDrawFailure 只在 body 真的提到账号态时才说账号态", () => {
  const body = '{"errors":{"message":"please complete your profile via email verification"}}';
  assert.match(describeDrawFailure({ status: 403, bodyText: body }), /邮箱验证/, "上游自己说了就照说");
  assert.match(describeDrawFailure({ status: 401, bodyText: "账号未完成实名认证" }), /实名/, "中文口径同样认");
});

section("describeDrawFailure 分诊 404 / 429 / 5xx", () => {
  assert.match(describeDrawFailure({ status: 404 }), /端点或模型不存在/);
  assert.match(describeDrawFailure({ status: 429 }), /限流/);
  assert.match(describeDrawFailure({ status: 503 }), /上游服务异常/);
});

section("describeDrawFailure 已知 cause 优先于泛化文案", () => {
  assert.match(describeDrawFailure({ cause: "拿不到 task_id" }), /拿不到 task_id/);
});

section("describeDrawFailure 脱敏 ms- 令牌，绝不让凭据进消息", () => {
  const leaked = '{"echo":"ms-3f2a1b8c-1111-2222-3333-444455556666"}';
  const msg = describeDrawFailure({ status: 500, bodyText: leaked });
  assert.ok(!msg.includes("3f2a1b8c"), `令牌裸值泄漏进消息：${msg}`);
  assert.match(msg, /REDACTED/);
});

section("describeDrawFailure 脱敏 Bearer 头", () => {
  const msg = describeDrawFailure({ status: 500, bodyText: "Authorization: Bearer sk-abcdefghijklmnop" });
  assert.ok(!msg.includes("sk-abcdefghijklmnop"), `Bearer 令牌泄漏：${msg}`);
});

section("describeDrawFailure 截断超长 body", () => {
  const msg = describeDrawFailure({ status: 500, bodyText: "x".repeat(5000) });
  assert.ok(msg.length < 500, `body 未被截断（长度 ${msg.length}）`);
});

// ── 冷却门 ────────────────────────────────────────────────────────────────────
section("createDrawCooldown 失败后进入冷却，可清空", () => {
  const c = createDrawCooldown(60_000);
  assert.equal(c.remainingMs(), 0);
  c.fail();
  assert.ok(c.remainingMs() > 0, "失败后应处于冷却中");
  c.clear();
  assert.equal(c.remainingMs(), 0);
});

section("createDrawCooldown 窗口为 0 时不阻拦", () => {
  const c = createDrawCooldown(0);
  c.fail();
  assert.equal(c.remainingMs(), 0);
});

// ── 轮询预算 ──────────────────────────────────────────────────────────────────
section("轮询节奏取 15s 量级（更密无收益）", () => {
  assert.ok(DRAW_POLL_INTERVAL_MS >= 15_000, `间隔 ${DRAW_POLL_INTERVAL_MS}ms 低于实测选定的量级`);
});

section("超时是 15 分钟量级——实测最慢 537s，且放弃不等于任务死亡", () => {
  assert.equal(DRAW_TIMEOUT_MS, 900_000);
  assert.ok(DRAW_TIMEOUT_MS > 537_000, "必须覆盖已观测到的最慢一次");
});

section("expectedPollCount 与预算自洽", () => {
  assert.equal(expectedPollCount(900_000, 15_000), 60);
  assert.equal(expectedPollCount(300_000, 0), 300_000, "非法间隔不得产生 0 或 NaN");
  assert.equal(expectedPollCount(1, 15_000), 1);
});

// ── 跑 ────────────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, body] of checks) {
  try {
    body();
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`  NOT OK - ${name}`);
    console.error(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed > 0) {
  console.error(`draw.test.mjs: ${failed} 组断言失败`);
  process.exit(1);
}
console.log(`draw.test.mjs 全部通过（${checks.length} 组）`);
