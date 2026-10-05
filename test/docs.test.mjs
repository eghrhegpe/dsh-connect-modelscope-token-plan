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

// 递归枚举某目录下的 .ts——第十一轮的教训：probe.ts 住在 src/host/routes/，
// 而各 § 的清单只 readdirSync 顶层目录，**子目录整个不在射程内**。
const tsFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".ts")) out.push(rel);
    }
  };
  walk(dir);
  return out;
};

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
    ...tsFiles("src/host"),
    // 用户可见文案也是「文档」：面板上的一句假话比 docs 里的一句更伤，
    // 因为它就在用户眼前。第九轮就是靠面板文案把 env 说成「回退」发现的
    // ——而当时这份清单里没有 i18n.ts，门禁恰好漏掉了唯一直接面向用户的面。
    ...tsFiles("src/client")
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

// ── §7 凭据分层：不许把环境变量说成「回退」 ────────────────────────────────
//
// 实测事实（2026-10-05，用户报告触发）：DSH 凭据服务的分层里，**启动时的环境快照
// 压过存储文件**（`dsh-credentials-local/lib/index.js:429` 的 `inherited(ref)` 用
// `launchEnvironmentOf(ctx).getFrom(ref, ["process"])`，读的是启动时冻结的快照）。
// 所以「环境变量是回退」是**反的**：面板保存的值赢不过环境里的值。
//
// 这条错误的实际伤害：用户改了 Windows 环境变量，面板显示「未配置·来源 无」，
// 而面板上那句提示告诉他「环境变量为回退」——两边都没说清「快照在启动时冻结」。
// 判据是机械的：环境变量与「回退/fallback」不得出现在同一句用户可见文案里。
{
  // 用户可见面：client 的全部字符串（i18n 是主战场）+ README 的诚实声明
  // + cordis.patch.yml——操作者改配置时唯一在手边的文件，第十一轮发现它自己
  // 也挂着「env 是回退」（§7 建时清单没含它，恰好漏掉最该正确的那份）。
  const surfaces = [
    ...tsFiles("src/client"),
    "README.md",
    "cordis.patch.yml"
  ];
  // 只有明确在讲「读取顺序/优先级」的句子才算违规；单纯提「环境变量」这个词是对的
  // （比如 token.ephemeral 在「没有凭据服务」时建议用环境变量，那是正确的）。
  const FALLBACK_CLAIM = /回退|fallback|优先.*凭据服务|credentials service first/i;
  const ENV_WORD = /环境变量|MODELSCOPE_API_KEY|environment variable/i;
  const files = surfaces.filter((f) => existsSync(join(root, f)));
  assert.ok(files.length > 0, "应当至少扫到一个用户可见面");
  for (const file of files) {
    for (const [i, line] of read(file).split(/\r?\n/).entries()) {
      if (!ENV_WORD.test(line) || !FALLBACK_CLAIM.test(line)) continue;
      // 允许已经交代了真实优先级的写法（明确说 env 优先级更高 / 启动时读一次）。
      if (/优先级高|启动时读|ranks ABOVE|read once/i.test(line)) continue;
      assert.fail(
        `${file}:${i + 1} 把环境变量说成「回退/fallback」，但 DSH 的分层里环境快照优先级**高于**存储文件：\n` +
          `    ${line.trim()}\n` +
          `（改成明说「只在启动时读一次，且优先级高于此处保存的值」。）`
      );
    }
  }
}

