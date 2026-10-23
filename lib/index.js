import { A as verbatim, C as degrade, D as pluginError, E as optional, O as redactSecrets, T as obj, _ as enabledCountOf, a as name, b as hasHardQuotaWordingIn, c as LLM_DISPLAY_NAME, d as drawCandidates, f as imageGenModelIds, g as rosterWithAvailability, h as resolveDrawModelChoice, i as isAdmitted, k as str, l as LLM_PROVIDER_ID, m as normalizeEntry, n as PLUGIN_VERSION, o as resolveSettings, p as isVisionModel, r as inject, t as DRAW_TIMEOUT_MAX_MS, v as parseAllowedList, w as errMsg, x as looksLikeRateLimit } from "./host-config.js";
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
		* 把面板输入的令牌存成引用；**两端空白先 trim**，空白值视为没输入。
		*
		* **为什么 trim 而不是原样存**：校验用的是 `value.trim()`，落库却曾是原值——
		* 校验与落库必须是**同一个值**，否则「通过校验的值」与「发出去的值」不是一个东西。
		* 实测（2026-10-19）：`save("  ms-3f2a…  ")` 会把带着前后空格的串存进凭据服务，
		* 而它拼出的请求头是 `Bearer   ms-…  `——用户粘进一个空格就换来一个语焉不详的
		* 401，面板却显示「已保存」。只 trim 两端，令牌中间的形状（分段连字符）不动。
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
			const value = verbatim(token, "").trim();
			if (value === "") throw new Error("a ModelScope token is required");
			if (!isPlausibleToken(value)) throw new Error("that does not look like a ModelScope access token (expected ms- followed by at least 16 hex digits); if you are sure the token is correct, this plugin's shape check may be out of date");
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
		*
		* **先 unset 成功、再删内存**：反过来的顺序有一个竞态——unset 抛错时内存
		* 已删，下次 resolve() 会走 env 回退读回那个本该被删掉的令牌（如果 env
		* 里也有 `MODELSCOPE_API_KEY`）。用户以为凭据已删干净，但它「复活」了。
		* 现在 unset 失败时内存保留，resolve() 会读到内存里的旧值并报错（因为
		* `source` 不是 `null`，但用户认为已经删了）——至少不会静默回退到 env。
		*/
		async forget() {
			const service = resolveService();
			if (service !== null && typeof service.unset === "function") await service.unset(TOKEN_REF);
			memory.delete(TOKEN_REF);
			lastCheck = null;
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
* 4. 第四步删掉了{@link createStateReadCache} 的 `inheritFrom`——一个从未被
*    任何 store 使用、且写回路径绕过写队列的迁移缝（死代码 + 有害形状 +
*    文档误导三合一，裁定见该函数的说明）；同时把{@link writeStateFile} 的
*    临时文件清理从「rename 失败」一条路扩大到**任何**失败路径。
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
async function writeStateFile(file, payload, { temporary }) {
	try {
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
function createStateReadCache(readThrough, options = {}) {
	const { ttlMs = STATE_READ_TTL_MS, now = Date.now } = options;
	let cached = void 0;
	let cachedAt = 0;
	return {
		/**
		* 读值：TTL 内返回缓存，过期则穿透到 `readThrough()`。
		* @returns {Promise<T|null>}
		*/
		async read() {
			if (cached !== void 0 && now() - cachedAt < ttlMs) return cached;
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
//#region src/shared/codes.ts
/**
* 错误分类码表的**单一真源**——Host 与 Client 同读这一份。
*
* 为什么从 `host/codes.ts` 搬来：这张表曾经在 Client 侧有一份「刻意副本」
* （`client/snapshot.ts` 的 `CLIENT_CODE`），理由是「浏览器无法 import Host
* 模块」。那个理由已经过期——`shared/wire.ts` 的运行时值（如
* `SNAPSHOT_REQUIRED_KEYS`）早就在双端 import，浏览器 bundle 拿得到 shared/
* 下的任何模块。两份表必然漂移，而漂移的后果是最需要人看的内部错误没有引导
* 文案（INTERNAL_ERROR 当初就是这么漏的）。码表住 shared，Host 的分类函数
* （`classifyStatus` / `classifyRateLimit` / `parseRetryAfterMs`）留在
* `host/codes.ts`——那些读上游响应，是 Host 独有的行为。
*
* 魔搭的分类现实（SPIKE.md）：上游不带任何额度头，额度耗尽与每分钟限频都只
* 会以 429 + 文案出现，所以 429 的分诊是**按 body 文案**做的保守二分——
* QUOTA_EXCEEDED 快速失败不重试，RATE_LIMITED 交给调用方退避。分不清时归
* RATE_LIMITED（退避是两方向里更安全的那个）。
*
* @module dsh-connect-modelscope-token-plan/codes
*/
/**
* 面板按它分流的稳定码表 —— Client 的 `GUIDANCE_BY_CODE` 以这份表的键为契约
* （且以 `CodeValue` 为**类型**契约：缺键是编译错误，不再只靠测试红）。
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
	* 本表是 `GUIDANCE_BY_CODE` 的键集真源——新增 client 码必须同时进
	* 这张表，两侧才同步。
	*/
	PAYLOAD_ERROR: "payload_error"
});

//#endregion
//#region src/host/codes.ts
/**
* Host 侧的 429 分诊分类函数。**码表本身已迁至 `shared/codes.ts`**（双端同读，
* 见那里的搬迁理由）；本文件只剩「读上游响应」的 Host 独有行为，并把 CODE
* 再导出一次，让 Host 各模块的 `from "./codes.ts"` 导入路径不变。
*
* 魔搭的分类现实（SPIKE.md）：上游不带任何额度头，额度耗尽与每分钟限频都只
* 会以 429 + 文案出现，所以 429 的分诊是**按 body 文案**做的保守二分——
* QUOTA_EXCEEDED 快速失败不重试，RATE_LIMITED 交给调用方退避。分不清时归
* RATE_LIMITED（退避是两方向里更安全的那个）。
*
* @module dsh-connect-modelscope-token-plan/codes
*/
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
	return hasHardQuotaWordingIn(message) ? "quota" : "rate_limit";
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
* 旧共享布局**不继承**（2026-10-18 补记的裱定）：profile 分段前写在共享目录里的
* usage.json 不做一次性迁移——它回答「这个 profile 的调用吃了多少额度」，而无
* profile 时期（宿主不提供 profileContext）的账不属于任何一个 profile，整段搬
* 过来是把那段账算成这个 profile 的。宿主升级后开始提供该服务时，旧文件原地
* 保留，由 `npm run doctor` 以 shared (legacy) 作用域报出——面板不搬历史，但操作者看得见
* 它（诊断诚实性，见 doctor.ts）。（usage-prefs 的单值偏好反而继承，裱定见
* usage-prefs-store.ts 头注）。
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
* @param {number} [options.retentionDays] - 天桶**保留**数（超出即修剪；从配置注入，
*   让「配置改小」在下次写入时生效，而不是等一个固定的内部常数）。与「显示多少天」
*   是两件事——显示窗口由调用方传给 `trend(days)`，保留窗口恒 ≥ 它（host-config 夹）。
* @param {number} [options.maxEvents] - 事件流上限。
* @param {() => Date} [options.now] - 时钟源；测试注入。
* @param {{warn?: (message: string) => void}} [options.logger] - ctx.logger。
*/
function createFileUsageStore({ name, profile = null, retentionDays = 90, maxEvents = 50, now = () => /* @__PURE__ */ new Date(), logger }) {
	const dir = profileStateDir(name, profile);
	const file = join(dir, "usage.json");
	/** 最近一次解析异常（损坏即忽略的痕迹），快照转 shapeWarnings。 */
	let anomaly = null;
	/**
	* 最近一次**写**失败的痕迹。
	*
	* 与 {@link anomaly} 分开记，因为两者的寿命不同：解析异常是**读**出来的，下一次
	* 读就会覆盖它（读到好的就恢复）；写失败是**写**出来的，只有一次成功的写才能
	* 抹掉它——读得动旧值不代表上一次写落了盘（读回来的永远是上一次**成功**写下去
	* 的那一份）。
	*/
	let writeAnomaly = null;
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
	/**
	* 把内存态写盘（原子），失败不抛——计数是尽力而为的观测，不是事务。
	*
	* 但「不抛」不等于「不说」。这一句注释原先与实现相反：writeStateFile 失败会**抛**
	* （state-store.ts 的 writeStateFile 在 catch 里重抛），抛给谁？本仓的用法是
	* index.ts 那句 `.catch(() => {})`（理由见那里：观测失败不是对话失败）——于是
	* 一次写失败被彻底咽掉：面板继续显示上一次成功落盘的数字，计数看起来是活的，
	* 其实早就冻住了，而**没有任何人知道**（没有日志，没有 shapeWarning）。
	*
	* 所以失败要留两处痕迹：日志（给操作者）与 {@link writeAnomaly}（进快照的
	* shapeWarnings，给面板）。吞掉的是失败，不是失败的原因。
	*/
	const persist = async (payload) => {
		try {
			await ensureStateDir(dir);
			await writeStateFile(file, JSON.stringify(payload), { temporary: temporaryOf(dir, "usage.json") });
		} catch (error) {
			const note = `usage-state: write failed (${redactSecrets(errMsg(error))})`;
			writeAnomaly = note;
			logger?.warn?.(`${name}: ${note} — the local counters are not reaching disk; the panel still shows the last values that did`);
			return;
		}
		writeAnomaly = null;
		cache.remember(payload);
	};
	/**
	* 排队执行一次读-改-写；版本冲突时整个变更是 no-op。
	*
	* 闸在**临界区内部**由 diskVersionBlocksWrites 现读磁盘判定，不读内存里的
	* readOnly——那个变量只用于日志去重与「闸已抬起」通知，删掉它不会让任何一次
	* 写入被放行或拦住（2026-10-18 变异实证：删掉复位块后「删文件后写入必须恢复」
	* 与「新计数落盘」两条断言仍然全绿）。
	*
	* 注释曾写「只读闸置位时整个变更是 no-op」——把判定归给内存闩锁。a61db2f（10-04，
	* 首次提交）起就是这么写的，那时磁盘闸还没长出来，那句话是真的；403bfbc（10-05）
	* 把守卫改成临界区内现读磁盘之后它就过期了，一直没被发现——因为没有任何断言
	* 读它，它只是一句注释。
	*/
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
	/** 修剪：只留最近 retentionDays 个天桶（按 dateKey 排序，今天不删）。 */
	const pruneDays = (payload, todayKey) => {
		const keep = new Set(Object.keys(payload.days).sort().slice(-Math.max(1, retentionDays)));
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
		/**
		* 今天的单模型计数（只含有记录的模型，dayCalls/dayTokens 口径，均跨日清零）。
		*
		* 三种答案，与 {@link daily} / {@link trend} 同一条红线（wire.ts：读不到 ≠ 0）：
		*   - 数组 —— 今天的单模型记录（只含有记录的模型；空数组 = 今天确实没有记录，
		*     是**真实零**）；
		*   - `null` —— **读不到**：载荷读不出来（损坏 / 形状不对 / 更新构建写的版本 /
		*     存在却不可读）。面板渲染「—」，不是空排行。
		*
		* 这是 2026-10-18 补上的最后一块拼图：daily() 三态在 2026-10-16、trend() 在
		* 本轮都补上了，perModelToday() 一直停在 `payload?.models ?? {}`——同一个坏文件
		* 在头条画「—」、在单模型排行却画「还没有本地调用记录。」，同一份坏数据在
		* 同一个卡片里给出两种答案。判据与 daily() 逐字一致：文件不存在才是真实的零，
		* 文件在却读成空是信息丢失。
		*
		* @returns {Array<{modelId: string, calls: number, tokens: number|null, lastAt: string|null}> | null}
		*/
		async perModelToday() {
			const payload = await cache.read();
			if (payload === null) return await pathExists(file) ? null : [];
			const todayKey = localDateKey(now());
			const out = [];
			for (const [modelId, counter] of Object.entries(payload.models ?? {})) {
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
		/**
		* 最近 N 天趋势（含今天）。
		*
		* 三种答案，与 {@link daily} 同一条红线（wire.ts：读不到 ≠ 0）：
		*   - `TrendBucket[]` —— 逐日桶，缺桶 = 该日 0 次（**真实零**：那天确实没有
		*     记录，是已知答案）；
		*   - `null` —— **读不到**：载荷读不出来（损坏 / 形状不对 / 更新构建写的
		*     版本 / 存在却不可读）。面板渲染「—」，不是一片零柱。
		*
		* 判据与 daily() 逐字一致：**文件不存在**才是真实的零（这台 Host 从未经本
		* 插件调用过），**文件在却读成空**是信息丢失。缺桶补 0 与整份读空补 0 是两件
		* 完全不同的事，前者是数据，后者是伪造。
		*
		* 这是 2026-10-18 补上的一块拼图：daily() 早在 2026-10-16 就有了三态，
		* trend() 一直只做了一半——`payload === null` 时照样逐日 push `{calls: 0}`，
		* 于是「usage.json 被写坏」在今日计数上画「—」、在趋势图上却画 14 根结实的
		* 零柱，同一份坏数据在两个区块给出两种答案。shapeWarnings 里那条 anomaly
		* 确实会出现，但它说「usage.json 有问题」，不说「你看到的这条趋势线是假的」。
		*
		* @returns {TrendBucket[] | null}
		*/
		async trend(days = retentionDays) {
			const payload = await cache.read();
			if (payload === null) return await pathExists(file) ? null : [];
			const out = [];
			const cursor = now();
			for (let offset = Number(days) - 1; offset >= 0; offset -= 1) {
				const date = new Date(cursor);
				date.setDate(date.getDate() - offset);
				const key = localDateKey(date);
				const bucket = payload.days[key];
				out.push({
					dateKey: key,
					calls: bucket?.calls ?? 0,
					tokens: bucket?.tokens ?? 0
				});
			}
			return out;
		},
		/**
		* 事件流（Newest-first，已截断）。
		*
		* 三种答案，与 {@link daily} / {@link trend} 同一条红线（wire.ts：读不到 ≠ 0）：
		*   - 数组 —— 读到的事件（空数组 = 确实没有事件，是**真实零**）；
		*   - `null` —— **读不到**：载荷读不出来（损坏 / 形状不对 / 更新构建写的版本 /
		*     存在却不可读）。面板渲染「—」，不是「暂无事件」。
		*
		* 与 perModelToday() 同一块拼图（2026-10-18）：`payload?.events ?? []` 把
		* 「读不到」和「确实没有」合成同一种答案，坏文件在事件卡上假装岁月静好。
		*
		* @returns {QuotaEvent[] | null}
		*/
		async events() {
			const payload = await cache.read();
			if (payload === null) return await pathExists(file) ? null : [];
			return [...payload.events ?? []];
		},
		/**
		* 最近一次异常（无异常为 null）——快照转 shapeWarnings。
		*
		* 写失败的痕迹优先于读侧的解析异常：它更近、也更严重（解析异常说「这份文件
		* 读不懂」，写失败说「我们刚写的东西没落盘」）。
		*/
		anomaly() {
			return writeAnomaly ?? anomaly;
		}
	};
}
/**
* 从 429/错误事件流推断「哪些模型当前额度耗尽」——**纯函数**，判定规则的唯一真源。
*
* 为什么需要它：官方只给**账户级**魔粒余额（`/openapi/v1/magicubes/balance`），
* 没有 per-model 额度端点；而「哪个模型刚才在限频」恰恰是面板独家能答的问题。
* 证据只有两类：事件流（`kind` 已按 llm-error-fix **重分类后**的口径，见
* `usage-observer.ts` 头注）与单模型今日计数，本函数只用前者——计数分不清
* 成功与失败（`recordCall` 按流计次、含失败），拿它当证据会猜。
*
* 判定规则（三条，全部可机械复现）：
*   1. **只有 `kind:"quota"` 算证据**。`rate_limit` 是瞬时限频（peer 会退避
*      重试，请求打得出去），`error` 是未知——把任何 429 都当耗尽是 0.2.0
*      已修掉的误判（QUOTA 快速失败 vs RATE_LIMIT 退避，两条路不同）。
*   2. **只在推断窗口内有效**：事件 `at` 落在 `[now - windowMinutes, +∞)`。
*      窗口外的旧证据不算——免费额度按天重置，昨天的耗尽不该关掉今天的模型。
*   3. **不推断恢复**：成功的流不发事件，所以「模型已恢复」在这份数据里
*      **不可观测**。已恢复的模型最多灰显满一个窗口——方向是保守的（宁可少
*      提供一会，不把注定 429 的模型放进选择器），且面板灰显带着原因，
*      不是静默消失。
*
* 总量语义：`events` 是环形缓冲（`maxEvents` 截断、Newest-first），所以「窗口
* 内没有证据」可能是**真没有**、也可能是**证据被截掉了**——后者只发生在
* 极端刷屏（50 条以内）时。**方向是假阴性，不是保守**：证据被挤掉 → 集合收缩
* → 一个仍耗尽的模型可能提前回灰、被重新放进选择器。以前这里写的是「保守收敛」，
* 把危险方向说成了安全方向（下一轮会话会据此放松，所以改掉）。它之所以还能接受，
* 是因为失败面很小且自限：窗口最长 1440min、事件天然会滑出，`reconcile` 每轮
* 现算，下一个 quota 事件会立刻把它重新灰掉。时间戳解析不出的事件跳过，不猜。
*
* @param {readonly QuotaEvent[]|null|undefined} events - 事件流（任意顺序）。
* @param {Date|number} [now] - 时钟源（测试注入）。
* @param {number} [windowMinutes] - 推断窗口（分钟）。非正/非有限时返回空集
*   ——总量防御：host-config 已把配置夹到 [5, 1440]，走到这里就是编程错误，
*   「没有证据」比按坏窗口算出一个莫名的集合诚实。
* @returns {string[]} 当前应视为额度耗尽的模型 id（去重、排序，稳定快照）。
*/
function exhaustedModelIds(events, now = Date.now(), windowMinutes = 60) {
	if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return [];
	const list = Array.isArray(events) ? events : [];
	const nowMs = now instanceof Date ? now.getTime() : Number(now);
	if (!Number.isFinite(nowMs)) return [];
	const since = nowMs - windowMinutes * 6e4;
	const out = /* @__PURE__ */ new Set();
	for (const event of list) {
		if (event === null || typeof event !== "object") continue;
		if (event.kind !== "quota") continue;
		const at = Date.parse(String(event.at));
		if (!Number.isFinite(at) || at < since) continue;
		const modelId = typeof event.modelId === "string" ? event.modelId : "";
		if (modelId !== "") out.add(modelId);
	}
	return [...out].sort();
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
* 1. 只收**当前魔搭目录里真实存在**的 id（2026-10-23 实拉 `/v1/models` 全集
*    37 个中筛出 21 个）；目录下架的条目应随手删除，表不是历史档案。
* 2. 每条注明来源 host 与核对日期；有多个数据源时写主流值并留离群说明。
* 3. 覆盖优先级由 `curatedWindowOf` 的调用方（inference-client 打标）保证：
*    目录声明过窗口的条目不进打标，策展表永不推翻平台声明。
* 4. 生图/语音模型（Qwen-Image-Edit、ACE-Step 等）无对话上下文，不收。
*/
/**
* 本表最后一次与 models.dev / 真机目录核对的日期（ISO 日期，UTC）。
*
* 存在的理由：策展表是**静态知识**，而目录会上下架。维护纪律要求「目录下架的条目
* 应随手删除」，但没有任何机制会自动知道下架发生了——没有这个日期，表会悄悄腐烂，
* 而使用者无从判断一个值是三个月前还是三年前核的。快照侧据此在表过期时给一条
* shapeWarning（见 {@link curatedCatalogStale}）。
*/
const CURATED_AS_OF = "2026-10-23";
/**
* 策展表距上次核对已经过去多少天；日期解析不了返回 `null`。
* @param {Date} [now] - 时钟源（测试注入）。
* @returns {number|null} 天数（向下取整），或 null。
*/
function curatedCatalogAgeDays(now = /* @__PURE__ */ new Date()) {
	const asOf = Date.parse("2026-10-23T00:00:00Z");
	if (Number.isNaN(asOf)) return null;
	const delta = now.getTime() - asOf;
	return delta < 0 ? 0 : Math.floor(delta / 864e5);
}
/**
* 策展表是否该被复核了：距 {@link CURATED_AS_OF} 超过 `maxAgeDays` 天。
*
* 只回答「该提醒了吗」，不回答「表里的值错了」——过期的表往往仍然正确，只是
* 不再有核对背书。快照把它转成一条 shapeWarning，而不是拒绝使用表里的值。
* @param {Date} [now] - 时钟源（测试注入）。
* @param {number} [maxAgeDays] - 容忍的天数，默认 180。
* @returns {boolean}
*/
function curatedCatalogStale(now = /* @__PURE__ */ new Date(), maxAgeDays = 180) {
	const age = curatedCatalogAgeDays(now);
	return age !== null && age > maxAgeDays;
}
/** id → 标称上下文窗口（tokens）。键必须与魔搭目录 id 逐字一致。 */
const CURATED_CONTEXT_WINDOWS = {
	"deepseek-ai/DeepSeek-V4-Flash-0731": 1048576,
	"deepseek-ai/DeepSeek-V4-Pro": 1048576,
	"deepseek-ai/DeepSeek-V4-Pro-0813": 1048576,
	"deepseek-ai/DeepSeek-V4.1-Flash": 1048576,
	"deepseek-ai/DeepSeek-V4.1-Flash-1017": 1048576,
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
	"stepfun-ai/Step-5-Preview": 1e6,
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
	/**
	* 详情端点任务标签的**独立**缓存与 TTL——与目录/余额的 `read` 刻意分开。
	*
	* 标签回答「这个模型吃不吃图」，是出厂能力，几乎不变；目录/余额回答「现在有
	* 什么、还剩多少」——两者需要的陈旧度差着量级。它们曾共用 `cacheSeconds`
	* （默认 60 秒），而面板与对话框胶囊按 `pollSeconds`（默认 30s）轮询快照、
	* 快照每次都调 `fetchModels`：穿透时对目录里每个模型各打一次
	* `siteBase/api/v1/models/{id}`。当前目录 ~37 条 = **每轮 38 个 HTTP 请求、
	* 稳定每分钟一轮**（约 5 万/天），只为判一个布尔值，打的还是 modelscope.cn
	* 网站上一个非公开、非契约的接口。那不叫新鲜，叫白打。
	*
	* `maxAgeMs` 必须一起抬：coalesced-fetch 的清扫上限默认 1 小时（那是「任何
	* 调用方的最长 TTL」），不抬的话 6 小时的 TTL 会被清扫提前作废。键数等于目录
	* 里的模型数（约 40 条），无界增长不成立。
	*/
	const TAGS_TTL_MS = 216e5;
	const { read: readTags } = createCoalescedFetch({ maxAgeMs: TAGS_TTL_MS });
	/** 详情端点的并发：长 TTL 之后扇出已经很稀，没必要一上来 6 路齐发去撞主站。 */
	const TAG_FETCH_CONCURRENCY = 3;
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
	* undici 里未消费的 body 会**占住连接**直到 GC。标签扇出会对目录里 30–40 个
	* 模型并发打详情端点（`mapWithConcurrency` 分批），其中任何一条走「!ok」或
	* 「形状不符」分支，连接就一直挂着——短时间内连接池被这些挂起的响应吃满，
	* 后面的请求开始排队。
	*
	* `cancel()` 是显式的弃权：告诉 undici「这个 body 我不要了」，它会立刻释放
	* 连接而不是等GC。用 `void` 前缀是因为这是best-effort——取消失败不影响我们
	* 已经决定的结果。
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
	* `widgets[].task` 兜底）去重后的标签数组。
	*
	* **失败一律抛，绝不返回 `[]`**：本函数的结果会被 {@link TAGS_TTL_MS} 缓存
	* 六小时，而 `[]` 是一个**结论**（「这个模型没有任务标签」）。把 429 / 5xx /
	* 形状漂移降级成 `[]` 再缓存，等于让一次网络抖动把某个模型的视觉标签钉死半天
	* ——正是「读不到 ≠ 没有」的反面。coalesced-fetch 不缓存 rejection（失败被当
	* 「不是答案」共享，但不落盘），所以抛出去的那一轮不会被记住；调用方 catch 成
	* `[]`，只影响这一轮，下一轮照常重试。
	*/
	const fetchTaskTags = async (id) => {
		const detailUrl = settings.siteBase + "/api/v1/models/" + encodeURI(id);
		const response = await fetchWithTimeout(detailUrl, {
			method: "GET",
			headers: { accept: "application/json" }
		});
		if (!response.ok) {
			discardBody(response);
			throw new Error("model detail failed with HTTP " + String(response.status));
		}
		let json;
		try {
			json = await response.json();
		} catch {
			discardBody(response);
			throw new Error("model detail body was not JSON");
		}
		if (json === null || typeof json !== "object" || json.Code !== 200) throw new Error("model detail shape drifted (expected {Code:200, Data:{Tasks:[...]}})");
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
	/**
	* 令牌的稳定指纹（FNV-1a，32 位 hex）——只用作余额缓存的键。
	*
	* **不用 `token.slice(-6)` 那种末位截断**：两个不同令牌末 6 位相同的概率在
	* 1/16^7 量级，虽低但非零，而代价是一个 TTL（cacheSeconds，默认 60s）内把
	* A 的身份的余额当 B 的返回——缓存键的正确性不该交给运气。指纹不需要保密、
	* 不进日志（脱敏正则的形状与它无关），完整的哈希零成本。
	* @param {string} token - 访问令牌。
	* @returns {string} 8 位 hex 指纹。
	*/
	function tokenFingerprint(token) {
		let hash = 2166136261;
		for (let i = 0; i < token.length; i++) {
			hash ^= token.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0).toString(16).padStart(8, "0");
	}
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
			const cacheKey = contextOverride != null ? `models:override:${contextOverride}` : "models:catalog";
			const cacheTtl = contextOverride != null ? Math.min(settings.cacheSeconds * 1e3, 5e3) : settings.cacheSeconds * 1e3;
			return await read(cacheKey, async () => {
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
				const tagArrays = await mapWithConcurrency(ids, TAG_FETCH_CONCURRENCY, async (id) => {
					try {
						const cached = await readTags(`model-tags:${id}`, () => fetchTaskTags(id), TAGS_TTL_MS);
						return Array.isArray(cached) ? cached : [];
					} catch {
						return [];
					}
				});
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
			}, cacheTtl);
		},
		/**
		* 官方「魔粒」余额：GET siteBase/openapi/v1/magicubes/balance（Bearer
		* 令牌；2026-10-04 实测可用，匿名 401，SPIKE.md §魔粒）。coalesced 缓存
		* cacheSeconds，缓存键带令牌指纹（FNV-1a 完整哈希，不是末位截断——
		* 换令牌 ≤1 个 TTL 内必然读到新身份，且不同令牌不会因同后缀串味）。
		*/
		async fetchBalance() {
			const { value: token } = await tokenStore.resolve();
			if (token === "") throw pluginError(CODE.AUTH_ERROR, "no ModelScope token configured — set MODELSCOPE_API_KEY or save one in the panel");
			const url = settings.siteBase + "/openapi/v1/magicubes/balance";
			const key = "balance#" + tokenFingerprint(token);
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
			if (response.status >= 500) {
				discardBody(response);
				throw pluginError(CODE.UPSTREAM_ERROR, "modelscope returned HTTP " + String(response.status) + " (validity probe)");
			}
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
* Legacy adoption (ruling 2026-10-18): pre-§23 machines kept this state in
* the SHARED directory; a profile-scoped store inherits it ONCE, when its own
* file is missing. The seam lives in the read-through closure below, NOT in a
* cache option, and the write-back rides this store's write chain; an explicit
* `dir` (the tests) never inherits, and an explicit `forget()` is never
* resurrected. The mirror rulings for the other three state stores live in
* their own file headers: usage-prefs inherits the same way, usage / draw do
* NOT adopt — the old shared files stay put, and `npm run doctor` reports them
* as a `shared (legacy)` scope instead.
*
* @module dsh-connect-modelscope-token-plan/provider-store
*/
/**
* The "nothing stored" payload. Every absent / unreadable / foreign read
* collapses here, so the three call sites that produce it stay in step instead
* of each spelling out the same three `null`s.
*/
const EMPTY_PAYLOAD$3 = {
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
	const stateDir$2 = dir ?? providerDir(profile);
	const filePath = join(stateDir$2, "provider.json");
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
		await ensureStateDir(stateDir$2);
		await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary: temporaryOf(stateDir$2, "provider.json") });
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
	const readPayload = async () => await read() ?? EMPTY_PAYLOAD$3;
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
* draw.json 随出图工具一起诞生，晚于按 profile 分段（git 史上成立），且宿主一直提供
* profileContext 的机器上不存在共享布局里的旧 draw.json；provider.json 则需要
* （§23 之前它一直在共享目录）。
* 前提修正（2026-10-18）：「市面上不存在」只对宿主一直提供 profileContext 的机器成立。
* 宿主不提供时 profile 恒为 null，draw.json 今至仍写共享目录；宿主升级后提供该服务
* 时，同一个迁移窗口在 draw.json 上一模一样——那种窗口里旧 draw.json 不继承不搬，
* doctor 以 shared (legacy) 作用域报出，出图开关与模型偏好回 patch 默认（与 usage.json 同侧：
* 诊断可见 > 静默搬运）。
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
const EMPTY_PAYLOAD$2 = {
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
	const readPayload = async () => await cache.read() ?? EMPTY_PAYLOAD$2;
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
//#region src/host/draw-jobs.ts
/**
* 建一张出图作业表。
* @param {DrawJobsOptions} [options] - 容量与保护窗参数。
* @returns {DrawJobs} 作业表。
*/
function createDrawJobs(options = {}) {
	const maxJobs = Math.max(1, Math.floor(options.maxJobs ?? 64));
	const resumeWindowMs = Math.max(1, Math.floor(options.resumeWindowMs ?? 9e5));
	const hardMaxJobs = Math.max(maxJobs, Math.floor(options.hardMaxJobs ?? maxJobs * 2));
	/** @type {Map<string, DrawJob>} 插入顺序即淘汰顺序（Map 保序）。 */
	const jobs = /* @__PURE__ */ new Map();
	/**
	* 超容时的两级淘汰（判据见文件头「生命周期」）：
	*   软上限只淘汰已过续查保护窗的（越过总放弃线，续查只换来「超过总预算」）；
	*   硬上限保底——全是保护窗内的作业也绝不无界。
	* @param {number} now - 当前墙钟毫秒（`create` 的 `now` 缝传进来，测试可造旧作业）。
	*/
	const evictIfNeeded = (now) => {
		if (jobs.size <= maxJobs) return;
		for (const [id, job] of jobs) {
			if (jobs.size <= maxJobs) return;
			if (now - job.submittedAt >= resumeWindowMs) jobs.delete(id);
		}
		while (jobs.size > hardMaxJobs) {
			const oldest = jobs.keys().next();
			if (oldest.done === true) return;
			jobs.delete(oldest.value);
		}
	};
	return {
		create({ taskId, model, prompt, now }) {
			const jobId = taskId;
			const at = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
			const job = {
				jobId,
				taskId,
				model,
				prompt,
				submittedAt: at,
				polls: 0
			};
			const previous = jobs.get(jobId);
			if (previous !== void 0) job.polls = previous.polls;
			jobs.set(jobId, job);
			evictIfNeeded(at);
			return { ...job };
		},
		get(jobId) {
			const found = jobs.get(jobId);
			return found === void 0 ? null : { ...found };
		},
		notePolls(jobId, polls) {
			const found = jobs.get(jobId);
			if (found === void 0) return;
			found.polls += Math.max(0, Math.floor(polls));
		},
		drop(jobId) {
			jobs.delete(jobId);
		},
		dispose() {
			jobs.clear();
		},
		size() {
			return jobs.size;
		}
	};
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
* Resolve the effective numeric preference (e.g. how many days the trend chart
* shows): the same `panel ?? config` dialect as the other two shapes.
*
* Range clamping is deliberately NOT done here — the bound (a retention
* window) belongs to the caller that knows it (`host-config` / the snapshot
* aggregate), not to the precedence rule.
* @param {number|null} panel - the panel-saved value (`null` = never saved).
* @param {number} config - the patch-declared default.
* @returns {number} the effective preference.
*/
function resolveSwitchNumber(panel, config) {
	return panel ?? config;
}
/**
* Where the effective value came from — the panel when it saved one, the
* config otherwise. Rides with every resolved answer so the panel can name
* the side in charge.
* @param {boolean|string|number|null} panel - the panel-saved value.
* @returns {"panel"|"config"}
*/
function switchSource(panel) {
	return panel === null ? "config" : "panel";
}

//#endregion
//#region src/host/usage-prefs-store.ts
/**
* 用量面板的**显示偏好**——目前只有一个字段：趋势图的显示窗口（画多少天）。
*
* ## 为什么单独一个文件
*
*  - `usage.json` 是**数据**（天桶 / 单模型 / 事件），写路径是观测热路径。把一个
*    显示偏好混进去，会让「偏好读不到」与「计数文件损坏」共用一条降级语义；更要命
*    的是版本漂移——旧构建重写那份 payload 时会**静默丢掉**它不认识的键。
*  - `provider.json` 是 provider 注册的 desired state（开关 / 允许清单 / 窗口覆盖），
*    与「趋势图画多少天」无关；合成一份 payload 会让两边的写入时序互相牵连。
*
* 落点与 provider / draw 同一套分段规则：`$DSH_HOME/state/<profile>/<plugin>/usage-prefs.json`
* （无 profile 时落共享目录）。分段的意思是「这个 profile 想看多长」，两个 profile
* 不互相覆盖。
*
* legacy 继承（2026-10-18 裁定）：pre-profile 共享目录里的 usage-prefs.json 在
* 本 profile 自己的文件**不在场**时一次性继承——与 provider-store 同款手写缝
*（读路径内触发、回填排进**本 store 的写队列**、显式清除不复活）。为什么这个
* 搬而 usage.json 不搬：单值显示偏好回填无害，而历史计数是「本 profile 的账」，
* 搬过来是把无 profile 时期的账算成这个 profile 的（usage-store.ts 头注的裁定）。
*
* 优先级与所有 opt-in 开关同一份裁决（`switch-precedence.ts`）：面板保存值赢，
* 否则 `cordis.patch.yml` 的 `trendDays` 说了算；两者都会在 host-config 里被夹进
* 保留窗口之内（`retentionDays`）——**画得比留得多**会把已剪的日子画成 0。
*
* 完整性三件套与 provider / usage / draw **同源**（全部上收在 `state-store.ts`，
* 本文件只做调用方，论述见 `draw-store.ts` 头注，不在此重复）：写串行化
* （{@link createStateWriteQueue}）、写守卫（{@link guardStateWrite}，ADR-006）、
* 读侧说明（{@link stateVersionNote}）。
*
* doctor 覆盖：{@link describeUsagePrefsPayload} 给只读速览，`doctor.ts` 据此把
* usage-prefs.json 的「损坏 / 未知版本」报进症状表。
*
* @module dsh-connect-modelscope-token-plan/usage-prefs-store
*/
/** 本 store 落盘 payload 的版本。 */
const USAGE_PREFS_VERSION = 1;
/** 本 build 读得懂的版本集合（升级时把新号加进来，旧号保持可读）。 */
const KNOWN_USAGE_PREFS_VERSIONS = Object.freeze([1]);
const EMPTY_PAYLOAD$1 = {
	windowDays: null,
	version: null
};
/**
* 本 build 读不读得懂这个版本。
*
* 与 provider / draw 的 `isKnown*Version` 同形：**白名单**判据，不与
* {@link USAGE_PREFS_VERSION} 比较——升级后旧号仍要可读。读侧、报告侧
* （versionNote / describeUsagePrefsPayload）问的都是这一个函数，三者不可能就
* 「什么是未知版本」说两套话。写侧问的是 `state-store` 的 `isKnownStateVersion`
* （它额外放行 `null` = 没有文件，那是唯一该写的情形）。
* @param {unknown} version - 盘上读到的值（可能根本不是数字）。
* @returns {boolean}
*/
function isKnownUsagePrefsVersion(version) {
	return typeof version === "number" && KNOWN_USAGE_PREFS_VERSIONS.includes(version);
}
/**
* 归一一个保存的显示窗口：正整数（向下取整），或 `null`（= 跟随配置默认）。
*
* **不在这里夹上界**：上界是保留窗口（`retentionDays`），那是 host-config 的事，
* 此模块不该知道它。传进来的越界值由调用方（host-config / 快照聚合 / 路由）夹。
* @param {unknown} value - 原始值。
* @returns {number|null} 归一后的天数或 `null`。
*/
function normalizeWindowDays(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const days = Math.floor(value);
	return days > 0 ? days : null;
}
/** 本 store 的目录（与 provider / draw 同一套分段规则）。 */
function usagePrefsDir(profile, dir) {
	if (typeof dir === "string" && dir !== "") return dir;
	return profile ? profileStateDir(name, profile) : stateDir(name);
}
/**
* 显示窗口的**唯一**裁决 + 夹取：面板保存值优先（沿用全仓唯一方言
* {@link resolveSwitchNumber}），否则配置默认；随后落进 `[1, maxDays]`。
*
* 夹取放在这里而不是 store 里，是因为 store 不该知道上界；放在**本模块**而不是
* 两个调用方各写一遍，是因为「面板值 vs 默认」和「夹到保留窗口」加起来只有一条
* 正确算法——路由保存时与快照聚合渲染时各写一份，就会出现「面板显示 90 天、
* 图里只画了 14 天」这类两处不一致。
* @param {number|null} panel - 面板保存值（`null` = 未保存）。
* @param {number} fallback - 配置默认（已由 host-config 夹过）。
* @param {number} maxDays - 上界（保留窗口，`retentionDays`）。
* @returns {number} 生效天数。
*/
function resolveWindowDays(panel, fallback, maxDays) {
	const want = resolveSwitchNumber(panel, fallback);
	return Math.min(Math.max(1, Math.floor(want)), Math.max(1, Math.floor(maxDays)));
}
/**
* 文件支撑的用量显示偏好。
* @param {StoreOptions} [options] - `{ dir, profile, ttlMs, logger }`。
* @returns {object} store 句柄。
*/
function createFileUsagePrefsStore(options = {}) {
	const { dir, profile = null, ttlMs = STATE_READ_TTL_MS, logger } = options;
	const stateDir$1 = usagePrefsDir(profile, dir);
	const filePath = join(stateDir$1, "usage-prefs.json");
	/**
	* 写一份 payload 并落盘。
	*
	* ADR-006 写守卫（{@link guardStateWrite}）先问盘：版本不认或文件读不出 →
	* 返回拒绝理由（已 degrade 记录），不落笔。守卫与随后的写入在同一个临界区里
	* （由 patchPayload 的链保证），判据与执行之间不隔任何 await。
	* @param {object} body - 要持久化的 JSON 体。
	* @returns {Promise<string|null>} 拒绝原因，或 `null` = 已写入。
	*/
	const writePayload = async (body) => {
		const refusal = await guardStateWrite(filePath, KNOWN_USAGE_PREFS_VERSIONS, {
			label: "usage-prefs-state",
			logger
		});
		if (refusal !== null) return refusal;
		await ensureStateDir(stateDir$1);
		await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary: temporaryOf(stateDir$1, "usage-prefs.json") });
		return null;
	};
	/** 写串行化：读-改-写必须排队（详见{@link createStateWriteQueue}）。 */
	const writeQueue = createStateWriteQueue();
	/**
	* 解析一份路径上的 payload；认不出的版本读作「没设过」但**记住**版本号——读侧
	* 宽容、versionNote 负责把宽容说出口（写侧守卫已挡住覆盖，两半合起来才是
	* ADR-006）。
	*/
	const parseAt = async (path) => {
		const source = obj(await readStateJson(path));
		const version = typeof source.version === "number" ? source.version : null;
		if (!isKnownUsagePrefsVersion(version)) return {
			windowDays: null,
			version
		};
		return {
			windowDays: normalizeWindowDays(source.windowDays),
			version
		};
	};
	/** 读本 profile 自己的文件。 */
	const parsePayload = async () => parseAt(filePath);
	const legacyFile = dir === void 0 && profile ? join(stateDir(name), "usage-prefs.json") : null;
	const cache = createStateReadCache(async () => {
		const own = await parsePayload();
		if (own.windowDays !== null || legacyFile === null || own.version !== null) return own;
		const legacy = await parseAt(legacyFile);
		if (legacy.windowDays === null) return own;
		await writeQueue.enqueue(() => writePayload({
			version: 1,
			windowDays: legacy.windowDays,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		}).then(() => void 0, () => void 0));
		return legacy;
	}, { ttlMs });
	/**
	* 读当前 payload。
	* @returns {Promise<UsagePrefsPayload>}
	*/
	const readPayload = async () => await cache.read() ?? EMPTY_PAYLOAD$1;
	/**
	* 读-改-写，**整段排队**。
	*
	* 基线每次从磁盘重读（`parsePayload` 直读，不走 TTL 缓存）：两个 Host 进程共享
	* 一个状态目录，而缓存里可能是写入前的值（provider §8d 的回归用例在 draw 上
	* 同样成立，见 draw-store.ts）。写成功即 `cache.remember`。
	*
	* 失败语义与 provider / draw 对齐：拒绝原因与 IO 失败都**向上抛**（save 抛、
	* 路由 catch 后 `respondError` 呈报），链自己吞掉失败继续走后面的保存。
	*
	* @param {number|null} windowDays - 新的显示窗口；`null` = 清除（回到配置默认）。
	* @returns {Promise<void>}
	*/
	const save = (windowDays) => writeQueue.enqueue(async () => {
		const body = { version: 1 };
		if (windowDays !== null) body.windowDays = windowDays;
		body.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		const refusal = await writePayload(body);
		if (refusal !== null) throw new Error(refusal);
		cache.remember({
			windowDays,
			version: 1
		});
	});
	return {
		/** 面板保存的显示窗口天数；`null` = 跟随配置默认。 */
		async windowDays() {
			return (await readPayload()).windowDays;
		},
		/**
		* 盘上带着本构建读不懂的版本时的一句说明，否则 `null`。
		*
		* 读侧宽容（未知版本读作「没设过」）的另一半：快照聚合把它转进
		* `shapeWarnings`，doctor 报同一份文件。没有它，「保存的显示窗口被忽略」在
		* 面板上就是「从未保存过」——而回退方向是配置默认。
		* @returns {Promise<string|null>}
		*/
		async versionNote() {
			const version = (await readPayload()).version;
			if (version === null || isKnownUsagePrefsVersion(version)) return null;
			return stateVersionNote({
				label: "usage-prefs-state",
				file: filePath,
				version,
				known: KNOWN_USAGE_PREFS_VERSIONS,
				consequence: "the saved trend window is being answered as \"not set\", so the chart falls back to the config default."
			});
		},
		/** 保存显示窗口（`null` = 清掉，回到配置默认）。 */
		async saveWindowDays(windowDays) {
			if (windowDays !== null && !(typeof windowDays === "number" && Number.isFinite(windowDays) && Math.floor(windowDays) > 0)) throw new TypeError("trend window expects a positive integer or null");
			await save(windowDays === null ? null : Math.floor(windowDays));
		},
		/** 落盘路径（诊断与测试用）。 */
		filePath
	};
}

//#endregion
//#region src/host/roster-seen-store.ts
/**
* 「本机第一次见到这个模型是什么时候」——胶囊那句「· N 新模型」的唯一事实源。
*
* ## 它回答什么，不回答什么
*
* 只记**首见时间戳**：每个 id 第一次出现在本机拉到的目录里的那一刻。由此派生的
* 那句话必须说成「本机首次见到的模型」，**不能**说成「网关新增」——上游的
* `/v1/models` 不提供「上架时间」，本插件没有任何字段能证实某个模型是这周才上
* 的。能证实的只有「本机从哪天开始看见它」，那就只说这一句。
*
* 也**不**记录活动/促销变化（限免、错峰、签到）：那些是实时读数，面板的余额块与
* 胶囊 popover 已经直接画上游给的现值，再造一本「促销 diff 账」就是同一事实两本
* 账，两本迟早说两套话（ADR-017 的口径）。
*
* ## 一次调用同时 diff 与落盘
*
* {@link RosterSeenStore.note} 不能拆成「先 diff 缓存、稍后再写」：那样两个并发
* 的收敛轮可能都基于同一份旧 map 判断，后写的那次会把先写的那批模型再宣布一遍。
* 读、算、写在一个调用里完成。
*
* ## 首次写入是**播种**，不是宣布
*
* 升级到带本文件的构建时，磁盘上没有历史——此时**知道**目录里有这些模型，但
* **不知道**其中哪些是新的。把整个目录宣布成「刚上架」正是本文件要避免的谎，
* 所以播种那一轮把每个 id 都盖成「已过期」的戳（`now - 窗口`），`newIds` 返回
* 空。这个自愈是刻意的：某个 id 要先离开目录再回来，才配得到一个真实的首见戳。
*
* ## 200 个 id 以上是**形状漂移**，不是「保留最新 200」
*
* 按「保留最新」淘汰一个仍在目录里的 id，会让它下一轮看起来像没见过 → 重新盖戳
* → 再被宣布一次；而被淘汰的集合每轮轮换，于是「新模型」计数会**震荡并变大**
* （实测 250 个 id 对 200 上限：50 → 100 → …）。会自己发明新模型的历史文件比
* 没有历史文件更糟，所以超限一律读作形状漂移：**不写、不宣布**，旧 map 原样
* 保留，标记在异常期间消失，目录回到合理规模后自愈。
*
* ## 分段与 legacy
*
* 落点与 provider / draw / usage-prefs 同一套分段规则：
* `$DSH_HOME/state/<profile>/<plugin>/roster-seen.json`（无 profile 时落共享目录）。
* **不搬**：本文件晚于 profile 分段引入，共享目录里不存在它的旧布局可继承——
* 与 usage-prefs-store 的「legacy 继承」相反，这里没有 legacy 缝，也不该长出一条。
*
* 完整性三件套与其余 store 同源（全部上收在 `state-store.ts`，本文件只做调用方，
* 论述见 `draw-store.ts` 头注）：写串行化（{@link createStateWriteQueue}）、写守卫
* （{@link guardStateWrite}，ADR-006）、读侧说明（{@link stateVersionNote}）。
*
* doctor 覆盖：{@link describeRosterSeenPayload} 给只读速览，`doctor.ts` 据此把
* roster-seen.json 的「损坏 / 未知版本」报进症状表。
*
* @module dsh-connect-modelscope-token-plan/roster-seen-store
*/
/** 本 store 落盘 payload 的版本。 */
const ROSTER_SEEN_VERSION = 1;
/** 本 build 读得懂的版本集合（升级时把新号加进来，旧号保持可读）。 */
const KNOWN_ROSTER_SEEN_VERSIONS = Object.freeze([1]);
/**
* 「新」的时效窗口：首见戳落在这个窗口内就算新。
*
* 7 天是有意的尺度——它要盖住「用户几天没开面板、回来时发现多了两个模型」这个
* 真实场景，又不能长到让一次批量上架在半个月后还挂着标记。窗口在这里是**常量**
* 而不是配置：一个能被调成 365 天的「新模型」标记等于没有语义。
*/
const ROSTER_SEEN_NEW_WINDOW_MS = 6048e5;
/**
* 目录规模上限。超过即视为形状漂移（不是淘汰队列，理由见模块头注）。
*
* 取值与姊妹插件的同类实现一致：真实目录在数百个模型以内，200 给「这一侧目录
* 突然返回了整站列表」这类事故留出足够间距。
*/
const ROSTER_SEEN_MAX_IDS = 200;
const EMPTY_PAYLOAD = {
	seen: {},
	version: null
};
/**
* 本 build 读不读得懂这个版本。
*
* 与其余 store 的 `isKnown*Version` 同形：**白名单**判据，不与
* {@link ROSTER_SEEN_VERSION} 比较——升级后旧号仍要可读。读侧、报告侧问的都是
* 这一个函数。
* @param {unknown} version - 盘上读到的值（可能根本不是数字）。
* @returns {boolean}
*/
function isKnownRosterSeenVersion(version) {
	return typeof version === "number" && KNOWN_ROSTER_SEEN_VERSIONS.includes(version);
}
/**
* 归一一张首见表：只留「id 是非空字符串、戳是有限正数」的项。
*
* 丢掉而不是修补坏项是有意的：一个戳为 0 或负数的项会让 `now - stamp` 变成
* 几十年，那个 id 于是永远算「新」；宁可让它下次出现时重新盖一个真实戳。
* @param {unknown} raw - 盘上读到的 `seen` 值。
* @returns {RosterSeen} 归一后的表（可能是空对象）。
*/
function normalizeRosterSeen(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out = {};
	for (const [id, stamp] of Object.entries(raw)) {
		if (id === "") continue;
		if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) continue;
		out[id] = stamp;
	}
	return out;
}
/** 本 store 的目录（与 provider / draw / usage-prefs 同一套分段规则）。 */
function rosterSeenDir(profile, dir) {
	if (typeof dir === "string" && dir !== "") return dir;
	return profile ? profileStateDir(name, profile) : stateDir(name);
}
/**
* 从一张首见表里挑出「还算新」的 id，按首见时间升序（最老的在前）。
*
* 升序是有意的：调用方只展示前几个名字（胶囊 tooltip / popover 的预算），先看到
* 的应该是**最早**变成新的那几个——它们离过期最近，也是读者最可能已经见过、
* 需要被告知「其实才刚出现」的那批。
* @param {RosterSeen} seen - 归一后的首见表。
* @param {number} nowMs - 当前时刻。
* @returns {string[]} 窗口内的 id 列表。
*/
function freshIdsOf(seen, nowMs) {
	return Object.entries(seen).filter(([, first]) => nowMs - first < ROSTER_SEEN_NEW_WINDOW_MS).sort((left, right) => left[1] - right[1]).map(([id]) => id);
}
/**
* 文件支撑的首见表。
* @param {StoreOptions} [options] - `{ dir, profile, ttlMs, logger }`。
* @returns {object} store 句柄。
*/
function createFileRosterSeenStore(options = {}) {
	const { dir, profile = null, ttlMs = STATE_READ_TTL_MS, logger } = options;
	const stateDir = rosterSeenDir(profile, dir);
	const filePath = join(stateDir, "roster-seen.json");
	/**
	* 写一份 payload 并落盘。
	*
	* ADR-006 写守卫（{@link guardStateWrite}）先问盘：版本不认或文件读不出 →
	* 返回拒绝理由（已 degrade 记录），不落笔。
	* @param {object} body - 要持久化的 JSON 体。
	* @returns {Promise<string|null>} 拒绝原因，或 `null` = 已写入。
	*/
	const writePayload = async (body) => {
		const refusal = await guardStateWrite(filePath, KNOWN_ROSTER_SEEN_VERSIONS, {
			label: "roster-seen-state",
			logger
		});
		if (refusal !== null) return refusal;
		await ensureStateDir(stateDir);
		await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary: temporaryOf(stateDir, "roster-seen.json") });
		return null;
	};
	/** 写串行化：读-改-写必须排队（详见{@link createStateWriteQueue}）。 */
	const writeQueue = createStateWriteQueue();
	/**
	* 解析一份路径上的 payload；认不出的版本读作「空表」但**记住**版本号——读侧
	* 宽容、versionNote 负责把宽容说出口（写侧守卫已挡住覆盖，两半合起来才是
	* ADR-006）。
	*/
	const parseAt = async (path) => {
		const source = obj(await readStateJson(path));
		const version = typeof source.version === "number" ? source.version : null;
		if (!isKnownRosterSeenVersion(version)) return {
			seen: {},
			version
		};
		return {
			seen: normalizeRosterSeen(source.seen),
			version
		};
	};
	const cache = createStateReadCache(() => parseAt(filePath), { ttlMs });
	/** 读当前 payload。 */
	const readPayload = async () => await cache.read() ?? EMPTY_PAYLOAD;
	return {
		/**
		* 记下这一轮的完整目录，并回答「其中哪些还在新窗口内」。
		*
		* 一次调用同时 diff 与落盘（理由见模块头注）。首轮写入是**播种**：把每个 id
		* 盖成已过期的戳、返回空 `newIds`。
		* @param {readonly string[]} ids - 上游这一轮列出的**完整**目录 id。
		* @param {number} [nowMs] - 时钟（测试注入）。
		* @returns {Promise<{newIds: string[]}>} 窗口内的 id，升序；播种那轮为空。
		*/
		async note(ids, nowMs = Date.now()) {
			const list = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id !== "") : [];
			const unique = [...new Set(list)];
			if (unique.length === 0) return { newIds: [] };
			const now = Number.isFinite(nowMs) ? nowMs : Date.now();
			return writeQueue.enqueue(async () => {
				const current = await parseAt(filePath);
				if (current.version !== null && !isKnownRosterSeenVersion(current.version)) return { newIds: [] };
				const previous = current.seen;
				const seeded = current.version === null;
				const next = {};
				for (const id of unique) {
					const first = previous[id];
					next[id] = typeof first === "number" && first > 0 ? Math.min(first, now) : seeded ? now - ROSTER_SEEN_NEW_WINDOW_MS : now;
				}
				if (Object.keys(next).length > 200) return { newIds: [] };
				if (seeded || Object.keys(previous).length !== Object.keys(next).length || Object.keys(next).some((id) => previous[id] !== next[id])) {
					const refusal = await writePayload({
						version: 1,
						seen: next,
						updatedAt: (/* @__PURE__ */ new Date()).toISOString()
					});
					if (refusal !== null) throw new Error(refusal);
					cache.remember({
						seen: next,
						version: 1
					});
				}
				return { newIds: seeded ? [] : freshIdsOf(next, now) };
			});
		},
		/**
		* 只读：此刻还算「新」的 id（升序）。
		*
		* **不写盘**：快照与 provider 路由都是读路径，写只发生在收敛器的 `note`。
		* 读路径若顺手补戳，一次面板轮询就能把「谁是新模型」这件事改写掉。
		* @param {number} [nowMs] - 时钟（测试注入）。
		* @returns {Promise<string[]>}
		*/
		async fresh(nowMs = Date.now()) {
			return freshIdsOf((await readPayload()).seen, Number.isFinite(nowMs) ? nowMs : Date.now());
		},
		/** 这张表有没有写过（区分「播种」与「真的没有新模型」）。 */
		async isSet() {
			return (await readPayload()).version !== null;
		},
		/**
		* 盘上带着本构建读不懂的版本时的一句说明，否则 `null`。
		*
		* 读侧宽容（未知版本读作空表）的另一半：快照聚合把它转进 `shapeWarnings`，
		* doctor 报同一份文件。没有它，「首见表被忽略」在面板上就是「没有新模型」。
		* @returns {Promise<string|null>}
		*/
		async versionNote() {
			const version = (await readPayload()).version;
			if (version === null || isKnownRosterSeenVersion(version)) return null;
			return stateVersionNote({
				label: "roster-seen-state",
				file: filePath,
				version,
				known: KNOWN_ROSTER_SEEN_VERSIONS,
				consequence: "the first-sighting history is being answered as empty, so the pill shows no new-model marker."
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
* 3. **`FAILED` 常常没有可分诊的形状**：实测样本 `errors.code` 为 `0`、
*    `errors.message` 为空串、没有顶层 `message`。所以不能承诺「一定读得出原因」——
*    本模块的 `describeDrawFailure` 只报**这个 body 里确实写着**的东西：读得到
*    `errors.message` 就报它，读不到就明说原因不可知（2026-10-19 修补：旧写法把
*    「实测样本为空」当成了「永远为空」，非空原因会被一并报成「未给出原因」）。
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
/**
* 一次**工具调用**里愿意等的时间（毫秒）。
*
* 出图工具是给 agent 用的，一次调用阻塞 = 一整轮对话被占住。15 分钟的总预算
* （{@link DRAW_TIMEOUT_MS}）是「这张图值不值得继续等」的上限，不是「一次调用
* 该不该堵住 agent」的上限——两者同一个数，就是把上游排队的代价转嫁成对话的
* 停顿。
*
* 取 90s：实测耗时 61s–537s 大幅波动，90s 能一次拿完最快那一档（61s），而
* 更慢的本来就必须分段查（见 `draw-runtime.ts` 的两段式工具）。再往上加只是
* 把「等得久」换成「卡得久」，并不改变「慢的图要分几次查」这个事实。
*/
const DRAW_WAIT_BUDGET_MS = 9e4;
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
* 从上游 body 里取第一句**可引用的原因**：`errors.message`，退回顶层 `message`。
*
* 取的是**未截断**的原文——`describeDrawFailure` 的 tail 会截到 300 字符，截断后的
* JSON 解析不出来。解析不出来（非 JSON / 字段为空 / 字段不是字符串）一律返回 `""`：
* 这里**不猜**，没有原因就说没有原因。
*/
function upstreamMessageOf(raw) {
	if (raw === "") return "";
	try {
		const parsed = JSON.parse(raw);
		for (const candidate of [parsed?.errors?.message, parsed?.message]) if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
	} catch {}
	return "";
}
/**
* 把一次失败转成 agent 与面板都能读的一句话。
*
* **关于魔搭 `FAILED` 的诚实边界**：实测见过的失败样本是
* `{"errors":{"code":0,"message":""}, "task_status":"FAILED"}`——那一份**原因不可知**。
* 但样本量是 1，不是恒定形态：上游也可能给出非空的 `errors.message`
* （2026-10-19 锐评实测 `sensitive content detected`、
* `image_url is required for model MusePublic/Qwen-Image-Edit` 这类原因会被旧写法
* 一并报成「未给出失败原因」，且 body 被丢掉，2/2 误报）。所以判据是**逐个 body 判**：
* 有原因就报原因，确实没有才明说「上游未给出原因」；任何情况下都不从空错误里编造
* 原因，两种情况**都附脱敏后的 body**。这是本仓库 README「诚实声明」的要求。
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
	const raw = typeof failure.bodyText === "string" ? failure.bodyText : "";
	const text = redactSecrets(raw).slice(0, 300);
	const status = Number.isFinite(failure.status) ? Number(failure.status) : 0;
	const tail = text === "" ? "" : `; body: ${text}`;
	if (status === 401 || status === 403) return `出图失败：HTTP ${status} —— ${/邮箱|实名|email[^\n]{0,40}verif|verif\w*[^\n]{0,40}email|complete\s+your\s+profile/i.test(text) ? "访问令牌无效、无权访问该模型，或账号未完成邮箱验证/实名（上游 body 提到了账号态）" : "访问令牌无效或无权访问该模型（上游未指明具体原因）"}。请在面板确认令牌与账号状态${tail}`;
	if (status === 404) return `出图失败：HTTP 404 —— 端点或模型不存在（检查 apiBase 与模型 id）${tail}`;
	if (status === 429) return `出图失败：HTTP 429 —— 上游限流，请稍后重试${tail}`;
	if (status >= 500) return `出图失败：HTTP ${status} —— 上游服务异常，稍后重试${tail}`;
	const cause = str(failure.cause, "");
	if (cause !== "") return `出图失败：${redactSecrets(cause)}${tail}`;
	const taskStatus = str(failure.taskStatus, "");
	if (taskStatus === "FAILED") {
		const upstream = upstreamMessageOf(raw);
		if (upstream !== "") return `出图失败：上游任务 FAILED —— ${redactSecrets(upstream)}${tail}`;
		return `出图失败：上游任务 FAILED，但未给出失败原因（上游 errors.message 为空），换模型或稍后重试${tail}`;
	}
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
* 4. 轮询的 5xx / 429 / 408 是**瞬态**不是终局（{@link isTransientPollStatus}）：
*    同一个物理故障不因表现为 TCP 抛错还是 5xx 响应就两种判法；只有 4xx 是
*    终局证据。瞬态持续时由 deadline 收口成 pending，续查把手不丢。
*
* @module dsh-connect-modelscope-token-plan/draw-runtime
*/
/** agent 工具名。带插件前缀，避免与 `dsh-draw-router` 的 `draw_image` 撞名。 */
const DRAW_TOOL_NAME = "modelscope_draw_image";
/** 一次失败的冷却窗：出图慢，失败后立刻重试既易撞限流又白等。 */
const DRAW_FAILURE_COOLDOWN_MS = 6e4;
/**
* 工具级硬护栏比单次等待预算多出的余量。
*
* 它保证**等待循环先返回**：护栏若与等待预算同值，正常路径会以 peer 的超时错误
* 结束，而不是带 `jobId` 的 `pending`——那会把续查这条唯一的把手换成一个死胡同。
*/
const DRAW_TOOL_TIMEOUT_MARGIN_MS = 1e4;
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
* **第一段**：提交一次出图，只要 `task_id`。
*
* 提交必须带 `X-ModelScope-Async-Mode`（实测可省但官方示例都带，带上无害）。
* 响应里的 `task_status` **一律忽略**——实测恒为 `SUCCEED`，连最终 `FAILED` 的那次
* 也是，所以成功与否只看轮询终态（这条由 `readTaskId` 钉在纯逻辑层）。
* @param {DrawSubmitInput} input - 提交参数。
* @returns {Promise<{taskId: string}>} 上游任务 id（= 续查用的 jobId）。
* @throws {Error} 提交失败——消息已过 `describeDrawFailure`。
*/
async function submitDrawTask({ fetchImpl, apiBase, apiKey, model, prompt, imageUrl, size, steps, guidance, seed, negativePrompt }) {
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
	return { taskId };
}
/**
* **第二段**：在给定预算内轮询一个任务，直到终态或预算耗尽。
*
* 与 `runDrawOnce` 的差别只有一处：预算耗尽时**返回 `pending` 而不是抛错**——
* 抛错是「这件事做不成了」，`pending` 是「还没成，可以再查」。同一段循环因此
* 同时服务于两种调用形状（一次性跑完 / 分段续查），不写两份。
*
* 轮询带 `X-ModelScope-Task-Type`（**必需**，漏了必假失败）。三类情形**不升级
* 为终局**，在本次预算内继续等下一轮：① 传输层抛错（ECONNRESET / DNS）；
* ② 非 JSON / 200 垃圾响应体（CDN 错误页）；③ **瞬态 HTTP 状态码**（5xx /
* 429 / 408，见 {@link isTransientPollStatus}）。只有 4xx 是终局证据。
* @param {object} options - 等待参数。
* @param {DrawFetch} options.fetchImpl - 注入的 fetch。
* @param {string} options.apiBase - apiBase。
* @param {string} options.apiKey - 访问令牌。
* @param {string} options.taskId - 上游任务 id。
* @param {number} [options.waitMs] - 本次调用的等待预算。
* @param {number} [options.pollIntervalMs] - 轮询间隔（测试可缩短）。
* @param {() => boolean} [options.shouldStop] - 每轮轮询前问一次「还要不要继续」
*   （撤下闸）。`signal` 只能表达**已经**中止，问不出「刚刚被撤下」——等待循环是
*   本模块唯一的循环，撤下只有在这里能被周期性看见。
* @returns {Promise<DrawAwait>} 三种结局之一。
*/
async function awaitDrawTask({ fetchImpl, apiBase, apiKey, taskId, waitMs = DRAW_WAIT_BUDGET_MS, pollIntervalMs = DRAW_POLL_INTERVAL_MS, signal, shouldStop }) {
	const headers = {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json"
	};
	const deadline = Date.now() + Math.max(1, Math.floor(waitMs));
	const interval = Math.max(1, Math.floor(pollIntervalMs));
	let polls = 0;
	let lastStatus;
	for (;;) {
		if (Date.now() >= deadline) return {
			kind: "pending",
			polls
		};
		if (shouldStop?.() === true) return {
			kind: "pending",
			polls
		};
		try {
			await sleep(interval, signal);
		} catch {
			return {
				kind: "pending",
				polls
			};
		}
		polls++;
		let polled;
		try {
			polled = await fetchImpl(buildTasksEndpoint(apiBase, taskId), {
				method: "GET",
				headers: {
					...headers,
					[TASK_TYPE_HEADER]: TASK_TYPE_IMAGE_GENERATION
				},
				...signal !== void 0 ? { signal } : {}
			});
		} catch {
			if (signal?.aborted === true) return {
				kind: "pending",
				polls
			};
			continue;
		}
		const pollText = await safeText(polled);
		if (!polled.ok) {
			if (isTransientPollStatus(polled.status)) continue;
			const previous = lastStatus !== void 0 ? `（上一轮读到 ${lastStatus}）` : "";
			return {
				kind: "failed",
				message: describeDrawFailure({
					...polled.status !== void 0 ? { status: polled.status } : {},
					...pollText !== "" ? { bodyText: pollText } : {},
					cause: `轮询请求失败：HTTP ${polled.status ?? "未知"}，本轮未读到任务状态${previous}`
				})
			};
		}
		const data = await safeJson(polled, pollText);
		const status = readTaskStatus(data);
		if (status !== null) lastStatus = status;
		if (!isTerminalPayload(data)) continue;
		if (status === "FAILED") return {
			kind: "failed",
			message: describeDrawFailure({
				taskStatus: "FAILED",
				bodyText: pollText
			})
		};
		const images = readOutputImages(data);
		if (images.length === 0) return {
			kind: "failed",
			message: describeDrawFailure({
				taskStatus: "SUCCEED",
				bodyText: pollText,
				cause: "任务报 SUCCEED 但没有可用图片"
			})
		};
		return {
			kind: "done",
			images,
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
	return resolveDrawModelChoice(entries, requested, preferred).id;
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
* 装配 agent 工具定义——**两段式**，一次调用不再阻塞整轮对话。
*
* ## 为什么是两段式
*
* 上游出图要排队，实测 61s–537s（免费池）。旧形状是「一次调用 await 到终态」，
* 于是 `drawTimeoutMs`（15 分钟）既是「这张图值不值得等」的上限，也成了「一轮
* 对话被卡多久」的上限——把上游排队的代价直接转嫁成对话停顿。
*
* 现在一次调用只做两件事之一：
*   - **不带 `jobId`** → 提交任务，然后只在 `waitMs`（默认 {@link DRAW_WAIT_BUDGET_MS}）
*     内等；等到就返回 `done`，没等到就返回 `pending` + `jobId`；
*   - **带 `jobId`** → 只查那个任务，同样最多等 `waitMs`。
*
* `drawTimeoutMs` 因此回到它本来的语义：**从提交算起的总放弃线**（跨调用累计），
* 越过它才报「放弃」。
*
* ## 两个刻意的判定
*
*   - `pending` **不是失败**：不抛错、不进冷却门。它只表示「这次调用愿意等的时间里
*     没等到」，进冷却就会把续查这条路堵死——那正是分段查询的目的所在。
*   - 只有**真失败**（提交失败 / 上游 `FAILED` / 越过总放弃线）才 `cooldown.fail()`。
*
* 工具仍只做「参数归一 → 跑一次 → 组装结果文本」，所有判定都委托给 `draw.ts` 的纯函数。
* @param {object} options - 装配参数。
* @param {(definition: object) => unknown} options.defineTool - peer 的工厂。
* @param {DrawFetch} options.fetchImpl - 注入的 fetch。
* @param {() => Promise<string>} options.resolveApiKey - 每次调用现读令牌。
* @param {() => unknown|Promise<unknown>} [options.getEntries] - 目录条目读取器。
* @param {object} [options.settings] - `{ apiBase, drawModelId, drawTimeoutMs, drawWaitMs }`。
* @param {ReturnType<typeof createDrawCooldown>} [options.cooldown] - 冷却门。
* @param {DrawJobs} [options.jobs] - 作业表（可注入，便于测试）。
* @param {() => boolean} [options.isDisposed] - 卸载闸。
* @returns {unknown} 已定义的 agent 工具。
*/
function defineDrawTool({ defineTool, fetchImpl, resolveApiKey, getEntries, settings, getPreferredModelId, cooldown = createDrawCooldown(DRAW_FAILURE_COOLDOWN_MS), jobs = createDrawJobs(), pollIntervalMs = DRAW_POLL_INTERVAL_MS, isDisposed = () => false }) {
	/**
	* 总放弃线：从提交算起，跨多次调用累计。
	*
	* 上下界与 `host-config.resolveSettings` 同源，这里再夹一次是为了让本函数的
	* 不变式**自足**：`waitMs + margin <= timeoutMs <= DRAW_TIMEOUT_MAX_MS`（见下面
	* `waitMs` 与工具定义里的 `timeoutMs`）。直接调用本函数（不经配置层）时也成立。
	*/
	const timeoutMs = Math.min(DRAW_TIMEOUT_MAX_MS, Math.max(3e4, Math.floor(Number(settings?.drawTimeoutMs) > 0 ? Number(settings?.drawTimeoutMs) : DRAW_TIMEOUT_MS)));
	/**
	* 单次调用愿意等的时间。
	*
	* 上界是 `timeoutMs - margin`，**不是** `timeoutMs`：工具的硬护栏取
	* `waitMs + margin`，若允许两者相等，护栏就会越过 `DRAW_TIMEOUT_MAX_MS`
	* （配置允许 `drawWaitMs == drawTimeoutMs`，上限 1_800_000 → 护栏 1_810_000），
	* 且「等待循环先返回」从结构保证退化成「用户不会把两个值设成相等」的运气。
	* 下界交给 `host-config` 的 `drawWaitMs` clamp——同一个数在两处各夹一次，上限/
	* 下限就会各说一套话（`drawTimeoutMs` 的 clamp 早已是本仓库的教训）。
	*/
	const waitMs = Math.min(Math.max(1, timeoutMs - DRAW_TOOL_TIMEOUT_MARGIN_MS), Math.max(1, Math.floor(Number(settings?.drawWaitMs) > 0 ? Number(settings?.drawWaitMs) : DRAW_WAIT_BUDGET_MS)));
	const apiBase = str(settings?.apiBase, "https://api-inference.modelscope.cn/v1");
	const abortController = new AbortController();
	const abortIfDisposed = () => {
		if (isDisposed()) abortController.abort();
	};
	const shouldStop = () => {
		abortIfDisposed();
		return isDisposed();
	};
	/**
	* 等一个作业，把 {@link awaitDrawTask} 的三种结局翻译成工具结果或错误。
	*
	* 两段共用这一段——「刚提交的」与「续查的」在等待这件事上没有区别，唯一的区别
	* 是作业表里那条记录从哪来。
	* @param {string} apiKey - 访问令牌。
	* @param {DrawJob} job - 作业（含提交时刻与累计轮询数）。
	* @param {string[]} available - 目录里的出图模型（续查时为空，不必再拉目录）。
	* @returns {Promise<DrawToolResult>} 工具结果。
	* @throws {Error} 真失败（上游 FAILED / 轮询 HTTP 失败）或越过总放弃线。
	*/
	const waitAndReport = async (apiKey, job, available) => {
		abortIfDisposed();
		const awaited = await awaitDrawTask({
			fetchImpl,
			apiBase,
			apiKey,
			taskId: job.taskId,
			waitMs,
			pollIntervalMs,
			signal: abortController.signal,
			shouldStop
		});
		if (awaited.kind === "failed") {
			jobs.drop(job.jobId);
			throw new Error(awaited.message);
		}
		jobs.notePolls(job.jobId, awaited.polls);
		const polls = job.polls + awaited.polls;
		if (awaited.kind === "done") {
			jobs.drop(job.jobId);
			const urls = awaited.images.join("\n");
			return {
				source: "modelscope",
				status: "done",
				jobId: job.jobId,
				model: job.model,
				url: awaited.images[0] ?? "",
				prompt: job.prompt,
				hint: `图片已生成（上游异步任务，${polls} 次轮询，task ${job.taskId}）\n模型: ${job.model}\n${urls}` + (available.length > 0 ? `\n可用出图模型: ${available.join(", ")}` : "")
			};
		}
		const elapsedMs = Date.now() - job.submittedAt;
		if (elapsedMs >= timeoutMs) throw new Error(describeDrawFailure({ cause: `超过总预算（${Math.round(timeoutMs / 1e3)}s，${polls} 次轮询）仍未拿到结果。上游任务（${job.taskId}）可能仍在生成——实测排队时长在 1–15 分钟间大幅波动，与请求本身无关；注意放弃后原任务的结果不保证还能取回` }));
		const resumeHint = jobs.get(job.jobId) !== null ? `稍后带 jobId ${job.jobId} 再调用本工具即可继续查询（只查询、不会重复出图；作业表只在本次挂载内有效，重启 DSH 或重挂插件后要重新提交）` : "本次挂载已撤下（插件被卸载/重载），作业表已清空——这一轮之后**不能**再带 jobId 续查；上游任务可能仍在生成，但结果不保证还能取回，重新出图请去掉 jobId 再调用";
		return {
			source: "modelscope",
			status: "pending",
			jobId: job.jobId,
			model: job.model,
			url: "",
			prompt: job.prompt,
			hint: `仍在生成中（已等 ${Math.round(elapsedMs / 1e3)}s，${polls} 次轮询，task ${job.taskId}）：上游排队通常 1–15 分钟。${resumeHint}`
		};
	};
	return defineTool({
		name: DRAW_TOOL_NAME,
		description: "Generate or edit an image with the ModelScope (魔搭) API-Inference token. Text-to-image by default; pass `imageUrl` to edit an existing image (image-to-image), or several newline-separated URLs for multi-image editing. Omit `model` to use the catalogue's image model. TWO-PHASE: upstream generation queues, so latency varies from ~1 minute to 15+ minutes. Call without `jobId` to submit and wait briefly; if the result is `status: pending`, call again with the returned `jobId` to keep polling. A pending result is NOT a failure — the image is still being generated. Available image model ids are reported in the result.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "Image prompt; describe the target image (for edits, describe the intended change). Ignored when resuming with `jobId`."
			},
			jobId: {
				type: "string",
				description: "Resume an earlier task: pass the `jobId` returned by a previous call to keep polling it (no new image is submitted)"
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
					status: { type: "string" },
					jobId: { type: "string" },
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
		timeoutMs: waitMs + DRAW_TOOL_TIMEOUT_MARGIN_MS,
		async execute(params) {
			if (abortController.signal.aborted || isDisposed()) throw new Error("modelscope draw tool is no longer mounted");
			const apiKey = await resolveApiKey();
			if (typeof apiKey !== "string" || apiKey.trim() === "") throw new Error("MODELSCOPE_API_KEY 未配置：在面板粘贴 ms- 访问令牌，或设置该环境变量");
			const resumeId = str(params?.jobId, "");
			if (resumeId !== "") {
				const job = jobs.get(resumeId);
				if (job === null) throw new Error(`jobId ${resumeId} 不在本次会话的作业表里（插件重启过，或该 id 不是本插件发出的）：原任务可能仍在生成，但它的结果不保证还能取回（上游终态记录会被回收），请重新出图`);
				try {
					return await waitAndReport(apiKey, job, []);
				} catch (error) {
					cooldown.fail();
					throw error;
				}
			}
			const prompt = str(params?.prompt, "");
			if (prompt === "") throw new Error("prompt is required");
			const remaining = cooldown.remainingMs();
			if (remaining > 0) throw new Error(`draw cooldown: 上一次出图失败，${Math.ceil(remaining / 1e3)}s 后再试`);
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
				if (normalized === null) {
					const safe = redactSecrets(raw).slice(0, 80);
					throw new Error(`imageUrl 不可用：${safe} —— 只接受公网 http(s) 链接或 data:image/...;base64 内联数据（本地文件上游取不到，请先上传）`);
				}
				images.push(normalized);
			}
			try {
				const size = str(params?.size, "");
				const steps = toPositiveInt(params?.steps);
				const guidance = toPositiveNumber(params?.guidance);
				const seed = toNonNegativeInt(params?.seed);
				const negativePrompt = str(params?.negativePrompt, "");
				const { taskId } = await submitDrawTask({
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
					...negativePrompt !== "" ? { negativePrompt } : {}
				});
				const job = jobs.create({
					taskId,
					model,
					prompt
				});
				return await waitAndReport(apiKey, job, drawModelIds(entries));
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
/**
* 轮询响应里的**瞬态** HTTP 状态码：不判作业死刑，本次等待预算内继续等下一轮。
*
* 判据是「同一个物理故障不因表现形态而异」：传输层抛错（ECONNRESET / DNS
* 解析失败）早就走的是「继续等下一轮」，而同一种 CDN 边缘抖动、上游短暂过载
* 以 **5xx/429 响应**的形态出现时，旧写法直接判失败、作业出表、进 60s 冷却
* ——agent 想续查只能重新提交一张图。上游排队窗口实测 1–15 分钟
* （docs/SPIKE-image-gen.md），那个窗口内的边缘 5xx 是常态噪声，不是终局。
*
* 4xx 保持终局：401/403 = 令牌或权限真的没了，404/400 = 任务或端点真的没了
* ——这些等下去也不会变。deadline 负责收口：瞬态一直持续时耗尽预算后返回
* `pending`，两段式的续查把手（jobId）不丢。
* @param {number} status - 轮询响应的 HTTP 状态码。
* @returns {boolean} 是否按瞬态继续等。
*/
function isTransientPollStatus(status) {
	return status === 408 || status === 429 || status >= 500;
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
/**
* 可注入的 sleep（测试可覆写；这里只提供默认实现）。
*
* 支持 `AbortSignal`：插件 dispose 时可以立即中断等待，而不是等 sleep 自然结束。
* 默认 15s 的轮询间隔意味着用户点「停止」后最多要等 15s 才真正停——abort 让
* 停止信号立即生效。
*/
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(/* @__PURE__ */ new Error("sleep aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error("sleep aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

//#endregion
//#region src/host/draw-tool-state.ts
/** 当前缺席原因（`null` = 未登记 / 已清掉）。 */
let note = null;
/**
* 本次挂载是否真的把工具注册上了。
*
* 与 `note` 的区别见文件头：`note` 是「注册尝试过且失败的原因」，这一位是「注册
* 成功与否」。开关在挂载后才翻开的场景，两者都是「没有缺席原因 + 没注册上」，
* 只有这一位能把它认出来。
*/
let mounted = false;
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
* 记下「本次挂载已注册上」。只有注册路径走完才置 true；缺席与「开关没开」都是
* false。
* @param {boolean} value - 是否注册成功。
* @returns {void}
*/
function setDrawToolMounted(value) {
	mounted = value === true;
}
/**
* 读「本次挂载是否注册上了」。
* @returns {boolean} true = 注册成功。
*/
function drawToolMounted() {
	return mounted;
}
/**
* 清空（卸载时调用：下一个 Host 生命周期从干净的「未登记」开始）。
* @returns {void}
*/
function resetDrawToolNote() {
	note = null;
	mounted = false;
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
* **测试覆盖**：`test/draw-register.test.mjs`（2026-10-17 补上，此前这里是零引用）
* 用 `deps.loadToolsModule` 这条现成的缝注入伪 `defineTool`，让真装配链原样跑起来
* ——**不需要** peer-stub-loader。教训是：本文件此前把「peer-dependent」直接读成
* 「测不了」，而缝早就留好了；同处境的 `llm-adapter.ts` / `draw-runtime.ts` 用
* `test/helpers/peer-stub-loader.mjs` 证明过另一条路（那条 loader 是给**没有缝**
* 的直连 import 用的）。`tools/dev/mutate-spec.json` 里有本文件的一组变异，用来
* 保证那套测试真的会红——第一版测试里 `mount` 助手自己清了缺席原因，于是「过期
* 原因会不会被清掉」那条断言是测试自己满足的，是变异测试把它抓出来的。
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
* @param {object} deps - 测试缝（`loadToolsModule`、`drawFetch`、`pollIntervalMs`）。
* @returns {Promise<void>}
*/
async function registerDrawTool(ctx, wiring, deps = {}) {
	const { settings, configError, tokenStore, inference, drawStore, publisher, logger } = wiring;
	const loggerFor = logger ?? ctx.logger;
	setDrawToolNote(null);
	setDrawToolMounted(false);
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
				drawTimeoutMs: settings.drawTimeoutMs,
				drawWaitMs: settings.drawWaitMs
			},
			...wiring.drawJobs !== void 0 ? { jobs: wiring.drawJobs } : {},
			...deps.pollIntervalMs !== void 0 ? { pollIntervalMs: deps.pollIntervalMs } : {},
			isDisposed
		}));
		setDrawToolMounted(true);
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
* 结构性纪律（本文件新立的）：一次 publish 拆成 **gather（可挂起）**与
* **commit（不可挂起）**两半，commit 是**非 async 函数**——「disposed 复查与
* registerAdapter 之间没有 await」由此前的注释论证升级为语言级保证。相位
* （idle/serving/failing/broken/disposed）从契约字段推导，不双写。
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
* 从 publisher 的契约状态**推导**相位——单源，不双写。
*
* `registered` / `error` 是 `publish-core.ts` 的共享契约字段（`swapRegistration`
* 与 `unregister` 直接写它们）。并行维护一个 `phase` 字段就是双写，双写必然
* 漂移且方向静默；推导让相位永远不可能与那两个字段矛盾。
*
* 相位与两道空转守卫的对应（旧版注释里的条件，现在是有名字的状态）：
*   - `idle`     = 没注册且无错：开关关着的稳态 → 关侧空转守卫可跳过；
*   - `serving`  = 已注册且无错：offer 已 live → 开侧空转守卫可跳过；
*   - `failing`  = 已注册但有错：回滚到了旧对、但新 offer 没落地 → **必须继续
*     重试**（跳过就是静默丢弃用户刚保存的清单）；
*   - `broken`   = 没注册且有错：上次发布失败且什么都没在服务 → 继续重试自愈；
*   - `disposed` = 插件已 dispose：任何 publish 都是 no-op。
* @param {{registered: boolean, error: string|null}} state - publisher 状态。
* @param {boolean} disposed - publish 队列的 disposed 闸状态。
* @returns {PublisherPhase} 相位。
*/
function publisherPhaseOf(state, disposed) {
	if (disposed) return "disposed";
	if (state.registered) return state.error === null ? "serving" : "failing";
	return state.error === null ? "idle" : "broken";
}
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
	* 发布相位——两道空转守卫的判断条件从此有名字（推导见 {@link publisherPhaseOf}）。
	* @param {boolean} disposed - 当前是否已 dispose。
	* @returns {PublisherPhase}
	*/
	const phaseOf = (disposed) => publisherPhaseOf(state, disposed);
	/**
	* gather 阶段：一次 publish 的**可挂起**半边。
	*
	* 读面板开关、解析 llm 服务、解析适配器工厂、构建适配器——四个 await 全住
	* 在这里。产出两种计划：`done`（跳过 / 注销 / 构建失败，都已执行完）或
	* `commit`（适配器构建好了，只剩同步提交）。
	*
	* 领域字段（entries / enabledIds / unavailableIds）在查询开关**之前**写入，
	* 开关关分支刻意不回滚它们——这个不对称是承重的，不是疏忽：`routes/provider.ts`
	* 与 roster 保存会在开关重新打开时正好从这些字段重新 publish，所以用户的
	* 允许清单编辑与最后一次拉到的目录**必须**熬过关闭期。把 `previous*` 还回去
	* 会静默丢掉两者——开关关闭期间做的保存，会在开关重新打开时消失。
	* `swapRegistration` 的 `onRollback` 会还它们，但只对注册真的抛了的路径——
	* 那种失败必须让先前在服务的对继续服务，这是与「开关关着」不同的承诺。
	* @param {unknown} entries - 归一目录条目。
	* @param {unknown} enabledIds - 允许清单（空 = 全部）。
	* @param {string[]} unavailableModelIds - 额度耗尽的模型 id。
	* @returns {Promise<PublishPlan>} 执行计划。
	*/
	const gatherPublish = async (entries, enabledIds, unavailableModelIds) => {
		if (queue.isDisposed()) return {
			kind: "done",
			result: {
				ok: false,
				skipped: true
			}
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
			if (phaseOf(false) === "idle" && offerUnchanged()) return {
				kind: "done",
				result: {
					ok: true,
					skipped: true
				}
			};
			const result = unregister({
				state,
				release
			});
			syncSignaturesAfterPublish(state);
			return {
				kind: "done",
				result
			};
		}
		const llm = resolveRegistrationService({
			state,
			getLlm: effectiveGetLlm,
			release
		});
		if (llm === null) return {
			kind: "done",
			result: {
				ok: false,
				error: state.error
			}
		};
		let built;
		try {
			const createModelScopeAdapter = await resolveAdapterFactory();
			if (createModelScopeAdapter === void 0) throw new Error(BAD_FACTORY_SHAPE_ERROR);
			built = await createModelScopeAdapter({
				entries: state.entries,
				enabledIds: state.enabledIds,
				baseUrl: effectiveSettings.apiBase,
				maxTokensOverrides: effectiveSettings.maxTokensOverrides ?? {},
				resolveApiKey: effectiveResolveApiKey,
				get: effectiveGetLlm,
				unavailableModelIds: state.unavailableIds,
				...usage !== void 0 ? { usage } : {},
				...usage !== void 0 ? { onError: (error) => effectiveLogger?.warn?.(`usage record failed: ${typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error)}`) } : {}
			});
			if (!isBuiltAdapter(built)) throw new Error(BAD_FACTORY_SHAPE_ERROR);
		} catch (e) {
			const described = describeBuildFailure(e);
			state.error = described.note;
			warnBuildFailure(effectiveLogger, "ModelScope", described);
			return {
				kind: "done",
				result: {
					ok: false,
					error: described.error
				}
			};
		}
		if (phaseOf(false) === "serving" && offerUnchanged()) return {
			kind: "done",
			result: {
				ok: true,
				skipped: true
			}
		};
		return {
			kind: "commit",
			llm,
			built,
			previousBuilt,
			previousEntries,
			previousEnabledIds,
			previousUnavailable
		};
	};
	/**
	* commit 阶段：一次 publish 的**不可挂起**半边。
	*
	* **这个函数刻意不是 `async`**——语言禁止在非 async 函数里写 `await`，所以
	* 从下面的 disposed 复查到 `swapRegistration` 内部的 `registerAdapter` 之间
	* **不可能**插入挂起点。旧版靠一句「这个位置严密：从这里到 registerAdapter
	* 之间没有任何 await」的注释论证这件事；现在由函数签名本身保证——想在这里
	* 加 await，编译期就过不去。临界区的正确性由结构承载，不由注释承载。
	*
	* 为什么这道复查必须有（gather 入口那次只覆盖到第一个 await，而注册发生在
	* **最后一次** await 之后）：teardown 落在这段窗口里时，入口闸门不会重跑，
	* 于是 registerAdapter 把适配器注册进一个**已经把本插件撤下的 Host**，而
	* teardown 早就跑完、release 永不调用——泄漏的对持有 tokenStore 与整个
	* Cordis ctx 的闭包，形成僵尸 provider：picker 里那个 provider 还在、还能
	* 路由，而面板路由已注销，用户没有界面能关掉它。
	*
	* 为什么 peer 的 fiber 兜底救不了：`registerAdapter` 用的是 **llm 服务自己的**
	* `ctx.effect`（peer 源码里 `.bind(this)` 到 llm 服务），插件卸载不会 dispose
	* 它，宿主注册表永久持有该 adapter。
	*
	* 若 teardown 发生在本次检查**之后**，它执行 release() 时能看到新写入的
	* releaseAdapter 并摘掉——两种时序都正确。检查刻意留在本文件（publisher）而
	* **不**放进 `swapRegistration`：那是 publish-core 的共享骨头，不该知道
	* disposed 的概念。
	* @param {Extract<PublishPlan, {kind: "commit"}>} plan - gather 产出的提交计划。
	* @returns {{ok: boolean, skipped?: boolean, error?: unknown}}
	*/
	const commitPublish = (plan) => {
		if (queue.isDisposed()) return {
			ok: false,
			skipped: true
		};
		const requestedSignature = catalogSignature(state.entries, state.enabledIds);
		const result = swapRegistration({
			llm: plan.llm,
			built: plan.built,
			previousBuilt: plan.previousBuilt,
			state,
			release,
			registerPair,
			emit,
			onRollback: () => {
				state.entries = plan.previousEntries;
				state.enabledIds = plan.previousEnabledIds;
				state.unavailableIds = plan.previousUnavailable;
			}
		});
		syncSignaturesAfterPublish(state);
		if (result.ok === false && state.registered === true && state.signature === requestedSignature) state.error = null;
		return result;
	};
	/**
	* 为一个目录/允许清单快照（重）构建并注册 provider。
	*
	* 形状 = gather（可挂起）+ commit（不可挂起）：全部 await 住在前者，后者是
	* 非 async 函数。重建并重注册而非原地改：`PiAiAdapter` 内部 memoize profiles
	* 快照，只有新的注册才能改变提供的模型列表。注册失败时**恢复上一对**，所以
	* 坏 publish 永远不能把已在服务的模型拉下来。
	* @param {object[]} entries - 归一目录条目。
	* @param {string[]} enabledIds - 允许清单（空 = 全部）。
	* @param {string[]} [unavailableModelIds] - 要从 picker 的 offer 里丢掉的额度耗尽 id。
	* @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
	*/
	const publishProviderOnce = async (entries, enabledIds, unavailableModelIds = []) => {
		const plan = await gatherPublish(entries, enabledIds, unavailableModelIds);
		return plan.kind === "done" ? plan.result : commitPublish(plan);
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
*
* **不含展示名 `name`**：模型展示名变化不影响注册的 offer（descriptor 里的 `name`
* 只是显示用的），重新注册是浪费——期间在途请求可能被打断。展示名变化不改变
* 模型的能力、窗口或输出上限，所以不参与签名。
* @param {object[]} entries - 归一目录条目。
* @param {string[]} enabledIds - 允许清单（空 = 全部）。
* @returns {string}
*/
function catalogSignature(entries, enabledIds) {
	return `${(Array.isArray(entries) ? entries : []).map((entry) => {
		const e = entry;
		return `${str(e?.id, "")}:v${isVisionModel(e) ? 1 : 0}:c${typeof e?.contextWindow === "number" ? e.contextWindow : ""}:o${typeof e?.maxOutputLength === "number" ? e.maxOutputLength : ""}`;
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
//#region src/host/provider-reconcile.ts
/**
* provider 注册的 **desired-state reconciler**——把两个各自为政的驱动收编成
* 一个控制器。
*
* ## 它取代什么
*
* 改之前，往同一个注册态里写的有两个 driver：挂载 seed + 每 `pollSeconds`
* 一次的目录轮询（`index.ts` 的 `runPoll`），以及四条 provider 路由的
* 「保存后立即 publish」。两者没有共同的状态词汇表，于是 `runPoll` 不得不把
* 窗口覆盖**读两遍**（fetch 前一次、fetch 后一次），「期间被改就跳过本轮」——
* 那是没有 desired-state 控制器的典型补丁：丢一次更新、再等一个轮询周期。
*
* ## 模型
*
*   - **desired state**（操作者想要什么）= `providerStore` 里的开关 + 允许
*     清单 + 窗口覆盖。它只有一个家，轮询和路由都只读它、不各写一份；
*   - **reconcile 一遍** = 读 desired → 带窗口覆盖拉目录 → 复查 desired
*     （fetch 期间被改就重跑，不等下一轮）→ 算这一轮的额度耗尽集合（事件流 +
*     纯函数 `exhaustedModelIds`）→ 把「当前目录 + 当前清单 + 耗尽集合」交给
*     publisher（它自己重读开关，single source 不变）；
*   - **触发方全部降级为「标记 dirty」**：挂载、轮询定时器、四条写路由。
*     谁都不用记得「别人是不是也在 publish」——队列性质由本模块的串行链保证。
*
* ## 两个刻意的行为改变（相对旧 runPoll）
*
*   1. **fetch 失败不再发布空目录**。旧 `readEntries` 把 fetch 失败降级成
*      `entries: []` 再 publish——一次瞬时的目录抖动会把已服务的模型全部撤下
*      （破坏，不是重试）。这里失败只记原因、保留当前 offer，下一轮自然重试；
*      轮询侧本来就该如此（旧 runPoll 正是这么做的），路由侧现在与它一致。
*   2. **fetch 期间 desired 被改 → 重跑，不是跳过**。旧代码「跳过本轮、等
*      pollSeconds」；这里原地收敛，保存路由的 await 返回时新值一定已落地。
*
* peer-free：不 import 任何 Host peer。
*
* @module dsh-connect-modelscope-token-plan/provider-reconcile
*/
/**
* 创建 provider reconciler。
*
* 串行链 + dirty 标志：每次触发（轮询/路由/挂载）都排在链尾，链上每一环先看
* dirty 再决定要不要真跑——在途那一轮会替后来者消费 dirty，所以 N 次连续触发
* 最多收敛成两遍 reconcile，不会排 N 遍。调用方 await 返回的 promise，即
* 「我的触发已被消费」。
* @param {ProviderReconcilerDeps} deps - wiring 子集。
* @returns {{reconcile: () => Promise<void>; health: () => {{ lastError: unknown }} }}
*/
function createProviderReconciler(deps) {
	const { settings, providerStore, inference, publisher, usageEvents, logger, rosterSeenStore } = deps;
	/**
	* 把一次 store 读取收成「值或 null」——**同步抛与异步拒收都降级**。
	*
	* store 是外部契约：当前三个 store 方法都是 `async`（同步抛不可达），但这
	* 不是可依赖的保证——病态实现、未来改签名、测试替身都可能同步抛。同步抛
	* 曾在 `Promise.all([a(), b(), c()])` 的**数组构造处**逃逸，把整个 executor
	* 变成 rejection（2026-10-18 实测的链毒化入口，见 {@link reconcile} 的防
	* 毒化注释）。一次读失败按「未设置」降级是本文件既有纪律，同步抛与拒收
	* 不该得到不同待遇。
	* @template T
	* @param {() => T | Promise<T>} read - 一次 store 读取。
	* @returns {Promise<T | null>} 读到的值，或 null（读不到）。
	*/
	const settle = (read) => {
		try {
			return Promise.resolve(read()).catch(() => null);
		} catch {
			return Promise.resolve(null);
		}
	};
	/**
	* 读一次 desired。三路都降级为「未设置」：读不到按未设置处理，与开关/清单/
	* 覆盖各自的读侧纪律一致——一次读失败不该把收敛打掉。
	* @returns {Promise<Desired>}
	*/
	const readDesired = async () => {
		const [enabled, enabledIds, contextWindow] = await Promise.all([
			settle(() => providerStore.enabled()),
			settle(() => providerStore.enabledIds()),
			settle(() => providerStore.contextWindow())
		]);
		return {
			enabled,
			enabledIds,
			contextWindow
		};
	};
	/** desired 的稳定键：用于「fetch 期间被改了吗」的比对。 */
	const desiredKey = (desired) => JSON.stringify([
		desired.enabled,
		desired.enabledIds,
		desired.contextWindow
	]);
	/**
	* 读这一轮要发布的「额度耗尽集合」。
	*
	* 事件读失败**不抛**（收敛不能因为一条观测路径坏了就停）：降级为空集并留一条
	* warn——与目录 fetch 失败同纪律（原因不丢、下一轮重试）。方向要说清：空集
	* 意味着「没有证据」，picker 会提供那些模型；这是把可观测失败换算成「暂时
	* 没有证据」的取舍，比让整个收敛链崩掉诚实。
	* @returns {Promise<string[]>}
	*/
	const readUnavailable = async () => {
		if (usageEvents === void 0) return [];
		let events;
		try {
			events = await usageEvents();
		} catch (error) {
			logger?.warn?.(`${name}: usage events read failed (${redactSecrets(errMsg(error))}) — no quota-exhaustion evidence this pass`);
			return [];
		}
		return exhaustedModelIds(events, /* @__PURE__ */ new Date(), settings.exhaustionWindowMinutes);
	};
	/**
	* 收敛一遍：读 desired → 拉目录 → 复查 desired → publish。
	* @returns {Promise<void>}
	*/
	const runOnce = async () => {
		const before = await readDesired();
		let catalog;
		try {
			catalog = await inference.fetchModels(before.contextWindow);
		} catch (error) {
			logger?.warn?.(`${name}: catalog fetch failed (${redactSecrets(errMsg(error))}) — the current offer stays registered; the next pass retries`);
			return;
		}
		const after = await readDesired();
		if (desiredKey(after) !== desiredKey(before)) {
			dirty = true;
			return;
		}
		const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
		if (rosterSeenStore !== void 0) try {
			await rosterSeenStore.note(entries.map((entry) => String(entry?.id ?? "")));
		} catch (error) {
			logger?.warn?.(`${name}: roster first-sighting write failed (${redactSecrets(errMsg(error))}) — the new-model marker may miss this pass`);
		}
		const enabledIds = resolveEnabledIds(after.enabledIds, publisher.state.enabledIds);
		const unavailable = await readUnavailable();
		try {
			await publisher.publish(entries, enabledIds, unavailable);
		} catch (error) {
			logger?.warn?.(`${name}: publish failed (${redactSecrets(errMsg(error))}) — the catalog is current, only the provider registration did not land`);
		}
	};
	/** 串行链：每次触发排到链尾；在途那一轮替后来者消费 dirty。 */
	let chain = Promise.resolve();
	/** 有新触发待消费。闭包状态，不暴露——触发方只看得见 {@link reconcile}。 */
	let dirty = false;
	/**
	* 最近一次「未被 runOnce 自行记档」的意外反抗（executor 层面漏网的抛，如
	* `publisher.state` 的 getter 同步抛），下一遍成功即清空。路由侧 await 拿到
	* `result` 会自行 respondError；但**轮询侧 `void reconcile()` 会把它丢掉**——
	* 这份 lastError + 一条 warn 是「这一遍没收敛成」对操作员/测试唯一可观测的
	* 记档（否则链的防毒化会把它连同结果一起吞成 0 痕迹，见 {@link reconcile} 注释）。
	*/
	let lastError = null;
	/**
	* 触发一次收敛。幂等且可重入：在途时只置 dirty，由在途那一轮替本调用消费
	* （N 次连续触发最多收敛成两遍 reconcile，不会排 N 遍）。
	* @returns {Promise<void>} 本触发已被消费（注册态已反映 desired）后 resolve。
	*/
	const reconcile = () => {
		dirty = true;
		const result = chain.then(async () => {
			let guard = 0;
			while (dirty) {
				dirty = false;
				await runOnce();
				if (++guard > 20) break;
			}
		});
		result.then(() => {
			lastError = null;
		}, (error) => {
			lastError = error;
			logger?.warn?.(`${name}: reconcile pass failed (${redactSecrets(errMsg(error))}); state will be reconciled on the next trigger`);
		});
		chain = result.then(() => void 0, () => void 0);
		return result;
	};
	return {
		reconcile,
		/** 最近一次未被记档的意外反抗（成功即清空）；null = 当前健康。 */
		health: () => ({ lastError })
	};
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
const TREND_WINDOW_PATH = "/api/dsh-connect-modelscope-token-plan/trend/window";

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
/** 聚合快照 body。wiring 子集见 routes/snapshot.ts 的 Pick。 */
async function buildSnapshotBody(wiring) {
	const { settings, tokenStore, usageStore, inference, providerStore, drawStore, usagePrefsStore, rosterSeenStore, publisher } = wiring;
	const panelWindow = await usagePrefsStore.windowDays().catch(() => null);
	const windowDays = resolveWindowDays(panelWindow, settings.trendDays, settings.retentionDays);
	const [tokenState, daily, perModel, trend, events, providerNote] = await Promise.all([
		soft(tokenStore.state()),
		soft(usageStore.daily()),
		soft(usageStore.perModelToday()),
		soft(usageStore.trend(windowDays)),
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
	const windowNote = await soft((async () => usagePrefsStore.versionNote())());
	if (windowNote.ok && windowNote.value !== null) shapeWarnings.push(windowNote.value);
	const rosterNote = await soft((async () => rosterSeenStore.versionNote())());
	if (rosterNote.ok && rosterNote.value !== null) shapeWarnings.push(rosterNote.value);
	if (curatedCatalogStale()) {
		const age = curatedCatalogAgeDays();
		shapeWarnings.push(`context-catalog: curated windows were last verified on ${CURATED_AS_OF}` + (age === null ? "" : ` (${age} days ago)`) + " — re-check them against the current catalogue");
	}
	const provider = await soft((async () => {
		const panel = await providerStore.enabled().catch(() => null);
		const enabled = resolveSwitchEnabled(panel, settings.registerProvider);
		const source = switchSource(panel);
		const roster = rosterWithAvailability(modelEntries, publisher.state.unavailableIds ?? [], settings.maxTokensOverrides);
		const stored = await providerStore.enabledIds().catch(() => null);
		const enabledIds = resolveEnabledIds(stored, publisher.state.enabledIds);
		const allowedList = parseAllowedList(enabledIds);
		const enabledCount = enabledCountOf(allowedList, roster.map((row) => row.id));
		const contextWindow = await providerStore.contextWindow().catch(() => null);
		const catalogNote = models.ok ? null : `模型目录读不到：${models.error}`;
		const newModelIds = await rosterSeenStore.fresh().catch(() => []);
		return {
			enabled,
			source,
			llmAvailable: publisher.state.llmAvailable === true,
			registered: publisher.state.registered === true,
			error: typeof publisher.state.error === "string" ? publisher.state.error : catalogNote,
			modelCount: roster.length,
			enabledCount,
			allowed: allowedList.mode,
			enabledIds,
			contextWindow,
			newModelIds,
			roster
		};
	})());
	const draw = await soft((async () => {
		const panel = await drawStore.enabled().catch(() => null);
		const panelModel = await drawStore.modelId().catch(() => null);
		const candidates = drawCandidates(modelEntries);
		const preferred = resolveSwitchValue(panelModel, settings.drawModelId === "" ? void 0 : settings.drawModelId) ?? null;
		const choice = resolveDrawModelChoice(modelEntries, void 0, preferred ?? void 0);
		return {
			enabled: resolveSwitchEnabled(panel, settings.drawEnabled),
			source: switchSource(panel),
			candidateIds: candidates.map((row) => row.id),
			candidateCount: candidates.length,
			candidates,
			preferredModel: preferred,
			preferredSource: switchSource(panelModel),
			effectiveModel: choice.id,
			effectiveSource: choice.source,
			absentReason: drawToolNote(),
			mountPending: resolveSwitchEnabled(panel, settings.drawEnabled) === true && drawToolMounted() !== true,
			preferredInCatalog: preferred === null ? null : models.ok ? candidates.some((row) => row.id === preferred) : null,
			toolName: "modelscope_draw_image"
		};
	})());
	if (!provider.ok) shapeWarnings.push(`provider source failed (${provider.code}): ${provider.error}`);
	if (!draw.ok) shapeWarnings.push(`draw source failed (${draw.code}): ${draw.error}`);
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
			perModel: perModel.ok ? perModel.value : null,
			countingNote: "local-counting"
		},
		events: events.ok ? events.value : null,
		trend: {
			days: windowDays,
			windowDays: panelWindow,
			maxDays: settings.retentionDays,
			buckets: trend.ok ? trend.value : null
		},
		models: {
			available: models.ok,
			count: modelIds.length,
			sample: modelIds.slice(0, 20),
			error: models.ok ? null : models.error
		},
		...provider.ok ? { provider: provider.value } : {},
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
				error: `request body is too large (max ${limit} bytes)`
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
* usageStore / inference / providerStore / drawStore / usagePrefsStore /
* rosterSeenStore / publisher / logger。
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
* 读目录条目，读不到**抛错**（让 snapshot() 走 respondError 返回 ok:false）。
*
* 读目录前先取**当前窗口覆盖**传给 `fetchModels`：条目在归一前打上覆盖标记，
* descriptor / roster / catalogSignature 都从这份条目派生。每个写路由（开关、
* 清单、窗口、reset）都经这里取条目再 publish，所以任何一次重注册都带着最新
* 覆盖——否则先存窗口、再存清单会把未打标的目录重新注册上去，覆盖静默失效到
* 下一轮轮询。
*
* **为什么抛错而不是降级成空目录**：空 roster 与「真的没有模型」在面板上长得
* 一模一样（modelCount=0），而真相是「目录拉不到」——这与 snapshot-aggregate
* 的 `models.available=false` 语义矛盾（后者明确区分「0 个模型」与「读不到」）。
* 抛错让 GET 返回 ok:false + error，面板能显示「目录拉不到」而不是「0 个模型」。
*/
async function readEntries$1(inference, providerStore) {
	const contextWindow = await optional(providerStore?.contextWindow?.(), null);
	const catalog = await inference.fetchModels(contextWindow);
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
* `allowed` 的分类与 `enabledCount` 的计数：都从 `shared/allow-list.ts` 的
* {@link parseAllowedList} 联合上取（fix D：快照与 provider 路由以前各写一套
* 分类，会漂移；旧版 `allowedOf` 只认「恰好哨兵」为 `"none"`，
* `["__hide_all__","other"]` 会被错判成 `"list"`——统一到联合后，含哨兵即
* `"none"`，与 `filterByEnabled` / `isModelEnabled` 同一份解释）。
*/
/**
* 注册 provider 路由（三条路径）。wiring 子集：settings / providerStore /
* publisher / inference / logger。
* @param ctx - host 根上下文（只用 `ctx.webServer`）。
* @param {ProviderRouteWiring} wiring - 本路由读到的子集。
* @returns {Function} 依次调用三个 `off()` 的注销回调。
*/
function registerProviderRoute(ctx, wiring) {
	const { settings, providerStore, publisher, reconcile, inference, rosterSeenStore, logger } = wiring;
	/**
	* 组装一份 §9 响应形状。GET 与成功后的 POST 共用，所以两个方向不可能对「当前
	* 状态是什么」说两套话。
	*
	* **目录读不到怎么办**：GET 是权威读路径，读不到就让它失败（handler 转
	* `respondError`，面板看见「目录拉不到」而不是「0 个模型」）。POST 的响应只是
	* 保存后的回读，而此时**保存已经成功**——不能把一次成功的写报成失败，所以
	* `tolerateCatalogFailure` 让它降级为空 roster 并带上 `catalogError` 说明原因。
	* @param {object} [extra] - 调用方要追加/覆盖的字段。
	* @param {object} [options] - `{ tolerateCatalogFailure }`：写成功后的回读宽容模式。
	* @returns {Promise<object>} 响应体。
	*/
	const snapshot = async (extra = {}, options = {}) => {
		const panelSwitch = await optional(providerStore.enabled());
		const enabledIds = await readEnabledIds(providerStore, publisher.state.enabledIds);
		const contextWindow = await optional(providerStore.contextWindow?.(), null);
		let entries = [];
		let catalogError = null;
		try {
			entries = await readEntries$1(inference, providerStore);
		} catch (error) {
			if (options.tolerateCatalogFailure !== true) throw error;
			catalogError = redactedError(error);
		}
		const roster = rosterWithAvailability(entries, publisher.state.unavailableIds ?? [], settings.maxTokensOverrides);
		const allowedList = parseAllowedList(enabledIds);
		const modelCount = roster.length;
		const newModelIds = rosterSeenStore === void 0 ? [] : await optional(rosterSeenStore.fresh(), []);
		return {
			ok: true,
			enabled: resolveSwitchEnabled(panelSwitch, settings.registerProvider),
			source: switchSource(panelSwitch),
			llmAvailable: publisher.state.llmAvailable === true,
			registered: publisher.state.registered === true,
			error: typeof publisher.state.error === "string" ? publisher.state.error : null,
			modelCount,
			enabledCount: enabledCountOf(allowedList, roster.map((row) => row.id)),
			allowed: allowedList.mode,
			enabledIds,
			contextWindow,
			newModelIds,
			roster,
			...catalogError !== null ? { catalogError } : {},
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
				try {
					writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
				} catch (error) {
					respondError(response, error);
				}
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
				await reconcile();
			} catch (error) {
				respondError(response, error);
				return;
			}
			writeJson(response, 200, await snapshot({}, { tolerateCatalogFailure: true }), { "cache-control": "no-store" });
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
				await reconcile();
			} catch (error) {
				respondError(response, error);
				return;
			}
			writeJson(response, 200, await snapshot({}, { tolerateCatalogFailure: true }), { "cache-control": "no-store" });
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
				await reconcile();
			} catch (error) {
				respondError(response, error);
				return;
			}
			writeJson(response, 200, await snapshot({}, { tolerateCatalogFailure: true }), { "cache-control": "no-store" });
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
				await reconcile();
			} catch (error) {
				respondError(response, error);
				return;
			}
			writeJson(response, 200, await snapshot({}, { tolerateCatalogFailure: true }), { "cache-control": "no-store" });
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
* tools registry 没有 unregister，工具一旦注册就摘不下来（完整论述见
* draw-register.ts 文件头注）。所以本路由保存成功后
* 不改挂载状态，只在响应里给出 `mountPending`，让面板能说清这件事，而不是让用户
* 以为开关坏了。
*
* peer-free：不 import 任何 Host peer。
* @module dsh-connect-modelscope-token-plan/routes/draw
*/
/**
* 读目录条目。
*
* 与 provider 路由同一条纪律：GET 不能因为一次目录失败就把整个面板状态打掉——
* 出图候选为空只影响「能不能挑模型」，不影响开关的显示。
*
* 但「空目录」和「目录读不到」必须分开（红线 3）：后者要能回答「首选模型还在
* 不在」时说「不知道」而不是「不在」。所以这里返回 `{ ok, entries }`，调用方
* 按 ok 决定是断言还是弃权。
*
* @param {object} inference - inference client。
* @returns {Promise<{ok: boolean, entries: unknown[]}>} 目录读取结果与归一条目。
*/
async function readEntries(inference) {
	try {
		const catalog = await inference.fetchModels();
		return {
			ok: true,
			entries: Array.isArray(catalog?.entries) ? catalog.entries : []
		};
	} catch {
		return {
			ok: false,
			entries: []
		};
	}
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
		const catalog = await readEntries(inference);
		const candidates = drawCandidates(catalog.entries);
		const preferredModelId = resolveSwitchValue(panelModelId, settings.drawModelId === "" ? void 0 : settings.drawModelId) ?? null;
		const choice = resolveDrawModelChoice(catalog.entries, void 0, preferredModelId ?? void 0);
		return {
			ok: true,
			enabled: resolveSwitchEnabled(panelSwitch, settings.drawEnabled),
			source: switchSource(panelSwitch),
			candidateIds: candidates.map((row) => row.id),
			candidateCount: candidates.length,
			candidates,
			preferredModel: preferredModelId,
			preferredSource: switchSource(panelModelId),
			effectiveModel: choice.id,
			effectiveSource: choice.source,
			absentReason: drawToolNote(),
			/**
			* 开关的保存**不会**改变本次挂载的工具。
			*
			* 工具无法注销（peer 的 tools registry 没有 unregister），所以开关翻转只在
			* 下次 Host 启动时生效。面板据此显示一句说明——否则用户会以为开关坏了。
			* 判据：开关为开且**本次挂载没注册上**。
			*
			* 注意判据不是「有缺席原因」：缺席原因非 null 表示注册尝试过且失败，而挂载
			* 那一刻开关是关的（用户之后才翻开）时 absentReason 为 null、却同样没注册
			* 上——后者才是最需要这句提示的场景。见 `draw-tool-state.ts` 文件头。
			*/
			mountPending: resolveSwitchEnabled(panelSwitch, settings.drawEnabled) === true && drawToolMounted() !== true,
			preferredInCatalog: preferredModelId === null ? null : catalog.ok ? candidates.some((row) => row.id === preferredModelId) : null,
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
//#region src/host/routes/usage-prefs.ts
/**
* 趋势图**显示窗口**路由：读当前窗口（GET）与保存（POST）。
*
* 一条路径两件事：
*   - GET  `TREND_WINDOW_PATH`   读面板覆盖 + 生效天数 + 上界（无副作用）；
*   - POST `TREND_WINDOW_PATH`   body `{ windowDays: number|null }` → 保存
*     （`null` = 清除覆盖，回到 `trendDays` 配置默认）。
*
* **与 provider / draw 路由不同，本路由保存后不触发任何收敛**：显示窗口只影响
* 快照里 `trend` 那一段，面板保存成功后自己调一次 `load()` 就当场回显；没有
* 需要重建的注册态。
*
* 越界值**夹取而不是拒绝**：上界是保留窗口（`settings.retentionDays`），而
* host-config 对配置里的同一个值也是夹——两处若一个夹一个拒，同一个越界值会因
* 来源不同得到两个下场。类型给错（字符串 / 缺字段）仍然按 400 拒：那是形状错，
* 不是范围错。
*
* peer-free：不 import 任何 Host peer。
* @module dsh-connect-modelscope-token-plan/routes/usage-prefs
*/
/**
* 注册趋势窗口路由。
* @param ctx - host 根上下文（只用 `ctx.webServer`）。
* @param {UsagePrefsRouteWiring} wiring - 本路由读到的子集。
* @returns {Function} 注销回调。
*/
function registerUsagePrefsRoute(ctx, wiring) {
	const { settings, usagePrefsStore, logger } = wiring;
	/**
	* 组装响应。GET 与写成功后的响应共用，两个方向不可能对「当前窗口」说两套话。
	* @param {object} [extra] - 追加/覆盖字段。
	* @returns {Promise<object>} 响应体。
	*/
	const snapshot = async (extra = {}) => {
		const panel = await optional(usagePrefsStore.windowDays());
		return {
			ok: true,
			windowDays: panel,
			days: resolveWindowDays(panel, settings.trendDays, settings.retentionDays),
			maxDays: settings.retentionDays,
			source: switchSource(panel),
			...extra
		};
	};
	const off = ctx.webServer.register({
		kind: "exact",
		path: TREND_WINDOW_PATH,
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
			const isNull = body.windowDays === null;
			const isNumber = typeof body.windowDays === "number" && Number.isFinite(body.windowDays);
			if (!isNull && !isNumber) {
				writeJson(response, 400, {
					ok: false,
					error: "expected { windowDays: number | null }"
				}, { "cache-control": "no-store" });
				return;
			}
			const saved = isNull ? null : Math.min(Math.max(1, Math.floor(body.windowDays)), settings.retentionDays);
			try {
				await usagePrefsStore.saveWindowDays(saved);
			} catch (error) {
				respondError(response, error);
				return;
			}
			writeJson(response, 200, await snapshot(), { "cache-control": "no-store" });
		}, settings.allowedHosts)
	});
	return () => {
		try {
			off();
		} catch (error) {
			logger?.warn?.(`trend window route unregister failed: ${redactedError(error)}`);
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
		registerDrawRoute(ctx, wiring),
		registerUsagePrefsRoute(ctx, wiring)
	];
}

//#endregion
//#region src/host/index.ts
/**
* dsh-connect-modelscope-token-plan — Host 半边（装配入口）。
*
* 本插件的定位是**额度 + provider + 出图 + 上下文窗口策展**的多功能集成（见
* AGENTS.md「定位变更」），不再是「只做额度信息」的那一版。口径分工：推理响应
* **不携带**额度头（SPIKE.md §结论 1），但官方另有魔粒余额端点
* （`GET {siteBase}/openapi/v1/magicubes/balance`，SPIKE.md 文首后记，2026-10-04
* 实测可用），面板头条读的是它；本文件下的兄弟模块只负责本地计数那一半（按模型
* 分布 / 本地趋势 / 429 事件流），回答官方余额答不了的问题。
*
* 重活都在专注的兄弟模块里，本文件只保留 Cordis 入口（name/inject/apply）、
* wiring 装配与卸载副作用。兄弟模块按域分组：
*
*   **配置与凭据**
*   - `host-config.ts`        配置契约 + isAdmitted 信任围栏 + 夹取常量
*   - `switch-precedence.ts`  开关优先级：面板值 > patch 默认
*   - `ms-auth.ts`            访问令牌存取（静态钥匙，无登录流；唯一凭据出口）
*
*   **路由（7 条，`routes.ts` 是门面，`routes/` 下各域一份）**
*   - `routes/snapshot.ts`    面板轮询的唯一只读路由
*   - `routes/models.ts`      模型目录
*   - `routes/token.ts`       令牌保存/忘掉/验证
*   - `routes/probe.ts`       零额度鉴权探针
*   - `routes/provider.ts`    provider 开关/清单/窗口/重置
*   - `routes/draw.ts`        出图开关/模型/重置
*   - `routes/usage-prefs.ts` 趋势显示窗口
*   - `routes/http.ts`        CORS / JSON / 错误脱敏的公共辅助
*   - `routes/paths.ts`       路由路径常量
*
*   **数据层（`state-store.ts` 是共用原语）**
*   - `state-store.ts`        原子写/版本守卫/读缓存/写队列（四个 store 共用）
*   - `usage-store.ts`        本地计数：天桶/单模型/事件流
*   - `provider-store.ts`     开关 + 允许清单 + 窗口覆盖的持久化
*   - `draw-store.ts`         出图开关 + 模型偏好
*   - `usage-prefs-store.ts`  趋势显示窗口偏好 + `resolveWindowDays` 夹取
*   - `inference-client.ts`   HTTP 出口：模型目录 + 魔粒余额 + 探针
*   - `coalesced-fetch.ts`    有界并发缓存（目录/余额/标签共用）
*   - `context-catalog.ts`    内置上下文窗口策展表（models.dev 交叉真值）
*
*   **Provider 注册**
*   - `llm-models.ts`         目录 → descriptor 映射（peer-free）
*   - `llm-adapter.ts` / `llm-adapter-core.ts`  适配器装配（core 为三族共享）
*   - `provider-publish.ts`   发布状态机：队列/disposed 闸/回滚
*   - `provider-reconcile.ts` desired-state 收敛器（轮询 + 路由统一触发）
*   - `publish-core.ts`       三族共享的发布原语
*
*   **观测与纠正**
*   - `usage-observer.ts`     真实对话 → 本地计数/事件（观察流出口）
*   - `llm-error-fix.ts`      429 误判纠正（QUOTA → RATE_LIMIT）
*   - `llm-retry.ts`          重试策略（按 code 决定退避）
*   - `codes.ts`              错误分类单一真源
*
*   **出图工具**
*   - `draw.ts`               协议纯逻辑半边（peer-free）
*   - `draw-register.ts`      工具注册（挂载时一次性，不可撤销）
*   - `draw-runtime.ts`       运行时（两段式：提交 → 轮询）
*   - `draw-jobs.ts`          作业表（本次挂载内有效）
*   - `draw-tool-state.ts`    缺席原因 + 本次挂载注册位（内存）
*
*   **聚合与工具**
*   - `snapshot-aggregate.ts` 快照聚合（软失败，绝不白屏）
*   - `doctor.ts`             只读盘点工具
*   - `util.ts`               通用工具（脱敏/错误消息/类型守卫）
*   - `types.ts`              Host 侧类型定义
*
* 完整的「文件 → 一句话职责 → 关键导出」表在 AGENTS.md 的代码地图里，由
* test/docs.test.mjs §14 门禁守着（每个 src/*.ts 都必须登记）。本注释只做入口
* 处的分组索引——**新增兄弟模块时两处都要改**，别让这里再落后一轮。
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
		retentionDays: settings.retentionDays,
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
	const drawJobs = createDrawJobs({ resumeWindowMs: settings.drawTimeoutMs });
	const usagePrefsStore = createFileUsagePrefsStore({
		profile,
		logger: ctx.logger
	});
	const rosterSeenStore = createFileRosterSeenStore({
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
	const { reconcile } = createProviderReconciler({
		settings,
		providerStore,
		inference,
		publisher,
		usageEvents: () => usageStore.events(),
		rosterSeenStore,
		logger: ctx.logger
	});
	const wiring = {
		settings,
		configError,
		tokenStore,
		usageStore,
		inference,
		providerStore,
		drawStore,
		drawJobs,
		usagePrefsStore,
		rosterSeenStore,
		publisher,
		reconcile,
		logger: ctx.logger
	};
	const offs = registerRoutes(ctx, wiring);
	ctx.effect(() => {
		reconcile().catch((error) => {
			ctx.logger?.warn?.(`${name}: mount reconcile failed (${redactSecrets(errMsg(error))})`);
		});
		registerDrawTool(ctx, wiring, deps);
		const timer = setInterval(() => {
			reconcile().catch((error) => {
				ctx.logger?.warn?.(`${name}: scheduled reconcile failed (${redactSecrets(errMsg(error))})`);
			});
		}, settings.pollSeconds * 1e3);
		return () => {
			clearInterval(timer);
			resetDrawToolNote();
			drawJobs.dispose();
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