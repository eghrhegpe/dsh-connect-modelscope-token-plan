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
import { verbatim } from "./util.ts";
import type { TokenStatus } from "../shared/wire.ts";

/** 引用名：沿用本机凭据库里已存在的记录（README「三条事实」第 3 条）。 */
export const TOKEN_REF = "MODELSCOPE_API_KEY";

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
    /** 把面板输入的令牌存成引用；原样存（不 trim），空白值视为没输入。 */
    async save(token: string) {
      const value = verbatim(token, "");
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error("a ModelScope token is required");
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
     */
    async forget() {
      memory.delete(TOKEN_REF);
      try {
        const service = resolveService();
        if (service !== null && typeof service.unset === "function") {
          await service.unset(TOKEN_REF);
        }
      } catch {
        // 内存副本已清，没有别的可做。
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
     * 尚待真机验证后接入——SPIKE.md §结论 5）。
     */
    async state(): Promise<TokenStatus> {
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
