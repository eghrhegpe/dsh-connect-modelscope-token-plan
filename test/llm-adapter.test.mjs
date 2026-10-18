// llm-adapter 装配链的契约快照测试。
//
// 背景：`src/host/llm-adapter.ts`（及它依赖的 `llm-adapter-core.ts` 装配链）是
// peer-dependent 半边——直接 import 随 Host 发行的 `@earendil-works/pi-ai` /
// `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-llm-pi-ai`，离线 checkout 不可解析，
// 因而此前**没有任何测试覆盖**（llm-adapter.ts 文件头曾直言「改错本文件不会让
// 任何门禁变红」，docs/ROADMAP.md Backlog 把它列为最大覆盖缺口）。
//
// 本套件用 `test/helpers/peer-stub-loader.mjs`（Node module customization hooks）
// 把四个 peer 入口换成记录式假实现，让**真实装配链代码**原样加载执行，再从
// `__records` 断言「我们对 peer 的调用形状」：
//
//   - descriptor 契约（reasoning:false、compat、input、cost、maxTokens 条件出现）；
//   - retryPolicy 传参（key、mode、maxRetries、retryableCodes 含/不含什么）；
//   - PiAiAdapter 构造形状（profiles 行、auth 惰性、图片 hook 接线）；
//   - usage 观察层包装（传了才包；重分类先于观察、事件记 rate_limit 而非 quota）。
//
// 诚实边界：这里钉的是**我们自己这一侧**对 peer 的调用形状（假 peer 是我们写的，
// 不会跟着 peer 真身漂移）。peer 真身升级改形状，仍需 ROADMAP Backlog 的 e2e /
// 真机冒烟去抓——本套件不替代它，只保证「我们这边不再静默改坏」。
//
// @module test/llm-adapter.test.mjs

import { strict as assert } from "node:assert";
import { register } from "node:module";

// 必须先注册 loader，再动态 import 任何会（直接或间接）碰 peer 的模块。
register(new URL("./helpers/peer-stub-loader.mjs", import.meta.url));

// 假 peer 的共享记录器；import 真实包名，loader 拦成 stub，拿到同一模块实例。
const { __records } = await import("@earendil-works/pi-ai");
const { createModelScopeAdapter } = await import("../src/host/llm-adapter.ts");

const BASE_URL = "https://api-inference.modelscope.cn/v1";

// ── §1 providerIds 与 createProvider 调用形状 + descriptor 契约 ─────────────
{
  const base = __records.createProviderCalls.length;
  const built = createModelScopeAdapter({
    entries: [
      { id: "org/Alpha", name: "Alpha", input_modalities: ["text"] },
      { id: "org/Visual", name: "Visual", tasks: ["image-text-to-text"] },
      { id: "org/Gen", name: "Gen", output_modalities: ["image"] }
    ],
    baseUrl: BASE_URL,
    resolveApiKey: async () => "ms-secret"
  });
  assert.deepEqual(built.providerIds, ["modelscope-token-plan"]);
  assert.ok(built.adapter !== null && typeof built.adapter === "object", "adapter 必须是对象（Proxy 包装后的实例）");

  const [pc] = __records.createProviderCalls.slice(base);
  assert.equal(pc.id, "modelscope-token-plan", "provider id 必须是自有 slug，不能撞裸 modelscope");
  assert.equal(pc.name, "ModelScope Token Plan");
  assert.equal(pc.models.length, 2, "生图模型（output_modalities 只含 image）不是 chat 模型，不进 descriptor");

  const [alpha, visual] = pc.models;
  assert.equal(alpha.id, "org/Alpha");
  assert.equal(alpha.name, "Alpha");
  assert.equal(alpha.provider, "modelscope-token-plan");
  assert.equal(alpha.baseUrl, BASE_URL);
  assert.deepEqual(alpha.input, ["text"]);
  assert.equal(alpha.reasoning, false, "§4：不钉 effort，保守 false");
  assert.equal(alpha.compat.supportsDeveloperRole, false, "承重墙：pi-ai 缺省会猜 true，魔搭不认 developer 角色");
  assert.equal(alpha.compat.maxTokensField, "max_tokens");
  assert.equal(typeof alpha.cost.input, "number", "cost 是哨兵对象不是 null，pi-ai 会把 null 当未知成本行渲染");
  assert.equal(typeof alpha.contextWindow, "number", "contextWindow 必须有正数兜底，pi-ai 对 undefined 当 0 算会坏 max-token 计算");

  assert.deepEqual(visual.input, ["text", "image"], "vision 判定必须进 descriptor（详情端点任务标签是权威信号）");
}

