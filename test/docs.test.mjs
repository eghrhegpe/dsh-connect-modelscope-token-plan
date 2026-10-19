// 文档完整性门禁：README / docs 里的**可验证断言**必须与代码现实一致。
//
// 本仓库的漂移全部发生在**文档**侧，而测试套件只钉得住代码。判据刻意是**静态
// 文本**检查——不联网、不 import peer、干净 checkout 可跑，只验证**机械可判**的
// 承诺，不试图理解语义。宁可窄而硬。每段上线前都用变异测试验过真的会红
// （注入违规 → 变红 → 恢复 → 全绿）。
//
// 事故溯源按版本住 docs/archive/ 各过程档案（最早两轮见 docs/IMPLEMENTATION.md
// 与 docs/archive/2026-10-05-closeout.md）；本文件**尽量**只留判据与判据的形状
// 理由，不复述完整事故经过——已被过程档案收录的故事只留一行指针。

import { strict as assert } from "node:assert";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
// 断言用的文档集合：**默认**已排除机读规格目录（见 isVendoredSpec）。在这里
// 统一过滤而不是逐条调用点过滤——新增一条文档断言时自动继承该豁免，漏一处就会
// 在上游重新导出时误报。确需扫描 vendor 目录的规则请显式说明理由。
const docFiles = () => walk("docs", ".md").filter((f) => !isVendoredSpec(f));
const tsFiles = (dir) => walk(dir, ".ts");
// 归档是冻结的历史记录，允许逐字保留当时的论述（含已被推翻的形状预期）。
const inArchive = (rel) => rel.split("/")[1] === "archive";
// 机读规格目录是**上游产物的原样快照**（本例：modelscope.cn 官方 OpenAPI 的
// json + 从官网导出的 html 转 md），不是本仓库撰写的文档。它们跟着 spec 一起
// 版本化，不进 README 文档地图——地图是给「谁写给谁看的文档」用的，把上游导出
// 登记进去只会让地图被噪音撑大。同样从文档断言的射程内排除：它们随时会被上游
// 重新导出覆盖，任何「必须与代码一致」的门禁都只会在重新导出时误报。
const isVendoredSpec = (rel) => rel.startsWith("docs/modelscope.cn-openapi/");

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

  // ① npm test 必须走 glob 门禁 test/run-all.mjs——它把「每个 .test.mjs 都被跑到」
  //    从自觉登记变成结构事实（旧形态是 && 串全部文件名，新增套件忘了挂 = 从不
  //    执行；runner 以 readdir 为唯一事实源，登记这一步不存在了，见其文件头）。
  const testScript = JSON.parse(read("package.json")).scripts.test;
  assert.equal(
    testScript.trim(),
    "node test/run-all.mjs",
    "package.json 的 test 脚本必须是 `node test/run-all.mjs`（套件清单的事实源在 glob，不在这条串里）"
  );
  // runner 自己也得守规矩：glob 之外必须把 build-gate 钉在末尾——它是唯一的
  // 产物新鲜度门禁，名字不以 .test.mjs 结尾，glob 捞不到它。
  const runnerSrc = read("test/run-all.mjs");
  assert.ok(
    runnerSrc.includes("build-gate.mjs"),
    "test/run-all.mjs 必须显式跑 build-gate.mjs（glob 不含它，丢了就没人比产物）"
  );

  // ①b runner 的裁剪 flag 必须真的在裁剪。
  //
  // 事故：run-all.mjs 只认 `--only <值>` 空格式，而 AGENTS.md 验证段写的正是
  // `--only=<子串>` 等号式——等号式取不到值 → only=null → **静默跑全量**，并且
  // build-gate 当时挂在 `!only` 分支里，那些「裁剪」调用连唯一的产物门禁一起跳过。
  // 开发者以为自己在跑一个域、实际跑了 39 个套件。这里用真实子进程钉住三件事：
  // 两种写法都认、解析不出值以非零码报错、裁剪时 build-gate 照跑。
  //
  // 用 spawnSync 而不是 import：runner 在模块顶层就 process.exit，import 会把
  // 本套件一起带走。
  {
    const runner = join(root, "test", "run-all.mjs");
    const run = (args) => spawnSync(process.execPath, [runner, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, MODELSCOPE_API_KEY: "" }
    });
    // 挑一个名字足够独特的套件做探针：它必须只匹配自己。
    const probe = "wire";
    const matched = readdirSync(join(root, "test"))
      .filter((f) => f.endsWith(".test.mjs") && f.includes(probe))
      .sort();
    assert.deepEqual(matched, ["wire.test.mjs"], `--only 探针 "${probe}" 必须只匹配 wire.test.mjs，实际 ${JSON.stringify(matched)}`);

    for (const args of [[`--only=${probe}`], ["--only", probe]]) {
      const r = run(args);
      const picked = (r.stdout.match(/\[\d+\/\d+\]\s+(\S+\.mjs)/g) ?? []).map((s) => s.split(/\s+/).pop());
      assert.equal(r.status, 0, `node test/run-all.mjs ${args.join(" ")} 应当成功，实际退出码 ${r.status}\n${r.stderr ?? ""}`);
      assert.deepEqual(
        picked,
        ["wire.test.mjs", "build-gate.mjs"],
        `node test/run-all.mjs ${args.join(" ")} 应当只跑 wire + build-gate，实际跑了 ${JSON.stringify(picked)}\n` +
          `（等号式曾被静默忽略 → 退化成全量，见文件头那次事故。）`
      );
      // build-gate 必须在：裁剪时它恰恰最容易被「只改了一个域」蒙混过去。
      assert.ok(
        picked.includes("build-gate.mjs"),
        `裁剪调用也必须跑 build-gate.mjs（产物新鲜度门禁）：node test/run-all.mjs ${args.join(" ")}`
      );
    }

    // 给了 flag 却没给值：必须报错，绝不能悄悄跑全量。
    for (const args of [["--only"], ["--only="], ["--skip"], ["--jobs"]]) {
      const r = run(args);
      assert.notEqual(r.status, 0, `node test/run-all.mjs ${args.join(" ")} 应当以非零码报错，实际退出码 ${r.status}`);
      assert.ok(
        !/全部通过/.test(r.stdout),
        `node test/run-all.mjs ${args.join(" ")} 不该跑出「全部通过」——flag 没给值必须报错而不是跑全量`
      );
    }
    // 连字符形式（`--only-wire`）是常见手误，同样不许被静默忽略。
    {
      const r = run(["--only-wire"]);
      assert.notEqual(r.status, 0, `\`--only-wire\` 应当以非零码报错，实际退出码 ${r.status}`);
      assert.ok(!/全部通过/.test(r.stdout), "`--only-wire` 不该被静默忽略（跑全量）");
    }
  }

  // ② 文档里凡出现「N 套件」都必须等于当前真实数量。
  //
  // **归档豁免**（与 §2 同款，依据见文件头那条政策）：归档是冻结的历史记录，
  // 「当时 37/37 通过」在写下的那一刻是真的。把那个数字改成今天的值 = 篡改记录，
  // 把数字删掉 = 丢信息，两条都比「门禁少看一个归档文件」更坏。
  //
  // 这条过滤此前漏了（§2 有、§6② 没有），后果是**每加一个测试套件都会逼着人去
  // 改一份不该再动的历史文档**：2026-10-17 新增 `draw-register.test.mjs` 时实测
  // 踩到，门禁报「docs/archive/…-0.4.0-process.md:182 写死「37 套件」，而当前实际
  // 是 38 套件」。冻结记录本来就不该跟着今天的套件数漂。
  for (const file of ["RELEASING.md", ".github/workflows/gate.yml", ...docFiles().filter((f) => !inArchive(f))]) {
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

  // ③ AGENTS.md「测试策略」那棵目录树：每个 test/*.test.mjs 都必须在树里被点名。
  //
  // 事故（2026-10-18 清点实测）：树里漏了 `switch-precedence.test.mjs` 与
  // `usage-prefs-store.test.mjs` 两个套件，而 ①（glob 门禁）只保证「磁盘上的套件
  // 都被跑到」，② 只保证「文档里写的 N 套件数是对的」——**没有一条管这棵树本身**。
  // 树是 AI 会话挑「读哪个测试」的第一入口，漏登记的套件等于不存在。
  //
  // 判据机械：树里出现的每个 `*.test.mjs` 名字（含 `draw*.test.mjs` 这类通配，
  // 通配按 glob 展开匹配）与磁盘套件集合双向一致。`run-all.mjs`、`build-gate.mjs`
  // 与 helpers 下的 `peer-stub-loader.mjs` 不是 `.test.mjs`，不在射程内。
  {
    const lines = read("AGENTS.md").split(/\r?\n/);
    // 定位「测试策略」节里那个以 `test/` 开头的 fenced block。
    const headerAt = lines.findIndex((l) => /^##\s+测试策略/.test(l));
    assert.ok(headerAt >= 0, "AGENTS.md 应当有「测试策略」节");
    const openAt = lines.findIndex((l, i) => i > headerAt && l.trim() === "```");
    assert.ok(openAt > headerAt, "「测试策略」节里应当有 ``` 围栏");
    const closeAt = lines.findIndex((l, i) => i > openAt && l.trim() === "```");
    assert.ok(closeAt > openAt, "「测试策略」节的 ``` 围栏应当闭合");

    const tokens = [];
    for (const line of lines.slice(openAt + 1, closeAt)) {
      const m = line.match(/([A-Za-z0-9_*.-]+\.mjs)\b/);
      if (m) tokens.push(m[1]);
    }
    const suites = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.mjs"));
    const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

    const missing = suites.filter((s) => !tokens.some((t) => (t.includes("*") ? globRe(t).test(s) : t === s)));
    assert.deepEqual(
      missing,
      [],
      `AGENTS.md「测试策略」树里漏登记了 ${missing.join("、")}——树是挑测试的第一入口，` +
        `漏掉的套件对会话等于不存在。新增套件时把它补进这棵树（通配行如 \`draw*.test.mjs\` ` +
        `要在括号里列全实际成员）。`
    );

    const ghosts = tokens.filter((t) => !t.includes("*") && t.endsWith(".test.mjs") && !suites.includes(t));
    assert.deepEqual(
      ghosts,
      [],
      `AGENTS.md「测试策略」树里写了不存在（或已删）的套件：${ghosts.join("、")}。`
    );
  }

  // ④ 谁都不许声称 CI / .github 不存在。
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
  const submissionDir = join(root, "awesome-dsh-plugin-submission");
  const submissions = existsSync(submissionDir)
    ? readdirSync(submissionDir).filter((f) => f.endsWith(".yml")).map((f) => `awesome-dsh-plugin-submission/${f}`)
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
    // needle 必须是**这段论述特有的措辞**，不能是通用词。两次实测的误伤：
    //   ①「静默忽略」是通用词——`src/host/index.ts` 一句「注入被静默忽略」的注释
    //     被判成重述这条事实；
    //   ②「无法区分」同样通用——`docs/SPIKE-image-gen.md` 里讲别的事也用了它。
    // 归属文件的原文是「无法区分『参数生效』与『参数被静默忽略』」，只有这整串
    // 才是这条论述独有的指纹。
    needles: [/「参数生效」与「参数被静默忽略」/],
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

// ── §11 引用有效性：每个 test/*.test.mjs 引用必须指向真实存在的文件 ──────────
//
// §1/§5/§9 都查文档侧的引用，但查不到**代码注释与测试注释**里指向不存在测试的
// 引用。事故：`test/peer-contract.test.mjs` 曾在 6 处注释里被当成既成事实引用
// （src/host/llm-retry.ts 两处、llm-error-fix.ts、llm-adapter.ts、
// test/error-fix.test.mjs、retry.test.mjs、switch-precedence.test.mjs），而该
// 文件从未存在——它需要运行时 peer，peer 未 vendored 进本仓库。后果是注释声称
// 「peer 契约被测试钉死」，后来者信以为真，认为 peer 行为漂移会被某个门禁抓住，
// 实际没有。IMPLEMENTATION.md:149 已把这个事故记作「幽灵测试引用」，但当时只把
// 措辞改成「在门禁之外」，引用字符串留在原地，幽灵就一直活着。
// 判据机械：所有 `test/xxx.test.mjs` 形式的引用必须是磁盘上真实存在的文件。
//
// 射程（2026-10-19 扩展）：src/ + test/ 照旧；**docs/**（非归档）也进射程——
// docs/PROVIDER-M4.md §13 曾点名三个从未存在的套件（provider-store / llm-models /
// publish-core 的 .test.mjs），正因旧判据射程止步 src+test，幽灵全绿存活了很久，
// 2026-10-19 评审才把它改写成真实承重套件。docs/archive/** 仍不扫（冻结历史）。
// 一条例外：**docs** 里指向不存在测试的引用，所在段落带缺口声明标记
// （幽灵 / 从未存在 / 无此文件 / 缺口声明 / 该契约测试在…）时放行——与 §3
// SAFE_CONTEXT 同一套段落判据先例（中文文档折行，标记可能落在引用的另一行上）。
// 该例外不给 src/test：代码注释声称覆盖，必须真有文件。
// 另一条例外（2026-10-19 收紧）：引用前面显式署名了**别的仓库**（`agnes:test/…`）
// 时放行——那条路径不由本仓提供。**行号本身不再是免检牌**：旧判据「带行号即整体
// 跳过」让幽灵引用挂个行号就能复活（详见下面 check 的注释）。
{
  const refRe = /\btest\/[A-Za-z0-9_.-]+\.test\.mjs(?::\d+)?\b/g;
  // docs 侧缺口声明段落标记：段内带这些词 = 该引用被明确声明为已知缺口（§3 先例）。
  const GAP_DECL = /幽灵|从未存在|无此文件|缺口声明|该契约测试在/;
  // 本文件必须被排除——门禁定义文件需要能提到任何测试名（包括不存在的那个），
  // 否则它没法描述自己的判据来源，会自我绊倒。
  const scanned = [
    ...tsFiles("src"),
    ...walk("test", ".mjs").filter((f) => f !== "test/docs.test.mjs"),
    // 2026-10-19 射程扩展：非归档 docs 也查（docFiles() 已排除 vendored spec，归档另排）。
    ...docFiles().filter((f) => !inArchive(f)),
  ];
  // 跨仓引用必须**显式署名**：`<仓名>:test/xxx.test.mjs:58`（仓名限定为小写 slug，
  // 免得中文散文里的一个冒号就成了免检牌）。行号本身不再是免检牌——见 check 的注释。
  const foreignRef = (text, index) => /[a-z][a-z0-9-]*:\s*$/.test(text.slice(Math.max(0, index - 40), index));
  for (const file of scanned) {
    const isDoc = file.startsWith("docs/");
    const check = (full, para, foreign) => {
      // 带行号的引用**曾经整体免检**（旧判据 `if (/:\\d+$/.test(full)) return`），理由是
      // 「带行号 = 跨仓精确定位」。但行号只说明引用更精确，不说明这条路径不必存在：
      // 2026-10-19 锐评变异实证——在本仓 src 里注入
      // `test/__ghost_probe__.test.mjs:42`，本门禁**静默通过**（同一条引用去掉行号
      // 就被点名）。幽灵引用带上一个行号就复活了，而 §11 守的正是「注释声称有覆盖」。
      // 现在行号只是被**剥掉**、不改判据；跨仓引用必须自己署名（`agnes:test/…`）。
      if (foreign) return;
      const bare = full.replace(/:\d+$/, "");
      if (isDoc && para !== null && GAP_DECL.test(para)) return;
      assert.ok(
        existsSync(join(root, bare)),
        `${file}: 引用了 ${bare}，但该测试文件不存在——声称有测试覆盖其实没有。` +
          (isDoc
            ? ` 要么实现它，要么把引用放进带缺口声明标记（幽灵/从未存在/无此文件/缺口声明）的段落，`
            : ` 要么实现它，要么把注释改成明确的缺口声明并记进 docs/ROADMAP.md 的 Backlog，`) +
          `要么在引用前写明是哪个仓库的（如 agnes:${bare}）。`
      );
      // 行号也要真在文件里：指向一个 20 行文件的第 549 行，同样是「声称有覆盖其实没有」。
      const lineNo = /:(\d+)$/.exec(full);
      if (lineNo !== null) {
        const total = read(bare).split(/\r?\n/).length;
        assert.ok(
          Number(lineNo[1]) <= total,
          `${file}: 引用了 ${full}，但 ${bare} 只有 ${total} 行——行号指向文件外。`
        );
      }
    };
    if (isDoc) {
      // 文档侧按段落判：段落 = 一段非空行（与 §3 同一套「按整段」约定）。
      const paras = [];
      let cur = [];
      for (const l of read(file).split(/\r?\n/)) {
        if (l.trim()) cur.push(l);
        else {
          if (cur.length) paras.push(cur.join("\n"));
          cur = [];
        }
      }
      if (cur.length) paras.push(cur.join("\n"));
      for (const p of paras) for (const m of p.matchAll(refRe)) check(m[0], p, foreignRef(p, m.index));
    } else {
      const body = read(file);
      for (const m of body.matchAll(refRe)) check(m[0], null, foreignRef(body, m.index));
    }
  }
}

// ── §12 语义状态词防御：文档地图说「尚未实现」时，对应实现必须真的不存在 ──────
//
// 事故（2026-10-15 修复）：README 文档地图把 SPIKE-image-gen.md 标成「尚未实现」，
// 而 v0.2 起出图工具已落地（src/host/draw.ts 等，test/draw.test.mjs 39 组钉死）。
// §8 只查「尚待真机验证 / 验证后落地 / 待真机回填」这几个预告词，「尚未实现」不在
// 射程内——语义状态词是静态文本判据的盲区，这里按具体事实补一条机械规则。
// 判据：任何非归档 .md / README 的行若同时含「尚未实现」与 SPIKE-image-gen.md，
// 且 src/host/draw.ts 已存在，即报红。将来真有「实现了又回退」时，把实现文件
// 删掉的同时必须同步更新这条判据（或让文案改为历史标注）。
{
  const DRAW_IMPLEMENTED = existsSync(join(root, "src", "host", "draw.ts"));
  if (DRAW_IMPLEMENTED) {
    // 归档过滤是**显式**加的，不是 `docFiles()` 给的——那句话说反了（`docFiles()`
    // 只排掉 vendored spec，不排归档）。同 §2 / §6②：冻结历史里那句「尚未实现」
    // 在写下时是真的，不该被今天的实现状态判红。
    const files = ["README.md", ...docFiles().filter((f) => !inArchive(f))];
    for (const file of files) {
      const lines = read(file).split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!line.includes("尚未实现") || !line.includes("SPIKE-image-gen.md")) return;
        assert.fail(
          `${file}:${i + 1} 把 SPIKE-image-gen.md 标成「尚未实现」，但 src/host/draw.ts 已在——` +
            `v0.2 起出图工具已实现：\n    ${line.trim()}\n（改成「已实现 / v0.2 起」，或删掉实现文件并同步更新本条判据。）`
        );
      });
    }
  }
}

