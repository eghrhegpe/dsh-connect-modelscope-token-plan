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

// ── §0 `--json` 契约：姊妹不在场时 stdout 必须仍是 JSON ──
//
// 这条排在一切之前，因为它守的是**下面那次调用本身**能否被解读。缺席分支是 CI 的常态
// （别人的 checkout 里没有同族仓库），也正是它把本门禁连红过两个提交：工具曾把人话打进
// stdout 再 exit(0)，上面的 JSON.parse 在第一个字符处就炸，「不在场 = skip」这条写在本
// 文件头注里的语义从未生效过。判据：同一个 `--json` 调用，absence 下仍然可解析。
//
// 用不存在的 `--sibling` 强制走缺席分支——不依赖机器上恰好有没有同族仓库（本地/CI 同判）。
{
  const absentArgs = ["--json", "--sibling", join(ROOT, "no-such-sibling-repo")];
  const absent = spawnSync(process.execPath, [TOOL, ...absentArgs], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(absent.status, 0, `姊妹不在场时退出码必须是 0（skip 不是失败），实得 ${absent.status}`);
  let parsed;
  try {
    parsed = JSON.parse(absent.stdout);
  } catch {
    assert.fail(
      "--json 在姊妹不在场时输出了非 JSON 的 stdout（机器可读契约被破坏，调用方必然炸）：\n" +
      absent.stdout.slice(0, 300)
    );
  }
  assert.deepEqual(parsed.reports, [], "姊妹不在场时 reports 应是空数组，而不是把人话混进 stdout");
  assert.match(
    absent.stderr,
    /未发现姊妹仓库/,
    "缺席的**原因**必须仍然说给使用者听——只是改道 stderr，不许沉默"
  );

  // 缺席也不许被 --strict 升格成失败：那条语义只针对「宣称与实测不符」。
  const strictAbsent = spawnSync(process.execPath, [TOOL, ...absentArgs, "--strict"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(
    strictAbsent.status,
    0,
    `--strict 下姊妹不在场仍应是 skip（CI 语义），实得退出码 ${strictAbsent.status}`
  );
  console.log("family-kernel: §0 --json 契约（不在场 → reports:[]，原因在 stderr，--strict 不升格）✓");
}

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
