// peer 范围 × 真实版本宇宙的对齐门禁。
//
// ## 守什么，不守什么
//
// package.json 里那 10 条 `@deepseek-ai/dsh-*` peer 范围是**声明**：宿主拿
// `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 决定某个
// 运行时版本能不能装本插件（dsh-app-boot 的兼容闸）。声明错了不会有编译错误、不会
// 有测试红——它只是**安静地接受或拒绝一批版本**。
//
// 本套件把「这条范围在真实发布史上到底放行哪些版本」冻结进
// test/host-range.golden.json，每次跑都对一遍，红了逐个版本点名。
//
// 它守的是**对齐**（范围与版本宇宙是否还匹配），不是**行为**（插件在那个版本上能不能
// 跑起来）。后者要真装真启，本仓库的离线门禁刻意不做那件事。
//
// ## 为什么 `>=0.1.5` 这个下界不是它看起来的样子
//
// `">=0.1.5 <0.3"` 读起来是「0.1.5 及以上」，实际语义是「**0.1.6-alpha.1** 及以上」：
// 0.1.5 是稳定版，预发布排序低于自身，所以 0.1.5 自己的 alpha/rc 全部被拒——写作者
// 以为放行的，正是它拒绝的那批。反过来它又**主动接收** 0.1.6-alpha.1、0.1.7-alpha.1、
// 0.2.1-alpha.1 这些内测版。两个方向都只有把范围拿去跑一遍真实版本表才看得见，这就是
// 本文件的全部意义。
//
// ## 为什么是 .test.mjs
//
// test/run-all.mjs 按 glob 自动发现 test/*.test.mjs，所以落盘即参跑。本套件零网络；
// 它读 package.json、golden、src/** 与（宿主那份在场时）宿主 node_modules 里的
// peer 模块。刷新 golden 走 tools/update-host-range.mjs（唯一联网的地方）。
//
// 它需要 devDependencies（typescript——扫描器用的就是 `npm run typecheck` 那套解析器）：
// 裸 checkout 上先 `npm install`，否则报 "Cannot find package 'typescript'"。
//
// ## 红了怎么办
//
// 三种可能：上游发了新运行时版本（→ 跑生成器刷新，然后**用人的判断**看那个新版本该
// 不该被收）；范围被人改了（→ 有意就刷新，手滑就改回去）；golden 被手改坏了（→ 它是
// 生成物，别手改）。
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pathResolves, readGroups, scanPeerImports } from "./helpers/peer-imports.mjs";
import { compareVersions, diffAgainstGolden, explain, hostPeers, partition } from "./host-range.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const golden = JSON.parse(readFileSync(join(here, "host-range.golden.json"), "utf8"));

/** 已发布的全部 @deepseek-ai/dsh 版本，按 semver 升序。 */
const universe = golden.universe ?? [];

/**
 * src/** 里从 peer 取符号的地方。扫两遍：AST 路认形态（具名/默认/命名空间/动态/再导出），
 * token 路只看词法。两套互不依赖的实现必须数出同一批——对不上就是扫描器坏了。
 * 扫描器自己的门禁在 test/peer-imports.test.mjs（零宿主，CI 上也跑）。
 */
const peerScan = scanPeerImports({ root, peerNames: Object.keys(manifest.peerDependencies ?? {}) });

// --- 1. golden 的宇宙 = 已发布的全部版本，不是抽样 -------------------------
assert.ok(Array.isArray(universe) && universe.length > 0, "universe 为空");

// 宿主判的是**运行时版本**，不是 peer 包自己的版本：`@deepseek-ai/dsh-settings@0.1.2-alpha.3`
// 是那个包的发布节奏，与任何会加载本插件的宿主无关。
assert.equal(golden.universePackage, "@deepseek-ai/dsh", "宇宙必须锚在宿主运行时版本上");

// 注册表返回的是发布序（0.2.1-alpha.1 发布在 0.2.0-rc.2 之后），不是版本序；生成器排过序，
// 这里复核——没排序的黄金表会让「最新放行版本」算错。
for (let i = 1; i < universe.length; i++) {
  assert.ok(
    compareVersions(universe[i - 1], universe[i]) < 0,
    `顺序或重复被破坏：${universe[i - 1]} 不早于 ${universe[i]}`,
  );
}

// 每个代际至少一个锚点。全丢说明扫描没够到输入（或 golden 被截断过）。
for (const anchor of ["0.1.7-rc.1", "0.2.0-rc.1", "0.2.1-rc.2"]) {
  assert.ok(universe.includes(anchor), `锚点 ${anchor} 不在宇宙里`);
}

