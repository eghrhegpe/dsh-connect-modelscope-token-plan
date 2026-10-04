/**
 * `doctor` —— 只读回答「这台机器上，魔搭面板的数据在哪、坏了没有」。
 *
 * 与 sensenova 的 doctor 同形（`--json` 出机器可读报告、其余出人读行），按本
 * 插件的现实缩小：魔搭只有一个状态文件（usage.json）和一把静态令牌，没有
 * provider/draw/catalog 三件套，所以症状表只有一个 id。它不 import 任何 Host
 * peer，在干净 checkout 上即可运行；只读本插件自己的 state 目录，绝不写盘、
 * 绝不打印令牌值（env 只报在场性，凭据服务里的令牌只有运行中的 Host 看得见，
 * 报告会明说这一点）。与 sensenova 同款纪律：绝不读 `cordis.patch.yml`。
 *
 * 症状（symptom）只报**磁盘上可证实**的事，面板上人眼看到的问题引导去对应
 * 的 tab，不做无法从磁盘验证的断言：
 *   - `state-unreadable` —— usage.json 在场但本构建无法按它认识的样子解析：
 *     要么损坏（面板会有 shapeWarnings 且本地计数停写），要么是更新构建写的
 *     （版本只读闸已把本构建的写入挡住）。两种情况操作者都需要一句话的下一步。
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
import { describeUsagePayload } from "./usage-store.ts";

/** 症状 id 的单一声明（renderReport 与 --json 都从这里取值）。 */
export const SYMPTOM = Object.freeze({
  STATE_UNREADABLE: "state-unreadable"
});

export type SymptomValue = (typeof SYMPTOM)[keyof typeof SYMPTOM];

/** 每个症状的第一步动作。总函数：缺一条 hint 就过不了编译（见 deriveSymptoms）。 */
const SYMPTOM_HINT: Record<SymptomValue, string> = {
  [SYMPTOM.STATE_UNREADABLE]:
    "usage.json 无法按本构建认识的形状解析（损坏，或由更新构建写入）。" +
    "面板会显示 shapeWarnings 且本地计数已停写；升级插件后重试，或删除该文件重置（丢失历史计数）。"
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

/** 读一个作用域目录。调用方保证目录在场（profile 目录来自 readdir；共享布局先过 exists()）。 */
async function readScope(dir: string, profile: string | null): Promise<DoctorScope> {
  const scope: DoctorScope = { profile, stateDir: dir, usage: null, unreadable: [] };
  const file = join(dir, "usage.json");
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    const summary = describeUsagePayload(raw);
    if (summary === null) {
      scope.unreadable.push("usage.json");
    } else {
      scope.usage = summary;
      if (!summary.versionKnown) scope.unreadable.push("usage.json (unknown version)");
    }
  } catch {
    // 读不到 = 不在场（usage null，安静）；读到了但不是 JSON 也走这里，
    // 与「解析不出形状」同归 unreadable——但先确认文件真的在场。
    try {
      await stat(file);
      scope.unreadable.push("usage.json");
    } catch {
      // 文件不在场：还没记过调用，不是故障。
    }
  }
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
  if (scopes.every((scope) => scope.usage === null && scope.unreadable.length === 0)) {
    lines.push(`no usage state under ${join(report.dshHome, "state")} (a clean machine, or the panel has not recorded any probe yet)`);
  }
  for (const scope of scopes) {
    const label = scope.profile === null ? "shared" : scope.profile;
    if (scope.usage === null && scope.unreadable.length === 0) {
      lines.push(`${label}: no usage.json (not recorded yet)`);
      continue;
    }
    const usage = scope.usage;
    const summary = usage === null
      ? "unreadable"
      : `${usage.days} day bucket(s), ${usage.events} event(s)` + (usage.versionKnown ? "" : " [UNKNOWN VERSION]");
    lines.push(`${label}: usage.json — ${summary}`);
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
