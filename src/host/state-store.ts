/**
 * 状态文件公共原语。**TL;DR**：本文件只做四件事——`dshHome`/`stateDir`（定位
 * 状态目录）、`profileSegment`（按 profile 分段路径）、{@link createStateReadCache}
 * （统一读缓存）、以及写侧三件套（{@link createStateWriteQueue} 写串行化 /
 * {@link guardStateWrite} ADR-006 写守卫 / {@link stateVersionNote} 读侧版本说明）。
 * 其余一切遵守下方「行为约定」。
 *
 * 把本插件各 store（usage-store / provider / draw）各自手写的同一段
 * "版本载荷 + temp 文件 + rename 原子 + 0600 + 损坏即忽略" 收敛到这里。
 * 家规：peer-free（不 import 任何 Host peer，纯 `node:fs`）、离线可测
 * （store.test.mjs 直接注入 dir 构造即可）。
 *
 * 行为约定（与本插件 store 的约定逐一对齐）：
 *   - 目录：`$DSH_HOME/state/<name>`——与 Host 自己的目录并列，而不是在
 *     `logs/`（trace 轮转会按日志清扫，状态文件不能跟着被扫走）。
 *   - 写：临时文件（0600，owner-only）→ `rename` 原子落位。**失败抛错**，
 *     是否吞错是各 store 的语义（usage-store 面对只读 Home 选择吞、
 *     provider 面板开关交给调用方的错误路径），原语不做决定。
 *   - 临时名：进程 + 时间戳 + 随机 UUID 后缀。随机后缀让每个 temp 路径唯一，
 *     `rename` 原子性借此成立（见 `temporaryOf`）。
 *   - 读：缺失、不可读、非 JSON 一律返回 `null`——"损坏即忽略"的方向。是否
 *     缓存、缓存多久由 {@link createStateReadCache} 决定，不是每个 store 各自的
 *     即兴实现。
 *
 * ## 演变记录（历史，非契约）
 * 1. 第一步收敛的是上述「版本载荷 + 临时文件 + 原子落位」；临时名此前只有
 *    进程 + 时间戳，同毫秒并发写会静默丢一条，故加随机后缀。
 * 2. 第二步收敛的是**读缓存**：provider / draw 早有 1s TTL，而 catalog 完全
 *    没有（进程内永不失效）——同一个「两个进程共享一个 state 目录」的问题修了
 *    两个、漏了第三个。现在统一走 {@link createStateReadCache}，一个 TTL 三个调用方。
 * 3. 第三步收敛的是**写侧三件套**。这三个 store 曾各自手写：provider 有
 *    writeChain、usage 有 writeChain、draw **两个都没有**（并发保存丢一次、
 *    磁盘 version 比本构建新时降级覆写、读侧静默读作「没设过」——2026-10-17
 *    实测复现，正是 provider-store 注释里记着「咬过三次」的那类漂移的第四条）。
 *    现在三件套各有一份公共实现：串行化是{@link createStateWriteQueue}、写守卫是
 *    {@link guardStateWrite}、读侧说明是{@link stateVersionNote}；provider /
 *    usage / draw 三个 store 都是调用方，不再各写一遍。
 * 4. 第四步删掉了{@link createStateReadCache} 的 `inheritFrom`——一个从未被
 *    任何 store 使用、且写回路径绕过写队列的迁移缝（死代码 + 有害形状 +
 *    文档误导三合一，裁定见该函数的说明）；同时把{@link writeStateFile} 的
 *    临时文件清理从「rename 失败」一条路扩大到**任何**失败路径。
 *
 * @module dsh-connect-modelscope-token-plan/state-store
 */
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { degrade, errMsg, redactSecrets, str } from "./util.ts";

/**
 * DSH 主目录：操作者导出了 `DSH_HOME` 就用它，否则回落到 `~/.dsh`。
 * @returns {string} 主目录。
 */
export function dshHome() {
  return str(process.env.DSH_HOME, join(homedir(), ".dsh"));
}