// --- 2. 每条 peer 范围的判定与记录一致 ------------------------------------
const report = diffAgainstGolden(manifest, golden);
assert.deepEqual(
  report,
  [],
  `\n${explain(report)}\n（上游发版或范围改动都会走到这里；确认后用 node tools/update-host-range.mjs 刷新）`,
);

// --- 3. 记录的分区与它自己的范围自洽（防手改 golden） ---------------------
for (const [name, entry] of Object.entries(golden.peers ?? {})) {
  const derived = partition(universe, entry.range);
  assert.deepEqual(
    derived.admitted,
    entry.admitted,
    `${name} 的 admitted 与它自己的 range "${entry.range}" 不自洽——golden 是生成物，别手改`,
  );
  assert.equal(derived.admitted.length + derived.refused.length, universe.length);
}

// 反向：磁盘上每条 host peer 都必须有记录（否则「新增了一条 peer 依赖却没人给它评分」，
// 它会悄悄收进版本而零记录）。
{
  const recorded = new Set(Object.keys(golden.peers ?? {}));
  const missing = hostPeers(manifest)
    .map(([name]) => name)
    .filter((name) => !recorded.has(name));
  assert.deepEqual(missing, [], `这些 peer 没有 golden 记录：${missing.join(", ")}`);
}

// --- 4. 下界不会被静默上舍 ------------------------------------------------
//
// `>=0.1.5` 配预发布宇宙时，写作者以为的「X.Y.Z 及以上」实际是「X.Y.Z 之后的第一个
// 预发布及以上」。这条把那个语义差钉出来。若哪天真要「从 0.1.5 起」，正确写法是
// `>=0.1.5-rc.1` 之类——改完这条断言会自动跟随，因为它从 range 里读。
{
  const offenders = [];
  for (const [name, entry] of Object.entries(golden.peers ?? {})) {
    const floor = /^>=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(entry.range);
    if (!floor) continue;
    if (floor[1].includes("-")) continue; // 下界自带预发布标签，本检查不适用
    const own = `${floor[1]}-rc.1`;
    if (!universe.includes(own)) continue;
    if (entry.admitted.includes(own)) offenders.push(`${name} 放行了 ${own}`);
  }
  assert.deepEqual(offenders, [], `稳定版下界静默放行了自己的预发布：${offenders.join("; ")}`);
}

// --- 5. 实际验证过的宿主版本都被放行 -------------------------------------
//
// validatedOn 是「这个插件真的在哪些宿主上跑过」的账本（证据写在生成器里）。它必须既在
// 宇宙里、又被每条 peer 放行——否则等于「我们验证过的版本，自己的声明却拒之门外」。
{
  const validatedOn = golden.validatedOn ?? [];
  assert.ok(validatedOn.length > 0, "validatedOn 为空——账本不能空着自称验证过");
  for (const version of validatedOn) {
    assert.ok(universe.includes(version), `已验证的宿主 ${version} 不在宇宙里（版本消失或 golden 被截断）`);
    const refusedBy = Object.entries(golden.peers ?? {})
      .filter(([, entry]) => !(entry.admitted ?? []).includes(version))
      .map(([name]) => name);
    assert.deepEqual(refusedBy, [], `已验证的宿主 ${version} 被这些 peer 拒绝：${refusedBy.join(", ")}`);
  }
}

// --- 6. 0.x 之外不外泄 ----------------------------------------------------
//
// 上限一律写 `<0.3`（desugar 成 `<0.3.0-0`）。跨 minor 是 ABI 断裂线，收进来就等于宣称
// 「下一代会跑」而没有一行验证。
{
  const leaked = [];
  for (const probe of ["0.3.0", "1.0.0"]) {
    for (const [name, entry] of Object.entries(golden.peers ?? {})) {
      if ((entry.admitted ?? []).includes(probe)) leaked.push(`${name} 放行了 ${probe}`);
    }
  }
  assert.deepEqual(leaked, [], leaked.join("; "));

  // 反向活性证明：若范围塌成只拒，上一条会恒真而毫无意义。
  const anyAdmitted02 = Object.values(golden.peers ?? {}).some((entry) =>
    (entry.admitted ?? []).some((v) => v.startsWith("0.2.")));
  assert.ok(anyAdmitted02, "没有 0.2.x 被放行——范围塌了或宇宙读空了");
}

