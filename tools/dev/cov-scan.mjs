// 覆盖率扫描器：对每个 test/*.mjs 单独跑，收集 NODE_V8_COVERAGE，
// 归并到 src/**/*.ts，输出「文件级」与「行级」覆盖。
// 用法: node tools/cov-scan.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const toPosix = (p) => p.split(sep).join("/");

// ── 枚举被测源文件 ──
function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
      out.push(toPosix(relative(base, full)));
    }
  }
  return out;
}
const SRC_FILES = [...walk(join(ROOT, "src"))].sort();
const SRC_ABS = new Map(SRC_FILES.map((r) => [toPosix(join(ROOT, "src", r)), r]));

const TESTS = readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".mjs")).sort();

// ── 跑每个测试，收集覆盖 ──
// fileCoverage: Map<relSrcPath, { ranges: [[start,end,count]], }>
const perTest = new Map();
const globalRanges = new Map(); // rel -> [[s,e,count]]

for (const t of TESTS) {
  const covDir = mkdtempSync(join(tmpdir(), "cov-"));
  let ok = true;
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [join(ROOT, "test", t)], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_V8_COVERAGE: covDir }
    });
  } catch (e) {
    ok = false;
    stdout = String(e.stdout || "") + String(e.stderr || "");
  }
  const touched = new Set();
  for (const f of readdirSync(covDir)) {
    const data = JSON.parse(readFileSync(join(covDir, f), "utf8"));
    for (const script of data.result ?? []) {
      let p;
      try { p = toPosix(fileURLToPath(script.url)); } catch { continue; }
      const rel = SRC_ABS.get(p);
      if (!rel) continue;
      touched.add(rel);
      const fn = script.functions;
      // 合并该 script 的所有函数 range（顶层 + 内部）
      const list = [];
      for (const f2 of fn) {
        for (const r of f2.ranges) {
          if (r.count === 0) continue;
          list.push([r.startOffset, r.endOffset, r.count]);
        }
      }
      if (!globalRanges.has(rel)) globalRanges.set(rel, []);
      globalRanges.get(rel).push(...list);
    }
  }
  perTest.set(t, { touched, ok, stdout });
  rmSync(covDir, { recursive: true, force: true });
}

// ── 行级映射：用 source-map-free 的 offset→line（strip-types 后行号可能偏移，
//     所以同时报告「字节覆盖区间数」和「行覆盖」两套，以字节为准更可靠）──
function offsetToLines(path) {
  const src = readFileSync(path, "utf8");
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
  return (off) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

const report = [];
for (const rel of SRC_FILES) {
  const abs = join(ROOT, "src", rel);
  const src = readFileSync(abs, "utf8");
  const totalLines = src.split("\n").length;
  const ranges = globalRanges.get(rel) ?? [];
  const covered = new Set();
  if (ranges.length) {
    const o2l = offsetToLines(abs);
    for (const [s, , c] of ranges) if (c > 0) { covered.add(o2l(s)); covered.add(o2l(s + 1)); }
  }
  const tests = [...perTest.entries()].filter(([, v]) => v.touched.has(rel)).map(([k]) => k);
  report.push({
    rel, totalLines, coveredLines: covered.size,
    pct: totalLines ? +(covered.size / totalLines * 100).toFixed(1) : 0,
    rangeCount: ranges.length, tests
  });
}

const out = { generatedAt: new Date().toISOString(), srcFiles: SRC_FILES.length, report,
  testStatus: [...perTest].map(([k, v]) => ({ test: k, ok: v.ok })) };
writeFileSync(join(tmpdir(), "cov-report.json"), JSON.stringify(out, null, 2));

console.log(`\n=== 文件级覆盖（${SRC_FILES.length} 个源文件）===`);
console.log("pct    lines  ranges  file");
for (const r of report.sort((a, b) => a.pct - b.pct || a.rel.localeCompare(b.rel))) {
  const flag = r.pct === 0 ? "ZERO" : r.pct < 40 ? "LOW " : "    ";
  console.log(`${flag} ${String(r.pct).padStart(5)}%  ${String(r.coveredLines).padStart(4)}/${String(r.totalLines).padEnd(4)} ${String(r.rangeCount).padStart(5)}  ${r.rel}`);
}
console.log("\n=== 每个测试触碰到的源文件 ===");
for (const [t, v] of perTest) {
  console.log(`${v.ok ? "PASS" : "FAIL"} ${t}  ->  ${[...v.touched].sort().join(", ") || "(无 src 覆盖)"}`);
}
console.log("\nJSON: " + join(tmpdir(), "cov-report.json"));
