import { _ as pluginError, a as resolveSettings, b as verbatim, c as LLM_DISPLAY_NAME, d as normalizeEntry, f as rosterWithAvailability, g as optional, h as obj, i as name, l as LLM_PROVIDER_ID, m as errMsg, n as inject, o as HIDE_ALL_MODELS, p as degrade, r as isAdmitted, t as PLUGIN_VERSION, v as redactSecrets, y as str } from "./host-config-DLJjmU6B.js";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

//#region src/host/ms-auth.ts
/**
* 魔搭访问令牌（`ms-…`）的存取——本插件唯一的凭据模块。
*
* 与姊妹插件的最大差异：**没有登录流**。没有 OIDC、没有密码、没有 refresh
* ——令牌是用户在魔搭个人中心（siteBase → 访问令牌）生成的一把静态钥匙，
* 过期/吊销只能由用户换新的。所以 sensenova 的整套 token-store（grant 续期、
* 节流、重登）在这里缩成一个「凭据引用的 resolve/save/forget」。
*
* 存储形态：凭据服务里的 **引用**（owner-only `~/.dsh/.credentials.yaml`），
* 引用名沿用本机已有的 `MODELSCOPE_API_KEY`——一个已存在的引用值，装上面板
* 即亮，零配置。kind 保持服务承认的 `api-key` 形（绝不发明私有 kind：那会让
* 凭据文件对整个 Host 不可解析，Host 直接起不来）。`process.env` 的
* `MODELSCOPE_API_KEY` 是回退。
*
* 读取优先级，每次 resolve 都重走一遍：凭据服务（面板保存的值必须立即生效）
* → 进程内存（无凭据服务的 Host）→ 环境。
*
* 令牌有效性检查（零额度探针：缺 `messages` 的请求预期 401 先于 400）属于
* probe 路由的职责，本模块只管存取与状态；SPIKE.md §结论 5 记录了该探针
* 尚待真机验证。
*
* @module dsh-connect-modelscope-token-plan/ms-auth
*/
/** 引用名：沿用本机凭据库里已存在的记录（README「三条事实」第 3 条）。 */
const TOKEN_REF = "MODELSCOPE_API_KEY";
/**
* 构造令牌 store。
* @param {object} [options] - wiring。
* @param {object|Function|null} [options.credentials] - `ctx.credentials` 服务
*   或其 resolver；**每次使用时解析**（服务可能在本插件挂载之后才注册，
*   一次性查找会把错误的 "ephemeral" 断言冻进后续每个轮询）。
* @param {object} [options.env] - 环境源；默认 `process.env`。
*/
function createTokenStore({ credentials = null, env = process.env } = {}) {
	/** 无凭据服务的 Host 的内存兜底。 */
	const memory = /* @__PURE__ */ new Map();
	const resolveService = () => {
		return (typeof credentials === "function" ? credentials() : credentials) ?? null;
	};
	return {
		/** 把面板输入的令牌存成引用；原样存（不 trim），空白值视为没输入。 */
		async save(token) {
			const value = verbatim(token, "");
			if (typeof value !== "string" || value.trim() === "") throw new Error("a ModelScope token is required");
			const service = resolveService();
			if (service !== null && typeof service.set === "function") {
				await service.set(TOKEN_REF, value);
				memory.set(TOKEN_REF, value);
			} else memory.set(TOKEN_REF, value);
		},
		/**
		* 忘掉面板保存的令牌。env 回退**不动**——清面板引用不能删操作者的 .env。
		*/
		async forget() {
			memory.delete(TOKEN_REF);
			try {
				const service = resolveService();
				if (service !== null && typeof service.unset === "function") await service.unset(TOKEN_REF);
			} catch {}
		},
		/**
		* 解析当前令牌与来源。返回类型显式注解：这是快照 TokenStatus.source
		* 联合类型的上游，靠推断会把字面量联合拓宽成 string。
		* @returns {Promise<{value: string, source: ("credentials"|"memory"|"env"|null)}>}
		*/
		async resolve() {
			try {
				const service = resolveService();
				if (service !== null && typeof service.resolve === "function") {
					const resolved = await service.resolve(TOKEN_REF).catch(() => void 0);
					const value = verbatim(resolved?.value, "");
					if (typeof value === "string" && value.trim() !== "") return {
						value,
						source: "credentials"
					};
				}
			} catch {}
			const held = memory.get(TOKEN_REF);
			if (typeof held === "string" && held.trim() !== "") return {
				value: held,
				source: "memory"
			};
			const fromEnv = verbatim(env[TOKEN_REF], "");
			if (typeof fromEnv === "string" && fromEnv.trim() !== "") return {
				value: fromEnv,
				source: "env"
			};
			return {
				value: "",
				source: null
			};
		},
		/**
		* 无秘密的状态描述（快照与面板消费）。
		* `valid` 恒为 null：本模块不做有效性断言（零额度探针在 probe 路由，
		* 尚待真机验证后接入——SPIKE.md §结论 5）。
		*/
		async state() {
			const { source } = await this.resolve();
			return {
				present: source !== null,
				source: source === null ? "none" : source,
				valid: null,
				checkedAt: null,
				ephemeral: resolveService() === null
			};
		}
	};
}

