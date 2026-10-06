/**
 * `doctor` —— 只读回答「这台机器上，魔搭面板的数据在哪、坏了没有」。
 *
 * 与 sensenova 的 doctor 同形（`--json` 出机器可读报告、其余出人读行），按本
 * 插件的现实缩小：魔搭只有两个状态文件（usage.json 用量计数、provider.json
 * 面板保存的开关与允许清单）和一把静态令牌，没有 draw/catalog 三件套，所以
 * 症状表只有一个 id。它 import 的只有两个 state store 与它们各自的底座
 * （host-config / state-store / util），不碰任何平台对接 peer（llm / publish /
 * inference 一侧），所以在干净 checkout 上即可运行；
 * 只读本插件自己的 state 目录，绝不写盘、绝不打印令牌值（env 只报在场性，
 * 凭据服务里的令牌只有运行中的 Host 看得见，报告会明说这一点）。与 sensenova
 * 同款纪律：绝不读 `cordis.patch.yml`。
 *
 * 症状（symptom）只报**磁盘上可证实**的事，面板上人眼看到的问题引导去对应
 * 的 tab，不做无法从磁盘验证的断言：
 *   - `state-unreadable` —— usage.json 或 provider.json 在场但本构建无法按它
 *     认识的样子解析：要么损坏，要么是更新构建写的（版本只读闸已把本构建的
 *     写入挡住）。这两种情况面板上的可见性**不对称**，值得说清：
 *     · 损坏的文件被静默读作「未设置」，**不会**进 shapeWarnings（与
 *       usage-store 的既有约定一致：坏 JSON 读作空，面板不因此变红），所以
 *       它只有 doctor 能报——这正是「不会报错的状态」要靠 doctor 抓的原因；
 *     · 未知版本的面板是宽容读，所以会进 shapeWarnings（provider.json 那条），
 *       因为不说出口，面板就把「保存的值被忽略」呈现成「从未保存过」。
 *     两种情况操作者都需要一句话的下一步。
 *
 * 干净机器的诚实答案是空数组——「磁盘上没有需要解释的东西」。
 *
 * @module dsh-connect-modelscope-token-plan/doctor
 */
