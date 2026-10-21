// check-market-rules.mjs —— 拿上游的规则原文，比对本仓的镜像与副本。
//
// 用法：node tools/check-market-rules.mjs           # 刷新副本 + 打印镜像差异
//       node tools/check-market-rules.mjs --check   # 只报告，不写盘
//
// ## 为什么是联网脚本，而不是门禁里直接联网
//
// 本仓库的离线门禁是零网络的（裸 node + strip-types），所以「上游改了规则」这件事
// 在离线套件里**永远查不出来**——只能查「镜像与旧副本对不对得上」。这个脚本是那半边：
// 它去取上游原文，把差异摆出来，剩下的是人来决定抄不抄。
//
// ## 三处比对（各自回答不同的问题）
//
// ① 上游 `scripts/lib/entries.mjs` 的 CAT_IDS / ENTRY_KEYS / TARBALL_HOSTS
//    vs 本仓 `test/helpers/market-rules.mjs` 的同名常量。
//    —— 那是**手抄镜像**：上游改了形状规则而我们没跟上，就是投稿在合入后打断市场
//    README 生成的那种失败（上游 `scripts/generate-readme.mjs` 遇 problem 就
//    process.exit(1)，原话 "refusing to generate"）。
// ② 上游 `contributing.md` 里的 category 清单 vs 上游 `entries.mjs` 的 CAT_IDS。
//    —— 上游自己的两处说法是否一致。不一致时本仓的离线交叉核对
//    （`test/market-entry.test.mjs`：镜像的 CAT_IDS 对副本的 category 行）会判红，
//    而照抄是抄不出一个两边都对得上的状态的——所以这里先把上游的矛盾指出来。
// ③ 上游 `contributing.md` 原文 vs 本仓副本
//    `awesome-dsh-plugin-submission/contributing.md`。
//    —— 副本是逐字节拷贝的上游文件，但它从 2026-10-05 起就没有刷新机制；上游改了
//    贡献指南，我们这边会一直拿着旧副本，而离线门禁只认副本，于是「静悄悄地过期」。
//
// ## 写了什么
//
// 默认模式会**刷新副本**（③ 的本地那一份，逐字节覆盖）——它是纯拷贝，刷新没有判断
// 余地。**镜像（① 的本地那一份）不自动改**：那是手抄的判据与措辞，抄的时候要照着
// 上游的语气写，改它是要人来看的。脚本只把差异和上游的值打出来。
//
// ## 依赖
//
// 它 import `test/helpers/market-rules.mjs`（那份镜像本身）——写的人和查的人不能各用
// 一套算术。那条 import 会牵出 `test/helpers/submission-entry.mjs`，于是**要 js-yaml**
// （devDependencies）：裸 checkout 上先 `npm install`，否则会看到一句
// "js-yaml is not installed"。
//
// ## 本机跑可能要加 `--use-system-ca`
//
// 这台开发机在 TLS 中间人后面：node 自带的 CA 池不认那个证书，于是**两个端点都**
// `fetch failed`（不只 raw 那个）。加系统证书池就通：
//
//   node --use-system-ca tools/check-market-rules.mjs --check
//
// `test/submission-drift.mjs` 是同一处境（同一个上游、同一个网络）。CI 上没有这层
// 中间人，不需要这个 flag。
//
// ## 红了是什么意思（以及不是什么）
//
// 红了 = 上游的规则事实变了，本仓的镜像还没跟上。这是**信息**，不是「插件坏了」。
// 真正要做的决定是：抄，还是有意不改（那要在镜像的注释里写清为什么）。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CAT_IDS, ENTRY_KEYS, TARBALL_HOSTS } from "../test/helpers/market-rules.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIRROR = `${REPO_ROOT}test/helpers/market-rules.mjs`;
const COPY = `${REPO_ROOT}awesome-dsh-plugin-submission/contributing.md`;
const UPSTREAM_REPO = "awesome-dsh-plugin/awesome-dsh-plugin";
const UPSTREAM_BRANCH = "main";
const checkOnly = process.argv.includes("--check");
const TIMEOUT_MS = 20_000;