//#endregion
//#region src/host/state-store.ts
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
/**
* The DSH home: `$DSH_HOME` when the operator exported one, else `~/.dsh`.
* @returns {string} the home directory.
*/
function dshHome() {
	return str(process.env.DSH_HOME, join(homedir(), ".dsh"));
}
/**
* Where this plugin keeps state: `$DSH_HOME/state/<name>`.
* @param {string} name - the plugin's own state directory name
*   (`host-config.ts`'s `name`).
* @returns {string} the directory.
*/
function stateDir(name) {
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
function isProfileSegment(value) {
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
function profileSegment(ctx) {
	if (ctx === null || typeof ctx !== "object") return null;
	const raw = readOptionalService(ctx, "profileContext");
	if (raw === null || typeof raw !== "object") return null;
	const name = raw.name;
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
function readOptionalService(ctx, name) {
	if (typeof ctx.get === "function") try {
		return ctx.get(name);
	} catch {}
	const reflect = ctx.reflect;
	if (reflect && typeof reflect.get === "function") try {
		return reflect.get(name, false);
	} catch {}
	try {
		return ctx[name];
	} catch {
		return;
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
function profileStateDir(name, profile) {
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
async function ensureStateDir(dir) {
	await mkdir(dir, {
		recursive: true,
		mode: 448
	});
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
function temporaryOf(dir, base, now = Date.now) {
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
async function writeStateFile(file, payload, { temporary }) {
	await writeFile(temporary, `${payload}\n`, {
		encoding: "utf8",
		mode: 384
	});
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
const STATE_READ_TTL_MS = 1e3;
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
function createStateReadCache(readThrough, options = {}) {
	const { ttlMs = STATE_READ_TTL_MS, now = Date.now, inheritFrom = null } = options;
	let cached = void 0;
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
		adopted = true;
		const inherited = await inheritFrom.read();
		if (inherited === null) return null;
		try {
			await inheritFrom.write(inherited);
		} catch {}
		return inherited;
	};
	return {
		/**
		* 读值：TTL 内返回缓存，过期则穿透到 `load()`。
		* @returns {Promise<T|null>}
		*/
		async read() {
			if (cached !== void 0 && now() - cachedAt < ttlMs) return cached;
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
		remember(value) {
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
async function readStateJson(file) {
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
async function readStateVersion(file) {
	const raw = await readStateJson(file);
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const version = raw.version;
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
function isKnownStateVersion(version, known) {
	return version === null || known.includes(version);
}

//#endregion
//#region src/host/codes.ts
/**
* 错误分类的单一真源（对齐姊妹插件的 codes.ts 纪律）。
*
* 魔搭的分类现实（SPIKE.md）：上游不带任何额度头，额度耗尽与每分钟限频都只
* 会以 429 + 文案出现，所以 429 的分诊是**按 body 文案**做的保守二分——
* QUOTA_EXCEEDED 快速失败不重试，RATE_LIMITED 交给调用方退避。分不清时归
* RATE_LIMITED（退避是两方向里更安全的那个）。
*
* @module dsh-connect-modelscope-token-plan/codes
*/
/** 面板按它分流的稳定码表。 */
const CODE = Object.freeze({
	CONFIG_ERROR: "config_error",
	NETWORK_ERROR: "network_error",
	TIMEOUT_ERROR: "timeout_error",
	AUTH_ERROR: "auth_error",
	RATE_LIMITED: "rate_limited",
	QUOTA_EXCEEDED: "quota_exceeded",
	UPSTREAM_ERROR: "upstream_error"
});
/**
* 把上游 HTTP 状态归类成稳定码。
*
* 401/403 → AUTH_ERROR（换令牌能修，绝不自动重试——魔搭没有锁号问题，
* 但重试一个坏令牌只会刷屏）；429 由调用方先走 {@link classifyRateLimit}
* 分诊，这里只兜底；5xx → UPSTREAM_ERROR；其余 → NETWORK_ERROR。
*/
function classifyStatus(status) {
	if (status === 401 || status === 403) return CODE.AUTH_ERROR;
	if (status === 429) return CODE.RATE_LIMITED;
	if (status >= 500) return CODE.UPSTREAM_ERROR;
	if (status >= 400) return CODE.UPSTREAM_ERROR;
	return CODE.NETWORK_ERROR;
}
/**
* 429 的文案分诊：quota（当日/单模型额度耗尽，重试无意义）vs rate_limit
* （每分钟限频，退避有用）。判据是**平台自己的语言**，单词命中即可；没有
* 文案或看不懂时归 rate_limit——退避是两个方向里更安全的默认。
*/
function classifyRateLimit(message) {
	const text = String(message).toLowerCase();
	return [
		"quota",
		"daily",
		"limit reached",
		"额度",
		"上限",
		"次数"
	].some((word) => text.includes(word)) ? "quota" : "rate_limit";
}
/**
* 解析 Retry-After（秒或 HTTP 日期）与平台文案里写明的等待时长。
* 上游声明多长就等多长，不截断也不放大；解析不出返回 null。
*/
function parseRetryAfterMs(headers, message) {
	const raw = headers?.get?.("retry-after") ?? null;
	if (typeof raw === "string" && raw.trim() !== "") {
		const seconds = Number(raw.trim());
		if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1e3);
		const date = Date.parse(raw);
		if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
	}
	const cn = String(message).match(/(\d+)\s*(秒|分钟|小时|天)/);
	if (cn) {
		const unit = cn[2] ?? "秒";
		const value = Number(cn[1]);
		const multiplier = unit === "分钟" ? 60 : unit === "小时" ? 3600 : unit === "天" ? 86400 : 1;
		if (Number.isFinite(value) && value > 0) return value * multiplier * 1e3;
	}
	return null;
}

//#endregion
//#region src/host/usage-store.ts
/**
* 本地用量存储——面板「额度」tab 的数据真源。
*
* 为什么存在：魔搭没有余额查询接口（SPIKE.md §结论 1），面板的「剩余」=
* 配置常数 − 本地计数。计数只可能来自**经本插件**的调用（probe 现在记、
* provider 注册以后也记同一入口），所以面板文案必须永远带着「本地推算，
* 仅统计经本插件的调用」。
*
* 持久化纪律（与姊妹插件同款）：`$DSH_HOME/state/[<profile>/]<name>/usage.json`
* —— 按 profile 分段（它回答的是「这个 profile 的调用吃了多少额度」，与
* catalog/provider 开关同侧；没有共享跨 profile 的理由）。原子写（0600 temp
* + rename）、损坏即忽略、版本守卫拒覆写未知版本。进程内 1s 读缓存让一次
* 快照聚合的多次问询自洽。
*
* 语义基线（wire.ts）：
* - 天桶缺失 = 该日本插件没有记录到调用 = 真实的 0，不是数据丢失；
* - models 的 `tokens` 可为 null（上游没给 usage 时），绝不把 null 写成 0；
* - 事件流有界（maxEvents）， Newest-first。
*
* peer-free：纯 node:fs，离线可测（注入 dir 即可，见 test/usage-store.test.mjs）。
*
* @module dsh-connect-modelscope-token-plan/usage-store
*/
/** 本地日期键（ quota 按天重置，以 Host 本地时区为准）。 */
function localDateKey(now) {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
const STATE_VERSION = 1;
const KNOWN_VERSIONS = [STATE_VERSION];
/** 解析并校验磁盘载荷；形状不对读作 null（损坏即忽略），并标记异常。 */
function parsePayload(raw) {
	if (raw === null) return {
		payload: null,
		anomaly: null
	};
	if (typeof raw !== "object" || Array.isArray(raw)) return {
		payload: null,
		anomaly: "usage-state: payload is not an object"
	};
	const source = raw;
	const version = source.version;
	if (typeof version !== "number" || !KNOWN_VERSIONS.includes(version)) return {
		payload: null,
		anomaly: `usage-state: unknown version ${String(version)}`
	};
	const days = {};
	const rawDays = source.days;
	if (rawDays !== void 0 && rawDays !== null) {
		if (typeof rawDays !== "object" || Array.isArray(rawDays)) return {
			payload: null,
			anomaly: "usage-state: days is not an object"
		};
		for (const [key, value] of Object.entries(rawDays)) if (value && typeof value === "object" && !Array.isArray(value)) {
			const bucket = value;
			days[key] = {
				calls: typeof bucket.calls === "number" && Number.isFinite(bucket.calls) ? bucket.calls : 0,
				tokens: typeof bucket.tokens === "number" && Number.isFinite(bucket.tokens) ? bucket.tokens : 0
			};
		}
	}
	const models = {};
	const rawModels = source.models;
	if (rawModels !== void 0 && rawModels !== null) {
		if (typeof rawModels !== "object" || Array.isArray(rawModels)) return {
			payload: null,
			anomaly: "usage-state: models is not an object"
		};
		for (const [key, value] of Object.entries(rawModels)) if (value && typeof value === "object" && !Array.isArray(value)) {
			const counter = value;
			models[key] = {
				calls: typeof counter.calls === "number" && Number.isFinite(counter.calls) ? counter.calls : 0,
				tokens: typeof counter.tokens === "number" && Number.isFinite(counter.tokens) ? counter.tokens : null,
				lastAt: typeof counter.lastAt === "string" ? counter.lastAt : null,
				day: typeof counter.day === "string" ? counter.day : "",
				dayCalls: typeof counter.dayCalls === "number" && Number.isFinite(counter.dayCalls) ? counter.dayCalls : 0,
				dayTokens: typeof counter.dayTokens === "number" && Number.isFinite(counter.dayTokens) ? counter.dayTokens : 0
			};
		}
	}
	const events = Array.isArray(source.events) ? source.events.filter((entry) => Boolean(entry) && typeof entry === "object" && typeof entry.at === "string" && typeof entry.modelId === "string" && typeof entry.kind === "string" && typeof entry.message === "string") : [];
	return {
		payload: {
			version: STATE_VERSION,
			days,
			models,
			events
		},
		anomaly: null
	};
}
/**
* 构造文件用量 store。
* @param {object} options
* @param {string} options.name - 插件 slug（状态目录名，来自 host-config）。
* @param {string|null} [options.profile] - profile 名；null = 共享目录。
* @param {number} [options.trendDays] - 天桶保留数（超出修剪；从配置注入，
*   让「配置改小」在下次写入时生效，而不是等一个固定的内部常数）。
* @param {number} [options.maxEvents] - 事件流上限。
* @param {() => Date} [options.now] - 时钟源；测试注入。
* @param {{warn?: (message: string) => void}} [options.logger] - ctx.logger。
*/
function createFileUsageStore({ name, profile = null, trendDays = 14, maxEvents = 50, now = () => /* @__PURE__ */ new Date(), logger }) {
	const dir = profileStateDir(name, profile);
	const file = join(dir, "usage.json");
	/** 最近一次解析异常（损坏即忽略的痕迹），快照转 shapeWarnings。 */
	let anomaly = null;
	/** 只读闸：磁盘版本比本构建新时置位——读照常、写拒绝，绝不 clobber。 */
	let readOnly = false;
	/** 最近一次确认过的内存态；读路径拿它，写路径以它为基线。 */
	let current = {
		version: STATE_VERSION,
		days: {},
		models: {},
		events: []
	};
	let loaded = false;
	/** 写串行化：读-改-写必须排队，两个并发 recordCall 不能互相覆盖。 */
	let writeChain = Promise.resolve();
	/** 读盘（缓存穿透）；返回 null = 无记录或损坏。 */
	const readThrough = async () => {
		const onDisk = await readStateVersion(file);
		if (onDisk !== null && !isKnownStateVersion(onDisk, KNOWN_VERSIONS)) {
			anomaly = `usage-state: on-disk version ${onDisk} is newer than this build knows`;
			readOnly = true;
			logger?.warn?.(`${name}: ${anomaly} — recording disabled to avoid clobbering`);
			return null;
		}
		const parsed = parsePayload(await readStateJson(file));
		anomaly = parsed.anomaly;
		if (parsed.anomaly !== null) logger?.warn?.(`${name}: ${parsed.anomaly} — starting from empty`);
		return parsed.payload;
	};
	const cache = createStateReadCache(readThrough, { now: () => Date.now() });
	/** 把内存态写盘（原子），失败不抛——计数是尽力而为的观测，不是事务。 */
	const persist = async (payload) => {
		await ensureStateDir(dir);
		await writeStateFile(file, JSON.stringify(payload), { temporary: temporaryOf(dir, "usage.json") });
		cache.remember(payload);
	};
	/** 排队执行一次读-改-写；只读闸置位时整个变更是 no-op。 */
	const enqueue = (mutate) => {
		const run = writeChain.then(async () => {
			if (readOnly) return;
			const payload = (loaded ? current : await cache.read() ?? null) ?? {
				version: STATE_VERSION,
				days: {},
				models: {},
				events: []
			};
			mutate(payload);
			current = payload;
			loaded = true;
			await persist(payload);
		});
		writeChain = run.catch(() => {});
		return run;
	};
	/** 修剪：只留最近 trendDays 个天桶（按 dateKey 排序，今天不删）。 */
	const pruneDays = (payload, todayKey) => {
		const keep = new Set(Object.keys(payload.days).sort().slice(-Math.max(1, trendDays)));
		keep.add(todayKey);
		for (const key of Object.keys(payload.days)) if (!keep.has(key)) delete payload.days[key];
	};
	return {
		/** 记一次调用（今天 +1；模型计数跨日清零；tokens 可为 null）。 */
		async recordCall({ modelId, tokens = null, at = now() }) {
			if (typeof modelId !== "string" || modelId.trim() === "") throw pluginError(CODE.CONFIG_ERROR, "recordCall: modelId is required");
			const dayKey = localDateKey(at);
			await enqueue((payload) => {
				const day = payload.days[dayKey] ?? {
					calls: 0,
					tokens: 0
				};
				day.calls += 1;
				if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) day.tokens += tokens;
				payload.days[dayKey] = day;
				const counter = payload.models[modelId] ?? {
					calls: 0,
					tokens: null,
					lastAt: null,
					day: dayKey,
					dayCalls: 0,
					dayTokens: 0
				};
				if (counter.day !== dayKey) {
					counter.day = dayKey;
					counter.dayCalls = 0;
					counter.dayTokens = 0;
				}
				counter.calls += 1;
				counter.dayCalls += 1;
				if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
					counter.tokens = (counter.tokens ?? 0) + tokens;
					counter.dayTokens += tokens;
				}
				counter.lastAt = at.toISOString();
				payload.models[modelId] = counter;
				pruneDays(payload, dayKey);
			});
		},
		/** 记一条事件（429/错误），Newest-first，截断到 maxEvents。 */
		async recordEvent({ modelId, kind, message, at = now() }) {
			await enqueue((payload) => {
				payload.events = [{
					at: at.toISOString(),
					modelId: String(modelId),
					kind,
					message: String(message).slice(0, 500)
				}, ...payload.events].slice(0, maxEvents);
			});
		},
		/** 今天（本地时区）的账户级计数；没有任何记录时是 0，不是 null。 */
		async daily() {
			const day = (await cache.read())?.days[localDateKey(now())] ?? null;
			return day === null ? {
				dateKey: localDateKey(now()),
				calls: 0,
				tokens: 0
			} : {
				...day,
				dateKey: localDateKey(now())
			};
		},
		/** 今天的单模型计数（只含有记录的模型，dayCalls/dayTokens 口径，均跨日清零）。 */
		async perModelToday() {
			const payload = await cache.read();
			const todayKey = localDateKey(now());
			const out = [];
			for (const [modelId, counter] of Object.entries(payload?.models ?? {})) {
				if (counter.day !== todayKey) continue;
				out.push({
					modelId,
					calls: counter.dayCalls,
					tokens: counter.dayTokens,
					lastAt: counter.lastAt
				});
			}
			out.sort((a, b) => b.calls - a.calls);
			return out;
		},
		/** 最近 N 天趋势（含今天；缺桶 = 该日 0 次，真实零不是数据丢失）。 */
		async trend(days = trendDays) {
			const payload = await cache.read();
			const out = [];
			const cursor = now();
			for (let offset = Number(days) - 1; offset >= 0; offset -= 1) {
				const date = new Date(cursor);
				date.setDate(date.getDate() - offset);
				const key = localDateKey(date);
				const bucket = payload?.days[key];
				out.push({
					dateKey: key,
					calls: bucket?.calls ?? 0,
					tokens: bucket?.tokens ?? 0
				});
			}
			return out;
		},
		/** 事件流（Newest-first，已截断）。 */
		async events() {
			return [...(await cache.read())?.events ?? []];
		},
		/** 最近一次解析异常（无异常为 null）——快照转 shapeWarnings。 */
		anomaly() {
			return anomaly;
		},
		/** 无秘密的状态（doctor 用）。 */
		async state() {
			const payload = await cache.read();
			return {
				file: profile === null ? join(stateDir(name), "usage.json") : file,
				hasRecord: payload !== null,
				days: Object.keys(payload?.days ?? {}).length,
				events: payload?.events.length ?? 0,
				readOnly
			};
		}
	};
}

//#endregion
//#region src/host/coalesced-fetch.ts
/**
* One coalescing read-through cache: a TTL cache plus ONE in-flight promise
* per key.
*
* Two properties every caller needs, and that are easy to get wrong when each
* fetch re-implements them by hand (as `console-client.ts` once did twice):
*
*   1. **Single flight** — N concurrent readers of one key share ONE upstream
*      call. Without it, every open panel (or tab) polling at once issues its
*      own request, which is how a Host walks into the platform's own rate
*      limiter.
*   2. **Read-through TTL** — a fresh answer is served from memory; a stale one
*      is refetched.
*
* A REJECTED producer is shared but never cached: a failure is not an answer,
* and caching one would pin an error on the panel for a whole TTL after a
* single transient hiccup. Sharing the rejection is still correct — the callers
* asked for the same thing at the same time and get the same outcome.
*
* The maps are injectable so a caller can share one cache across modules (the
* console route's `cache`/`inflight` pair is created in `index.ts` and cleared
* wholesale when the account or key changes).
*
* @module dsh-connect-modelscope-token-plan/coalesced-fetch
*/
/**
* The longest TTL any caller may use; entries older than this are swept so the
* map cannot grow without bound when keys are per-credential and credentials
* rotate.
*/
const MAX_CACHE_AGE_MS = 36e5;
/**
* The generation state for one shared cache map.
*
* Keyed by the cache MAP rather than held per instance, and that is load
* bearing: a caller may construct a fresh `createCoalescedFetch` on every
* request while injecting one long-lived shared map (which is exactly what
* `console-client.ts` does, over the `cache`/`inflight` pair created in
* `index.ts`). Per-instance counters would reset to 0 on every call, so a
* `clear()` bump would be invisible to the very next read and a pre-clear
* flight's answer would be served to the account that just signed in.
* Hanging the counters off the map makes every instance over that map share
* one generation state, so the guard holds no matter how the caller builds it.
*/
const GENERATIONS = /* @__PURE__ */ new WeakMap();
/** The (created-on-demand) generation state belonging to one cache map. */
function generationsOf(cache) {
	let state = GENERATIONS.get(cache);
	if (state === void 0) {
		state = {
			global: 0,
			keys: /* @__PURE__ */ new Map()
		};
		GENERATIONS.set(cache, state);
	}
	return state;
}
/**
* Drop one key's cached answer, or the whole cache, bumping generations.
*
* Exported separately from the instance so a caller that only owns the raw
* maps — the account and api-key routes, which must invalidate the console
* cache the moment the credential changes — can invalidate WITHOUT having to
* construct an instance first. It shares `generationsOf`, so an instance's own
* `clear()` and this function are the same operation.
* @param {Map<string, unknown>} cache - the cache map to drop from.
* @param {Map<string, Promise<unknown>>} inflight - its in-flight companion.
* @param {string} [key] - the key to drop; omit to drop everything.
* @returns {void}
*/
function clearCoalescedFetch(cache, inflight, key) {
	const gens = generationsOf(cache);
	if (key === void 0) {
		gens.global += 1;
		cache.clear();
		inflight.clear();
		gens.keys.clear();
		return;
	}
	gens.keys.set(key, (gens.keys.get(key) ?? gens.global) + 1);
	cache.delete(key);
	inflight.delete(key);
}
/**
* A coalescing read-through cache.
* @param {object} [options]
* @param {Map<string, {body: unknown, at: number, gen: number}>} [options.cache] -
*   an existing cache map to share; a fresh one is created when omitted.
* @param {Map<string, Promise<unknown>>} [options.inflight] - an existing
*   in-flight map to share.
* @param {number} [options.maxAgeMs] - the sweep ceiling.
* @returns {{
*   read: (key: string, producer: () => Promise<unknown>, ttlMs: number) => Promise<unknown>,
*   clear: (key?: string) => void
* }}
*/
function createCoalescedFetch(options = {}) {
	const { cache = /* @__PURE__ */ new Map(), inflight = /* @__PURE__ */ new Map(), maxAgeMs = MAX_CACHE_AGE_MS } = options;
	const gens = generationsOf(cache);
	const genOf = (key) => gens.keys.get(key) ?? gens.global;
	/** Drop entries past the sweep ceiling; called after every write. */
	const sweep = () => {
		const nowMs = Date.now();
		for (const [key, entry] of cache) if (nowMs - entry.at > maxAgeMs) cache.delete(key);
	};
	/**
	* Read one key through the cache, coalescing concurrent misses.
	* @param {string} key - the cache key (a URL, or a key carrying a
	*   credential fingerprint — see the raccoon route).
	* @param {() => Promise<unknown>} producer - what to call on a miss.
	* @param {number} ttlMs - how long an answer stays fresh (`0` = never
	*   reuse; the single-flight sharing still applies).
	* @returns {Promise<unknown>} the value.
	*/
	const read = async (key, producer, ttlMs) => {
		const cached = cache.get(key);
		if (cached !== void 0 && cached.gen === genOf(key) && Date.now() - cached.at < ttlMs) return cached.body;
		const pending = inflight.get(key);
		if (pending !== void 0) return pending;
		const born = genOf(key);
		const flight = (async () => {
			const body = await producer();
			cache.set(key, {
				body,
				at: Date.now(),
				gen: born
			});
			sweep();
			return body;
		})().finally(() => {
			if (inflight.get(key) === flight) inflight.delete(key);
		});
		inflight.set(key, flight);
		return flight;
	};
	/**
	* Drop one key's cached answer, or the whole cache.
	*
	* The drop bumps the key's (or the global) generation AND evicts the
	* in-flight map entry, so the NEXT read cannot join a pre-clear flight nor be
	* served a pre-clear cache entry — the previous identity's answer is gone for
	* good even when its producer was still in flight when the change happened.
	* In-flight calls themselves are NOT cancelled: a reader that already took a
	* flight's promise still settles with what it asked for; only NEW reads miss.
	* @param {string} [key] - the key to drop; omit to drop everything.
	* @returns {void}
	*/
	const clear = (key) => clearCoalescedFetch(cache, inflight, key);
	return {
		read,
		clear
	};
}

//#endregion
//#region src/host/inference-client.ts
/**
* 魔搭 API-Inference 的 HTTP 出口：模型目录（零额度）与 probe 调用。
*
* 两条纪律来自 SPIKE.md：
* - **上游不带额度头**——所以本模块只解析 status / body / Retry-After，
*   不假装能从响应里读到余额；
* - **models 免认证可读**——目录轮询走无凭据 GET，零额度成本，也因此
*   令牌变化不需要失效目录缓存（一个省掉整类失效 bug 的简化）。
*   （注释纪律：块注释里写以斜杠开头的路径必须用反引号包住，否则
*   「两个星号加斜杠」会把注释提前关掉——本次 typecheck 亲手踩的。）
*
* 429 分诊按 body 文案（codes.ts classifyRateLimit）：quota → 快速失败，
* rate_limit → 带 retryAfterMs 的退避。401/403 → AUTH_ERROR（换令牌能修，
* 调用方绝不自动重试）。所有错误经 pluginError 带稳定 code，消息过
* redactSecrets。
*
* @module dsh-connect-modelscope-token-plan/inference-client
*/
/**
* 有界并发 map：对 items 逐个跑 fn（异步），同时最多 limit 个在飞。
* 用于目录加载时并行拉取各模型详情端点，避免一次性打爆主站。
*/
async function mapWithConcurrency(items, limit, fn) {
	const results = new Array(items.length);
	let cursor = 0;
	async function worker() {
		while (cursor < items.length) {
			const i = cursor++;
			const item = items[i];
			if (item === void 0) continue;
			results[i] = await fn(item);
		}
	}
	const n = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: n }, () => worker()));
	return results;
}
/**
* 构造推理 client。
* @param {object} options
* @param {ResolvedSettings} options.settings - resolveSettings 的产物。
* @param {object} options.tokenStore - ms-auth 的 store（resolve() 取令牌）。
* @param {HostDeps} [options.deps] - 测试缝（fetchImpl）。
* @param {{warn?: (message: string) => void}} [options.logger] - ctx.logger。
*/
function createInferenceClient({ settings, tokenStore, deps = {}, logger }) {
	const doFetch = deps.fetchImpl ?? fetch;
	const { read } = createCoalescedFetch();
	/** 带超时的一次 fetch（AbortController；abort → TIMEOUT_ERROR）。 */
	const fetchWithTimeout = async (url, init) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), settings.inferenceTimeoutMs);
		try {
			return await doFetch(url, {
				...init,
				signal: controller.signal
			});
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw pluginError(CODE.TIMEOUT_ERROR, "modelscope request timed out");
			throw pluginError(CODE.NETWORK_ERROR, redactSecrets(errMsg(error)));
		} finally {
			clearTimeout(timer);
		}
	};
	/** 读响应 body 里的 OpenAI 错误文案（形状漂移时返回空串，不抛）。 */
	const readErrorMessage = async (response) => {
		try {
			const body = await response.json();
			const message = body?.error?.message ?? body?.message;
			return typeof message === "string" ? message : "";
		} catch {
			return "";
		}
	};
	/**
	* 单个模型的详情端点任务标签（modelscope.cn/api/v1/models/{id}）。
	* 免认证 GET，零推理额度（实测匿名 200）。返回 `Data.Tasks[].Name`（+
	* `widgets[].task` 兜底）去重后的标签数组；任意失败 / 非预期形状返回空数组，
	* 调用方据此回退策展清单 + 名字启发。
	*/
	const fetchTaskTags = async (id) => {
		const detailUrl = settings.siteBase + "/api/v1/models/" + encodeURI(id);
		const response = await fetchWithTimeout(detailUrl, {
			method: "GET",
			headers: { accept: "application/json" }
		});
		if (!response.ok) return [];
		const json = await response.json().catch(() => null);
		if (json === null || typeof json !== "object" || json.Code !== 200) return [];
		const data = json.Data ?? {};
		const tasks = [];
		for (const t of Array.isArray(data.Tasks) ? data.Tasks : []) {
			const name = str(t?.Name, "");
			if (name !== "") tasks.push(name);
		}
		for (const w of Array.isArray(data.widgets) ? data.widgets : []) {
			const task = str(w?.task, "");
			if (task !== "") tasks.push(task);
		}
		return Array.from(new Set(tasks));
	};
	return {
		/**
		* 模型目录：GET apiBase/models，免认证、零额度，coalesced 缓存
		* cacheSeconds。返回归一后的目录条目（entries，M4 用来建 descriptor）与
		* 派生的 id 列表（ids，旧消费方继续可用）——两条路线读同一份条目，不会漂移；
		* 形状漂移抛 UPSTREAM_ERROR 并带 detail。
		*/
		async fetchModels() {
			const url = settings.apiBase + "/models";
			return await read("models", async () => {
				const response = await fetchWithTimeout(url, { method: "GET" });
				if (!response.ok) {
					const message = await readErrorMessage(response);
					const code = classifyStatus(response.status);
					throw pluginError(code, redactSecrets("model catalog failed with HTTP " + String(response.status) + (message === "" ? "" : ": " + message)));
				}
				const json = await response.json().catch(() => null);
				if (json === null || typeof json !== "object" || json.object !== "list" || !Array.isArray(json.data)) throw pluginError(CODE.UPSTREAM_ERROR, "model catalog shape drifted (expected {object:'list', data:[...]})");
				const raws = json.data;
				const ids = raws.map((r) => str(r.id, "")).filter((id) => id !== "");
				const tagArrays = await mapWithConcurrency(ids, 6, (id) => fetchTaskTags(id).catch(() => []));
				const tagsById = /* @__PURE__ */ new Map();
				ids.forEach((id, i) => tagsById.set(id, tagArrays[i] ?? []));
				const entries = raws.map((raw) => {
					const id = str(raw.id, "");
					const tags = tagsById.get(id) ?? [];
					return normalizeEntry({
						...raw,
						tasks: tags.length > 0 ? tags : void 0
					});
				}).filter((entry) => entry.id !== "");
				return {
					entries,
					ids: entries.map((entry) => entry.id),
					fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
				};
			}, settings.cacheSeconds * 1e3);
		},
		/**
		* 官方「魔粒」余额：GET siteBase/openapi/v1/magicubes/balance（Bearer
		* 令牌；2026-10-04 实测可用，匿名 401，SPIKE.md §魔粒）。coalesced 缓存
		* cacheSeconds，缓存键带令牌指纹——换令牌 ≤1 个 TTL 内必然读到新身份。
		*/
		async fetchBalance() {
			const { value: token } = await tokenStore.resolve();
			if (token === "") throw pluginError(CODE.AUTH_ERROR, "no ModelScope token configured — set MODELSCOPE_API_KEY or save one in the panel");
			const url = settings.siteBase + "/openapi/v1/magicubes/balance";
			const key = "balance#" + token.slice(-6);
			return await read(key, async () => {
				const response = await fetchWithTimeout(url, {
					method: "GET",
					headers: {
						authorization: "Bearer " + token,
						accept: "application/json"
					}
				});
				if (!response.ok) {
					const message = await readErrorMessage(response);
					const code = classifyStatus(response.status);
					throw pluginError(code, redactSecrets("magicube balance failed with HTTP " + String(response.status) + (message === "" ? "" : ": " + message)));
				}
				const json = await response.json().catch(() => null);
				const data = json !== null && typeof json === "object" ? json.data : null;
				if (json === null || typeof json !== "object" || json.success !== true || data === null || typeof data !== "object") throw pluginError(CODE.UPSTREAM_ERROR, "magicube balance shape drifted (expected {success:true, data:{total_balance,available_balance,frozen_amount}})");
				const numOr = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
				const row = data;
				return {
					available: numOr(row.available_balance),
					total: numOr(row.total_balance),
					frozen: numOr(row.frozen_amount),
					fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
				};
			}, settings.cacheSeconds * 1e3);
		},
		/**
		* 一次 probe 调用。
		*
		* - usage：真调用（1 个 max_tokens 的 ping），**消耗 1 次免费额度**，
		*   换回 usage 计数——面板「测试一次调用」与计数演示的来源；
		* - validity：故意缺 messages 的请求，预期 401（令牌坏）先于 400
		*   （请求坏）返回，**零额度**鉴权探针（语义待真机回填，SPIKE.md）。
		*
		* 失败抛 pluginError；调用方（probe 路由）负责把它记进事件流。
		*/
		async probe({ modelId, kind }) {
			if (typeof modelId !== "string" || modelId.trim() === "") throw pluginError(CODE.CONFIG_ERROR, "probe: modelId is required");
			const { value: token } = await tokenStore.resolve();
			if (token === "") throw pluginError(CODE.AUTH_ERROR, "no ModelScope token configured — set MODELSCOPE_API_KEY or save one in the panel");
			const startedAt = Date.now();
			const payload = {
				model: modelId,
				stream: false
			};
			if (kind === "usage") {
				payload.messages = [{
					role: "user",
					content: "ping"
				}];
				payload.max_tokens = 1;
			}
			const response = await fetchWithTimeout(settings.apiBase + "/chat/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer " + token
				},
				body: JSON.stringify(payload)
			});
			const elapsedMs = Date.now() - startedAt;
			if (kind === "validity") {
				if (response.status === 401 || response.status === 403) {
					const message = await readErrorMessage(response);
					throw pluginError(CODE.AUTH_ERROR, redactSecrets(message === "" ? "token rejected (HTTP 401/403)" : message));
				}
				if (response.status === 429) {
					const message = await readErrorMessage(response);
					const retryAfterMs = parseRetryAfterMs(response.headers, message);
					throw pluginError(CODE.RATE_LIMITED, redactSecrets(message === "" ? "modelscope returned 429 (validity probe)" : message), retryAfterMs === null ? {} : { retryAfterMs });
				}
				if (response.status >= 500) throw pluginError(CODE.UPSTREAM_ERROR, "modelscope returned HTTP " + String(response.status) + " (validity probe)");
				return {
					ok: true,
					kind,
					status: response.status,
					modelId,
					usage: null,
					elapsedMs
				};
			}
			if (!response.ok) {
				const message = await readErrorMessage(response);
				if (response.status === 429) {
					const retryAfterMs = parseRetryAfterMs(response.headers, message);
					const triage = classifyRateLimit(message);
					const extra = retryAfterMs !== null && retryAfterMs !== void 0 ? { retryAfterMs } : {};
					throw pluginError(triage === "quota" ? CODE.QUOTA_EXCEEDED : CODE.RATE_LIMITED, redactSecrets(message === "" ? "modelscope returned 429 (probe on " + modelId + ")" : message), extra);
				}
				throw pluginError(classifyStatus(response.status), redactSecrets(message === "" ? "modelscope returned HTTP " + String(response.status) : message));
			}
			const json = await response.json().catch(() => null);
			const usage = json === null ? null : json.usage;
			const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
			return {
				ok: true,
				kind,
				status: response.status,
				modelId,
				usage: usage === void 0 || usage === null ? null : {
					promptTokens: positive(usage.prompt_tokens) ?? 0,
					completionTokens: positive(usage.completion_tokens) ?? 0,
					totalTokens: positive(usage.total_tokens) ?? 0
				},
				elapsedMs
			};
		}
	};
}

//#endregion
//#region src/host/provider-store.ts
/**
* The provider-registration switch AND its model allow-list — this plugin's OWN
* state file, never the Host's configuration.
*
* Why a file at all: `registerProvider` in `cordis.patch.yml` is a DEPLOYMENT
* default the operator edits with a reload, but the panel needs a live switch
* that takes effect on the next request. The switch state therefore lives in
* `$DSH_HOME/state/<plugin>/provider.json`, exactly like the plugin's other
* state stores (`usage-store.ts`): operational state, not an operator decision
* baked into the patch layer.
*
* The allow-list rides in the SAME file, not a second one: both fields answer
* "what does THIS profile want the provider to offer", so they must be read and
* written as one payload — two files (or two caches over one file) would let a
* switch flip clobber a list save that landed a tick earlier.
*
* Precedence at read time:
*
*   1. a value SAVED FROM THE PANEL (enabled: true|false, enabledIds: [...])
*      always wins;
*   2. no saved value (never touched, or the file was unreadable) falls back
*      to the patch's `registerProvider` for the switch, and to "no filter"
*      (empty list) for the allow-list.
*
* Integrity follows `state-store.ts`: a versioned payload, a temp file plus an
* atomic rename (two Host processes can share the directory), owner-only
* modes, and "anything unrecognised reads as not set" — a corrupted or
* downgraded file costs one re-toggle, never a crash.
*
* The allow-list's empty-vs-absent distinction is the one this module guards:
* an EMPTY list means "no filter, offer every model", while `HIDE_ALL_MODELS`
* (`llm-models.ts`) is the caller-side sentinel for "offer nothing". Neither
* spelling is stored here as `null` — absence of a saved list reads as "no
* filter", which is the only safe default for a fresh install.
*
* @module dsh-connect-modelscope-token-plan/provider-store
*/
/** Shape version, bumped when the persisted form changes incompatibly. */
const PROVIDER_VERSION = 1;
/**
* Every persisted shape THIS build can read: the current version plus any
* historical ones. Bumping {@link PROVIDER_VERSION} means adding the new number
* here too — otherwise this build would refuse its own newest files.
*
* This is the ADR-006 write-side guard's whitelist: an on-disk version not in
* this list was written by a NEWER build, and must not be clobbered (see
* {@link writePayload}).
*/
const KNOWN_PROVIDER_VERSIONS = [1];
/**
* The directory this plugin's state lives in — per-profile when the Host names
* one, shared otherwise (PITFALLS §23). Unlike the THROTTLE, which is
* deliberately shared across profiles, this answers "does THIS profile want the
* provider registered" and must not be overwritten by the other profile's Host.
* @param {string|null} [profile] - the profile name; `null` means shared.
* @returns {string} the directory.
*/
function providerDir(profile) {
	return profileStateDir(name, profile);
}
/**
* Normalize an on/off switch: only booleans are real answers.
* @param {unknown} raw - the persisted or posted value.
* @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
*/
function normalizeEnabled(raw) {
	return typeof raw === "boolean" ? raw : null;
}
/**
* Normalize a persisted allow-list: an array of non-empty strings, de-duplicated
* and order-preserved. Anything else reads as "no saved list".
*
* The de-dup matters: the route publishes this list straight into
* `filterByEnabled`, and a list carrying one id twice would still filter
* correctly, but the snapshot echoes `enabledCount` off it — counting a
* duplicate twice is the kind of drift that takes a while to notice.
* @param {unknown} raw - the persisted or posted value.
* @returns {string[]|null} the list, or `null` when nothing usable.
*/
function normalizeEnabledIds(raw) {
	if (!Array.isArray(raw)) return null;
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of raw) {
		const id = typeof entry === "string" ? entry.trim() : "";
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}
/**
* The file-backed provider switch + allow-list.
* @param {object} [options]
* @param {string} [options.dir] - override the state directory (tests).
* @param {string|null} [options.profile] - the profile name; see {@link providerDir}.
* @param {number} [options.ttlMs] - how long a parsed payload may be reused
*   before disk is consulted again; defaults to {@link STATE_READ_TTL_MS}.
* @returns {object} the store.
*/
function createFileProviderStore(options = {}) {
	const { dir, profile = null, ttlMs = STATE_READ_TTL_MS, logger } = options;
	const stateDir$1 = dir ?? providerDir(profile);
	const filePath = join(stateDir$1, "provider.json");
	/**
	* Write one payload atomically to this file.
	*
	* The single writer for every caller (save / saveEnabledIds / forget / the
	* §23 legacy adoption) — several copies of this is exactly the drift this
	* module keeps getting bitten by.
	*
	* ADR-006 write-side guard: never overwrite a state file this build cannot
	* read. An unknown NUMERIC version means a NEWER build wrote it; clobbering
	* it destroys data we cannot even see. So the write is refused with a
	* `degrade` signal, not a silent no-op — the PITFALLS §37 discipline: swallow
	* the failure, not the reason.
	* @param {object} body - the JSON body to persist.
	* @returns {Promise<string|null>} the refusal reason when the write was
	*   refused (already `degrade`-logged), or `null` when it landed — the caller
	*   decides whether to surface the refusal to a user.
	*/
	const writePayload = async (body) => {
		const existing = await readStateVersion(filePath);
		if (!isKnownStateVersion(existing, KNOWN_PROVIDER_VERSIONS)) {
			const reason = `provider: refusing to overwrite provider.json holding version ${existing} (this build knows ${KNOWN_PROVIDER_VERSIONS.join("/")})`;
			degrade(reason, null, logger, null);
			return reason;
		}
		const temporary = temporaryOf(stateDir$1, "provider.json");
		await ensureStateDir(stateDir$1);
		await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary });
		return null;
	};
	const legacyFile = dir === void 0 && profile ? join(stateDir(name), "provider.json") : null;
	/** Read ONE payload off the disk, shape-checked. */
	const parsePayload = async () => {
		const raw = await readStateJson(filePath);
		const source = obj(raw);
		if (source.version !== 1) return {
			enabled: null,
			enabledIds: null
		};
		return {
			enabled: normalizeEnabled(source.enabled),
			enabledIds: normalizeEnabledIds(source.enabledIds)
		};
	};
	/**
	* Read one payload, then hand it to `write` — the read-modify-write that keeps
	* the switch and the list from clobbering each other. `undefined` keys in
	* `patch` mean "leave what is on disk alone", so a switch save cannot drop a
	* list save and vice versa.
	* @param {object} patch - `{ enabled?, enabledIds? }` to persist.
	* @param {boolean} [mergeEnabled] - keep the currently-stored switch value.
	* @returns {Promise<string|null>} the write refusal reason, or `null`.
	*/
	const patchPayload = async (patch, mergeEnabled) => {
		const current = await parsePayload();
		const body = {
			version: 1,
			...mergeEnabled ? current.enabled === null ? {} : { enabled: current.enabled } : patch.enabled === void 0 ? {} : { enabled: patch.enabled },
			...patch.enabledIds === void 0 ? {} : { enabledIds: patch.enabledIds },
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		return writePayload(body);
	};
	const cache = createStateReadCache(async () => {
		const own = await parsePayload();
		if (own.enabled !== null || own.enabledIds !== null || legacyFile === null) return own;
		const legacy = await parsePayloadFrom(legacyFile);
		if (legacy.enabled === null && legacy.enabledIds === null) return own;
		try {
			await writePayload({
				version: 1,
				...legacy.enabled === null ? {} : { enabled: legacy.enabled },
				...legacy.enabledIds === null ? {} : { enabledIds: legacy.enabledIds },
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
		} catch {}
		return legacy;
	}, { ttlMs });
	const read = () => cache.read();
	/**
	* The payload the callers actually read. The short-TTL cache's `read()` is
	* typed `Promise<T | null>` because it doubles as "never read" signalling for
	* the §23 legacy adoption; a provider payload is always an object, so the
	* `null` branch collapses here, in one place, rather than at every caller.
	* @returns {Promise<ProviderPayload>} the payload; `{enabled:null,enabledIds:null}` when nothing is stored.
	*/
	const readPayload = async () => await read() ?? {
		enabled: null,
		enabledIds: null
	};
	/** Read one payload off an explicit path (the legacy shared file). */
	const parsePayloadFrom = async (file) => {
		const raw = await readStateJson(file);
		const source = obj(raw);
		if (source.version !== 1) return {
			enabled: null,
			enabledIds: null
		};
		return {
			enabled: normalizeEnabled(source.enabled),
			enabledIds: normalizeEnabledIds(source.enabledIds)
		};
	};
	return {
		/**
		* The saved switch value.
		* @returns {Promise<boolean|null>} `null` = not set, fall back to config.
		*/
		async enabled() {
			return (await readPayload()).enabled;
		},
		/**
		* The saved model allow-list.
		* @returns {Promise<string[]>} the saved ids; an EMPTY list means "no
		*   filter, offer every model" (also the answer for a never-saved list).
		*/
		async enabledIds() {
			return (await readPayload()).enabledIds ?? [];
		},
		/**
		* Whether the panel has ever saved a value here.
		* @returns {Promise<boolean>}
		*/
		async isSet() {
			const payload = await readPayload();
			return payload.enabled !== null || payload.enabledIds !== null;
		},
		/**
		* Persist a switch value. The write is atomic (temp file + rename) so a
		* concurrent reader never sees a partial payload, and it PRESERVES the
		* saved allow-list.
		* @param {boolean} value - the new switch state.
		* @returns {Promise<void>}
		*/
		async save(value) {
			const enabled = normalizeEnabled(value);
			if (enabled === null) throw new TypeError("provider switch expects a boolean");
			const refusal = await patchPayload({ enabled }, true);
			if (refusal !== null) throw new Error(refusal);
			cache.remember({
				enabled,
				enabledIds: (await readPayload()).enabledIds ?? []
			});
		},
		/**
		* Persist the model allow-list, preserving the saved switch.
		* @param {string[]} ids - the ids to offer (empty = offer all).
		* @returns {Promise<void>}
		*/
		async saveEnabledIds(ids) {
			const list = normalizeEnabledIds(ids);
			if (list === null) throw new TypeError("provider allow-list expects an array of strings");
			const refusal = await patchPayload({ enabledIds: list }, true);
			if (refusal !== null) throw new Error(refusal);
			cache.remember({
				enabled: (await readPayload()).enabled ?? null,
				enabledIds: list
			});
		},
		/**
		* Forget the panel-saved values: the config default and "no filter" rule
		* again.
		* @returns {Promise<void>}
		*/
		async forget() {
			const refusal = await patchPayload({
				enabled: null,
				enabledIds: null
			}, false);
			if (refusal !== null) throw new Error(refusal);
			cache.remember({
				enabled: null,
				enabledIds: null
			});
		}
	};
}

//#endregion
//#region src/host/switch-precedence.ts
/**
* The single adjudicator for "panel-saved value vs config default" across
* every opt-in switch.
*
* Historically the rule was hand-copied at three call sites (the provider
* route, the models route, the draw route) in two look-alike dialects:
*
*   - the boolean switch: `(panel ?? config) === true` plus
*     `panel === null ? "config" : "panel"`;
*   - the model preference: `panel ?? config` plus the same source probe.
*
* A fourth dialect existed where no config default exists at all (the Raccoon
* switch — a profile without a saved value falls to `off` with no fallback),
* which is exactly the shape this module does NOT serve: that one has no
* config default to adjudicate against, so it is the caller's plain read.
*
* This module is peer-free and deliberately tiny: the whole point is that a
* switch can never again invent its own precedence dialect, and the source
* label (`panel` / `config`) always rides with the answer so the panel can
* say which side is in charge. `test/switch-precedence.test.mjs` pins the
* dialect so a new caller copying the shape is the odd one out.
*
* @module dsh-connect-modelscope-token-plan/switch-precedence
*/
/**
* Resolve the effective boolean switch: a panel-saved value always wins,
* otherwise the config default rules.
* @param {boolean|null} panel - the panel-saved value (`null` = never saved).
* @param {boolean} config - the patch-declared default.
* @returns {boolean} the effective switch.
*/
function resolveSwitchEnabled(panel, config) {
	return (panel ?? config) === true;
}
/**
* Where the effective value came from — the panel when it saved one, the
* config otherwise. Rides with every resolved answer so the panel can name
* the side in charge.
* @param {boolean|string|null} panel - the panel-saved value.
* @returns {"panel"|"config"}
*/
function switchSource(panel) {
	return panel === null ? "config" : "panel";
}

//#endregion
//#region src/host/publish-core.ts
/**
* The shared bones of a provider publisher — the parts that MUST NOT differ
* between upstreams, factored out so they cannot drift.
*
* The publisher (`provider-publish.ts` for the ModelScope provider) runs the
* same control plane: a publish queue, a `disposed` gate, and a single-point
* pair registration that doubles as the rollback path. Those three are
* load-bearing and pinned by tests (PITFALLS §18 for the queue, §19 for the
* register shape) — and the rollback is the worst place to discover a
* divergence, because it only runs once something has already failed. When
* they were written twice, keeping them in sync relied on comments in one file
* pointing at the other; here there is one copy.
*
* What is deliberately NOT shared: the publish GATE and the state shape. The
* ModelScope side decides from "switch on?" plus a persisted catalog and an
* allow-list, and restores `entries`/`enabledIds`/quota ids on a rollback;
* another provider's publisher decides from "switch on?" plus "is there a
* credential?" and restores its roster. That difference is real domain
* difference, and folding it into one parameterized state machine would make a
* publish unreadable — every reader would have to read the configuration to
* know what one does.
*
* Peer-free: touches no runtime peer.
*
* @module dsh-connect-modelscope-token-plan/publish-core
*/
/** The event a successful (re)registration emits so readers refresh. */
const ADAPTERS_UPDATED_EVENT = "llm/adapters-updated";
/** The error a publisher reports when the Host exposes no `llm` service. */
const NO_LLM_SERVICE_ERROR = "the Host exposes no llm registration service";
/** The shape check message both publishers raise on a bad factory result. */
const BAD_FACTORY_SHAPE_ERROR = "the adapter factory did not return { adapter, providerIds }";
/**
* A publish queue: every publish runs after all the ones in flight.
*
* Concurrent publishes are not hypothetical — a mount seed can still be
* mid-flight when the first panel poll publishes the catalog it just fetched,
* and a switch flip or a logout can land on top of either. Two publishes
* interleaving means the SLOWER one wins: it releases the pair the faster one
* registered and then registers its own, so the Host serves a stale (possibly
* empty) set while the snapshot reports the fresh one (PITFALLS §18).
*
* The chain is the same shape `token-store.ts` uses for `getToken`: no lock
* object, and a rejected link never poisons the ones behind it.
* @returns {{
*   enqueue: (task: () => Promise<unknown>) => Promise<unknown>,
*   isDisposed: () => boolean,
*   dispose: () => void
* }}
*/
function createPublishQueue() {
	let publishChain = Promise.resolve();
	let disposed = false;
	return {
		/**
		* Queue `task` behind everything in flight and resolve with its result.
		* @param {() => Promise<unknown>} task - the publish to run, in turn.
		* @returns {Promise<unknown>} the task's own settled value.
		*/
		enqueue(task) {
			const queued = publishChain.then(task, task);
			publishChain = queued.then(() => void 0, () => void 0);
			return queued;
		},
		/**
		* Whether the publisher has been disposed. A publish that arrives after
		* dispose registers a provider into a Host that has already withdrawn the
		* plugin: no owner, no release, nothing on screen.
		* @returns {boolean}
		*/
		isDisposed: () => disposed,
		/** Mark the publisher disposed; every later publish becomes a no-op. */
		dispose() {
			disposed = true;
		}
	};
}
/**
* Build the releaser for one publisher's `state`.
*
* Releases are idempotent in the Host, and a release that throws must not
* abort the one behind it — during shutdown or a rollback the service may
* already be gone.
* @param {object} state - the publisher state holding the release functions.
* @returns {() => void} release, safe to call any number of times.
*/
function createPairReleaser(state) {
	return () => {
		const releaseFn = (fn) => {
			try {
				fn?.();
			} catch {}
		};
		releaseFn(state.releaseAdapter);
		releaseFn(state.releaseDirectory);
		state.releaseAdapter = null;
		state.releaseDirectory = null;
	};
}
/**
* Hand one built adapter to the `llm` service and record its release
* functions onto `target`.
*
* Defined ONCE because the publish path and the rollback path both register a
* pair, and two copies drift: a change to the directory row made in one place
* and not the other leaves the ROLLBACK registering a provider the publish
* path would never have built — and a rollback only runs once something has
* already gone wrong, which is the worst possible moment to find out
* (PITFALLS §19).
*
* The releases are written straight onto `target` rather than returned: if the
* directory call throws AFTER the adapter was registered, the adapter's
* release must still be reachable, or `release()` cannot undo it and the
* adapter outlives the plugin.
* @param {object} llm - the registration service.
* @param {{providerIds: string[], adapter: unknown}} built - what to register.
* @param {object} target - where the release functions are recorded.
* @param {object} identity - the provider's row on the models settings page.
* @param {string} identity.providerId
* @param {string} identity.displayName
* @returns {void}
*/
function registerProviderPair(llm, built, target, { providerId, displayName }) {
	target.releaseAdapter = llm.registerAdapter(built.providerIds, built.adapter);
	target.releaseDirectory = typeof llm.registerConfigurableProviders === "function" ? llm.registerConfigurableProviders([{
		provider: providerId,
		displayName,
		settingsNs: name,
		settingsPath: [],
		declared: false
	}]) : null;
}
/**
* Memoize the peer-dependent adapter factory for one publisher.
*
* The module is loaded once and the factory is read off it once, so a Host
* whose peers resolve slowly pays that cost one time, not per publish.
* @param {() => Promise<object>} loadModule - resolves the adapter module.
* @param {string} exportName - the factory export to read off the module.
* @returns {() => Promise<Function>} the memoized factory resolver.
*/
function createAdapterFactoryResolver(loadModule, exportName) {
	let adapterFactoryPromise;
	return async () => {
		if (adapterFactoryPromise === void 0) adapterFactoryPromise = Promise.resolve(loadModule()).then((mod) => mod?.[exportName]);
		return adapterFactoryPromise;
	};
}
/**
* Verify a built adapter is really one before it is registered Host-wide.
*
* An adapter is registered Host-wide, so a factory that returns anything else
* must fail here rather than publish a provider that cannot serve a request.
* @param {unknown} built - what the factory returned.
* @returns {boolean} whether it is `{ adapter, providerIds }`.
*/
function isBuiltAdapter(built) {
	return built !== null && typeof built === "object" && Array.isArray(built.providerIds) && built.adapter !== void 0;
}
/**
* Turn a build failure into a secret-free note plus a hint.
*
* A credential never reaches the panel or a log. The failure a reader cannot
* diagnose from the message alone: the llm peer packages ship INSIDE the Host,
* so a plugin directory the Host's node_modules cannot be reached from — a dev
* checkout symlinked into the profile, say — has no way to import them. Say
* so, with the remedy, because the panel can only report "provider absent".
* @param {unknown} error - the thrown value (may not be an Error at all).
* @returns {{note: string, hint: string, error: unknown}} the redacted message,
*   the optional remedy suffix, and the original value for re-raising.
*/
function describeBuildFailure(error) {
	const annotated = error;
	const why = errMsg(error);
	return {
		note: redactSecrets(why),
		hint: annotated?.code === "ERR_MODULE_NOT_FOUND" ? " — the llm peer packages ship with the Host; install this plugin where they resolve (or link them into its own node_modules)" : "",
		error
	};
}
/**
* Log one build failure the way both publishers log it.
* @param {object} [logger] - `ctx.logger`.
* @param {string} label - the upstream's name for the message ("ModelScope").
* @param {{note: string, hint: string}} described - from `describeBuildFailure`.
* @returns {void}
*/
function warnBuildFailure(logger, label, described) {
	logger?.warn?.(`${name}: cannot build the ${label} adapter: ${described.note}${described.hint}`);
}
/**
* Resolve the `llm` registration service, or bail out with the pair released.
*
* Both upstreams answer the same question the same way, and the answer is a
* fact about the Host — not about the provider — so it is one copy: a Host
* with no `llm` service gets no registration and a stated reason, never a
* half-built one.
* @param {object} job
* @param {object} job.state - the publisher state.
* @param {(service: string) => object|null} job.getLlm - the service resolver.
* @param {() => void} job.release - the publisher's releaser.
* @returns {object|null} the service, or null when it cannot register.
*/
function resolveRegistrationService({ state, getLlm, release }) {
	const llm = getLlm("llm");
	state.llmAvailable = llm !== null && typeof llm.registerAdapter === "function";
	if (!state.llmAvailable) {
		release();
		state.registered = false;
		state.error = NO_LLM_SERVICE_ERROR;
		return null;
	}
	return llm;
}
/**
* Take the registration down and record why it is gone.
*
* `state.built` is cleared along with it, and that matters: a stale `built`
* survives into the NEXT publish as its rollback target, so a later failed
* publish would re-register an adapter whose release has already been called.
* (The Raccoon publisher's "no credential" branch used to leave it standing.)
* @param {object} job
* @param {object} job.state - the publisher state.
* @param {() => void} job.release - the publisher's releaser.
* @param {string|null} [job.error] - why nothing is registered; null when the
*   absence is the wanted state (switch off).
* @returns {{ok: boolean, skipped: boolean}} the publish outcome.
*/
function unregister({ state, release, error = null }) {
	release();
	state.registered = false;
	state.built = null;
	state.error = error;
	return {
		ok: true,
		skipped: true
	};
}
/**
* Swap the registered pair: take down the old one, register the new one, and
* restore the OLD one if the new registration throws.
*
* This is the other half of PITFALLS §19, and the reason it is shared: the
* rollback is the path that only runs once something has already gone wrong.
* A registration that fails AFTER the old pair was released must put the
* previous one back, or a bad publish takes down models that were already
* serving. Written twice, the two copies drift; written once, a fix to the
* rollback reaches both upstreams.
*
* @param {object} job
* @param {object} job.llm - the registration service.
* @param {{providerIds: string[], adapter: unknown}} job.built - the new pair.
* @param {unknown} job.previousBuilt - the pair that was serving, or null.
* @param {object} job.state - the publisher state to record onto.
* @param {() => void} job.release - the publisher's releaser.
* @param {(llm: object, built: object, target: object) => void} job.registerPair -
*   the single-point registrar.
* @param {(event: string) => void | undefined} job.emit - the Host's raw
*   `ctx.emit`, if it has one. Optional so the absent case is handled once, in
*   {@link emitAdaptersUpdated}, rather than by every call site inventing a
*   no-op stand-in before it gets there.
* @param {() => void} [job.onRollback] - restore the domain snapshot fields
*   (`entries`/`enabledIds`, or the roster) to what is really serving.
* @returns {{ok: boolean, error?: unknown}} the publish outcome.
*/
function swapRegistration({ llm, built, previousBuilt, state, release, registerPair, emit, onRollback }) {
	release();
	try {
		registerPair(llm, built, state);
	} catch (error) {
		release();
		state.built = null;
		onRollback?.();
		state.error = redactSecrets(errMsg(error));
		if (previousBuilt !== null) try {
			registerPair(llm, previousBuilt, state);
			state.built = previousBuilt;
			state.registered = true;
		} catch {
			state.built = null;
			state.registered = false;
		}
		else state.registered = false;
		return {
			ok: false,
			error
		};
	}
	state.built = built;
	state.registered = true;
	state.error = null;
	emitAdaptersUpdated(emit);
	return { ok: true };
}
/**
* Emit the adapter-update event, tolerating a Host that has no `emit` and a
* Host whose `emit` refuses.
*
* This is the ONE place the emit path is defended, and it absorbs both halves
* of what used to be three layers. The assembly point (`index.ts`) used to wrap
* `ctx.emit` in its own `try { ctx.emit?.(event) } catch {}`, and each
* publisher then defaulted a missing `emit` to a no-op
* (`emit ?? (() => {})`) before handing it here — where a third `try/catch`
* waited. The middle layer could never do anything: the layer above it had
* already swallowed every throw, so the no-op fallback was unreachable except
* for a literal `undefined`, which the outer `?.` had already covered too.
*
* @param {((event: string) => void) | undefined} emit - the Host's raw
*   `ctx.emit`, or `undefined` on a Host that has none.
* @returns {void}
*/
function emitAdaptersUpdated(emit) {
	try {
		emit?.(ADAPTERS_UPDATED_EVENT);
	} catch {}
}

//#endregion
//#region src/host/provider-publish.ts
/**
* 魔搭 provider 的**发布状态机**——接入 DSH 的 control-plane 半边。
*
* 三条承重语义，每条都被一条必须继续绿的测试钉住：
*   - publish 队列把每一次 publish 排到所有在途 publish 之后，慢 publish 不能被
*     快 publish 覆盖（PITFALLS §18）；
*   - `disposed` 闸拦住 dispose 之后才到的 publish，不让它注册进一个已经撤下本
*     插件的 Host；
*   - 单点 `registerPair`（带 factory-await + shape 检查，PITFALLS §19）被 publish
*     与 rollback 两条路共用；失败时**恢复旧对**，坏 publish 不会把已在服务的模型
*     也拉下来。
*
* 与姊妹插件的差异**只有**：工厂导出名 `"createModelScopeAdapter"`、`registerPair`
* 用的 `LLM_PROVIDER_ID`/`LLM_DISPLAY_NAME`、`warnBuildFailure` 的 label
* `"ModelScope"`。上面的四条语义原样保留——它们是 `publish-core.ts` 的骨头。
*
* peer-free：不 import 任何运行时 peer。适配器工厂由调用方注入
* （`loadAdapterModule`，默认 `import("./llm-adapter.ts")`），所以离线套件可以换
* 一个假工厂而不碰 Host 的 node_modules。
*
* 跨切面行为指路：目录变化 / 开关翻转 / 清单保存 → 重注册 = `index.ts` 轮询
* publish + provider 路由 handler。
*
* @module dsh-connect-modelscope-token-plan/provider-publish
*/
/**
* provider 发布器。
*
* 持有活注册状态（`state`）；publish 队列、`disposed` 闸与单点 `registerPair` 是
* `publish-core.ts` 共享的骨头。调用方从挂载 seed、目录轮询、provider 开关、roster
* 保存来驱动 `publish`，从 `ctx.effect` 的 teardown 调 `dispose`。
*
* `getLlm` 解析器是**函数**不是快照：`llm` 服务可能在本插件挂载后才与 Host 注册
* ——与 `credentials` 的「解析器而非快照」同一套。
*
* @param {ProviderPublisherDeps} [deps]
* @returns {{
*   state: ProviderPublisherState,
*   publish: (entries: object[], enabledIds: string[],
*             unavailableModelIds?: string[]) => Promise<object>,
*   release: () => void,
*   dispose: () => void,
*   isDisposed: () => boolean
* }}
*/
function createProviderPublisher(deps = {}) {
	const { settings, panelSwitch, loadAdapterModule, getLlm, resolveApiKey, emit, logger } = deps;
	const effectiveSettings = settings ?? {};
	const effectivePanelSwitch = panelSwitch ?? (async () => null);
	const effectiveLoadAdapterModule = loadAdapterModule ?? (() => import("./llm-adapter-BRQ1zUNC.js"));
	const effectiveGetLlm = getLlm ?? (() => null);
	const effectiveResolveApiKey = resolveApiKey ?? (async () => "");
	const effectiveLogger = logger ?? { warn: () => {} };
	/**
	* 活注册状态。一个普通对象，调用方以 `state` 读它（快照的 provider 块从上面取
	* `registered`/`error`）。release 函数住在这里而不是作为返回值，是因为在注册
	* 已完成后才抛的注册也必须能被拿到——否则适配器会比插件活得久（见
	* `registerPair`）。
	*/
	const state = {
		entries: [],
		enabledIds: [],
		unavailableIds: [],
		signature: "",
		quotaSignature: "",
		/** 是否有应答 `registerAdapter` 的 `llm` 服务。 */
		llmAvailable: false,
		/** 我们的 provider 对当前是否已无错注册。 */
		registered: false,
		/** 最近一次注册错误，经快照脱敏呈现。 */
		error: null,
		releaseAdapter: null,
		releaseDirectory: null,
		/** 当前 release 函数所属于的已构建适配器。 */
		built: null
	};
	/** publish 队列与 `disposed` 闸——三条承重语义里的前两条，都在 `publish-core.ts`。 */
	const queue = createPublishQueue();
	/** 解析 peer-dependent 适配器工厂，只解析一次并 memoize。 */
	const resolveAdapterFactory = createAdapterFactoryResolver(effectiveLoadAdapterModule, "createModelScopeAdapter");
	/** 释放已注册的 provider 对。释放函数在 Host 里是幂等的。 */
	const release = createPairReleaser(state);
	/**
	* 把一个构建好的适配器交给 llm 服务，并把它的 release 函数记到 `target` 上。
	*
	* 函数体是共享的 `registerProviderPair`（PITFALLS §19）——两个 publisher、两条
	* 路径共用一份；这个包装只补上「这行是给哪个 provider 的」。
	* @param {object} llm - 注册服务。
	* @param {{providerIds: string[], adapter: unknown}} built - 要注册的东西。
	* @param {object} target - release 函数要记到哪（`state`）。
	* @returns {void}
	*/
	const registerPair = (llm, built, target) => registerProviderPair(llm, built, target, {
		providerId: LLM_PROVIDER_ID,
		displayName: LLM_DISPLAY_NAME
	});
	/**
	* 为一个目录/允许清单快照（重）构建并注册 provider。
	*
	* 重建并重注册而非原地改：`PiAiAdapter` 内部 memoize profiles 快照，只有新的注册
	* 才能改变提供的模型列表。注册失败时**恢复上一对**，所以坏 publish 永远不能把
	* 已在服务的模型拉下来。
	* @param {object[]} entries - 归一目录条目。
	* @param {string[]} enabledIds - 允许清单（空 = 全部）。
	* @param {string[]} [unavailableModelIds] - 要从 picker 的 offer 里丢掉的额度耗尽 id。
	* @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
	*/
	const publishProviderOnce = async (entries, enabledIds, unavailableModelIds = []) => {
		if (queue.isDisposed()) return {
			ok: false,
			skipped: true
		};
		const previousBuilt = state.built;
		const previousEntries = state.entries;
		const previousEnabledIds = state.enabledIds;
		const previousUnavailable = state.unavailableIds;
		state.entries = Array.isArray(entries) ? entries : [];
		state.enabledIds = Array.isArray(enabledIds) ? enabledIds : [];
		state.unavailableIds = Array.isArray(unavailableModelIds) ? unavailableModelIds : [];
		const panelValue = await effectivePanelSwitch().catch(() => null);
		if (!resolveSwitchEnabled(panelValue, effectiveSettings.registerProvider === true)) return unregister({
			state,
			release
		});
		const llm = resolveRegistrationService({
			state,
			getLlm: effectiveGetLlm,
			release
		});
		if (llm === null) return {
			ok: false,
			error: state.error
		};
		let createModelScopeAdapter;
		let built;
		try {
			createModelScopeAdapter = await resolveAdapterFactory();
			if (createModelScopeAdapter === void 0) throw new Error(BAD_FACTORY_SHAPE_ERROR);
			built = await createModelScopeAdapter({
				entries: state.entries,
				enabledIds: state.enabledIds,
				baseUrl: effectiveSettings.apiBase,
				resolveApiKey: effectiveResolveApiKey,
				get: effectiveGetLlm,
				unavailableModelIds: state.unavailableIds
			});
			if (!isBuiltAdapter(built)) throw new Error(BAD_FACTORY_SHAPE_ERROR);
		} catch (e) {
			const described = describeBuildFailure(e);
			state.error = described.note;
			warnBuildFailure(effectiveLogger, "ModelScope", described);
			return {
				ok: false,
				error: described.error
			};
		}
		return swapRegistration({
			llm,
			built,
			previousBuilt,
			state,
			release,
			registerPair,
			emit,
			onRollback: () => {
				state.entries = previousEntries;
				state.enabledIds = previousEnabledIds;
				state.unavailableIds = previousUnavailable;
			}
		});
	};
	/**
	* publish，排到所有其他在途 publish 之后。
	*
	* 包装的存在是为了没有任何调用方要记得队列：挂载 seed、目录轮询、provider 开关、
	* roster 保存都走同一条临界区，它们任何一个与另一个竞争就是上面的 bug。
	* @param {object[]} entries - 归一目录条目。
	* @param {string[]} enabledIds - 允许清单（空 = 全部）。
	* @param {string[]} [unavailableModelIds] - 额度耗尽的模型 id。
	* @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
	*/
	const publish = (entries, enabledIds, unavailableModelIds = []) => queue.enqueue(() => publishProviderOnce(entries, enabledIds, unavailableModelIds));
	/**
	* 标记 publisher 已 dispose：之后（或在途的）任何 publish 都变成 no-op，不能注册
	* 进一个已撤下的 Host。
	*/
	const dispose = () => queue.dispose();
	return {
		state,
		publish,
		release,
		dispose,
		isDisposed: () => queue.isDisposed()
	};
}

//#endregion
//#region src/host/routes/paths.ts
/**
* 路由字面量。浏览器 bundle（src/client/const.ts）无法从 host-config 导入，
* 两边各写一份字面量——由 test/config.test.mjs 钉住相等，改名时先红再改。
* @module dsh-connect-modelscope-token-plan/routes/paths
*/
const SNAPSHOT_PATH = "/api/dsh-connect-modelscope-token-plan/snapshot";
const MODELS_PATH = "/api/dsh-connect-modelscope-token-plan/models";
const TOKEN_PATH = "/api/dsh-connect-modelscope-token-plan/token";
const TOKEN_FORGET_PATH = "/api/dsh-connect-modelscope-token-plan/token/forget";
const PROBE_PATH = "/api/dsh-connect-modelscope-token-plan/probe";
const PROVIDER_PATH = "/api/dsh-connect-modelscope-token-plan/provider";

//#endregion
//#region src/host/snapshot-aggregate.ts
/**
* 快照聚合：把 token 状态、本地用量、模型目录三路数据软失败地拼成
* `Snapshot`（src/shared/wire.ts 的契约）。
*
* `soft()` 家规：任何一路失败都不许白屏——部分失败呈现为该路的降级形状
* （models.available=false / shapeWarnings 一条），而不是整条快照 ok:false。
* 快照路由只在**配置坏**（configError）或聚合器自身抛错时才回 ok:false。
*
* 严格区分 null 与 0（wire.ts 语义基线）：本地计数器没记录 = 真实 0；模型
* 目录读不到 = available:false + error，绝不伪装成「0 个模型」。
*
* @module dsh-connect-modelscope-token-plan/snapshot-aggregate
*/
/** 软失败包装：成功给 value，失败给 {error, code}——从不 reject。 */
async function soft(promise) {
	try {
		return {
			ok: true,
			value: await promise
		};
	} catch (error) {
		const code = error.code;
		return {
			ok: false,
			error: errMsg(error),
			code: typeof code === "string" ? code : "internal_error"
		};
	}
}
/**
* 把允许清单读成 M4 的三态语义（§11 的 `allowed`）。
*
* 空清单 = 不过滤（`all`）；哨兵 `HIDE_ALL_MODELS` = 什么都不提供（`none`）；
* 其余非空清单 = 严格白名单（`list`）。空清单已经占用了「不过滤」，所以「什么都不
* 提供」必须有第二种拼写——这正是 `HIDE_ALL_MODELS` 存在的原因。
*/
function resolveAllowed(enabledIds) {
	if (enabledIds.includes("__hide_all__")) return "none";
	if (enabledIds.length > 0) return "list";
	return "all";
}
/**
* Provider 状态块降级形状：读不到开关/注册状态/目录时，面板仍然得到一个完整
* 可渲染的块（开关关、roster 空、error 说明原因），绝不让整条快照失败。
*/
function providerDegraded(error) {
	return {
		enabled: false,
		source: "config",
		llmAvailable: false,
		registered: false,
		error,
		modelCount: 0,
		enabledCount: 0,
		allowed: "all",
		enabledIds: [],
		roster: []
	};
}
/** 聚合快照 body。wiring 子集见 routes/snapshot.ts 的 Pick。 */
async function buildSnapshotBody(wiring) {
	const { settings, tokenStore, usageStore, inference, providerStore, publisher } = wiring;
	const [tokenState, daily, perModel, trend, events] = await Promise.all([
		soft(tokenStore.state()),
		soft(usageStore.daily()),
		soft(usageStore.perModelToday()),
		soft(usageStore.trend(settings.trendDays)),
		soft(usageStore.events())
	]);
	const shapeWarnings = [];
	const usageAnomaly = usageStore.anomaly();
	if (usageAnomaly !== null) shapeWarnings.push(usageAnomaly);
	for (const path of [
		tokenState,
		daily,
		perModel,
		trend,
		events
	]) if (!path.ok) shapeWarnings.push(`usage-source failed (${path.code}): ${path.error}`);
	const tokenPresent = tokenState.ok ? tokenState.value.present : false;
	const balance = await soft(inference.fetchBalance());
	const models = await soft(inference.fetchModels());
	const modelIds = models.ok ? models.value.ids : [];
	const modelEntries = models.ok ? models.value.entries : [];
	if (!models.ok && models.code !== "network_error") shapeWarnings.push(`models: ${models.error}`);
	if (tokenPresent && !balance.ok && balance.code !== "network_error") shapeWarnings.push(`balance: ${balance.error}`);
	const provider = await soft((async () => {
		const panel = await providerStore.enabled().catch(() => null);
		const enabled = resolveSwitchEnabled(panel, settings.registerProvider);
		const source = switchSource(panel);
		const roster = rosterWithAvailability(modelEntries, []);
		const enabledIds = Array.isArray(publisher.state.enabledIds) ? publisher.state.enabledIds : [];
		const allowed = resolveAllowed(enabledIds);
		const allowSet = new Set(enabledIds);
		const enabledCount = allowed === "all" ? roster.length : allowed === "list" ? roster.filter((row) => allowSet.has(row.id)).length : 0;
		return {
			enabled,
			source,
			llmAvailable: publisher.state.llmAvailable === true,
			registered: publisher.state.registered === true,
			error: typeof publisher.state.error === "string" ? publisher.state.error : null,
			modelCount: roster.length,
			enabledCount,
			allowed,
			enabledIds,
			roster
		};
	})());
	const usedLocal = daily.ok ? daily.value.calls : 0;
	const dailyLimit = settings.dailyQuotaTotal;
	return {
		ok: true,
		name,
		version: PLUGIN_VERSION,
		now: (/* @__PURE__ */ new Date()).toISOString(),
		pollSeconds: settings.pollSeconds,
		cacheSeconds: settings.cacheSeconds,
		token: tokenState.ok ? tokenState.value : {
			present: false,
			source: "none",
			valid: null,
			checkedAt: null,
			ephemeral: true
		},
		balance: balance.ok ? {
			available: balance.value.available,
			total: balance.value.total,
			frozen: balance.value.frozen,
			fetchedAt: balance.value.fetchedAt,
			error: null
		} : {
			available: null,
			total: null,
			frozen: null,
			fetchedAt: null,
			error: tokenPresent ? balance.error : null
		},
		quota: {
			daily: {
				limit: dailyLimit,
				usedLocal,
				remainingComputed: Math.max(0, dailyLimit - usedLocal)
			},
			perModelLimit: settings.dailyQuotaPerModel,
			perModel: perModel.ok ? perModel.value : [],
			countingNote: "local-counting"
		},
		events: events.ok ? events.value : [],
		trend: {
			days: settings.trendDays,
			buckets: trend.ok ? trend.value : []
		},
		models: {
			available: models.ok,
			count: modelIds.length,
			sample: modelIds.slice(0, 20),
			error: models.ok ? null : models.error
		},
		provider: provider.ok ? provider.value : providerDegraded(provider.error),
		shapeWarnings,
		quotaError: null
	};
}
/** 聚合器自身抛错时的失败码（快照路由的 ok:false 分支用）。 */
function failureCode(error) {
	const code = error.code;
	return typeof code === "string" ? code : "internal_error";
}

//#endregion
//#region src/host/routes/http.ts
/**
* 路由族共享的 HTTP 原语：JSON 形状、有界 body 读取、标准拒绝与信任围栏。
* 与姊妹插件 routes/http.ts 受控复制；每个拒绝的措辞只此一份，路由无法
* 漂移出自己的 403/405。不 import 任何 Host peer。
* @module dsh-connect-modelscope-token-plan/routes/http
*/
/** JSON 路由的族默认响应头。 */
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"referrer-policy": "no-referrer"
};
/** 写一个带族头的 JSON 响应。 */
function writeJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		...JSON_HEADERS,
		...headers
	});
	res.end(payload);
}
/** 提交体的字节上限： hostile 页面不能对着路由流一个无限 body。 */
const MAX_JSON_BODY_BYTES = 4096;
/**
* 读一个小的 JSON 请求体，超限即拒。刻意无趣：不协商 content-type、不流式，
* 有界收集 + 解析。
*/
async function readJsonBody(request, limit = MAX_JSON_BODY_BYTES) {
	const chunks = [];
	let received = 0;
	try {
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			received += buffer.byteLength;
			if (received > limit) return {
				ok: false,
				error: "request body is too large"
			};
			chunks.push(buffer);
		}
	} catch {
		return {
			ok: false,
			error: "could not read the request body"
		};
	}
	if (chunks.length === 0) return {
		ok: false,
		error: "a JSON body is required"
	};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {
			ok: false,
			error: "the body must be a JSON object"
		};
		return {
			ok: true,
			value: parsed
		};
	} catch {
		return {
			ok: false,
			error: "the body is not valid JSON"
		};
	}
}
/** 信任围栏拒绝时的一律 403（面板认这个形状）。 */
function refuseOrigin(response) {
	writeJson(response, 403, {
		ok: false,
		error: "forbidden: origin mismatch"
	});
}
/** 方法不允许时的一律 405。方法拒绝不是新答案，不带 cache-control。 */
function refuseMethod(response) {
	writeJson(response, 405, {
		ok: false,
		error: "method not allowed"
	});
}
/**
* 把 catch 到的错误脱敏后再进响应的 error 字段（家规红线 1：凭据永不进
* 日志或响应）。redactSecrets 幂等，双重应用无害。
*/
function redactedError(error) {
	const text = redactSecrets(errMsg(error));
	return text.trim() === "" ? "request failed" : text;
}
/** 读并校验 JSON body，失败时写 400 并返回 null（调用方的停手信号）。 */
async function readJsonBodyOr400(request, response, limit = MAX_JSON_BODY_BYTES) {
	const body = await readJsonBody(request, limit);
	if (!body.ok) {
		writeJson(response, 400, {
			ok: false,
			error: body.error
		}, { "cache-control": "no-store" });
		return null;
	}
	return body.value;
}
/**
* 给每个路由包上同一道信任围栏（isAdmitted），403 措辞只此一份。
* 被包的 handler 不得再重复围栏——那只是第二道死守卫。
*/
function withOrigin(handler, allowedHosts) {
	return async (request, response) => {
		if (!isAdmitted(request, allowedHosts)) {
			refuseOrigin(response);
			return;
		}
		return handler(request, response);
	};
}

