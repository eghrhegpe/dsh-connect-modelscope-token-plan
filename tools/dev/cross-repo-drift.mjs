#!/usr/bin/env node
/**
 * cross-repo-drift.mjs —— 同族插件之间的「同源度」体检。
 *
 * ## 它回答什么
 *
 * 本插件与姊妹插件（sensenova / agnes 等）共享一套**文件命名**，头注里散落着
 * 「受控复制」「与姊妹插件同源」这类**自我描述**。这些描述没有任何门禁：源文件
 * 一改，宣称还是那句话，而读者（包括 AI 协作方）会照着它推理——本仓库真的因此
 * 错过一次（`provider-publish.ts` 自称「差异只有三个标签」，而 `draw-runtime.ts`
 * 整段自称「无覆盖」，两条都被实测推翻）。
 *
 * 本工具把那些宣称变成**可复核的数字**：逐同名文件算去注释后的代码行重叠率，
 * 并把「文件自己说同源、实测却不同源」的项单独列出来。
 *
 * ## 判据：行集合重叠（Jaccard），不是 diff 行数、不是 LCS
 *
 * 这里踩过两个坑，都实证过，所以判据写死在 `codeOverlap()`：
 *
 *   1. **diff / numstat 的差异行数会被注释语言骗。** 两侧头注一中一英时，
 *      `provider-publish.ts` 报出 464 行差异，读起来像「两份完全不同的实现」，
 *      而实质差异远小于此。所以本工具**先剥注释**再比。
 *   2. **LCS（最长公共子序列）会被函数顺序骗。** `util.ts` 两侧的函数集合几乎
 *      相同、只是排列次序不同，LCS 只给 32%，而真实差异是 **1 个差异块**
 *      （`redactSecrets` 对令牌的脱敏）。所以本工具用**顺序无关**的行集合重叠，
 *      并把 LCS 一并打印供对照——两者差得远 = 主要是重排，不是改写。
 *
 * ## 用法
 *
 *     node tools/dev/cross-repo-drift.mjs                 # 扫全部姊妹仓库
 *     node tools/dev/cross-repo-drift.mjs --claims        # 只看「宣称与实测不符」
 *     node tools/dev/cross-repo-drift.mjs --json          # 机器可读
 *     node tools/dev/cross-repo-drift.mjs --sibling <dir> # 指定姊妹仓库（可多次）
 *     node tools/dev/cross-repo-drift.mjs --strict        # 有宣称不符时非零退出
 *
 * ## 找不到姊妹仓库时
 *
 * 正常退出（0）并明说「未发现」——别人的 checkout 里没有这三个仓库，那不是错误。
 * 本工具因此**不进 `npm test`**（与 `tools/dev/` 其余工具同规矩：它们不是门禁，
 * 是诊断）。
 *
 * ## 分档（只用于阅读，不是门禁）
 *
 *     >=85%  同构    结构与实现基本一致，改一侧另一侧大概率要跟着改
 *     60-85% 同族    结构同源、有实质差异；可对着读，不可照搬
 *     30-60% 分家    同名而已，历史同源但已各自演化
 *     <30%   同名    只有文件名叫得一样，别按名字借代码
 *
 * @module tools/dev/cross-repo-drift
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（`tools/dev/` 上溯两级——移动本文件时必须同步改这里）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "src");

/** 认作「姊妹插件」的目录名形态（`--sibling` 可绕过）。 */
const SIBLING_PATTERN = /^dsh-connect-.*-token-plan$/;

/** 姊妹语境词——「同源」必须与它们邻近才算跨仓宣称（见下方误报边界）。 */
const SIBLING_WORDS = "姊妹|sensenova|agnes|qoder|同族";