// ── §13 每版手册禁令：根目录不得再有 RELEASE-X.Y.Z.md，也不得有 releases/ ──────
//
// 事故（2026-10-17 裁定）：本仓 2026-10-05 自造了「每次发版新开一份 RELEASE-X.Y.Z.md，
// 上一版移入 releases/archive/」的惯例，随后自己把这条写进 RELEASING.md 当纪律，再被
// 逐版复制。实测它站不住：姊妹插件（agnes / sensenova / qoder / trae / workbuddy）都没
// 这套；而 `RELEASE-0.5.0.md` 的 130 个非空行里 48% 与上一版**逐行相同**、另 23% 只是
// 把版本号代进去，同时把 `EOTP` / `E401` / 版本号烧在**两处**这类流程知识困在单一版里
// （当时 RELEASING.md 一个字都没有）。
//
// 为什么要有这条门禁：惯例的载体是**文件名**，而文件名不进任何判据——删掉规则文档后，
// 下一轮（人或 agent）从 git 历史里看到那五个文件，照样会照抄一遍。判据机械：根目录出现
// `RELEASE-*.md`，或 `releases/` 目录被重新创建，即报红。
//
// 历史记录不丢：那五个文件的内容仍在 git 历史里（例：`git show 616e58b:RELEASE-0.5.0.md`），
// 流程知识已上收进 RELEASING.md。Release 正文现在写在临时文件里喂 `--notes-file`。
{
  const rootMd = readdirSync(join(root), { withFileTypes: true })
    .filter((e) => e.isFile() && /^RELEASE-.*\.md$/.test(e.name))
    .map((e) => e.name);
  assert.deepEqual(
    rootMd,
    [],
    `根目录出现了每版手册：${rootMd.join(", ")}\n` +
      `2026-10-17 起不产生这个文件（理由见 RELEASING.md 头注与 docs.test.mjs §13）：\n` +
      `Release 正文写临时文件喂 \`gh release create --notes-file\`，草稿留在 CHANGELOG 该版节。`
  );
  assert.equal(
    existsSync(join(root, "releases")),
    false,
    "releases/ 目录被重新创建了——它只服务已被推翻的「手册归档」惯例；历史版本在 git 历史里"
  );
}