//#endregion
//#region src/host/routes/snapshot.ts
/**
* 快照路由——Client 面板轮询的唯一只读路由。
*
* HTTP 恒 200，成败看 body（wire.ts 的 Snapshot | SnapshotFailure）：一次
* 读取失败不许顺着渲染树炸穿成整页失效，错误是**数据**（ok:false + code）
* 不是异常。configError 在这里短路——面板把它映射成顶部一行，让操作者看到
* 配错的是什么，而不是一个莫名其妙的网络失败。
*
* @module dsh-connect-modelscope-token-plan/routes/snapshot
*/
/**
* 注册快照路由。wiring 子集：settings / configError / tokenStore /
* usageStore / inference / providerStore / publisher / logger。
* @returns {Function} off() 注销回调。
*/
function registerSnapshotRoute(ctx, wiring) {
	const { settings, configError } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: SNAPSHOT_PATH,
		handler: withOrigin(async (request, response) => {
			if (request.method !== void 0 && request.method !== "GET" && request.method !== "HEAD") {
				refuseMethod(response);
				return;
			}
			if (configError !== null) {
				writeJson(response, 200, {
					ok: false,
					code: CODE.CONFIG_ERROR,
					error: configError
				}, { "cache-control": "no-store" });
				return;
			}
			try {
				const body = await buildSnapshotBody(wiring);
				writeJson(response, 200, body, { "cache-control": "no-store" });
			} catch (error) {
				writeJson(response, 200, {
					ok: false,
					error: redactedError(error),
					code: failureCode(error)
				}, { "cache-control": "no-store" });
			}
		}, settings.allowedHosts)
	});
}