/**
 * 本插件存放状态的位置：`$DSH_HOME/state/<name>`。
 * @param {string} name - 插件自己的状态目录名（即 `host-config.ts` 的 `name`）。
 * @returns {string} 目录路径。
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
 * 该字符串能否安全地作为**一个**路径段使用？
 * @param {unknown} value - 候选 profile 名。
 * @returns {boolean} 通过 {@link PROFILE_SEGMENT_RE} 即为 true。
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
 * @param {object} [ctx] - Host 交给 `apply()` 的 Cordis context。
 * @returns {string|null} profile 名，取不到或不安全时为 `null`。
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
 * not an inconsistency. Briefly: the three switch-shaped
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
/**
 * 写一个状态文件：一个 0600 临时文件，然后 rename。
 *
 * 载荷串以换行结尾，与本模块存在前每个 store 的写法一致。失败**向上传播** ——
 * 调用方自己决定只读 Home 要不要吞（throttle/catalog 吞，provider 开关不吞）。
 *
 * ## 任何一步失败都要清掉临时文件
 *
 * `rename` 会失败，而最常见的原因是 Windows 上目标文件正被另一个进程/编辑器
 * 占着（EACCES/EPERM）。临时文件此前**留在原地**：名字是
 * `<base>.<pid>.<ts>.<uuid>.tmp`，每次失败多一个，于是
 * `state/<profile>/<name>/` 慢慢堆满垃圾，而没有任何代码会去清它们（全仓原本
 * 无任何 unlink）。第一次修只补了 rename 失败那一条路；`writeFile` 本身失败
 * （磁盘满）、`open` 失败、`handle.sync()` 失败（EIO）留下的半截临时文件照样
 * 堆——2026-10-18 改为：**try 覆盖到 rename 成功为止，catch 里删掉自己的临时
 * 文件再重抛**。清理失败不掩盖原始错误（那才是调用方要处理的），所以只
 * `catch {}`。
 *
 * @param {string} file - 最终文件路径。
 * @param {string} payload - 序列化后的正文（JSON 文本）。
 * @param {{temporary: string}} options - 先写哪个临时路径。
 * @returns {Promise<void>}
 */
