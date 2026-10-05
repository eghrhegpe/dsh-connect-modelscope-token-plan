// 合并 V8 ranges（去重嵌套）后计算真实字节/行覆盖。
// 用法: node tools/cov-merge.mjs <test1> <test2> ...   (不带参 = 全部)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toPosix = (p) => p.split(sep).join("/");

/** 把 V8 的 count>0 ranges（可能互相嵌套）合并成不相交区间。 */
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

const targets = process.argv.slice(2);
const tests = targets.length ? targets
  : readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".mjs")).sort();

const acc = new Map(); // absPath -> {src, merged:[[a,b]], len}
function addFile(abs, ranges) {
  if (!acc.has(abs)) {
    const src = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    acc.set(abs, { src, merged: [], len: src.length });
  }
  acc.get(abs).merged.push(...merge(ranges));
}

for (const t of tests) {
  const covDir = mkdtempSync(join(tmpdir(), "covm-"));
  try {
    execFileSync(process.execPath, [join(ROOT, "test", t)], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_V8_COVERAGE: covDir }
    });
  } catch { /* 失败也收覆盖率 */ }
  for (const f of readdirSync(covDir)) {
    const d = JSON.parse(readFileSync(join(covDir, f), "utf8"));
    for (const sc of d.result ?? []) {
      let p; try { p = toPosix(fileURLToPath(sc.url)); } catch { continue; }
      if (!existsSync(p)) continue;
      if (!/[/\\](src[/\\].*\.ts|client\.js)$/.test(p)) continue;
      const rs = [];
      for (const fn of sc.functions) for (const r of fn.ranges) rs.push(r);
      addFile(p, rs);
    }
  }
  rmSync(covDir, { recursive: true, force: true });
}

function lineIndex(src) {
  const st = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) st.push(i + 1);
  return st;
}
function lineOf(st, off) {
  let lo = 0, hi = st.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (st[m] <= off) lo = m; else hi = m - 1; }
  return lo + 1;
}

const rows = [];
for (const [abs, { src, merged, len }] of acc) {
  const m2 = merge(merged.map(([a, b]) => ({ startOffset: a, endOffset: b, count: 1 })));
  const coveredBytes = m2.reduce((n, [a, b]) => n + (b - a), 0);
  const st = lineIndex(src);
  const totalLines = src.split("\n").length;
  const lines = new Set();
  for (const [a, b] of m2) { lines.add(lineOf(st, a)); lines.add(lineOf(st, Math.max(a, b - 1))); }
  rows.push({
    file: toPosix(relative(ROOT, abs)),
    bytes: len, coveredBytes, bpct: len ? +(coveredBytes / len * 100).toFixed(1) : 0,
    lines: totalLines, coveredLines: lines.size,
    lpct: totalLines ? +(lines.size / totalLines * 100).toFixed(1) : 0
  });
}
rows.sort((a, b) => a.bpct - b.bpct || a.file.localeCompare(b.file));
console.log("byte%   line%   file");
for (const r of rows) {
  const flag = r.bpct === 0 ? "ZERO" : r.bpct < 15 ? "LOW " : r.bpct < 40 ? "MID " : "    ";
  console.log(`${flag} ${String(r.bpct).padStart(5)}%  ${String(r.lpct).padStart(5)}%  ${r.file}`);
}