//#endregion
//#region src/host/routes/models.ts
/**
* 模型目录路由：`GET /models` —— 免认证的 `/v1/models` 读穿透（缓存与单飞
* 在 inference-client 里），零额度成本（SPIKE.md §结论 3）。只读。
* @module dsh-connect-modelscope-token-plan/routes/models
*/
/** 注册模型目录路由。wiring 子集：settings / inference。 */
function registerModelsRoute(ctx, wiring) {
	const { settings, inference } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: MODELS_PATH,
		handler: withOrigin(async (request, response) => {
			if (request.method !== void 0 && request.method !== "GET" && request.method !== "HEAD") {
				refuseMethod(response);
				return;
			}
			try {
				const catalog = await inference.fetchModels();
				writeJson(response, 200, {
					ok: true,
					models: catalog.ids.map((id) => ({ id })),
					entries: catalog.entries.map((entry) => ({
						id: entry.id,
						name: entry.name,
						vision: entry.vision,
						contextWindow: entry.contextWindow,
						maxOutputLength: entry.maxOutputLength
					})),
					count: catalog.ids.length,
					fetchedAt: catalog.fetchedAt,
					cacheSeconds: settings.cacheSeconds
				}, { "cache-control": "no-store" });
			} catch (error) {
				const code = error.code;
				writeJson(response, 200, {
					ok: false,
					code: typeof code === "string" ? code : CODE.UPSTREAM_ERROR,
					error: redactedError(error)
				}, { "cache-control": "no-store" });
			}
		}, settings.allowedHosts)
	});
}

