/**
 * `HostDeps` 接线门禁（declared ⇒ wired）。
 *
 * 守的是一条已经在本仓重复出现三次的漂移：**契约声明了，代码没接线**。
 *   - `HostDeps` 曾声明 `credentials` / `getLlm` / `emit` / `pollMs`，而 `index.ts`
 *     硬编码走 `ctx`，注入被静默忽略（2026-10-16 实测）；
 *   - `pollMs` 描述的机制根本不存在（它自己的注释就写着"轮询实际取
 *     settings.pollSeconds"）；
 *   - 反向也漂：`loadToolsModule` / `drawFetch` 实际在用，却从没写进接口——靠
 *     `deps: any` 绕过类型。
 *
 * 这类缝的害处不是"功能缺失"，是**骗人**：一个以为自己覆盖了假 llm 服务的测试，
 * 实际走的是 ctx，绿得毫无意义。所以它要有门禁，而不是靠 review 记住。
 *
 * 两层：
 *   §1 源码扫描：`HostDeps` 的每个字段都必须在 `src/host/index.ts`（或它转发给的
 *      模块）里以 `deps.<field>` 形式被读到；反向：源码里读的每个 `deps.X` 都必须
 *      在接口里声明。
 *   §2 运行时：注入的 `getLlm` / `emit` / `credentials` 必须**真的生效**（阴性对照
 *      是修复前的代码——注入被忽略，§2 全红）。
 *
 * @module test/deps-wiring
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { apply } from "../src/host/index.ts";
import { SNAPSHOT_PATH } from "../src/host/routes/paths.ts";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "ms-deps-wiring-"));

const srcDir = new URL("../src/", import.meta.url);
const readSrc = (relative) => readFileSync(new URL(relative, srcDir), "utf8");

/** 收集 src/ 下所有 .ts 的源码（扫描面覆盖转发链，不只是 index.ts）。 */
function allSources() {
  const out = [];
  const walk = (dirUrl) => {
    for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
      const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dirUrl);
      if (entry.isDirectory()) walk(url);
      else if (entry.name.endsWith(".ts")) out.push({ name: String(url).split("/src/")[1], text: readFileSync(url, "utf8") });
    }
  };
  walk(new URL("../src/", import.meta.url));
  return out;
}

// ── §1 双向扫描：声明 ⇄ 接线 ──
{
  const typesText = readSrc("host/types.ts");
  const block = typesText.slice(typesText.indexOf("export interface HostDeps"), typesText.indexOf("/** 路由族共享的 wiring 袋"));
  assert.ok(block.includes("HostDeps"), "接口块必须能被定位（正则改坏了就红在这里）");

  /** 接口里声明的字段名（`?` 之前那个标识符，跳过注释行）。 */
  const declared = [...block.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)]
    .map((m) => m[1])
    .filter((name) => name !== undefined);
  assert.ok(declared.length >= 5, `声明的缝不该这么少：${declared.join(", ")}`);

  const sources = allSources();
  /** 源码里真正被读到的 `deps.<field>`。 */
  const wired = new Set();
  for (const { text } of sources) {
    for (const m of text.matchAll(/\bdeps\.([A-Za-z_][A-Za-z0-9_]*)/g)) wired.add(m[1]);
  }

  // (a) 声明了却没接线 —— 注入被静默忽略，比没有这个缝更坏。
  const unwired = declared.filter((name) => !wired.has(name));
  assert.deepEqual(
    unwired,
    [],
    `HostDeps 声明了这些缝但 src/ 里没人读 deps.<name>——注入会被静默忽略。要么在 index.ts 接上，要么删掉这个字段\n  - ${unwired.join("\n  - ")}`
  );

  // (b) 接线了却没声明 —— 说明有人靠 any 绕过了类型。
  const undeclared = [...wired].filter((name) => !declared.includes(name));
  assert.deepEqual(
    undeclared,
    [],
    `src/ 读了这些 deps.<name> 但 HostDeps 没声明（多半是 any 绕过）——补进接口\n  - ${undeclared.join("\n  - ")}`
  );

  // 反向自证：扫描器自己别瞎了（把接口块抽错的典型症状是 declared 为空，上面已断言）。
  assert.ok(declared.includes("env") && declared.includes("getLlm"), "扫描器必须认得这两个已知字段");
}

