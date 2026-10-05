// usage-observer 离线套件：把「DSH 真实对话 → 本地计数 / 429 事件」这条
// 观察层的纯函数半边钉死，peer-free（不 import pi-ai / dsh-llm-pi-ai）。
//
// 这条链路是面板四块计数面板（今日次数 / 模型分布 / 趋势 / 429 事件流）的
// **唯一**生产者：M4 之前 probe 是唯一写入者，而 usage 试调按钮已随目录表删除、
// validity 探针按设计不记调用——所以这里的行为就是那四块面板的全部真相。
import { strict as assert } from "node:assert";
import {
  tokensOfChunk,
  eventOfChunk,
  observeStream,
  modelIdOfOptions,
  withUsageObserver,
} from "../src/host/usage-observer.ts";
import { CODE } from "../src/host/llm-error-fix.ts";

/** 收集 sinks 调用的记录器（假实现，不碰磁盘）。 */
function recorder() {
  const calls = [];
  const events = [];
  return {
    calls,
    events,
    sinks: {
      recordCall: (input) => { calls.push(input); },
      recordEvent: (input) => { events.push(input); },
    },
  };
}

/** 把数组变成 async iterator。 */
async function* of(chunks) {
  for (const chunk of chunks) yield chunk;
}

// ── tokensOfChunk：只认真实 usage chunk，取累计值 ──────────────────────────
{
  // 首选上游给的精确总量。
  assert.equal(tokensOfChunk({ type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }), 15);
  // 没有 totalTokens 时退回 input+output。
  assert.equal(tokensOfChunk({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } }), 15);
  // 非正数读作「没给」，不是 0。
  assert.equal(tokensOfChunk({ type: "usage", usage: { inputTokens: 0, outputTokens: 0 } }), null);
  assert.equal(tokensOfChunk({ type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }), null);
  // 文本 delta 不是 usage。
  assert.equal(tokensOfChunk({ type: "text-delta", index: 0, text: "hi" }), null);
  assert.equal(tokensOfChunk({ type: "finish", reason: { kind: "stop" } }), null);
  assert.equal(tokensOfChunk(null), null);
  assert.equal(tokensOfChunk("usage"), null);
}

// ── eventOfChunk：429 分诊读的是「重分类之后」的 code ─────────────────────
{
  // 真额度耗尽 → quota。
  const quota = eventOfChunk({
    type: "finish",
    reason: { kind: "error", failure: { code: CODE.QUOTA, message: "balance exhausted" } },
  });
  assert.equal(quota.kind, "quota");
  assert.equal(quota.message, "balance exhausted");

  // 限频 → rate_limit（llm-error-fix 把误判的 rpm 429 改写成 RATE_LIMIT，
  // 观察层在它外面，所以这里读到的已经是 RATE_LIMIT——面板与退避策略说同一件事）。
  const rate = eventOfChunk({
    type: "finish",
    reason: { kind: "error", failure: { code: CODE.RATE_LIMIT, message: "rpm exhausted" } },
  });
  assert.equal(rate.kind, "rate_limit", "限频不能被记成额度耗尽，否则面板与重试策略口径相反");

  // 其它 code → error（不假装是 quota）。
  assert.equal(eventOfChunk({
    type: "finish",
    reason: { kind: "error", failure: { code: "SERVER", message: "boom" } },
  }).kind, "error");
  // 无 code → error，且消息是自述的占位而非空串。
  const bare = eventOfChunk({ type: "finish", reason: { kind: "error", failure: {} } });
  assert.equal(bare.kind, "error");
  assert.ok(bare.message.length > 0, "没有 message 时也要有一句可读的话");

  // 成功与非 error 终止不产生事件。
  assert.equal(eventOfChunk({ type: "finish", reason: { kind: "stop" } }), null);
  assert.equal(eventOfChunk({ type: "finish", reason: { kind: "tool-calls" } }), null);
  // 用户中断不是上游 quota 信号。
  assert.equal(eventOfChunk({
    type: "finish",
    reason: { kind: "aborted", failure: { code: CODE.RATE_LIMIT, message: "user stopped" } },
  }), null, "aborted 是用户按的停止键，不进事件流");

  // 凭据形状先脱敏再进事件流（state 文件与面板都会读到它）。
  const leaky = eventOfChunk({
    type: "finish",
    reason: { kind: "error", failure: { code: CODE.QUOTA, message: "key ms-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d rejected" } },
  });
  assert.ok(!leaky.message.includes("0a1b2c3d"), "ms- 令牌裸值必须脱敏");
}