//#endregion
//#region src/host/routes/token.ts
/**
* 令牌路由：面板「接入」tab 保存 / 忘掉访问令牌。
*
* 存的是凭据引用（ms-auth TOKEN_REF），不是新 kind。保存/忘掉后**不需要**
* 失效任何缓存：模型目录免认证、probe 每次现 resolve 令牌——本插件没有
* 「凭据换手后缓存还在替旧身份说话」的形态，这是免认证目录带来的结构性
* 简化（SPIKE.md §结论 3）。
* @module dsh-connect-modelscope-token-plan/routes/token
*/
/** 注册令牌路由（POST /token 保存，POST /token/forget 忘掉）。 */
function registerTokenRoute(ctx, wiring) {
	const { settings, tokenStore } = wiring;
	const save = withOrigin(async (request, response) => {
		if (request.method !== "POST") {
			refuseMethod(response);
			return;
		}
		const body = await readJsonBodyOr400(request, response);
		if (body === null) return;
		const token = typeof body.token === "string" ? body.token : "";
		if (token.trim() === "") {
			writeJson(response, 400, {
				ok: false,
				error: "a ModelScope token (ms-…) is required"
			}, { "cache-control": "no-store" });
			return;
		}
		try {
			await tokenStore.save(token);
			writeJson(response, 200, {
				ok: true,
				...await tokenStore.state()
			}, { "cache-control": "no-store" });
		} catch (error) {
			writeJson(response, 200, {
				ok: false,
				error: redactedError(error)
			}, { "cache-control": "no-store" });
		}
	}, settings.allowedHosts);
	const forget = withOrigin(async (request, response) => {
		if (request.method !== "POST") {
			refuseMethod(response);
			return;
		}
		try {
			await tokenStore.forget();
			writeJson(response, 200, {
				ok: true,
				...await tokenStore.state()
			}, { "cache-control": "no-store" });
		} catch (error) {
			writeJson(response, 200, {
				ok: false,
				error: redactedError(error)
			}, { "cache-control": "no-store" });
		}
	}, settings.allowedHosts);
	return [ctx.webServer.register({
		kind: "exact",
		path: TOKEN_PATH,
		handler: save
	}), ctx.webServer.register({
		kind: "exact",
		path: TOKEN_FORGET_PATH,
		handler: forget
	})];
}

