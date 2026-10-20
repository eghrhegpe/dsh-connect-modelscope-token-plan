/**
 * submission-drift.test.mjs — 投稿副本 vs 市场线上条目：联网那一半的离线夹具。
 *
 * 守的是什么：`test/submission-drift.mjs` 是本仓唯一能看见市场线上条目现在写
 * 的是什么的代码，它住在定时档里（.github/workflows/submission-drift.yml），
 * **每次 push 都不跑**。从前它在本地零覆盖——`test/run-all.mjs` 的 glob 只捞
 * `*.test.mjs`，而这个文件刻意不叫那个名字（它要住在 test/ 下、能被 workflow
 * 直接 `node` 跑，但不该被门禁当成一个套件）。于是它带着「发出去的字节」独自
 * 漂了：台账协议、退出码、解析器的假 DRIFT，全都在没人跑过的路径上。
 *
 * 怎么覆盖：`--from` 让它对着一个本地目录比对上游条目，**零网络**。这个套件把
 * 脚本连同 helpers/、package.json、投稿目录**逐字节复制**进一个临时 ROOT，再对
 * 临时 ROOT 里的那份跑各个场景——被测的就是发货的那份字节（不是重写的等价
 * 物），草稿、台账、fixture 全在临时目录里，一个字节都不碰本仓。
 *
 * 临时 ROOT 放在 `<repo>/tmp/` 下，不放 `os.tmpdir()`：共享解析器要用
 * `js-yaml`（市场的同款解析器），而 `require` 是按目录逐级上溯 `node_modules`
 * 的——临时树要是落在仓外，从它到仓的 `node_modules` 之间断了一条链，模块就
 * 找不到，报错还长得像「依赖没装」。`tmp/` 在 .gitignore 里，用完即删。
 *
 * 场景对应的每一条都是已实证的缺陷或裁定（不钉住就会漂回去）：
 *
 *   - 台账协议：声明过的分歧放行；过期的声明（PR 落地了）判红；声明与现实不符
 *     判红；未声明的分歧判红；url/name 这类身份字段永远不可声明。
 *   - 台账畸形：非法 field、非 https 的 pr、entries 不是数组、JSON 坏掉，全部
 *     判红——台账坏了必须是红，不是静默放行。
 *   - 退出码：`--from` 漏给值是命令行笔误 → 2（不是「环境事实」→ 0）；没有草稿
 *     → 0 且明说 SKIP；`--from` 指向没有该文件的 checkout → 1（不是问过上游的
 *     404）。
 *   - 解析器：行尾注释（`en: '…' # note`）两侧都剥掉，不该判成假 DRIFT；`''`
 *     转义要反转义；引号后无空白贴着 `#` 不是合法 YAML → 判红（现在报的是
 *     「YAML 不合法」，不是猜出来的 DRIFT）。
 *   - **真 YAML 语义**（换成市场同款解析器之前，这几条全都不成立）：
 *     上游用无引号 plain scalar（市场的模板就是这样）、用双引号、category 带引号
 *     但语义相同——都必须算「一致」，从前它们一律读成 undefined 判成假 DRIFT；
 *     反过来，上游在 `description:` 之外另有一行顶层 `en:` 时，真漂移必须被抓
 *     出来，从前取第一处匹配把它吞了。
 *   - **三态**：一侧没有的字段是「读不出」，不是「相同」也不是「不同」。
 *     `description.zh` 缺席合法（市场只要求 en），别的必填字段缺席 = 他们那份
 *     坏了 = 红；台账可以用 `"upstream": null` 表达一次缺席。
 *   - 报告：长描述只报第一处差异附近的窗口，不倒 400 个字符。
 *
 * @module test/submission-drift.test
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SCRIPT = join(HERE, "submission-drift.mjs");
const HELPER = join(HERE, "helpers", "submission-entry.mjs");

/** 临时 ROOT 里的包名。slug 决定草稿文件名：owner/repo → owner__repo.yml。 */
const SLUG = "example/example";
const SLUG_FILE = "example__example.yml";
const DRAFT_REL = `awesome-dsh-plugin-submission/${SLUG_FILE}`;
const LEDGER_REL = "awesome-dsh-plugin-submission/pending-drift.json";

