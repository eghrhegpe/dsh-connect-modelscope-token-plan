// peer-imports.test.mjs —— test/helpers/peer-imports.mjs 这条扫描线自己的门禁。
//
// 为什么它单独一个套件，而不是塞进 host-range.test.mjs：
//
//   host-range.test.mjs 的 10 节要问「宿主装的那份 peer 里有没有这个符号」——
//   那需要宿主在场（装了 DSH 的那台机器）。CI 上没有宿主，那一节整节跳过。
//   于是「扫描器本身对不对」这件事在 CI 上没人管：扫描器坏掉 → 扫不出任何导入点
//   → 10 节在有宿主的机器上也只会说「符号契约未运行」→ 没人知道扫描器已经瞎了。
//
//   这个套件是零网络、零宿主的：它拿夹具喂扫描器，逐个形态核对它认不认得出；
//   再拿真实的 src/** 扫一遍，核对两套独立实现（AST / token 流）数出的是同一批导入点。
//   扫描器坏了，它先红。
//
// 判据是硬事实：这个文件里有没有这样的导入语句、绑定了哪些名字。不猜语义。

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  missingOnHost,
  ownerOf,
  pathResolves,
  readGroups,
  scanImportsByTokens,
  scanImportsInText,
  scanPeerImports,
} from "./helpers/peer-imports.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const peerNames = Object.keys(manifest.peerDependencies ?? {});

// --- 1. 归属：子路径算它爹 -----------------------------------------------------
assert.equal(ownerOf("@earendil-works/pi-ai", peerNames), "@earendil-works/pi-ai");
assert.equal(ownerOf("@earendil-works/pi-ai/api/openai-completions.lazy", peerNames), "@earendil-works/pi-ai");
assert.equal(ownerOf("@deepseek-ai/dsh-llm-pi-ai", peerNames), "@deepseek-ai/dsh-llm-pi-ai");
assert.equal(ownerOf("./local", peerNames), null);

// 兄弟包不许互相认亲：`dsh-llm` 不是 `dsh-llm-pi-ai` 的前缀（分隔符是 `/` 不是 `-`）。
assert.notEqual(ownerOf("@deepseek-ai/dsh-llm-pi-ai", ["@deepseek-ai/dsh-llm"]), "@deepseek-ai/dsh-llm");

// --- 2. 逐个导入形态：认得出 / 不该认的别认 ---------------------------------
{
  const peer = "@earendil-works/pi-ai";
  const src = `
import { createProvider } from "${peer}";
import { bar as baz } from "${peer}";
import { type OnlyType, value } from "${peer}";
import type { TypeWhole } from "${peer}";
import def from "${peer}";
import * as ns from "${peer}";
import "${peer}";
import { qux } from "./local";
export { reexported } from "${peer}";
export * from "${peer}";
export * as renamedNs from "${peer}";
// import { commented } from "${peer}";
const s = "import { inString } from '${peer}'";
async function load() { return await import("${peer}"); }
`;
  const sites = scanImportsInText(src, { file: "<fixture>", peerNames: [peer] });
  const shape = sites.map((site) => `${site.kind}:${site.spec}:${site.symbols.join("+")}`);

  // 具名导入（含别名、内联 type 修饰被剔掉）
  assert.ok(shape.includes("named:" + peer + ":createProvider"), shape.join(" | "));
  assert.ok(shape.includes("named:" + peer + ":bar"), shape.join(" | "));
  assert.ok(shape.includes("named:" + peer + ":value"), shape.join(" | "));
  // 整句类型导入不算取符号
  assert.ok(!shape.some((entry) => entry.includes("TypeWhole")), shape.join(" | "));
  // 默认导入 / 命名空间导入 / 副作用导入各是一种形态
  assert.ok(shape.includes("default:" + peer + ":default"), shape.join(" | "));
  assert.ok(shape.includes("namespace:" + peer + ":"), shape.join(" | "));
  assert.ok(shape.includes("side-effect:" + peer + ":"), shape.join(" | "));
  // 再导出
  assert.ok(shape.includes("named:" + peer + ":reexported"), shape.join(" | "));
  assert.ok(shape.includes("star:" + peer + ":"), shape.join(" | "));
  assert.ok(shape.includes("namespace:" + peer + ":"), shape.join(" | "));
  // 非 peer 的相对路径不进表
  assert.ok(!shape.some((entry) => entry.includes("./local")), shape.join(" | "));
  // 注释里的、字符串里的，都不算导入
  assert.ok(!shape.some((entry) => entry.includes("commented")), shape.join(" | "));
  assert.ok(!shape.some((entry) => entry.includes("inString")), shape.join(" | "));
  // 动态导入
  assert.ok(sites.some((site) => site.kind === "dynamic" && site.spec === peer), shape.join(" | "));
}