// ── §2 运行时：注入必须真的生效（而不只是被声明）──
//
// `emit` 不在这里：它只在 publish **成功**时发出，而离线进程里适配器 peer 加载
// 注定失败，硬造一条成功路径的成本远高于收益——它由 §1 的双向扫描守着（改回硬
// 编码 `ctx.emit` 的那个瞬间，`declared` 里就有字段不再被 `deps.<name>` 读到）。
{
  const cleanups = [];
  /** ctx 里**什么服务都没有**：任何没接线的缝都会退回这里，从而被测出来。 */
  const makeCtx = (extra = {}) => ({
    get: () => undefined,
    emit: () => { throw new Error("ctx.emit 是哨兵：只有 emit 缝没接线才会碰到它"); },
    logger: { warn: () => {} },
    // 真跑 effect（轮询在这里起飞），并收下 cleanup——否则定时器会把进程吊住。
    effect: (fn) => { const off = fn(); if (typeof off === "function") cleanups.push(off); },
    webServer: { register: () => () => {} },
    ...extra
  });

  const MODEL_LIST = JSON.stringify({ object: "list", data: [{ id: "Qwen/Qwen3-Coder" }] });
  const fetchImpl = async (url) =>
    String(url).includes("/models")
      ? new Response(MODEL_LIST, { status: 200, headers: { "content-type": "application/json" } })
      : new Response("{}", { status: 401 });

  const handlers = new Map();
  let asked = 0;
  let resolved = 0;

  apply(
    makeCtx({
      webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {}; } }
    }),
    // 开关默认关 → publish 不会起飞 → getLlm 永远不被问。要测缝必须先让它有活干。
    { registerProvider: true },
    {
      getLlm: (service) => {
        asked += 1;
        return service === "llm" ? { registerAdapter: () => () => {} } : null;
      },
      credentials: {
        async resolve() { resolved += 1; return { value: "ms-0123456789abcdef0123456789abcdef" }; },
        async set() {},
        async unset() {}
      },
      fetchImpl,
      env: {}
    }
  );

  // 给挂载轮询（拉目录 → 记首见 → publish）跑完它的 await 链。用**等到条件成立**
  // 而不是固定睡 50ms：这条链上多了一次状态文件落盘（roster-seen.json，冷启动
  // 要播种整个目录），固定窗口在满负载并行跑套件时会被挤爆成假红。等的是同一件
  // 事（`asked > 0`），所以放宽的是等待时长，不是断言。
  const deadline = Date.now() + 5000;
  while (asked === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  for (const off of cleanups.splice(0)) off();

  assert.ok(asked > 0, "注入的 getLlm 必须真的被 publisher 调用（修复前它走 ctx.get，asked 恒为 0）");

  // credentials：打一次快照即可确定 tokenStore 用的是注入的那份服务。
  const handler = handlers.get(SNAPSHOT_PATH);
  assert.ok(handler, "快照路由必须注册");
  const res = {
    status: null,
    writeHead(status) { this.status = status; },
    end(payload) { this.body = JSON.parse(payload); }
  };
  await handler({ method: "GET", headers: { host: "localhost:3080" } }, res);
  assert.ok(resolved > 0, "注入的 credentials 必须真的被 resolve（修复前它走 ctx.get('credentials')）");
  assert.equal(res.body.token.present, true, "注入的凭据服务给出的令牌应当被快照看见");
}

