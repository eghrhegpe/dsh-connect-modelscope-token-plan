// 通用变异测试：对给定源文件施加一组「真实回归」变异，跑指定测试文件，
// 报告哪些变异**没被抓住**（= 门禁盲区）。
//
// 用法: node tools/mutate.mjs <specFile.json>
// spec: [{ target, test, mutants: [{name, from, to}] }]
//
// 每个 mutant 用**逐字字符串替换**（from 必须唯一命中），未命中即报 NOT-APPLIED，
// 绝不猜。源文件在 finally 里从内存原文恢复。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// tools/dev/ 下的脚本要上溯两级才到仓库根（本文件在 tools/dev/）。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));

const allResults = [];
for (const group of spec) {
  const target = join(ROOT, group.target);
  if (!existsSync(target)) { console.log(`!! 目标不存在: ${group.target}`); continue; }
  const original = readFileSync(target, "utf8");
  console.log(`\n=== ${group.target}  ←  ${group.test} ===`);
  try {
    for (const m of group.mutants) {
      const occurrences = original.split(m.from).length - 1;
      if (occurrences !== 1) {
        console.log(`  NOT-APPLIED(${occurrences}) ${m.name}`);
        allResults.push({ ...m, group: group.target, verdict: `NOT-APPLIED(${occurrences})` });
        continue;
      }
      writeFileSync(target, original.replace(m.from, m.to), "utf8");
      let verdict = "STILL-GREEN (漏!)", detail = "";
      try {
        for (const t of [].concat(group.test)) {
          // `group.test` 是**仓库相对路径**（README 里写的就是 `test/xxx.test.mjs`，
          // spec 也一直这么填）。早先这里是 join(ROOT, "test", t)，会把 test/ 拼
          // 两次成 test/test/xxx —— 于是每个变异都因「模块找不到」而退出非零，
          // 被下面一律记成 KILLED。**整份审计因此全是假阳性**，而且看起来全绿。
          // 现在按路径语义解析：带 / 的当相对路径，裸文件名仍补 test/ 前缀。
          const rel = t.includes("/") ? t : join("test", t);
          // 硬超时：某些变异（如删掉 clearInterval）会让进程永不退出，
          // 没有超时整个审计会挂死。超时本身也是一种「没被抓住」——
          // 门禁跑不完 = 门禁失效，记为 HUNG。
          execFileSync(process.execPath, [join(ROOT, rel)], {
            cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
            timeout: 90_000, killSignal: "SIGKILL"
          });
        }
      } catch (e) {
        const killedByTimeout = e.killed === true || e.signal === "SIGKILL";
        const err = String(e.stderr ?? "");
        if (killedByTimeout) {
          verdict = "HUNG (挂死)";
          detail = "测试进程 90s 未退出——门禁跑不完";
        } else if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(err)) {
          // 测试**根本没跑起来**：不能算「抓到了变异」。这正是上面那个 join 拼错
          // 时的表现，当时被记成 KILLED，把整份审计变成假绿。
          verdict = "BROKEN (测试没跑起来)";
          detail = (err.split("\n").find((l) => /Cannot find module|Error:/.test(l)) ?? "").trim().slice(0, 120);
        } else {
          verdict = "KILLED (抓到)";
          detail = (err.split("\n").find((l) => /AssertionError|Error:/.test(l)) ?? "").trim().slice(0, 120);
        }
      } finally {
        writeFileSync(target, original, "utf8");
      }
      console.log(`  ${verdict.padEnd(22)} ${m.name}`);
      if (detail) console.log(`      ${detail}`);
      allResults.push({ ...m, group: group.target, verdict, detail });
    }
  } finally {
    writeFileSync(target, original, "utf8");
  }
}

const killed = allResults.filter((r) => r.verdict.startsWith("KILLED")).length;
const survived = allResults.filter((r) => r.verdict.startsWith("STILL")).length;
const hung = allResults.filter((r) => r.verdict.startsWith("HUNG")).length;
const na = allResults.filter((r) => r.verdict.startsWith("NOT")).length;
const broken = allResults.filter((r) => r.verdict.startsWith("BROKEN")).length;
console.log(`\n════ 汇总: 杀死 ${killed} / 漏过 ${survived} / 挂死 ${hung} / 未命中 ${na} / 没跑起来 ${broken} ════`);
if (survived || hung || broken) {
  console.log("\n门禁盲区（漏过 + 挂死 + 没跑起来）:");
  for (const r of allResults.filter((x) => x.verdict.startsWith("STILL") || x.verdict.startsWith("HUNG") || x.verdict.startsWith("BROKEN"))) {
    console.log(`  - [${r.group}] ${r.name}  → ${r.verdict}`);
  }
}
// 「杀死 N/漏过 0」只有在 N 条变异**真的跑起来**时才是好消息。全都没跑起来
// 时这个汇总看起来一样漂亮——所以这一行必须显式说明变异是否真的执行过。
if (broken) console.log("\n⚠ 有变异没跑起来：上面的「杀死」数与检出率都不可信，先修测试路径。");