// --- 7. 比较器与宿主真正在用的 semver 对拍 -------------------------------
//
// 本仓库自带一份零依赖比较器（test/host-range.mjs），是故意重写的。重写就有偏离风险，
// 所以拿宿主那份 semver（dsh 自带的 7.x）对同一批输入逐个比对。找不到宿主副本时打印
// SKIP 而不是失败——干净检出不装任何东西是这个仓库的前提。
function loadHostSemver() {
  const candidates = [];
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (globalRoot) candidates.push(join(globalRoot, "@deepseek-ai", "dsh", "node_modules", "semver"));
  } catch {
    // 没有 npm / 没有全局树：下面还有裸 semver 可试。
  }
  candidates.push("semver");
  const require = createRequire(join(root, "package.json"));
  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      if (loaded && typeof loaded.satisfies === "function") return loaded;
    } catch {
      // 试下一个。
    }
  }
  return null;
}

{
  const semver = loadHostSemver();
  if (semver === null) {
    console.log("SKIP: 既没有宿主那份 semver 也没有裸 semver，对拍未运行");
  } else {
    // 不只比本仓的 range：混进几条已知陷阱形式，防止「比较器只对自己的输入正确」。
    const ranges = [
      ...hostPeers(manifest).map(([, range]) => range),
      "<0.2",
      ">=0.1.5 <0.3",
      ">=0.1.7-rc.1 <0.3.0-0",
      ">=0.2.0-rc.0 <0.3",
    ];
    const disagreements = [];
    let compared = 0;
    for (const range of ranges) {
      for (const version of universe) {
        const ours = partition([version], range).admitted.length === 1;
        const theirs = semver.satisfies(version, range, { includePrerelease: true });
        compared++;
        if (ours !== theirs) disagreements.push(`${version} × "${range}": 本仓=${ours} 宿主=${theirs}`);
      }
    }
    assert.deepEqual(disagreements.slice(0, 10), [], disagreements.slice(0, 10).join("\n"));
    // 活性：没比到东西也算红——「一致」不能由零组输入凑出来。
    assert.ok(compared >= ranges.length * 10, `对拍没比到输入：compared=${compared}`);
  }
}

// --- 8. 射程闭合：每条 peerDependency 都有账 -----------------------------
//
// 上面那个模型（golden.peers）只覆盖「宿主拿 DSH 运行时版本去判」的那类 peer。
// 其余的（框架库、由宿主依赖树决定版本的）必须**显式**记进 golden.outOfScopePeers
// 并写明原因——「多了一条 peer 依赖没人管」是沉默的缺口，而沉默的缺口会一直沉默。
// 记下来的代价是：射程外的 peer 换一种契约来守（见 9、10 两节），不是从此没人管。
{
  const peerNames = Object.keys(manifest.peerDependencies ?? {});
  const inScope = new Set(Object.keys(golden.peers ?? {}));
  const outOfScope = new Map((golden.outOfScopePeers ?? []).map((entry) => [entry.name, entry]));

  const unaccounted = peerNames.filter((name) => !inScope.has(name) && !outOfScope.has(name));
  assert.deepEqual(
    unaccounted,
    [],
    `这些 peerDependency 没有任何记录（既不在 golden.peers，也不在 golden.outOfScopePeers）：${unaccounted.join(", ")}`,
  );

  // 反向：账上有的必须是真声明——记一个 package.json 里没有的 peer 是幻觉。
  const phantom = [...inScope, ...outOfScope.keys()].filter((name) => !peerNames.includes(name));
  assert.deepEqual(phantom, [], `golden 记了 package.json 里没有的 peer：${phantom.join(", ")}`);

  // 一条 peer 不许记两遍（两个账本两套说法 = 迟早自相矛盾）。
  const doubleBooked = peerNames.filter((name) => inScope.has(name) && outOfScope.has(name));
  assert.deepEqual(doubleBooked, [], `这些 peer 同时记在两个账本里：${doubleBooked.join(", ")}`);

  for (const [name, entry] of outOfScope) {
    assert.ok(
      typeof entry.reason === "string" && entry.reason.trim().length > 10,
      `${name} 的射程外记录没写「为什么不在射程里」`,
    );
    assert.equal(
      entry.range,
      manifest.peerDependencies?.[name] ?? null,
      `${name} 的射程外记录里的 range 与 package.json 不一致（golden 是生成物，别手改）`,
    );
  }

  // 我们真的从它 import 符号的那些射程外 peer，必须有「从哪个版本起符号就在」的证据——
  // 否则那条下界是没有出处的。
  for (const name of new Set(peerScan.ast.map((site) => site.owner))) {
    if (!outOfScope.has(name)) continue;
    assert.ok(
      typeof outOfScope.get(name).symbolsFrom === "string" && outOfScope.get(name).symbolsFrom.length > 0,
      `${name} 是我们 import 符号的 peer，但它的射程外记录里没有 symbolsFrom——那个下界凭什么？`,
    );
  }
}