const UPSTREAM_ENTRIES = "scripts/lib/entries.mjs";
const UPSTREAM_GUIDE = "contributing.md";

// 取上游原文。两个端点都试，因为它们各自会在不同网络上挂：
//
//   - raw.githubusercontent.com —— 规范端点，但在不少企业网关上 TLS 直接断（本机就是：
//     `curl` 报 SSL error）。无鉴权、无速率限制。
//   - api.github.com 的 contents 端点（Accept: application/vnd.github.raw）—— 返回文件
//     原文而不是 base64，匿名 60 次/小时。对本脚本的频率（每天一次）绰绰有余。
//
// 端点选择只影响能不能取到，不影响取到的内容：同一个 commit 的同一份文件。
async function fetchUpstream(path) {
  const urls = [
    `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_BRANCH}/${path}`,
    `https://api.github.com/repos/${UPSTREAM_REPO}/contents/${path}?ref=${UPSTREAM_BRANCH}`,
  ];
  const tried = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/vnd.github.raw", "user-agent": "dsh-connect-modelscope-token-plan" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        tried.push(`${url} → HTTP ${response.status}`);
        continue;
      }
      return { text: await response.text(), url };
    } catch (error) {
      tried.push(`${url} → ${error?.message ?? error}`);
    }
  }
  return { error: tried.join("; "), url: urls[0] };
}

// 从上游源码里抠出那几个常量。上游是 `export const CAT_IDS = ['agi', 'ui', …]`
// 一行字面量（reorder-categories.py 按正则改写这一行，所以它必须保持单行），
// ENTRY_KEYS / TARBALL_HOSTS 是 `const X = new Set([...])`。
//
// 抠不出来就报错退出，不猜：抠不出常量而报「没有差异」，那是绿灯撒谎。
function parseUpstreamConstants(source) {
  const literal = (name) => {
    const match = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(?:new Set\\(\\s*)?\\[([^\\]]*)\\]`));
    if (!match) return null;
    return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
  };
  const catIds = literal("CAT_IDS");
  const entryKeys = literal("ENTRY_KEYS");
  const tarballHosts = literal("TARBALL_HOSTS");
  const missing = [];
  if (catIds === null) missing.push("CAT_IDS");
  if (entryKeys === null) missing.push("ENTRY_KEYS");
  if (tarballHosts === null) missing.push("TARBALL_HOSTS");
  if (missing.length > 0) {
    throw new Error(`上游 ${UPSTREAM_ENTRIES} 里没抠出 ${missing.join(", ")}——上游改了写法，这个脚本要跟上`);
  }
  return { catIds, entryKeys, tarballHosts };
}

// 贡献指南里的 category 清单：找那一行（同时含 `agi` 与 `fun`），把它里的反引号词抠出来。
// 规则与 `test/market-entry.test.mjs` 的离线交叉核对**完全一致**——两处各写一遍会漂。
export function categoriesFromGuide(text) {
  const line = text
    .split(/\r?\n/)
    .find((candidate) => candidate.includes("`agi`") && candidate.includes("`fun`"));
  if (!line) return null;
  return [...line.matchAll(/`([a-z]+)`/g)].map((entry) => entry[1]);
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function diffLists(label, upstream, local) {
  if (sameList(upstream, local)) return null;
  const upstreamSet = new Set(upstream);
  const localSet = new Set(local);
  const added = upstream.filter((value) => !localSet.has(value));
  const removed = local.filter((value) => !upstreamSet.has(value));
  const reordered = sameList([...upstream].sort(), [...local].sort());
  const lines = [`~ ${label} 与上游不一致`];
  if (added.length > 0) lines.push(`  + 上游有、本仓没有：${added.join(", ")}`);
  if (removed.length > 0) lines.push(`  - 本仓有、上游没有：${removed.join(", ")}`);
  if (reordered) lines.push("  ~ 取值集合相同，顺序不同（category 的顺序是站点章节顺序）");
  return lines.join("\n");
}

const entries = await fetchUpstream(UPSTREAM_ENTRIES);
const guide = await fetchUpstream(UPSTREAM_GUIDE);
if (entries.error || guide.error) {
  // 「没问到」不是「没问题」：网络不通时不能安静地绿。抄 submission-drift.mjs 的口径——
  // 打印够清楚的说明，把这个事实标到运行摘要上，退出码 0（网络故障不是回归），
  // 但绝不打印「无差异」。
  const detail = [entries.error, guide.error].filter(Boolean).join(" | ");
  console.error(`SKIP: 取不到上游原文，本轮没有比对任何东西（这不等于规则没变）\n  ${detail}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    console.error("::warning title=market-rules check skipped::上游原文取不到，本轮未比对");
  }
  process.exit(0);
}