/**
 * 自称**代码级**同源的关键词。
 *
 * 边界（本工具的第一版在这里误报过，两次，都写进注释）：
 *
 *   - **`同形` / `同款` 不算**。`doctor.ts` 写「与 sensenova 的 doctor 同形」
 *     「同款纪律」——那是**输出形状与纪律**的对齐（`--json` 出机器可读、其余出
 *     人读行），不承诺代码同源，实测重叠 38% 与那句话并不矛盾。拿代码重叠率去
 *     检验一条形状宣称，是工具在替读者加戏。
 *   - **裸「同源」不算**。`client/const.ts` 头注里的「相对、同源」是 web 的
 *     **same-origin**（同源策略那个同源），与跨仓库毫无关系；头注首行更是直接
 *     写着 "Ids and same-origin routes"。所以「同源」必须与姊妹语境词邻近才计。
 *
 * 漏判的代价是漏报（读者仍要自己判断），误报的代价是噪音——而一个会喊狼来了的
 * 门禁，很快就会被忽略。宁可少判。
 */
const CLAIM_PATTERN = new RegExp(
  "受控复制|复制自"
  + `|(?:${SIBLING_WORDS})[^\\n]{0,40}同源`
  + `|同源[^\\n]{0,40}(?:${SIBLING_WORDS})`
);

/** 反向表述：出现这些就说明该处宣称其实是「**不**同源」，不该算宣称。 */
const CLAIM_DENIAL_PATTERN = /不能照抄|不可照搬|不可照抄|不能照搬|别按名字|各写各的|不是同一份|已分家/;

/** 宣称「同源」但实测重叠低于此值 → 判为不符。 */
const CLAIM_MISMATCH_BELOW = 0.6;

/** 分档边界（从高到低）。 */
const TIERS = [
  { min: 0.85, label: "同构" },
  { min: 0.6, label: "同族" },
  { min: 0.3, label: "分家" },
  { min: 0, label: "同名" }
];

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const strict = argv.includes("--strict");
const claimsOnly = argv.includes("--claims");
const explicitSiblings = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--sibling" && argv[i + 1] !== undefined) explicitSiblings.push(resolve(argv[i + 1]));
}

/**
 * 递归收集 `src/` 下的 `.ts` 相对路径（POSIX 分隔）。
 *
 * 起点就是 `src`，所以 `node_modules` 天然不在范围内——早先拿仓库根当起点时，
 * `node_modules/@types/node` 下的同名 `.d.ts` 会混进配对、把报告淹掉。
 * @param {string} dir - 起始目录。
 * @param {string} [base] - 相对基准（递归内部用）。
 * @returns {string[]} 相对路径，已排序。
 */
function walkTs(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full, base));
    else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(relative(base, full).split(sep).join("/"));
    }
  }
  return out.sort();
}

/**
 * 头注里**逐行**筛出「自称代码级同源」的行。
 *
 * 为什么必须逐行而不是按整段头注判：`draw.ts` 的头注是一段**混合陈述**——它既说
 * 「核心不能照抄」，又说外壳（endpoint 拼接、冷却门）可复用。按整段判 denial 会把
 * 这一整段都排除掉，于是任何夹在其中的宣称都检不出来。本工具的变异检验就是这么
 * 抓到自己的：往 `draw.ts` 里塞一句「与姊妹插件 draw.ts 同源，可直接照搬」，
 * 整段判定把它当成了「已在别处否认过」而放过。**逐行判定**之后它立刻报了 [不符]。
 *
 * 反过来，`use-snapshot-polling.ts` 改后的措辞（「与姊妹插件的同名文件**不是同一份**
 * 实现」）落在同一行里，denial 逐行生效，正确地不算宣称。
 * @param {string} header - 头注文本。
 * @returns {string[]} 构成宣称的行。
 */
function claimLinesOf(header) {
  return header
    .split("\n")
    .filter((line) => CLAIM_PATTERN.test(line) && !CLAIM_DENIAL_PATTERN.test(line));
}

/**
 * 姊妹仓库的短名——头注里可能的**指名**写法。
 *
 * 头注有两类宣称：「与 **sensenova** 的 util.ts 同源」（指名）与「与**姊妹插件**
 * 同源」（泛称）。核对必须分开对待：**指名宣称只对它点名的那个仓库成立**，拿它去
 * 核对另一个姊妹仓库是误报——`util.ts` 与 sensenova 94% 同源、与 agnes 只有 48%，
 * 而头注那句话只承诺前者。泛称则对每个姊妹都算声称（也正是泛称的代价：它一句话
 * 承诺了两件事，只有一件成立时就该被点出来）。
 */
