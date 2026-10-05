// build-gate.mjs —— 产物新鲜度门禁：入库的 lib/ 与 client.js 必须真的是当前
// src/ 构建出来的。
//
// ## 为什么这道门禁必须存在（不是洁癖）
//
// 本插件的 `lib/` 与根 `client.js` 是**故意入库**的产物（见 .gitignore 与
// tsdown.config.mjs 的注释）：DSH 市场的 `github:` 安装源走 git-dep，**不跑
// prepack**。所以 `npm run prepack` 里那句 `npm run build` 在最主要的安装路径上
// 根本不执行——lib/ 不入库则装出来的包没有 `main` 入口，卡片直接失效；反过来，
// **改了 src/ 忘了 build，市场装出来的包跑的是旧代码，而工作树干净、测试全绿、
// typecheck 全绿，没有任何东西会红。** 这是入库产物模式唯一的、也是致命的
// 失效模式：一个门禁都不响的 bug。
//
// ## 判据：内容哈希，不是 mtime
//
// 常见的做法是比 mtime（产物比源码新= 新鲜）。本门禁**不**这么做，因为：
//
//   - `git clone` / `git checkout` 会把所有文件的 mtime 设成 checkout 时刻，
//     两者几乎相同，判据随机翻转；
//   - 打包、解压、CI 缓存恢复都会重写时间戳，mtime 不携带内容信息；
//   - 反向也不可靠：有人 `touch src/**` 就能骗过 mtime 门禁。
//
// 所以本门禁**重新构建一遍**到系统临时目录，与入库产物逐字节比对。哈希一样 =
// 新鲜。不一样 = 有人改了 src/ 没重新 build。
//
// 代价是一次构建（本仓库体量约 1s）。换来的是「发布物与源码同源」成为一条
// **可证伪**的断言，而不是一句口头承诺——值得。
//
// ## 失败时怎么修
//
//     npm run build && git add lib client.js
//
// 纪律：产物与源码**同一个提交**。分开提交等于让市场短暂装到旧代码。
//
// ## 只读性
//
// 重新构建落盘到系统临时目录，**不碰工作树里的产物**——所以本门禁是只读的：
// 跑失败、跑中断、跑一百次，`lib/` 与 `client.js` 都原样不动。
//
// ## 边界
//
// 覆盖 host 与 client 两个产物（`lib/` + `client.js`），与 tsdown.config.mjs 的
// 两个条目一一对应。新增构建目标时同步更新 `ARTIFACTS` 与下面 `gateConfig()`
// 里的条目，否则新产物不受本门禁管——与 `test/release.test.mjs` 里「检查可能
// 已失效」防的是同一类盲区。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 入库产物目标：仓库内路径 + 它在新构建里对应的子路径。
 *
 * `freshSub` 必须与 `gateConfig()` 里改写的 outDir 一一对应——host 条目落
 * `lib/`、client 条目落包根，所以前者映射到 `host/`、后者映射到 staging 本身。
 */
const ARTIFACTS = [
  { repoPath: "lib", freshSub: "host", label: "lib/" },
  { repoPath: "client.js", freshSub: ".", label: "client.js" }
];

const fails = [];
const note = (m) => console.log(`  ok - ${m}`);
const bad = (m) => fails.push(m);

/** Windows 路径转 POSIX 形式（写进配置的字面量必须是 POSIX，否则 import 踩 URL scheme）。 */
const toPosix = (p) => p.split(sep).join("/");

/** 目录内所有文件的相对路径（递归、排序）——比对的内容单位。 */
function walk(dir, base = dir) {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(toPosix(relative(base, full)));
  }
  return out;
}

/** 内容哈希（sha256 前 12 位：够短，够用）。 */
function hashOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
}

/** 某目录下所有文件的「相对路径 → 哈希」映射；目录不存在或为空返回 null。 */
function fingerprintDir(dir) {
  if (!existsSync(dir)) return null;
  const files = walk(dir);
  if (files.length === 0) return null;
  return new Map(files.map((rel) => [rel, hashOf(join(dir, rel))]));
}