// 动态导入的绑定名与读到的属性路径：`??` 回退链上有一条走得通就算数。
{
  const peer = "@deepseek-ai/dsh-tools";
  const src = `
async function load() {
  const mod = await import("${peer}");
  return mod?.defineTool ?? mod?.default?.defineTool ?? null;
}
`;
  const sites = scanImportsInText(src, { file: "<fixture>", peerNames: [peer] });
  const dynamic = sites.find((site) => site.kind === "dynamic");
  assert.ok(dynamic, "动态导入没被认出来");
  assert.equal(dynamic.binding, "mod");
  assert.deepEqual(
    dynamic.reads.map((read) => read.parts),
    [["defineTool"], ["default", "defineTool"]],
  );
  // 同一条 `??` 链 → 合成一组：任一路径走得通即可
  const groups = readGroups(dynamic.reads);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].paths.length, 2);
}

// --- 3. 两套独立实现必须数出同一批导入点 ------------------------------------
//
// AST 路认形态、算绑定名与属性路径；token 路只看词法，只回答「几次、什么 spec」。
// 两条路互不依赖：对不上就是扫描器自己出了问题，当场判红（而不是绿着等人发现）。
{
  const peer = "@earendil-works/pi-ai";
  const src = `
import { createProvider } from "${peer}";
import type { OnlyType } from "${peer}";
import { type Inline, kept } from "${peer}";
import * as ns from "${peer}";
export { again } from "${peer}";
async function load() { return await import("${peer}"); }
`;
  const ast = scanImportsInText(src, { file: "<fixture>", peerNames: [peer] });
  const tokens = scanImportsByTokens(src, { peerNames: [peer] });
  const astSpecs = ast.map((site) => site.spec).sort();
  const tokenSpecs = tokens.map((hit) => hit.spec).sort();
  assert.deepEqual(tokenSpecs, astSpecs, "两套扫描路数出的导入点对不上");
  assert.equal(astSpecs.length, 5, `AST 路数出 ${astSpecs.length} 个：${astSpecs.join(", ")}`);
}