// ── §2 resolveRetryPolicy 传参形状 ──────────────────────────────────────────
{
  const base = __records.retryPolicyCalls.length;
  createModelScopeAdapter({
    entries: [{ id: "org/Alpha" }],
    baseUrl: BASE_URL,
    resolveApiKey: async () => "ms-secret"
  });
  const [rp] = __records.retryPolicyCalls.slice(base);
  assert.equal(rp.key, "dsh-connect-modelscope-token-plan.modelscope-token-plan.retryPolicy");
  assert.equal(rp.config.mode, "normal");
  assert.equal(rp.config.maxRetries, 8, "比 peer 默认更温和的共享池退避");
  assert.ok(rp.config.retryableCodes.includes("RATE_LIMIT"), "瞬时限频必须可重试");
  assert.ok(!rp.config.retryableCodes.includes("QUOTA"), "耗尽的池重试只会延长冷却窗口，刻意不重试");
  assert.ok(!rp.config.retryableCodes.includes("ACCOUNT_QUOTA"));
  assert.deepEqual(rp.config.backoff, { initialDelayMs: 1500, maxDelayMs: 20000, jitterRatio: 0.25 });
}

// ── §3 PiAiAdapter 构造形状（profiles 行 / auth 惰性 / 图片 hook 接线） ──────
{
  const base = __records.adapterOpts.length;
  const fakeFs = { processPathFromHostPath: (hostPath) => `mapped:${hostPath}` };
  const built = createModelScopeAdapter({
    entries: [{ id: "org/Alpha", name: "Alpha", max_output_length: 4096 }],
    baseUrl: BASE_URL,
    resolveApiKey: async () => "ms-live",
    get: (service) => (service === "attachments" ? "att-svc" : service === "fs" ? fakeFs : undefined)
  });
  const [ao] = __records.adapterOpts.slice(base);

  const profiles = ao.profiles();
  assert.ok(profiles instanceof Map, "profiles 必须是 Map");
  const profile = profiles.get("modelscope-token-plan");
  assert.ok(profile, "profile 行必须以 provider id 为键");
  assert.equal(profile.provider, "modelscope-token-plan");
  assert.equal(profile.displayName, "ModelScope Token Plan");
  assert.equal(typeof profile.streamIdleTimeoutMs, "number");
  assert.equal(profile.retryPolicy.__stub, "retry-policy", "profile 行必须携带 resolveRetryPolicy 的返回值");
  assert.ok(profile.configuredMaxTokens instanceof Map);
  assert.ok(profile.modelErrors instanceof Map);
  assert.equal(profile.piProvider.__stub, "provider");
  assert.equal(typeof profile.piProvider.auth.apiKey.resolve, "function");

  // auth.resolve 惰性：有 key 才吐凭据，空/缺都答 undefined——每次请求现读，
  // 轮换令牌不需要重新注册。
  const resolve = profile.piProvider.auth.apiKey.resolve;
  assert.deepEqual(await resolve({ credential: { key: "ms-x" } }), { auth: { apiKey: "ms-x" }, source: "ModelScope Token Plan" });
  assert.equal(await resolve({ credential: { key: "" } }), undefined);
  assert.equal(await resolve(), undefined);

  // resolveApiKey 透传：适配器读的必须是注入的解析器（每次请求现读）。
  assert.equal(await ao.resolveApiKey(), "ms-live");

  // 图片 hook：resolveAttachments 走 get("attachments")。
  assert.equal(await ao.resolveAttachments(), "att-svc");

  // resolveImageAccess 走共享的 resolveImageAttachmentAccess，host 路径经
  // get("fs").processPathFromHostPath 映射。
  const iaBase = __records.imageAccessCalls.length;
  const mapped = ao.resolveImageAccess({ kind: "file" }, { ref: 1 });
  const [ia] = __records.imageAccessCalls.slice(iaBase);
  assert.deepEqual(ia.attachments, { kind: "file" });
  assert.deepEqual(ia.ref, { ref: 1 });
  assert.equal(mapped.mapped, "mapped:host:/photo.png", "mapFn 必须接上 fs 服务的 host 路径映射器");
}