const NAMED_SIBLINGS = ["sensenova", "agnes", "qoder"];

/**
 * 头注里是否**针对某个姊妹**做了「不同源」的表述（点名与否认词同行）。
 *
 * 这一条是修上一个坑时当场长出来的：把 `format.ts` 写成「与 sensenova 的 format.ts
 * 同源……**与 agnes 那份已分家**（45%）」之后，工具反而开始对 agnes 报「宣称不符」
 * ——因为指名检测在整段里看见了 `agnes` 这个词，就以为那句话是在向 agnes 承诺。
 * 点名提到一个姊妹，既可能是承诺，也可能是**划清界限**；靠否认词区分。
 * @param {string} header - 头注文本。
 * @param {string} siblingKey - 姊妹仓库短名。
 * @returns {boolean}
 */
function deniesAbout(header, siblingKey) {
  return header
    .split("\n")
    .some((line) => new RegExp(siblingKey, "i").test(line) && CLAIM_DENIAL_PATTERN.test(line));
}

/**
 * 某段头注是否对 `siblingKey` 这个姊妹仓库做了同源宣称。
 *
 * 判定顺序（每一步都是被实证逼出来的，别简化）：
 *   1. 没有任何宣称行 → 不宣称；
 *   2. 有**针对该姊妹**的划界表述 → 不宣称（`deniesAbout`）；
 *   3. 整段里有指名（`sensenova` / `agnes` / …）→ 只对点名的那个计数；
 *   4. 都没有 → 泛称，对每个姊妹都算声称。
 *
 * 指名检测看**整段头注**而不是只看宣称行：`util.ts` 的宣称句是「与姊妹插件
 * util.ts 同源」（泛称），点名落在下一句「相对 **sensenova** 版本的差异只有一处」
 * ——只看宣称行会把它误判成泛称，于是拿这句话去核对 agnes（48%）并报一个不存在的
 * 「不符」。**宣称判行、指名判段**，这个不对称是实证出来的，不是设计洁癖。
 * @param {string} header - 头注文本。
 * @param {string} siblingKey - 姊妹仓库短名（如 `sensenova`）。
 * @returns {boolean}
 */
function claimsAbout(header, siblingKey) {
  if (claimLinesOf(header).length === 0) return false;
  if (deniesAbout(header, siblingKey)) return false;
  const named = NAMED_SIBLINGS.filter((name) => new RegExp(name, "i").test(header));
  if (named.length === 0) return true;
  return named.includes(siblingKey);
}

/**
 * 去注释后的代码行：跳过空行与纯注释行，其余按去首尾空白后的原文入列。
 *
 * 「纯注释行」的判定刻意只认行首形态（`*`、`//`、`/*`）——本仓库的注释都是整行
 * 形态，行尾注释极少，无须做词法级解析；漏掉的个别行尾注释只会让重叠率略偏低，
 * 不会把「不同源」判成「同源」。
 * @param {string} file - 文件路径。
 * @returns {string[]} 代码行。
 */
function codeLines(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((t) => t !== "" && t[0] !== "*" && t.slice(0, 2) !== "//" && t.slice(0, 2) !== "/*");
}

/**
 * 文件头注（前 40 行里的注释行）——「自我描述」的取材处。
 * @param {string} file - 文件路径。
 * @returns {string} 头注文本。
 */
function headerOf(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .slice(0, 40)
    .filter((line) => {
      const t = line.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
    })
    .join("\n");
}

/**
 * 行集合重叠率（顺序无关，Jaccard 的对称形式）——本工具的主判据。
 * @param {string[]} a - 一侧代码行。
 * @param {string[]} b - 另一侧代码行。
 * @returns {number} 0..1。
 */
function codeOverlap(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let shared = 0;
  for (const line of setA) if (setB.has(line)) shared += 1;
  return (2 * shared) / (setA.size + setB.size);
}

