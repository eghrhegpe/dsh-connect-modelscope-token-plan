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
// test/run-all.mjs 按 glob 自动发现 test/*.test.mjs，所以落盘即参跑。本套件零网络、
// 零安装，只读 package.json 与 golden 两个文件；刷新 golden 走
// tools/update-host-range.mjs（唯一联网的地方）。
//
// ## 红了怎么办
//
// 三种可能：上游发了新运行时版本（→ 跑生成器刷新，然后**用人的判断**看那个新版本该
// 不该被收）；范围被人改了（→ 有意就刷新，手滑就改回去）；golden 被手改坏了（→ 它是
// 生成物，别手改）。
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, diffAgainstGolden, explain, hostPeers, partition } from "./host-range.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const golden = JSON.parse(readFileSync(join(here, "host-range.golden.json"), "utf8"));

/** 已发布的全部 @deepseek-ai/dsh 版本，按 semver 升序。 */
const universe = golden.universe ?? [];

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

console.log("host-range.test.mjs: all checks passed");