export async function writeStateFile(file: string, payload: string, { temporary }: { temporary: string }) {
  try {
    await writeFile(temporary, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
    // 先把内容 fsync 到盘，再 rename。这是**崩溃一致性**（不是并发原子性，后者由
    // rename 本身保证）：没有它，断电/内核崩溃时 rename 可能把一个**空或半截**的
    // 文件立到目标路径上——而 parsePayload 对损坏文件是「读作未设置」静默降级的，
    // 于是用户看到的是「模型清单/历史计数全没了」而没有任何错误。
    //
    // 代价是真机上每次几毫秒（实测 tmpfs 上 0.07ms，机械盘/容器 overlay 上更贵）。
    // 这值得：`usage.json` 每次对话都写、`provider.json` 每次点开关都写——**都不是
    // 低频操作**，而丢一次用户的允许清单意味着要重勾一遍。
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    // 自己的临时文件，不留垃圾。unlink 失败（权限/并发）不该盖掉真实原因。
    try {
      await unlink(temporary);
    } catch {
      // 已被别的进程清掉，或压根不存在：无可做。
    }
    throw error;
  }
}

/**
 * How long a parsed state file may be reused without going back to disk.
 *
 * Two Host processes share one state directory, so this is
 * the upper bound on "how stale this process's view can be" — long enough to
 * keep one poll self-consistent, short enough that a change made anywhere else
 * is picked up on the next tick rather than after a restart.
 */
export const STATE_READ_TTL_MS = 1000;

/**
 * 状态文件的短生命周期读缓存 —— 把 catalog / provider / draw 三个 store
 * 各自手写的「近期读过就不再读盘」收敛到这里（两个 Host 进程共享同一个状态
 * 目录，缓存期就是「另一个进程的写入多久可见」的上界）。
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
 * ## 这个原语为什么不负责 legacy 继承
 *
 * 一次性迁移缝（profile 分段前写在**共享**目录里的状态 → 本 profile 目录）曾经
 * 作为 `inheritFrom` 选项住在这里，2026-10-18 删除，三个原因叠在一起：
 *   - **死代码**：四个 store 无一带它（`grep -rn inheritFrom src/` 只命中本文件
 *     自己的声明；实际继承是 provider-store 在读穿透闭包里手写的）；
 *   - **有害形状**：它的写回是**读路径内直接触发的写**，不经本 store 的写队列
 *     ——那正是 provider-store 注释里记着「咬过三次」的竞态形状：继承写与并发
 *     的用户保存竞争，而继承只发生一次，被盖掉的那次保存是**永久**丢失的；
 *   - **文档误导**：本文件与 provider-store 的注释都把继承描述成走这个缝，
 *     实为两处手写，读者会以为它是共享基础设施。
 * 现在 provider / usage-prefs 各自在读穿透闭包里手写继承，并把回填排进**自己
 * 的写队列**（裁定在各自头注）。新 store 要继承时照那个形状写，**不要**复活
 * 这个参数。
 *
 * @template T
 * @param {() => Promise<T|null>} readThrough - 真正的读盘 + 解析；返回 `null` 表示无可用记录。
 * @param {object} [options]
 * @param {number} [options.ttlMs] - 缓存有效期，默认 {@link STATE_READ_TTL_MS}。
 * @param {() => number} [options.now] - 时钟源；测试注入。
 * @returns {{read: () => Promise<T|null>, remember: (value: T|null) => void}}
 */
export function createStateReadCache<T>(readThrough: () => Promise<T | null>, options: { ttlMs?: number; now?: () => number } = {}) {
  const { ttlMs = STATE_READ_TTL_MS, now = Date.now } = options;
  // "never read" is `undefined` and "read, nothing stored" is `null` — the two
  // must not collapse into one type, so the annotation carries both.
  let cached: T | null | undefined = undefined;
  let cachedAt = 0;

  return {
    /**
     * 读值：TTL 内返回缓存，过期则穿透到 `readThrough()`。
     * @returns {Promise<T|null>}
     */
    async read() {
      if (cached !== undefined && now() - cachedAt < ttlMs) return cached;
      cached = await readThrough();
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
 * Read the persisted `version` field of one state file.
 *
 * This is the ADR-006 write-side guard's probe: a writer must know what it is
 * about to overwrite. Three outcomes, and the difference between the first two
 * is load-bearing:
 *
 *   - `null` — ABSENT (ENOENT), non-JSON, or carrying no numeric `version`.
 *     Nothing here the guard could protect, so a write belongs: a corrupt file
 *     must stay replaceable, or an operator would be stuck with it forever.
 *   - a number — the version on disk. One this build does not recognise was
 *     written by a NEWER build and must not be clobbered.
 *   - **throws** — the path EXISTS but could not be read (EACCES/EBUSY/EIO, or a
 *     directory sitting at the path). The guard must read that as "there is
 *     something here and I cannot see it", never as "nothing stored": collapsing
 *     it into `null` made the anti-clobber guard fail OPEN, so the very
 *     downgrade it exists to prevent came through that seam.
 *
 * Kept apart from `readStateJson` on purpose: the guard needs the version even
 * when the rest of the payload is unparseable, it must not depend on any store's
 * parse semantics, and it must NOT inherit the read path's deliberate "anything
 * unrecognised reads as not set" permissiveness — that permissiveness is right
 * for a reader and wrong for a writer.
 * @param {string} file - the state file path.
 * @returns {Promise<number|null>} the persisted version, or `null` when absent/unusable.
 * @throws when the path exists but cannot be read — callers must refuse to write.
 */
export async function readStateVersion(file: string): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    // ENOENT 是唯一「没有东西要保护」的 fs 错误（写是恢复手段）。其余一律抛给
    // 写守卫：readFile 的其它 errno 都意味着文件在那儿而我们看不见它。
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // 损坏 / 半截 JSON：没有可保护的版本号，允许覆盖（这也是操作者的恢复手段）。
    return null;
  }
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

/**
 * 写串行化队列——store 的「读-改-写必须排队」的那把链。
 *
 * 为什么这不是某个 store 的私事：三个 store（provider / usage / draw）各写过
 * 一份一模一样的 `let writeChain = Promise.resolve(...)`，而 draw 曾经**两份都
 * 没有**——并发 `saveEnabled(true)` + `saveModelId(...)` 各自读到同一个 current，
 * 后写的赢，前一次保存被整个丢掉（2026-10-17 实测：落盘只剩其中一个字段）。
 * provider-store 的注释记着这类漂移「咬过三次」，draw 是第四条。抽到这里，
 * 第四个 store 起只需调用，没有「再手写一遍」这个选项。
 *
 * 语义（与 provider / usage 此前的私有实现逐字一致）：
 *   - `task` 在上一个任务落幕后才起动，临界区内重新读盘（基线不来自 TTL 缓存）；
 *   - **调用方拿到的是 `run` 本身**——拒绝照旧传播（provider 的 `save()` 要抛给
 *     路由、usage 的 `recordCall()` 也要抛），因为吞掉失败是调用方的语义决定；
 *   - 链自己吞掉失败继续走：一次只读 Home 上的写失败不该毒化后续所有保存。
 *
 * peer-free，与其余原语同纪律。
 * @returns {{
 *   enqueue: <T>(task: () => Promise<T>) => Promise<T>
 * }} 排队执行一次任务。
 */
export function createStateWriteQueue() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = chain.then(task);
      chain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }
  };
}