// ── observeStream：透传 + 结束即记账（只记一次） ─────────────────────────
{
  // 成功：usage + finish → 记一次 call，带 token。
  const r1 = recorder();
  const success = [
    { type: "text-delta", index: 0, text: "he" },
    { type: "usage", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
    { type: "finish", reason: { kind: "stop" } },
  ];
  const seen = [];
  for await (const chunk of observeStream(of(success), "Qwen/Qwen3.5-27B", r1.sinks)) seen.push(chunk.type);
  assert.deepEqual(seen, ["text-delta", "usage", "finish"], "chunk 必须原样透传，一个不少");
  assert.equal(r1.calls.length, 1, "一次调用只记一次");
  assert.equal(r1.calls[0].modelId, "Qwen/Qwen3.5-27B");
  assert.equal(r1.calls[0].tokens, 120, "token 用上游的精确总量");
  assert.equal(r1.events.length, 0, "成功没有事件");
}
{
  // 失败（429）：没有 usage chunk，但仍记一次 call（次数口径），token 为 null，
  // 另记一条事件。null ≠ 0（wire 语义基线）。
  const r2 = recorder();
  const failure = [
    { type: "finish", reason: { kind: "error", failure: { code: CODE.RATE_LIMIT, message: "429 too many requests" } } },
  ];
  for await (const _ of observeStream(of(failure), "deepseek-ai/DeepSeek-V4.1-Flash", r2.sinks));
  assert.equal(r2.calls.length, 1, "被打上限频的请求同样是一次上游调用");
  assert.equal(r2.calls[0].tokens, null, "上游没给 usage 时是 null，不是 0");
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].kind, "rate_limit");
  assert.equal(r2.events[0].modelId, "deepseek-ai/DeepSeek-V4.1-Flash");
}
{
  // 多个 usage chunk 取最后一个（peer 的 usage 是累计值，不是增量）。
  const r3 = recorder();
  const multi = [
    { type: "usage", usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    { type: "finish", reason: { kind: "stop" } },
  ];
  for await (const _ of observeStream(of(multi), "m", r3.sinks));
  assert.equal(r3.calls[0].tokens, 15, "取累计值，不做加法");
}
{
  // 消费者提前 break：仍记一次（请求已经发出去了），token 为 null，且只记一次。
  const r4 = recorder();
  for await (const chunk of observeStream(of([
    { type: "text-delta", index: 0, text: "…" },
    { type: "text-delta", index: 0, text: "…" },
    { type: "finish", reason: { kind: "stop" } },
  ]), "m", r4.sinks)) {
    break;
  }
  assert.equal(r4.calls.length, 1, "中断也是一次调用，且只记一次");
  assert.equal(r4.calls[0].tokens, null);
}
{
  // 内层抛错：流照常抛给调用方（观察层不吞），但记账仍发生。
  const r5 = recorder();
  async function* boom() {
    yield { type: "text-delta", index: 0, text: "x" };
    throw new Error("STREAM_CLOSED");
  }
  let threw = false;
  try {
    for await (const _ of observeStream(boom(), "m", r5.sinks));
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "观察层不吞上游异常");
  assert.equal(r5.calls.length, 1, "崩掉的流也已经消耗了一次上游调用");
}
{
  // sinks 抛错/拒绝：绝不能打断对话（观测失败不是对话失败）。
  const r6 = recorder();
  const hostile = {
    recordCall: () => { throw new Error("disk on fire"); },
    recordEvent: () => Promise.reject(new Error("disk on fire")),
  };
  const chunks = [];
  for await (const chunk of observeStream(of([
    { type: "finish", reason: { kind: "error", failure: { code: CODE.QUOTA, message: "exhausted" } } },
  ]), "m", hostile)) chunks.push(chunk.type);
  assert.deepEqual(chunks, ["finish"], "sinks 炸了也要把 chunk 透传出去");
}

// ── modelIdOfOptions：缺失读成空串，绝不猜 ────────────────────────────────
{
  assert.equal(modelIdOfOptions({ model: "m/x" }), "m/x");
  assert.equal(modelIdOfOptions({}), "");
  assert.equal(modelIdOfOptions({ model: 42 }), "");
  assert.equal(modelIdOfOptions(null), "");
}

// ── withUsageObserver：两个流出口都包，且包在重分类层之外 ───────────────────
{
  const r7 = recorder();
  const inner = {
    stream: (options) => of([
      { type: "usage", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
      { type: "finish", reason: { kind: "stop" } },
    ]),
  };
  const wrapped = withUsageObserver(inner, r7.sinks);
  const out = [];
  for await (const chunk of wrapped.stream({ model: "MiniMax/MiniMax-M3" })) out.push(chunk.type);
  assert.deepEqual(out, ["usage", "finish"]);
  assert.equal(r7.calls.length, 1);
  assert.equal(r7.calls[0].modelId, "MiniMax/MiniMax-M3");
  assert.equal(r7.calls[0].tokens, 7);
}
{
  // options 里没有 model → 不记账（不猜模型），但流照常透传。
  const r8 = recorder();
  const wrapped = withUsageObserver({ stream: () => of([{ type: "finish", reason: { kind: "stop" } }]) }, r8.sinks);
  const out = [];
  for await (const chunk of wrapped.stream({})) out.push(chunk.type);
  assert.deepEqual(out, ["finish"]);
  assert.equal(r8.calls.length, 0, "没有 model 就不记——分布图不能凭空多出一行");
}
{
  // prepareCall(provider, model, signal)：模型 id 在第二参，handle.stream 也要包。
  const r9 = recorder();
  const handle = {
    stream: () => of([
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      { type: "finish", reason: { kind: "stop" } },
    ]),
  };
  const wrapped = withUsageObserver({
    stream: () => of([]),
    prepareCall: () => handle,
  }, r9.sinks);
  const prepared = await wrapped.prepareCall("modelscope-token-plan", "Qwen/Qwen3.5-35B-A3B");
  for await (const _ of prepared.stream({})) { /* 走完 */ }
  assert.equal(r9.calls.length, 1, "prepareCall 那条路也要记账");
  assert.equal(r9.calls[0].modelId, "Qwen/Qwen3.5-35B-A3B");
  assert.equal(r9.calls[0].tokens, 2);
}
{
  // prepareCall 返回 promise 时同样包住 resolve 后的 handle。
  const r10 = recorder();
  const wrapped = withUsageObserver({
    stream: () => of([]),
    prepareCall: async () => ({
      stream: () => of([{ type: "finish", reason: { kind: "stop" } }]),
    }),
  }, r10.sinks);
  const prepared = await wrapped.prepareCall("p", "ZhipuAI/glm-4.6");
  for await (const _ of prepared.stream({})) { /* 走完 */ }
  assert.equal(r10.calls.length, 1);
  assert.equal(r10.calls[0].modelId, "ZhipuAI/glm-4.6");
  assert.equal(r10.calls[0].tokens, null, "没有 usage chunk 就是 null");
}
{
  // 非流成员原样透传（不能因为套了 Proxy 就把 adapter 的其它能力弄丢）。
  const wrapped = withUsageObserver({
    resolveApiKey: async () => "ms-secret",
    stream: () => of([]),
  }, recorder().sinks);
  assert.equal(await wrapped.resolveApiKey(), "ms-secret");
}
{
  // 429 事件的 code 是重分类**之后**的：这条钉死观察层必须套在重分类层之外。
  // 顺序反了，被 llm-error-fix 纠正成 RATE_LIMIT 的 rpm 限频会在这里被读成
  // QUOTA → 面板记「额度耗尽」，而重试策略在同一刻按限频退避，两边说两套话。
  const r11 = recorder();
  const reclassified = { type: "finish", reason: { kind: "error", failure: { code: CODE.RATE_LIMIT, message: "rpm exhausted" } } };
  for await (const _ of observeStream(of([reclassified]), "m", r11.sinks));
  assert.equal(r11.events[0].kind, "rate_limit");
}

console.log("usage-observer.test.mjs: all assertions passed");
