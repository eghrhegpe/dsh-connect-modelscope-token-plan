/**
 * The submission draft against the LIVE marketplace entry — the half the
 * offline gate cannot see, and the only thing here that can.
 *
 * `test/docs.test.mjs` (the 投稿副本 block) pins the draft to this repository's own copy:
 * `locale/en.json`, `locale/zh.json`, `package.json#description`. That fence is
 * deliberately blind to upstream, and its header says so — an internally
 * consistent draft that is stale against upstream passes it, because a red
 * caused by someone else's `main` is nobody's regression and that is how a gate
 * stops being read. This file is the other half: it asks the marketplace what
 * our entry actually says, and reports the difference.
 *
 * Why it needs a clock rather than a push:
 *
 *   - Upstream changes on upstream's schedule. A per-push run measures our
 *     commit cadence, not the maintainers' edit cadence — the one week the
 *     `category` disagreement went unseen is exactly that shape (the entry was
 *     re-filed, or a description was corrected, and nothing on our side was
 *     touched, so nothing on our side ran).
 *   - A red here is INFORMATION. It says: the entry moved. Read it, then either
 *     adopt the upstream text into the draft or re-open the PR. It never means
 *     "revert a commit to turn this green".
 *
 * So it lives in `.github/workflows/submission-drift.yml`, on a `schedule`, with
 * no `continue-on-error`: on a scheduled workflow GitHub mails the owner when a
 * run fails, which is the "shows up the day it happens" property a
 * `continue-on-error` job inside ci.yml promises and cannot deliver.
 *
 * What counts as a divergence, and what may be declared:
 *
 *   `url` / `name`   never declarable. A draft pointing at another repository is
 *                    a bug, full stop.
 *   `category`       declarable. The valid set lives in upstream
 *   `description.*`  `contributing.md` and the maintainers re-file entries as
 *                    maintenance, not as a correction of your judgement. A PR
 *                    in flight is a real, temporary divergence.
 *
 * Three states per field, not two. A field both sides carry is either identical
 * or a divergence. A field ONE side does not carry is neither — it is UNKNOWN,
 * and unknown must never be read as "they match". The marketplace lets exactly
 * one field be omitted (`contributing.md` line 20: "Only `description.en` is
 * required… a maintainer will add it"), so an absent `description.zh` upstream
 * is legal, expected, and declarable. Every other field is required by the
 * marketplace, so its absence upstream means the published copy of our entry is
 * malformed — that is information about someone else's file, and it is red.
 *
 * A declaration lives in `awesome-dsh-plugin-submission/pending-drift.json` and
 * must name the exact pair it excuses plus the PR that ends it. It is checked
 * from BOTH sides: a divergence with no declaration is red, and a declaration
 * that no longer describes reality is ALSO red — either the PR landed (delete
 * the entry) or upstream moved somewhere else (the entry is now a lie). A
 * ledger that only ever grows is a mute button, and a mute button is the same
 * failure as `continue-on-error`.
 *
 * `"upstream": null` says "upstream does not have this field at all" — the only
 * shape that can express an absence. Without it an absence had nowhere to go:
 * the ledger demanded a string, so a missing upstream field could not be
 * declared at all, and the gate was red with no way to turn it green.
 *
 *   node test/submission-drift.mjs                 # fetch upstream (needs the network)
 *   node test/submission-drift.mjs --from <dir>    # read data/plugins/*.yml from a checkout
 *
 * `--from` is not a test hook: when this reds at 03:49 you will want to
 * reproduce it against the file GitHub is showing you, and raw.githubusercontent
 * is blocked on plenty of corporate networks (this repository's own dev machine
 * included — `api.github.com` answers, `raw.` times out).
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEntry } from "./helpers/submission-entry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_REPO = "awesome-dsh-plugin/awesome-dsh-plugin";
const UPSTREAM_BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_BRANCH}/data/plugins`;
const LEDGER_REL = "awesome-dsh-plugin-submission/pending-drift.json";
const TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;

/** The fields this fence compares, in report order. Only these three may be
 *  declared in the ledger; `url` and `name` are identity, not judgement. */
