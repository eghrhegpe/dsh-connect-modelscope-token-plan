/**
 * family-kernel.test.mjs —— 同族复制的账本门禁（KERNEL.json 的兑现者）。
 *
 * ## 它守什么
 *
 * 本插件与 sensenova / agnes 是「受控复制」。2026-10-17 实测：与 sensenova 有 9 个
 * 内核文件重叠 ≥91.5%，与 agnes 只有 2 个——「受控」二字此前没有任何门禁，全靠
 * 头注自觉。本文件把**自称**变成红灯：
 *
 *   §1 内核重叠（**只报告，不判红**）：打印 KERNEL.json 的基线与实测重叠，以及账本里
 *      与姊妹没有同名配对的项。撤掉断言的理由见 §1 那段注释——它的输入是别人的仓库，
 *      在 CI 上不存在、在开发者机器上会因别人改动而红。基线退化成「给人看的趋势读数」。
 *   §2 宣称核对：drift 工具的 claimMismatch（头注自称同源、实测不同源）在姊妹
 *      仓库在场时必须是 0。**这是本文件唯一保留的硬断言**，因为它判的是**本仓自己的
 *      文档有没有说假话**（「抄错文档」那一类），而不是别人的文件长什么样。
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

  // ── §1 内核重叠：**只报告，不判红**（2026-10-17 裁定）──
  //
  // 这半边曾经断言 `overlap >= floor` 与「账本与磁盘无脱节」。撤掉的理由不是嫌它严，
  // 是它的**输入属于别的仓库**：floor 是「别人的文件今天长什么样」的函数，于是
  //   - CI（干净检出、姊妹仓库不在场）上这半边根本不存在，永远看不到；
  //   - 开发者机器上（姊妹恰好都在）它会因为你没碰过的那个仓库改了 `apply.ts` 而变红，
  //     而处方是「去改 KERNEL.json 的 floor」——一条把「别人变了」翻译成「你去改账本」
  //     的门禁，最终只会被橡皮图章式地放行。
  // 判据该判的是**我们自己能不能被检查**：§2 的宣称核对判的是本仓文档自称的同源度与
  // 实测是否相符（那是「抄错文档」的防线），保留为硬断言；数值重叠与账本在场性打印出来
  // 给人看，不进退出码。
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
      violations.push(`${file}  ${(pair.overlap * 100).toFixed(1)}%  < 基线 ${(floor * 100).toFixed(0)}%`);
    }
  }
  const driftNote = violations.length === 0
    ? "全部在基线上"
    : `跌破基线的 ${violations.length} 项：${violations.join("；")}`;
  console.log(
    `family-kernel: ${key} 重叠报告（非门禁）—— ${driftNote}` +
      (ghosts.length > 0 ? `；账本里与它没有同名配对的：${ghosts.join("、")}` : "")
  );

  // ── §2 宣称核对（唯一的硬断言：判的是本仓自己的文档）──
  const mismatches = report.mismatches ?? [];
  assert.deepEqual(
    mismatches,
    [],
    `与 ${key} 存在「头注自称同源、实测不同源」的宣称（这是**本仓文档说假话**，必须改文档，不是改判据）：\n  ${mismatches.map((m) => (typeof m === "string" ? m : `${m.file}  实测重叠 ${(m.overlap * 100).toFixed(0)}%`)).join("\n  ")}`
  );

  console.log(`family-kernel: ${key} ✓（宣称不符 0；重叠见上面那行报告，不进退出码）`);
}

const declared = Object.keys(KERNEL).filter((k) => k !== "_comment");
const verified = declared.filter((k) => byKey.has(k));
const missing = declared.filter((k) => !byKey.has(k));
console.log(
  `family-kernel.test.mjs: all checks passed（账本 ${declared.length} 仓：核验 ${verified.length}，不在场跳过 ${missing.length}）`
);
