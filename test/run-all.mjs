/**
 * run-all.mjs —— npm test 的取代者：一条命令跑完全部离线套件。
 *
 * ## 它解决什么
 *
 * package.json 的 test 脚本原本是 `node a && node b && ...` 串 31 个文件。两个病：
 *   1. 新增套件要改 package.json 那一条超长行——忘了挂就**从不执行**。这条纪律
 *      原本由 `docs.test.mjs` §6① 守着（「test 脚本必须含每个文件名」），那是
 *      「记得登记」的自觉门禁；本文件把 glob 变成唯一事实源，登记这一步不存在了。
 *      §6① 随之前移为「package.json 的 test 必须是 `node test/run-all.mjs`」。
 *   2. && 链第一个红就停，后面 30 个套件的状态未知；CI 翻修一轮才知道全貌。
 *      本文件跑完全部再汇总，并支持 `--only` 过滤。
 *
 * ## 纪律承袭（env-hermetic §2 的立场，落在 runner 层）
 *
 * 每个套件在**独立子进程**里跑（隔离顶层 await 与模块状态——原样保留链式语义），
 * 并且 spawn 时统一删掉 MODELSCOPE_API_KEY / DSH_TOKEN_*：
 * 「靠每个测试记得清环境是守不住的」，runner 是那条纪律的物化。注意这不是完整
 * 的 hermeticity——suite 仍可读宿主其余 env（凭据文件按 DSH_HOME 隔离，由
 * env-hermetic §1 自己钉）。env-hermetic 的 §2 源码扫描保留：它抓「用 apply()
 * 却没传 env 缝」的**装配层泄漏**，与本文件的进程级剥离互补不重复。
 *
 * ## build-gate 永远最后
 *
 * 它是唯一的产物新鲜度门禁，跑在全套件的产物之上；顺序写死在这里，不随 glob 漂。
 *
 * 用法：
 *   node test/run-all.mjs                # 全部
 *   node test/run-all.mjs --only wire    # 只跑名字含 "wire" 的套件
 *   node test/run-all.mjs --jobs 4       # 并行度（默认 1，顺序与文件名同序）
 *
 * @module test/run-all
 */
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** 宿主令牌不得泄进子进程：runner 级剥离，见文件头「纪律承袭」。 */
const strippedEnv = { ...process.env };
delete strippedEnv.MODELSCOPE_API_KEY;
for (const k of Object.keys(strippedEnv)) {
  if (/^DSH_TOKEN_/.test(k)) delete strippedEnv[k];
}

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
const jobsIdx = argv.indexOf("--jobs");
const jobs = jobsIdx >= 0 ? Math.max(1, Number(argv[jobsIdx + 1]) || 1) : 1;

const suites = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !only || f.includes(only))
  .sort()
  .map((f) => join(TEST_DIR, f));
// build-gate 不在 .test.mjs 里：它永远是最后一个（产物新鲜度门禁，见文件头）。
if (!only) suites.push(join(TEST_DIR, "build-gate.mjs"));

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      cwd: process.cwd(),
      env: strippedEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let tail = "";
    const cap = 4000; // 失败时只回放末尾：全量 31 套件的 stdout 会把终端埋掉
    child.stdout.on("data", (d) => {
      tail += d;
      if (tail.length > cap) tail = tail.slice(-cap);
    });
    child.stderr.on("data", (d) => {
      tail += d;
      if (tail.length > cap) tail = tail.slice(-cap);
    });
    child.on("close", (code) => resolve({ file, code, tail }));
    child.on("error", (err) => resolve({ file, code: -1, tail: String(err) }));
  });
}

const failed = [];
let done = 0;
const started = Date.now();
const label = (f) => f.replace(/^.*[\\/]/, "");

async function worker(list) {
  for (const file of list) {
    const r = await runSuite(file);
    done += 1;
    const tag = `[${done}/${suites.length}] ${label(file)}`;
    if (r.code === 0) {
      const last = r.tail.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
      console.log(`${tag}  ok  ${last.slice(0, 90)}`);
    } else {
      failed.push(r);
      console.log(`${tag}  FAIL (exit ${r.code})`);
    }
  }
}

// 轮转分片：--jobs n 时套件 i 交给 worker i%n，保持同序文件不相撞。
const shards = Array.from({ length: jobs }, (_, i) => suites.filter((_, j) => j % jobs === i));
await Promise.all(shards.map(worker));

const secs = ((Date.now() - started) / 1000).toFixed(1);
if (failed.length > 0) {
  for (const r of failed) {
    console.log(`\n=== ${label(r.file)} 输出末尾 ===\n${r.tail}`);
  }
  console.log(`\nnpm test：${failed.length}/${suites.length} 套件失败（${secs}s）`);
  process.exit(1);
}
console.log(`\nnpm test 全部通过（${suites.length} 套件，${secs}s）`);