const COMPARED = ["url", "name", "category", "description.en", "description.zh"];
const DECLARABLE = new Set(["category", "description.en", "description.zh"]);

/** 市场要求存在的字段（上游 `scripts/lib/entries.mjs` 逐条检查，模板见
 *  `contributing.md` 第 9-20 行）。上游缺了这些 = 他们发布的那份条目坏了，
 *  不是我们与它之间的分歧。 */
const REQUIRED_UPSTREAM = new Set(["url", "name", "category", "description.en"]);

/** 唯一允许缺席的字段：`contributing.md` 第 20 行「Only `description.en` is
 *  required… 写不了中文就不写 `zh`，维护者会补上」。 */
const OPTIONAL_UPSTREAM = new Set(["description.zh"]);

// --- reading a submission file -------------------------------------------
//
// 解析器住在 test/helpers/submission-entry.mjs，离线那一半（docs.test.mjs 的
// 投稿副本块）import 的是同一个函数。两处各写一份、只靠一句注释要求「Keep
// identical」治不住漂移——这正是 tools/dev/cross-repo-drift.mjs 头注治过的病
// （同源副本铁器无门禁）。共用实现后，两个层级对同一份字节给出同一个读法，
// 不可能互相矛盾。
//
// 它用的是市场同款的真 YAML 解析器（js-yaml），不是逐行扫描：市场 CI 用
// js-yaml 读条目，我们若用自制解析器读，比较的就不是市场看到的东西——那是
// 假红（上游用 plain scalar，我们读成 undefined，判成一次漂移）与假绿（上游
// 的 description 之外另有一行 en:，我们取第一处，真漂移被吞）的来源。为什么
// 必须换、换成之前量到的数字，见那里的头注。

// --- reporting ------------------------------------------------------------

const SKIP_TAG = "SKIP submission-drift";

function summarise(lines) {
  const body = lines.join("\n");
  console.log(body);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, `\n### submission-drift\n\n\`\`\`\n${body}\n\`\`\`\n`);
    } catch {
      /* the step summary is a convenience; losing it must not change a verdict */
    }
  }
}

/** A skip is an environment fact, not a marketplace signal. It exits 0, the
 *  same shape as every other environment skip in this repository, but it
 *  prints the exact URL and the exact error and annotates the run, so a green
 *  scheduled job that never reached anything is visible as such instead of
 *  passing for a clean bill. */
function skip(reason, detail) {
  const lines = [
    `${SKIP_TAG} — ${reason}`,
    "",
    ...detail,
    "",
    "Nothing was compared. This is not a statement about the marketplace entry;",
    "it is a statement about this environment. Re-run once the network is back,",
    "or reproduce locally with `node test/submission-drift.mjs --from <checkout>/data/plugins`.",
  ];
  summarise(lines);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::warning title=submission-drift skipped::${reason}`);
  }
  process.exit(0);
}

/** Truncate around the first differing byte so a 400-character description
 *  reports the sentence that moved instead of 400 characters of eyeballing. */
function windowOf(value, other) {
  if (typeof value !== "string") return JSON.stringify(value);
  if (value.length <= 100) return JSON.stringify(value);
  let i = 0;
  while (i < value.length && i < other.length && value[i] === other[i]) i += 1;
  const start = Math.max(0, i - 30);
  const end = Math.min(value.length, i + 70);
  return `${start > 0 ? "…" : ""}${JSON.stringify(value.slice(start, end))}${end < value.length ? "…" : ""}`;
}

// --- the ledger -----------------------------------------------------------

function readLedger() {
  const path = join(ROOT, LEDGER_REL);
  if (!existsSync(path)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${LEDGER_REL} is not valid JSON: ${error.message}`);
  }
  const entries = parsed.entries ?? [];
  if (!Array.isArray(entries)) throw new Error(`${LEDGER_REL}: "entries" must be an array`);
  for (const [i, entry] of entries.entries()) {
    const at = `${LEDGER_REL} entries[${i}]`;
    if (!DECLARABLE.has(entry?.field)) {
      throw new Error(
        `${at}: field ${JSON.stringify(entry?.field)} cannot be declared. ` +
          `Declarable: ${[...DECLARABLE].join(", ")}. ` +
          `A wrong url or name is a bug, not an in-flight disagreement.`
      );
    }
    for (const key of ["upstream", "draft"]) {
      if (entry[key] === null) {
        // `"upstream": null` means "upstream does not have this field at all" —
        // the only shape that can express an absence. The draft side is the copy
        // we publish, so it always carries a value: null there is a lie about
        // our own file.
        if (key === "upstream") continue;
        throw new Error(
          `${at}: "draft" must be a string — the draft is the copy we publish, ` +
            `it always has a value. Only "upstream" may be null.`
        );
      }
      if (typeof entry[key] !== "string") {
        throw new Error(
          `${at}: "${key}" must be a string` +
            (key === "upstream" ? ' (or null when upstream has no such field)' : "")
        );
      }
    }
    if (typeof entry.pr !== "string" || !entry.pr.startsWith("https://")) {
      throw new Error(`${at}: "pr" must be the URL of the change that ends this divergence`);
    }
  }
  return entries;
}

