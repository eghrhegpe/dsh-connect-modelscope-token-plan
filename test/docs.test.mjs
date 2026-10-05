// 文档完整性门禁：README / docs 里的**可验证断言**必须与代码现实一致。
//
// 本仓库的漂移全部发生在**文档**侧，而测试套件只钉得住代码。判据刻意是**静态
// 文本**检查——不联网、不 import peer、干净 checkout 可跑，只验证**机械可判**的
// 承诺，不试图理解语义。宁可窄而硬。每段上线前都用变异测试验过真的会红
// （注入违规 → 变红 → 恢复 → 全绿）。
//
// 事故溯源见 docs/IMPLEMENTATION.md（0.1.0/M4 期）与 docs/archive/
// 2026-10-05-closeout.md（0.2.0 十二轮收口）——本文件只留判据，不复述历史。

import { strict as assert } from "node:assert";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

// 递归枚举 .md / .ts。历史教训：早期各段只 readdirSync 顶层目录，于是
// src/host/routes/ 与 docs 子目录整片不在射程内，而事故现场恰好住在里面。
const walk = (dir, ext) => {
  const out = [];
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel, ext));
    else if (e.name.endsWith(ext)) out.push(rel);
  }
  return out;
};
const docFiles = () => walk("docs", ".md");
const tsFiles = (dir) => walk(dir, ".ts");
// 归档是冻结的历史记录，允许逐字保留当时的论述（含已被推翻的形状预期）。
const inArchive = (rel) => rel.split("/")[1] === "archive";

