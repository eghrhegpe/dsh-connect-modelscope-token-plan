// context-catalog-drift.test.mjs —— 策展表漂移检查器：纯逻辑分类 + CLI 退出码，零网络。
//
// 守两道：
//   ① `tools/lib/curated-drift.mjs` 的判定语义（内存夹具）：匹配路径、众数、
//      canon 决胜、拼写差容忍、六类分类的边界。这些判据钉的是 2026-10-23 四轮
//     探针迭代出来的定稿算法——不钉就会漂回「随手一版」。
//   ② `tools/check-context-catalog.mjs` 的退出码契约（--from 夹具 + spawn 真字节）：
//     干净 0 / 漂移 1 / 用法错 2 / 输入坏 1（ERROR 前缀）。退出码是这个工具与
//     每周定时档之间的全部接口，错了要么静默（该红没红）、要么狼来了（拼写差
//     每周判红，三天后没人再读）。
//
// 夹具 api.json 的形状照抄 models.dev：provider → models → 模型键**不带 owner
// 前缀**，canonical_model_id 带（`deepseek/deepseek-v4-pro`）。魔搭目录 id 带
// owner 前缀（`deepseek-ai/DeepSeek-V4-Pro`）——靠尾段匹配攀亲，这正是被测算法
// 的核心路径，fixture 必须复现这个形状差，不能图省事两边都写成一样的。
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPELLING_TOLERANCE,
  actionableCount,
  buildUpstreamIndex,
  deriveWindow,
  diffCuratedTable,
} from "../tools/lib/curated-drift.mjs";
import { CURATED_CONTEXT_WINDOWS } from "../src/host/context-catalog.ts";

// ── ① 纯逻辑 ────────────────────────────────────────────────────────────────

/** 造一个模型条目（models.dev 形状）。 */
const model = (context, { canon, input = ["text"], output = ["text"] } = {}) => ({
  ...(canon === undefined ? {} : { canonical_model_id: canon }),
  ...(context === undefined ? {} : { limit: { context } }),
  modalities: { input, output },
});

/** 造 api.json：[[providerId, {模型键: 模型}], ...]。 */
const apiJsonOf = (providers) => ({
  providers: Object.fromEntries(providers.map(([providerId, models]) => [providerId, { models }])),
});

// 索引与统计：没有 limit.context 的模型不计入；形状不认必须抛（不能安静地空转）。
{
  const index = buildUpstreamIndex(
    apiJsonOf([
      ["deepseek", { "deepseek-v4-pro": model(1048576, { canon: "deepseek/deepseek-v4-pro" }) }],
      ["openrouter", { "deepseek-v4-pro": model(1048576, { canon: "deepseek/deepseek-v4-pro" }), "no-limit": model(undefined) }],
    ])
  );
  assert.equal(index.stats.providers, 2, "两个带 models 的 provider");
  assert.equal(index.stats.models, 2, "没有 limit.context 的模型不计入模型数");
  assert.throws(() => buildUpstreamIndex({ nope: true }), /一个带 limit.context 的模型都没读到/, "没有 providers 键时按顶层映射宽容解读，读空了一样抛");
  assert.throws(() => buildUpstreamIndex(null), /形状不认识/, "null → 抛");
  assert.throws(() => buildUpstreamIndex({ providers: { a: { models: {} } } }), /一个带 limit.context 的模型都没读到/, "空索引必须抛——读不出东西而报「没有差异」是绿灯撒谎");
}