// --- the upstream side ----------------------------------------------------

/** Malformed command line → exit 2, never exit 0. This used to `skip()` (exit 0
 *  plus "Re-run once the network is back"), which read as an environment fact
 *  and would have sent the reader re-running a command that cannot work. A
 *  missing flag value is a typo on the command line; the repository's shape for
 *  that is test/run-all.mjs's `die()`: message + usage + exit 2. */
function usageError(message) {
  console.error(`submission-drift: ${message}`);
  console.error("用法：node test/submission-drift.mjs [--from <checkout>/data/plugins]");
  process.exit(2);
}

function fetchTarget(file) {
  const fromIndex = process.argv.indexOf("--from");
  if (fromIndex !== -1) {
    const dir = process.argv[fromIndex + 1];
    // A flag without its value is a typo, not an environment fact: exiting 0 with
    // network advice would send the reader re-running a command that cannot work.
    // This repository's convention is exit 2 for a malformed command line
    // (test/run-all.mjs `die()`).
    if (dir === undefined) usageError("--from needs a directory");
    return { kind: "file", path: join(resolve(dir), `${file}.yml`), label: join(resolve(dir), `${file}.yml`) };
  }
  return { kind: "http", url: `${RAW_BASE}/${file}.yml`, label: `${RAW_BASE}/${file}.yml` };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function readUpstream(target) {
  if (target.kind === "file") {
    if (!existsSync(target.path)) {
      return { kind: "gone", label: target.label };
    }
    return { kind: "text", text: readFileSync(target.path, "utf8"), label: target.label };
  }

  let last = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(target.url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "dsh-submission-drift" },
      });
    } catch (error) {
      // No answer at all: DNS, a blocking proxy, a firewall. Returned at once
      // rather than retried — a host that does not answer does not answer the
      // second time either, and three timeouts would spend a minute learning
      // what the first one already said. 5xx below is the transient class and
      // is the only thing worth retrying.
      return { kind: "no-answer", label: target.url, why: `${error.name}: ${error.message}` };
    }
    if (response.status === 404) return { kind: "gone", label: target.url };
    if (response.status === 403 || response.status === 429) {
      // A shared runner IP hitting a rate limit says nothing about the entry.
      return { kind: "unavailable", label: target.url, why: `HTTP ${response.status} (rate limited)` };
    }
    if (response.status >= 500) {
      last = `HTTP ${response.status}`;
      if (attempt < ATTEMPTS) await sleep(2_000 * attempt);
      continue;
    }
    if (!response.ok) return { kind: "unavailable", label: target.url, why: `HTTP ${response.status}` };
    return { kind: "text", text: await response.text(), label: target.url };
  }
  return { kind: "unavailable", label: target.url, why: `${last} on ${ATTEMPTS} attempts` };
}

