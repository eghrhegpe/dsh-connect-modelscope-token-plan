#!/usr/bin/env node
/**
 * check-context-catalog.mjs —— 内置上下文窗口策展表 vs models.dev 上游的漂移检查。
 *
 * 用法：
 *   node tools/check-context-catalog.mjs                 # 联网：拉上游 api.json + 魔搭 live 目录
 *   node tools/check-context-catalog.mjs --from <目录>    # 离线夹具：<目录>/api.json（必需）+ catalog.json（可选）
 *   npm run context-catalog:check                        # 等价于第一种
 *
 * ## 为什么不在离线门禁里做
 *
 * 离线门禁是零网络的，只能查「表自身自洽」；「上游改了、表没跟上」这件事只有联网
 * 才看得见（2026-10-23 的实证：DeepSeek-V4.1-Flash-1017 上架一周后面板一直显示
 * 128k 兜底，而 35 个 host 的众数都是 1M——人是靠手动比对上游才发现这个 bug 的）。
 * 这个脚本把那次手动比对自动化；它住在 `tools/` 与每周定时档里，不进 `npm test`。
 *
 * ## 退出码
 *
 *   0  没有需要人处理的结论（含「上游没取到」的 SKIP——取不到 ≠ 没变）
 *   1  有结论：漂移（该补/该复核/该删），或输入坏到读不出（JSON 坏、上游形状
 *      漂移——输出以 ERROR: 开头，与漂移结论区分）
 *   2  用法/夹具错误（flag 写错、--from 漏值、夹具缺 api.json）
 *
 * ## 本机跑可能要加 `--use-system-ca`
 *
 * 这台开发机在 TLS 中间人后面，node 自带 CA 池不认那个证书（同
 * `tools/check-market-rules.mjs` 的处境）。加系统证书池就通：
 *
 *   node --use-system-ca tools/check-context-catalog.mjs
 *
 * CI 上没有这层中间人，不需要这个 flag。
 *
 * ## 红了是什么意思
 *
 * 红了 = 上游或目录动了、内置表没跟上，**这是信息不是回归**。要做的事是改
 * `src/host/context-catalog.ts`（补/删/复核条目 + 更新 CURATED_AS_OF），然后
 * `npm run build` 并跑全量测试。脚本只报 diff，不写盘——抄什么值是人的决定。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CURATED_AS_OF, CURATED_CONTEXT_WINDOWS } from "../src/host/context-catalog.ts";
import { SPELLING_TOLERANCE, actionableCount, buildUpstreamIndex, diffCuratedTable } from "./lib/curated-drift.mjs";

const MODELSDEV_URL = "https://models.dev/api.json";
const CATALOG_URL = "https://api-inference.modelscope.cn/v1/models";
const TIMEOUT_MS = 20_000;
const USAGE = "用法：node tools/check-context-catalog.mjs [--from <夹具目录>]";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
let fromDir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--from") {
    fromDir = args[i + 1] ?? null;
    i++;
    continue;
  }
  console.error(`不认识的参数：${args[i]}\n${USAGE}`);
  process.exit(2);
}
if (args.includes("--from") && (fromDir === null || fromDir === "")) {
  console.error(`--from 需要一个目录（里面放 api.json，可选 catalog.json）\n${USAGE}`);
  process.exit(2);
}

/** 网络取数（带超时）。失败返回 { error }，由调用方决定 SKIP 还是降级。 */
async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "accept-encoding": "gzip, deflate, br" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return { json: await response.json() };
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

/** 夹具取数：读本地文件，JSON 坏/文件缺都是显式错误（本地文件不是网络故障）。 */
function readFixtureJson(path, { required }) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    if (required) {
      console.error(`ERROR: 夹具缺少 ${path}\n${USAGE}`);
      process.exit(2);
    }
    return { missing: true };
  }
  try {
    return { json: JSON.parse(text) };
  } catch (error) {
    console.error(`ERROR: ${path} 不是合法 JSON：${error?.message ?? error}`);
    process.exit(1);
  }
}

// ── 取数 ────────────────────────────────────────────────────────────────────
let apiJson;
let catalogIds = null;
let catalogNote = null;

if (fromDir !== null) {
  apiJson = readFixtureJson(join(fromDir, "api.json"), { required: true }).json;
  const catalogFixture = readFixtureJson(join(fromDir, "catalog.json"), { required: false });
  if (!catalogFixture.missing) catalogIds = catalogIdsFrom(catalogFixture.json, fromDir);
} else {
  const upstream = await fetchJson(MODELSDEV_URL);
  if (upstream.error !== undefined) {
    // 「没问到」不是「没问题」：网络不通时不能安静地绿，也绝不打印「无差异」。
    console.error(
      `SKIP: 取不到上游（${MODELSDEV_URL}），本轮没有比对任何东西（这不等于上游没变）\n  ${upstream.error}`
    );
    if (process.env.GITHUB_STEP_SUMMARY) {
      console.error("::warning title=context-catalog check skipped::上游 api.json 取不到，本轮未比对");
    }
    process.exit(0);
  }
  apiJson = upstream.json;
  const catalog = await fetchJson(CATALOG_URL);
  if (catalog.error !== undefined) {
    catalogNote = `live 目录没取到（${catalog.error}）`;
  } else {
    catalogIds = catalogIdsFrom(catalog.json, CATALOG_URL);
    if (catalogIds === null) catalogNote = `live 目录形状不认识（${CATALOG_URL}）`;
  }
}