// 匹配路径：整串优先、尾段兜底；众数取多数、并列取小。
{
  const index = buildUpstreamIndex(
    apiJsonOf([
      ["deepseek", { "deepseek-v4-pro": model(1048576, { canon: "deepseek/deepseek-v4-pro" }) }],
      ["openrouter", { "deepseek-v4-pro": model(1048576, { canon: "deepseek/deepseek-v4-pro" }) }],
      ["novita", { "deepseek-v4-pro": model(1000000, { canon: "deepseek/deepseek-v4-pro" }) }],
    ])
  );
  const hit = deriveWindow(index, "deepseek-ai/DeepSeek-V4-Pro");
  assert.equal(hit?.value, 1048576, "尾段匹配命中；3 个 host 里 2 个 1048576 → 众数 1048576");
  assert.equal(hit?.hosts, 3, "hosts = 收录该 canon 的 provider 数");
  assert.equal(hit?.canon, "deepseek/deepseek-v4-pro", "canon 上报，攀错亲时人能一眼看出");
  assert.deepEqual(hit?.input, ["text"], "modalities.input 并集");
  assert.equal(deriveWindow(index, "no/such-model"), null, "未收录 → null（兜底留给调用方）");
  assert.equal(deriveWindow(index, ""), null, "空 id → null");
  assert.equal(deriveWindow(index, undefined), null, "非字符串 → null");
}
{
  // 众数并列 → 取小（宁可少算窗口，不放大）。
  const index = buildUpstreamIndex(
    apiJsonOf([
      ["a", { "tie-flash": model(1048576, { canon: "a/tie-flash" }) }],
      ["b", { "tie-flash": model(1000000, { canon: "a/tie-flash" }) }],
    ])
  );
  assert.equal(deriveWindow(index, "x/Tie-Flash")?.value, 1000000, "众数并列取较小值");
}

// canon 决胜：候选多时取收录 host 数最多；并列取字典序最小（确定性）。
{
  const index = buildUpstreamIndex(
    apiJsonOf([
      ["aaa", { "shared-model": model(100000, { canon: "aaa/shared-model" }) }],
      ["x1", { "shared-model": model(200000, { canon: "x/shared-model" }) }],
      ["x2", { "shared-model": model(200000, { canon: "x/shared-model" }) }],
      ["x3", { "shared-model": model(200000, { canon: "x/shared-model" }) }],
    ])
  );
  const hit = deriveWindow(index, "owner/Shared-Model");
  assert.equal(hit?.canon, "x/shared-model", "3 hosts 打败 1 host——多数胜过孤证");
  assert.equal(hit?.value, 200000);
}
{
  const index = buildUpstreamIndex(
    apiJsonOf([
      ["bbb", { "tie-model": model(200000, { canon: "bbb/tie-model" }) }],
      ["aaa", { "tie-model": model(300000, { canon: "aaa/tie-model" }) }],
    ])
  );
  const hit = deriveWindow(index, "owner/Tie-Model");
  assert.equal(hit?.canon, "aaa/tie-model", "host 数并列 → 字典序最小，保证每次跑同一答案");
  assert.equal(hit?.value, 300000);
}

// 分类边界：六类各自的门槛 + catalogIds=null 时三类不判。
{
  const index = buildUpstreamIndex(
    apiJsonOf([
      ["deepseek", { "ds-stable": model(1048576, { canon: "d/ds-stable" }), "ds-spelling": model(1000000, { canon: "d/ds-spelling" }), "ds-drift": model(131072, { canon: "d/ds-drift" }), "ds-new": model(1048576, { canon: "d/ds-new" }) }],
      ["alibaba", { "qw-unsourced": model(undefined) }],
      ["vendor", { "img-gen": model(262144, { canon: "v/img-gen", output: ["image"] }) }],
    ])
  );
  const curated = {
    "deepseek-ai/DS-Stable": 1048576,
    "deepseek-ai/DS-Spelling": 1048576, // live 1000000，差 4.76% ≤ 5% → 拼写
    "deepseek-ai/DS-Drift": 262144, // live 131072，差 50% → 漂移
    "deepseek-ai/DS-NoSource": 256000, // 上游推不出
    "old/Gone-Model": 200000, // 不在目录里
  };
  const catalogIds = ["deepseek-ai/DS-Stable", "deepseek-ai/DS-Spelling", "deepseek-ai/DS-Drift", "deepseek-ai/DS-NoSource", "deepseek-ai/DS-New", "alibaba/QW-Unsourced", "vendor/Img-Gen"];
  const report = diffCuratedTable(curated, index, catalogIds);

  assert.equal(report.stable, 1, "完全一致 → stable");
  assert.deepEqual(report.spelling.map((r) => r.id), ["deepseek-ai/DS-Spelling"], "≤5% 的十进制/二进制差 → spelling（不红）");
  assert.deepEqual(report.drifted.map((r) => r.id), ["deepseek-ai/DS-Drift"], ">5% → drifted（红）");
  assert.deepEqual(report.unverifiable.map((r) => r.id), ["deepseek-ai/DS-NoSource"], "在目录里但上游推不出 → 无佐证（备注）");
  assert.deepEqual(report.delisted.map((r) => r.id), ["old/Gone-Model"], "表里有、目录没有 → 该删");
  assert.deepEqual(report.missing.map((r) => r.id), ["deepseek-ai/DS-New", "vendor/Img-Gen"], "目录在、上游有、表里没有 → 该补（含被标记的非对话模型）");
  assert.deepEqual(report.unsourced, ["alibaba/QW-Unsourced"], "目录在、上游没有 → 无源（信息项）");
  assert.equal(report.missing[0].chatworthy, true, "text 进 text 出 → 对话模型");
  assert.equal(actionableCount(report), 4, "该补 2（DS-New + Img-Gen）+ 该复核 1 + 该删 1（拼写/无佐证/无源不计数）");

  // 生图模型（output 只有 image）进 missing 时必须被标记——纪律 4 不收。
  const imgReport = diffCuratedTable({}, index, ["vendor/Img-Gen"]);
  assert.equal(imgReport.missing.length, 1, "上游推得出的生图模型也会进 missing——但带非对话标记");
  assert.equal(imgReport.missing[0].chatworthy, false, "output 不含 text → chatworthy=false，等人确认");

  // 目录未知：missing/delisted/unsourced 三类不判，漂移侧照常。
  const noCatalog = diffCuratedTable(curated, index, null);
  assert.equal(noCatalog.catalogKnown, false, "标记目录未知");
  assert.deepEqual(noCatalog.missing, [], "没有目录事实就不能说「该补」");
  assert.deepEqual(noCatalog.delisted, [], "没有目录事实就不能说「该删」");
  assert.deepEqual(noCatalog.unsourced, [], "没有目录事实就没有「无源」");
  assert.deepEqual(noCatalog.drifted.map((r) => r.id), ["deepseek-ai/DS-Drift"], "漂移侧不依赖目录");
}

