// draw-jobs.ts 的语义钉：两段式出图的会话内作业表。
//
// ## 为什么单独一个套件
//
// 这张表是「一次调用不再阻塞整轮对话」能成立的前提——没有它，agent 拿到的
// `jobId` 就换不回「上次那个任务」，分段查询只能靠 agent 自己记 `task_id`
// （而总放弃线所需的提交时刻根本记不了）。它不碰网络、不碰 peer，却能决定
// 续查这条路通不通，所以值得单独立一组钉。
//
// 钉的重点是**边界**而不是 happy path：表满淘汰、重复登记、取不到返回 null。
// 尤其是「取不到」——插件重启后表一定是空的，那里的行为必须是可操作的说明，
// 而不是一个莫名的失败。

import { strict as assert } from "node:assert";
import { createDrawJobs } from "../src/host/draw-jobs.ts";

const checks = [];
function section(name, body) {
  checks.push([name, body]);
}

// ── 登记与取出 ────────────────────────────────────────────────────────────────
section("jobId 就是上游 task_id（少一层映射，少一处漂移）", () => {
  const jobs = createDrawJobs();
  const job = jobs.create({ taskId: "t-1", model: "m/A", prompt: "a cat" });
  assert.equal(job.jobId, "t-1");
  assert.equal(job.taskId, "t-1", "两个字段都留着：读侧不必靠「刚好同值」这个巧合");
  assert.equal(jobs.get("t-1")?.taskId, "t-1");
});

section("提交时刻默认取当前，也可显式给（测试总放弃线要能造旧作业）", () => {
  const jobs = createDrawJobs();
  const fresh = jobs.create({ taskId: "t-1", model: "m", prompt: "p" });
  assert.ok(Math.abs(Date.now() - fresh.submittedAt) < 5_000, "不给 now 就取当前时刻");
  const old = jobs.create({ taskId: "t-2", model: "m", prompt: "p", now: 1_000 });
  assert.equal(old.submittedAt, 1_000);
});

section("get 返回副本：外部改动不能污染表", () => {
  const jobs = createDrawJobs();
  jobs.create({ taskId: "t-1", model: "m", prompt: "p" });
  const snapshot = jobs.get("t-1");
  assert.notEqual(snapshot, null);
  snapshot.polls = 999;
  assert.equal(jobs.get("t-1").polls, 0, "表里那条不该被外部改到");
});

// ── 累计轮询数 ────────────────────────────────────────────────────────────────
section("notePolls 跨调用累加（诊断「上游慢」要看全貌，不是单次的数）", () => {
  const jobs = createDrawJobs();
  jobs.create({ taskId: "t-1", model: "m", prompt: "p" });
  jobs.notePolls("t-1", 2);
  jobs.notePolls("t-1", 3);
  assert.equal(jobs.get("t-1").polls, 5);
});

section("notePolls 对不在表里的 id 静默（调用方已另有错误路径）", () => {
  const jobs = createDrawJobs();
  jobs.notePolls("nope", 5);
  assert.equal(jobs.size(), 0, "不该顺手把不认识的 id 建出来");
});

// ── 边界 ──────────────────────────────────────────────────────────────────────
section("容量满时淘汰最旧的一条（长跑会话不能把内存养成泄漏）", () => {
  // 软上限只淘汰**已过续查保护窗**的（越过总放弃线，找回来也只会换来「超过
  // 总预算」）；保护窗内的不淘汰——见下一个用例。
  const jobs = createDrawJobs({ maxJobs: 2, resumeWindowMs: 60_000 });
  const now = Date.now();
  jobs.create({ taskId: "t-1", model: "m", prompt: "p", now: now - 120_000 });
  jobs.create({ taskId: "t-2", model: "m", prompt: "p", now: now - 90_000 });
  jobs.create({ taskId: "t-3", model: "m", prompt: "p", now: now - 30_000 });
  assert.equal(jobs.size(), 2);
  assert.equal(jobs.get("t-1"), null, "最旧且已过保护窗的 t-1 应被淘汰");
  assert.notEqual(jobs.get("t-3"), null, "最新的必须还在");
});

section("续查保护窗内的作业不被容量淘汰（能续查的作业被杀 = 两段式残缺）", () => {
  // 2026-10-19 评审落地：旧 FIFO 会把仍在等待线内的 pending 作业淘汰掉，
  // agent 带 jobId 回来只换来「不在表中」，而上游任务还在跑。
  const jobs = createDrawJobs({ maxJobs: 2, resumeWindowMs: 60_000 });
  const now = Date.now();
  jobs.create({ taskId: "t-1", model: "m", prompt: "p", now: now - 10_000 });
  jobs.create({ taskId: "t-2", model: "m", prompt: "p", now: now - 5_000 });
  jobs.create({ taskId: "t-3", model: "m", prompt: "p", now });
  assert.equal(jobs.size(), 3, "三条都在保护窗内：软上限一条都不淘汰");
  assert.notEqual(jobs.get("t-1"), null, "最旧的也还在——它还没越过总放弃线");
});

section("硬上限保底：全是保护窗内的作业也绝不无界", () => {
  const jobs = createDrawJobs({ maxJobs: 2, resumeWindowMs: 60_000, hardMaxJobs: 3 });
  const now = Date.now();
  for (let i = 1; i <= 4; i++) jobs.create({ taskId: `t-${i}`, model: "m", prompt: "p", now: now - i * 1_000 });
  assert.equal(jobs.size(), 3, "超过硬上限淘汰最旧，保护窗不放弃有界性");
  assert.equal(jobs.get("t-1"), null, "最旧的 t-1 被硬上限淘汰");
  assert.notEqual(jobs.get("t-4"), null, "最新的必须还在");
});

section("同一个 id 重复登记：以新代旧，但保住累计轮询数", () => {
  const jobs = createDrawJobs();
  jobs.create({ taskId: "t-1", model: "m", prompt: "p" });
  jobs.notePolls("t-1", 4);
  jobs.create({ taskId: "t-1", model: "m2", prompt: "p2" });
  const job = jobs.get("t-1");
  assert.equal(job.model, "m2", "新登记的参数生效");
  assert.equal(job.polls, 4, "诊断计数不该被「重建作业」清零");
  assert.equal(jobs.size(), 1, "重复登记不该多占一格");
});

section("取不到返回 null——插件重启后表是空的，那里需要的是可操作说明", () => {
  const jobs = createDrawJobs();
  assert.equal(jobs.get("never-seen"), null, "不抛错：抛错会把「我不记得」伪装成「出图失败」");
});

section("drop 与 dispose：出图即出表、卸载即清空", () => {
  const jobs = createDrawJobs();
  jobs.create({ taskId: "t-1", model: "m", prompt: "p" });
  jobs.create({ taskId: "t-2", model: "m", prompt: "p" });
  jobs.drop("t-1");
  assert.equal(jobs.get("t-1"), null);
  assert.equal(jobs.size(), 1);
  jobs.dispose();
  assert.equal(jobs.size(), 0, "dispose 后不留残余（插件卸载不该留作业）");
});

// ── 跑 ────────────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, body] of checks) {
  try {
    await body();
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`  NOT OK - ${name}`);
    console.error(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed > 0) {
  console.error(`draw-jobs.test.mjs: ${failed} 组断言失败`);
  process.exit(1);
}
console.log(`draw-jobs.test.mjs 全部通过（${checks.length} 组）`);