/**
 * ADR-006 写侧守卫：本构建读不懂的版本，不许覆盖。
 *
 * 磁盘上出现一个**本构建不认识的数字版本**，只可能是更新的构建写的；用一个旧
 * 载荷盖掉它，销毁的是我们根本看不见的数据（实测过一次 version 2 → 1 的降级
 * 覆写，110 次历史归零）。所以写入前先问盘，三种答案：
 *   - `null`（没有文件 / 没有版本 / 损坏）——没有什么可保护，写是恢复手段，放行；
 *   - 已知版本——放行；
 *   - 未知数字版本，或文件**在场却读不出来**（EACCES/EBUSY/EIO）——拒写。
 *     后者由 {@link readStateVersion} 抛出来（它只把 ENOENT 读作「没有文件」），
 *     这里接住并拒写：「读不到」不等于「没有东西要保护」。
 *
 * 拒写返回一句**已 degrade 记录**的原因（调用方决定要不要再抛给用户——provider
 * 的 save 抛、draw 的 saveEnabled 抛、usage 的 recordCall 静默 no-op），而不是
 * 静默 no-op： swallow the failure, not the reason。
 *
 * @param {string} file - 目标状态文件路径（消息里只取 basename）。
 * @param {readonly number[]} known - 本构建读得懂的版本集合。
 * @param {{label: string, logger?: {warn?: (m: string) => void}|undefined}} options -
 *   `label` 进拒绝消息的前缀（如 `"provider"` / `"draw-state"`）。`logger` 的
 *   `| undefined` 不是冗余：tsconfig 开了 `exactOptionalPropertyTypes`，而各 store
 *   解构出来的 `logger` 本身就带着 `undefined`（属性可选），不写这一半编译不过。
 * @returns {Promise<string|null>} 拒绝原因（已记日志），放行时为 `null`。
 */
export async function guardStateWrite(
  file: string,
  known: readonly number[],
  options: { label: string; logger?: { warn?: (message: string) => void } | undefined }
): Promise<string | null> {
  const base = basename(file);
  let existing: number | null;
  try {
    existing = await readStateVersion(file);
  } catch (error) {
    // 文件在那儿却读不出来（EACCES/EBUSY/EIO）：正是本守卫要拦的那类覆盖。
    const reason = `${options.label}: refusing to overwrite ${base} (cannot read it: ${redactSecrets(errMsg(error))})`;
    degrade(reason, null, options.logger, null);
    return reason;
  }
  if (!isKnownStateVersion(existing, known)) {
    const reason = `${options.label}: refusing to overwrite ${base} holding version ${existing} (this build knows ${known.join("/")})`;
    degrade(reason, null, options.logger, null);
    return reason;
  }
  return null;
}

/**
 * 读侧版本说明：磁盘上那份文件带着本构建读不懂的版本时，给操作者的一句话。
 *
 * 为什么读侧宽容还要说话：写侧守卫挡住了覆盖，读侧按设计把未知版本**宽容地**
 * 读作「没设过」——于是「保存的值被忽略」在面板上呈现成「从未保存过」。对
 * provider 的允许清单，这两者读出的方向是危险的（空清单 = 不过滤 = 提供全部
 * 模型）；对 draw 的开关，回退方向是 patch 默认（通常 = 关）。闸与说明是同一条
 * 承诺的两半，缺了哪半都静默。
 *
 * `consequence` 由调用方给：每个 store 知道自己「读作没设过」意味着什么，公共
 * 原语只负责把文件名、版本号、已知版本集合与下一步动作说全。
 *
 * @param {object} options
 * @param {string} options.label - 消息前缀（如 `"provider-state"`）。
 * @param {string} options.file - 状态文件路径（消息里只取 basename）。
 * @param {number} options.version - 盘上的版本号（调用方已判过是未知的）。
 * @param {readonly number[]} options.known - 本构建读得懂的版本集合。
 * @param {string} options.consequence - 「读作没设过」对这个 store 意味着什么。
 * @returns {string} 人读的一句警告。
 */
export function stateVersionNote(options: {
  label: string;
  file: string;
  version: number;
  known: readonly number[];
  consequence: string;
}): string {
  return (
    `${options.label}: ${basename(options.file)} holds version ${options.version}, which this build cannot read` +
    ` (this build knows ${options.known.join("/")}); ${options.consequence}` +
    " Upgrade this build to see the saved values, or delete the file to reset them."
  );
}