// ── §1 文档地图：README 里链到的每个仓库内文件都必须存在 ────────────────
//
// 只查**仓库内**相对链接；`http(s)://` 外链与锚点跳过——失效不归本门禁管。
{
  const linked = [...read("README.md").matchAll(/\]\((?!https?:|#)([^)#\s]+)\)/g)].map((m) => m[1]);
  assert.ok(linked.length > 0, "README 应当至少链到一个仓库内文件");
  for (const target of linked) {
    assert.ok(
      existsSync(join(root, target)),
      `README 链接的 ${target} 不存在——文档地图指向了不存在的文件`
    );
  }
}

// ── §2 反向：每份文档都要在 README 文档地图里出现 ─────────────────────────
//
// 防止「新增了文档但没人找得到」。归档豁免——它不入门，也不该要求登记。
{
  const readme = read("README.md");
  const docs = docFiles().filter((f) => !inArchive(f));
  assert.ok(docs.length > 0, "docs/ 应当有文档");
  for (const doc of docs) {
    assert.ok(
      readme.includes(doc),
      `${doc} 不在 README 文档地图里——新增文档请登记，否则没人会读到它`
    );
  }
}

// ── §3 死配置：已删除的配置项不得以「现存配置」的口吻出现 ────────────────
//
// config.test.mjs 钉住它们不在 CONFIG_DEFAULTS / cordis.patch.yml 里；这里钉住
// **文档**也不再声称它们存在。允许两种安全写法：句子里带删除/作废语，或明确标
// 注为历史/契约记录。危险写法是**光秃秃的现在时**。判定按**整段**而非单行——
// 中文文档里一句话经常折行，删除语落在下一行。
{
  const DELETED_KEYS = ["dailyQuotaTotal", "dailyQuotaPerModel"];
  const SAFE_CONTEXT = /删|作废|不再|已移除|曾|更正|历史|当时|化石|预留的替代|test\/config\.test\.mjs|CONFIG_DEFAULTS|~~/;
  const files = [
    "README.md",
    "cordis.patch.yml",
    ...docFiles(),
    ...tsFiles("src/host"),
    // 用户可见文案也是「文档」：面板上的一句假话比 docs 里的一句更伤，因为它就在
    // 用户眼前——第九轮就是靠面板文案把 env 说成「回退」发现的。
    ...tsFiles("src/client")
  ];
  for (const file of files) {
    const lines = read(file).split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const key of DELETED_KEYS) {
        if (!line.includes(key)) continue;
        let start = i;
        while (start > 0 && lines[start - 1].trim() !== "") start--;
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
// 该承诺已被明确作废（见 §14）。只禁止**活的**承诺：被 `~~` 划掉并紧跟「未执行 /
// 已决定不执行」的历史记录是允许的。同时钉住没人误建那个文件而留下两份契约。
{
  const doc = read("docs/PROVIDER-M4.md");
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
// 事故形态：文档声称某个不存在于该测试的断言在钉住某不变量。
{
  const doc = "docs/PROVIDER-M4.md";
  const text = read(doc);
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const m = line.match(/`(test\/[\w.-]+\.mjs)`[^。\n]*钉住/);
    if (!m) continue;
    const testFile = m[1];
    assert.ok(existsSync(join(root, testFile)), `${doc}:${i + 1} 引用了不存在的测试 ${testFile}`);
    const testText = read(testFile);
    // 这句话里出现的**全大写标识符**应当能在测试里找到。
    for (const ident of [...line.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map((x) => x[1])) {
      assert.ok(
        testText.includes(ident),
        `${doc}:${i + 1} 声称 ${testFile} 钉住 ${ident}，但该文件里没有出现 ${ident}`
      );
    }
  }
}

// ── §6 套件数量与 CI 存在性：这两类断言必须与磁盘一致 ────────────────────────
//
// 写死的数字只会越漂越远（曾写死 15 / 16，实际早已不止），且有人声称 CI 不存在
// 而 gate.yml 就在版本库里。
{
  const suiteCount = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.mjs")).length
    + 1; // + build-gate.mjs，它也在 npm test 末尾但名字不以 .test.mjs 结尾

  // ① package.json 的 test 脚本必须真的跑到每一个测试文件（新增文件忘了挂 = 从不执行）。
  const testScript = JSON.parse(read("package.json")).scripts.test;
  for (const suite of readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.mjs")).sort()) {
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
  for (const file of ["RELEASING.md", ".github/workflows/gate.yml", ...docFiles()]) {
    if (!existsSync(join(root, file))) continue;
    for (const [i, line] of read(file).split(/\r?\n/).entries()) {
      const m = line.match(/(\d+)\s*套件/);
      if (!m) continue;
      assert.equal(
        Number(m[1]),
        suiteCount,
        `${file}:${i + 1} 写死「${m[1]} 套件」，而当前实际是 ${suiteCount} 套件。\n    ${line.trim()}\n` +
          `（要么改成实际数量，要么去掉数字——写死的数量只会越漂越远。）`
      );
    }
  }

  // ③ 谁都不许声称 CI / .github 不存在。
  assert.ok(existsSync(join(root, ".github", "workflows", "gate.yml")), ".github/workflows/gate.yml 应当存在");
  for (const file of ["RELEASING.md", "README.md"]) {
    for (const [i, line] of read(file).split(/\r?\n/).entries()) {
      if (!/(没有|不存在|无)\s*`?\.?github/.test(line)) continue;
      assert.fail(
        `${file}:${i + 1} 声称 .github / CI 不存在，而 .github/workflows/gate.yml 就在版本库里：\n    ${line.trim()}`
      );
    }
  }
}

// ── §7 凭据分层：不许把环境变量说成「回退」 ────────────────────────────────
//
// 实测事实（2026-10-05）：DSH 凭据服务的分层里，**启动时的环境快照压过存储文件**
// （快照在启动时冻结，不是活的 process.env）。所以「环境变量是回退」是**反的**。
// 只有明确在讲「读取顺序/优先级」的句子才算违规；单纯提「环境变量」是对的。
{
  const surfaces = [...tsFiles("src/client"), "README.md", "cordis.patch.yml"];
  const FALLBACK_CLAIM = /回退|fallback|优先.*凭据服务|credentials service first/i;
  const ENV_WORD = /环境变量|MODELSCOPE_API_KEY|environment variable/i;
  const files = surfaces.filter((f) => existsSync(join(root, f)));
  assert.ok(files.length > 0, "应当至少扫到一个用户可见面");
  for (const file of files) {
    for (const [i, line] of read(file).split(/\r?\n/).entries()) {
      if (!ENV_WORD.test(line) || !FALLBACK_CLAIM.test(line)) continue;
      if (/优先级高|启动时读|ranks ABOVE|read once/i.test(line)) continue;
      assert.fail(
        `${file}:${i + 1} 把环境变量说成「回退/fallback」，但 DSH 的分层里环境快照优先级**高于**存储文件：\n` +
          `    ${line.trim()}\n（改成明说「只在启动时读一次，且优先级高于此处保存的值」。）`
      );
    }
  }
}

// ── §8 已回填的验证不许仍挂「待验证」 ──────────────────────────────────────
//
// claim 类型（承 §7 的教训——按类型建，不按 key 枚举）：凡「尚待真机验证 / 验证后
// 落地」这类**预告**，一旦对应结论已回填，预告本身就成了过时描述。同族的形状预期
// （「401 先于 400」）被真机推翻后，裸写同样算过时描述。
// 安全标注必须**在预告行自身**：变异测试证明段落级窗口形同虚设。
{
  const PENDING_CLAIM = /尚待真机验证|验证后落地|待真机回填/;
  const SHAPE_CLAIM = /401[^\d]*先于\s*400|400[^\d]*先于\s*401/;
  const PENDING_SAFE = /真机回填|已于 2026|已回填|已落地|更正|~~|推翻|历史/;
  const SHAPE_SAFE = /早先|曾|~~|推翻|证伪/;
  // SPIKE.md 是真机验证的登记处（预告与回填本就并存），豁免。
  const files = ["README.md", "cordis.patch.yml", ...docFiles().filter((f) => f !== "docs/SPIKE.md"), ...tsFiles("src/host"), ...tsFiles("src/client")];
  for (const file of files) {
    for (const [i, line] of read(file).split(/\r?\n/).entries()) {
      const isPending = PENDING_CLAIM.test(line);
      const isShape = !isPending && SHAPE_CLAIM.test(line);
      if (!isPending && !isShape) continue;
      assert.ok(
        (isPending ? PENDING_SAFE : SHAPE_SAFE).test(line),
        `${file}:${i + 1} 挂着已被真机推翻/回填的旧预告，同行没有历史标注——` +
          `要么改为回填后的事实，要么加「早先…已被真机推翻」类标注：\n    ${line.trim()}`
      );
    }
  }
}

// ── §9 投稿溯源与 npm description：门外的两类可机械判声明 ─────────────────
//
// 投稿 yml 的逐条溯源引用是市场 CI 核验 description 的证据链，符号名是引用承重
// 部分（行号随编辑漂移，不判）；npm 公开 description 则描述给用户看的第一句话。
{
  const submissionDir = join(root, "docs", "submission");
  const submissions = existsSync(submissionDir)
    ? readdirSync(submissionDir).filter((f) => f.endsWith(".yml")).map((f) => `docs/submission/${f}`)
    : [];
  for (const rel of submissions) {
    const refRe = /src\/([A-Za-z0-9_./-]+\.ts)(?::\d+)?(?:\s+([A-Z][A-Za-z0-9]{3,}))?/g;
    for (const m of read(rel).matchAll(refRe)) {
      const [, path, symbol] = m;
      const full = `src/${path}`;
      assert.ok(existsSync(join(root, full)), `${rel}: 引用的 ${full} 不存在——投稿溯源指向了仓库里没有的文件`);
      if (symbol) {
        assert.ok(
          read(full).includes(symbol),
          `${rel}: ${full} 里找不到 ${symbol}——引用了一个不存在的组件/函数名`
        );
      }
    }
  }

  const desc = JSON.parse(read("package.json")).description;
  assert.ok(
    !/call budget|per-model caps/i.test(desc),
    `package.json 的 description 仍用已删除的次数/上限口径：\n    ${desc}\n` +
      `（面板收敛后次数口径推算条已删；公开字段只写现状：官方魔粒余额 + 经本插件的本地计数/趋势/429 事件流。）`
  );
}

// ── §10 反重复：承重事实的完整论述只允许住在它的唯一归属文件里 ────────────────
//
// §1–§9 都查「事实是否与磁盘一致」，但查不出「同一个事实被抄了 7 遍」。这个代价
// 已经付过：修一处错声明要同步改 4 个文件，因为同一错误声明的传播点散落在
// README / docs / patch / src。判据机械：非归属文件若提到该事实，必须在**文件内**
// 链回归属文件——指针可以，重述不行。docs/archive/** 豁免（冻结的历史允许逐字保留）。
const FACTS = [
  {
    id: "reasoning_effort 档位表不可行（既不校验值也不保证生效）",
    needles: [/静默忽略/],
    canonical: "docs/PROVIDER-M4.md",
    pointer: "PROVIDER-M4.md"
  },
  {
    id: "按流计次：每次重试各记一次 call",
    needles: [/各记一次/],
    canonical: "src/host/usage-observer.ts",
    pointer: "usage-observer.ts"
  },
  {
    id: "重分类层在观察层之内（顺序不可反）",
    needles: [/顺序不可反/, /改写先于观察/],
    canonical: "src/host/usage-observer.ts",
    pointer: "usage-observer.ts"
  }
];
{
  const scanned = [
    "README.md",
    "cordis.patch.yml",
    ...docFiles(),
    ...tsFiles("src/host"),
    ...tsFiles("src/client")
  ].filter((f) => !inArchive(f));
  for (const fact of FACTS) {
    assert.ok(
      read(fact.canonical).split(/\r?\n/).some((l) => fact.needles.some((n) => n.test(l))),
      `${fact.canonical} 是「${fact.id}」的归属文件，却找不到该事实的论述——事实没有家，先给它安家`
    );
    for (const file of scanned) {
      if (file === fact.canonical) continue;
      const text = read(file);
      if (!fact.needles.some((n) => n.test(text))) continue;
      assert.ok(
        text.includes(fact.pointer),
        `${file} 提到了「${fact.id}」，但文件内没有链回归属文件 ${fact.canonical}：\n` +
          `（重述会漂移。改成一句话指针 + 链接，完整论述只保留在归属文件里。）`
      );
    }
  }
}

console.log("docs.test.mjs: all checks passed");
