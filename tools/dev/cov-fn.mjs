// 输出 client.js 内部每个具名函数的执行计数（counts=0 → 该函数从未被调用）。
// 用法: node tools/cov-fn.mjs [test] [artifactSubstring]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const test = process.argv[2] ?? "panel.test.mjs";
const match = process.argv[3] ?? "client.js";
const R = join(ROOT, ".cov-fn-runner.mjs");
writeFileSync(R, `import { writeFileSync } from "node:fs";\nprocess.on("exit", () => writeFileSync(".cov-fn-ok","1"));\n`);

const covDir = mkdtempSync(join(tmpdir(), "covfn-"));
try {
  execFileSync(process.execPath, ["--import", "./.cov-fn-runner.mjs", "test/" + test], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_V8_COVERAGE: covDir }
  });
} catch (e) { console.error("测试失败:", String(e.stderr ?? e.message).slice(0, 500)); }

const acc = new Map();
for (const f of readdirSync(covDir)) {
  const d = JSON.parse(readFileSync(join(covDir, f), "utf8"));
  for (const sc of d.result ?? []) {
    if (!sc.url.includes(match)) continue;
    for (const fn of sc.functions) {
      if (!fn.functionName) continue;
      const top = fn.ranges[0]?.count ?? 0;
      const cur = acc.get(fn.functionName) ?? { top: 0, partial: 0 };
      cur.top += top;
      // 内部 range 的 0 = 函数体内未执行的部分
      for (const r of fn.ranges) if (r.count === 0) cur.partial += r.endOffset - r.startOffset;
      acc.set(fn.functionName, cur);
    }
  }
}
rmSync(covDir, { recursive: true, force: true });
rmSync(R, { force: true });
rmSync(join(ROOT, ".cov-fn-ok"), { force: true });

const rows = [...acc].map(([n, v]) => ({ n, calls: v.top, deadBytes: v.partial }));
rows.sort((a, b) => a.calls - b.calls || b.deadBytes - a.deadBytes);
const never = rows.filter((r) => r.calls === 0);
const partial = rows.filter((r) => r.calls > 0 && r.deadBytes > 0);
console.log(`\n=== ${test} 驱动 ${match}：${rows.length} 个具名函数 ===`);
console.log(`从未调用 (${never.length}):`);
for (const r of never) console.log(`  0    ${r.n}`);
console.log(`\n被调用但体内有死分支 (${partial.length}):`);
for (const r of partial) console.log(`  ${String(r.calls).padStart(5)}  ${r.n}  (未执行 ${r.deadBytes}B)`);