import { readdir, stat, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { name } from "./host-config.ts";
import { dshHome as defaultDshHome, isProfileSegment } from "./state-store.ts";
import { describeProviderPayload } from "./provider-store.ts";
import { describeUsagePayload } from "./usage-store.ts";

/** 症状 id 的单一声明（renderReport 与 --json 都从这里取值）。 */
export const SYMPTOM = Object.freeze({
  STATE_UNREADABLE: "state-unreadable"
});

export type SymptomValue = (typeof SYMPTOM)[keyof typeof SYMPTOM];

/** 每个症状的第一步动作。总函数：缺一条 hint 就过不了编译（见 deriveSymptoms）。 */
const SYMPTOM_HINT: Record<SymptomValue, string> = {
  [SYMPTOM.STATE_UNREADABLE]:
    "state/ 下有一个文件（usage.json 或 provider.json）无法按本构建认识的形状解析：要么损坏，" +
    "要么由更新的构建写入（本构建的写入已被版本只读闸挡住）。面板会显示 shapeWarnings；" +
    "升级插件后再看，或删除该文件重置——usage.json 丢了历史计数，provider.json 丢了面板保存的" +
    "开关与允许清单。"
};

/** 缺一条 hint 就在编译期报错——新症状 id 必须先补 hint。 */
export function hintFor(id: SymptomValue): string {
  return SYMPTOM_HINT[id];
}

/** 一个作用域（一个 profile，或共享布局）里本插件状态的只读概况。 */
export interface DoctorScope {
  profile: string | null;
  stateDir: string;
  /** usage.json 的速览；`null` = 文件不在场（还没记过任何调用，不是故障）。 */
  usage: { versionKnown: boolean; days: number; events: number } | null;
  /** provider.json 的速览；`null` = 文件不在场（面板还没保存过开关/清单，不是故障）。 */
  provider: { versionKnown: boolean; enabled: boolean | null; enabledIds: number | null } | null;
  /** 在场但解析不了的文件名清单（含未知版本）。 */
  unreadable: string[];
}

/** 完整报告：每个 profile 一个作用域 + 共享布局 + 令牌在场性 + 症状。 */
export interface DoctorReport {
  dshHome: string;
  plugin: string;
  scopes: DoctorScope[];
  shared: DoctorScope | null;
  profiled: boolean;
  /** `MODELSCOPE_API_KEY` 环境变量是否在场（只报布尔，绝不报值）。 */
  tokenEnv: boolean;
  symptoms: { id: SymptomValue; hint: string }[];
}

/**
 * 读一个状态文件做速览：`kind: "raw"` = 解析出来了；`"unreadable"` = 文件在场
 * 但不是 JSON；`"absent"` = 不在场（面板还没记过，不是故障）。三者必须分开——
 * 旧的写法把「读不到」和「读到了但不是 JSON」一起吞进同一个 catch，再靠一次
 * stat 反推文件是否在场；多一个状态文件这套反推就要抄一遍。
 */
type StateFileRead =
  | { kind: "raw"; raw: unknown }
  | { kind: "unreadable" }
  | { kind: "absent" };

async function readStateFile(dir: string, file: string): Promise<StateFileRead> {
  let text: string;
  try {
    text = await readFile(join(dir, file), "utf8");
  } catch {
    // 不在场是常态；权限失败也归到这一支——doctor 只报它看得到的，不猜别的。
    return { kind: "absent" };
  }
  try {
    return { kind: "raw", raw: JSON.parse(text) };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * 把一个状态文件写进作用域：解析不出形状进 `unreadable`，解析得出就交给
 * `remember` 存速览，并额外标出「在场但版本不认」。两份文件的差别只在这两个
 * 回调上，其余判定（在场性、损坏、未知版本）是同一条路。
 */
async function inspectStateFile<T extends { versionKnown: boolean }>(
  dir: string,
  file: string,
  scope: DoctorScope,
  describe: (raw: unknown) => T | null,
  remember: (summary: T) => void
): Promise<void> {
  const read = await readStateFile(dir, file);
  if (read.kind === "absent") return;
  if (read.kind === "unreadable") {
    scope.unreadable.push(file);
    return;
  }
  const summary = describe(read.raw);
  if (summary === null) {
    scope.unreadable.push(file);
    return;
  }
  remember(summary);
  if (!summary.versionKnown) scope.unreadable.push(`${file} (unknown version)`);
}

/** 读一个作用域目录。调用方保证目录在场（profile 目录来自 readdir；共享布局先过 exists()）。 */
async function readScope(dir: string, profile: string | null): Promise<DoctorScope> {
  const scope: DoctorScope = { profile, stateDir: dir, usage: null, provider: null, unreadable: [] };
  await inspectStateFile(dir, "usage.json", scope, describeUsagePayload, (summary) => {
    scope.usage = summary;
  });
  await inspectStateFile(dir, "provider.json", scope, describeProviderPayload, (summary) => {
    scope.provider = summary;
  });
  return scope;
}

/**
 * state/ 下的合法 profile 段。两条排除，缺一不可：
 *   - `state/<plugin>/` 是共享（pre-profile）布局，目录名与 slug 同名——它是
 *     插件不是 profile，绝不能读回成 profile；
 *   - `$DSH_HOME/state/` 被所有已装插件共享，姊妹插件的扁平目录
 *     （`state/dsh-connect-sensenova-token-plan/`）同样是合法单段名。profile
 *     的识别形状是**嵌套**：`state/<profile>/<plugin>/`——不含本插件 state
 *     子目录的目录一律跳过（否则会把别的插件的状态用错误的解析器读一遍）。
 */
async function listProfiles(stateRoot: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(stateRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const profiles: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isProfileSegment(entry.name) || entry.name === name) continue;
    if (await exists(join(stateRoot, entry.name, name))) profiles.push(entry.name);
  }
  return profiles.sort();
}

/** Whether a path exists (any kind). */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 与 sensenova 同款的布局裁定：有 profile 目录就逐 profile 报；一个都没有时，
 * 共享布局目录**在场**才作为唯一作用域（目录不存在 = null，干净机器与
 * 「有目录但还没记录」因此可区分）。
 */
export async function diagnose(options: { dshHome?: string } = {}): Promise<DoctorReport> {
  const home = typeof options.dshHome === "string" && options.dshHome !== "" ? options.dshHome : defaultDshHome();
  const stateRoot = join(home, "state");
  const profiles = await listProfiles(stateRoot);
  const scopes = await Promise.all(profiles.map((profile) => readScope(join(stateRoot, profile, name), profile)));
  const sharedDir = join(stateRoot, name);
  const shared = profiles.length === 0 && (await exists(sharedDir)) ? await readScope(sharedDir, null) : null;
  const allScopes = shared === null ? scopes : [shared, ...scopes];
  return {
    dshHome: home,
    plugin: name,
    scopes,
    shared,
    profiled: profiles.length > 0,
    tokenEnv: typeof process.env.MODELSCOPE_API_KEY === "string" && process.env.MODELSCOPE_API_KEY.trim() !== "",
    symptoms: deriveSymptoms(allScopes)
  };
}

/**
 * 磁盘可证实的症状，声明顺序输出（同机两次运行必须同序）。
 * hintFor 是总函数：索引 SYMPTOM_HINT 直接得到 string（Record 键即联合），
 * 新 id 没补 hint 会编译失败，而不是运行时 undefined。
 */
export function deriveSymptoms(scopes: DoctorScope[]): { id: SymptomValue; hint: string }[] {
  const found = new Set<SymptomValue>();
  for (const scope of scopes) {
    if (scope.unreadable.length > 0) found.add(SYMPTOM.STATE_UNREADABLE);
  }
  return (Object.values(SYMPTOM) as SymptomValue[])
    .filter((id) => found.has(id))
    .map((id) => ({ id, hint: hintFor(id) }));
}

/** 人读行（非 --json 输出）。令牌只报在场性；凭据服务的令牌只有 Host 看得见。 */
export function renderReport(report: DoctorReport): string {
  const lines = [`dshHome: ${report.dshHome}`];
  const scopes = report.shared !== null ? [report.shared, ...report.scopes] : report.scopes;
  if (scopes.every((scope) => scope.usage === null && scope.provider === null && scope.unreadable.length === 0)) {
    lines.push(`no state under ${join(report.dshHome, "state")} (a clean machine, or the panel has not saved anything yet)`);
  }
  for (const scope of scopes) {
    const label = scope.profile === null ? "shared" : scope.profile;
    if (scope.usage === null && scope.provider === null && scope.unreadable.length === 0) {
      lines.push(`${label}: no usage.json, no provider.json (not recorded yet)`);
      continue;
    }
    if (scope.usage !== null) {
      const usage = scope.usage;
      lines.push(
        `${label}: usage.json — ${usage.days} day bucket(s), ${usage.events} event(s)` +
        (usage.versionKnown ? "" : " [UNKNOWN VERSION]")
      );
    }
    if (scope.provider !== null) {
      const provider = scope.provider;
      // switch 的三态要说清：not set 是「面板从没保存过」，off 是「保存了 false」。
      lines.push(
        `${label}: provider.json — switch ${provider.enabled === null ? "not set" : provider.enabled ? "on" : "off"}` +
        `, allow-list ${provider.enabledIds === null ? "not set" : `${provider.enabledIds} model(s)`}` +
        (provider.versionKnown ? "" : " [UNKNOWN VERSION]")
      );
    }
    for (const item of scope.unreadable) lines.push(`${label}: UNREADABLE: ${item}`);
  }
  lines.push(
    `token env (MODELSCOPE_API_KEY): ${report.tokenEnv ? "set" : "unset"}` +
    " — tokens held by the credentials service are only visible to the running Host; check the panel's Access tab."
  );
  if (report.symptoms.length === 0) {
    lines.push("symptoms: none (nothing on disk that needs explaining)");
  } else {
    for (const symptom of report.symptoms) lines.push(`symptom ${symptom.id}: ${symptom.hint}`);
  }
  return lines.join("\n");
}

/** CLI 入口：`node tools/doctor.mjs`（人读行）或 `--json`（机器可读报告）。 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<DoctorReport> {
  const report = await diagnose();
  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report));
  return report;
}