const ELLIPSIS = "…"; // windowOf 的截断标记（U+2026，与报告里的破折号 U+2014 不同）

const EN =
  "Connect ModelScope models into DSH (off by default), with a model's info page and local call counts.";
const ZH = "一键接入魔搭社区的模型到 DSH（默认关），可查看模型信息页与本地调用计数。";

/** 造一份投稿副本。`enLine` / `zhLine` 可以整行替换（用来造 plain scalar、
 *  双引号、行尾注释、非法 YAML 这类边界），`drop` 可以整行去掉（造缺席），
 *  其余字段按 YAML 单引号标量规则转义成 `''`。 */
const draftOf = (over = {}) => {
  const o = { url: `https://github.com/${SLUG}`, name: SLUG, category: "model", en: EN, zh: ZH, ...over };
  const lines = [
    "# Submission draft for awesome-dsh-plugin.",
    `url: ${o.url}`,
    `name: ${o.name}`,
    `category: ${o.category}`,
    "description:",
  ];
  if (!o.drop?.includes("en")) {
    lines.push(`  en: ${o.enLine ?? `'${o.en.replaceAll("'", "''")}'`}`);
  }
  if (!o.drop?.includes("zh")) {
    lines.push(`  zh: ${o.zhLine ?? `'${o.zh.replaceAll("'", "''")}'`}`);
  }
  return lines.join("\n");
};

const DEFAULT_PKG = { name: "example", repository: { url: `git+https://github.com/${SLUG}.git` } };

/** 一条合法声明（本仓真台账里那条的样子）。 */
const CATEGORY_DECLARATION = {
  field: "category",
  upstream: "usage",
  draft: "model",
  pr: "https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8207",
  note: "Re-filed upstream; merges when a maintainer takes it.",
};

/** 建一个可跑的临时 ROOT：脚本 + helpers + package.json + 投稿目录。
 *  目录形状照抄本仓——脚本住在 `test/` 下，ROOT 是它自己的父目录，所以临时
 *  ROOT 里也必须把脚本放在 `test/` 里，否则它会去读上一级目录的 package.json。 */
function makeRoot(dir, { draft = draftOf(), ledger = null, pkg = DEFAULT_PKG } = {}) {
  mkdirSync(join(dir, "awesome-dsh-plugin-submission"), { recursive: true });
  mkdirSync(join(dir, "test", "helpers"), { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  if (draft !== null) writeFileSync(join(dir, DRAFT_REL), draft);
  if (ledger !== null) {
    writeFileSync(
      join(dir, LEDGER_REL),
      typeof ledger === "string" ? ledger : `${JSON.stringify(ledger, null, 2)}\n`
    );
  }
  // 逐字节复制：被测物就是发货的那份脚本与那份共享解析器。
  copyFileSync(SCRIPT, join(dir, "test", "submission-drift.mjs"));
  copyFileSync(HELPER, join(dir, "test", "helpers", "submission-entry.mjs"));
}

/** 造一个上游 fixture 目录（`--from` 指向的那个），文本为 null 表示目录里没有该文件。 */
function makeFixture(dir, text) {
  const out = join(dir, "fixture");
  mkdirSync(out, { recursive: true });
  if (text !== null) writeFileSync(join(out, SLUG_FILE), text);
  return out;
}

/** 跑临时 ROOT 里的脚本。环境是净的：脚本只认 GITHUB_STEP_SUMMARY /
 *  GITHUB_ACTIONS 两个 env，删掉它们，别的照常（不制造「CI 里行为不同」的洞）。 */
function run(root, args) {
  const env = { ...process.env, MODELSCOPE_API_KEY: "" };
  delete env.GITHUB_STEP_SUMMARY;
  delete env.GITHUB_ACTIONS;
  const res = spawnSync(process.execPath, [join(root, "test", "submission-drift.mjs"), ...args], {
    encoding: "utf8",
    cwd: root,
    env,
    timeout: 30_000,
  });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// 临时树放在仓内：共享解析器要 require("js-yaml")，而 require 逐级上溯
// node_modules——落在仓外就断了链，症状长得像「依赖没装」。
const TMP_BASE = join(REPO, "tmp");
mkdirSync(TMP_BASE, { recursive: true });
const tmpRoot = mkdtempSync(join(TMP_BASE, "ms-submission-drift-"));
let scenarioIndex = 0;

/** 跑一个场景：建 ROOT、造 fixture、跑脚本、按期望断言退出码与输出。 */
function scenario(name, { draft, ledger, pkg, upstream = null, args, code, includes = [], excludes = [] }) {
  scenarioIndex += 1;
  const dir = join(tmpRoot, `case-${scenarioIndex}`);
  mkdirSync(dir, { recursive: true });
  makeRoot(dir, { draft, ledger, pkg });
  const fixture = makeFixture(dir, upstream);
  const argv = args ?? ["--from", fixture];
  const res = run(dir, argv);
  const where = `${name}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`;
  assert.equal(res.code, code, `${where}\n（期望退出码 ${code}，实际 ${res.code}）`);
  for (const needle of includes) {
    assert.ok(
      res.stdout.includes(needle) || res.stderr.includes(needle),
      `${where}\n（输出里应含 ${JSON.stringify(needle)}）`
    );
  }
  for (const needle of excludes) {
    assert.ok(!res.stdout.includes(needle), `${where}\n（输出里不该含 ${JSON.stringify(needle)}）`);
  }
}

try {
  // ── 一致：两侧说同一句话 ────────────────────────────────────────────────
  scenario("两侧一致 → 放行", {
    upstream: draftOf(),
    code: 0,
    includes: ["the draft and the live entry say the same thing", "identical"],
  });

  // ── 未声明的分歧 → 判红 ────────────────────────────────────────────────
  scenario("category 分歧且未声明 → 判红", {
    upstream: draftOf({ category: "usage" }),
    code: 1,
    includes: ["undeclared divergence on category", "problem(s) against the live entry"],
  });

  // ── 声明过的分歧 → 放行（台账协议的正例） ──────────────────────────────
  scenario("category 分歧已声明 → 放行", {
    upstream: draftOf({ category: "usage" }),
    ledger: { entries: [CATEGORY_DECLARATION] },
    code: 0,
    includes: ["declared: category", "each declared and each with a PR that ends it"],
  });

  // ── 过期声明：PR 落地了 → 判红（台账只增不减 = 静音键） ───────────────
  scenario("声明已过期（两侧已相同）→ 判红", {
    upstream: draftOf(),
    ledger: { entries: [CATEGORY_DECLARATION] },
    code: 1,
    includes: ["stale declaration: category now matches upstream"],
  });

  // ── 声明与现实不符 → 判红 ──────────────────────────────────────────────
  scenario("声明与现实不符 → 判红", {
    upstream: draftOf({ category: "other" }),
    ledger: { entries: [CATEGORY_DECLARATION] },
    code: 1,
    includes: ["declaration no longer describes reality: category"],
  });

  // ── 身份字段不可声明 ──────────────────────────────────────────────────
  scenario("url 分歧不可声明 → 判红", {
    upstream: draftOf({ url: "https://github.com/other/other" }),
    code: 1,
    includes: ["url diverges and cannot be declared"],
  });

  // ── 台账畸形：四种坏法都判红 ──────────────────────────────────────────
  scenario("台账 field 不可声明 → 判红", {
    upstream: draftOf(),
    ledger: { entries: [{ ...CATEGORY_DECLARATION, field: "url" }] },
    code: 1,
    includes: ["cannot be declared", "Declarable: category"],
  });

  scenario("台账 pr 不是 https → 判红", {
    upstream: draftOf(),
    ledger: { entries: [{ ...CATEGORY_DECLARATION, pr: "http://example.com/pr" }] },
    code: 1,
    includes: ['"pr" must be the URL of the change that ends this divergence'],
  });

  scenario("台账 entries 不是数组 → 判红", {
    upstream: draftOf(),
    ledger: { entries: { field: "category" } },
    code: 1,
    includes: ['"entries" must be an array'],
  });

  scenario("台账 JSON 坏掉 → 判红", {
    upstream: draftOf(),
    ledger: "{ not json",
    code: 1,
    includes: ["is not valid JSON"],
  });

  // ── 退出码：三种「什么都没比」必须各说各的 ────────────────────────────
  scenario("没有草稿 → 0 且明说 SKIP", {
    draft: null,
    code: 0,
    includes: ["SKIP submission-drift", "ships no submission draft"],
  });

  scenario("--from 漏给值 → 2（命令行笔误，不是环境事实）", {
    args: ["--from"],
    code: 2,
    includes: ["--from needs a directory"],
  });

  scenario("--from 指向没有该文件的 checkout → 1", {
    upstream: null,
    code: 1,
    includes: ["no such file in the checkout you pointed --from at"],
  });

  scenario("package.json 的 repository 不是 github → 1", {
    pkg: { name: "example", repository: { url: "https://gitlab.com/example/example" } },
    code: 1,
    includes: ["package.json#repository is not a github.com owner/repo URL"],
  });

  // ── 解析器：行尾注释不是假 DRIFT（这正是从前的误报源） ────────────────
  scenario("上游标量带行尾注释 → 仍算一致", {
    upstream: draftOf({ enLine: `'${EN.replaceAll("'", "''")}' # upstream added a note` }),
    code: 0,
    includes: ["the draft and the live entry say the same thing"],
  });

  scenario("上游 field 带行尾注释 → 仍算一致", {
    upstream: draftOf({ category: "model # filed under model" }),
    code: 0,
    includes: ["the draft and the live entry say the same thing"],
  });

  scenario("引号后无空白贴着 # → 整份不是合法 YAML，判红并说清是 YAML 的问题", {
    upstream: draftOf({ enLine: `'${EN.replaceAll("'", "''")}'#note` }),
    code: 1,
    includes: ["the marketplace entry is not valid YAML"],
  });

  // ── 真 YAML 语义：写法不同不等于内容不同（换解析器之前全判错） ────────
  scenario("上游用 plain scalar（市场的模板写法）且同文 → 一致", {
    upstream: draftOf({ enLine: EN }),
    code: 0,
    includes: ["the draft and the live entry say the same thing"],
  });

  scenario("上游用双引号且同文 → 一致", {
    upstream: draftOf({ enLine: `"${EN}"` }),
    code: 0,
    includes: ["the draft and the live entry say the same thing"],
  });

  scenario("category 带引号但语义相同 → 一致", {
    upstream: draftOf({ category: "'model'" }),
    code: 0,
    includes: ["the draft and the live entry say the same thing"],
  });

  scenario("上游用 plain scalar 且内容不同 → 真 DRIFT（从前读成 undefined 而漏掉）", {
    upstream: draftOf({ enLine: "A different description entirely." }),
    code: 1,
    includes: ["description.en", "DRIFT"],
  });

  scenario("上游在 description 之外另有一行顶层 en: → 真漂移必须被抓（从前被吞）", {
    upstream: [
      "# Upstream copy.",
      "url: https://github.com/example/example",
      "name: example/example",
      "category: model",
      // 诱饵：内容与我们的草稿**相同**。从前解析器取第一处 `en: ` 匹配，读到
      // 这行 → 与草稿相同 → 「一致」→ 真漂移被吞（EXIT=0）。真解析器按结构读
      // description.en，读到的才是真值。
      `en: '${EN.replaceAll("'", "''")}'`,
      "description:",
      "  en: 'Totally different upstream text.'",
      "  zh: '完全不同的上游文案。'",
    ].join("\n"),
    code: 1,
    includes: ["description.en", "DRIFT"],
  });

  scenario("上游用折行标量（>-）且同文 → 一致", {
    upstream: [
      "url: https://github.com/example/example",
      "name: example/example",
      "category: model",
      "description:",
      "  en: >-",
      `    ${EN}`,
      "  zh: '一键接入魔搭社区的模型到 DSH（默认关），可查看模型信息页与本地调用计数。'",
    ].join("\n"),
    code: 0,
    includes: ["the draft and the live entry say the same thing"],
  });

  scenario("草稿自己用 plain scalar → 一致（我们自己的稿子也该被真解析器接受）", {
    draft: draftOf({ enLine: EN }),
    upstream: draftOf(),
    code: 0,
    includes: ["the draft and the live entry say the same thing"],
  });

  // ── 三态：读不出 ≠ 相同，也 ≠ 不同 ────────────────────────────────────
  scenario("上游缺 description.en（必填）→ 判红并说是他们那份坏了", {
    upstream: draftOf({ drop: ["en"] }),
    code: 1,
    includes: ["the marketplace entry has no description.en"],
  });

  scenario("上游缺 description.zh（可选，市场只要求 en）→ 不算分歧", {
    upstream: draftOf({ drop: ["zh"] }),
    code: 0,
    includes: ["the draft and the live entry say the same thing"],
  });

  scenario("上游有 zh 而我们的草稿没有（维护者补的译文）→ 不算分歧", {
    draft: draftOf({ drop: ["zh"] }),
    upstream: draftOf(),
    code: 0,
    includes: ["the draft and the live entry say the same thing"],
  });

  scenario("台账用 \"upstream\": null 声明一次缺席 → 放行（唯一能表达「没有」的形状）", {
    upstream: draftOf({ drop: ["en"] }),
    ledger: {
      entries: [
        {
          field: "description.en",
          upstream: null,
          draft: EN,
          pr: "https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8208",
          note: "Upstream file is missing the description; a PR restores it.",
        },
      ],
    },
    code: 0,
    includes: ["declared: description.en"],
  });

  scenario("台账声明 upstream=null 但上游其实有 → 判红（声明与现实不符）", {
    upstream: draftOf({ en: "Upstream says something else." }),
    ledger: {
      entries: [
        {
          field: "description.en",
          upstream: null,
          draft: EN,
          pr: "https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8208",
        },
      ],
    },
    code: 1,
    includes: ["declaration no longer describes reality: description.en"],
  });

  scenario("草稿缺必填字段 → 判红（是我们自己的稿子坏了）", {
    draft: draftOf({ drop: ["en"] }),
    upstream: draftOf(),
    code: 1,
    includes: ["the draft is missing description.en"],
  });

  // ── 非法 YAML：两份都得说清是谁的 YAML 不合法 ─────────────────────────
  scenario("草稿不是合法 YAML（未加引号且含 ': '）→ 判红并说是我们的稿子", {
    draft: draftOf({ enLine: "Vision toolkit: OCR, grounding and pixel diff." }),
    upstream: draftOf(),
    code: 1,
    includes: ["the submission draft is not valid YAML"],
  });

  scenario("上游不是合法 YAML → 判红并说是他们那份", {
    upstream: draftOf({ enLine: "Vision toolkit: OCR, grounding and pixel diff." }),
    code: 1,
    includes: ["the marketplace entry is not valid YAML"],
  });

  // ── 报告形状：长描述只报第一处差异附近的窗口 ──────────────────────────
  {
    const base = "x".repeat(150);
    const long = `${base}A${"y".repeat(200)}`;
    const other = `${base}B${"y".repeat(200)}`;
    scenario("长描述只报差异附近的窗口", {
      draft: draftOf({ en: other }),
      upstream: draftOf({ en: long }),
      code: 1,
      includes: [ELLIPSIS],
      excludes: [long, other],
    });
  }

  scenario("短描述整段报出（不截断）", {
    draft: draftOf({ zh: "短文本" }),
    upstream: draftOf({ zh: "另一段" }),
    code: 1,
    includes: ['"短文本"'],
    excludes: [ELLIPSIS],
  });
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

console.log("submission-drift.test.mjs: all checks passed");