// --- main -----------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const repoUrl = String(pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
const slug = repoUrl.replace(/^https:\/\/github\.com\//, "");

// Without this, a package.json whose repository is missing or is not on GitHub
// would silently build the URL `<RAW_BASE>/.yml` and the run would report a
// gone entry — blaming the marketplace for a local manifest bug.
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) {
  summarise([
    "submission-drift: package.json#repository is not a github.com owner/repo URL",
    "",
    `  repository: ${JSON.stringify(pkg.repository?.url ?? null)}`,
    `  derived:    ${JSON.stringify(slug)}`,
    "",
    "The upstream path is derived from that field, so nothing sensible can be",
    "asked. Fix the manifest before reading anything into this run.",
  ]);
  process.exit(1);
}

const file = slug.replace("/", "__");
const draftRel = `awesome-dsh-plugin-submission/${file}.yml`;

if (!existsSync(join(ROOT, draftRel))) {
  skip(`this repository ships no submission draft (${draftRel})`, [
    "There is nothing to compare against upstream. The draft directory exists to",
    "hold the text that was submitted; a repository without one has no live entry",
    "to drift from.",
  ]);
}

let ledger;
try {
  ledger = readLedger();
} catch (error) {
  summarise(["submission-drift: the pending-drift ledger is malformed", "", error.message]);
  process.exit(1);
}

const draft = parseEntry(readFileSync(join(ROOT, draftRel), "utf8"));
if (!draft.ok) {
  // Our own draft, read with the marketplace's parser. If it does not parse,
  // the marketplace would refuse the file — and every comparison below would be
  // against a fiction, so this is a hard stop, not a divergence.
  summarise([
    "submission-drift: the submission draft is not valid YAML",
    "",
    `  draft: ${draftRel}`,
    `  why:   ${draft.error}`,
    "",
    "The marketplace parses entries with js-yaml, and this gate reads the draft with",
    "the same parser. A draft that does not parse would be refused there, so there is",
    "nothing meaningful to compare. Fix the file, then re-run.",
  ]);
  process.exit(1);
}

const target = fetchTarget(file);
const upstream = await readUpstream(target);

if (upstream.kind === "gone") {
  // Two very different failures share this shape, and conflating them sends the
  // reader to the wrong place: a 404 from upstream means the listing is gone,
  // while a missing file under `--from` means the path they typed is wrong (or
  // that checkout predates the entry). Nothing was asked of the marketplace in
  // the second case, so it must not claim an answer.
  const local = target.kind === "file";
  summarise([
    `submission-drift: ${local ? "no such file in the checkout you pointed --from at" : "the marketplace entry is GONE"}`,
    "",
    `  asked:    ${upstream.label}`,
    `  draft:    ${draftRel}`,
    "",
    ...(local
      ? [
          "`--from` reads a local checkout, so nothing was asked of the marketplace.",
          "Point it at `<checkout>/data/plugins` — the directory holding",
          "`<owner>__<repo>.yml` — or drop the flag to ask upstream over the network.",
        ]
      : [
          "Upstream answered, and there is no file at that path. The entry was removed",
          "or renamed — either way this repository's listing no longer exists in the",
          "marketplace. Check the upstream repository's history for the removal, then",
          "either re-submit the draft or delete it here so the offline gate stops",
          "pinning text nobody reads.",
        ]),
  ]);
  process.exit(1);
}

if (upstream.kind === "no-answer") {
  skip(`nothing answered at ${upstream.label} (${upstream.why})`, [
    `  asked:    ${upstream.label}`,
    "",
    "DNS did not resolve, a proxy refused, or the connection timed out. The file",
    "was never requested, so this run knows nothing about the entry — including",
    "whether it still exists.",
  ]);
}

if (upstream.kind === "unavailable") {
  skip(`the host answered without the file (${upstream.why})`, [
    `  asked:    ${upstream.label}`,
    "",
    "The request reached a server, but the answer was a rate limit or an outage",
    "rather than the entry. On a shared runner IP this is routine and says",
    "nothing about the marketplace.",
  ]);
}

