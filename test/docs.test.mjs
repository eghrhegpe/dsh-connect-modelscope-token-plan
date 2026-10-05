// 文档完整性门禁：README / docs 里的**可验证断言**必须与代码现实一致。
//
// 为什么需要它：本仓库的漂移全部发生在**文档**侧，而 20 个套件只钉得住代码。
// 已实际发生过的三类事故（2026-10-05 审计，逐条复现）：
//   ① 文档承诺的交付物不存在——PROVIDER-M4.md 两处写「归档为 docs/PROVIDER.md」、
//      README.md 文档地图指向 sensenova 仓库的 docs/ARCHITECTURE.md，两个文件都不在；
//   ② 已删除的配置项在文档里仍被描述为现存——`dailyQuotaTotal`/`dailyQuotaPerModel`
//      在 IMPLEMENTATION.md / SPIKE.md / REFERENCES.md 三处仍以现在时出现，而
//      config.test.mjs 正在断言「它们不许回来」；
//   ③ 文档声称某测试钉住了某不变量，而那个断言根本不存在——PROVIDER-M4.md 说
//      `test/config.test.mjs` 钉住 client/host 的 PROVIDER_PATH 相等，实际零引用。
//
// 判据刻意是**静态文本**检查：不联网、不 import peer、干净 checkout 可跑。它不
// 试图理解语义（做不到），只验证三类**机械可判**的承诺。宁可窄而硬。

import { strict as assert } from "node:assert";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

// ── §1 文档地图：README 里链到的每个仓库内文件都必须存在 ────────────────
//
// 只查**仓库内**相对链接（`](docs/x.md)`、`](assets/x.png)` 等）；`http(s)://`
// 外链与锚点跳过——那些的失效不归本门禁管，也不该为了它们联网。
{
  const readme = read("README.md");
  const linked = [...readme.matchAll(/\]\((?!https?:|#)([^)#\s]+)\)/g)].map((m) => m[1]);
  assert.ok(linked.length > 0, "README 应当至少链到一个仓库内文件");
  for (const target of linked) {
    assert.ok(
      existsSync(join(root, target)),
      `README 链接的 ${target} 不存在——文档地图指向了不存在的文件（这正是 docs/PROVIDER.md 与 docs/ARCHITECTURE.md 的事故形态）`
    );
  }
}

// ── §2 反向：docs/ 下的每个文件都要在 README 文档地图里出现 ──────────────
//
// 防止「新增了文档但没人找得到」。PROVIDER-M4.md 与 SPIKE.md 都在地图里；
// 新增文档而不登记会让它变成孤儿。
{
  const readme = read("README.md");
  const docs = readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md"));
  assert.ok(docs.length > 0, "docs/ 应当有文档");
  for (const doc of docs) {
    assert.ok(
      readme.includes(`docs/${doc}`),
      `docs/${doc} 不在 README 文档地图里——新增文档请登记，否则没人会读到它`
    );
  }
}

// ── §3 死配置：已删除的配置项不得以「现存配置」的口吻出现 ────────────────
//
// config.test.mjs 已经钉住它们不在 CONFIG_DEFAULTS / cordis.patch.yml 里。
// 这里钉住**文档**也不再声称它们存在。允许两种安全写法：
//   · 句子里带删除/作废语（删、已删除、作废、不再、曾、~~删除线~~）；
//   · 明确标注为历史/契约记录（更正、历史、当时、化石）。
// 危险写法是**光秃秃的现在时**（「配置保留为…预留」「都只是参考线配置」）。
{
  const DELETED_KEYS = ["dailyQuotaTotal", "dailyQuotaPerModel"];
  // 安全上下文词：命中任一即认为这句话已经交代了「它没了」。
  const SAFE_CONTEXT = /删|作废|不再|已移除|曾|更正|历史|当时|化石|预留的替代|test\/config\.test\.mjs|CONFIG_DEFAULTS|~~/;
  // 段落内的安全语允许更宽：段落里任何一处**说明了这两个项不存在**都算交代过。
  // （判定用整段而非单行，因为中文句子经常折行——cordis.patch.yml 的
  // 「已随之 / 删除」就跨了两行。）
  const files = [
    "README.md",
    "cordis.patch.yml",
    ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
    ...readdirSync(join(root, "src", "host")).filter((f) => f.endsWith(".ts")).map((f) => `src/host/${f}`)
  ];
  for (const file of files) {
    const lines = read(file).split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const key of DELETED_KEYS) {
        if (!line.includes(key)) continue;
        // 判定按**整段**而非单行：中文文档里一句话经常折行，删除语（「已随之删
        // 除」）落在下一行。「段落」= 相邻的非空行块（YAML 里即一个注释块）。
        const start = (() => {
          let s = i;
          while (s > 0 && lines[s - 1].trim() !== "") s--;
          return s;
        })();
        let end = i;
        while (end + 1 < lines.length && lines[end + 1].trim() !== "") end++;
        const paragraph = lines.slice(start, end + 1).join("\n");
        assert.ok(
          SAFE_CONTEXT.test(paragraph),
          `${file}:${i + 1} 提到已删除的配置项 ${key} 但所在段落没有交代它已删除：\n    ${line.trim()}\n` +
            `（这会让读者以为它仍是可配的。改写为「已删除…」或标为历史记录。）`
        );
      }
    });
  }
}