//#endregion
//#region src/host/routes/probe.ts
/**
* probe 路由：面板「接入」tab 的「测试一次调用」，也是本地计数器的第一个
* 数据源。
*
* 两种形态（SPIKE.md §结论 5）：
* - `kind:"usage"` —— 真调用（max_tokens=1），**消耗 1 次免费额度**；成功后
*   recordCall 把这次调用记进当天天桶与单模型计数（tokens 取 usage）。
* - `kind:"validity"` —— 故意缺 messages 的请求，预期 401 先于 400，零额度
*   鉴权探针（语义待真机回填）。只记事件，不记调用。
*
* 失败照常记账：429 分诊成 quota/rate_limit 事件（带 Retry-After），401 记
* auth 事件——事件流是面板「额度」tab 的第三块。错误消息先脱敏（红线 1）。
* @module dsh-connect-modelscope-token-plan/routes/probe
*/
/** 注册 probe 路由。wiring 子集：settings / tokenStore / usageStore / inference / logger。 */
function registerProbeRoute(ctx, wiring) {
	const { settings, usageStore, inference, logger } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: PROBE_PATH,
		handler: withOrigin(async (request, response) => {
			if (request.method !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
			const kind = body.kind === "validity" ? "validity" : "usage";
			if (modelId === "") {
				writeJson(response, 400, {
					ok: false,
					error: "modelId is required"
				}, { "cache-control": "no-store" });
				return;
			}
			try {
				const result = await inference.probe({
					modelId,
					kind
				});
				if (kind === "usage") await usageStore.recordCall({
					modelId,
					tokens: result.usage === null ? null : result.usage.totalTokens
				});
				writeJson(response, 200, {
					...result,
					tokenState: await wiring.tokenStore.state()
				}, { "cache-control": "no-store" });
			} catch (error) {
				const code = error.code;
				const message = redactedError(error);
				const eventKind = code === CODE.QUOTA_EXCEEDED ? "quota" : code === CODE.RATE_LIMITED ? "rate_limit" : "error";
				await usageStore.recordEvent({
					modelId,
					kind: eventKind,
					message
				}).catch(() => {});
				if (eventKind !== "error") logger?.warn?.(`probe ${modelId}: ${eventKind}: ${message}`);
				const retryAfterMs = error.retryAfterMs;
				writeJson(response, 200, {
					ok: false,
					code: typeof code === "string" ? code : CODE.UPSTREAM_ERROR,
					error: message,
					...retryAfterMs !== void 0 ? { retryAfterMs } : {},
					tokenState: await wiring.tokenStore.state().catch(() => null)
				}, { "cache-control": "no-store" });
			}
		}, settings.allowedHosts)
	});
}

