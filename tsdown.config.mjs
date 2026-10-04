// @ts-check
/**
 * 构建配置（与姊妹插件同构）。`src/` 是全部源码（host + client + shared）；
 * `lib/` 与根 `client.js` 是**故意入库**的产物——DSH 市场的 `github:` 安装源
 * 不跑 prepack，lib/ 不入库则装出来的包 main 不存在（理由见 .gitignore 与
 * sensenova 仓库 ADR-005）。新鲜度由 build-gate（后续接入）把关。
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