// ── §8 已回填的验证不许仍挂「待验证」 ──────────────────────────────────────
//
// claim 类型（承 §7 的教训——按类型建，不按 key 枚举）：SPIKE.md 是真机验证的
// 登记处；凡是「尚待真机验证 / 验证后落地」这类**预告**，一旦对应结论已回填，
// 预告本身就成了过时描述。第十一轮就是被这条抓现行：probe 的「401 先于 400」
// 早在 2026-10-04 被真机推翻（实测缺 messages 返回 200 空壳），而 ms-auth.ts、
// probe.ts、ROADMAP.md 三处仍写着旧预期或「尚待验证」。
// 判据是机械的：预告语不得独立存活——同段必须有回填/推翻/历史标注。
{
  const PENDING_CLAIM = /尚待真机验证|验证后落地|待真机回填/;
  // 同族 claim：探针的预期响应形状也是「预测→回填」的产物。「预期 401 先于 400」
  // 被真机推翻后，裸写这个预期同样算过时描述（§8 两种写法一起抓）。
  // 允许 401/400 与「先于」之间夹任意非数字字符（如「（令牌坏）」），否则
  // `401（令牌坏）先于 400` 这类插入式写法会漏检——实测就在 inference-client.ts
  // 的 probe JSDoc 里漏过（第十一轮只修了 routes/probe.ts）。
  const SHAPE_CLAIM = /401[^\d]*先于\s*400|400[^\d]*先于\s*401/;
  // 安全标注必须**在预告行自身**：变异测试证明段落级窗口形同虚设——一段 60 行的
  // JSDoc 里任何角落有个「回填」字样就全段放行，孤立的旧预期照样绿。
  const PENDING_SAFE = /真机回填|已于 2026|已回填|已落地|更正|~~|推翻|历史/;
  const SHAPE_SAFE = /早先|曾|~~|推翻|证伪/;
  const files = [
    "README.md",
    "cordis.patch.yml",
    ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md") && f !== "SPIKE.md").map((f) => `docs/${f}`),
    ...tsFiles("src/host"),
    ...tsFiles("src/client")
  ];
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
// 2026-10-05 审计发现两类漂移住在 §1–§8 射程之外（README / docs / patch / src）：
//   ① docs/submission/*.yml 的逐条溯源引用承诺「每个名词都是源码里真有的」，实际
//      10 处引用 4 处失准——1 个组件名写错（`LocalCallCard` 不存在，实为
//      `LocalDailyCard`）、3 处行号指到 JSDoc 行而非函数行。市场 CI 逐句对照源码
//      核验 description，这份 yml 就是它的证据链；
//   ② package.json 的 npm 公开 description 仍写着已删除的次数口径
//      （"daily call budget, per-model caps"）——面板收敛时推算条已删，公开字段
//      还在描述一个不存在的界面。
// 判据照旧机械：行号不钉（随编辑漂移，注释里的行号旧了不致命）；**符号名**是
// 引用承重部分——被引标识符必须真实存在于被引文件。
{
  // ① 投稿 yml 的每个 src/... 引用必须落盘；行号后紧跟的大写开头标识符（≥4 字符）
  //   必须在被引文件里出现。小写开头的词（"says" 这类叙述）不判——宁可窄而硬。
  const submissionDir = join(root, "docs", "submission");
  const submissions = existsSync(submissionDir)
    ? readdirSync(submissionDir).filter((f) => f.endsWith(".yml")).map((f) => `docs/submission/${f}`)
    : [];
  for (const rel of submissions) {
    const refRe = /src\/([A-Za-z0-9_./-]+\.ts)(?::\d+)?(?:\s+([A-Z][A-Za-z0-9]{3,}))?/g;
    for (const m of read(rel).matchAll(refRe)) {
      const [, path, symbol] = m;
      const full = `src/${path}`;
      assert.ok(
        existsSync(join(root, full)),
        `${rel}: 引用的 ${full} 不存在——投稿溯源指向了仓库里没有的文件`
      );
      if (symbol) {
        assert.ok(
          read(full).includes(symbol),
          `${rel}: ${full} 里找不到 ${symbol}——引用了一个不存在的组件/函数名`
        );
      }
    }
  }

  // ② npm 公开 description 不得复活已删除的次数/上限口径（§3 的英文面补票）。
  const desc = JSON.parse(read("package.json")).description;
  assert.ok(
    !/call budget|per-model caps/i.test(desc),
    `package.json 的 description 仍用已删除的次数/上限口径：\n    ${desc}\n` +
      `（面板收敛后次数口径推算条已删；公开字段只写现状：官方魔粒余额 + 经本插件的本地计数/趋势/429 事件流。）`
  );
}

console.log("docs.test.mjs: all checks passed");