/**
 * 最长公共子序列比率（顺序敏感）——与 `codeOverlap` 一并报，用来区分重排与改写。
 * @param {string[]} a - 一侧代码行。
 * @param {string[]} b - 另一侧代码行。
 * @returns {number} 0..1。
 */
function lcsRatio(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return 1;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j]);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  return (2 * prev[m]) / (n + m);
}

/** 定位姊妹仓库：显式指定的，或本仓库同级目录下符合命名形态的目录。 */
function discoverSiblings() {
  if (explicitSiblings.length > 0) {
    return explicitSiblings.filter((dir) => existsSync(join(dir, "src")));
  }
  const parent = dirname(ROOT);
  let entries = [];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && SIBLING_PATTERN.test(e.name))
    .map((e) => join(parent, e.name))
    .filter((dir) => resolve(dir) !== resolve(ROOT) && existsSync(join(dir, "src")))
    .sort();
}

/** 分档标签。 */
function tierOf(ratio) {
  return TIERS.find((t) => ratio >= t.min).label;
}

/** 百分比整数。 */
function pct(value) {
  return `${Math.round(value * 100)}%`;
}

/** 主流程：对一个姊妹仓库产出报告。 */
function reportFor(sibling) {
  const siblingKey = (basename(sibling).match(/^dsh-connect-(.+)-token-plan$/) ?? [])[1] ?? basename(sibling);
  const ownFiles = walkTs(SRC);
  const theirSet = new Set(walkTs(join(sibling, "src")));
  const pairs = [];

  for (const rel of ownFiles) {
    if (!theirSet.has(rel)) continue;
    const ownPath = join(SRC, rel);
    const theirPath = join(sibling, "src", rel);
    const ownLines = codeLines(ownPath);
    const theirLines = codeLines(theirPath);
    const overlap = codeOverlap(ownLines, theirLines);
    // 逐行判宣称（混合陈述会把整段吞掉，见 claimLinesOf）；指名宣称只对它点名的
    // 那个仓库计数（见 claimsAbout），否则拿「与 sensenova 同源」去核对 agnes
    // 会得出一堆误报。
    const claimsSameOrigin = claimsAbout(headerOf(ownPath), siblingKey);
    pairs.push({
      file: rel,
      ownLines: ownLines.length,
      theirLines: theirLines.length,
      overlap,
      lcs: lcsRatio(ownLines, theirLines),
      tier: tierOf(overlap),
      claimsSameOrigin,
      claimMismatch: claimsSameOrigin && overlap < CLAIM_MISMATCH_BELOW
    });
  }

  const ownTotal = pairs.reduce((sum, p) => sum + p.ownLines, 0);
  const tiers = TIERS.map((t) => {
    const inTier = pairs.filter((p) => p.tier === t.label);
    return {
      label: t.label,
      files: inTier.length,
      lines: inTier.reduce((sum, p) => sum + p.ownLines, 0)
    };
  });

  return {
    sibling: basename(sibling),
    siblingKey,
    siblingPath: sibling,
    ownFileCount: ownFiles.length,
    pairedCount: pairs.length,
    ownCodeTotal: ownTotal,
    tiers,
    pairs: pairs.slice().sort((x, y) => y.overlap - x.overlap),
    mismatches: pairs.filter((p) => p.claimMismatch)
  };
}

