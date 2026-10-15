/**
 * 测试环境隔离门禁（hermeticity gate）。
 *
 * 守的是一条具体的因果链（2026-10-16 实测）：`ms-auth.createTokenStore` 的 env
 * 默认 `process.env` ⇒ 测试进程**继承宿主的真实魔搭令牌** ⇒ 任何「应当没有令牌」
 * 的断言（例如空状态快照的 `token.present === false`）在开发机上红，而在 CI 的
 * 干净环境里永远绿。方向是最坏的：偏偏只有装了真令牌的机器会红，也就是作者和
 * 真实用户。
 *
 * 同一个坑在 `doctor.test.mjs` 里被手工 `delete` 处理过、`routes.test.mjs` 里
 * 没有——**靠每个测试记得清环境是守不住的**（这是本仓自己反复论证过的立场：
 * 契约不该靠下游自觉）。所以堵法分两层：
 *
 *   §1 运行时对照：把「宿主 env 能泄漏」与「env 缝能挡住」各自跑一遍并断言，
 *      让这条路径的存在本身被钉住——而不是等某天某个断言红了才发现；
 *   §2 源码扫描：任何 import `apply()` 的测试必须显式注入 `env`（或自己 delete），
 *      新增/改写的测试忘传就在这里红。
 *
 * 谁都没有义务记住这条纪律——记住的是这个文件。
 *
 * @module test/env-hermetic
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/host/index.ts";
import { SNAPSHOT_PATH } from "../src/host/routes/paths.ts";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "ms-env-hermetic-"));

/** 形状合法但一定是假的令牌（`ms-` + 32 位十六进制，过 `isPlausibleToken`）。 */
const FAKE_TOKEN = "ms-0123456789abcdef0123456789abcdef";

/** 最小 ctx：没有 credentials 服务——令牌只能从 memory / env 来。 */
const makeCtx = (capture) => ({
  get: () => undefined,
  logger: { warn: () => {} },
  effect: (_fn, _label) => {},
  webServer: {
    register({ path, handler }) {
      capture.set(path, handler);
      return () => capture.delete(path);
    }
  }
});

/** 打一次快照，返回 `{ ok, token }` 那部分。 */
async function snap() {
  const handlers = new Map();
  apply(makeCtx(handlers), {}, { env: {} });
  const handler = handlers.get(SNAPSHOT_PATH);
  assert.ok(handler, "快照路由必须注册");
  const res = {
    status: null,
    writeHead(status) { this.status = status; },
    end(payload) { this.body = JSON.parse(payload); }
  };
  await handler({ method: "GET", headers: { host: "localhost:3080" } }, res);
  assert.equal(res.status, 200);
  return res.body;
}

/** 挂一个指定 deps 的 apply，读它的 `token.present`。 */
async function tokenPresentWith(deps) {
  const handlers = new Map();
  const previous = process.env.MODELSCOPE_API_KEY;
  process.env.MODELSCOPE_API_KEY = FAKE_TOKEN;
  try {
    apply(makeCtx(handlers), {}, deps);
    const handler = handlers.get(SNAPSHOT_PATH);
    const res = {
      status: null,
      writeHead(status) { this.status = status; },
      end(payload) { this.body = JSON.parse(payload); }
    };
    await handler({ method: "GET", headers: { host: "localhost:3080" } }, res);
    return { present: res.body.token.present, source: res.body.token.source };
  } finally {
    // 还原而不是删除：宿主到底有没有令牌，**由宿主机决定**，测试无权替它做主。
    if (previous === undefined) delete process.env.MODELSCOPE_API_KEY;
    else process.env.MODELSCOPE_API_KEY = previous;
  }
}

// ── §1 运行时对照：泄漏路径是真的，缝也是真的 ──
{
  // 阳性：不传 env（= 走默认 process.env）时，宿主环境**确实**能被读到。
  // 这条不是「为了防止将来」，它是证据——删掉它，就没人知道 §2 在防什么。
  const leaked = await tokenPresentWith({});
  assert.equal(leaked.present, true, "默认 env 源是宿主 process.env（这是会泄漏的那条路）");
  assert.equal(leaked.source, "env", "来源应当标明来自环境");

  // 阴性：注入 env 之后，宿主令牌看不见了。
  const isolated = await tokenPresentWith({ env: {} });
  assert.equal(isolated.present, false, "注入 env 缝后，宿主令牌不得可见");
  assert.equal(isolated.source, "none");

  // 注入的 env **能**被读到：缝是双向可用的，不是一个恒为空的桩。
  const injected = await tokenPresentWith({ env: { MODELSCOPE_API_KEY: FAKE_TOKEN } });
  assert.equal(injected.present, true, "注入的 env 必须真的被当作来源");
  assert.equal(injected.source, "env");

  // 本文件自己的快照不受宿主令牌影响（自证：这套 walking skeleton 是干净的）。
  const clean = await snap();
  assert.equal(clean.token.present, false);
}

// ── §2 源码扫描：谁 import 了 apply，谁必须隔离 env ──
{
  const testDir = new URL(".", import.meta.url);
  const files = readdirSync(testDir).filter((entry) => entry.endsWith(".test.mjs"));
  assert.ok(files.length > 0, "得有测试文件可扫（扫不到 = 门禁自己瞎了）");

  /** 走了真实 Host 入口 `apply()`——也就是会造出真实 tokenStore 的那类测试。 */
  const IMPORTS_HOST_APPLY = /from\s+"\.\.\/src\/host\/index\.ts"/;
  /** 两种合法的隔离姿势：注入 env 缝，或显式清掉环境变量。 */
  const ISOLATED = /env:\s*\{|delete\s+process\.env\.MODELSCOPE_API_KEY/;

  const offenders = [];
  for (const file of files) {
    if (file === "env-hermetic.test.mjs") continue;
    const source = readFileSync(new URL(file, testDir), "utf8");
    if (!IMPORTS_HOST_APPLY.test(source)) continue;
    if (!ISOLATED.test(source)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `这些测试用了 apply() 却没有隔离令牌环境：向 apply 传 { env: {} }（见 src/host/types.ts 的 env 缝注释）\n  - ${offenders.join("\n  - ")}`
  );

  // 反向也钉一下：这条正则不能被将来某次「顺手改 import 路径」悄悄绕过。
  const selfSource = readFileSync(new URL("env-hermetic.test.mjs", testDir), "utf8");
  assert.ok(IMPORTS_HOST_APPLY.test(selfSource), "探针自身必须仍然命中那条 import 正则");
}

console.log("env-hermetic.test.mjs: all checks passed");
