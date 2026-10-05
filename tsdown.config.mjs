// @ts-check
/**
 * 构建配置（与姊妹插件同构）。`src/` 是全部源码（host + client + shared）；
 * `lib/` 与根 `client.js` 是**故意入库**的产物。DSH 市场用 **pnpm** 安装，而 pnpm
 * 对 **git 依赖一律拒绝执行构建脚本**（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，要解
 * 必须把包名加进 allowBuilds 白名单，装插件的用户没有这个入口）。所以「把 prepack
 * 换成 prepare、让安装时自构建」这条路是**死的**：npm 在 git 安装时确实会跑
 * prepare（已实测，2026-10-05），pnpm 不会。lib/ 不入库则装出来的包 main 不存在，
 * 卡片直接失效（理由见 .gitignore 与 sensenova 仓库 ADR-005）。新鲜度由
 * build-gate 把关——产物必须与源码同一个提交。
 *
 * `chunkFileNames: "[name].js"`（不含内容哈希）：改 src 时产物**原地修改**而非删旧
 * 加新，diff 不产生 `D` + `??` 噪音。build-gate 用正则从本文件提取这个命名方案作
 * 判定基准，不手抄第二份——手抄会在配置漂移时让门禁报「入库有/新构建无」，而真因
 * 是两边命名不一致，读起来像「改了 src 忘 build」，白烧一轮排查。
 *
 * 两个条目：
 * 1. HOST — src/host/index.ts 打成单入口 lib/index.js（esm/node）。离线测试
 *    直接 import 源码，不依赖 lib/ 的分块。
 * 2. CLIENT — src/client/index.ts 打成根 client.js（IIFE/browser）。IIFE 是
 *    承重决策不是风格：loader 以 script/module 两种世界求值都必须合法，且
 *    esm 构建会被 rolldown 包上 __commonJS 垫片、改写 loader ABI。
 */
import { defineConfig } from "tsdown";

/** peer 包必须从 Host 运行时解析，绝不打进产物。 */
const NEVER_BUNDLE = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-llm-pi-ai",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-host-webserver",
  "@deepseek-ai/schemastery",
  "@earendil-works/pi-ai",
];

export default defineConfig([
  {
    name: "host",
    entry: ["src/host/index.ts"],
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2023",
    splitting: false,
    clean: true,
    minify: false,
    sourcemap: false,
    dts: false,
    outExtensions: () => ({ js: ".js" }),
    outputOptions: {
      entryFileNames: "index.js",
      chunkFileNames: "[name].js"
    },
    deps: { neverBundle: [...NEVER_BUNDLE] },
  },
  {
    name: "client",
    entry: ["src/client/index.ts"],
    outDir: ".",
    format: "iife",
    platform: "browser",
    target: "es2020",
    // react 永远经 loader 的模块表解析，绝不打包：浏览器世界用自己的
    // require 物化 clientFactory，Node 套件给的是替身。
    deps: { neverBundle: ["react"] },
    outputOptions: {
      entryFileNames: "client.js",
      name: "dsh_connect_modelscope_token_plan_client",
    },
    // outDir 是仓库根（产物按契约在包根），这里的 clean 绝不能开。
    clean: false,
    minify: false,
    sourcemap: false,
    dts: false,
  },
]);