/** 人读报告。 */
function printReport(report) {
  const { sibling, ownFileCount, pairedCount, ownCodeTotal, tiers, pairs, mismatches } = report;
  console.log(`\n=== 与 ${sibling} 的同源度 ===`);
  console.log(`同名文件 ${pairedCount} / 本仓 ${ownFileCount} 个；同名文件去注释代码合计 ${ownCodeTotal} 行`);
  console.log("\n分档（按本仓代码行）：");
  for (const t of tiers) {
    const share = ownCodeTotal === 0 ? 0 : t.lines / ownCodeTotal;
    console.log(
      `  ${t.label.padEnd(4)} ${String(t.files).padStart(3)} 个文件  ` +
      `${String(t.lines).padStart(5)} 行（${pct(share).padStart(4)}）`
    );
  }

  const top = pairs.filter((p) => p.overlap >= 0.85).slice(0, 8);
  if (top.length > 0) {
    console.log("\n最同源（若要抽共享内核，候选在这里）：");
    for (const p of top) console.log(`  ${pct(p.overlap).padStart(4)}  ${p.file}  (${p.ownLines} 行)`);
  }

  const bottom = pairs.filter((p) => p.overlap < 0.3).slice(-8).reverse();
  if (bottom.length > 0) {
    console.log("\n最不同源（同名而已，别按名字借代码）：");
    for (const p of bottom) console.log(`  ${pct(p.overlap).padStart(4)}  ${p.file}  (${p.ownLines} 行)`);
  }

  const reordered = pairs.filter((p) => p.overlap >= 0.85 && p.lcs < 0.5);
  if (reordered.length > 0) {
    console.log("\n排列不同但内容几乎相同（差异是重排，不是改写——LCS 会低估这些）：");
    for (const p of reordered) {
      console.log(`  ${p.file}  重叠 ${pct(p.overlap)} / LCS ${pct(p.lcs)}`);
    }
  }

  const claimed = pairs.filter((p) => p.claimsSameOrigin);
  console.log(`\n头注自我描述核对：${claimed.length} 处自称「同源 / 受控复制」`);
  if (claimed.length === 0) {
    console.log("  （无）");
  } else {
    for (const p of claimed) {
      const mark = p.claimMismatch ? "[不符]" : "[  ok]";
      console.log(`  ${mark} ${p.file}  实测重叠 ${pct(p.overlap)}`);
    }
  }
  if (mismatches.length > 0) {
    console.log(
      `\n${mismatches.length} 处宣称与实测不符（重叠 < ${pct(CLAIM_MISMATCH_BELOW)}）：` +
      "要么改措辞，要么改代码——现在这句话在误导读者。"
    );
  }
}

const siblings = discoverSiblings();
if (siblings.length === 0) {
  const absentNote =
    "cross-repo-drift: 未发现姊妹仓库（同级目录下没有 dsh-connect-*-token-plan）。\n" +
    "  这不是错误——本工具是诊断，不是门禁。要指定仓库用 --sibling <dir>。";
  // `--json` 是机器可读契约：**stdout 只能是 JSON**，人话改道 stderr。
  // 曾经的写法把上面这段打进 stdout 再 exit(0)，调用方（test/family-kernel.test.mjs）
  // 的 JSON.parse 在读到第一个字符时就 SyntaxError——于是它自己头注里写明的
  // 「姊妹不在场 = skip（CI 上必然走这条路）」从未生效，main 连红两次（48da3ea 起）。
  // 缺席是 skip，不是失败：退出码仍是 0，原因一条不少地留给使用者。
  if (asJson) {
    console.error(absentNote);
    console.log(JSON.stringify({ root: ROOT, reports: [], note: "no-siblings" }, null, 2));
  } else {
    console.log(absentNote);
  }
  process.exit(0);
}

const reports = siblings.map(reportFor);

if (asJson) {
  console.log(JSON.stringify({ root: ROOT, reports }, null, 2));
} else if (claimsOnly) {
  for (const report of reports) {
    console.log(`\n=== ${report.sibling} ===`);
    const claimed = report.pairs.filter((p) => p.claimsSameOrigin);
    for (const p of claimed) {
      console.log(`  ${p.claimMismatch ? "[不符]" : "[  ok]"} ${p.file}  实测重叠 ${pct(p.overlap)}`);
    }
    if (claimed.length === 0) console.log("  （本仓 src 里没有自称同源的头注）");
  }
} else {
  for (const report of reports) printReport(report);
  console.log("");
}

const totalMismatch = reports.reduce((sum, r) => sum + r.mismatches.length, 0);
if (strict && totalMismatch > 0) {
  console.error(`cross-repo-drift: --strict 下检出 ${totalMismatch} 处宣称与实测不符`);
  process.exit(1);
}