// 容忍度常数本身：5% 卡在「同量级两种进制拼写」与「量级差」之间。
assert.equal(SPELLING_TOLERANCE, 0.05, "1MiB/1M=4.86%、256KiB/256K=2.4% 算拼写；128K→1M=87% 必须算漂移");

// ── ② CLI 退出码（--from 夹具 + spawn 真字节，零网络）────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SCRIPT = join(REPO, "tools", "check-context-catalog.mjs");
const TMP_BASE = join(REPO, "tmp");

/** 用**真**策展表造一份「全稳定」夹具：每条表内 id 配一个上游 provider 条目。
 *  从磁盘上的表生成，表将来长了夹具自动跟着长——不会悄悄变成半份 fixture。 */
function cleanFixture(dir) {
  const models = {};
  for (const [id, value] of Object.entries(CURATED_CONTEXT_WINDOWS)) {
    models[id.split("/").pop()] = model(value, { canon: `fix/${id.split("/").pop()}` });
  }
  writeFileSync(join(dir, "api.json"), JSON.stringify(apiJsonOf([["fix", models]])));
  writeFileSync(join(dir, "catalog.json"), JSON.stringify({ object: "list", data: Object.keys(CURATED_CONTEXT_WINDOWS).map((id) => ({ id })) }));
}