const live = parseEntry(upstream.text);
if (!live.ok) {
  // Their file, read with the same parser the marketplace uses. A marketplace
  // entry that does not parse is not a disagreement between the two copies —
  // it is a broken file on their side, and it needs a maintainer.
  summarise([
    "submission-drift: the marketplace entry is not valid YAML",
    "",
    `  upstream: ${upstream.label}`,
    `  why:      ${live.error}`,
    "",
    "The marketplace publishes this file as-is, so a file that does not parse is a",
    "broken entry on their side — not something the ledger can excuse. Re-run with",
    "--from against a local checkout to confirm the bytes you are looking at.",
  ]);
  process.exit(1);
}

const report = [
  `submission-drift: ${slug}`,
  `  draft:    ${draftRel}`,
  `  upstream: ${upstream.label}`,
  "",
];

// Three states per field, not two. A field both sides carry is either identical
// or a divergence. A field ONE side does not carry is UNKNOWN — and unknown must
// never be read as "they match". That mistake is not hypothetical: with the old
// line-by-line parser, an upstream description this gate could not read came
// back as undefined on both sides, undefined === undefined said "identical", and
// a real divergence passed with EXIT=0.
const diverged = [];
const absentRequired = [];
const problems = [];

for (const field of COMPARED) {
  const upstreamValue = live.get(field);
  const draftValue = draft.get(field);

  if (upstreamValue === undefined && draftValue === undefined) {
    report.push(`  ${field.padEnd(16)} identical (neither side carries it)`);
    continue;
  }

  if (draftValue === undefined) {
    if (OPTIONAL_UPSTREAM.has(field)) {
      // `description.zh` is the one field the marketplace lets you omit
      // (contributing.md line 20: "Only `description.en` is required… a
      // maintainer will add it"). A maintainer adding the Chinese text on their
      // side is the guide working as designed, not a drift.
      report.push(`  ${field.padEnd(16)} upstream carries one, our draft does not`);
      report.push(`  ${"".padEnd(16)} upstream: ${windowOf(upstreamValue, "")}`);
      report.push(`  ${"".padEnd(16)} (expected: a maintainer adds the translation)`);
      continue;
    }
    // The draft is the copy we publish. Missing a field the marketplace has
    // means our copy is behind — our bug, and no ledger entry can excuse it.
    problems.push(
      `the draft is missing ${field}, which the marketplace entry carries. ` +
        `Fix ${draftRel} (and the copies in locale/*.json + package.json, or the ` +
        `offline gate will red).`
    );
    report.push(`  ${field.padEnd(16)} MISSING IN DRAFT`);
    continue;
  }

  if (upstreamValue === undefined) {
    if (REQUIRED_UPSTREAM.has(field)) {
      // A required field is missing from the marketplace's copy. That is
      // information about their file, and it is red — but the ledger can still
      // carry it, because `"upstream": null` is the one shape that expresses an
      // absence.
      absentRequired.push(field);
      report.push(`  ${field.padEnd(16)} UPSTREAM HAS NO ${field.toUpperCase()}`);
      report.push(`  ${"".padEnd(16)} draft:    ${windowOf(draftValue, "")}`);
      continue;
    }
    // Legal and expected: the marketplace does not require a translation.
    report.push(`  ${field.padEnd(16)} upstream carries no ${field}`);
    report.push(`  ${"".padEnd(16)} draft:    ${windowOf(draftValue, "")}`);
    report.push(`  ${"".padEnd(16)} (legal: only description.en is required upstream)`);
    continue;
  }

  if (upstreamValue === draftValue) {
    report.push(`  ${field.padEnd(16)} identical`);
    continue;
  }

  diverged.push(field);
  report.push(`  ${field.padEnd(16)} DRIFT`);
  report.push(`  ${"".padEnd(16)} upstream: ${windowOf(upstreamValue, draftValue)}`);
  report.push(`  ${"".padEnd(16)} draft:    ${windowOf(draftValue, upstreamValue)}`);
}

