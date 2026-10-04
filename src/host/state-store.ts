/**
 * 状态文件公共原语 —— 把本插件的各 store（usage-store）从
 * 各自手写的同一段"版本载荷 + temp 文件 + rename 原子 + 0600 + 损坏即忽略"
 * 收敛到这里（家规：peer-free、离线可测）。。
 *
 * 第二步收敛的是**读缓存**：provider / draw 早有 1s TTL，而 catalog 完全没有
 * （进程内永不失效）——同一个「两个进程共享一个 state 目录」的问题修了两个、
 * 漏了第三个。现在统一走 {@link createStateReadCache}，一个 TTL 三个调用方。
 *
 * peer-free 与四个 store 同纪律：不 import 任何 Host peer，纯 `node:fs`，
 * 离线可测（store.test.mjs 直接注入 dir 构造即可）。
 *
 * 行为约定（与本插件 store 的约定逐一对齐）：
 *   - 目录：`$DSH_HOME/state/<name>`——与 Host 自己的目录并列，而不是在
 *     `logs/`（trace 轮转会按日志清扫，状态文件不能跟着被扫走）。
 *   - 写：临时文件（0600，owner-only）→ `rename` 原子落位。**失败抛错**，
 *     是否吞错是各 store 的语义（usage-store 面对只读 Home 选择吞、
 *     provider 面板开关交给调用方的错误路径），原语不做决定。
 *   - 临时名：进程 + 时间戳 + 随机 UUID 后缀。固定临时名会让两个 Host 进程的
 *     写落到同一路径、互相 `rename` 掉对方写了一半的文件；同一进程同一毫秒的
 *     两次异步写也会撞名（`writeFile` 截断覆盖后一次 `rename` 静默丢写），
 *     随机后缀让每个 temp 路径唯一，`rename` 原子性借此成立（见 `temporaryOf`）。
 *     此前的写法曾只有进程 + 时间戳，同毫秒并发写会静默丢一条。
 *   - 读：缺失、不可读、非 JSON 一律返回 `null`——"损坏即忽略"的方向。是否
 *     缓存、缓存多久由 {@link createStateReadCache} 决定，不是每个 store 各自的
 *     即兴实现。
 *
 * @module dsh-connect-modelscope-token-plan/state-store
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { str } from "./util.ts";

/**
 * The DSH home: `$DSH_HOME` when the operator exported one, else `~/.dsh`.
 * @returns {string} the home directory.
 */
export function dshHome() {
  return str(process.env.DSH_HOME, join(homedir(), ".dsh"));
}

/**
 * Where this plugin keeps state: `$DSH_HOME/state/<name>`.
 * @param {string} name - the plugin's own state directory name
 *   (`host-config.ts`'s `name`).
 * @returns {string} the directory.
 */
export function stateDir(name: string) {
  return join(dshHome(), "state", name);
}

/**
 * 单个 profile 名的形态约束。它会直接成为磁盘路径的一段，所以这里按
 * **外部输入**处理，而不是信任 Host 给的值。
 *
 * 规则与它的用途一一对应：
 *   - 字符集限制（`[A-Za-z0-9._-]`）——排除路径分隔符与任何 traversal 形状；
 *   - 不以点开头——顺带排掉 `.` 与 `..` 这两个唯一能让单段路径逃逸的名字；
 *   - 长度上限——防超长目录名（Windows 路径上限、以及某些文件系统的 NAME_MAX）。
 *
 * 为什么不用白名单枚举已知 profile 名：集合是开放的（用户可以任意新建
 * profile，本插件不该认识它们），白名单会把新 profile 错判成"拿不到名字"。
 */
const PROFILE_SEGMENT_MAX = 64;
const PROFILE_SEGMENT_RE = /^(?!\.)[A-Za-z0-9._-]+$/;

/**
 * Is this string safe to use as ONE path segment?
 * @param {unknown} value - candidate profile name.
 * @returns {boolean} true when it survives {@link PROFILE_SEGMENT_RE}.
 */
export function isProfileSegment(value: unknown) {
  if (typeof value !== "string") return false;
  const name = value.trim();
  if (name === "" || name.length > PROFILE_SEGMENT_MAX) return false;
  return PROFILE_SEGMENT_RE.test(name);
}