// ── §4 usage 观察层包装：传了才包，且重分类先于观察 ─────────────────────────
{
  // 对照：不传 usage → withUsageObserver 不包（usage-observer.ts 头：「无 sinks
  // 时返回原对象」）；传 usage → 套观察层 Proxy。同一 settings 下两者必须不是
  // 同一引用，否则「传了才包」的开关就失效了。
  const noUsage = createModelScopeAdapter({
    entries: [{ id: "org/Alpha" }],
    baseUrl: BASE_URL,
    resolveApiKey: async () => "ms-secret"
  });
  const calls = [];
  const events = [];
  const sinks = {
    recordCall: (input) => calls.push(input),
    recordEvent: (input) => events.push(input)
  };
  const observed = createModelScopeAdapter({
    entries: [{ id: "org/Alpha" }],
    baseUrl: BASE_URL,
    resolveApiKey: async () => "ms-secret",
    usage: sinks
  });
  assert.notEqual(observed.adapter, noUsage.adapter, "传 usage 时必须套观察层 Proxy，不能与不传的 adapter 是同一引用");

  const handle = observed.adapter.prepareCall({}, "org/Alpha", new AbortController().signal);
  const chunks = [];
  for await (const chunk of handle.stream({})) chunks.push(chunk);
  assert.equal(chunks.length, 1, "假 peer 流只 yield 一个 finish chunk，必须原样透传");
  assert.equal(chunks[0].reason.failure.code, "RATE_LIMIT", "重分类层必须把误判的 QUOTA 纠正成 RATE_LIMIT");

  assert.equal(calls.length, 1, "每次流结束记一次 call（含失败）");
  assert.deepEqual(calls[0], { modelId: "org/Alpha", tokens: null }, "失败调用记次数、token 为 null（不是 0）");
  assert.equal(events.length, 1, "带 failure 的 error finish 必须记一条事件");
  assert.equal(events[0].modelId, "org/Alpha");
  assert.equal(events[0].kind, "rate_limit", "观察层读的是重分类之后的 code——rpm 限频记 rate_limit 而非 quota");
  assert.ok(events[0].message.includes("rpm"), "事件 message 保留脱敏后的原文");
}

// ── §5 允许清单 / 额度耗尽 / maxTokens 条件出现 ─────────────────────────────
{
  // 空清单 + 无 unavailable → 全部提供；maxTokens 只在目录声明时出现。
  const base = __records.createProviderCalls.length;
  createModelScopeAdapter({
    entries: [
      { id: "org/NoLimit", max_output_length: 8192 },
      { id: "org/Unlimited" }
    ],
    baseUrl: BASE_URL,
    resolveApiKey: async () => "ms-secret"
  });
  const [pc] = __records.createProviderCalls.slice(base);
  assert.equal(pc.models.length, 2);
  assert.equal(pc.models[0].maxTokens, 8192, "声明了输出上限才声明 maxTokens");
  assert.equal(pc.models[1].maxTokens, undefined, "未声明不猜数字——harness 用 defaultMaxTokens 兜底");

  // 白名单 + 额度耗尽 → 只提供清单内、未耗尽的 chat 模型。
  const base2 = __records.createProviderCalls.length;
  createModelScopeAdapter({
    entries: [
      { id: "org/A", name: "A" },
      { id: "org/B", name: "B", output_modalities: ["image"] },
      { id: "org/C", name: "C" }
    ],
    baseUrl: BASE_URL,
    resolveApiKey: async () => "ms-secret",
    enabledIds: ["org/A", "org/B"],
    unavailableModelIds: ["org/A"]
  });
  const [pc2] = __records.createProviderCalls.slice(base2);
  assert.equal(pc2.models.length, 0, "生图模型先排除、额度耗尽的再排除——注定 429 的请求干脆不发");
}

console.log("llm-adapter.test.mjs: all checks passed");