// A declaration has to describe a divergence that is actually there. If it does
// not, the entry has outlived its reason and is now just a comment.
//
// `upstream: null` in a declaration means "upstream does not have this field
// at all". That is the only shape that can express an absence, so the reality
// check compares `value ?? null` on both sides: an absent field and a declared
// null are the same fact.
for (const entry of ledger) {
  const actualUpstream = live.get(entry.field) ?? null;
  const actualDraft = draft.get(entry.field) ?? null;
  const declaredUpstream = entry.upstream ?? null;
  if (actualUpstream === actualDraft) {
    problems.push(
      `stale declaration: ${entry.field} now matches upstream (${JSON.stringify(actualUpstream)}). ` +
        `The change this entry excused has landed — delete it from ${LEDGER_REL}.`
    );
    continue;
  }
  if (declaredUpstream !== actualUpstream || entry.draft !== actualDraft) {
    problems.push(
      `declaration no longer describes reality: ${entry.field} is declared as ` +
        `upstream ${JSON.stringify(declaredUpstream)} → draft ${JSON.stringify(entry.draft)}, but it is now ` +
        `upstream ${JSON.stringify(actualUpstream)} → draft ${JSON.stringify(actualDraft)}. ` +
        `Upstream moved somewhere else; decide again and update ${LEDGER_REL}.`
    );
  }
}

// Every divergence needs a declaration, and identity fields can never have one.
for (const field of diverged) {
  const declared = ledger.find((entry) => entry.field === field);
  if (declared === undefined) {
    problems.push(
      DECLARABLE.has(field)
        ? `undeclared divergence on ${field}. Either adopt the upstream text into ${draftRel} ` +
          `(the same words — the comparison is by value, not by spelling — and then into ` +
          `locale/*.json + package.json, or the offline gate will red), or — if a PR is in ` +
          `flight — declare this exact pair in ${LEDGER_REL} with the PR that ends it.`
        : `${field} diverges and cannot be declared: the draft points somewhere other than this ` +
          `repository. Fix ${draftRel}.`
    );
  }
}

// An absent required field upstream is a divergence we cannot compare — and the
// ledger is where that fact lives, as `"upstream": null`.
for (const field of absentRequired) {
  const declared = ledger.find((entry) => entry.field === field);
  if (declared === undefined) {
    problems.push(
      DECLARABLE.has(field)
        ? `the marketplace entry has no ${field}, which the marketplace requires. ` +
          `That is a malformed copy on their side, not a disagreement between the two. ` +
          `If a PR is fixing it, declare it in ${LEDGER_REL} with "upstream": null and ` +
          `that PR; otherwise report it upstream.`
        : `the marketplace entry has no ${field}. That is a malformed copy on their side, ` +
          `and ${field} is an identity field, so no ledger entry can excuse it — report it ` +
          `upstream.`
    );
  }
}

const declaredCount = [...diverged, ...absentRequired].filter((field) =>
  ledger.some((entry) => entry.field === field)
).length;

if (problems.length > 0) {
  report.push("");
  for (const problem of problems) report.push(`  ✗ ${problem}`);
  report.push("");
  report.push(`FAIL — ${problems.length} problem(s) against the live entry.`);
  summarise(report);
  process.exit(1);
}

if (diverged.length === 0 && absentRequired.length === 0) {
  report.push("");
  report.push("OK — the draft and the live entry say the same thing.");
  summarise(report);
  process.exit(0);
}

report.push("");
for (const field of [...diverged, ...absentRequired]) {
  const entry = ledger.find((candidate) => candidate.field === field);
  report.push(`  declared: ${field} — ${entry.pr}`);
  if (entry.note) report.push(`            ${entry.note}`);
}
report.push("");
report.push(
  `OK — ${declaredCount} divergence(s), each declared and each with a PR that ends it. ` +
    `This run will red the day one of those PRs lands, so the declaration gets deleted.`
);
summarise(report);
