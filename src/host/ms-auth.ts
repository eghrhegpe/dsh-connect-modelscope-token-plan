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
import { verbatim } from "./util.ts";
import type { TokenStatus } from "../shared/wire.ts";

/** 引用名：沿用本机凭据库里已存在的记录（README「三条事实」第 3 条）。 */
export const TOKEN_REF = "MODELSCOPE_API_KEY";

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
export function isPlausibleToken(value: string): boolean {
  return typeof value === "string" && TOKEN_SHAPE.test(value.trim());
}

/**
 * 构造令牌 store。
 * @param {object} [options] - wiring。
 * @param {object|Function|null} [options.credentials] - `ctx.credentials` 服务
 *   或其 resolver；**每次使用时解析**（服务可能在本插件挂载之后才注册，
 *   一次性查找会把错误的 "ephemeral" 断言冻进后续每个轮询）。
 * @param {object} [options.env] - 环境源；默认 `process.env`。
 */
export function createTokenStore({ credentials = null, env = process.env }: { credentials?: unknown; env?: Record<string, string | undefined> } = {}) {
  /** 无凭据服务的 Host 的内存兜底。 */
  const memory = new Map();

  const resolveService = () => {
    const value = typeof credentials === "function" ? credentials() : credentials;
    return value ?? null;
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
    async save(token: string) {
      const value = verbatim(token, "");
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error("a ModelScope token is required");
      }
      if (!isPlausibleToken(value.trim())) {
        throw new Error(
          "that does not look like a ModelScope access token (expected ms- followed by hex digits)"
        );
      }
      const service = resolveService();
      if (service !== null && typeof service.set === "function") {
        // 先落持久层：服务拒绝的 save 必须传播出去，由路由呈报，不能留半态。
        await service.set(TOKEN_REF, value);
        // 镜像进内存：服务可能在下次 resolve 前注销，已落盘的值不能读成缺席。
        memory.set(TOKEN_REF, value);
      } else {
        memory.set(TOKEN_REF, value);
      }
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
      const service = resolveService();
      if (service !== null && typeof service.unset === "function") {
        await service.unset(TOKEN_REF);
      }
    },

    /**
     * 解析当前令牌与来源。返回类型显式注解：这是快照 TokenStatus.source
     * 联合类型的上游，靠推断会把字面量联合拓宽成 string。
     * @returns {Promise<{value: string, source: ("credentials"|"memory"|"env"|null)}>}
     */
    async resolve(): Promise<{ value: string; source: "credentials" | "memory" | "env" | null }> {
      try {
        const service = resolveService();
        if (service !== null && typeof service.resolve === "function") {
          const resolved = await service.resolve(TOKEN_REF).catch(() => undefined);
          const value = verbatim(resolved?.value, "");
          if (typeof value === "string" && value.trim() !== "") return { value, source: "credentials" };
        }
      } catch {
        // 服务不可用：落回内存/env。
      }
      const held = memory.get(TOKEN_REF);
      if (typeof held === "string" && held.trim() !== "") return { value: held, source: "memory" };
      const fromEnv = verbatim(env[TOKEN_REF], "");
      if (typeof fromEnv === "string" && fromEnv.trim() !== "") return { value: fromEnv, source: "env" };
      return { value: "", source: null };
    },

    /**
     * 无秘密的状态描述（快照与面板消费）。
     * `valid` 恒为 null：本模块不做有效性断言（零额度探针在 probe 路由，
     * 语义已于 2026-10-04 真机回填——判定 401/403 = 令牌坏、200/400 = 令牌好；
     * SPIKE.md §结论 5）。
     *
     * `ephemeral` 答的是「**手里这个值**重启会不会丢」，不是「有没有凭据服务」
     * ——wire 的定义是前者。曾经只按「服务缺席」置位，于是两种都说谎：没有服务
     * 时若令牌来自 env（重启不丢）被标 ephemeral；服务在场时面板保存的值被标非
     * ephemeral（那是碰巧对，不是判出来的）。按来源答：
     * `memory` 才真的只在本次进程存活期间存在。
     */
    async state(): Promise<TokenStatus> {
      const { source } = await this.resolve();
      return {
        present: source !== null,
        source: source === null ? "none" : source,
        valid: null,
        checkedAt: null,
        ephemeral: source === "memory"
      };
    }
  };
}