/**
 * 当前这台 Host 跑在哪个 profile 下，取不到就返回 `null`。
 *
 * **怎么读它**：`ctx.get(name)` —— Cordis 自己的 "read a service without the
 * inject requirement" 入口，未提供时安静返回 `undefined`。注意**别用属性访问**
 * 去探：`ctx.profileContext` 会在服务缺失时**抛错**（`cannot get property
 * "profileContext" without inject`，cordis `lib/index.js:676`）——这是本插件
 * 实测踩到的，不是推测。`readOptionalService` 把两个入口都包了，属性访问只作为
 * 测试桩的兜底留在最后。
 *
 * **为什么不用 `inject` 声明它**：`inject` 里的是**硬依赖**（`lib/index.js:688`
 * 的报错文案就叫 "cannot get required service"），缺了 Cordis 根本不加载本插件。
 * 而 `profileContext` 在官方 runtime 里是**可选**的（`@linxin666/
 * dsh-client-ui-plugin-manager` 明确处理了"host 隐藏了它"的情形，
 * `dsh-better-sidebar` 同理）。把它变成硬依赖，会让那些主机上整个插件消失
 * （面板、额度、provider 全挂），代价远大于收益。
 *
 * **为什么不读 `DSH_PROFILE`**：在那个 runtime 里它是 OUTPUT 而非输入——由
 * `runProfile()` 派生给子进程（`dsh-shell-env` 做的事），"no runtime module
 * reads it to choose a profile"。手设或陈旧的值会把状态写进一个"这台 Host
 * 根本不读"的 profile。
 *
 * 取到 = 调用方据此分段；取不到 = **退回当前的全局路径**，行为零漂移。
 *
 * @param {object} [ctx] - the Cordis context the Host handed `apply()`.
 * @returns {string|null} the profile name, or `null` when unavailable/unsafe.
 */
export function profileSegment(ctx: { get?: (n: string) => unknown; reflect?: { get?: (n: string, strict?: boolean) => unknown }; [key: string]: unknown } | null | undefined) {
  if (ctx === null || typeof ctx !== "object") return null;
  const raw = readOptionalService(ctx, "profileContext");
  if (raw === null || typeof raw !== "object") return null;
  const name = (raw as { name?: unknown }).name;
  return isProfileSegment(name) ? String(name).trim() : null;
}

/**
 * 读一个**可选**服务，三种入口依次尝试。
 *
 * 1. `ctx.get(name)` —— Cordis 的官方无 inject 读法（`ReflectService.get`），也是
 *    `startSideEffects` 读可选 `settings` 服务用的同一入口。首选。
 * 2. `ctx.reflect.get(name, false)` —— 底层等价物，宿主未把 mixin 挂出来时用。
 * 3. `ctx[name]` 直接取属性 —— 手写测试桩的形状。**留在最后**：在真 Cordis 上
 *    访问一个未声明且未提供的服务会抛（`... without inject`），必须包着 try。
 *
 * 三者都拿不到就是"这台 Host 没有这个服务"，调用方据此降级；这里永不抛错，
 * 因为一个探测不到的可选服务不该让插件挂掉。
 * @param {object} ctx - the Cordis context.
 * @param {string} name - the service name.
 * @returns {unknown} the service value, or `undefined`.
 */