// ── §4 归档承诺：PROVIDER-M4.md 不得再声称会改名成 PROVIDER.md ─────────────
//
// 该承诺已被明确作废（见 §14）。钉住它不会悄悄回来，同时钉住真的没有人
// 误建那个文件而留下两份漂移的契约。
{
  const doc = read("docs/PROVIDER-M4.md");
  // 只禁止**活的**承诺。被 `~~删除线~~` 划掉并紧跟「未执行 / 已决定不执行」
  // 的历史记录是允许的（§14 正是这样写的）——它记录的是这项决定，不是承诺。
  for (const [i, line] of doc.split(/\r?\n/).entries()) {
    if (!/本文件归档为\s*`?docs\/PROVIDER\.md/.test(line)) continue;
    if (/~~/.test(line) || /未执行|不执行|作废|更正/.test(line)) continue;
    assert.fail(
      `docs/PROVIDER-M4.md:${i + 1} 仍在声称会归档为 docs/PROVIDER.md——该承诺已作废，见 §14。\n` +
        `若只是保留历史记录，请加删除线并注明「未执行」。`
    );
  }
  assert.ok(
    !existsSync(join(root, "docs", "PROVIDER.md")),
    "docs/PROVIDER.md 已存在，但 §14 已决定不归档——两份契约文档会立刻漂移"
  );
}

// ── §5 测试钉住声明：文档说「某测试钉住了 X」时，那个测试必须真的提到 X ──────
//
// 事故形态：PROVIDER-M4.md:244 说 config.test.mjs 钉住 client/host 的
// PROVIDER_PATH 相等，而 config.test.mjs 里零引用。
{
  const claims = [
    { doc: "docs/PROVIDER-M4.md", pattern: /`(test\/[\w.-]+\.mjs)`\s*钉住(?:相等)?/, mustAppear: null }
  ];
  for (const { doc } of claims) {
    const text = read(doc);
    // 只在**同一行内**同时出现测试文件名与「钉住」时检查，避免跨段误判。
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      const m = line.match(/`(test\/[\w.-]+\.mjs)`[^。\n]*钉住/);
      if (!m) continue;
      const testFile = m[1];
      assert.ok(existsSync(join(root, testFile)), `${doc}:${i + 1} 引用了不存在的测试 ${testFile}`);
      const testText = read(testFile);
      // 这句话里出现的**全大写标识符**（PROVIDER_PATH 之类）应当能在测试里找到。
      const idents = [...line.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map((x) => x[1]);
      for (const ident of idents) {
        assert.ok(
          testText.includes(ident),
          `${doc}:${i + 1} 声称 ${testFile} 钉住 ${ident}，但该文件里没有出现 ${ident}`
        );
      }
    }
  }
}

// ── §6 套件数量与 CI 存在性：文档里这两类断言必须与磁盘一致 ────────────────
//
// 两类实际发生过的漂移：
//   · 文档写死套件数量（RELEASING.md「15 套件」、gate.yml「16 套件」），
//     而实际是 20——写死的数字只会越漂越远；
//   · RELEASING.md 声称「没有 .github/workflows/，CI 也不存在」，而 gate.yml
//     就在版本库里且每次 push 都跑。
{
  const suiteCount = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.mjs")).length
    + 1; // + build-gate.mjs，它也在 npm test 末尾但名字不以 .test.mjs 结尾

  // ① package.json 的 test 脚本必须真的跑到每一个测试文件（新增文件忘了挂 = 从不执行）。
  const testScript = JSON.parse(read("package.json")).scripts.test;
  const suitesOnDisk = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.mjs")).sort();
  for (const suite of suitesOnDisk) {
    assert.ok(
      testScript.includes(`test/${suite}`),
      `test/${suite} 存在但没挂进 package.json 的 test 脚本——它永远不会被执行`
    );
  }
  assert.ok(
    testScript.includes("test/build-gate.mjs"),
    "build-gate.mjs 必须挂在 npm test 末尾（它是唯一的产物新鲜度门禁）"
  );

  // ② 文档里凡出现「N 套件」都必须等于当前真实数量。
  const COUNT_CLAIM = /(\d+)\s*套件/;
  const claimFiles = [
    "RELEASING.md",
    ".github/workflows/gate.yml",
    ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)
  ];
  for (const file of claimFiles) {
    if (!existsSync(join(root, file))) continue;
    for (const [i, line] of read(file).split(/\r?\n/).entries()) {
      const m = line.match(COUNT_CLAIM);
      if (!m) continue;
      // 历史记录（CHANGELOG 之类）允许写当时的数字，但这些文件不是历史。
      assert.equal(
        Number(m[1]),
        suiteCount,
        `${file}:${i + 1} 写死「${m[1]} 套件」，而当前实际是 ${suiteCount} 套件。\n` +
          `    ${line.trim()}\n` +
          `（要么改成实际数量，要么去掉数字——写死的数量只会越漂越远。）`
      );
    }
  }

  // ③ 谁都不许声称 CI / .github 不存在——gate.yml 在版本库里。
  assert.ok(existsSync(join(root, ".github", "workflows", "gate.yml")), ".github/workflows/gate.yml 应当存在");
  const CI_DENIAL = /(没有|不存在|无)\s*`?\.?github/;
  for (const file of ["RELEASING.md", "README.md"]) {
    for (const [i, line] of read(file).split(/\r?\n/).entries()) {
      if (!CI_DENIAL.test(line)) continue;
      // 允许「没有发布自动化 / 没有自动打 tag」这类正确说法——只有把 `.github`
      // 本身说没了才是错的。
      assert.fail(
        `${file}:${i + 1} 声称 .github / CI 不存在，而 .github/workflows/gate.yml 就在版本库里：\n` +
          `    ${line.trim()}`
      );
    }
  }
}

console.log("docs.test.mjs: all checks passed");