// --- 9. 已装版本的契约：宿主实际装的那份必须被我们声明的范围放行 ---------
//
// 射程外的 peer 不进「版本宇宙 × 范围」那个模型，但它们**确实**有个版本在宿主机器上
// 装着。那份版本必须被我们声明的范围放行——否则宿主一升级，本插件就被自己的 peer 范围
// 拒之门外，而这件事没有任何门禁会发现。
{
  const modulesDir = hostModulesDir();
  const semver = loadHostSemver();
  const skipped = [];
  for (const entry of golden.outOfScopePeers ?? []) {
    const version = modulesDir ? installedVersion(modulesDir, entry.name) : null;
    if (!version) {
      skipped.push(entry.name);
      continue;
    }
    const admitted = rangeAdmits(version, entry.range, semver);
    assert.notEqual(
      admitted,
      null,
      `判断不了 ${entry.name}@${version} 是否被 "${entry.range}" 放行（既没有宿主那份 semver，本仓比较器也不认这个范围的写法）`,
    );
    assert.ok(
      admitted,
      `宿主装的是 ${entry.name}@${version}，但我们声明的范围 "${entry.range}" 不放行它——宿主升级后这个 peer 会直接拒绝本插件`,
    );
    // 两个都能算的时候必须一致：本仓比较器与宿主真正在用的 semver 说的是一件事。
    let ours = null;
    try {
      ours = partition([version], entry.range).admitted.length === 1;
    } catch {
      ours = null; // 本仓比较器不认这种写法（^ ~ 等），不猜。
    }
    if (ours !== null && semver) {
      assert.equal(
        ours,
        admitted,
        `本仓比较器与宿主 semver 对 ${entry.name}@${version} × "${entry.range}" 的判断不一致`,
      );
    }
  }
  if (skipped.length > 0) {
    console.log(`SKIP: 宿主这份没装 ${skipped.join(", ")}，已装版本契约未运行`);
  }
}

// --- 10. 符号契约：我们 import 的符号必须在宿主装的那份里真的存在 ---------
//
// 9 节守的是「版本放不放行」，这一节守的是「放行了也用得上」：本插件从 pi-ai 拿
// createProvider 与 openAICompletionsApi——如果宿主装的那份 pi-ai 改名或删了这两个
// 导出，范围照样放行，插件照样装得上，然后在大庭广众之下炸在 import 上。
// 这一节分两段，两段的判据强度不同——混在一起写就会像现在这样：宿主不在场时，
// 整节连同它的活性检查一起被跳过，于是「扫描器瞎了」这件事在 CI 上没人知道。
//
//   10a 扫描面（与宿主在不在场无关）：扫描器必须真的看见 src/** 里的 peer 导入点，
//       而且 AST 路与 token 路两套互不依赖的实现必须数出同一批。宿主不在场时
//       这一段照跑——它是「扫描器还活着」的唯一证据。
//
//   10b 契约面（宿主在场才跑）：逐个符号核对宿主装的那份。宿主不在场时按 9 节的
//       同一语义 SKIP，不假装核对过。
{
  // --- 10a. 扫描面 ----------------------------------------------------------
  const astSpecs = peerScan.ast.map((site) => `${site.file}|${site.spec}`).sort();
  const tokenSpecs = peerScan.tokens.map((hit) => `${hit.file}|${hit.spec}`).sort();
  assert.deepEqual(
    tokenSpecs,
    astSpecs,
    "两套扫描路数出的 peer 导入点对不上——扫描器坏了，不是「都对」",
  );
  assert.ok(astSpecs.length > 0, "一个 peer 导入点都没扫到——扫描器坏了，不是「都对」");

  // --- 10b. 契约面 ----------------------------------------------------------
  const modulesDir = hostModulesDir();
  const skipped = [];
  let checked = 0;
  for (const site of peerScan.ast) {
    if (!modulesDir) {
      skipped.push(site.spec);
      continue;
    }
    const loaded = await loadHostModule(modulesDir, site.spec);
    if (!loaded) {
      skipped.push(site.spec);
      continue;
    }
    for (const symbol of site.symbols) {
      assert.ok(
        symbol in loaded.mod,
        `宿主装的 ${site.spec}@${loaded.version} 里没有导出 ${symbol}——我们在 ${site.file} 从它 import 这个符号`,
      );
      checked++;
    }
    // 命名空间导入与动态导入读的是**属性**（`mod?.defineTool ?? mod?.default?.defineTool`），
    // 不是具名导出：契约是「这条 `??` 链上有一条走得通」，不是「每条都得通」。
    for (const group of readGroups(site.reads)) {
      const paths = group.paths.map((parts) => parts.join("."));
      assert.ok(
        group.paths.some((parts) => pathResolves(loaded.mod, parts)),
        `宿主装的 ${site.spec}@${loaded.version} 上没有 ${paths.join(" 或 ")}——我们在 ${site.file} 读这个属性`,
      );
      checked++;
    }
  }
  if (skipped.length > 0) {
    console.log(`SKIP: 宿主这份里读不到 ${skipped.join(", ")}，符号契约未运行`);
  }
  // 活性：宿主在场、却一个符号都没核到，说明我们以为能比的那份其实没读到（宿主那份
  // 的布局与我们以为的不同，或解析器坏了）。这时候「全过」是零组输入凑出来的。
  // 宿主不在场时这段不判红——那时 10a 已经兜住了「扫描器瞎了」，没有可比对象就是
  // 没有可比对象，不假装有。
  if (modulesDir) {
    assert.ok(
      checked > 0,
      "宿主那份在，却一个符号都没核到——宿主那份的布局或解析器坏了，不是「都对」",
    );
  }
}

