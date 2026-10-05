// check-market-entry.mjs —— 临时校验：把发布指令里的 yml 代码块抽出来，用真正的
// YAML 解析器过一遍（市场 CI 就是这么查的——描述里含 ": " 而未加引号会直接解析失败）。
//
// 用法：node tools/check-market-entry.mjs <含yml 代码块的 md> [提供 yaml 模块的仓目录]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const md = readFileSync(process.argv[2], "utf8");
const fence = "```yaml\n";
const start = md.indexOf(fence);
if (start < 0) {
  console.error("未找到 yaml 代码块");
  process.exit(1);
}
const bodyStart = start + fence.length;
const end = md.indexOf("\n```", bodyStart);
const yml = md.slice(bodyStart, end);

console.log(`提取的 yml（${yml.split("\n").length} 行）：`);
console.log(yml);
console.log("--- 用 YAML 解析器实检 ---");

let yaml;
try {
  const require = createRequire(import.meta.url);
  yaml = require(join(process.argv[3], "node_modules", "yaml"));
} catch {
  console.error("找不到 yaml 模块，跳过解析（仅做人工检查）");
  process.exit(2);
}

const d = yaml.parse(yml);
const KNOWN = ["url", "name", "category", "description", "tarball"];
console.log("解析成功 ✓");
console.log("  url      :", d.url);
console.log("  name     :", d.name);
console.log("  category :", d.category);
console.log("  en 必填且以句号结尾:", Boolean(d.description?.en?.endsWith(".")));
console.log("  zh 以中文句号结尾  :", Boolean(d.description?.zh?.endsWith("。")));
console.log("  含 npm: 字段（CI 会拒，须为 false）:", "npm" in d);
console.log("  含 screenshots 字段（应 false，走仓库自己的 screenshots.json）:", "screenshots" in d);
console.log("  含 tarball（本仓从源码安装，应 false）:", "tarball" in d);
console.log("  多余字段:", Object.keys(d).filter((k) => !KNOWN.includes(k)).join(",") || "无");
