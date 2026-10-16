/**
 * family-kernel.test.mjs —— 同族复制的账本门禁（KERNEL.json 的兑现者）。
 *
 * ## 它守什么
 *
 * 本插件与 sensenova / agnes 是「受控复制」。2026-10-17 实测：与 sensenova 有 9 个
 * 内核文件重叠 ≥91.5%，与 agnes 只有 2 个——「受控」二字此前没有任何门禁，全靠
 * 头注自觉。本文件把账本变成红灯：
 *
 *   §1 内核重叠：KERNEL.json 按姊妹仓库列 floor，跌破即红。内核文件在姊妹仓库里
 *      没有同名配对 = 账本与实测脱节，同样红。
 *   §2 宣称核对：drift 工具的 claimMismatch（头注自称同源、实测不同源）在姊妹
 *      仓库在场时必须是 0——这是 `--strict` 语义的升格：从「有人手动跑诊断」变成
 *      「每次 npm test 都在跑」。
 *
 * ## 判据只有一份
 *
 * 行集合重叠（剥注释后的 Jaccard）与 LCS 的取舍、以及「行一中一英骗过 diff 行数」
 * 这类坑，tools/dev/cross-repo-drift.mjs 已用实测论证并写死。本文件**不复制判据**，
 * 以子进程跑该工具读 `--json` 输出——判据漂移只会发生一次，发生在这里就红在这里。
 *
 * ## 姊妹仓库不在场 = 明说后放行
 *
 * 与 drift 工具同语义：别人的 checkout 里没有那三个仓库不是错误，是本门禁的常态
 * （CI 上必然走这条路）。所以它给 CI 的语义是 skip，给本机的语义是 ledger——
 * 「夜检」不需要 cron：任何一次本机 `npm test` 就是检查本身。
 *
 * @module test/family-kernel
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KERNEL = JSON.parse(readFileSync(join(ROOT, "KERNEL.json"), "utf8"));
const TOOL = join(ROOT, "tools", "dev", "cross-repo-drift.mjs");

const proc = spawnSync(process.execPath, [TOOL, "--json"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024
});
assert.equal(proc.status, 0, `cross-repo-drift.mjs 退出码 ${proc.status}：${proc.stderr?.slice(0, 500)}`);
const { reports } = JSON.parse(proc.stdout);
const byKey = new Map(reports.map((r) => [r.siblingKey, r]));

for (const [key, spec] of Object.entries(KERNEL)) {
  if (key === "_comment") continue;
  const report = byKey.get(key);
  if (!report) {
    // 缺席判据用 drift 自己的发现结果（byKey），而不是 spec.siblingDir 是否存在：
    // 后者在仓库目录存在但 src/ 缺失时也会被 drift 排除，那时账本该显式红，不该静默跳。
    console.log(`family-kernel: 姊妹仓库 ${key} 不在场，跳过其账本（本机同族开发机才会核验）`);
    continue;
  }

  // ── §1 内核重叠 ──
  const pairByFile = new Map(report.pairs.map((p) => [p.file, p]));
  const violations = [];
  const ghosts = [];
  for (const [file, floor] of Object.entries(spec.files)) {
    const pair = pairByFile.get(file);
    if (!pair) {
      ghosts.push(file);
      continue;
    }
    if (pair.overlap < floor - 1e-9) {
      violations.push(`${file}  实测重叠 ${(pair.overlap * 100).toFixed(1)}%  < floor ${(floor * 100).toFixed(0)}%`);
    }
  }
  assert.deepEqual(
    ghosts,
    [],
    `KERNEL.json 里这些文件与 ${key} 没有同名配对（账本与磁盘脱节，改账本或改代码，二选一，都要明着改）：\n  - ${ghosts.join("\n  - ")}`
  );
  assert.deepEqual(
    violations,
    [],
    `与 ${key} 的内核文件跌破 floor（跌破 = 出现了结构分家，合法分家请显式改 KERNEL.json 的 floor 并说明理由）：\n  ${violations.join("\n  ")}`
  );

  // ── §2 宣称核对（--strict 语义升格）──
  const mismatches = report.mismatches ?? [];
  assert.deepEqual(
    mismatches,
    [],
    `与 ${key} 存在「头注自称同源、实测不同源」的宣称：\n  ${mismatches.map((m) => (typeof m === "string" ? m : `${m.file}  实测重叠 ${(m.overlap * 100).toFixed(0)}%`)).join("\n  ")}`
  );

  console.log(`family-kernel: ${key} ✓（内核 ${Object.keys(spec.files).length} 项全过 floor，宣称不符 0）`);
}

const declared = Object.keys(KERNEL).filter((k) => k !== "_comment");
const verified = declared.filter((k) => byKey.has(k));
const missing = declared.filter((k) => !byKey.has(k));
console.log(
  `family-kernel.test.mjs: all checks passed（账本 ${declared.length} 仓：核验 ${verified.length}，不在场跳过 ${missing.length}）`
);
