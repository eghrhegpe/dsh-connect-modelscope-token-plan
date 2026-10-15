// 一次性可行性探针（不入库）：从 DSH 安装目录的 app.asar 里找出宿主浏览器侧真正注入的
// React 版本——决定「用真 react-dom 做渲染门禁」值不值的关键事实：测试用的 React
// 必须与线上 loader 表里那个是同一个大版本，否则门禁测的是另一个 reconciler。
// 用法：node tools/dev/probe-host-react.mjs [asar 路径]
import { createReadStream } from "node:fs";

const TARGET = process.argv[2] ?? "C:\\Users\\zhujieling11\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";
const NEEDLE = "bundleType";

const stream = createReadStream(TARGET, { highWaterMark: 4 << 20 });
let carry = "";
let offset = 0;
const hits = [];
const VERSION_RE = /bundleType:\s*[01]\s*,\s*version:\s*"(\d+\.\d+\.\d+[^"]*)"/g;

for await (const chunk of stream) {
  const text = carry + chunk.toString("latin1");
  for (const m of text.matchAll(VERSION_RE)) {
    hits.push({ at: offset - carry.length + m.index, version: m[1] });
  }
  // 卷动：保留尾部 4KB 以免 needle 横跨块边界
  carry = text.slice(-4096);
  offset += chunk.length;
}

const tally = new Map();
for (const h of hits) tally.set(h.version, (tally.get(h.version) ?? 0) + 1);
console.log(`asar: ${TARGET}`);
console.log(`命中 React devtools 注册点 ${hits.length} 处`);
for (const [version, n] of [...tally.entries()].sort()) console.log(`  React ${version}  ×${n}`);
if (!tally.size) console.log("  （没找到 bundleType/version 形态的注册点——可能是压缩改写或根本没打包 React）");