// ── §3 轮询带窗口覆盖（回归：runPoll 曾无参调 fetchModels → 覆盖每轮振荡回退）──
//
// 修复前：用户存 256K → 路由 publish 打标条目（签名 S_marked）→ 下一轮 poll 用
// 未打标条目（S_unmarked）→ catalogSignature 含窗口值，签名不同 → 摘下重挂——
// 覆盖每 pollSeconds 静默回退一次，适配器每轮重建。这里把带覆盖的 provider.json
// 落进本测试的 DSH_HOME，断言**轮询 publish 出去的 descriptor** 真带着覆盖窗口。
{
  const writeFile = (await import("node:fs/promises")).writeFile;
  const { mkdir } = await import("node:fs/promises");
  const pluginStateDir = join(process.env.DSH_HOME, "state", "dsh-connect-modelscope-token-plan");
  await mkdir(pluginStateDir, { recursive: true });
  // Qwen/Qwen3-Coder：目录不声明窗口、策展表也不收（§3 只测覆盖路径）。
  await writeFile(
    join(pluginStateDir, "provider.json"),
    JSON.stringify({ version: 1, enabled: true, enabledIds: null, contextWindow: 262144 })
  );

  const cleanups = [];
  const warns = [];
  const makeCtx = (extra = {}) => ({
    get: () => undefined,
    emit: () => {},
    logger: { warn: (m) => { warns.push(m); } },
    effect: (fn) => { const off = fn(); if (typeof off === "function") cleanups.push(off); },
    webServer: { register: () => () => {} },
    ...extra
  });

  const MODEL_LIST = JSON.stringify({ object: "list", data: [{ id: "Qwen/Qwen3-Coder" }] });
  const fetchImpl = async (url) =>
    String(url).includes("/models")
      ? new Response(MODEL_LIST, { status: 200, headers: { "content-type": "application/json" } })
      : new Response("{}", { status: 401 });

  /**
   * publish 链的真值取自**适配器工厂收到的条目**——这正是「带覆盖打标」能否走到
   * 注册的最上游观测点：runPoll 若无参 fetchModels，条目就落 128k 兜底，此断言红。
   * 假模块替代真 llm-adapter（其 peer 只在 Host 进程存在，测试进程 import 必败），
   * 但 descriptor 由**真 buildDescriptors** 造（跑真的 llm-models.ts），保证断言
   * 测的是生产映射逻辑而非测试自画的形状。
   */
  let publishedEntries = null;
  let registered = false;
  const { buildDescriptors } = await import("../src/host/llm-models.ts");

  // 返回值（effect cleanup 收集在 makeCtx 的 cleanups 里）本块不直接用——
  // teardown 走下方 cleanups.splice(0)，这里要的是 apply() 的副作用真的跑完。
  apply(
    makeCtx(),
    { registerProvider: true },
    {
      getLlm: () => ({
        registerAdapter: () => {
          registered = true;
          return () => {};
        },
        registerConfigurableProviders: () => () => {}
      }),
      credentials: {
        async resolve() { return { value: "ms-0123456789abcdef0123456789abcdef" }; },
        async set() {},
        async unset() {}
      },
      fetchImpl,
      env: {},
      loadAdapterModule: async () => ({
        createModelScopeAdapter: ({ entries }) => {
          publishedEntries = entries;
          const models = buildDescriptors(entries, {
            providerId: "modelscope-token-plan",
            baseUrl: "https://api-inference.modelscope.cn/v1",
            enabledIds: null,
            unavailableModelIds: []
          });
          return {
            adapter: {
              getModels: () => models,
              providerId: "modelscope-token-plan",
              resolveCredential: async () => "ms-0123456789abcdef0123456789abcdef"
            },
            providerIds: ["modelscope-token-plan"]
          };
        }
      })
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  for (const off of cleanups.splice(0)) off();

  assert.ok(registered, "挂载轮询（M4 seed）必须真的走完 publish → registerAdapter");
  assert.ok(Array.isArray(publishedEntries) && publishedEntries.length > 0, "适配器工厂必须收到目录条目");
  const entry = publishedEntries.find((e) => e?.id === "Qwen/Qwen3-Coder");
  assert.ok(entry, "目录里的模型必须原样进工厂");
  assert.equal(entry.contextWindow, 262144, "轮询 publish 的条目必须带落盘的窗口覆盖（修复前无参 fetchModels → 每轮回退 128k）");
  // 再往下游走一步：descriptor（真正注册进 Host 的形状）同样带覆盖。
  const models = buildDescriptors(publishedEntries, {
    providerId: "modelscope-token-plan",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    enabledIds: null,
    unavailableModelIds: []
  });
  assert.equal(models[0].contextWindow, 262144, "注册 descriptor 的 contextWindow 必须是覆盖值");
}

console.log("deps-wiring.test.mjs: all checks passed");