// --- 共用工具 ---------------------------------------------------------------

/** 宿主那份 node_modules 在哪（装 DSH 的那个目录）。找不到就返回 null。 */
function hostModulesDir() {
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!globalRoot) return null;
    const dir = join(globalRoot, "@deepseek-ai", "dsh", "node_modules");
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** 宿主那份里某个包装的是哪个版本。装不上就 null（不是 0，也不是报错）。 */
function installedVersion(modulesDir, packageName) {
  try {
    const pkg = JSON.parse(readFileSync(join(modulesDir, ...packageName.split("/"), "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * 「这个版本被这条范围放行吗」：有宿主 semver 就用它（它认 ^ ~ 等写法），
 * 没有就用本仓比较器（只认 >=X.Y.Z / <X.Y.Z 的方言，别的直接放弃）。
 * 判不了返回 null——**不猜**。
 */
function rangeAdmits(version, range, semver) {
  if (semver) return semver.satisfies(version, range, { includePrerelease: true });
  try {
    return partition([version], range).admitted.length === 1;
  } catch {
    return null;
  }
}

/** exports 字段的值可能是字符串，也可能是条件对象（{import, node, default}）。 */
function pickExportTarget(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  for (const condition of ["import", "node", "default"]) {
    if (value[condition] === undefined) continue;
    const target = pickExportTarget(value[condition]);
    if (target) return target;
  }
  return null;
}

/** 解析 exports 里的某个子路径（含 "./api/*" 这种通配）。解析不出来就 null。 */
function resolveSubpath(exportsMap, subpath) {
  if (!exportsMap) return null;
  if (exportsMap[subpath] !== undefined) return pickExportTarget(exportsMap[subpath]);
  for (const key of Object.keys(exportsMap)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (subpath.length < prefix.length + suffix.length) continue;
    const target = pickExportTarget(exportsMap[key]);
    if (target) return target.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length));
  }
  return null;
}

/** 宿主那份里的某个模块（按 exports 解析后 dynamic import）。读不到就 null。 */
async function loadHostModule(modulesDir, spec) {
  const parts = spec.split("/");
  const packageName = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = join(modulesDir, ...packageName.split("/"));
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const subpath = spec === packageName ? "." : `./${spec.slice(packageName.length + 1)}`;
  const target = resolveSubpath(pkg.exports, subpath) ?? (subpath === "." ? pkg.main ?? "index.js" : null);
  if (!target) return null;
  try {
    const mod = await import(pathToFileURL(join(dir, target)).href);
    return { mod, version: pkg.version };
  } catch {
    return null;
  }
}

console.log("host-range.test.mjs: all checks passed");