// --- 4. 真实 src/** 的导入点：登记在案 ---------------------------------------
//
// 这是一张封闭清单：src/** 里从 peer 取符号的地方，一处不多一处不少。
// 新增或删除一处导入点时，这张表要跟着改——改的时候顺便看一眼「宿主那份有没有它」。
//
// **它钉的不只是「哪一行 import 了哪个包」，还有「取了哪些符号」**：只钉 `file|spec`
// 的话，`import { createProvider }` 变成 `import { createProvider, extraSymbol }`
// 这类改动会从清单上溜过去——而「宿主那份有没有 extraSymbol」正是 host-range 第 10 节
// 要问的事，CI 上没有宿主时，那一节整节跳过，就没人管了。
{
  const expected = [
    {
      file: "src/host/draw-register.ts",
      spec: "@deepseek-ai/dsh-tools",
      kind: "dynamic",
      binding: "mod",
      reads: [["defineTool"], ["default", "defineTool"]],
    },
    {
      file: "src/host/llm-adapter-core.ts",
      spec: "@earendil-works/pi-ai",
      kind: "named",
      symbols: ["createProvider"],
    },
    {
      file: "src/host/llm-adapter-core.ts",
      spec: "@earendil-works/pi-ai/api/openai-completions.lazy",
      kind: "named",
      symbols: ["openAICompletionsApi"],
    },
    {
      file: "src/host/llm-adapter-core.ts",
      spec: "@deepseek-ai/dsh-llm-pi-ai",
      kind: "named",
      symbols: ["PiAiAdapter"],
    },
    {
      file: "src/host/llm-adapter-core.ts",
      spec: "@deepseek-ai/dsh-llm",
      kind: "named",
      symbols: ["resolveRetryPolicy", "resolveImageAttachmentAccess"],
    },
  ];

  const { ast, tokens } = scanPeerImports({ root, peerNames });

  // 每一行都要能说清「从哪个包取了什么」：具名/默认导入看 symbols，动态/命名空间看绑定与读法。
  const actual = ast
    .map((site) => ({
      file: site.file,
      spec: site.spec,
      kind: site.kind,
      symbols: [...(site.symbols ?? [])].sort(),
      binding: site.binding ?? null,
      reads: (site.reads ?? []).map((read) => read.parts),
    }))
    .sort((a, b) => `${a.file}|${a.spec}`.localeCompare(`${b.file}|${b.spec}`));
  const wanted = [...expected]
    .map((site) => ({
      file: site.file,
      spec: site.spec,
      kind: site.kind,
      symbols: [...(site.symbols ?? [])].sort(),
      binding: site.binding ?? null,
      reads: site.reads ?? [],
    }))
    .sort((a, b) => `${a.file}|${a.spec}`.localeCompare(`${b.file}|${b.spec}`));

  const describe = (list) =>
    list
      .map(
        (s) =>
          `${s.file} → ${s.spec}（${s.kind}）` +
          (s.symbols.length ? ` 取 ${s.symbols.join("+")}` : "") +
          (s.binding ? ` 绑定 ${s.binding}` : "") +
          (s.reads.length ? ` 读 ${s.reads.map((p) => p.join(".")).join(" / ")}` : ""),
      )
      .join("；") || "（空）";

  assert.deepEqual(
    actual,
    wanted,
    "src/** 里的 peer 导入点与登记表不一致：\n" +
      `  实际：${describe(actual)}\n` +
      `  登记：${describe(wanted)}\n` +
      "  改了一处导入点就把这张表补进去（连同 host-range.test.mjs 的 10 节一起看一遍）",
  );

  // 真实仓库里两套路也必须一致。
  const astSpecs = ast.map((site) => `${site.file}|${site.spec}`).sort();
  const tokenSpecs = tokens.map((hit) => `${hit.file}|${hit.spec}`).sort();
  assert.deepEqual(tokenSpecs, astSpecs, "两套扫描路在真实 src/** 上数出的导入点对不上");
}

// --- 5. 契约核对：宿主那份上缺什么 ------------------------------------------
{
  const mod = { createProvider: () => {}, defineTool: () => {}, default: { defineTool: () => {} } };

  // 具名导出在 → 不缺
  assert.deepEqual(missingOnHost(mod, { symbols: ["createProvider"], reads: [] }), []);
  // 具名导出不在 → 缺，且说清缺的是哪个
  assert.deepEqual(missingOnHost(mod, { symbols: ["nope"], reads: [] }), ["导出 nope"]);
  // 属性路径走得通 → 不缺
  assert.deepEqual(missingOnHost(mod, { symbols: [], reads: [{ parts: ["defineTool"], chain: "c1" }] }), []);
  assert.deepEqual(
    missingOnHost(mod, { symbols: [], reads: [{ parts: ["default", "defineTool"], chain: "c1" }] }),
    [],
  );
  // 同链两条都走不通 → 缺
  assert.deepEqual(
    missingOnHost(mod, {
      symbols: [],
      reads: [
        { parts: ["missing"], chain: "c1" },
        { parts: ["default", "missing"], chain: "c1" },
      ],
    }),
    ["属性 missing 或 default.missing"],
  );
  // 不同链各自都得走通
  assert.deepEqual(
    missingOnHost(mod, {
      symbols: [],
      reads: [
        { parts: ["missing"], chain: "c1" },
        { parts: ["alsoMissing"], chain: "c2" },
      ],
    }),
    ["属性 missing", "属性 alsoMissing"],
  );
  // 属性路径逐段走得通才算数
  assert.equal(pathResolves(mod, ["default", "defineTool"]), true);
  assert.equal(pathResolves(mod, ["default", "nope"]), false);
  assert.equal(pathResolves(mod, ["nope", "defineTool"]), false);
}

console.log("peer-imports.test.mjs: all checks passed");