export function readOptionalService(ctx: { get?: (n: string) => unknown; reflect?: { get?: (n: string, strict?: boolean) => unknown }; [key: string]: unknown }, name: string): unknown {
  // `ctx.get` is Cordis's own "read a service without the inject requirement"
  // mixin (ReflectService.get) — the same entry `startSideEffects` already uses
  // for the optional `settings` service. It answers `undefined` for a service
  // this Host never provided.
  if (typeof ctx.get === "function") {
    try {
      return ctx.get(name);
    } catch {
      // Not every host publishes the mixin; fall through.
    }
  }
  const reflect = (ctx as { reflect?: { get?: (n: string, strict?: boolean) => unknown } }).reflect;
  if (reflect && typeof reflect.get === "function") {
    try {
      return reflect.get(name, false);
    } catch {
      // Ditto.
    }
  }
  // Last resort: a plain object (the hand-written test stubs). Reading a member
  // off a REAL Cordis context throws for undeclared services, which is why this
  // entry is last and guarded.
  try {
    return (ctx as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/**
 * Per-profile state directory: `$DSH_HOME/state/<profile>/<name>`.
 *
 * Which states use this and which keep {@link stateDir} is a deliberate split,
 * not an inconsistency — see PITFALLS §23. Briefly: the three switch-shaped
 * states (catalog / provider / draw) answer "what does THIS profile want", so
 * two profiles must not overwrite each other; the throttle answers "how long
 * did the upstream tell US to wait" and the credentials grant answers "who are
 * you", both of which are per-machine and are INTENDED to cross profiles.
 *
 * `profile` being `null` degrades to the shared directory, so every old host,
 * every test and every in-process construction behaves exactly as before.
 * @param {string} name - the plugin's own state directory name.
 * @param {string|null} [profile] - the profile name; `null` means shared.
 * @returns {string} the directory.
 */
export function profileStateDir(name: string, profile: string | null) {
  return profile ? join(dshHome(), "state", profile, name) : stateDir(name);
}

/**
 * Make the state directory exist (owner-only), created on demand.
 *
 * A read-only Home throws — callers wrap this in their own policy (the
 * throttle/catalog writers swallow it, the provider switch does not).
 * @param {string} dir - the state directory.
 * @returns {Promise<void>}
 */
export async function ensureStateDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * A unique temporary path per write.
 *
 * Two Host processes can share one state directory, so a fixed temp name would
 * let both writes land on the same path and each `rename` could move the
 * other's half-written file. A process-plus-clock suffix keeps concurrent
 * writers off each other; the RANDOM suffix then makes two writes from the
 * SAME process inside one millisecond distinct too — clock+pid alone collides
 * when two async state writes land in the same tick, and the second `writeFile`
 * truncates the first's half-written temp before its `rename`, silently losing
 * one write. The rename itself stays atomic per path.
 * @param {string} dir - the state directory.
 * @param {string} base - the final file name, e.g. `"throttle.json"`.
 * @param {() => number} [now] - clock source; injected by the tests.
 * @returns {string} `dir/<base>.<pid>.<now>.<uuid>.tmp`.
 */
export function temporaryOf(dir: string, base: string, now = Date.now) {
  return join(dir, `${base}.${process.pid}.${now()}.${randomUUID()}.tmp`);
}

/**
 * Write one state file atomically: a 0600 temporary file, then a rename.
 *
 * The payload string is written with a trailing newline, exactly as every
 * store wrote before this module existed. Failures PROPAGATE — the callers
 * decide whether a read-only Home breaks their flow.
 * @param {string} file - the final file path.
 * @param {string} payload - the serialized body (JSON text).
 * @param {{temporary: string}} options - the temp path to write first.
 * @returns {Promise<void>}
 */
export async function writeStateFile(file: string, payload: string, { temporary }: { temporary: string }) {
  await writeFile(temporary, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

/**
 * How long a parsed state file may be reused without going back to disk.
 *
 * Two Host processes share one state directory (see PITFALLS §22), so this is
 * the upper bound on "how stale this process's view can be" — long enough to
 * keep one poll self-consistent, short enough that a change made anywhere else
 * is picked up on the next tick rather than after a restart.
 */
export const STATE_READ_TTL_MS = 1000;

/**
 * 状态文件的短生命周期读缓存 —— 把 catalog / provider / draw 三个 store
 * 各自手写的「近期读过就不再读盘」收敛到这里（§22：两个 Host 进程共享同一
 * 个状态目录，缓存期就是「另一个进程的写入多久可见」的上界）。
 *
 * 为什么要有 TTL 而不是不缓存：每次轮询都重读一遍小 JSON 本身不贵，但快照
 * 聚合在一次请求内会多次问同一个 store（目录条目、允许清单、开关），缓存让
 * 一次请求内的答案自洽。为什么 TTL 必须短：超过了就是「另一个 profile 改了
 * 允许清单，本机要重启才看得见」——这正是 catalog-store 早前的形态（无 TTL，
 * 进程内永不失效），而现在三者共用一份 `ttlMs`。
 *
 * `null` 也是一个合法的缓存值（"文件不存在/损坏，读作无记录"），所以"从未
 * 读过"用 `undefined` 表示，两者不可混。
 *
 * peer-free，与其余原语同纪律（不 import Host peer、离线可测）。时钟与 TTL
 * 都可注入，便于测试把缓存推进过期。
 *
 * `inheritFrom` 是 §23 的一次性迁移缝：按 profile 分段后，本 profile 的新文件
 * 一开始并不存在，而旧版把值放在**所有 profile 共享**的目录里。给了它以后，
 * 读穿透发现自己的记录缺失时会去旧路径取一次、回填、再返回——**只尝试一次**
 * （`adopted` 标志），所以它不会变成每个 TTL 周期都多读一个文件。
 *
 * 为什么让缓存原语承担这件事，而不是在外面先跑一遍迁移脚本：迁移就有了时序，
 * 而"先迁移、再 seed"在 `apply()` 的同步构造里排不出确定顺序。挂在读穿透上
 * 则天然正确——任何读到"空"的地方都会自动拿到旧值，且与并发进程无关（读到
 * 同一份旧值、写同一份结果）。
 *
 * @template T
 * @param {() => Promise<T|null>} readThrough - 真正的读盘 + 解析；返回 `null` 表示无可用记录。
 * @param {object} [options]
 * @param {number} [options.ttlMs] - 缓存有效期，默认 {@link STATE_READ_TTL_MS}。
 * @param {() => number} [options.now] - 时钟源；测试注入。
 * @param {{read: () => Promise<T|null>, write: (value: T) => Promise<void>}|null} [options.inheritFrom]
 *   - 旧版共享布局（`read`）与把它回填到本 profile（`write`）；`null` = 不迁移。
 * @returns {{read: () => Promise<T|null>, remember: (value: T|null) => void}}
 */
export function createStateReadCache<T>(readThrough: () => Promise<T | null>, options: { ttlMs?: number; now?: () => number; inheritFrom?: { read: () => Promise<T | null>; write: (value: T) => Promise<void> } | null } = {}) {
  const { ttlMs = STATE_READ_TTL_MS, now = Date.now, inheritFrom = null } = options;
  // "never read" is `undefined` and "read, nothing stored" is `null` — the two
  // must not collapse into one type, so the annotation carries both.
  let cached: T | null | undefined = undefined;
  let cachedAt = 0;
  /** Whether the one-shot legacy adoption has already been attempted. */
  let adopted = false;

  /**
   * 读穿透：自己的记录优先；缺失且还有旧布局可继承时，取一次旧值并回填。
   * @returns {Promise<T|null>}
   */
  const load = async () => {
    const own = await readThrough();
    if (own !== null || inheritFrom === null || adopted) return own;
    // One shot, whatever the outcome: a machine with no legacy file should not
    // re-read it every TTL, and a value that reached memory has served its
    // purpose even if writing it back failed (a read-only Home).
    adopted = true;
    const inherited = await inheritFrom.read();
    if (inherited === null) return null;
    try {
      await inheritFrom.write(inherited);
    } catch {
      // Read-only Home, or another process won the race. The value still
      // serves this process for the rest of its life.
    }
    return inherited;
  };

  return {
    /**
     * 读值：TTL 内返回缓存，过期则穿透到 `load()`。
     * @returns {Promise<T|null>}
     */
    async read() {
      if (cached !== undefined && now() - cachedAt < ttlMs) return cached;
      cached = await load();
      cachedAt = now();
      return cached;
    },
    /**
     * 写路径用：把刚写入的值直接放进缓存，省掉下一次读盘，并保证自己的写入
     * 立刻对自己可见（不必等 TTL）。语义与 `read()` 一致，只是来源可信。
     * @param {T|null} value - 刚写入并解析后的值。
     * @returns {void}
     */
    remember(value: T | null) {
      cached = value;
      cachedAt = now();
    }
  };
}

/**
 * Read a state file as JSON, or `null` when it is absent, unreadable, or not
 * JSON. Anything unrecognised reads as "nothing stored" — the safe direction
 * for every consumer (one extra attempt / one re-fetch / the config default
 * rules again), never a crash.
 * @param {string} file - the file path.
 * @returns {Promise<unknown>} the parsed value, or `null`.
 */
export async function readStateJson(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read the persisted `version` field of one state file, or `null` when it is
 * absent, unreadable, non-JSON, or carries no numeric `version`.
 *
 * This is the ADR-006 write-side guard's probe: a writer must know what it is
 * about to overwrite. "No version" is the same as "no record" (nothing to
 * protect), while a NUMERIC version this build does not recognise means the
 * file was written by a NEWER build and must not be clobbered.
 *
 * Kept apart from `readStateJson` on purpose: the guard needs the version even
 * when the rest of the payload is unparseable, and it must not depend on any
 * store's parse semantics.
 * @param {string} file - the state file path.
 * @returns {Promise<number|null>} the persisted version, or `null`.
 */
export async function readStateVersion(file: string): Promise<number | null> {
  const raw = await readStateJson(file);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const version = (raw as Record<string, unknown>).version;
  return typeof version === "number" ? version : null;
}

/**
 * Whether a writer may proceed given the version currently on disk.
 *
 * `null` (no file / no version) is always safe to write. A numeric version is
 * safe only when this build declares it known — anything else is a NEWER build
 * that this build cannot read, so the write must be refused.
 * @param {number|null} version - the on-disk version, from {@link readStateVersion}.
 * @param {readonly number[]} known - the versions this build understands.
 * @returns {boolean} true when writing may proceed.
 */
export function isKnownStateVersion(version: number | null, known: readonly number[]): boolean {
  return version === null || known.includes(version);
}