/** 从 /v1/models 响应里取 id 列表；形状不对返回 null（调用方降级为「目录未知」）。 */
function catalogIdsFrom(json, where) {
  if (json === null || typeof json !== "object" || json.object !== "list" || !Array.isArray(json.data)) {
    if (where === CATALOG_URL) return null; // 网络模式：形状漂移 → 降级 + 注明，不当作用法错误
    console.error(`ERROR: 夹具 catalog.json 形状不认识（期望 {object:'list', data:[...]}）——${where}`);
    process.exit(1);
  }
  const ids = [];
  for (const entry of json.data) {
    const id = entry !== null && typeof entry === "object" ? entry.id : undefined;
    if (typeof id === "string" && id !== "") ids.push(id);
  }
  return ids;
}

// ── 判定 ────────────────────────────────────────────────────────────────────
let index;
try {
  index = buildUpstreamIndex(apiJson);
} catch (error) {
  console.error(`ERROR: ${error?.message ?? error}`);
  process.exit(1);
}

const report = diffCuratedTable(CURATED_CONTEXT_WINDOWS, index, catalogIds);
const tableSize = Object.keys(CURATED_CONTEXT_WINDOWS).length;
const mode = fromDir !== null ? `离线夹具 ${fromDir}` : "联网";

// ── 报告 ────────────────────────────────────────────────────────────────────
const lines = [];
lines.push(`策展表漂移检查（${mode}）· CURATED_AS_OF=${CURATED_AS_OF} · 表 ${tableSize} 条`);
lines.push(
  `上游 models.dev/api.json：${index.stats.providers} providers / ${index.stats.models} models（带 limit.context）`
);
if (catalogIds !== null) {
  lines.push(`live 目录 api-inference.modelscope.cn/v1/models：${catalogIds.length} 条`);
} else {
  lines.push(`live 目录：未知${catalogNote === null ? "" : `（${catalogNote}）`}——缺失/下架/无源三项不判，只做漂移比对`);
}
lines.push("");

if (report.missing.length > 0) {
  lines.push("── 该补（目录在、上游有共识、表里没有）──────────────────────────");
  for (const row of report.missing) {
    const modalities = [...row.input, ...row.output].join("|");
    lines.push(
      `  + ${row.id} → ${row.value}（${row.hosts} hosts · ${modalities === "" ? "无 modalities" : modalities} · canon ${row.canon}）`
    );
    if (!row.chatworthy) {
      lines.push("    ！ modalities 输出不含 text——疑似生图/语音模型，按纪律 4 确认后再收");
    }
  }
  lines.push("");
}
if (report.drifted.length > 0) {
  lines.push(`── 该复核（表值与上游众数差 >${(SPELLING_TOLERANCE * 100).toFixed(0)}%）────────────────────`);
  for (const row of report.drifted) {
    lines.push(`  ~ ${row.id} 表 ${row.curated} vs 上游 ${row.live}（${row.hosts} hosts · canon ${row.canon}）`);
  }
  lines.push("");
}
if (report.delisted.length > 0) {
  lines.push("── 该删（不在 live 目录了——表不是历史档案）────────────────────");
  for (const row of report.delisted) {
    lines.push(`  - ${row.id}（表 ${row.curated}${row.live === null ? "" : ` · 上游仍推得 ${row.live}`}）`);
  }
  lines.push("");
}
if (report.spelling.length > 0) {
  lines.push(`── 拼写差（≤${(SPELLING_TOLERANCE * 100).toFixed(0)}%，十进制/二进制，仅备注）──────────────────`);
  for (const row of report.spelling) {
    lines.push(`  = ${row.id} 表 ${row.curated} vs 上游 ${row.live}（${row.hosts} hosts）`);
  }
  lines.push("");
}
if (report.unverifiable.length > 0) {
  lines.push("── 无上游佐证（表里有、上游推不出——值失去交叉核对）──────────");
  for (const row of report.unverifiable) {
    lines.push(`  ? ${row.id}（表 ${row.curated}）`);
  }
  lines.push("");
}
if (report.unsourced.length > 0) {
  lines.push(`── 无源（目录在、上游没有 → 继续落 128k 兜底，${report.unsourced.length} 条）────────────`);
  lines.push(`  ${report.unsourced.join(", ")}`);
  lines.push("");
}
lines.push(`✓ 一致 ${report.stable} 条`);

const actionable = actionableCount(report);
if (actionable === 0) {
  const notes = [];
  if (report.spelling.length > 0) notes.push(`拼写差 ${report.spelling.length}`);
  if (report.unverifiable.length > 0) notes.push(`无佐证 ${report.unverifiable.length}`);
  if (report.unsourced.length > 0) notes.push(`无源 ${report.unsourced.length}`);
  lines.push(
    notes.length > 0
      ? `\n结论：没有需要处理的漂移（备注：${notes.join(" · ")}）。`
      : `\n结论：策展表与上游一致（表 ${tableSize} 条全部稳定）。`
  );
  console.log(lines.join("\n"));
  process.exit(0);
}

lines.push(
  `\n结论：${actionable} 处需要人处理（补 ${report.missing.length} · 复核 ${report.drifted.length} · 删 ${report.delisted.length}）。`
);
lines.push("改 src/host/context-catalog.ts → 更新 CURATED_AS_OF → npm run build → node test/run-all.mjs。");
console.log(lines.join("\n"));
process.exit(1);