/** 路径是目录吗（不存在时按文件处理——缺失已在上游报过）。 */
function isDir(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

/**
 * 定位 tsdown 的可执行入口。
 *
 * 读它自己的 package.json#bin 而**不**硬编码 `dist/run.mjs`：那个文件名随版本
 * 变过（0.23 是 run.mjs，早期是 run.js），硬编码会在一次依赖升级后变成
 * MODULE_NOT_FOUND——而门禁自身的失败很容易被误读成「产物不新鲜」。
 */
function resolveTsdownBin() {
  const pkgPath = join(ROOT, "node_modules", "tsdown", "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error("node_modules/tsdown 不存在——本门禁需要 devDependencies（先 npm install）");
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  // bin 可能是 string，也可能是 { [name]: path }。
  const rel = typeof pkg.bin === "string"
    ? pkg.bin
    : pkg.bin?.[Object.keys(pkg.bin ?? {})[0]];
  if (typeof rel !== "string" || rel === "") {
    throw new Error(`tsdown 的 package.json#bin 不可解析（读到 ${JSON.stringify(pkg.bin)}）`);
  }
  return join(ROOT, "node_modules", "tsdown", rel);
}

/**
 * 从仓库的 tsdown.config.mjs 里取出 `NEVER_BUNDLE` 的字面量文本。
 *
 * 正则提取而非 import 那个文件：import 会踩三个加载器坑（裸 Windows 路径被当
 * URL scheme、Node 22 对顶层 await 的已知 bug、系统临时目录的父级 package.json）。
 * 用正则把**真实配置**里的清单搬进临时配置，本门禁比的就还是真实配置的产物——
 * 手抄一份则会在配置漂移时静默比错东西。
 * @param {string} source - tsdown.config.mjs 全文。
 * @returns {string|null} 形如 `"a",\n  "b"` 的字面量片段；取不到返回 null。
 */
function extractNeverBundleLiteral(source) {
  const match = source.match(/const\s+NEVER_BUNDLE\s*=\s*\[([\s\S]*?)\]\s*;/);
  return match === null ? null : match[1].trim();
}

/**
 * 临时构建配置的内容：仓库配置的镜像，只把 outDir 改道到 staging。
 * @param {string} staging - POSIX 形式的 staging 绝对路径。
 * @param {string} neverBundle - NEVER_BUNDLE 字面量片段。
 * @returns {string} 配置文件源码。
 */
function gateConfig(staging, neverBundle) {
  return `const defineConfig = (entries) => entries;
const NEVER_BUNDLE = [${neverBundle}];
const STAGING = ${JSON.stringify(staging)};
export default defineConfig([
  {
    name: "host",
    entry: ["src/host/index.ts"],
    outDir: STAGING + "/host",
    format: "esm",
    platform: "node",
    target: "es2023",
    splitting: false,
    clean: false,
    minify: false,
    sourcemap: false,
    dts: false,
    outExtensions: () => ({ js: ".js" }),
    deps: { neverBundle: [...NEVER_BUNDLE] }
  },
  {
    name: "client",
    entry: ["src/client/index.ts"],
    outDir: STAGING,
    format: "iife",
    platform: "browser",
    target: "es2020",
    deps: { neverBundle: ["react"] },
    outputOptions: {
      entryFileNames: "client.js",
      name: "dsh_connect_modelscope_token_plan_client"
    },
    clean: false,
    minify: false,
    sourcemap: false,
    dts: false
  }
]);
`;
}

const missing = ARTIFACTS.filter((a) => !existsSync(join(ROOT, a.repoPath)));
if (missing.length > 0) {
  bad(
    `入库产物缺失：${missing.map((a) => a.label).join("、")}——DSH 市场的 github: 安装源` +
    "不跑 prepack，没有入库产物则装出来的包没有入口。跑 npm run build 并把产物一起提交。"
  );
}

if (missing.length === 0) {
  const staging = mkdtempSync(join(tmpdir(), "dsh-ms-build-gate-"));
  // 临时配置写在**仓库内**（跑完即删）：放系统临时目录会让 tsdown 的模块解析
  // 撞上父级 package.json 而报 "Invalid package config"。staging 只用来放产物。
  const gateConfigPath = join(ROOT, ".build-gate.config.mjs");
  try {
    const neverBundle = extractNeverBundleLiteral(
      readFileSync(join(ROOT, "tsdown.config.mjs"), "utf8")
    );
    if (neverBundle === null) {
      throw new Error(
        "tsdown.config.mjs 里读不出 NEVER_BUNDLE 字面量——构建配置改了形状，本门禁需同步维护"
      );
    }
    writeFileSync(gateConfigPath, gateConfig(toPosix(staging), neverBundle), "utf8");

    execFileSync(
      process.execPath,
      [resolveTsdownBin(), "-c", gateConfigPath],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );

    // ── 逐目标比对：文件集合 + 逐文件哈希 ──
    for (const { repoPath, freshSub, label } of ARTIFACTS) {
      const repoAbs = join(ROOT, repoPath);
      const repoIsDir = isDir(repoAbs);
      const freshPrint = repoIsDir
        ? fingerprintDir(join(staging, freshSub))
        // 单文件目标：只认 staging 根下那**一个**文件。不能直接
        // fingerprintDir(staging)——staging 里还躺着 host/ 子目录（另一个条目的
        // 产物），会把它们算成 client.js 的「新构建有/入库无」。
        : (() => {
            const p = join(staging, repoPath);
            return existsSync(p) ? new Map([[repoPath, hashOf(p)]]) : null;
          })();

      if (freshPrint === null) {
        bad(`重新构建后${label}没有产物——构建 entry 或配置变了？本门禁的目标映射需要同步维护`);
        continue;
      }

      // 目录目标比整个目录；单文件目标只比那一个文件，不比整个包根（包根还有
      // package.json、README 等与构建产物无关的东西）。
      const repoPrint = fingerprintDir(repoIsDir ? repoAbs : dirname(repoAbs));
      const only = repoIsDir ? null : repoPath;
      const repoFiltered = repoPrint === null
        ? null
        : new Map([...repoPrint].filter(([rel]) => (only === null ? true : rel === only)));

      if (repoFiltered === null || repoFiltered.size === 0) {
        bad(`入库产物${label}读不出内容——请跑 npm run build`);
        continue;
      }

      const missingKeys = [...repoFiltered.keys()].filter((k) => !freshPrint.has(k));
      const extraKeys = [...freshPrint.keys()].filter((k) => !repoFiltered.has(k));
      const changed = [...repoFiltered.keys()]
        .filter((k) => freshPrint.has(k) && freshPrint.get(k) !== repoFiltered.get(k));

      if (missingKeys.length === 0 && extraKeys.length === 0 && changed.length === 0) {
        note(`${label}的 ${repoFiltered.size} 个产物与当前 src/ 逐字节同源`);
        continue;
      }

      const detail = [];
      if (changed.length > 0) detail.push(`内容已变：${changed.join("、")}`);
      if (missingKeys.length > 0) detail.push(`入库有/新构建无：${missingKeys.join("、")}`);
      if (extraKeys.length > 0) detail.push(`新构建有/入库无：${extraKeys.join("、")}`);
      bad(
        `${label} 与当前 src/ 不同源（${detail.join("；")}）。\n` +
        "        改了 src/ 忘了 build。修：npm run build && git add lib client.js\n" +
        "        （产物必须与源码同一个提交——分开提交会让市场短暂装到旧代码）"
      );
    }
  } catch (error) {
    const detail = [
      error.stdout ? String(error.stdout) : "",
      error.stderr ? String(error.stderr) : "",
      error.message
    ].join("\n").trim();
    bad(
      "构建失败，无法判定产物新鲜度（这本身是需要修的）：\n" +
      detail.split("\n").map((line) => `        ${line}`).join("\n")
    );
  } finally {
    rmSync(gateConfigPath, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

if (fails.length > 0) {
  console.error(`\nbuild-gate.mjs: ${fails.length} 条失败`);
  for (const f of fails) console.error(`  x - ${f}`);
  process.exit(1);
}
console.log("\nbuild-gate.mjs 全部通过");