//#endregion
//#region src/host/routes/provider.ts
/**
* provider 注册路由：开关读/写、允许清单保存、回退默认。
*
* 三件事（§9）：
*   - GET  `PROVIDER_PATH`        读当前开关 + 目录 + 允许清单 + 注册状态（无副作用）；
*   - POST `PROVIDER_PATH`        body `{enabled?: boolean}` → 保存面板开关并重注册；
*   - POST `PROVIDER_PATH/roster` body `{enabledIds?: string[]}` → 保存允许清单并重注册；
*   - POST `PROVIDER_PATH/reset`  忘掉面板开关与允许清单，回到 patch 默认。
*
* `withOrigin` 围栏与 `refuseMethod` 照现有路由；写开关/清单失败**必须传播**
* （`ok:false` + error），不静默吞——这是用户的显式操作，面板必须看见它没生效。
*
* peer-free：不 import 任何 Host peer（`@deepseek-ai/*` / `@earendil-works/*`）。
* @module dsh-connect-modelscope-token-plan/routes/provider
*/
/**
* 读目录条目，读不到按空目录降级（GET 不能因目录失败把整个面板状态打掉）。
*/
async function readEntries(inference) {
	const catalog = await inference.fetchModels().catch((error) => {
		return {
			entries: [],
			__error: error
		};
	});
	return Array.isArray(catalog?.entries) ? catalog.entries : [];
}
/**
* 读「当前」允许清单：优先持久化的，否则 publisher 最近 publish 的那份。
*/
async function readEnabledIds(store, published) {
	const stored = await optional(store.enabledIds?.(), null);
	if (Array.isArray(stored)) return stored;
	return Array.isArray(published) ? published : [];
}
/**
* `allowed` 的分类：空清单 = 不过滤（"all"），恰好哨兵 = 全隐藏（"none"），
* 否则严格白名单（"list"）。
*
* `HIDE_ALL_MODELS` 是哨兵：空清单语义是「不过滤」，不能当「隐藏全部」用。
* @param {string[]} enabledIds - 允许清单。
* @returns {"all"|"none"|"list"}
*/
function allowedOf(enabledIds) {
	if (enabledIds.length === 0) return "all";
	if (enabledIds.length === 1 && enabledIds[0] === "__hide_all__") return "none";
	return "list";
}
/**
* 注册 provider 路由（三条路径）。wiring 子集：settings / providerStore /
* publisher / inference / logger。
* @param ctx - host 根上下文（只用 `ctx.webServer`）。
* @param {ProviderRouteWiring} wiring - 本路由读到的子集。
* @returns {Function} 依次调用三个 `off()` 的注销回调。
*/
function registerProviderRoute(ctx, wiring) {
	const { settings, providerStore, publisher, inference, logger } = wiring;
	/**
	* 组装一份 §9 响应形状。GET 与成功后的 POST 共用，所以两个方向不可能对「当前
	* 状态是什么」说两套话。
	* @param {object} [extra] - 调用方要追加/覆盖的字段。
	* @returns {Promise<object>} 响应体。
	*/
	const snapshot = async (extra = {}) => {
		const panelSwitch = await optional(providerStore.enabled());
		const enabledIds = await readEnabledIds(providerStore, publisher.state.enabledIds);
		const entries = await readEntries(inference);
		const roster = rosterWithAvailability(entries, []);
		const allowed = allowedOf(enabledIds);
		const modelCount = roster.length;
		return {
			ok: true,
			enabled: resolveSwitchEnabled(panelSwitch, settings.registerProvider),
			source: switchSource(panelSwitch),
			llmAvailable: publisher.state.llmAvailable === true,
			registered: publisher.state.registered === true,
			error: typeof publisher.state.error === "string" ? publisher.state.error : null,
			modelCount,
			enabledCount: allowed === "all" ? modelCount : allowed === "none" ? 0 : enabledIds.length,
			allowed,
			enabledIds,
			roster,
			...extra
		};
	};
	const offs = [];
	offs.push(ctx.webServer.register({
		kind: "exact",
		path: PROVIDER_PATH,
		handler: withOrigin(async (request, response) => {
			const method = request.method === void 0 ? "GET" : request.method;
			if (method === "GET") {
				writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
				return;
			}
			if (method !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			if (typeof body.enabled !== "boolean") {
				writeJson(response, 400, {
					ok: false,
					error: "expected { enabled: boolean }"
				}, { "cache-control": "no-store" });
				return;
			}
			try {
				await providerStore.save(body.enabled);
				const entries = await readEntries(inference);
				await publisher.publish(entries, await readEnabledIds(providerStore, publisher.state.enabledIds), []);
			} catch (error) {
				writeJson(response, 200, {
					ok: false,
					error: redactedError(error)
				}, { "cache-control": "no-store" });
				return;
			}
			writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
		}, settings.allowedHosts)
	}));
	offs.push(ctx.webServer.register({
		kind: "exact",
		path: `${PROVIDER_PATH}/roster`,
		handler: withOrigin(async (request, response) => {
			if ((request.method === void 0 ? "POST" : request.method) !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			if (!Array.isArray(body.enabledIds)) {
				writeJson(response, 400, {
					ok: false,
					error: "expected { enabledIds: string[] }"
				}, { "cache-control": "no-store" });
				return;
			}
			const ids = body.enabledIds.filter((id) => typeof id === "string" && id !== "");
			try {
				await providerStore.saveEnabledIds?.(ids);
				const entries = await readEntries(inference);
				await publisher.publish(entries, ids, []);
			} catch (error) {
				writeJson(response, 200, {
					ok: false,
					error: redactedError(error)
				}, { "cache-control": "no-store" });
				return;
			}
			writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
		}, settings.allowedHosts)
	}));
	offs.push(ctx.webServer.register({
		kind: "exact",
		path: `${PROVIDER_PATH}/reset`,
		handler: withOrigin(async (request, response) => {
			if ((request.method === void 0 ? "POST" : request.method) !== "POST") {
				refuseMethod(response);
				return;
			}
			await readJsonBody(request, MAX_JSON_BODY_BYTES).catch(() => ({
				ok: false,
				error: "ignored"
			}));
			try {
				await providerStore.forget();
				await providerStore.saveEnabledIds?.([]);
				const entries = await readEntries(inference);
				await publisher.publish(entries, [], []);
			} catch (error) {
				writeJson(response, 200, {
					ok: false,
					error: redactedError(error)
				}, { "cache-control": "no-store" });
				return;
			}
			writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
		}, settings.allowedHosts)
	}));
	return () => {
		for (const off of offs) try {
			off();
		} catch (error) {
			logger?.warn?.(`provider route unregister failed: ${redactedError(error)}`);
		}
	};
}

//#endregion
//#region src/host/routes.ts
/**
* 路由族的注册门面。`apply()`（index.ts）是唯一挂载缝：装配 wiring、交给
* registerRoutes；每个路由一个模块、闭包自己的 wiring 子集，绝不直接 import
* 服务。注册顺序即注销顺序（teardown 按此跑）。
* @module dsh-connect-modelscope-token-plan/routes
*/
/** 注册全部路由，返回 off() 注销回调（注册序）。M4 起含 provider 路由。 */
function registerRoutes(ctx, wiring) {
	return [
		registerSnapshotRoute(ctx, wiring),
		registerModelsRoute(ctx, wiring),
		...registerTokenRoute(ctx, wiring),
		registerProbeRoute(ctx, wiring),
		registerProviderRoute(ctx, wiring)
	];
}

//#endregion
//#region src/host/index.ts
/**
* dsh-connect-modelscope-token-plan — Host 半边（thin router）。
*
* 读魔搭 API-Inference 的**本地用量**（上游没有余额接口，见 docs/SPIKE.md）
* 并经一条只读 /api 路由喂给 Client 面板。重活都在专注的兄弟模块里，本文件
* 只保留 Cordis 入口（name/inject/apply）、wiring 装配与卸载副作用：
*
*   - `host-config.ts`        配置契约 + isAdmitted 信任围栏
*   - `routes.ts`             四条路由的门面（snapshot/models/token/probe）
*   - `ms-auth.ts`            访问令牌存取（静态钥匙，无登录流）
*   - `inference-client.ts`   模型目录（零额度）+ probe 调用（带分诊）
*   - `usage-store.ts`        本地计数：天桶/单模型/事件流（原子写、版本守卫）
*   - `snapshot-aggregate.ts` 快照聚合（软失败）
*   - `state-store.ts`        状态文件原子原语
*   - `codes.ts`              错误分类单一真源
*
* @module dsh-connect-modelscope-token-plan
*/
/**
* Host 入口：装配 wiring、注册路由、挂卸载副作用。
* @param ctx - Host 根上下文。
* @param config - 行的原始 patch 配置（无 schema，未校验；坏配置以
*   configError 经快照呈现，而不是在挂载时炸掉整台插件）。
* @param deps - 测试缝（fetchImpl）。真实 Loader 不传。
*/
function apply(ctx, config = {}, deps = {}) {
	const { settings, configError } = resolveSettings(config);
	const tokenStore = createTokenStore({ credentials: () => ctx.get("credentials") ?? null });
	const profile = profileSegment(ctx);
	const usageStore = createFileUsageStore({
		name,
		profile,
		trendDays: settings.trendDays,
		maxEvents: settings.maxEvents,
		logger: ctx.logger
	});
	const inference = createInferenceClient({
		settings,
		tokenStore,
		deps,
		logger: ctx.logger
	});
	const providerStore = createFileProviderStore({
		profile,
		logger: ctx.logger
	});
	const publisher = createProviderPublisher({
		settings,
		panelSwitch: () => providerStore.enabled(),
		getLlm: (service) => ctx.get?.(service) ?? null,
		resolveApiKey: async () => (await tokenStore.resolve()).value,
		emit: (event) => ctx.emit?.(event),
		logger: ctx.logger
	});
	/**
	* 读允许清单。
	*
	* M4 阶段**不落盘**允许清单（见 docs/PROVIDER-M4.md §10），所以从
	* `publisher.state.enabledIds` 读最后一次 publish 用的那份；从未保存过为 `[]`，
	* 语义是「不过滤」（与哨兵「什么都不提供」是两回事）。
	*/
	const readEnabledIds = () => Array.isArray(publisher.state.enabledIds) ? publisher.state.enabledIds : [];
	const wiring = {
		settings,
		configError,
		tokenStore,
		usageStore,
		inference,
		providerStore,
		publisher,
		logger: ctx.logger
	};
	const offs = registerRoutes(ctx, wiring);
	ctx.effect(() => {
		publisher.publish([], [], []).catch(() => {});
		const timer = setInterval(async () => {
			try {
				const catalog = await inference.fetchModels();
				const enabledIds = await providerStore.enabled().catch(() => null) === true ? readEnabledIds() : [];
				await publisher.publish(catalog.entries, enabledIds, []);
			} catch {}
		}, settings.pollSeconds * 1e3);
		return () => {
			clearInterval(timer);
			publisher.dispose();
			publisher.release();
			for (const off of offs) try {
				off?.();
			} catch (error) {
				ctx.logger?.warn?.(`${name}: route unregister failed: ${errMsg(error)}`);
			}
		};
	}, `${name}: routes`);
}

//#endregion
export { apply, inject, name, resolveSettings };