// ── 代码地图解析：按**表头**归属目录，返回每行的完整仓库相对路径 ──────────────
//
// 为什么必须按表头（而不是 basename）：`index.ts`（Host 表 / Client 表各一行）与
// `codes.ts`（Host 表 / 共享表各一行）这类 basename 在多个表里各有一行。旧实现把第一列
// 当裸 basename 在四个根里 `find(existsSync)` 取**第一个命中**，于是两行都落到同一个
// 文件上——`index.ts` 两行都解析到 `src/host/index.ts`，`codes.ts` 两行都解析到
// `src/host/codes.ts`。§14①（幽灵行）与 §14②（漏登记）因此同时漏掉
// `src/client/index.ts` 与 `src/shared/codes.ts` 的归属，§14b 更是**核错对象**
// （2026-10-18 评审第二轮的变异实证：把共享行改成只在 host/codes.ts 存在的
// `classifyStatus()`，本套件仍然全绿）。
//
// 表头是 AGENTS.md 自己写的「这个表属于哪个目录」的声明，比 basename 猜可靠：
//   ### Host 侧（`src/host/`）  → 行内 `routes/x.ts` 拼成 `src/host/routes/x.ts`
//   ### Client 侧（`src/client/`）
//   ### 共享（`src/shared/`）
function readCodeMap() {
  const agents = read("AGENTS.md");
  const SECTIONS = [
    [/^###\s+Host 侧/, "src/host"],
    [/^###\s+Client 侧/, "src/client"],
    [/^###\s+共享/, "src/shared"]
  ];
  const rows = [];
  let sectionRoot = null;
  for (const line of agents.split("\n")) {
    const section = SECTIONS.find(([re]) => re.test(line));
    if (section) { sectionRoot = section[1]; continue; }
    if (/^###\s/.test(line)) { sectionRoot = null; continue; } // 出了代码地图区
    const m = line.match(/^\|\s*`([^`]+\.ts)`\s*\|/);
    if (!m || sectionRoot === null) continue;
    // 表行形如：| `routes/snapshot.ts` | 一句话职责 | `导出1`, `导出2` |
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
    rows.push({ rel: `${sectionRoot}/${m[1]}`, exportsCell: cells[2] });
  }
  const onDisk = [];
  for (const dir of ["src/host", "src/host/routes", "src/client", "src/shared"]) {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".ts")) onDisk.push(`${dir}/${e.name}`);
    }
  }
  return { rows, onDisk };
}

// ── §14 AGENTS.md 代码地图：登记必须与磁盘一致（每个 src 文件都在，且不写幽灵行） ──
//
// 事故形态（2026-10-17 审计）：AGENTS.md 的代码地图 / 数据流 / 关键决策速查三张手维护的
// 表**没有任何门禁**——整个 test/ 里 AGENTS 零引用（实测）。它是每个会话进门第一份读的
// 文件，烂掉的代价比任何 docs 都高：错的地图会把下一轮会话指到不存在的文件上。同一天
// 刚废掉的「每版手册」也正是从「干净」开始、靠复制传播的。
//
// 判据机械（两个方向都要）：
//   ① 表行第一列登记的 `xxx.ts` 必须在**该表所属目录**下有对应文件（幽灵行 = 地图指向
//      不存在的东西）；
//   ② 磁盘上每个 src/**/*.ts 必须在表里登记（漏登记 = 新模块没人会读到）。
// 第三列「关键导出」同样机械可核（2026-10-18 推翻本条原先的「无法机械核」结论，
// 见 §14b）——当初误报 72/72 的判据是**按行匹配函数声明**，而实际导出还有
// const / class / re-export / async-generator 四种形状，形状枚举不全才全灭。
{
  const { rows, onDisk } = readCodeMap();
  assert.ok(rows.length > 30, `AGENTS.md 代码地图只解析到 ${rows.length} 行——表被改写/换格式了？`);
  const ghosts = rows.filter((row) => !existsSync(join(root, row.rel)));
  assert.deepEqual(ghosts, [], `AGENTS.md 代码地图里这些文件磁盘上没有（幽灵行）：${ghosts.map((r) => r.rel).join("、")}`);
  const registered = new Set(rows.map((row) => row.rel));
  const missing = onDisk.filter((f) => !registered.has(f));
  assert.deepEqual(
    missing,
    [],
    `这些 src 文件没进 AGENTS.md 的代码地图（新模块没人会读到）：${missing.join("、")}\n` +
      "把它加进对应的表（Host 侧 / Client 侧 / 共享），一句话职责 + 关键导出。"
  );
}

// ── §14b AGENTS.md 代码地图第三列「关键导出」：写下的名字必须真的导得出 ────────
//
// 事故（2026-10-18 评审实测）：0.5.0 两次改名（submitDrawJob→submitDrawTask、
// pollDrawJob→awaitDrawTask）之后，AGENTS.md:140 的「关键导出」列**从未同步**——
// `git log -L` 证实那两行自 8483d32 创建起一字未动。同类失效共 6 处（72 个登记
// 符号里）：5/66 在 Host/Client 表，另 1 个（resolveRetryPolicy）其实是 peer
// @deepseek-ai/dsh-llm 的导出、本仓只导 buildRetryPolicyConfig。地图把会话指向
// 不存在的函数名，比指向不存在的文件更隐蔽：文件缺失 §14① 抓得到，符号缺失
// 连 grep 都要人想到去 grep。
//
// §14 原判据对第三列写着「无法机械核（试过：正则当场误报 72/72）」。那次试错
// 的根因是**形状枚举不全**：只按 `export function NAME(` 匹配，于是 const
// （`export const S = {`）、class、re-export（`export { X } from "..."`）、
// async-generator（`export async function*`）全被判「不存在」→ 72/72 全灭。
// 六种形状枚举齐后实测 66/66 通过（零误报），这条判据是可机械的。
//
// 判据（两个方向，2026-10-18 补反向）：
//   ① 反向——第三列整列为空 = 地图放弃了这一栏（「导出了但没写」的极端形态：
//      文件在表里、却连一个入口都没给）。曾是 `if (!fileCell || !exportsCell)
//      continue;` 静默跳过，于是共享表（wire/codes/allow-list）整列空白没人管。
//      要么列一个真实导出，要么显式写「—」声明无关键导出。
//   ② 正向——第三列每个反引号名字（去掉 `()` 后缀）必须出现在该文件的实际导出集合里。
// 反引号外的东西（`被上面四个 store 共用`、`...`、`—`）不判——那些是散文省略。
{
  // 行 → 文件的归属由**表头**决定（见 readCodeMap 头注）：basename 在多个表里重复时，
  // 旧实现一律落到第一个命中的根，于是 client/index.ts 与 shared/codes.ts 从未被真正核过。
  const { rows } = readCodeMap();
  assert.ok(rows.length > 30, `AGENTS.md 代码地图只解析到 ${rows.length} 行——表被改写/换格式了？`);
  // 实际导出集合：六种形状（function / async function / async function* / const / class
  // / interface）+ 两种 re-export（`export { A, B } from "..."` 与本地 `export { A, B };`，
  // 后者 name 在花括号里，前者还要处理 `X as Y` 的改名）。
  const exportsOf = (file) => {
    const src = read(file);
    const names = new Set();
    const decl =
      /\bexport\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
    for (const m of src.matchAll(decl)) names.add(m[1]);
    const reExport = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*["'][^"']+["'])?\s*;?/g;
    for (const m of src.matchAll(reExport)) {
      for (const part of m[1].split(",")) {
        const as = part.match(/\bas\s+([A-Za-z_$][\w$]*)/);
        const bare = part.trim().match(/^([A-Za-z_$][\w$]*)$/);
        if (as) names.add(as[1]);
        else if (bare) names.add(bare[1]);
      }
    }
    return names;
  };
  const bad = [];
  for (const { rel, exportsCell } of rows) {
    if (!existsSync(join(root, rel))) continue; // 幽灵行由 §14① 判红，这里不重复报
    const actual = exportsOf(rel);
    // 反向判据：整列空白 = 放弃登记（见本条注释 ①）。
    if (exportsCell === undefined || exportsCell.trim() === "") {
      bad.push(`${rel}：地图第三列整列为空——列一个真实导出，或显式写「—」声明无关键导出`);
      continue;
    }
    // 正向判据：第三列里每个反引号名字。`...` 与散文（无反引号）不判。
    for (const name of [...exportsCell.matchAll(/`([^`]+)`/g)].map((x) => x[1])) {
      if (name === "...") continue;
      const bare = name.replace(/\(\).*$/, "");
      if (!/^[A-Za-z_$][\w$]*$/.test(bare)) continue;
      if (!actual.has(bare)) {
        bad.push(`${rel}：地图写 \`${name}\`，实际导出里没有（共 ${actual.size} 个导出）`);
      }
    }
  }
  assert.deepEqual(
    bad,
    [],
    `AGENTS.md 代码地图「关键导出」列问题：\n  ${bad.join("\n  ")}\n` +
      `（改名后忘了同步地图。两种修法：把地图改成实际导出的名字，或该符号确实是别处\n` +
      `（如 peer 包）的导出时改指向真正的归属。判据见本条注释：六种导出形状都枚举了。）`
  );
}

// ── §15 本地计数口径一致性：规范性表面必须同口径，且都必须带 profile 限定 ─────
//
// 事故（2026-10-17 评审实测）：0.5.0 把本地计数口径从「覆盖全部 DSH 魔搭调用」
// 收窄为「本客户端（本 profile）内经本插件的调用」，改了 README「诚实声明」、
// 面板图例（i18n）、AGENTS.md 三处，**漏了 cordis.patch.yml 与 PROVIDER-M4.md**
// ——patch 那份尤其伤：操作者改部署配置时最先读它。同一次更正散在五个表面上，
// 靠人记同步是防不住的，这里建成封闭集合检查，两个方向：
//   ① 禁止无限定宣称：集合内不得出现「覆盖全部 DSH 魔搭调用」。正则容忍
//      markdown 强调符与折行（`覆盖**全部\n   DSH 魔搭调用**` 也跑不掉）；
//      同行带更正/历史标注的引用除外（§3/§8 同款——按行不按段，段落级窗口
//      形同虚设是 §8 用变异证明过的教训）。
//   ② 必须带限定：集合内每一处都要出现口径限定词（中英任一任排）——改写措辞
//      不判红，但把「本客户端」三个字从某个表面上删干净会红。
// 豁免逻辑为什么要显式：CHANGELOG 与 docs/archive/** 逐字保留这次更正的原文
// （含被推翻的旧宣称），按 §6② 同款政策本就不进集合。
{
  const SCOPE_FILES = ["README.md", "AGENTS.md", "cordis.patch.yml", "docs/PROVIDER-M4.md", "src/client/i18n.ts"];
  // 反向断言：封闭集合的**成员清单本身**不许缩水。§15 的立论是「同一次更正散在
  // 五个表面上，靠人记同步防不住」——删掉一个表面就等于回到没有门禁，而原判据
  // （只扫集合内文件、只查存在性）对删成员完全无感：2026-10-19 评审实测删掉
  // cordis.patch.yml 后 exit 0 全绿。新增规范性表面时**加**进来，不许减；确需
  // 移除某个表面，先在注释里写清理由并同步改 REQUIRED_SCOPE_FILES（明示放弃射程）。
  const REQUIRED_SCOPE_FILES = ["README.md", "AGENTS.md", "cordis.patch.yml", "docs/PROVIDER-M4.md", "src/client/i18n.ts"];
  assert.ok(
    REQUIRED_SCOPE_FILES.every((f) => SCOPE_FILES.includes(f)),
    `口径封闭集合被删减了：${REQUIRED_SCOPE_FILES.filter((f) => !SCOPE_FILES.includes(f)).join("、")}——\n` +
      `2026-10-17 那次更正漏的正是 cordis.patch.yml 与 PROVIDER-M4.md，集合缩水等于那类漏同步重新变成可能。\n` +
      `要移除某个表面，先在 §15 注释里写清理由并同步改 REQUIRED_SCOPE_FILES（即明示放弃一处射程）。`
  );
  // 容忍强调符与折行的旧宣称指纹：覆盖 (**)(换行/缩进) 全部 (换行) DSH 魔搭 调用
  const STALE_CLAIM = /覆盖[\s*]{0,4}全部[\s*]{0,8}DSH[\s*]{0,4}魔搭[\s*]{0,4}调用/i;
  const HISTORY_MARK = /更正|~~|曾|历史|当时|推翻|证伪|收窄/;
  const QUALIFIER = /本客户端|this client|按\s*profile|per-profile|profile\s*分段|各记各的|separate ledger/;
  assert.ok(SCOPE_FILES.every((f) => existsSync(join(root, f))), `口径封闭集合里有文件不存在：${SCOPE_FILES.filter((f) => !existsSync(join(root, f))).join("、")}`);
  for (const file of SCOPE_FILES) {
    for (const [i, line] of read(file).split(/\r?\n/).entries()) {
      if (!STALE_CLAIM.test(line)) continue;
      assert.ok(
        HISTORY_MARK.test(line),
        `${file}:${i + 1} 仍称本地计数「覆盖全部 DSH 魔搭调用」——2026-10-17 起口径收窄为` +
          `「本客户端（本 profile）内经本插件的调用」（桌面端与 Web 端各记各的、互不可见，` +
          `npm run doctor 并排列出各 profile）。\n    ${line.trim()}\n` +
          `（保留历史引用必须在同一行加更正/证伪标注；否则改成本口径。）`
      );
    }
    assert.ok(
      QUALIFIER.test(read(file)),
      `${file} 通篇没有本地计数的口径限定词（本客户端 / 按 profile / separate ledger …）——` +
        `收窄后的口径必须写在每一处规范性表面上，否则读者会把它读成跨端总量。`
    );
  }
}

// ── §16 ROADMAP 时效：现状版本号必须追上 package.json，Backlog 分节必须在 ────
//
// 事故（2026-10-17 评审实测）：ROADMAP 的「现状」停在 v0.2.0，而实际 0.5.0；
// 两条 2026-10-15/16 已交付的门禁工作仍挂在「未做」清单里。§6② 管套件数、
// §8 管预告词、§12 管「尚未实现」，都没有覆盖率程图的版本陈述——而它是每个
// 会话判断「做到哪了」的入口。判据机械：ROADMAP 必须提到当前 package.json 的
// 版本号（写法不限），且 docs.test.mjs §11 红字提示指向的「Backlog」分节必须
// 还在（否则「明确的缺口声明」无处可去）。
{
  const pkg = JSON.parse(read("package.json"));
  const roadmap = read("docs/ROADMAP.md");
  assert.ok(
    roadmap.includes(pkg.version),
    `docs/ROADMAP.md 没有提到当前版本 ${pkg.version}——「现状」节停在旧版本号。\n` +
      `版本推进时同步刷新 ROADMAP 的现状节（0.5.0 起它对 0.3–0.5 三条功能线整体缺录，` +
      `已交付的门禁工作也仍挂在「未做」清单里）。`
  );
  assert.ok(
    /^##\s*Backlog/m.test(roadmap),
    "docs/ROADMAP.md 没有 Backlog 分节——docs.test.mjs §11 把「明确的缺口声明」指向这里，指针不能断。"
  );
}

// ── §17 四个状态 store 的 legacy 继承裁定必须写在头注里 ──────────────────────
//
// 事故（2026-10-18 修复 0.6.1 时实测）：profile 分段前写在共享目录里的状态文件
// （provider.json / usage.json / usage-prefs.json / draw.json）在迁移窗口期怎么
// 处置，四个 store 曾三套口径、两套没写在明面上——usage.json 没有任何裁定注释，
// draw.json 的头注写着「不存在共享旧文件」而这个前提只对一部分宿主成立（git 史
// 核实）。裁定住在**注释**里，不进任何判据：下一个人重写某个 store 的头注时删掉
// 那段裁定，没有任何测试会红，R3 原样复发。
//
// 判据机械，两个方向：
//   ① 集合按**结构**枚举（src/host 下 *-store.ts 且 import state-store 原语的），
//      新 store 自动入列，不靠人手登记；四个已知成员必须在射程内（过滤条件被改坏
//      时不许悄悄缩水）；
//   ② 裁定必须写在**头注**（首个 import 之前的文档块）里，且按裁定侧给指纹：
//      继承侧必须出现 legacy 字样，不搬侧必须出现「不继承/不搬」字样。写在中段
//      注释里不算——provider-store 的裁定 2026-10-18 前就在中段，评审照样看漏。
{
  const stores = tsFiles("src/host").filter((f) => /-store\.ts$/.test(f) && read(f).includes('from "./state-store.ts"'));
  // 继承侧 vs 不搬侧的指纹。新成员没有先验时落 GENERIC（提到 legacy 主题即可）。
  const SIDE = {
    "src/host/provider-store.ts": /legacy/i, // 继承缝：一次性继承旧共享 provider.json
    "src/host/usage-prefs-store.ts": /legacy|继承/, // 继承缝：单值显示偏好一次性继承
    "src/host/usage-store.ts": /不继承|不搬/, // 裁定：无 profile 时期的账不属于任何 profile，不搬
    "src/host/draw-store.ts": /不继承|没有 legacy|不搬/ // 裁定：不继承不搬，doctor 以 shared (legacy) 报出
  };
  const GENERIC = /legacy|继承|不搬/;
  // 反向断言：四个裁定侧指纹一个都不许少。原判据只遍历 Object.keys(SIDE)，
  // 删掉一个键 = 少一道检查而全绿（2026-10-19 评审实测：删 draw-store.ts 指纹后
  // exit 0）。上面 stores 结构集合已有反向断言（:795 那段），指纹集合却没有对称
  // 的保护——注释自称「四个已知成员必须在射程内」，实现只保证了一半。
  assert.deepEqual(
    Object.keys(SIDE).sort(),
    ["src/host/draw-store.ts", "src/host/provider-store.ts", "src/host/usage-prefs-store.ts", "src/host/usage-store.ts"].sort(),
    "SIDE 裁定侧指纹集合被删减了——四个状态 store 的 legacy 继承裁定各一份，少一个就等于那个 store 的头注没人盯"
  );
  const headerOf = (text) => {
    const end = text.indexOf("*/");
    if (end < 0) throw new Error(`头注解析失败：找不到块注释结尾 */——裁定必须写在首个 import 之前的块注释里，行注释不算（见 §17 判据）`);
    return text.slice(0, end + 2);
  };
  for (const known of Object.keys(SIDE)) {
    assert.ok(
      stores.includes(known),
      `state-store 门禁的结构集合漏掉了 ${known}——import 形式变了还是文件被改名？` +
        `（集合按「*-store.ts 且 import state-store」枚举，四个裁定侧指纹在 SIDE 里，改集合同步改指纹。）`
    );
  }
  for (const store of stores) {
    const needle = SIDE[store] ?? GENERIC;
    assert.ok(
      needle.test(headerOf(read(store))),
      `${store} 的头注（首个 import 之前的文档块）没有写明 legacy（pre-profile 共享目录）继承裁定——\n` +
        `      四个状态 store 各记各的账，共享旧文件搬不搬必须有明文：provider / usage-prefs 继承（一次性、显式清除不复活），\n` +
        `      usage / draw 不搬（doctor 以 shared (legacy) 作用域报出）。删掉或改写头注时把裁定留着——本门禁盯着它。`
    );
  }
}

// ── §18 AGENTS.md 验证段点名的门禁行号必须落在对应 § 节区间内 ──────────────
//
// 事故（2026-10-18 实测）：6ef18b8 在 docs.test.mjs 里插入 readCodeMap（约 45 行）
// 后，§14 及之后所有节整体下移，但 AGENTS.md 验证段写死的行号没跟着重数——
// 6 个声称值里 5 个指向了**别的节的代码**（§14:554 落在 §13 块、§15:659 落在
// §14b 块、§17:723 落在 §15 块），只有 §6:154 因为排在插入点之前而碰巧精确。
// 「每条都能点出行号」是给 AI 会话指路的承诺，指错 = 把会话领到另一道门禁的
// 代码上，比不带行号更糟。本门禁兜底：AGENTS.md 声称的行号必须落在它声称的
// 那个 § 节自己的区间里（该节注释行起，到下一条 § 注释行止）。
//
// 判定机械：先扫本文件所有 `// ── §N` 注释行构出节区间表（§N 允许带字母后缀，
// 如 14b），再扫 AGENTS.md 里形如「§N（:NNNN）」的引用，断言 :NNNN ∈ [该节注释行,
// 下一条 § 注释行)。以后谁再往 docs.test.mjs 中间插大段代码，AGENTS.md 忘了重数
// 行号就会判红——而上一轮这种漂移恰好全绿通过了。
{
  const ownLines = read("test/docs.test.mjs").split(/\r?\n/);
  const sections = [];
  for (const [i, line] of ownLines.entries()) {
    const m = line.match(/^\/\/ ── §(\d+[a-z]?) /);
    if (m) sections.push({ name: m[1], start: i + 1 });
  }
  assert.ok(sections.length >= 8, `docs.test.mjs 的 § 节注释行少于 8 个（${sections.length}）——节区间表坏了`);
  const spanOf = (name) => {
    const idx = sections.findIndex((s) => s.name === name);
    if (idx < 0) return null;
    const end = idx + 1 < sections.length ? sections[idx + 1].start : ownLines.length + 1;
    return [sections[idx].start, end];
  };
  const agLines = read("AGENTS.md").split(/\r?\n/);
  for (const [i, line] of agLines.entries()) {
    for (const m of line.matchAll(/§(\d+[a-z]?)[（(]:(\d+)[）)]/g)) {
      const name = m[1];
      const claimed = Number(m[2]);
      const span = spanOf(name);
      assert.ok(span, `AGENTS.md:${i + 1} 引用了 docs.test.mjs 里不存在的 §${name}：\n    ${line.trim()}`);
      assert.ok(
        claimed >= span[0] && claimed < span[1],
        `AGENTS.md:${i + 1} 声称 §${name} 在 docs.test.mjs:${claimed}，但 §${name} 实际在 :${span[0]}–:${span[1] - 1}——` +
          `（上一轮事故：中间插入 readCodeMap 后所有节 +45，行号没重数，5/6 全指到别的节上。）\n    ${line.trim()}`
      );
    }
  }
}

console.log("docs.test.mjs: all checks passed");
