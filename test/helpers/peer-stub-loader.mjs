// 记录式假 peer loader —— 供 test/llm-adapter.test.mjs 使用。
//
// 背景：`src/host/llm-adapter-core.ts` 直接 import 随 Host 发行的 peer 包
// （`@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`），
// 它们在离线 checkout（本仓库自己的 node_modules）里不可解析，所以适配器装配链
// 长期没有任何测试钉住（docs/ROADMAP.md Backlog 的最大覆盖缺口）。
//
// 本 loader 用 Node 的 module customization hooks（`module.register()`，Node 20.6+）
// 把上述 peer 入口替换成**记录式假实现**：假模块本身不模拟 peer 的运行时行为，
// 只把「被谁、用什么参数调了」记进共享的 `__records`（住在 `@earendil-works/pi-ai`
// 的 stub 里，其余 stub 经真实 import 关系引用同一实例）。于是真实装配链代码
// （llm-adapter-core.ts / llm-adapter.ts）可以原样加载执行，测试从 `__records`
// 断言「我们对 peer 的调用形状」——这是**契约快照**：peer 真身漂移由 ROADMAP
// Backlog 的 e2e 负责，这里钉的是我们自己这一侧不再静默改坏。
//
// 拦截面刻意收窄：只拦四个 peer 入口，其余一切照常解析。
//
// @module test/helpers/peer-stub-loader

const RECORDS_SOURCE = [
  "export const __records = {",
  "  createProviderCalls: [],",
  "  retryPolicyCalls: [],",
  "  imageAccessCalls: [],",
  "  adapterOpts: [],",
  "  streamConsumed: 0",
  "};",
  "export function createProvider(options) {",
  "  __records.createProviderCalls.push(options);",
  "  return { __stub: 'provider', ...options };",
  "}",
  "export function openAICompletionsApi() {",
  "  return { __stub: 'openai-completions-api' };",
  "}"
].join("\n");

// @earendil-works/pi-ai 子路径入口只导出 openAICompletionsApi（llm-adapter-core
// 用 lazy 入口），返回值只在 provider.api 行上被携带，原样返回 marker 即可。
const LAZY_ENTRY_SOURCE = [
  "export function openAICompletionsApi() {",
  "  return { __stub: 'openai-completions-api' };",
  "}"
].join("\n");

// dsh-llm：本插件只用两个导出。resolveRetryPolicy 记下 config 与派生 key；
// resolveImageAttachmentAccess 记下 attachments/ref 并执行一次 mapFn（host 路径
// 映射器），返回值带 mapped 让测试断言 hook 接线。
const LLM_SOURCE = [
  "import { __records } from '@earendil-works/pi-ai';",
  "export function resolveRetryPolicy(config, key) {",
  "  __records.retryPolicyCalls.push({ config, key });",
  "  return { __stub: 'retry-policy', ...config };",
  "}",
  "export function resolveImageAttachmentAccess(attachments, mapFn, ref) {",
  "  __records.imageAccessCalls.push({ attachments, ref });",
  "  const mapped = typeof mapFn === 'function' ? mapFn('host:/photo.png') : undefined;",
  "  return { attachments, mapped, ref };",
  "}"
].join("\n");

// dsh-llm-pi-ai：只用一个导出 PiAiAdapter。构造记录 opts；stream / prepareCall
// 返回一条固定流（yield 一个带结构化 type 的 QUOTA finish chunk）——让测试能
// 验证重分类层（QUOTA→RATE_LIMIT）与观察层（事件/计数）在真装配链上的顺序。
// 注意 stub 里 import 的 `@earendil-works/pi-ai` 也会被本 loader 拦到同一实例，
// 所以 __records 是全 stub 共享的。
const PI_AI_ADAPTER_SOURCE = [
  "import { __records } from '@earendil-works/pi-ai';",
  "export class PiAiAdapter {",
  "  constructor(opts) {",
  "    this.__opts = opts;",
  "    __records.adapterOpts.push(opts);",
  "  }",
  "  stream() {",
  "    __records.streamConsumed += 1;",
  "    return fixedStream();",
  "  }",
  "  prepareCall() {",
  "    return { stream: () => fixedStream() };",
  "  }",
  "}",
  "async function* fixedStream() {",
  "  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: '{\"type\":\"quota_exceeded_error\",\"message\":\"rpm exhausted\"}' } } };",
  "}"
].join("\n");

const STUBS = new Map([
  ["@earendil-works/pi-ai", RECORDS_SOURCE],
  ["@earendil-works/pi-ai/api/openai-completions.lazy", LAZY_ENTRY_SOURCE],
  ["@deepseek-ai/dsh-llm", LLM_SOURCE],
  ["@deepseek-ai/dsh-llm-pi-ai", PI_AI_ADAPTER_SOURCE]
]);

/** 拦截 peer 入口：specifier → `stub:<specifier>` URL。 */
export async function resolve(specifier, context, nextResolve) {
  if (STUBS.has(specifier)) {
    return { url: `stub:${specifier}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

/** 对 stub URL 返回对应的假模块源码；其余照常。 */
export async function load(url, context, nextLoad) {
  if (url.startsWith("stub:")) {
    const specifier = url.slice("stub:".length);
    const source = STUBS.get(specifier);
    if (source === undefined) throw new Error(`peer-stub-loader: unknown stub url ${url}`);
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