function runChecker(dir) {
  const env = { ...process.env, MODELSCOPE_API_KEY: "" };
  delete env.GITHUB_STEP_SUMMARY;
  delete env.GITHUB_ACTIONS;
  const res = spawnSync(process.execPath, [SCRIPT, "--from", dir], { cwd: REPO, encoding: "utf8", env, timeout: 30_000 });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

mkdirSync(TMP_BASE, { recursive: true });
const tmpRoot = mkdtempSync(join(TMP_BASE, "ms-curated-drift-"));
let caseIndex = 0;
/** 跑一个 CLI 场景：建夹具（可改 cleanFixture 的产物）、断言退出码与输出片段。 */
function cliCase(name, { mutate = () => {}, code, includes = [], excludes = [] }) {
  caseIndex += 1;
  const dir = join(tmpRoot, `case-${caseIndex}`);
  mkdirSync(dir, { recursive: true });
  cleanFixture(dir);
  mutate(dir);
  const res = runChecker(dir);
  const where = `${name}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`;
  assert.equal(res.code, code, `${where}\n（期望退出码 ${code}，实际 ${res.code}）`);
  for (const needle of includes) {
    assert.ok(res.stdout.includes(needle) || res.stderr.includes(needle), `${where}\n（输出里应含 ${JSON.stringify(needle)}）`);
  }
  for (const needle of excludes) {
    assert.ok(!res.stdout.includes(needle), `${where}\n（输出里不该含 ${JSON.stringify(needle)}）`);
  }
}

const firstId = Object.keys(CURATED_CONTEXT_WINDOWS)[0];

try {
  cliCase("全稳定 → 0，结论说一致", {
    code: 0,
    includes: [`表 ${Object.keys(CURATED_CONTEXT_WINDOWS).length} 条`, "结论：策展表与上游一致"],
    excludes: ["该补", "该复核", "该删"],
  });

  cliCase("上游有共识、表里没有 → 1（1017 事故的类别）", {
    mutate: (dir) => {
      const catalog = JSON.parse(readFileSyncSafe(join(dir, "catalog.json")));
      catalog.data.push({ id: "deepseek-ai/DeepSeek-V4.9-Future" });
      writeFileSync(join(dir, "catalog.json"), JSON.stringify(catalog));
      const api = JSON.parse(readFileSyncSafe(join(dir, "api.json")));
      api.providers.fix.models["DeepSeek-V4.9-Future"] = model(1048576, { canon: "fix/DeepSeek-V4.9-Future" });
      writeFileSync(join(dir, "api.json"), JSON.stringify(api));
    },
    code: 1,
    includes: ["该补", "DeepSeek-V4.9-Future", "→ 1048576", "结论：1 处需要人处理"],
  });

  cliCase("表值与上游差一个量级 → 1（该复核）", {
    mutate: (dir) => {
      const api = JSON.parse(readFileSyncSafe(join(dir, "api.json")));
      const key = firstId.split("/").pop();
      api.providers.fix.models[key] = model(131072, { canon: `fix/${key}` });
      writeFileSync(join(dir, "api.json"), JSON.stringify(api));
    },
    code: 1,
    includes: ["该复核", "vs 上游 131072", firstId],
  });

  cliCase("拼写差（1MiB vs 1M）→ 0，只备注不红", {
    mutate: (dir) => {
      const api = JSON.parse(readFileSyncSafe(join(dir, "api.json")));
      const key = firstId.split("/").pop();
      api.providers.fix.models[key] = model(1000000, { canon: `fix/${key}` });
      writeFileSync(join(dir, "api.json"), JSON.stringify(api));
    },
    code: 0,
    includes: ["拼写差", "vs 上游 1000000", "结论：没有需要处理的漂移"],
    excludes: ["该复核"],
  });

  cliCase("表里条目不在 live 目录 → 1（该删）", {
    mutate: (dir) => {
      const catalog = JSON.parse(readFileSyncSafe(join(dir, "catalog.json")));
      catalog.data = catalog.data.filter((entry) => entry.id !== firstId);
      writeFileSync(join(dir, "catalog.json"), JSON.stringify(catalog));
    },
    code: 1,
    includes: ["该删", firstId],
  });

  cliCase("catalog.json 缺席 → 目录未知，只做漂移比对，干净时仍 0", {
    mutate: (dir) => rmSync(join(dir, "catalog.json")),
    code: 0,
    includes: ["live 目录：未知", "缺失/下架/无源三项不判"],
    excludes: ["该补", "该删"],
  });

  cliCase("api.json 不是合法 JSON → 1 且 ERROR 前缀（与漂移结论区分）", {
    mutate: (dir) => writeFileSync(join(dir, "api.json"), "{ not json"),
    code: 1,
    includes: ["ERROR:"],
  });

  cliCase("api.json 空 providers → 1（空索引必须红，不能报「没有差异」）", {
    mutate: (dir) => writeFileSync(join(dir, "api.json"), JSON.stringify({ providers: {} })),
    code: 1,
    includes: ["ERROR:", "一个带 limit.context 的模型都没读到"],
  });

  cliCase("夹具缺 api.json → 2（用法/夹具错误，不是环境事实）", {
    mutate: (dir) => rmSync(join(dir, "api.json")),
    code: 2,
    includes: ["ERROR: 夹具缺少"],
  });
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

/** 读文件的小包装（cliCase 的 mutate 里用）。 */
function readFileSyncSafe(path) {
  return readFileSync(path, "utf8");
}

console.log("context-catalog-drift.test.mjs: all checks passed");
