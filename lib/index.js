import { C as optional, D as verbatim, E as str, S as obj, T as redactSecrets, _ as hasHardQuotaWordingIn, a as resolveSettings, b as degrade, c as LLM_PROVIDER_ID, d as isVisionModel, f as normalizeEntry, h as textToImageModelIds, i as name, m as rosterWithAvailability, n as inject, p as resolveAllowedList, r as isAdmitted, s as LLM_DISPLAY_NAME, t as PLUGIN_VERSION, u as imageGenModelIds, v as looksLikeRateLimit, w as pluginError, x as errMsg } from "./host-config.js";
import { basename, join } from "node:path";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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
* **但「环境在最末」只在 service.resolve() 缺席或返回空时才成立**（实测 2026-10-05，
* dsh-credentials-local/lib/index.js:429）：官方凭据服务的 precedence 里，**启动时的
* 环境快照压过存储文件**（`inherited(ref)` 用 `launchEnvironmentOf(ctx).getFrom(ref,
* ["process"])`，是启动时**冻结**的快照，不是活的 `process.env`）。所以当环境里有
* `MODELSCOPE_API_KEY` 时，「凭据服务」这一层返回的就是环境那个值，面板保存的值
* **赢不过它**——而面板仍会显示「已保存」。两个后果：
* ①在 DSH 启动**之后**改环境变量（含 Windows 用户级变量）不会被看见，改完必须
* **完全重启** DSH 才进快照；
* ②重启让环境变量生效后，它会**反过来压过**面板保存的值。
* 这不是本模块能修的（分层在 peer 的凭据服务里），但它必须写在手边。
*
* 令牌有效性检查（零额度探针：故意缺 `messages`）属于 probe 路由的职责，
* 本模块只管存取与状态。**真机已回填（2026-10-04，SPIKE.md §结论 5）**：魔搭
* 不先校验消息体，缺 `messages` 的请求返回 **200（空壳）而非 400**，鉴权失败才
* 是 401。所以探针判定规则定为 **401/403 = 令牌坏；200/400 = 令牌好；429 = 限频中**
* ——早先「401 先于 400」的预期已被推翻（见 probe.ts 文件头与本模块 §state 注释）。
*
* @module dsh-connect-modelscope-token-plan/ms-auth
*/
/** 引用名：沿用本机凭据库里已存在的记录（README「三条事实」第 3 条）。 */
const TOKEN_REF = "MODELSCOPE_API_KEY";
/**
* 令牌形状：`ms-` + 至少 16 位十六进制，允许连字符分段（UUID 那种）。
*
* 存在的理由见 {@link createTokenStore} 的 `save`：脱敏闸是正则，遮不住它不
* 认识的形状，所以「什么形状能进来」必须在入口就钉住，而不是指望出口拦得住。
*
* **下限必须与 `util.ts#redactSecrets` 的 `ms-` 闸一致**（都是 16 位）：比它宽则
* 出现「进得来但遮不住」的缝，比它窄则无谓地拒掉合法令牌。两处同改——
* `test/credentials.test.mjs` 钉住这条一致性。
*/
const TOKEN_SHAPE = /^ms-[0-9a-f-]{16,}$/i;
/** 这个值长得像魔搭访问令牌吗？（只判形状，不判真伪——真伪要问上游。） */
function isPlausibleToken(value) {
	return typeof value === "string" && TOKEN_SHAPE.test(value.trim());
}
/**
* 构造令牌 store。
* @param {object} [options] - wiring。
* @param {object|Function|null} [options.credentials] - `ctx.credentials` 服务
*   或其 resolver；**每次使用时解析**（服务可能在本插件挂载之后才注册，
*   一次性查找会把错误的 "ephemeral" 断言冻进后续每个轮询）。
* @param {object} [options.env] - 环境源；**默认 `process.env`**。
*   测试经 `apply()` 的 `deps.env` 注入 `{}` 以隔离宿主环境——本文件时不能假设
*   「没有传就是要用真环境」以外的语义，但调用方可以（详见 types.ts 的 env 缝）。
*
*   `| undefined` 不是冗余：`tsconfig` 开了 `exactOptionalPropertyTypes`，
*   「可选」不允许被显式赋值为 `undefined`，而 `apply()` 是原样转发 `deps.env`
*   （产品侧不传时它就是 `undefined`）。不写这一半，转发点编译不过。
*/
function createTokenStore({ credentials = null, env = process.env } = {}) {
	/** 无凭据服务的 Host 的内存兜底。 */
	const memory = /* @__PURE__ */ new Map();
	/**
	* 最后一次零额度探针的结论（`TokenStatus.valid` / `checkedAt` 的唯一生产者）。
	*
	* 只活在本进程：重启即回到「未检查过」，那是诚实答案——`valid: null` 的语义本来
	* 就是「没检查过」，不是「检查过但没结论」。
	*
	* **只在令牌换手时清**（`save` / `forget`）：上一次的结论只对**那一把**令牌成立。
	* 换令牌后留着旧结论，等于让一个关于别的值的判断继续替新令牌说话——正是
	* `ephemeral` 那条修正反对的「不是判出来的、是碰巧对的」。env 在 DSH 启动时读
	* 一次，进程内不会换手，所以这两个入口是全部。
	*/
	let lastCheck = null;
	const resolveService = () => {
		return (typeof credentials === "function" ? credentials() : credentials) ?? null;
	};
	/**
	* 解析当前令牌与来源（实现体）。
	*
	* 提成局部函数而不是只做返回对象上的方法：`state()` 也要走同一条路，而方法里
	* 调 `this.resolve()` 是一个**解构即崩**的 footgun——`const { state } =
	* createTokenStore(...)` 之后 `this` 是 undefined，调用直接 TypeError。当前
	* 调用点都规规矩矩用方法调用所以没炸，但那是运气，不是设计。返回类型显式
	* 注解：这是快照 TokenStatus.source 联合类型的上游，靠推断会把字面量联合
	* 拓宽成 string。
	* @returns {Promise<{value: string, source: ("credentials"|"memory"|"env"|null)}>}
	*/
	const resolveToken = async () => {
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
	};
	return {
		/**
		* 把面板输入的令牌存成引用；原样存（不 trim），空白值视为没输入。
		*
		* **形状校验**：只接受 `ms-` + 至少 16 位十六进制（可含连字符分段）。这不是
		* 洁癖——`redactSecrets` 的脱敏闸是**正则**，只能遮它认识的形状；一个
		* `ms-short-abc` 这样的短值它遮不住，而任何非空字符串此前都能被存下来并作为
		* `Authorization: Bearer …` 发出（非标准形状的令牌是可达状态）。上游一旦把
		* 它回显进错误消息（`inference-client` 的几处都把上游 body 拼进错误文本），
		* 凭据就进日志与面板响应——撞红线 1。
		*
		* 收紧入口同时也修了 UX：粘错令牌时立刻得到一句明确的话，而不是等一次
		* 真机请求换来一个语焉不详的 401。
		*/
		async save(token) {
			const value = verbatim(token, "");
			if (typeof value !== "string" || value.trim() === "") throw new Error("a ModelScope token is required");
			if (!isPlausibleToken(value.trim())) throw new Error("that does not look like a ModelScope access token (expected ms- followed by hex digits)");
			const service = resolveService();
			if (service !== null && typeof service.set === "function") {
				await service.set(TOKEN_REF, value);
				memory.set(TOKEN_REF, value);
			} else memory.set(TOKEN_REF, value);
			lastCheck = null;
		},
		/**
		* 忘掉面板保存的令牌。env 回退**不动**——清面板引用不能删操作者的 .env。
		*
		* 失败**向上传播**（由路由脱敏后呈报），不静默：凭据文件只读（EACCES）或
		* 服务实现里 unset 抛错时，吞掉错误会让路由回 `ok: true` + `source: credentials`，
		* 而令牌**仍在 `~/.dsh/.credentials.yaml` 里并且仍被 resolve() 读回来**。
		* 「忘掉令牌」是一个安全动作，谎报成功比失败更糟——用户以为凭据已删干净。
		* 内存副本无论如何都先清掉（它才是本进程真正持有的那份）。
		*/
		async forget() {
			memory.delete(TOKEN_REF);
			lastCheck = null;
			const service = resolveService();
			if (service !== null && typeof service.unset === "function") await service.unset(TOKEN_REF);
		},
		/**
		* 记录一次**零额度探针**的结论（probe 路由是唯一调用方）。
		*
		* 只接已经判出来的结论：`true`（200/400，令牌好）或 `false`（401/403，令牌坏）。
		* 429 / 上游错误 / 配置错误**不调用**——那些回答的是「上游现在忙不忙」或
		* 「这次请求成没成」，不是「这把令牌好不好」，把它们记进 `valid` 就是把限频
		* 说成令牌坏（正是 429 分诊那条修正反对的误判）。不调用即留着上一次的结论，
		* 那是已知的最好答案。
		*/
		noteValidity(valid) {
			lastCheck = {
				valid,
				checkedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
		},
		/**
		* 解析当前令牌与来源。
		* @returns {Promise<{value: string, source: ("credentials"|"memory"|"env"|null)}>}
		*/
		async resolve() {
			return resolveToken();
		},
		/**
		* 无秘密的状态描述（快照与面板消费）。
		*
		* `valid` / `checkedAt` 来自 `noteValidity`（零额度探针的结论），**本模块自己
		* 不做有效性断言**——判定规则在 probe 路由（401/403 = 令牌坏、200/400 = 令牌好，
		* 2026-10-04 真机回填；SPIKE.md §结论 5）。没探过就是 `null`，那不是「无效」，
		* 是「没检查过」。
		*
		* `ephemeral` 答的是「**手里这个值**重启会不会丢」，不是「有没有凭据服务」
		* ——wire 的定义是前者。曾经只按「服务缺席」置位，于是两种都说谎：没有服务
		* 时若令牌来自 env（重启不丢）被标 ephemeral；服务在场时面板保存的值被标非
		* ephemeral（那是碰巧对，不是判出来的）。按来源答：
		* `memory` 才真的只在本次进程存活期间存在。
		*/
		async state() {
			const { source } = await resolveToken();
			return {
				present: source !== null,
				source: source === null ? "none" : source,
				valid: lastCheck === null ? null : lastCheck.valid,
				checkedAt: lastCheck === null ? null : lastCheck.checkedAt,
				ephemeral: source === "memory"
			};
		}
	};
}

//#endregion
//#region src/host/state-store.ts
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
*
* @module dsh-connect-modelscope-token-plan/state-store
*/
/**
* DSH 主目录：操作者导出了 `DSH_HOME` 就用它，否则回落到 `~/.dsh`。
* @returns {string} 主目录。
*/
function dshHome() {
	return str(process.env.DSH_HOME, join(homedir(), ".dsh"));
}
/**
* 本插件存放状态的位置：`$DSH_HOME/state/<name>`。
* @param {string} name - 插件自己的状态目录名（即 `host-config.ts` 的 `name`）。
* @returns {string} 目录路径。
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
* 该字符串能否安全地作为**一个**路径段使用？
* @param {unknown} value - 候选 profile 名。
* @returns {boolean} 通过 {@link PROFILE_SEGMENT_RE} 即为 true。
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
* @param {object} [ctx] - Host 交给 `apply()` 的 Cordis context。
* @returns {string|null} profile 名，取不到或不安全时为 `null`。
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
/**
* 写一个状态文件：一个 0600 临时文件，然后 rename。
*
* 载荷串以换行结尾，与本模块存在前每个 store 的写法一致。失败**向上传播** ——
* 调用方自己决定只读 Home 要不要吞（throttle/catalog 吞，provider 开关不吞）。
*
* ## rename 失败时的临时文件清理
*
* `rename` 会失败，而最常见的原因是 Windows 上目标文件正被另一个进程/编辑器
* 占着（EACCES/EPERM）。临时文件此前**留在原地**：名字是
* `<base>.<pid>.<ts>.<uuid>.tmp`，每次失败多一个，于是
* `state/<profile>/<name>/` 慢慢堆满垃圾，而没有任何代码会去清它们（全仓原本
* 无任何 unlink）。现在失败时删掉自己的临时文件再重抛——清理失败不掩盖原始错误
* （那才是调用方要处理的），所以只 `catch {}`。
*
* @param {string} file - 最终文件路径。
* @param {string} payload - 序列化后的正文（JSON 文本）。
* @param {{temporary: string}} options - 先写哪个临时路径。
* @returns {Promise<void>}
*/
async function writeStateFile(file, payload, { temporary }) {
	await writeFile(temporary, `${payload}\n`, {
		encoding: "utf8",
		mode: 384
	});
	const handle = await open(temporary, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, file);
	} catch (error) {
		try {
			await unlink(temporary);
		} catch {}
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
const STATE_READ_TTL_MS = 1e3;
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
* `inheritFrom` 是一次性迁移缝：按 profile 分段后，本 profile 的新文件
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
async function readStateVersion(file) {
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
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
function createStateWriteQueue() {
	let chain = Promise.resolve();
	return { enqueue(task) {
		const run = chain.then(task);
		chain = run.then(() => void 0, () => void 0);
		return run;
	} };
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
async function guardStateWrite(file, known, options) {
	const base = basename(file);
	let existing;
	try {
		existing = await readStateVersion(file);
	} catch (error) {
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
function stateVersionNote(options) {
	return `${options.label}: ${basename(options.file)} holds version ${options.version}, which this build cannot read (this build knows ${options.known.join("/")}); ${options.consequence} Upgrade this build to see the saved values, or delete the file to reset them.`;
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
/**
* 面板按它分流的稳定码表 —— Client 的 `GUIDANCE_BY_CODE` 以这份表的键为契约，
* 新增/改名必须同步 Client，否则内部错误没有引导文案（见下 `INTERNAL_ERROR`）。
*/
const CODE = Object.freeze({
	CONFIG_ERROR: "config_error",
	NETWORK_ERROR: "network_error",
	TIMEOUT_ERROR: "timeout_error",
	AUTH_ERROR: "auth_error",
	RATE_LIMITED: "rate_limited",
	QUOTA_EXCEEDED: "quota_exceeded",
	UPSTREAM_ERROR: "upstream_error",
	/**
	* 插件自身抛错（聚合器、状态层、路由之外的意外）。
	*
	* 曾经只作为 `soft()` / `failureCode()` 的兜底字符串出现在快照里，没进这张
	* 表——于是 Client 的 `GUIDANCE_BY_CODE` 也没法映射它（那份映射被测试钉住
	* 「每个键必须在 CODE 里」），最需要人看的内部错误反而没有引导文案。
	* 正式收进码表，两端从此同一份真源。
	*/
	INTERNAL_ERROR: "internal_error",
	/**
	* Client 自产码：Host 响应无法解读成快照（非 JSON / 缺 ok 字段）时，
	* 面板用它走引导文案，而不是把裸英文串（"unexpected payload"）上屏。
	*
	* 本表是 `GUIDANCE_BY_CODE` 的键集真源（panel.test §2 钉「每个键必须在
	* CODE 里」、§3c 钉「每个码必须有引导」）——新增 client 码必须同时进
	* 这张表，两侧才同步。
	*/
	PAYLOAD_ERROR: "payload_error"
});
/**
* 把上游 HTTP 状态归类成稳定码。
*
* 401/403 → AUTH_ERROR（换令牌能修，绝不自动重试——魔搭没有锁号问题，
* 但重试一个坏令牌只会刷屏）；429 由调用方先走 {@link classifyRateLimit}
* 分诊，这里只兜底；其余 4xx/5xx → UPSTREAM_ERROR；低于 400 → NETWORK_ERROR。
*/
function classifyStatus(status) {
	if (status === 401 || status === 403) return CODE.AUTH_ERROR;
	if (status === 429) return CODE.RATE_LIMITED;
	if (status >= 400) return CODE.UPSTREAM_ERROR;
	return CODE.NETWORK_ERROR;
}
/**
* 429 的文案分诊：quota（当日/单模型额度耗尽，重试无意义）vs rate_limit
* （每分钟限频，退避有用）。
*
* 判据**复用 `llm-error-fix.ts` 的 {@link looksLikeRateLimit}**（限频信号 +
* 硬额度措辞的二元区分），不再在这里维护第二份词表——两个词表必然漂移，而漂移
* 的后果是插件内部两层互相抵消。
*
* 为什么曾经判错：这张表原来把 `"limit reached"` / `"daily"` / `"次数"` 归进
* quota 桶，于是
*
*   - `"Rate limit reached, please retry after 60 seconds"` → quota（应为 rate_limit）
*   - `"429 rate limit reached for rpm"`                → quota（应为 rate_limit）
*   - `"请求过于频繁，请稍后重试"`                        → quota（"次数" 命中）
*
* 后果很具体：`inference-client` 据此选 `QUOTA_EXCEEDED`，而 `llm-retry.ts`刻意
* 把 QUOTA 排除在可重试之外 —— 瞬时限频被当成耗尽、快失败且不重试；面板事件流
* 还会把 rpm 限频显示成「额度耗尽」，与 `llm-error-fix.ts` 那套「429 不是耗尽」
* 的纠正层在同一条数据上自相矛盾。
*
* 语义顺序：**限频信号优先，硬额度措辞兜底**。`looksLikeRateLimit` 正是这个
* 二元判定（有限频信号且无硬额度措辞），所以它说 true → rate_limit；说 false
* 时需要区分「有硬额度措辞的真耗尽」与「完全读不懂」，前者 quota、后者按更安全
* 的默认归 rate_limit。
*/
function classifyRateLimit(message) {
	if (typeof message !== "string" || message.length === 0) return "rate_limit";
	if (looksLikeRateLimit(message)) return "rate_limit";
	return hasHardQuotaWording(message) ? "quota" : "rate_limit";
}
/** 文本是否含硬额度措辞（真耗尽，不纠正）——直接问 llm-error-fix 的那张表。 */
function hasHardQuotaWording(message) {
	return hasHardQuotaWordingIn(message);
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
	const en = String(message).match(/(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i);
	if (en) {
		const value = Number(en[1]);
		const unit = (en[2] ?? "seconds").toLowerCase();
		const multiplier = unit.startsWith("min") ? 60 : unit.startsWith("h") ? 3600 : unit.startsWith("d") ? 86400 : 1;
		if (Number.isFinite(value) && value > 0) return value * multiplier * 1e3;
	}
	return null;
}

//#endregion
//#region src/host/usage-store.ts
/**
* 本地用量存储——面板「额度」tab 的数据真源。
*
* 为什么存在：官方只给**总**魔粒余额（`/openapi/v1/magicubes/balance`），不给
* 「哪个模型吃了多少、刚才谁在限频」。本 store 是那半边问题的答案——面板头条是
* 官方余额（真实值），本文件供的是分布 / 趋势 / 429 事件流。**不提供**「剩余次数」
* 推算：次数口径的上限是社区快照，与魔粒并排是误导，那条推算已从面板删除。
*
* 写入侧**只有** `usage-observer.ts`（在 provider 流出口观测真实对话）。面板上
* 没有任何入口能直接记一笔用量——早先 probe 路由的 `kind:"usage"` 试调已删除。
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
/**
* 路径在不在（任何 fs 错误都读作「不在」——存在性问的是能不能 `ls` 到它。
* EACCES 让 `stat` 失败时，真相其实是「在，只是看不见」，而对下面的判据来说
* 那同样不能被当成「没有记录」）。
*/
async function pathExists(file) {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
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
	/** 写串行化：读-改-写必须排队，两个并发 recordCall 不能互相覆盖。
	队列实现在 state-store（{@link createStateWriteQueue}）——provider / draw
	同款，三份私有副本正是 draw-store 曾经三件全缺的入口。 */
	const writeQueue = createStateWriteQueue();
	/**
	* 磁盘版本闸 —— 读路径与写路径**各自**调用，不共享副作用。
	*
	* 为什么必须两边都直接调（而不是让读路径置位、写路径顺带检查）：这个函数
	* 早先只在 `readThrough` 里被调用，而写路径的守卫写在 `enqueue` 开头——那时
	* `readOnly` 还没被置位（置位发生在随后的 `cache.read()` 内部），于是**守卫永远
	* 比真正的探测晚一步**，旧构建会用一个空载荷把新构建的 usage.json 降级覆写
	* （实测：version 2 → 1，110 次历史归零，而日志还在说 "recording disabled to
	* avoid clobbering"——日志与磁盘状态互相撒谎）。
	*
	* 现在写路径在 mutate 之前**自己**读一次盘，判据与执行之间不再隔着一个 await。
	*
	* @returns `true` = 磁盘版本比本构建新（写必须拒绝）；`false` = 可以写。
	*/
	const diskVersionBlocksWrites = async () => {
		let onDisk;
		try {
			onDisk = await readStateVersion(file);
		} catch (error) {
			const note = `usage-state: usage.json exists but cannot be read (${redactSecrets(errMsg(error))})`;
			if (!readOnly) logger?.warn?.(`${name}: ${note} — recording disabled to avoid clobbering`);
			anomaly = note;
			readOnly = true;
			return true;
		}
		if (onDisk !== null && !isKnownStateVersion(onDisk, KNOWN_VERSIONS)) {
			const note = `usage-state: on-disk version ${onDisk} is newer than this build knows`;
			if (!readOnly) logger?.warn?.(`${name}: ${note} — recording disabled to avoid clobbering`);
			anomaly = note;
			readOnly = true;
			return true;
		}
		if (readOnly) {
			logger?.warn?.(`${name}: usage-state: version guard lifted (on-disk version ${onDisk ?? "none"}) — recording resumed`);
			readOnly = false;
		}
		return false;
	};
	/** 读盘（缓存穿透）；返回 null = 无记录或损坏。 */
	const readThrough = async () => {
		if (await diskVersionBlocksWrites()) return null;
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
	const enqueue = (mutate) => writeQueue.enqueue(async () => {
		if (await diskVersionBlocksWrites()) return;
		const payload = await readThrough() ?? (loaded ? current : null) ?? {
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
		/**
		* 今天（本地时区）的账户级计数。
		*
		* 三种答案，三种含义，**不可合并**（wire.ts DailyUsage 的语义基线）：
		*   - `0` —— 确实一次都没有（没记录，或今天还没有桶）；这是可信的日常值；
		*   - `null` —— **读不到**：文件在，但本构建看不懂它（损坏 / 形状不对 / 更新
		*     构建写的版本 / 存在却不可读）。面板渲染「—」；
		*   - 数字 —— 今日次数。
		*
		* 判据是「文件在不在」而不是「载荷读没读出来」：**文件不存在**才是真实的 0
		* （这台 Host 从未经本插件调用过，不是数据丢失），而**文件在却读成空**代表
		* 我们失去了那部分信息——把它报成 0 会让操作者以为今天没调用过，真相是他
		* 不知道。
		*
		* 这是 2026-10-16 补上的一块拼图：`routes.test.mjs` 早有一条
		* 「本地计数读不到 → null，绝不是 0」的断言，但它只能用一个**会抛错的桩**
		* 造出那条路径（注释原话：「挂载的真实 store 造不出『读的时候抛』」）——
		* 真实 store 把所有读失败都吞成了空载荷。于是 null 那份语义在 wire.ts、
		* `cards.ts`、`snapshot-aggregate.ts` 里写了三遍，却从未在本机真的产出过。
		*
		* @returns {{dateKey: string, calls: number|null, tokens: number|null}}
		*/
		async daily() {
			const payload = await cache.read();
			const dateKey = localDateKey(now());
			if (payload === null) {
				const stored = await pathExists(file);
				return {
					dateKey,
					calls: stored ? null : 0,
					tokens: stored ? null : 0
				};
			}
			const day = payload.days[dateKey] ?? null;
			return day === null ? {
				dateKey,
				calls: 0,
				tokens: 0
			} : {
				...day,
				dateKey
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
*
* `seq` is the ONE monotonic source both bumps draw from (see
* {@link clearCoalescedFetch}): `global` is a high-water mark that only a global
* clear moves, and `keys` holds one absolute number per individually-cleared
* key. `keys` is therefore bounded by the number of distinct keys cleared since
* the last global clear — not swept, because a per-key number must outlive any
* in-flight flight born under it, while a later global clear wipes them all.
*/
const GENERATIONS = /* @__PURE__ */ new WeakMap();
/** The (created-on-demand) generation state belonging to one cache map. */
function generationsOf(cache) {
	let state = GENERATIONS.get(cache);
	if (state === void 0) {
		state = {
			global: 0,
			seq: 0,
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
	gens.seq += 1;
	if (key === void 0) {
		gens.global = gens.seq;
		cache.clear();
		inflight.clear();
		gens.keys.clear();
		return;
	}
	gens.keys.set(key, gens.seq);
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
	* @param {string} key - the cache key: a URL, or a key that also carries a
	*   credential fingerprint when the answer depends on which token is in play.
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
//#region src/host/context-catalog.ts
/**
* 内置上下文窗口策展表——魔搭目录不声明窗口时的第三方真值来源。
*
* 魔搭 `/v1/models`（及模型详情端点）只回基础标识字段（id/object/owned_by/
* created + Tasks 标签），没有窗口字段；未声明窗口的条目会一路落到
* `FALLBACK_CONTEXT_WINDOW`（128k）。这张表在「用户全局档位」之外补第三级
* 真值：目录声明 > 用户覆盖 > **策展表** > 兜底。
*
* 数据来自 models.dev 聚合（github.com/anomalyco/models.dev，MIT；api.json
* 构建产物）。魔搭 provider 自身在 api.json 只有 7 个不在当前目录的旧模型，
* 所以每条真值取的是**同 id 模型在各厂自家 host 下的主流 limit.context**——
* 跨 host 抄写的开量窗口是模型出厂规格，不是各网关的部署配额，取多数而非
* 最大值：个别网关把窗口抄大（如 openrouter 抄 1M）不代表魔搭侧真开那么宽。
*
* 维护纪律：
* 1. 只收**当前魔搭目录里真实存在**的 id（2026-10-16 实拉 `/v1/models` 全集
*    37 个中筛出 19 个）；目录下架的条目应随手删除，表不是历史档案。
* 2. 每条注明来源 host 与核对日期；有多个数据源时写主流值并留离群说明。
* 3. 覆盖优先级由 `curatedWindowOf` 的调用方（inference-client 打标）保证：
*    目录声明过窗口的条目不进打标，策展表永不推翻平台声明。
* 4. 生图/语音模型（Qwen-Image-Edit、ACE-Step 等）无对话上下文，不收。
*/
/** id → 标称上下文窗口（tokens）。键必须与魔搭目录 id 逐字一致。 */
const CURATED_CONTEXT_WINDOWS = {
	"deepseek-ai/DeepSeek-V4-Flash-0731": 1048576,
	"deepseek-ai/DeepSeek-V4-Pro": 1048576,
	"deepseek-ai/DeepSeek-V4-Pro-0813": 1048576,
	"deepseek-ai/DeepSeek-V4.1-Flash": 1048576,
	"meituan-longcat/LongCat-Flash-Lite": 256e3,
	"MiniMax/MiniMax-M1-80k": 1e6,
	"MiniMax/MiniMax-M3": 1048576,
	"nex-agi/Nex-N2.5-mini": 262144,
	"nex-agi/Nex-N2.5-Pro": 262144,
	"Qwen/Qwen3.5-122B-A10B": 262144,
	"Qwen/Qwen3.5-27B": 262144,
	"Qwen/Qwen3.5-35B-A3B": 262144,
	"Qwen/Qwen3.5-397B-A17B": 262144,
	"Qwen/Qwen3.8-27B": 262144,
	"Qwen/Qwen3.8-Flash-Next": 262144,
	"stepfun-ai/Step-3.5-Flash": 262144,
	"stepfun-ai/Step-3.7-Flash": 262144,
	"ZhipuAI/GLM-4.7-Flash": 2e5,
	"ZhipuAI/GLM-5.2": 1e6
};
/**
* 查策展窗口：命中返回正数，未命中返回 null（调用方继续走兜底）。
*
* 只认逐字 id——不做大小写/前后缀模糊匹配，宁可查不到落兜底，也不把
* 相近 id 的窗口张冠李戴。值合法性再挡一道（表内只应出现正数）。
* @param {string} id - 模型 id（魔搭目录原样拼写）。
* @returns {number|null} 标称窗口，未收录为 null。
*/
function curatedWindowOf(id) {
	if (typeof id !== "string" || id === "") return null;
	const value = CURATED_CONTEXT_WINDOWS[id];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
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
	/**
	* 丢弃一个我们不读的响应体。
	*
	* undici 里未消费的 body 会**占住连接**直到 GC。目录刷新会对 35 个模型并发打
	* 详情端点（`Promise.all` 分批），其中任何一条走「!ok」或「形状不符」分支，
	* 连接就一直挂着——短时间内连接池被这些挂起的响应吃满，后面的请求开始排队。
	*
	* `cancel()` 是显式的弃权：告诉 undici「这个 body 我不要了」，它会立刻释放
	* 连接而不是等GC。用 `void` 前缀是因为这是best-effort——取消失败不影响我们
	* 已经决定返回 `[]` 的结论。
	*/
	const discardBody = (response) => {
		try {
			response.body?.cancel();
		} catch {}
	};
	/** 读响应 body 里的 OpenAI 错误文案（形状漂移时返回空串，不抛）。 */
	const readErrorMessage = async (response) => {
		try {
			const body = await response.json();
			const message = body?.error?.message ?? body?.message;
			return typeof message === "string" ? message : "";
		} catch {
			discardBody(response);
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
		if (!response.ok) {
			discardBody(response);
			return [];
		}
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
		*
		* `contextOverride`（tokens）是面板保存的全局上下文窗口覆盖：非 null 时在
		* 归一**之前**改写每条原始条目——删掉目录可能携带窗口的四个原始拼写键、写上
		* `contextWindow`。这是唯一能可靠生效的注入点：`normalizeEntry` 按
		* `context_length/context_window/contextWindow/max_context_tokens` 顺序读
		* 首个正数，任何只改归一后字段的窄打标都会被 `...source` 展开里的旧键回读
		* 污染。删四键再写宽形状键，不依赖键序，目录声明与覆盖不可能同时在场。
		* descriptor、roster、catalogSignature 都从这份归一条目派生，一处打标全链
		* 路生效；签名含窗口值，覆盖变化自动触发重新注册。
		*
		* 覆盖值**参与缓存键**：coalesced 缓存里存的条目已是打标后的形状，若仍用
		* 字面量 `"models"` 键，保存覆盖后的一个 TTL 内会读到未打标的旧条目（面板
		* 显示变了、注册却没变）。带指纹后不同覆盖值各自缓存，互不串味。
		*
		* 窗口三级真值链（fetchModels 内单点判定）：目录声明 > 用户覆盖 >
		* **策展表**（context-catalog，models.dev 交叉真值，零网络依赖）> 兜底
		* 128k。目录声明过的条目任何下层都不碰；策展表只在用户没设覆盖时兜在
		* 兜底之前——它是「更聪明的 128k」，不是新权威。
		* @param {number|null} [contextOverride] - 全局窗口覆盖（tokens），null = 跟随目录。
		*/
		async fetchModels(contextOverride) {
			const url = settings.apiBase + "/models";
			return await read(`models:${contextOverride ?? "catalog"}`, async () => {
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
					const source = {
						...raw,
						tasks: tags.length > 0 ? tags : void 0
					};
					const CONTEXT_KEYS = [
						"context_length",
						"context_window",
						"contextWindow",
						"max_context_tokens"
					];
					if (!CONTEXT_KEYS.some((key) => {
						const value = source[key];
						return typeof value === "number" && Number.isFinite(value) && value > 0;
					})) {
						if (contextOverride != null) {
							for (const key of CONTEXT_KEYS) delete source[key];
							source.contextWindow = contextOverride;
							source.__contextSource = "override";
						} else {
							const curated = curatedWindowOf(id);
							if (curated !== null) {
								for (const key of CONTEXT_KEYS) delete source[key];
								source.contextWindow = curated;
								source.__contextSource = "curated";
							}
						}
					}
					return normalizeEntry(source);
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
		* 一次 probe 调用：故意缺 messages 的请求（**零额度**鉴权探针，语义已真机
		* 回填，SPIKE.md）。魔搭**不先校验 messages**——缺 messages 返回 200（空壳）
		* 而非 400，故判定规则是 401/403 = 令牌坏、200/400 = 令牌好、429 = 限频中。
		*
		* 失败抛 pluginError；调用方（probe 路由）负责把它记进事件流。
		*/
		async probe({ modelId }) {
			if (typeof modelId !== "string" || modelId.trim() === "") throw pluginError(CODE.CONFIG_ERROR, "probe: modelId is required");
			const { value: token } = await tokenStore.resolve();
			if (token === "") throw pluginError(CODE.AUTH_ERROR, "no ModelScope token configured — set MODELSCOPE_API_KEY or save one in the panel");
			const startedAt = Date.now();
			const payload = {
				model: modelId,
				stream: false
			};
			const response = await fetchWithTimeout(settings.apiBase + "/chat/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer " + token
				},
				body: JSON.stringify(payload)
			});
			const elapsedMs = Date.now() - startedAt;
			if (response.status === 401 || response.status === 403) {
				const message = await readErrorMessage(response);
				throw pluginError(CODE.AUTH_ERROR, redactSecrets(message === "" ? "token rejected (HTTP 401/403)" : message));
			}
			if (response.status === 429) {
				const message = await readErrorMessage(response);
				const retryAfterMs = parseRetryAfterMs(response.headers, message);
				const triage = classifyRateLimit(message);
				const extra = retryAfterMs !== null && retryAfterMs !== void 0 ? { retryAfterMs } : {};
				throw pluginError(triage === "quota" ? CODE.QUOTA_EXCEEDED : CODE.RATE_LIMITED, redactSecrets(message === "" ? "modelscope returned 429 (probe on " + modelId + ")" : message), extra);
			}
			if (response.status >= 500) throw pluginError(CODE.UPSTREAM_ERROR, "modelscope returned HTTP " + String(response.status) + " (validity probe)");
			response.body?.cancel();
			return {
				ok: true,
				status: response.status,
				modelId,
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
* downgraded file costs one re-toggle, never a crash. The write side refuses
* to overwrite a version this build cannot read (ADR-006); the read side stays
* permissive but REPORTS the disagreement via `versionNote()`, because for the
* allow-list "unreadable" and "never saved" would otherwise collapse to the
* same answer — and that answer is "offer every model".
*
* The allow-list's empty-vs-absent distinction is the one this module guards:
* an EMPTY list means "no filter, offer every model", while `HIDE_ALL_MODELS`
* (`llm-models.ts`) is the caller-side sentinel for "offer nothing". Neither
* spelling is stored here as `null` — absence of a saved list reads as "no
* filter", which is the only safe default for a fresh install. A foreign file
* reads the same way, which is precisely why `versionNote()` exists.
*
* @module dsh-connect-modelscope-token-plan/provider-store
*/
/**
* The "nothing stored" payload. Every absent / unreadable / foreign read
* collapses here, so the three call sites that produce it stay in step instead
* of each spelling out the same three `null`s.
*/
const EMPTY_PAYLOAD$1 = {
	enabled: null,
	enabledIds: null,
	contextWindow: null,
	version: null
};
/** Shape version, bumped when the persisted form changes incompatibly. */
const PROVIDER_VERSION = 1;
/**
* Every persisted shape THIS build can read: the current version plus any
* historical ones. Bumping {@link PROVIDER_VERSION} means adding the new number
* here too — otherwise this build would refuse its own newest files.
*
* This list is asked in THREE places:
*   - the write side ({@link writePayload}, ADR-006): an on-disk version not in
*     this list was written by a NEWER build and must not be clobbered. That
*     caller asks `isKnownStateVersion(existing, ...)` rather than
*     {@link isKnownProviderVersion} on purpose — it must also admit `null`
*     ("no file at all"), which is the one situation where a write belongs.
*   - the READ side ({@link parseAt}) and the report ({@link versionNote} /
*     {@link describeProviderPayload}), which ask {@link isKnownProviderVersion}.
* Keeping the read side and the report on one predicate is what makes them
* unable to disagree about what a foreign version means.
*/
const KNOWN_PROVIDER_VERSIONS = [1];
/**
* Whether this build can read a file declaring `version`.
*
* THE single answer to that question. Note it is deliberately NOT
* `version === PROVIDER_VERSION`: the whitelist includes shapes this build can
* read but no longer writes, so comparing against the write version would make a
* version bump unreadable-of-its-own-files. The original bug behind this function
* was exactly that split — `parseAt` compared against the write version while the
* report asked the whitelist, so a bumped build read its own v1 files as "not
* set" while its report said "nothing to say": the silent collapse the read side
* exists to kill, resurrected by the upgrade procedure.
* @param {unknown} version - the value read off disk (may not be a number at all).
* @returns {boolean}
*/
function isKnownProviderVersion(version) {
	return typeof version === "number" && KNOWN_PROVIDER_VERSIONS.includes(version);
}
/**
* The directory this plugin's state lives in — per-profile when the Host names
* one, shared otherwise. Unlike the THROTTLE, which is deliberately shared
* across profiles, this answers "does THIS profile want the provider registered"
* and must not be overwritten by the other profile's Host.
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
* Normalize a context-window value: a positive finite number, or `null`
* ("follow the catalog"). Anything else — strings, zero, negative, NaN,
* Infinity — reads as no override, mirroring how {@link normalizeEnabled}
* answers "nothing usable" instead of inventing a default.
* @param {unknown} raw - the persisted or posted value.
* @returns {number|null} the window in tokens, or `null` when nothing usable.
*/
function normalizeContextWindow(raw) {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
	return raw;
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
* Resolve the allow-list to publish/display, from the persisted value and the
* list this process last published.
*
* THE single answer to "which list wins", so that every consumer asks it the
* same way: a READABLE persisted list wins — including an EMPTY one, because
* this module's contract defines `[]` as "no filter, offer every model" — and
* the in-memory list is consulted only when the persisted side could not be read
* at all (the caller's `.catch` turns a rejection into `null`).
*
* The three call sites used to spell this out separately, and two of them had
* drifted: `snapshot-aggregate.ts` and `routes/provider.ts` honoured an empty
* persisted list, while `index.ts` treated it as "no answer" and republished the
* remembered list. So after the operator deleted `provider.json` (the reset
* `versionNote` itself recommends) the panel reported `allowed: "all"` — its
* `enabledCount` counting every model — while the poller kept registering the
* OLD restriction: the panel and the Host disagreeing about what is served,
* which is precisely what the publish queue and the idle guards exist to
* prevent. One copy now, asked by all three.
* @param {unknown} stored - the persisted list, or `null` when unreadable.
* @param {unknown} remembered - `publisher.state.enabledIds` (last published).
* @returns {string[]} the list to use.
*/
function resolveEnabledIds(stored, remembered) {
	if (Array.isArray(stored)) return stored;
	return Array.isArray(remembered) ? remembered : [];
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
	* legacy adoption path) — several copies of this is exactly the drift this
	* module keeps getting bitten by.
	*
	* ADR-006 write-side guard: never overwrite a state file this build cannot
	* read. An unknown NUMERIC version means a NEWER build wrote it; clobbering
	* it destroys data we cannot even see. So the write is refused with a
	* `degrade` signal, not a silent no-op — swallow the failure, not the reason.
	* The guard itself lives in `state-store.ts` ({@link guardStateWrite}) — it is
	* the same promise draw-store makes, and two copies of "what may be
	* overwritten" is one copy too many.
	* @param {object} body - the JSON body to persist.
	* @returns {Promise<string|null>} the refusal reason when the write was
	*   refused (already `degrade`-logged), or `null` when it landed — the caller
	*   decides whether to surface the refusal to a user.
	*/
	const writePayload = async (body) => {
		const refusal = await guardStateWrite(filePath, KNOWN_PROVIDER_VERSIONS, {
			label: "provider",
			logger
		});
		if (refusal !== null) return refusal;
		await ensureStateDir(stateDir$1);
		await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary: temporaryOf(stateDir$1, "provider.json") });
		return null;
	};
	const legacyFile = dir === void 0 && profile ? join(stateDir(name), "provider.json") : null;
	/**
	* Read ONE payload off the disk, shape-checked.
	*
	* "Can this build read it" is asked through {@link isKnownProviderVersion} —
	* the same predicate the report and the write guard use. Comparing against
	* {@link PROVIDER_VERSION} instead would say "cannot read" about the OLDEST
	* shapes this build still knows, which is exactly wrong when it is bumped:
	* the header's upgrade rule adds the new number to {@link KNOWN_PROVIDER_VERSIONS},
	* so a v1 file must stay readable while v2 is written. Getting that wrong
	* makes this reader disagree with {@link versionNote} — reads "not set" while
	* the note says "nothing to say", which is the silent collapse this module
	* exists to kill. That split once existed in production code for one release.
	*
	* A version this build cannot read reads as EMPTY, but REMEMBERS which version
	* it was. The ADR-006 guard already refuses to overwrite such a file, so the
	* read side has to be able to say "there is an answer in there, it just is
	* not one we can see" — collapsing it to "never saved" is what made a saved
	* allow-list look like a deliberate "offer every model". See {@link versionNote}.
	*/
	const parseAt = async (file) => {
		const source = obj(await readStateJson(file));
		const version = typeof source.version === "number" ? source.version : null;
		if (!isKnownProviderVersion(version)) return {
			enabled: null,
			enabledIds: null,
			contextWindow: null,
			version
		};
		return {
			enabled: normalizeEnabled(source.enabled),
			enabledIds: normalizeEnabledIds(source.enabledIds),
			contextWindow: normalizeContextWindow(source.contextWindow),
			version
		};
	};
	/** Read the profile's own file, shape-checked. */
	const parsePayload = async () => parseAt(filePath);
	/** Read one payload off an explicit path (the legacy shared file). */
	const parsePayloadFrom = async (file) => parseAt(file);
	const writeQueue = createStateWriteQueue();
	const cache = createStateReadCache(async () => {
		const own = await parsePayload();
		if (own.enabled !== null || own.enabledIds !== null || legacyFile === null) return own;
		if (own.version !== null) return own;
		const legacy = await parsePayloadFrom(legacyFile);
		if (legacy.enabled === null && legacy.enabledIds === null) return own;
		const inherited = {
			version: 1,
			...legacy.enabled === null ? {} : { enabled: legacy.enabled },
			...legacy.enabledIds === null ? {} : { enabledIds: legacy.enabledIds },
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await writeQueue.enqueue(() => writePayload(inherited).then(() => void 0, () => void 0));
		return legacy;
	}, { ttlMs });
	const read = () => cache.read();
	/**
	* The payload the callers actually read. The short-TTL cache's `read()` is
	* typed `Promise<T | null>` because it doubles as "never read" signalling for
	* the §23 legacy adoption; a provider payload is always an object, so the
	* `null` branch collapses here, in one place, rather than at every caller.
	* @returns {Promise<ProviderPayload>} the payload; the empty payload when nothing is stored.
	*/
	const readPayload = async () => await read() ?? EMPTY_PAYLOAD$1;
	/**
	* Read one payload, then hand it to {@link writePayload} — the read-modify-
	* write that keeps the switch and the list from clobbering each other.
	*
	* Three-state keys, and they are SYMMETRIC between `enabled` and `enabledIds`:
	* a key the caller omits (`undefined`) keeps whatever is on disk, an explicit
	* `null` clears it back to "not set" (the ABSENCE of the key — that is how
	* {@link forget} expresses "fall back to the config default"), and any other
	* value is stored as given. An earlier `mergeEnabled` flag applied the
	* "keep what is on disk" rule to `enabled` unconditionally, which silently
	* discarded the very value a switch save was asked to store.
	*
	* 读-改-写**整段排队**：两个并发 patch 不能互相覆盖。这个 store 以前完全没有
	* 写串行化（对比 `usage-store.ts` 的 `writeChain`），于是面板开关 POST 与
	* roster POST —— 两个独立请求，外加 `index.ts` 轮询同时在调 `enabledIds()` ——
	* 会各自读到同一个 `current`，后写的赢。实测：先存清单，再并发 `save(true)` +
	* `saveEnabledIds([...])`，其中一次保存被**整个丢掉**（用户勾了模型又开了开关，
	* 两次点击只活下来一次）。文件头说「两个字段必须作为一个载荷读写，否则开关会
	* 覆盖清单」——设计意图是对的，但那只防住了「**不同字段**互相覆盖」；缺了串行化，
	* **同字段**与「两次都基于同一快照」的互相覆盖照样发生。链的形状与
	* `usage-store` 一致，且必须把 `writePayload` 的版本拒绝语义一起搬进临界区
	* （否则拒绝判断会落在锁外）。
	*
	* 链吞掉自己的失败继续走：一次只读 Home 上的写失败不该毒化后续所有保存。
	*
	* 写成功的同时更新读缓存，调用方不再各自回读一遍：缓存里永远是刚写下去的那份，
	* 而 `patchPayload` 的 `current` 来自磁盘（`parsePayload`，不走缓存），所以合并
	* 结果不会带进过期值。此前的写法是写完再 `readPayload()` 读回另一半——那条回读
	* 走的是 TTL 缓存，拿到的是**写入前**的值，并发时会把一个较新的缓存项顶成旧值。
	*
	* @param {object} patch - `{ enabled?, enabledIds?, contextWindow? }` to persist.
	* @returns {Promise<string|null>} the write refusal reason, or `null`.
	*/
	const patchPayload = (patch) => {
		return writeQueue.enqueue(async () => {
			const current = await parsePayload();
			/** `undefined` keeps the stored key; `null` clears it (key absent). */
			const body = { version: 1 };
			const enabled = patch.enabled === void 0 ? current.enabled : patch.enabled;
			if (enabled !== null) body.enabled = enabled;
			const enabledIds = patch.enabledIds === void 0 ? current.enabledIds : patch.enabledIds;
			if (enabledIds !== null) body.enabledIds = enabledIds;
			const contextWindow = patch.contextWindow === void 0 ? current.contextWindow : patch.contextWindow;
			if (contextWindow !== null) body.contextWindow = contextWindow;
			body.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
			const refusal = await writePayload(body);
			if (refusal === null) cache.remember({
				enabled,
				enabledIds,
				contextWindow,
				version: 1
			});
			return refusal;
		});
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
		* The saved context-window override (tokens), or `null` = follow the
		* catalog. `null` is a real answer here, not absence: the override is
		* optional by design, and the caller (snapshot / stamping) decides what
		* "follow the catalog" means.
		* @returns {Promise<number|null>}
		*/
		async contextWindow() {
			return (await readPayload()).contextWindow;
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
		* A human-readable note when the file holds a version this build cannot
		* read, or `null` when there is nothing to say.
		*
		* The READ side is permissive on purpose: a foreign file reads as "not set",
		* so the panel keeps working instead of failing the whole snapshot. The cost
		* is that it cannot tell "never saved" from "saved but unreadable" — and
		* for the allow-list those two read differently in the dangerous direction
		* (an empty list means "offer every model"). Writes are already protected by
		* the ADR-006 guard in {@link writePayload}; this note is the read side's
		* half of the same promise. The snapshot aggregate pushes it into
		* `shapeWarnings`, and `doctor.ts` reports the same file, so the operator
		* sees the disagreement instead of a switch that looks merely unset.
		*
		* @returns {Promise<string|null>}
		*/
		async versionNote() {
			const version = (await readPayload()).version;
			if (version === null || isKnownProviderVersion(version)) return null;
			return stateVersionNote({
				label: "provider-state",
				file: filePath,
				version,
				known: KNOWN_PROVIDER_VERSIONS,
				consequence: "the saved switch and allow-list are being answered as \"not set\", so the allow-list reads as \"no filter, offer every model\" while the switch falls back to the config default."
			});
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
			const refusal = await patchPayload({ enabled });
			if (refusal !== null) throw new Error(refusal);
		},
		/**
		* Persist the model allow-list, preserving the saved switch.
		* @param {string[]} ids - the ids to offer (empty = offer all).
		* @returns {Promise<void>}
		*/
		async saveEnabledIds(ids) {
			const list = normalizeEnabledIds(ids);
			if (list === null) throw new TypeError("provider allow-list expects an array of strings");
			const refusal = await patchPayload({ enabledIds: list });
			if (refusal !== null) throw new Error(refusal);
		},
		/**
		* Persist the context-window override, preserving the saved switch and
		* allow-list. `null` clears the override back to "follow the catalog".
		* @param {number|null} value - the window in tokens, or `null` to clear.
		* @returns {Promise<void>}
		*/
		async saveContextWindow(value) {
			const window = normalizeContextWindow(value);
			if (value !== null && window === null) throw new TypeError("provider context window expects a positive finite number");
			const refusal = await patchPayload({ contextWindow: window });
			if (refusal !== null) throw new Error(refusal);
		},
		/**
		* Forget the panel-saved values: the config default and "no filter" rule
		* again. The context override is forgotten WITH them — the reset button
		* means "back to the way this plugin ships", and the override is panel
		* state in exactly the same sense.
		* @returns {Promise<void>}
		*/
		async forget() {
			const refusal = await patchPayload({
				enabled: null,
				enabledIds: null,
				contextWindow: null
			});
			if (refusal !== null) throw new Error(refusal);
		}
	};
}

//#endregion
//#region src/host/draw-store.ts
/**
* 出图工具的开关与模型偏好——本插件**自己的**状态文件，与 provider 那条开关分开。
*
* 为什么不是第二个字段塞进 `provider.json`：两者回答的是不同问题。
* `provider.json` 说「这个 profile 要不要把魔搭作为 **chat provider** 提供」；
* 本文件说「要不要给 agent 一个**出图工具**」。用户完全可能只要其一（用工具出图但
* 不污染模型选择器，或反之）。合成一个 payload 会让「关掉出图」连带改掉 provider
* 清单的写入时序——provider-store 的注释已说明为什么它的两个字段必须同生共死，
* 而那组理由**不适用于**这两个开关（它们之间没有 atomicity 要求）。
*
* 落点与 `provider-store.ts` 一致：`$DSH_HOME/state/<plugin>/draw.json`（无 profile
* 时）或 `$DSH_HOME/state/<profile>/<plugin>/draw.json`。profile 分段的意思是
* 「这个 profile 要不要暴露出图工具」，两个 profile 不能互相覆盖。
*
* 优先级与所有 opt-in 开关同一份裁决（`switch-precedence.ts`）：面板保存值赢，
* 否则 `cordis.patch.yml` 的 `drawEnabled` 默认值说了算。
*
* 完整性三件套（与 provider / usage 同源，全部上收在 `state-store.ts`，本文件只做
* 调用方——2026-10-17 收敛：此前这里**三件全缺**，并发 `saveEnabled` +
* `saveModelId` 会丢一次保存、磁盘 version 比本构建新时降级覆写、读侧静默读作
* 「没设过」，正是 provider-store 注释里记着「咬过三次」的那类漂移的第四条）：
*   - **写串行化**（{@link createStateWriteQueue}）：读-改-写整体排队，临界区内
*     从磁盘重读基线（不用 TTL 缓存—— provider §8d 的回归用例），链吞自己的
*     失败继续走；
*   - **写守卫**（{@link guardStateWrite}，ADR-006）：盘上版本本构建读不懂时
*     拒写并给出理由，绝不降级覆写；「文件在场却读不出来」同样拒写（读不到 ≠
*     没有东西要保护）；
*   - **读侧说明**（{@link stateVersionNote}）：未知版本宽容读作「没设过」，但
*     {@link createFileDrawStore} 的 `versionNote()` 把「保存的开关与模型偏好
*     被忽略」说出口，快照聚合把它转进 `shapeWarnings`——不说，面板就把「保存的
*     值被忽略」呈现成「从未保存过」。
*
* 与 provider-store 的一处**有意差异**：没有 legacy（pre-profile 共享目录）继承。
* draw.json 随出图工具一起诞生，晚于按 profile 分段，市面上不存在共享布局里的
* 旧 draw.json；provider.json 则需要（§23 之前它一直在共享目录）。
*
* doctor 覆盖：`describeDrawPayload` 给只读速览，`doctor.ts` 据此把 draw.json
* 的「损坏 / 未知版本」报进症状表——写侧守卫挡覆盖，doctor 报静默降级。
*
* @module dsh-connect-modelscope-token-plan/draw-store
*/
/** 本 store 落盘 payload 的版本。 */
const DRAW_STORE_VERSION = 1;
/** 本 build 读得懂的版本集合（升级时把新号加进来，旧号保持可读）。 */
const KNOWN_DRAW_VERSIONS = Object.freeze([1]);
const EMPTY_PAYLOAD = {
	enabled: null,
	modelId: null,
	version: null
};
/**
* 本 build 读不读得懂这个版本。
*
* 与 provider-store 的 {@link isKnownProviderVersion} 同形：**白名单**判据，
* 不与 {@link DRAW_STORE_VERSION} 比较——升级后旧号仍要可读。读侧（parseAt）、
* 报告侧（versionNote / describeDrawPayload）问的都是这一个函数，三者不可能就
* 「什么是未知版本」说两套话。写侧问的是 `state-store` 的
* `isKnownStateVersion`（它额外放行 `null` = 没有文件，那是唯一该写的情形）。
* @param {unknown} version - 盘上读到的值（可能根本不是数字）。
* @returns {boolean}
*/
function isKnownDrawVersion(version) {
	return typeof version === "number" && KNOWN_DRAW_VERSIONS.includes(version);
}
/**
* 归一一个保存的模型偏好：非空字符串，或 `null`（= 自动挑——具体挑谁由
* `draw-runtime.ts` 的 `pickDrawModel` 优先级决定，不是简单取目录第一个）。
*
* 不校验「这个 id 是否真存在」——目录会变，存一个暂时不在目录里的 id 是合法的
* （用户可能先配好、等模型上线）。调用侧解析不出来时退回自动。
* @param {unknown} value - 原始值。
* @returns {string|null} 归一后的 id 或 `null`。
*/
function normalizeDrawModelId(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}
/**
* 归一保存的开关值：只有真正的 boolean 才算数，其余读作「没设过」。
* @param {unknown} value - 原始值。
* @returns {boolean|null} 归一后的开关。
*/
function normalizeDrawEnabled(value) {
	return typeof value === "boolean" ? value : null;
}
/** 本 store 的目录（与 provider-store 同一套分段规则）。 */
function drawStoreDir(profile, dir) {
	if (typeof dir === "string" && dir !== "") return dir;
	return profile ? profileStateDir(name, profile) : stateDir(name);
}
/**
* 文件支撑的出图开关 + 模型偏好。
* @param {StoreOptions} [options] - `{ dir, profile, ttlMs, logger }`。
* @returns {object} store 句柄。
*/
function createFileDrawStore(options = {}) {
	const { dir, profile = null, ttlMs = STATE_READ_TTL_MS, logger } = options;
	const stateDir = drawStoreDir(profile, dir);
	const filePath = join(stateDir, "draw.json");
	/**
	* 写一份补丁并落盘（内部用；对调用方暴露的是 saveEnabled / saveModelId / reset）。
	*
	* ADR-006 写守卫（{@link guardStateWrite}）先问盘：版本不认或文件读不出 →
	* 返回拒绝理由（已 degrade 记录），不落笔。守卫与随后的写入在同一个临界区里
	* （由 patchPayload 的链保证），判据与执行之间不隔任何 await。
	* @param {object} body - 要持久化的 JSON 体。
	* @returns {Promise<string|null>} 拒绝原因，或 `null` = 已写入。
	*/
	const writePayload = async (body) => {
		const refusal = await guardStateWrite(filePath, KNOWN_DRAW_VERSIONS, {
			label: "draw-state",
			logger
		});
		if (refusal !== null) return refusal;
		await ensureStateDir(stateDir);
		await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary: temporaryOf(stateDir, "draw.json") });
		return null;
	};
	/** 写串行化：读-改-写必须排队（详见{@link createStateWriteQueue}与文件头）。 */
	const writeQueue = createStateWriteQueue();
	/**
	* 解析一份 payload；认不出的版本读作「没设过」但**记住**版本号——读侧宽容、
	* versionNote 负责把宽容说出口（写侧守卫已挡住覆盖，两半合起来才是 ADR-006）。
	*/
	const parsePayload = async () => {
		const source = obj(await readStateJson(filePath));
		const version = typeof source.version === "number" ? source.version : null;
		if (!isKnownDrawVersion(version)) return {
			enabled: null,
			modelId: null,
			version
		};
		return {
			enabled: normalizeDrawEnabled(source.enabled),
			modelId: normalizeDrawModelId(source.modelId),
			version
		};
	};
	const cache = createStateReadCache(parsePayload, { ttlMs });
	/**
	* 读当前 payload。
	* @returns {Promise<DrawPayload>}
	*/
	const readPayload = async () => await cache.read() ?? EMPTY_PAYLOAD;
	/**
	* 读-改-写一份补丁，**整段排队**。
	*
	* 基线每次从磁盘重读（`parsePayload` 直读，不走 TTL 缓存）：两个 Host 进程
	* 共享一个状态目录，而缓存里可能是写入前的值——provider §8d 的回归用例
	* （两个写入者共享一个目录，回读把较新的缓存顶成旧值）在 draw 上同样成立。
	* 写成功即 `cache.remember`，调用方不必各自回读一遍。
	*
	* 失败语义与 provider-store 对齐：拒绝原因与 IO 失败都**向上抛**（save 抛、
	* 路由 catch 后 `respondError` 呈报），链自己吞掉失败继续走后面的保存。
	*
	* @param {{enabled?: boolean|null, modelId?: string|null}} patch - 要改的字段；
	*   `undefined` = 保留盘上的值，`null` = 清除（回到「没设过」）。
	* @returns {Promise<void>}
	*/
	const patchPayload = (patch) => writeQueue.enqueue(async () => {
		const current = await parsePayload();
		const enabled = patch.enabled === void 0 ? current.enabled : patch.enabled;
		const modelId = patch.modelId === void 0 ? current.modelId : patch.modelId;
		const body = { version: 1 };
		if (enabled !== null) body.enabled = enabled;
		if (modelId !== null) body.modelId = modelId;
		body.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		const refusal = await writePayload(body);
		if (refusal !== null) throw new Error(refusal);
		cache.remember({
			enabled,
			modelId,
			version: 1
		});
	});
	return {
		/** 面板保存的出图开关；`null` = 回退 patch 默认值。 */
		async enabled() {
			return (await readPayload()).enabled;
		},
		/** 面板保存的模型偏好；`null` = 自动。 */
		async modelId() {
			return (await readPayload()).modelId;
		},
		/** 这个 profile 是否被显式配置过。 */
		async isConfigured() {
			const payload = await readPayload();
			return payload.enabled !== null || payload.modelId !== null;
		},
		/**
		* 盘上带着本构建读不懂的版本时的一句说明，否则 `null`。
		*
		* 读侧宽容（未知版本读作「没设过」）的另一半：快照聚合把它转进
		* `shapeWarnings`，doctor 报同一份文件。没有它，「保存的开关与模型偏好
		* 被忽略」在面板上就是「从未保存过」——而回退方向是 patch 默认（通常=关）。
		* @returns {Promise<string|null>}
		*/
		async versionNote() {
			const version = (await readPayload()).version;
			if (version === null || isKnownDrawVersion(version)) return null;
			return stateVersionNote({
				label: "draw-state",
				file: filePath,
				version,
				known: KNOWN_DRAW_VERSIONS,
				consequence: "the saved draw switch and model preference are being answered as \"not set\", so the switch falls back to the config default and the model back to automatic selection."
			});
		},
		/** 保存开关。 */
		async saveEnabled(enabled) {
			if (typeof enabled !== "boolean") throw new TypeError("draw switch expects a boolean");
			await patchPayload({ enabled });
		},
		/** 保存模型偏好（`null` = 清掉，回到自动）。 */
		async saveModelId(modelId) {
			if (modelId !== null && (typeof modelId !== "string" || modelId.trim() === "")) throw new TypeError("draw model expects a non-empty string or null");
			await patchPayload({ modelId });
		},
		/** 清掉两个字段（回到「没配过」）。 */
		async reset() {
			await patchPayload({
				enabled: null,
				modelId: null
			});
		},
		/** 落盘路径（诊断与测试用）。 */
		filePath
	};
}

//#endregion
//#region src/host/draw.ts
/**
* 魔搭出图（`/v1/images/generations`）的**纯逻辑半边**——协议形状的解析与判定。
*
* 为什么是这个形状：魔搭的生图是**异步两段式**（提交得 `task_id`，轮询才出图），
* 与姊妹插件 `dsh-connect-sensenova-token-plan/src/host/draw.ts` 的**同步单发**
* （`drawOnce` 一次 fetch 即 `parseDrawResponse` 取 `data[0].url`）形状不兼容，
* **不能照抄**。可复用的只有外壳（endpoint 拼接、冷却门、失败文案），核心必须新写。
* 协议依据全部来自 `docs/SPIKE-image-gen.md` 的真机实测，非文档转述。
*
* 本模块**只做纯函数**：endpoint 构造、请求体构造、响应解析、状态判定、失败分诊。
* 它**不发起任何请求、不碰凭据、不注册工具**——那半边（fetch 注入、Host 工具注册）
* 与 `llm-adapter.ts` 一样 peer-dependent，测试覆盖同样是零（docs/ROADMAP.md Backlog）。
* 刻意 peer-free：纯函数部分能进离线 `npm test` 门禁，`test/draw.test.mjs` 钉住形状。
*
* 三条承重结论（全部实测，推翻了几条广泛流传的错误写法）：
*
* 1. **轮询必须带 `X-ModelScope-Task-Type: image_generation`**，否则上游一律返回
*    `task not found` + `task_status: FAILED`——**那是假失败**，任务实际正常。
*    缺这个头的实现会在第一次轮询就误判失败并放弃一张已经能出的图。
* 2. **提交响应的 `task_status` 不可信**：实测每次提交都回 `SUCCEED`，包括最终确实
*    `FAILED` 的那次。所以提交只认 `task_id`，**成功与否只看轮询终态**。
* 3. **`FAILED` 没有可分诊的形状**：`errors.code` 实测为 `0`、`errors.message` 为
*    空串，没有顶层 `message`。任何「从错误里读出原因」的承诺都是编造——本模块的
*    `describeDrawFailure` 因此**明确承认原因不可知**，只报可确定的形态差异。
*
* 关于两个小工具（`str` / `redactSecrets`）：它们曾以**本地私有副本**的形式活在
* 本文件里，理由是「避免为 3 行代码引 util 的依赖面」。那条理由不成立——util.ts
* 自己只有 type-only import（peer-free），同包的 `draw-runtime.ts` 早就 import 它；
* 而私有副本已经漂移：脱敏正则少了 `sk-` 与密码键值对两组、`ms-` 的 charset 与
* util 版不一致（`[A-Za-z0-9-]` vs `[0-9a-f-]`）——脱敏闸漏一条就是凭据外泄
* （红线 1）。现在一律用 util 的单一副本。
*
* @module dsh-connect-modelscope-token-plan/draw
*/
/**
* 出图请求的截止时间（墙钟毫秒）。
*
* **15 分钟**：实测同一模型的耗时在 61s–537s 之间大幅波动（免费池排队），
* 且**超时放弃不等于任务死亡**——上游任务会继续跑完（记录之后还会被回收，
* 见 docs/SPIKE-image-gen.md §坑 5）。宁可多等，不要扔掉一张已在生成的图。
*/
const DRAW_TIMEOUT_MS = 9e5;
/**
* 两次轮询之间的间隔（毫秒）。
*
* 取 15s 的**真正理由**是「够用且不浪费」：实测最慢一次 537s，15s 间隔意味着
* 最多几十次查询，代价可忽略；而更密（社区示例的 5s）没有观测收益。
*
* ⚠️ 早先曾写「更密的轮询拖慢任务」，**该归因已推翻**——后续对照显示同一模型、
* 同样 15s 轮询的耗时是 61s → 261s → 537s 单调恶化，是**上游排队时长在波动**。
* 那次构成「证据」的 5s vs 30s 对照，控制变量没做，不足以支撑因果。
* 详见 docs/SPIKE-image-gen.md §坑 4（含撤回记录）。
*/
const DRAW_POLL_INTERVAL_MS = 15e3;
/** 轮询的总截止时间；与 `DRAW_TIMEOUT_MS` 同量级但独立可调（诊断时可放宽）。 */
const DRAW_POLL_DEADLINE_MS = DRAW_TIMEOUT_MS;
/**
* 轮询必须携带的头名与取值。
*
* 漏掉它 → 上游返回 `task not found` + `FAILED`，而任务其实在正常跑。这是本协议
* 最贵的单点知识，也是第一份外部资料缺失的那一块。
*/
const TASK_TYPE_HEADER = "X-ModelScope-Task-Type";
const TASK_TYPE_IMAGE_GENERATION = "image_generation";
/**
* 一次出图请求由几个 HTTP 请求组成：一次提交 + N 次轮询。
* 只作为文档性常量，供工具描述与测试引用。
*/
const DRAW_PHASE = Object.freeze({
	submit: "submit",
	poll: "poll"
});
/**
* 读一个响应的 `task_status`，取不到返回 `null`。
*
* 刻意**不猜**：字段缺失或类型不对都返回 `null`，由 `isTerminalStatus` 把它当作
* 「非终态」继续等——这样一次形状漂移最多变成多轮轮询，不会变成误报失败。
* @param {unknown} data - 已解析的 JSON。
* @returns {DrawTaskStatus|null} 规范化状态，取不到为 `null`。
*/
function readTaskStatus(data) {
	if (data === null || typeof data !== "object") return null;
	const raw = data.task_status;
	if (typeof raw !== "string") return null;
	const upper = raw.trim().toUpperCase();
	if (upper === "PENDING" || upper === "RUNNING" || upper === "SUCCEED" || upper === "FAILED") return upper;
	return null;
}
/**
* 一个状态是不是终态。
*
* **只有** `SUCCEED` / `FAILED` 是终态；`null`（读不到）与一切未知值都**不是**。
* 「未知值继续等」是刻意的：把上游新增的状态误判成失败会丢掉一张已经能出的图，
* 而误判成进行中最多多等几轮（受 `DRAW_POLL_DEADLINE_MS` 兜底）。
* @param {DrawTaskStatus|null} status - 规范化状态。
* @returns {boolean} 是否终态。
*/
function isTerminalStatus(status) {
	return status === "SUCCEED" || status === "FAILED";
}
/**
* 从提交响应里取 `task_id`。
*
* 提交响应里那个 `task_status: "SUCCEED"` **一律忽略**（见模块头第 2 条：它与终态
* 无关）。本函数只认 `task_id`，所以一个「提交即失败」的上游只要给了 id 就仍会被
* 轮询，而不给 id 会被当作提交失败——这两种都符合实测。
* @param {unknown} data - 已解析的提交响应。
* @returns {string|null} 任务 id，取不到为 `null`。
*/
function readTaskId(data) {
	if (data === null || typeof data !== "object") return null;
	const raw = data.task_id;
	return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}
/**
* 从终态响应里取出成品图的 URL 列表。
*
* 实测形状是顶层 `output_images: string[]`。**刻意不读** `data[0].url`（OpenAI
* 同步形状）与 `output.image_url`（外部资料误传的形状）——两者在魔搭上都不存在。
* @param {unknown} data - 已解析的轮询响应。
* @returns {string[]} 可用的图片 URL（保持上游顺序，已去空）。
*/
function readOutputImages(data) {
	if (data === null || typeof data !== "object") return [];
	const raw = data.output_images;
	if (!Array.isArray(raw)) return [];
	const out = [];
	for (const item of raw) if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
	return out;
}
/**
* 构造出图请求体。
*
* 只发上游**确认消费**的字段：`model` / `prompt` / `image_url` / `size` / `steps` /
* `guidance` / `seed` / `negative_prompt` 均被实测接受（SPIKE 实测 #9）；`loras`
* 也被确认消费（无效 LoRA id 在提交阶段直接 500，实测 #18）。**不发** `ref_image`
* ——那是别家平台的写法，魔搭上不存在（SPIKE §对照）。
*
* `image_url` **一律发数组**，哪怕只有一张：官方示例的形状是数组（多图编辑要用），
* 实测单张以数组发也通（#17）、以裸字符串发亦通（#8）。取数组是因为它的超集更贴近
* 上游本意，也省掉一个分支。
*
* `n` 刻意**不作为请求字段**：实测目录里的出图模型都是单出模型，`n` 的支持度未
* 逐项验证，传一个上游不认的参数比不传更危险。调用方要几张就发几次。
* @param {object} options - 请求参数。
* @param {string} options.model - 模型 id。
* @param {string} options.prompt - 提示词。
* @param {string|string[]} [options.imageUrl] - 输入图 URL，**字符串或数组均可**，
*   内部一律归一为数组（官方形状；多图编辑要用数组）。
* @param {string} [options.size] - `"宽x高"`，如 `"1024x1024"`（64 对齐）。
* @param {number} [options.steps] - 采样步数。
* @param {number} [options.guidance] - 引导系数。
* @param {number} [options.seed] - 随机种子。
* @param {string} [options.negativePrompt] - 负向提示词。
* @param {string|Record<string, number>} [options.loras] - LoRA 配置：单个 repo id，
*   或 `{id: weight}` 映射（官方：最多 6 个，权重和须为 1.0）。
* @returns {object} 请求体。
*/
function buildDrawBody(options) {
	const body = {
		model: str(options.model, ""),
		prompt: str(options.prompt, "")
	};
	const imageUrl = normalizeImageUrlList(options.imageUrl);
	if (imageUrl.length > 0) body.image_url = imageUrl;
	const size = str(options.size, "");
	if (size !== "") body.size = size;
	if (Number.isFinite(options.steps)) body.steps = options.steps;
	if (Number.isFinite(options.guidance)) body.guidance = options.guidance;
	if (Number.isFinite(options.seed)) body.seed = options.seed;
	const negativePrompt = str(options.negativePrompt, "");
	if (negativePrompt !== "") body.negative_prompt = negativePrompt;
	const loras = options.loras;
	if (typeof loras === "string" && loras.trim() !== "") body.loras = loras.trim();
	else if (loras !== null && typeof loras === "object") {
		const entries = Object.entries(loras).filter(([id, weight]) => id.trim() !== "" && Number.isFinite(weight));
		if (entries.length > 0) body.loras = Object.fromEntries(entries);
	}
	return body;
}
/**
* 把「一张或多张输入图」归一成 URL 数组。
*
* 单张给字符串上游也吃（实测 #8），但官方示例与多图编辑都用数组（#17 实测通），
* 故一律归一为数组。逐项过滤空串，**保持调用方给定的顺序**——多图编辑里顺序即语义
* （官方示例：「图一中的狗，去追图二中的飞盘」）。
* @param {unknown} value - 单个 URL、URL 数组，或缺省。
* @returns {string[]} 归一后的 URL 数组（可为空）。
*/
function normalizeImageUrlList(value) {
	const raw = Array.isArray(value) ? value : [value];
	const out = [];
	for (const item of raw) if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
	return out;
}
/**
* 从任意配置里读出「可用作输入图」的 URL。
*
* 承接 agent 工具的 `image_url` 参数。**只接受 http(s) 与 data URL**——其它形态
* （本地路径）上游取不到，转发过去只会换回一个原因不可知的 `FAILED`。实测尚未
* 验证 data URL 是否被上游接受（SPIKE 待办），但**转发它不会更糟**，而拦掉它会让
* 本地图片彻底不可用；故放行并在档案里留待验证。
* @param {unknown} value - 原始参数。
* @returns {string|null} 规范化后的 URL，不可用时为 `null`。
*/
function normalizeImageUrlInput(value) {
	const raw = typeof value === "string" ? value.trim() : "";
	if (raw === "") return null;
	if (/^https?:\/\//i.test(raw)) return raw;
	if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(raw)) return raw;
	return null;
}
/**
* 把一次失败转成 agent 与面板都能读的一句话。
*
* **关于魔搭 `FAILED` 的诚实边界**：实测唯一的失败样本是
* `{"errors":{"code":0,"message":""}, "task_status":"FAILED"}`——**原因不可知**。
* 所以这里只报「可确定的形态事实」（HTTP 码 / 轮询未出终态 / 明确的原因文本），
* **不从空错误里编造原因**，并在原因确实拿不到时明说「上游未给出原因」。这是本仓库
* README「诚实声明」的要求。
*
* 凭据永不入消息：body 文本可能回显 `ms-` 令牌，过 `redactSecrets` 后再截断。
* @param {object} failure - 失败信息。
* @param {number} [failure.status] - HTTP 状态码（提交/轮询的传输层失败）。
* @param {string} [failure.bodyText] - 上游 body 原文。
* @param {string} [failure.taskStatus] - 轮询读到的状态。
* @param {string} [failure.cause] - 已知原因（超时 / 没有可用图片 / 拿不到 task_id 等）。
* @returns {string} 一行说明。
*/
function describeDrawFailure(failure) {
	const text = redactSecrets(typeof failure.bodyText === "string" ? failure.bodyText : "").slice(0, 300);
	const status = Number.isFinite(failure.status) ? Number(failure.status) : 0;
	const tail = text === "" ? "" : `; body: ${text}`;
	if (status === 401 || status === 403) return `出图失败：HTTP ${status} —— 访问令牌无效、无权访问该模型，或账号未完成邮箱验证/实名（后者是实测遇到过的真实拦截）。请在面板确认令牌与账号状态${tail}`;
	if (status === 404) return `出图失败：HTTP 404 —— 端点或模型不存在（检查 apiBase 与模型 id）${tail}`;
	if (status === 429) return `出图失败：HTTP 429 —— 上游限流，请稍后重试${tail}`;
	if (status >= 500) return `出图失败：HTTP ${status} —— 上游服务异常，稍后重试${tail}`;
	const cause = str(failure.cause, "");
	if (cause !== "") return `出图失败：${cause}${tail}`;
	const taskStatus = str(failure.taskStatus, "");
	if (taskStatus === "FAILED") return "出图失败：上游任务 FAILED，但未给出失败原因（实测 errors.code=0、message 为空），换模型或稍后重试";
	if (taskStatus !== "") return `出图失败：任务停在 ${taskStatus}（非终态），已超过截止时间`;
	return `出图失败：上游未给出可诊断的失败信息${tail}`;
}
/**
* 冷却门：一次失败后的一段时间内拒绝再试。
*
* 借 sensenova 那份的形状（它也从 `dsh-draw-router` 抄来）：出图慢且贵，一次失败
* 后立刻重试既容易撞限流又浪费等待窗口。纯闭包，无依赖，可离线测。
* @param {number} cooldownMs - 冷却窗口（毫秒）。
* @returns {{fail: () => void, remainingMs: () => number, clear: () => void}} 冷却门。
*/
function createDrawCooldown(cooldownMs) {
	const window = Math.max(0, Math.floor(cooldownMs));
	let until = 0;
	return {
		/** 记一次失败，从此刻起进入冷却。 */
		fail() {
			until = Date.now() + window;
		},
		/** 剩余冷却毫秒；0 表示可以发起。 */
		remainingMs() {
			return Math.max(0, until - Date.now());
		},
		/** 清掉冷却（例如面板里手动排障后）。 */
		clear() {
			until = 0;
		}
	};
}

//#endregion
//#region src/host/draw-runtime.ts
/**
* 出图的 **peer-dependent 半边**：真正发起请求、驱动异步两段式、注册成 agent 工具。
*
* 与 `llm-adapter.ts` 同一个处境——import Host 发行的 peer（`@deepseek-ai/dsh-tools`
* 的 `defineTool` 由调用方惰性注入），**不能由离线单测套件导入**。纯逻辑全部住在
* `draw.ts`（已由 `test/draw.test.mjs` 覆盖 39 组），本文件只做「接线 + I/O」：
* 轮询循环、fetch、工具定义。
*
* **覆盖边界**（2026-10-16 复核）：`runDrawOnce` / `pickDrawModel` / `drawModelIds` /
* `splitImageUrls` / `buildGenerationsEndpoint` / `buildTasksEndpoint` /
* `DRAW_TOOL_NAME` 由 `test/draw-runtime.test.mjs` 钉住；**没被覆盖的是
* `defineDrawTool` 落到 peer registry 的那一段**（真 `defineTool` 形状与注册结果）
* ——只改那一段不会让任何门禁变红。本文件此前整段自称「无覆盖」，该陈述在补上
* 这个套件之后已经过时。
*
* 与姊妹插件的关键差异（形状不兼容，不能照抄）：
* `sensenova` 的出图是**同步单发**——一次 `fetch` 拿 `data[0].url` 就结束。魔搭是
* **异步两段式**：提交拿 `task_id`，再轮询到终态取 `output_images[0]`。所以这里多
* 一个 `pollTask` 循环，且它必须带 `X-ModelScope-Task-Type`（漏了 = 假失败）。
*
* 三条承重纪律：
* 1. 提交响应的 `task_status` **一律忽略**（实测恒为 SUCCEED，连最终 FAILED 的那次
*    也是），成功与否只看轮询终态。`readTaskId` 已把这条钉在纯逻辑层。
* 2. 轮询间隔 15s（`DRAW_POLL_INTERVAL_MS`），**不是**社区常见的 5s——实测更密的
*    轮询只与更慢相关。
* 3. 失败原因实测可能**不可知**（`errors.code:0` + 空 message）。`describeDrawFailure`
*    因此明说「未给出原因」，本文件也**不从空错误里编造**。
*
* @module dsh-connect-modelscope-token-plan/draw-runtime
*/
/** agent 工具名。带插件前缀，避免与 `dsh-draw-router` 的 `draw_image` 撞名。 */
const DRAW_TOOL_NAME = "modelscope_draw_image";
/**
* 已知能**纯文生图**的目录内模型 id（2026-10-16 真机复核）。
*
* 为什么需要手工策展：api-inference 目录里至今**没有**平台声明的 `text-to-image`
* 条目，只有 2 条 `image-to-image`——而两者行为**不同**：
* `Qwen/Qwen-Image-Edit` 不带 `image_url` 纯文生图可用（本轮实测：提交成功、两次
* 15min 排队超时后于 9.7min 出图）；`MusePublic/Qwen-Image-Edit` 纯文生图被上游
* 直接拒绝（提交阶段 HTTP 4xx：`image_url is required for model: …`）。
* 能力枚举把两者都归为 `image-to-image`，区分不了这个差异，所以这里用实测知识兜底：
* 目录里没有 `text-to-image` 可挑时，默认偏向这个已知能用的 id，而不是「目录第一个」
* （真实目录顺序 `MusePublic/…` 在前，照旧逻辑纯文生图必挂）。
*/
const KNOWN_T2I_MODEL_ID = "Qwen/Qwen-Image-Edit";
/** 一次失败的冷却窗：出图慢，失败后立刻重试既易撞限流又白等。 */
const DRAW_FAILURE_COOLDOWN_MS = 6e4;
/**
* 把 OpenAI 兼容 base 拼成出图端点。
*
* `…/v1` → `…/v1/images/generations`；已带该后缀则原样；更深路径回卷到 `/v1`。
* 与 sensenova 的同名函数同源（那是受控复制：endpoint 拼接与上游是谁无关）。
* @param {string} apiBase - 配置里的 apiBase。
* @returns {string} 完整端点。
*/
function buildGenerationsEndpoint(apiBase) {
	const trimmed = str(apiBase, "").replace(/\/+$/, "");
	if (/\/images\/generations$/.test(trimmed)) return trimmed;
	if (/\/v1$/.test(trimmed)) return `${trimmed}/images/generations`;
	if (/\/v1\//.test(trimmed)) return trimmed.replace(/\/v1\/.*$/, "/v1/images/generations");
	return `${trimmed}/v1/images/generations`;
}
/**
* 拼轮询端点。task_id 上游是 UUID（实测失败态出现过短 id），一律走 path。
* @param {string} apiBase - 配置里的 apiBase。
* @param {string} taskId - 任务 id。
* @returns {string} 完整端点。
*/
function buildTasksEndpoint(apiBase, taskId) {
	return `${buildGenerationsEndpoint(apiBase).replace(/\/images\/generations$/, "")}/tasks/${encodeURIComponent(taskId)}`;
}
/**
* 一个响应体到底是不是「终态」——读不到就当还没好，继续等。
*
* 与 `isTerminalStatus` 的分工：那个管状态语义，这个管「响应本身能不能读」。
* 上游偶发返回非 JSON（CDN 错误页）时，当作暂时性抖动继续等，而不是判失败——
* 实测过一个 task 在正常轮询下始终 SUCCEED，没有理由把一次解析失败升级成终局。
* @param {unknown} data - 已解析的 JSON。
* @returns {boolean} 是否终态。
*/
function isTerminalPayload(data) {
	return isTerminalStatus(readTaskStatus(data));
}
/**
* 真正跑一次出图：提交 + 轮询到终态。
*
* 两段都必须带各自必需的头：提交带 `X-ModelScope-Async-Mode`（实测可省但官方示例
* 都带，带上无害），轮询带 `X-ModelScope-Task-Type`（**必需**，漏了必假失败）。
* @param {object} options - 调用参数。
* @param {DrawFetch} options.fetchImpl - 注入的 fetch。
* @param {string} options.apiBase - apiBase。
* @param {string} options.apiKey - 访问令牌（绝不出现在返回文本里）。
* @param {string} options.model - 模型 id。
* @param {string} options.prompt - 提示词。
* @param {string|string[]} [options.imageUrl] - 输入图（图生图 / 多图编辑）。
* @param {string} [options.size] - `"宽x高"`。
* @param {number} [options.steps] - 采样步数。
* @param {number} [options.guidance] - 引导系数。
* @param {number} [options.seed] - 种子。
* @param {string} [options.negativePrompt] - 负向提示词。
* @param {number} [options.pollDeadlineMs] - 轮询截止。
* @param {number} [options.pollIntervalMs] - 轮询间隔（测试可缩短）。
* @returns {Promise<DrawOutcome>} 出图结果。
* @throws {Error} 提交失败、任务 FAILED、或超时——消息已过 `describeDrawFailure`。
*/
async function runDrawOnce({ fetchImpl, apiBase, apiKey, model, prompt, imageUrl, size, steps, guidance, seed, negativePrompt, pollDeadlineMs = DRAW_POLL_DEADLINE_MS, pollIntervalMs = DRAW_POLL_INTERVAL_MS }) {
	const headers = {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json"
	};
	const body = buildDrawBody({
		model,
		prompt,
		...imageUrl !== void 0 ? { imageUrl } : {},
		...size !== void 0 ? { size } : {},
		...steps !== void 0 ? { steps } : {},
		...guidance !== void 0 ? { guidance } : {},
		...seed !== void 0 ? { seed } : {},
		...negativePrompt !== void 0 ? { negativePrompt } : {}
	});
	let submitted;
	try {
		submitted = await fetchImpl(buildGenerationsEndpoint(apiBase), {
			method: "POST",
			headers: {
				...headers,
				"X-ModelScope-Async-Mode": "true"
			},
			body: JSON.stringify(body)
		});
	} catch (error) {
		throw new Error(describeDrawFailure({ cause: `提交请求失败：${error instanceof Error ? error.message : String(error)}` }));
	}
	const submitText = await safeText(submitted);
	if (!submitted.ok) throw new Error(describeDrawFailure({
		status: submitted.status,
		bodyText: submitText
	}));
	const taskId = readTaskId(await safeJson(submitted, submitText));
	if (taskId === null) throw new Error(describeDrawFailure({
		bodyText: submitText,
		cause: "提交响应里没有 task_id"
	}));
	const deadline = Date.now() + Math.max(1e3, Math.floor(pollDeadlineMs));
	const interval = Math.max(1, Math.floor(pollIntervalMs));
	let polls = 0;
	let lastStatus;
	for (;;) {
		if (Date.now() >= deadline) throw new Error(describeDrawFailure({ cause: `超过截止时间（${Math.round(pollDeadlineMs / 1e3)}s，${polls} 次轮询）仍未拿到结果。上游任务（${taskId}）**可能仍在生成**——实测排队时长在 1–15 分钟间大幅波动，与请求本身无关。稍后可重试；注意超时后原任务的结果不保证还能取回` }));
		await sleep(interval);
		polls++;
		let polled;
		try {
			polled = await fetchImpl(buildTasksEndpoint(apiBase, taskId), {
				method: "GET",
				headers: {
					...headers,
					[TASK_TYPE_HEADER]: TASK_TYPE_IMAGE_GENERATION
				}
			});
		} catch {
			continue;
		}
		const pollText = await safeText(polled);
		if (!polled.ok) throw new Error(describeDrawFailure({
			...polled.status !== void 0 ? { status: polled.status } : {},
			...pollText !== "" ? { bodyText: pollText } : {},
			...lastStatus !== void 0 ? { taskStatus: lastStatus } : {}
		}));
		const data = await safeJson(polled, pollText);
		const status = readTaskStatus(data);
		if (status !== null) lastStatus = status;
		if (!isTerminalPayload(data)) continue;
		if (status === "FAILED") throw new Error(describeDrawFailure({
			taskStatus: "FAILED",
			bodyText: pollText
		}));
		const images = readOutputImages(data);
		if (images.length === 0) throw new Error(describeDrawFailure({
			taskStatus: "SUCCEED",
			bodyText: pollText,
			cause: "任务报 SUCCEED 但没有可用图片"
		}));
		return {
			model,
			images,
			taskId,
			polls
		};
	}
}
/**
* 从目录里挑一个出图模型。
*
* 优先级（高 → 低）：
* 1. **工具显式请求**——即使不在目录里也放行（手工覆盖，上游会自己报错）；
* 2. **首选模型**（面板保存的模型偏好，或配置 `drawModelId`）——用户点了谁就是
*    谁，同样不校验在不在目录（用户可能先配好、等模型上线）。此前这个偏好只在
*    `pickDrawModel` 返回 null 时才生效，目录非空时等于死配置——面板显示的
*    preferredModel 与实际挑中的模型会说两套话；
* 3. 目录里**平台声明**为 `text-to-image` 的条目（`textToImageModelIds`，将来目录
*    补上真文生图模型时自动优先生效）；
* 4. **已知能纯文生图**的模型（`KNOWN_T2I_MODEL_ID`）——今天目录的坑位，见该
*    常量的注释：真实目录里它是第二个，照旧取「第一个」会挑中纯文生图必挂的
*    `MusePublic/…`；
* 5. 目录里第一个出图模型（`isImageGenModel` 的严格方向：只认明确声明，缺字段
*    不算）。
*
* 目录为空且既无显式请求也无首选模型 → `null`，由调用方给出可操作的错误，
* 而不是发一个注定失败的请求。
* @param {unknown} entries - 归一目录条目。
* @param {string} [requested] - 工具调用里显式给的 model。
* @param {string} [preferred] - 首选模型 id（面板偏好或配置 `drawModelId`）。
* @returns {string|null} 选中的 id。
*/
function pickDrawModel(entries, requested, preferred) {
	const want = str(requested, "");
	if (want !== "") return want;
	const preferredId = str(preferred, "");
	if (preferredId !== "") return preferredId;
	const ids = imageGenModelIds(entries);
	if (ids.length === 0) return null;
	const t2i = textToImageModelIds(entries);
	if (t2i.length > 0) return t2i[0] ?? null;
	if (ids.includes("Qwen/Qwen-Image-Edit")) return KNOWN_T2I_MODEL_ID;
	return ids[0] ?? null;
}
/**
* 目录里可用于出图的模型 id（工具结果里回显，方便 agent 与用户看到实际候选）。
* @param {unknown} entries - 归一目录条目。
* @returns {string[]} id 列表。
*/
function drawModelIds(entries) {
	return imageGenModelIds(entries);
}
/**
* 装配 agent 工具定义。
*
* 工具只做「参数归一 → 跑一次 → 组装结果文本」，所有判定都委托给 `draw.ts` 的纯函数。
* @param {object} options - 装配参数。
* @param {(definition: object) => unknown} options.defineTool - peer 的工厂。
* @param {DrawFetch} options.fetchImpl - 注入的 fetch。
* @param {() => Promise<string>} options.resolveApiKey - 每次调用现读令牌。
* @param {() => unknown|Promise<unknown>} [options.getEntries] - 目录条目读取器。
* @param {object} [options.settings] - `{ apiBase, drawModelId, drawTimeoutMs }`。
* @param {ReturnType<typeof createDrawCooldown>} [options.cooldown] - 冷却门。
* @param {() => boolean} [options.isDisposed] - 卸载闸。
* @returns {unknown} 已定义的 agent 工具。
*/
function defineDrawTool({ defineTool, fetchImpl, resolveApiKey, getEntries, settings, getPreferredModelId, cooldown = createDrawCooldown(DRAW_FAILURE_COOLDOWN_MS), isDisposed = () => false }) {
	const timeoutMs = Math.max(3e4, Math.floor(Number(settings?.drawTimeoutMs) > 0 ? Number(settings?.drawTimeoutMs) : DRAW_TIMEOUT_MS));
	const apiBase = str(settings?.apiBase, "https://api-inference.modelscope.cn/v1");
	return defineTool({
		name: DRAW_TOOL_NAME,
		description: "Generate or edit an image with the ModelScope (魔搭) API-Inference token. Text-to-image by default; pass `imageUrl` to edit an existing image (image-to-image), or an array of URLs for multi-image editing. Omit `model` to use the catalogue's image model. This call is ASYNCHRONOUS upstream: the model queues first, so latency varies from ~1 minute to 15+ minutes depending on the free pool; it polls until the task reaches a terminal state. Available image model ids are reported in the result.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "Image prompt; describe the target image (for edits, describe the intended change)"
			},
			model: {
				type: "string",
				description: "ModelScope image model id; defaults to the catalogue's image model"
			},
			imageUrl: {
				type: "string",
				description: "Input image URL for editing (public http(s) or data:image/...;base64). For multi-image editing pass several URLs separated by newlines — order is significant."
			},
			size: {
				type: "string",
				description: "Image size as WIDTHxHEIGHT, e.g. 1024x1024 (64-aligned)"
			},
			steps: {
				type: "number",
				description: "Sampling steps (platform range 1-100)"
			},
			guidance: {
				type: "number",
				description: "Prompt guidance scale (platform range 1.5-20)"
			},
			seed: {
				type: "number",
				description: "Random seed"
			},
			negativePrompt: {
				type: "string",
				description: "Negative prompt"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					source: { type: "string" },
					model: { type: "string" },
					url: { type: "string" },
					prompt: { type: "string" },
					hint: { type: "string" }
				}
			},
			render: (_args, result) => [{
				type: "text",
				text: result?.hint || "图片已生成"
			}]
		},
		timeoutMs: timeoutMs + 1e4,
		async execute(params) {
			if (isDisposed()) throw new Error("modelscope draw tool is no longer mounted");
			const prompt = str(params?.prompt, "");
			if (prompt === "") throw new Error("prompt is required");
			const remaining = cooldown.remainingMs();
			if (remaining > 0) throw new Error(`draw cooldown: 上一次出图失败，${Math.ceil(remaining / 1e3)}s 后再试`);
			const apiKey = await resolveApiKey();
			if (typeof apiKey !== "string" || apiKey.trim() === "") throw new Error("MODELSCOPE_API_KEY 未配置：在面板粘贴 ms- 访问令牌，或设置该环境变量");
			let picked = [];
			try {
				picked = await getEntries?.() ?? [];
			} catch {
				picked = [];
			}
			const entries = Array.isArray(picked) ? picked : [];
			const configuredPreferred = str(settings?.drawModelId, "");
			const panelPreferred = typeof getPreferredModelId === "function" ? await getPreferredModelId().catch(() => null) : null;
			const preferred = typeof panelPreferred === "string" && panelPreferred.trim() !== "" ? panelPreferred : configuredPreferred;
			const model = pickDrawModel(entries, str(params?.model, ""), preferred);
			if (model === null) throw new Error("目录里没有出图模型（image-to-image / text-to-image 条目为空）：确认令牌已配置、面板已至少轮询一次，且套餐含该模型");
			const rawImages = splitImageUrls(params?.imageUrl);
			const images = [];
			for (const raw of rawImages) {
				const normalized = normalizeImageUrlInput(raw);
				if (normalized === null) throw new Error(`imageUrl 不可用：${raw.slice(0, 80)} —— 只接受公网 http(s) 链接或 data:image/...;base64 内联数据（本地文件上游取不到，请先上传）`);
				images.push(normalized);
			}
			try {
				const size = str(params?.size, "");
				const steps = toPositiveInt(params?.steps);
				const guidance = toPositiveNumber(params?.guidance);
				const seed = toNonNegativeInt(params?.seed);
				const negativePrompt = str(params?.negativePrompt, "");
				const outcome = await runDrawOnce({
					fetchImpl,
					apiBase,
					apiKey,
					model,
					prompt,
					...images.length > 0 ? { imageUrl: images } : {},
					...size !== "" ? { size } : {},
					...steps !== void 0 ? { steps } : {},
					...guidance !== void 0 ? { guidance } : {},
					...seed !== void 0 ? { seed } : {},
					...negativePrompt !== "" ? { negativePrompt } : {},
					pollDeadlineMs: timeoutMs
				});
				const available = drawModelIds(entries);
				const urls = outcome.images.join("\n");
				return {
					source: "modelscope",
					model: outcome.model,
					url: outcome.images[0] ?? "",
					prompt,
					hint: `图片已生成（上游异步任务，${outcome.polls} 次轮询，task ${outcome.taskId}）\n模型: ${outcome.model}\n${urls}` + (available.length > 0 ? `\n可用出图模型: ${available.join(", ")}` : "")
				};
			} catch (error) {
				cooldown.fail();
				throw error;
			}
		}
	});
}
/**
* 把工具参数里的输入图拆成列表。
*
* 官方支持多图（数组形状），而 agent 工具的参数类型是标量，所以约定**用换行分隔**
* 多张。同时容忍调用方直接传数组（内部调用与测试会这么用）。
* @param {unknown} value - 原始参数。
* @returns {string[]} 拆好的 URL（未归一，调用方逐项过闸）。
*/
function splitImageUrls(value) {
	if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.trim() !== "");
	const raw = str(value, "");
	if (raw === "") return [];
	return raw.split(/\r?\n/).map((v) => v.trim()).filter((v) => v !== "");
}
/** 读正整数，非法返回 undefined（不下发无意义参数）。 */
function toPositiveInt(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : void 0;
}
/** 读非负整数（seed 可为 0）。 */
function toNonNegativeInt(value) {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : void 0;
}
/** 读正浮点（guidance 可为小数）。 */
function toPositiveNumber(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : void 0;
}
/** 读 body 文本，读不到给空串（错误分诊不能因为读 body 失败而失败）。 */
async function safeText(response) {
	try {
		return await response.text();
	} catch {
		return "";
	}
}
/** 解析 JSON；读不到就返回 `null`，由调用方按「非终态/无 id」处理。 */
async function safeJson(response, text) {
	try {
		return await response.json();
	} catch {
		try {
			return text === "" ? null : JSON.parse(text);
		} catch {
			return null;
		}
	}
}
/** 可注入的 sleep（测试可覆写；这里只提供默认实现）。 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

//#endregion
//#region src/host/draw-tool-state.ts
/** 当前缺席原因（`null` = 未登记 / 已清掉）。 */
let note = null;
/**
* 记下缺席原因（`null` 清空）。
* @param {DrawToolAbsentReason|null} reason - 原因码。
* @returns {void}
*/
function setDrawToolNote(reason) {
	note = reason;
}
/**
* 读当前缺席原因。
* @returns {DrawToolAbsentReason|null} 原因码。
*/
function drawToolNote() {
	return note;
}
/**
* 清空（卸载时调用：下一个 Host 生命周期从干净的「未登记」开始）。
* @returns {void}
*/
function resetDrawToolNote() {
	note = null;
}

//#endregion
//#region src/host/switch-precedence.ts
/**
* 所有 opt-in 开关共用的唯一裁决：「面板保存值 vs 配置默认值」。
*
* 规则只有一条：**面板保存值赢，否则配置默认值说了算**。来源标签（`panel` /
* `config`）随答案一起返回，面板才能说出是谁在管。规则收在一处，是为了让开关
* 再也无法各自发明一套优先级方言；`test/switch-precedence.test.mjs` 钉死这个
* 方言，照抄形状的新调用方会被它标成异类。
*
* 不服务「纯面板拥有、无配置默认值」的开关——那种没有可裁决的配置默认值，
* 调用方直接读即可。peer-free，纯函数。
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
* Resolve the effective string preference (e.g. a draw-model id): a
* panel-saved value wins, otherwise the config default rules.
* @param {string|null} panel - the panel-saved value (`null` = never saved).
* @param {string|undefined} config - the patch-declared default.
* @returns {string|undefined} the effective preference.
*/
function resolveSwitchValue(panel, config) {
	return panel ?? config;
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
//#region src/host/draw-register.ts
/**
* 出图工具的挂载副作用：读开关 → 解析目录 → 注册 agent 工具。
*
* 与 `provider-publish.ts` 的分工：那个管「魔搭作为 chat provider 的注册」，本文件
* 管「给 agent 一个出图工具」。两者是**独立的开关**——回答的是不同问题，合并没有
* 好处（用户可能想用工具出图但不想把魔搭塞进模型选择器，反之亦然）。
*
* 承重约束：**peer 的 tools registry 没有 unregister**。所以
*  - 注册只在挂载时尝试**一次**，不在任何轮询/路由里重复调用；
*  - 开关在挂载后翻转，要到下次 Host 启动才生效（面板文案必须说这句，否则用户
*    会以为开关坏了）；
*  - 目录变化**不需要**重注册：工具在**调用时**才读目录（`getEntries` 是个函数），
*    所以一次目录刷新会自然被下一次出图看到。
*
* 失败一律降级为「工具缺席」，绝不炸掉插件：tools 服务缺失、peer 加载失败、
* registry 拒收——三种都由 `draw-tool-state.ts` 记下原因供面板显示。本文件不吞
* 错误（那会让「工具为什么不在」无从诊断），只把它们翻译成可展示的原因码。
*
* peer-dependent：`@deepseek-ai/dsh-tools` 由 `deps.loadToolsModule` 惰性注入。
*
* **本文件目前没有测试覆盖**——`registerDrawTool` 在 `test/` 里零引用
* （docs/ROADMAP.md Backlog 记着这条缺口）。但**这不是「不能」**：同一处境的
* `llm-adapter.ts` / `draw-runtime.ts` 已经用 `test/helpers/peer-stub-loader.mjs`
* 证明这类模块能在离线套件里原样加载执行。此前的措辞把 `llm-adapter.ts` 当作
* 「同样无法导入」的例证拉来作证，那条类比在补上那个 loader 之后已经失效。
*
* @module dsh-connect-modelscope-token-plan/draw-register
*/
/**
* 解析一个可选服务，允许它稍后才注册。
*
* 承 sensenova 同名函数的纪律：**重试的是读，不是注册**——工具不能注销，重复注册
* 比缺席更糟。这里只做有限次立即读取，不做长退避（服务要么已注册，要么这次挂载
* 就没有）。
* @param {object} ctx - Host 上下文。
* @param {string} service - 服务名。
* @param {() => boolean} isDisposed - 卸载闸。
* @returns {Promise<object|null>} 服务实例或 `null`。
*/
async function resolveService(ctx, service, isDisposed) {
	for (let attempt = 0; attempt < 3; attempt++) {
		if (isDisposed()) return null;
		const found = ctx.get?.(service);
		if (found !== null && found !== void 0) return found;
		if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return null;
}
/**
* 读一次开关，决定是否注册出图工具。
* @param {object} ctx - Host 上下文。
* @param {object} wiring - `{ settings, configError, tokenStore, inference, providerStore, publisher, logger }`。
* @param {object} deps - 测试缝（`loadToolsModule`、`drawFetch`）。
* @returns {Promise<void>}
*/
async function registerDrawTool(ctx, wiring, deps = {}) {
	const { settings, configError, tokenStore, inference, drawStore, publisher, logger } = wiring;
	const loggerFor = logger ?? ctx.logger;
	setDrawToolNote(null);
	try {
		if (configError !== null) return;
		const panelValue = drawStore ? await drawStore.enabled().catch(() => null) : null;
		if (resolveSwitchEnabled(panelValue, settings.drawEnabled === true) !== true) return;
		const isDisposed = () => publisher?.isDisposed?.() === true;
		const tools = await resolveService(ctx, "tools", isDisposed);
		if (tools === null || typeof tools.register !== "function") {
			setDrawToolNote("no-tools-service");
			return;
		}
		let defineTool = null;
		try {
			const mod = await Promise.resolve(deps.loadToolsModule ? deps.loadToolsModule() : import("@deepseek-ai/dsh-tools"));
			defineTool = mod?.defineTool ?? mod?.default?.defineTool ?? null;
		} catch (error) {
			setDrawToolNote("peer-load-failed");
			loggerFor?.warn?.(`${name}: draw tool peer module failed to load (${redactSecrets(errMsg(error))}) — the tool is absent`);
			return;
		}
		if (typeof defineTool !== "function") {
			setDrawToolNote("peer-load-failed");
			return;
		}
		const drawFetch = deps.drawFetch ?? ((url, options) => fetch(url, options));
		tools.register(defineDrawTool({
			defineTool,
			fetchImpl: drawFetch,
			resolveApiKey: async () => (await tokenStore.resolve()).value,
			getEntries: async () => {
				return (await inference.fetchModels().catch(() => null))?.entries ?? [];
			},
			getPreferredModelId: async () => {
				const panelValue = drawStore ? await drawStore.modelId().catch(() => null) : null;
				return resolveSwitchValue(panelValue, settings.drawModelId === "" ? void 0 : settings.drawModelId) ?? null;
			},
			settings: {
				apiBase: settings.apiBase,
				drawModelId: settings.drawModelId,
				drawTimeoutMs: settings.drawTimeoutMs
			},
			isDisposed
		}));
	} catch (error) {
		setDrawToolNote("registry-refused");
		loggerFor?.warn?.(`${name}: draw tool registration refused (${redactSecrets(errMsg(error))}) — the tool is absent`);
	}
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
* load-bearing and pinned by tests — and the rollback is the worst place to
* discover a divergence, because it only runs once something has already failed.
* When they were written twice, keeping them in sync relied on comments in one
* file pointing at the other; here there is one copy.
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
* empty) set while the snapshot reports the fresh one.
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
* already gone wrong, which is the worst possible moment to find out.
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
*
* Only the SUCCESS is memoized. The memoized value used to be the promise
* itself, which pinned a rejection in the slot for the life of the process:
* after one failed `import()` every later publish rethrew the same error and
* the provider could never register again — even after the operator fixed the
* missing peer, which is exactly the remedy this file's own
* `describeBuildFailure` prints for `ERR_MODULE_NOT_FOUND`. A recoverable
* install problem cost a Host restart. Clearing the slot on failure keeps
* "loaded once" for the happy path and gives the next publish a real retry.
* @param {() => Promise<object>} loadModule - resolves the adapter module.
* @param {string} exportName - the factory export to read off the module.
* @returns {() => Promise<Function>} the memoized factory resolver.
*/
function createAdapterFactoryResolver(loadModule, exportName) {
	let adapterFactoryPromise;
	return async () => {
		if (adapterFactoryPromise === void 0) adapterFactoryPromise = Promise.resolve(loadModule()).then((mod) => mod?.[exportName]).catch((error) => {
			adapterFactoryPromise = void 0;
			throw error;
		});
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
*
* The absence routes through {@link unregister}, not a hand-rolled
* `release(); registered = false`: `state.built` must go down with it. A
* stale `built` survives into the NEXT publish as its rollback target, so a
* later failed publish would re-register an adapter whose release has already
* been called — a rollback path running against a dead pair, which is the
* worst possible moment to discover the divergence.
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
		unregister({
			state,
			release,
			error: NO_LLM_SERVICE_ERROR
		});
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
* This is the other half of the single-point `registerPair` discipline, and the
* reason it is shared: the rollback is the path that only runs once something
* has already gone wrong. A registration that fails AFTER the old pair was
* released must put the previous one back, or a bad publish takes down models
* that were already serving. Written twice, the copies drift; written once, a fix
* to the rollback reaches every publisher.
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
		restorePreviousPair({
			llm,
			previousBuilt,
			state,
			registerPair,
			release
		});
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
* 注册失败后恢复先前在服务的 provider 对（如果有）。
*
* 从 {@link swapRegistration} 提取，把 catch 块里的嵌套从 4 层降到 2 层——
* 原实现里 `registerPair(llm, previousBuilt, ...)` 住在 try 内、try 住在
* catch 内，读起来要数四层缩进才能确认它在做什么。行为完全不变：先摘掉
* 新对（`release()` 已在调用方做过），再尝试挂回旧对；旧对也注册不上就
* 诚实地标 `registered: false`。
*/
function restorePreviousPair({ llm, previousBuilt, state, registerPair, release }) {
	if (previousBuilt === null) {
		state.registered = false;
		return;
	}
	try {
		registerPair(llm, previousBuilt, state);
		state.built = previousBuilt;
		state.registered = true;
	} catch {
		release();
		state.built = null;
		state.registered = false;
	}
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
*     快 publish 覆盖（队列语义见 `publish-core.ts` 的 `createPublishQueue`）；
*   - `disposed` 闸拦住 dispose 之后才到的 publish，不让它注册进一个已经撤下本
*     插件的 Host；
*   - 单点 `registerPair`（带 factory-await + shape 检查）被 publish 与 rollback
*     两条路共用；失败时**恢复旧对**，坏 publish 不会把已在服务的模型也拉下来。
*
* 与 sensenova 版的关系：**结构同源、代码不等价**——去注释后代码行重叠 77%
* （2026-10-16 实测；复核：`node tools/dev/cross-repo-drift.mjs`）。所以差异**不止**
* 三个标签：除工厂导出名 `"createModelScopeAdapter"`、`registerPair` 用的
* `LLM_PROVIDER_ID`/`LLM_DISPLAY_NAME`、`warnBuildFailure` 的 label `"ModelScope"`
* 之外，vision 判定这里取自 `llm-models.ts`（sensenova 侧走 `parsers.ts` 的
* `identifyVisionModel`），usage 观察层的接线位置也不同。
*
* 可以跨仓库**对着读**的是三条承重语义（队列 / disposed 闸 / 单点 registerPair，
* 它们是 `publish-core.ts` 的骨头，三处 91% 同源）；具体代码不可照搬。
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
	const { settings, panelSwitch, loadAdapterModule, getLlm, resolveApiKey, usage, emit, logger } = deps;
	const effectiveSettings = settings ?? {};
	const effectivePanelSwitch = panelSwitch ?? (async () => null);
	const effectiveLoadAdapterModule = loadAdapterModule ?? (() => import("./llm-adapter.js"));
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
	* 函数体是共享的 `registerProviderPair`——所有 publisher、两条路径共用一份；
	* 这个包装只补上「这行是给哪个 provider 的」。
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
	* 空转守卫的公共判据：目录 offer 与额度耗尽集合是否都没变。
	*
	* 两处空转守卫（开关关着 / 开关开着）共用这个签名比对——公式与轮询同源
	* （由 {@link syncSignaturesAfterPublish} 内部调用导出的 {@link catalogSignature}
	* 与 {@link quotaSignatureOf}），不会漂移。提取成函数避免两处各写一遍。
	* @returns {boolean} true = offer 没变，可以跳过这次 publish。
	*/
	const offerUnchanged = () => state.signature === catalogSignature(state.entries, state.enabledIds) && state.quotaSignature === quotaSignatureOf(state.unavailableIds);
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
		if (!resolveSwitchEnabled(panelValue, effectiveSettings.registerProvider === true)) {
			if (state.registered === false && state.error === null && offerUnchanged()) return {
				ok: true,
				skipped: true
			};
			const result = unregister({
				state,
				release
			});
			syncSignaturesAfterPublish(state);
			return result;
		}
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
				unavailableModelIds: state.unavailableIds,
				...usage !== void 0 ? { usage } : {}
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
		if (state.registered === true && state.error === null && offerUnchanged()) return {
			ok: true,
			skipped: true
		};
		if (queue.isDisposed()) return {
			ok: false,
			skipped: true
		};
		const requestedSignature = catalogSignature(state.entries, state.enabledIds);
		const result = swapRegistration({
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
		syncSignaturesAfterPublish(state);
		if (result.ok === false && state.registered === true && state.signature === requestedSignature) state.error = null;
		return result;
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
/**
* 一份 provider 注册会提供的模型集合的廉价签名。
*
* 它只回答「重建会不会改变什么」：目录顺序里的模型 id，每个带上 descriptor 用的
* 同一个 vision 判定（id 没变但模态翻了也必须重建），加上允许清单。目录条目里其他
* 东西变了不影响注册的 offer。
* @param {object[]} entries - 归一目录条目。
* @param {string[]} enabledIds - 允许清单（空 = 全部）。
* @returns {string}
*/
function catalogSignature(entries, enabledIds) {
	return `${(Array.isArray(entries) ? entries : []).map((entry) => {
		const e = entry;
		const id = str(e?.id, "");
		return `${id}:v${isVisionModel(e) ? 1 : 0}:n${str(e?.name, id)}:c${typeof e?.contextWindow === "number" ? e.contextWindow : ""}:o${typeof e?.maxOutputLength === "number" ? e.maxOutputLength : ""}`;
	}).join(",")}|${(Array.isArray(enabledIds) ? enabledIds : []).join(",")}`;
}
/**
* 额度不可用集合的签名：轮询的「耗尽集合变没变」信号。
*
* 导出是为了让轮询路径与 {@link syncSignaturesAfterPublish} 无法漂移——它们以前把
* 这个公式各写一遍（`[...ids].sort().join(",")`），正是那种一对会被碰一下就走样的
* 组合，失败方式是静默的：两边不再看到对方的 publish，注册要么每次轮询都 churn，
* 要么再也不重建。构造上与顺序无关（排序过），所以两个相等的集合永远产出同一个
* 字符串。
* @param {string[]} unavailableIds - 耗尽的模型 id。
* @returns {string}
*/
function quotaSignatureOf(unavailableIds) {
	return [...unavailableIds].sort().join(",");
}
/**
* 按 publisher 刚发布出去的 offer 重算 state 的 `signature` 与 `quotaSignature`。
*
* 在每次绕开轮询变更检测的**直接** publish 之后调用：那两个字段是轮询的「offer 变没
* 变」信号，所以它们必须跟着实际提供的东西走，否则下一次轮询会无谓地 churn（重建）
* 注册。这里的公式与轮询用的**相同**——它们就是被导出的函数，不是抄一份——所以
* 两者不会漂移。只在成功的 publish 之后有意义：失败的 publish 上，调用方的 rollback
* 已经恢复了之前的字段。
* @param {{entries?: unknown, enabledIds?: unknown, unavailableIds?: unknown,
*          signature: string, quotaSignature: string}} state - `publisher.state`。
*/
function syncSignaturesAfterPublish(state) {
	const entries = Array.isArray(state.entries) ? state.entries : [];
	const enabledIds = Array.isArray(state.enabledIds) ? state.enabledIds : [];
	const unavailable = Array.isArray(state.unavailableIds) ? state.unavailableIds : [];
	state.signature = catalogSignature(entries, enabledIds);
	state.quotaSignature = quotaSignatureOf(unavailable);
}

//#endregion
//#region src/host/routes/paths.ts
/**
* 路由字面量。浏览器 bundle（src/client/const.ts）无法从 host-config 导入，
* 两边各写一份字面量——由 test/panel.test.mjs 的 §6/§6b 钉住两端解析出的完整
* 路径集合双向相等，改名时先红再改。（原注释指向 test/config.test.mjs，但那套
* 钉的是 CONFIG_DEFAULTS ↔ cordis.patch.yml，不含路由字面量。）
* @module dsh-connect-modelscope-token-plan/routes/paths
*/
const SNAPSHOT_PATH = "/api/dsh-connect-modelscope-token-plan/snapshot";
const MODELS_PATH = "/api/dsh-connect-modelscope-token-plan/models";
const TOKEN_PATH = "/api/dsh-connect-modelscope-token-plan/token";
const TOKEN_FORGET_PATH = "/api/dsh-connect-modelscope-token-plan/token/forget";
const PROBE_PATH = "/api/dsh-connect-modelscope-token-plan/probe";
const PROVIDER_PATH = "/api/dsh-connect-modelscope-token-plan/provider";
const DRAW_PATH = "/api/dsh-connect-modelscope-token-plan/draw";

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
/**
* 软失败包装：成功给 value，失败给 {error, code}——从不 reject。
*
* **`error` 在这里脱敏，这是本模块唯一的安全收口。** 这个字符串会一路流进
* `shapeWarnings`、`balance.error`、`models.error`（面板可见）与快照路由的响应体，
* 所以「下游每个 promise 都已自行脱敏」这个假设一旦有任何一个遵守者，令牌就直达
* 面板。契约不该靠下游的自觉：**收口处自己脱敏**，下游脱敏是纵深防御而不是前提。
*
* 代价是重复脱敏（上游多已脱敏过一次）——`redactSecrets` 是幂等的（已替换成
* `ms-[REDACTED]` 的内容再过一次仍是它），这点开销换掉「凭据可能外泄」这个尾部
* 风险划算。
*/
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
			error: redactSecrets(errMsg(error)),
			code: typeof code === "string" ? code : CODE.INTERNAL_ERROR
		};
	}
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
		contextWindow: null,
		roster: []
	};
}
/** 聚合快照 body。wiring 子集见 routes/snapshot.ts 的 Pick。 */
async function buildSnapshotBody(wiring) {
	const { settings, tokenStore, usageStore, inference, providerStore, drawStore, publisher } = wiring;
	const [tokenState, daily, perModel, trend, events, providerNote] = await Promise.all([
		soft(tokenStore.state()),
		soft(usageStore.daily()),
		soft(usageStore.perModelToday()),
		soft(usageStore.trend(settings.trendDays)),
		soft(usageStore.events()),
		soft(providerStore.versionNote())
	]);
	const shapeWarnings = [];
	const usageAnomaly = usageStore.anomaly();
	if (usageAnomaly !== null) shapeWarnings.push(usageAnomaly);
	for (const [label, path] of [
		["token", tokenState],
		["daily", daily],
		["per-model", perModel],
		["trend", trend],
		["events", events]
	]) if (!path.ok) shapeWarnings.push(`${label} source failed (${path.code}): ${path.error}`);
	const tokenKnownAbsent = tokenState.ok && tokenState.value.present === false;
	const contextOverride = await providerStore.contextWindow().catch(() => null);
	const [balance, models] = await Promise.all([soft(inference.fetchBalance()), soft(inference.fetchModels(contextOverride))]);
	const modelIds = models.ok ? models.value.ids : [];
	const modelEntries = models.ok ? models.value.entries : [];
	if (!models.ok && models.code !== "network_error") shapeWarnings.push(`models: ${models.error}`);
	if (!tokenKnownAbsent && !balance.ok && balance.code !== "network_error") shapeWarnings.push(`balance: ${balance.error}`);
	if (providerNote.ok && providerNote.value !== null) shapeWarnings.push(providerNote.value);
	const drawNote = await soft((async () => drawStore.versionNote())());
	if (drawNote.ok && drawNote.value !== null) shapeWarnings.push(drawNote.value);
	const provider = await soft((async () => {
		const panel = await providerStore.enabled().catch(() => null);
		const enabled = resolveSwitchEnabled(panel, settings.registerProvider);
		const source = switchSource(panel);
		const roster = rosterWithAvailability(modelEntries, []);
		const stored = await providerStore.enabledIds().catch(() => null);
		const enabledIds = resolveEnabledIds(stored, publisher.state.enabledIds);
		const contextWindow = await providerStore.contextWindow().catch(() => null);
		const allowed = resolveAllowedList(enabledIds);
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
			contextWindow,
			roster
		};
	})());
	const draw = await soft((async () => {
		const panel = await drawStore.enabled().catch(() => null);
		const panelModel = await drawStore.modelId().catch(() => null);
		const candidateIds = imageGenModelIds(modelEntries);
		return {
			enabled: resolveSwitchEnabled(panel, settings.drawEnabled),
			source: switchSource(panel),
			candidateIds,
			candidateCount: candidateIds.length,
			preferredModel: resolveSwitchValue(panelModel, settings.drawModelId === "" ? void 0 : settings.drawModelId) ?? null,
			preferredSource: switchSource(panelModel),
			absentReason: drawToolNote(),
			mountPending: resolveSwitchEnabled(panel, settings.drawEnabled) === true && drawToolNote() !== null,
			toolName: "modelscope_draw_image"
		};
	})());
	const usedLocal = daily.ok ? daily.value.calls : null;
	return {
		ok: true,
		name,
		version: PLUGIN_VERSION,
		now: (/* @__PURE__ */ new Date()).toISOString(),
		pollSeconds: settings.pollSeconds,
		cacheSeconds: settings.cacheSeconds,
		token: tokenState.ok ? {
			...tokenState.value,
			readError: null
		} : {
			present: false,
			source: "none",
			valid: null,
			checkedAt: null,
			ephemeral: true,
			readError: tokenState.error
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
			error: tokenKnownAbsent ? null : balance.error
		},
		quota: {
			daily: { usedLocal },
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
		...draw.ok ? { draw: draw.value } : {},
		shapeWarnings,
		quotaError: null
	};
}
/** 聚合器自身抛错时的失败码（快照路由的 ok:false 分支用）。 */
function failureCode(error) {
	const code = error.code;
	return typeof code === "string" ? code : CODE.INTERNAL_ERROR;
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
/**
* 写盘/操作失败的统一响应：HTTP 恒 200、成败看 body（与快照路由同一语义，
* 一次写失败不许顺着渲染树炸穿）。**用户显式操作的失败必须上屏**，所以
* 调用方不吞、这里只负责脱敏后的标准形状。provider 开关/清单/reset 与
* token save/forget 五处 catch 曾各写一遍这个 writeJson——集中成一份，
* 措辞与形状不会漂移。
* @param {object} response - webServer 的响应对象。
* @param {unknown} error - catch 到的任意值（未必是 Error）。
* @returns {void}
*/
function respondError(response, error) {
	writeJson(response, 200, {
		ok: false,
		error: redactedError(error)
	}, { "cache-control": "no-store" });
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
/**
* 注册令牌路由（POST /token 保存，POST /token/forget 忘掉）。
*
* 返回类型是本族唯一的一个**数组**：token 注册两条路由（save + forget），其余
* 路由族各只注册一条、返回单个 off()。标注在**这里**而不是在 routes.ts 里对
* 调用结果做 `as Array<() => void>` 断言——断言放在消费端等于把「这两条返回的是
* 注销回调而不是 handler」这个约定藏起来，标注在产地才是声明。
*/
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
			respondError(response, error);
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
			respondError(response, error);
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
* probe 路由：面板「接入」tab 的「验令牌（零额度）」按钮。
*
* 只剩一种形态（SPIKE.md §结论 5，2026-10-04 真机回填）：
* - 故意缺 messages 的请求——魔搭**不先校验消息体**，实测返回 200（空壳）而非
*   400，所以判定规则是 **401/403 = 令牌坏；200/400 = 令牌好；429 = 限频中**。
*   早先「401 先于 400」的预期已被真机推翻（空壳响应 `created:0`，疑似零额度，
*   未证实——故 validity 结果**不计入**本地用量，也不记调用，只记事件）。
*
* `kind:"usage"`（真调用、max_tokens=1、消耗 1 次免费额度）**已删除**：它只服务
* 已随面板收敛删掉的「模型目录」逐行试调按钮，且**不在 DSH 的调用路径上**——真
* 调用经 provider adapter，由 `usage-observer.ts` 在流出口记账。删它的另一个理由
* 是形态本身：服务端原有 `kind = body.kind === "validity" ? "validity" : "usage"`
* 的**缺省即 usage**，任何人 POST 一个 modelId 就会触发一次真实计费调用。面板只
* 剩零额度探针之后，缺省不该指向「花钱的那个」。
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
			if (modelId === "") {
				writeJson(response, 400, {
					ok: false,
					error: "modelId is required"
				}, { "cache-control": "no-store" });
				return;
			}
			try {
				const result = await inference.probe({ modelId });
				wiring.tokenStore.noteValidity(true);
				writeJson(response, 200, {
					...result,
					tokenState: await wiring.tokenStore.state().catch(() => null)
				}, { "cache-control": "no-store" });
			} catch (error) {
				const code = error.code;
				const message = redactedError(error);
				if (code === CODE.AUTH_ERROR) wiring.tokenStore.noteValidity(false);
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
* provider 注册路由：开关读/写、允许清单保存、上下文窗口覆盖、回退默认。
*
* 四件事（§9）：
*   - GET  `PROVIDER_PATH`           读当前开关 + 目录 + 允许清单 + 注册状态（无副作用）；
*   - POST `PROVIDER_PATH`           body `{enabled?: boolean}` → 保存面板开关并重注册；
*   - POST `PROVIDER_PATH/roster`    body `{enabledIds?: string[]}` → 保存允许清单并重注册；
*   - POST `PROVIDER_PATH/context`   body `{contextWindow: number|null}` → 保存全局上下文
*     窗口覆盖并重注册（null = 跟随目录）；
*   - POST `PROVIDER_PATH/reset`     忘掉面板开关、允许清单与窗口覆盖，回到 patch 默认。
*
* `withOrigin` 围栏与 `refuseMethod` 照现有路由；写开关/清单失败**必须传播**
* （`ok:false` + error），不静默吞——这是用户的显式操作，面板必须看见它没生效。
*
* peer-free：不 import 任何 Host peer（`@deepseek-ai/*` / `@earendil-works/*`）。
* @module dsh-connect-modelscope-token-plan/routes/provider
*/
/**
* 读目录条目，读不到按空目录降级（GET 不能因目录失败把整个面板状态打掉）。
*
* 读目录前先取**当前窗口覆盖**传给 `fetchModels`：条目在归一前打上覆盖标记，
* descriptor / roster / catalogSignature 都从这份条目派生。每个写路由（开关、
* 清单、窗口、reset）都经这里取条目再 publish，所以任何一次重注册都带着最新
* 覆盖——否则先存窗口、再存清单会把未打标的目录重新注册上去，覆盖静默失效到
* 下一轮轮询。
*/
async function readEntries$1(inference, providerStore) {
	const contextWindow = await optional(providerStore?.contextWindow?.(), null);
	const catalog = await inference.fetchModels(contextWindow).catch((error) => {
		return {
			entries: [],
			__error: error
		};
	});
	return Array.isArray(catalog?.entries) ? catalog.entries : [];
}
/**
* 读「当前」允许清单：优先持久化的，否则 publisher 最近 publish 的那份。
*
* 判据是**共用**的 resolveEnabledIds（provider-store）——本文件与面板聚合、
* index.ts 的轮询必须对「空清单」给同一个答案，否则三个界面各说一套。
*/
async function readEnabledIds(store, published) {
	return resolveEnabledIds(await optional(store.enabledIds?.(), null), published);
}
/**
* `allowed` 的分类：委托给 `llm-models.ts` 的单一口径
* {@link resolveAllowedList}（fix D：快照与 provider 路由以前各写一套分类，会漂移）。
*
* 旧版 `allowedOf` 只认「恰好哨兵」为 `"none"`，`["__hide_all__","other"]` 会被错判成
* `"list"`；统一到 `resolveAllowedList` 后，含哨兵即 `"none"`，与 `filterByEnabled` /
* `isModelEnabled` 口径一致。
* @param {string[]} enabledIds - 允许清单。
* @returns {"all"|"none"|"list"}
*/
function allowedOf(enabledIds) {
	return resolveAllowedList(enabledIds);
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
		const contextWindow = await optional(providerStore.contextWindow?.(), null);
		const entries = await readEntries$1(inference, providerStore);
		const roster = rosterWithAvailability(entries, []);
		const allowed = allowedOf(enabledIds);
		const modelCount = roster.length;
		const allowSet = new Set(enabledIds);
		return {
			ok: true,
			enabled: resolveSwitchEnabled(panelSwitch, settings.registerProvider),
			source: switchSource(panelSwitch),
			llmAvailable: publisher.state.llmAvailable === true,
			registered: publisher.state.registered === true,
			error: typeof publisher.state.error === "string" ? publisher.state.error : null,
			modelCount,
			enabledCount: allowed === "all" ? modelCount : allowed === "none" ? 0 : roster.filter((row) => allowSet.has(row.id)).length,
			allowed,
			enabledIds,
			contextWindow,
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
				const entries = await readEntries$1(inference, providerStore);
				await publisher.publish(entries, await readEnabledIds(providerStore, publisher.state.enabledIds), []);
			} catch (error) {
				respondError(response, error);
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
				const entries = await readEntries$1(inference, providerStore);
				await publisher.publish(entries, ids, []);
			} catch (error) {
				respondError(response, error);
				return;
			}
			writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
		}, settings.allowedHosts)
	}));
	offs.push(ctx.webServer.register({
		kind: "exact",
		path: `${PROVIDER_PATH}/context`,
		handler: withOrigin(async (request, response) => {
			if ((request.method === void 0 ? "POST" : request.method) !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			if (body.contextWindow !== null && (typeof body.contextWindow !== "number" || !Number.isFinite(body.contextWindow) || body.contextWindow <= 0)) {
				writeJson(response, 400, {
					ok: false,
					error: "expected { contextWindow: number | null }"
				}, { "cache-control": "no-store" });
				return;
			}
			try {
				await providerStore.saveContextWindow?.(body.contextWindow);
				const entries = await readEntries$1(inference, providerStore);
				await publisher.publish(entries, await readEnabledIds(providerStore, publisher.state.enabledIds), []);
			} catch (error) {
				respondError(response, error);
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
				const entries = await readEntries$1(inference, providerStore);
				await publisher.publish(entries, [], []);
			} catch (error) {
				respondError(response, error);
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
//#region src/host/routes/draw.ts
/**
* 出图工具路由：开关读/写、模型偏好保存、回到默认。
*
* 三条路径：
*   - GET  `DRAW_PATH`        读开关 + 出图候选模型 + 工具挂载状态（无副作用）；
*   - POST `DRAW_PATH`        body `{enabled?: boolean, modelId?: string|null}` → 保存；
*   - POST `DRAW_PATH/reset`  忘掉面板值，回到 patch 默认。
*
* **与 provider 路由刻意分开**：provider 管「魔搭作为 chat provider」，本路由管
* 「给 agent 一个出图工具」。两者的开关、状态文件、候选集合都不同，合并会让
* 「关掉出图」波及 provider 的注册时序（详见 draw-store.ts 的头注）。
*
* 一处**与 provider 路由不同**的地方必须说清：provider 开关翻转会**立即**重注册
* （publish 是活的重建），而出图工具的开关翻转**要等下次 Host 启动**——peer 的
* tools registry 没有 unregister，工具一旦注册就摘不下来。所以本路由保存成功后
* 不改挂载状态，只在响应里给出 `mountPending`，让面板能说清这件事，而不是让用户
* 以为开关坏了。
*
* peer-free：不 import 任何 Host peer。
* @module dsh-connect-modelscope-token-plan/routes/draw
*/
/**
* 读目录条目，读不到按空目录降级。
*
* 与 provider 路由同一条纪律：GET 不能因为一次目录失败就把整个面板状态打掉——
* 出图候选为空只影响「能不能挑模型」，不影响开关的显示。
* @param {object} inference - inference client。
* @returns {Promise<unknown[]>} 归一目录条目。
*/
async function readEntries(inference) {
	const catalog = await inference.fetchModels().catch(() => ({ entries: [] }));
	return Array.isArray(catalog?.entries) ? catalog.entries : [];
}
/**
* 注册出图路由（两条路径）。
* @param ctx - host 根上下文（只用 `ctx.webServer`）。
* @param {DrawRouteWiring} wiring - 本路由读到的子集。
* @returns {Function} 注销回调。
*/
function registerDrawRoute(ctx, wiring) {
	const { settings, drawStore, inference, logger } = wiring;
	/**
	* 组装响应。GET 与写成功后的响应共用，两个方向不可能对「当前状态」说两套话。
	* @param {object} [extra] - 追加/覆盖字段。
	* @returns {Promise<object>} 响应体。
	*/
	const snapshot = async (extra = {}) => {
		const panelSwitch = await optional(drawStore.enabled());
		const panelModelId = await optional(drawStore.modelId());
		const entries = await readEntries(inference);
		const candidateIds = imageGenModelIds(entries);
		const effectiveModelId = resolveSwitchValue(panelModelId, settings.drawModelId === "" ? void 0 : settings.drawModelId) ?? null;
		return {
			ok: true,
			enabled: resolveSwitchEnabled(panelSwitch, settings.drawEnabled),
			source: switchSource(panelSwitch),
			candidateIds,
			candidateCount: candidateIds.length,
			preferredModel: effectiveModelId,
			preferredSource: switchSource(panelModelId),
			absentReason: drawToolNote(),
			/**
			* 开关的保存**不会**改变本次挂载的工具。
			*
			* 工具无法注销（peer 的 tools registry 没有 unregister），所以开关翻转只在
			* 下次 Host 启动时生效。面板据此显示一句说明——否则用户会以为开关坏了。
			* 判据：开关为开且本次挂载尚未注册成功（或缺席原因未知）。
			*/
			mountPending: resolveSwitchEnabled(panelSwitch, settings.drawEnabled) === true && drawToolNote() !== null,
			toolName: "modelscope_draw_image",
			...extra
		};
	};
	const offs = [];
	offs.push(ctx.webServer.register({
		kind: "exact",
		path: DRAW_PATH,
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
			const hasEnabled = typeof body.enabled === "boolean";
			const hasModel = body.modelId === null || typeof body.modelId === "string";
			if (!hasEnabled && !hasModel) {
				writeJson(response, 400, {
					ok: false,
					error: "expected { enabled?: boolean, modelId?: string|null }"
				}, { "cache-control": "no-store" });
				return;
			}
			if (body.enabled !== void 0 && !hasEnabled) {
				writeJson(response, 400, {
					ok: false,
					error: "enabled must be a boolean"
				}, { "cache-control": "no-store" });
				return;
			}
			if (body.modelId !== void 0 && !hasModel) {
				writeJson(response, 400, {
					ok: false,
					error: "modelId must be a string or null"
				}, { "cache-control": "no-store" });
				return;
			}
			try {
				if (hasEnabled) await drawStore.saveEnabled(body.enabled);
				if (body.modelId !== void 0) await drawStore.saveModelId(body.modelId);
			} catch (error) {
				respondError(response, error);
				return;
			}
			writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
		}, settings.allowedHosts)
	}));
	offs.push(ctx.webServer.register({
		kind: "exact",
		path: `${DRAW_PATH}/reset`,
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
				await drawStore.reset();
			} catch (error) {
				respondError(response, error);
				return;
			}
			writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
		}, settings.allowedHosts)
	}));
	return () => {
		for (const off of offs) try {
			off();
		} catch (error) {
			logger?.warn?.(`draw route unregister failed: ${redactedError(error)}`);
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
		registerProviderRoute(ctx, wiring),
		registerDrawRoute(ctx, wiring)
	];
}

//#endregion
//#region src/host/index.ts
/**
* dsh-connect-modelscope-token-plan — Host 半边（thin router）。
*
* 读魔搭 API-Inference 的**本地用量**，并把它与官方魔粒余额一起经一条只读 /api
* 路由喂给 Client 面板。口径分工：推理响应**不携带**额度头（SPIKE.md §结论 1），但
* 官方另有魔粒余额端点（`GET {siteBase}/openapi/v1/magicubes/balance`，SPIKE.md
* 文首后记，2026-10-04 实测可用），面板头条读的是它；本文件下的兄弟模块只负责本地
* 计数那一半（按模型分布 / 本地趋势 / 429 事件流），回答官方余额答不了的问题。
* 重活都在专注的兄弟模块里，本文件
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
*   - `usage-observer.ts`     真实对话 → 本地计数/事件（观察流出口，见该文件头）
*
* @module dsh-connect-modelscope-token-plan
*/
/**
* Host 入口：装配 wiring、注册路由、挂卸载副作用。
* @param ctx - Host 根上下文。
* @param config - 行的原始 patch 配置（无 schema，未校验；坏配置以
*   configError 经快照呈现，而不是在挂载时炸掉整台插件）。
* @param deps - 测试缝（`HostDeps`：fetchImpl / getLlm / emit / credentials / env
*   与出图那两条）。真实 Loader 不传；**每个缝不传时都必须落回 ctx 或全局默认**，
*   产品行为零漂移。声明与接线由 `test/deps-wiring.test.mjs` 双向扫描守着。
*/
function apply(ctx, config = {}, deps = {}) {
	const { settings, configError } = resolveSettings(config);
	const tokenStore = createTokenStore({
		credentials: deps.credentials !== void 0 ? deps.credentials : () => ctx.get("credentials") ?? null,
		env: deps.env
	});
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
	const drawStore = createFileDrawStore({
		profile,
		logger: ctx.logger
	});
	const publisher = createProviderPublisher({
		settings,
		panelSwitch: () => providerStore.enabled(),
		getLlm: deps.getLlm ?? ((service) => ctx.get?.(service) ?? null),
		resolveApiKey: async () => (await tokenStore.resolve()).value,
		usage: {
			recordCall: (input) => usageStore.recordCall({
				modelId: input.modelId,
				tokens: input.tokens
			}).catch(() => {}),
			recordEvent: (input) => usageStore.recordEvent(input).catch(() => {})
		},
		emit: deps.emit ?? ((event) => ctx.emit?.(event)),
		...deps.loadAdapterModule ? { loadAdapterModule: deps.loadAdapterModule } : {},
		logger: ctx.logger
	});
	/**
	* 当前允许清单：落盘优先，读不到回退内存最近一次 publish 的清单。
	*
	* 判据与另外两个消费者（`snapshot-aggregate.ts` 的面板块、`routes/provider.ts`
	* 的 GET）**共用** {@link resolveEnabledIds}——空清单是「不过滤，提供全部模型」，
	* 那是 provider-store 的契约，不是「没有答案」。本函数曾经自己写成
	* `stored.length > 0` 才算数，于是**可读的空清单**（操作者按 versionNote 的建议
	* 删掉 provider.json，或清单被保存为空）会让面板说 all、轮询却继续按内存里的旧
	* 清单注册：面板与 Host 对「正在提供什么」各说一套。只有读**抛错**（`.catch`
	* → null）才回退内存。
	* @returns {Promise<string[]>}
	*/
	const currentEnabledIds = async () => resolveEnabledIds(await providerStore.enabledIds().catch(() => null), publisher.state.enabledIds);
	/**
	* 一次目录轮询：拉目录，再 publish 当前 offer。
	*
	* **窗口覆盖必须参与**：catalogSignature 含窗口值，轮询若用未打标条目 publish，
	* 用户保存覆盖后的每次轮询都会因「签名不同」把注册摘下重挂（覆盖每 pollSeconds
	* 静默回退一次、适配器每轮重建）。所以 fetch **前**先读落盘覆盖传给 fetchModels，
	* 与 `currentEnabledIds` 同一模式。
	*
	* fetch **后**再读一次：目录拉取可能耗时数百毫秒，期间用户可能保存了新覆盖——
	* 保存路由已经用新值 publish 过，此时用旧标条目 publish 反而把注册**倒退**一个
	* 周期；这种窗口内跳过本轮即可（下一轮轮询自然带新值）。清单沿用 fetch 后读的
	* 老顺序（捕获 fetch 期间的编辑），两条时序理由同源。
	* @returns {Promise<void>}
	*/
	const runPoll = async () => {
		const contextWindow = await providerStore.contextWindow().catch(() => null);
		let catalog = null;
		try {
			catalog = await inference.fetchModels(contextWindow);
		} catch (error) {
			ctx.logger?.warn?.(`${name}: catalog fetch failed (${redactSecrets(errMsg(error))}) — the next poll retries; the panel keeps its degraded models block`);
			return;
		}
		if (await providerStore.contextWindow().catch(() => null) !== contextWindow) return;
		try {
			await publisher.publish(catalog.entries, await currentEnabledIds(), []);
		} catch (error) {
			ctx.logger?.warn?.(`${name}: publish failed (${redactSecrets(errMsg(error))}) — the catalog is current, only the provider registration did not land`);
		}
	};
	const wiring = {
		settings,
		configError,
		tokenStore,
		usageStore,
		inference,
		providerStore,
		drawStore,
		publisher,
		logger: ctx.logger
	};
	const offs = registerRoutes(ctx, wiring);
	ctx.effect(() => {
		runPoll();
		registerDrawTool(ctx, wiring, deps);
		const timer = setInterval(() => {
			runPoll();
		}, settings.pollSeconds * 1e3);
		return () => {
			clearInterval(timer);
			resetDrawToolNote();
			publisher.dispose();
			publisher.release();
			for (const off of offs) try {
				off?.();
			} catch (error) {
				ctx.logger?.warn?.(`${name}: route unregister failed: ${redactSecrets(errMsg(error))}`);
			}
		};
	}, `${name}: routes`);
}

//#endregion
export { apply, inject, name, resolveSettings };