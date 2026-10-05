// 测 client.js（产物）被 panel.test.mjs 实际执行的比例——合并嵌套 range。
// 用法: node tools/cov-bundle.mjs <test> <artifact>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toPosix = (p) => p.split(sep).join("/");
const OUT = join(ROOT, ".cov-bundle.json");
const RUNNER = join(ROOT, ".cov-brunner.mjs");

// 不包装，只用 V8 offset；client.js 无 type-strip，offset 与磁盘字节一致（ASCII）
writeFileSync(RUNNER, `import { writeFileSync } from "node:fs";\nprocess.on("exit", () => writeFileSync(${JSON.stringify(OUT)}, "1"));\n`);

function merge(ranges) {
  const s = ranges.filter((r) => r.count > 0).map((r) => [r.startOffset, r.endOffset]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const test = process.argv[2] ?? "panel.test.mjs";
const artifact = process.argv[3] ?? "client.js";
const covDir = mkdtempSync(join(tmpdir(), "covb-"));
execFileSync(process.execPath, ["--import", "./.cov-brunner.mjs", "test/" + test], {
  cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NODE_V8_COVERAGE: covDir }
});

const abs = join(ROOT, artifact);
const src = readFileSync(abs, "utf8");
const all = [];
for (const f of readdirSync(covDir)) {
  const d = JSON.parse(readFileSync(join(covDir, f), "utf8"));
  for (const sc of d.result ?? []) {
    let p; try { p = toPosix(fileURLToPath(sc.url)); } catch { continue; }
    if (!p.endsWith(toPosix(artifact))) continue;
    for (const fn of sc.functions) for (const r of fn.ranges) all.push(r);
  }
}
rmSync(covDir, { recursive: true, force: true });
rmSync(RUNNER, { force: true });
rmSync(OUT, { force: true });

const m = merge(all);
const covered = m.reduce((n, [a, b]) => n + (b - a), 0);
const st = [0]; for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) st.push(i + 1);
const lineOf = (o) => { let lo = 0, hi = st.length - 1; while (lo < hi) { const m2 = (lo + hi + 1) >> 1; if (st[m2] <= o) lo = m2; else hi = m2 - 1; } return lo + 1; };
const lines = new Set(); for (const [a, b] of m) { lines.add(lineOf(a)); lines.add(lineOf(Math.max(a, b - 1))); }
const totalLines = src.split("\n").length;

console.log(`artifact: ${artifact}  (由 ${test} 驱动)`);
console.log(`字节覆盖: ${covered} / ${src.length}  = ${(covered / src.length * 100).toFixed(1)}%`);
console.log(`行覆盖(触及行): ${lines.size} / ${totalLines} = ${(lines.size / totalLines * 100).toFixed(1)}%`);
console.log(`未执行区间数: ${m.length}`);
// 打印最大的几个未覆盖块，定位死代码
const gaps = [];
for (let i = 1; i < m.length; i++) gaps.push([m[i - 1][1], m[i][0]]);
gaps.push([m.length ? m[m.length - 1][1] : 0, src.length]);
gaps.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
console.log(`\n最大未执行块 top10 (行区间, 字节数):`);
for (const [a, b] of gaps.slice(0, 10)) {
  if (b - a < 200) continue;
  const seg = src.slice(a, Math.min(b, a + 220)).replace(/\n/g, " ⏎ ");
  console.log(`  L${lineOf(a)}-${lineOf(b)} (${b - a}B): ${seg}`);
}