const upstream = parseUpstreamConstants(entries.text);
const guideCategories = categoriesFromGuide(guide.text);
if (guideCategories === null) {
  throw new Error(`上游 ${UPSTREAM_GUIDE} 里找不到 category 清单那一行——上游改了写法，这个脚本要跟上`);
}

const report = [];

// ① 镜像 vs 上游代码
const mirrorDiffs = [
  diffLists("CAT_IDS", upstream.catIds, CAT_IDS),
  diffLists("ENTRY_KEYS", upstream.entryKeys, [...ENTRY_KEYS]),
  diffLists("TARBALL_HOSTS", upstream.tarballHosts, [...TARBALL_HOSTS]),
].filter(Boolean);
if (mirrorDiffs.length > 0) {
  report.push(`镜像 ${MIRROR} 与上游 ${UPSTREAM_ENTRIES} 不一致：\n${mirrorDiffs.join("\n")}`);
  report.push("  抄的时候照着上游的措辞写（镜像是手抄的，不是生成物）。");
}

// ② 上游自己的两处说法
const upstreamSelfDiff = diffLists("上游 contributing.md 的 category 清单", upstream.catIds, guideCategories);
if (upstreamSelfDiff) {
  report.push(
    `上游自己两处说法不一致：\n${upstreamSelfDiff}\n  本仓的离线交叉核对（镜像 CAT_IDS 对副本 category 行）会因此判红——先定上游口径，再抄。`,
  );
}

// ③ 副本 vs 上游原文
const localCopy = readFileSync(COPY, "utf8");
const copyStale = localCopy !== guide.text;
if (copyStale) {
  const upstreamLines = guide.text.split(/\r?\n/);
  const localLines = localCopy.split(/\r?\n/);
  const firstDiff = upstreamLines.findIndex((line, index) => line !== localLines[index]);
  const where = firstDiff === -1 ? "行数不同" : `第 ${firstDiff + 1} 行起不同`;
  report.push(`副本 ${COPY} 与上游 ${UPSTREAM_GUIDE} 不一致（${where}）`);
}

if (report.length === 0) {
  console.log(`规则镜像与副本都跟上游一致（取自 ${entries.url}）`);
} else {
  console.log(report.join("\n\n"));
  if (copyStale && !checkOnly) {
    writeFileSync(COPY, guide.text);
    console.log(`\n已刷新副本 ${COPY}（逐字节覆盖上游原文）`);
  } else if (copyStale) {
    console.log(`\n--check：没有写盘。去掉 --check 重跑即可刷新副本。`);
  }
  if (mirrorDiffs.length > 0) {
    console.log("\n上游的值（照抄用）：");
    console.log(`  CAT_IDS = ${JSON.stringify(upstream.catIds)}`);
    console.log(`  ENTRY_KEYS = ${JSON.stringify(upstream.entryKeys)}`);
    console.log(`  TARBALL_HOSTS = ${JSON.stringify(upstream.tarballHosts)}`);
  }
  if (checkOnly) {
    console.error("上游规则与本仓镜像/副本对不上——这是信息，不是回归：抄，或者有意不改并写清为什么。");
    process.exitCode = 1;
  }
}
