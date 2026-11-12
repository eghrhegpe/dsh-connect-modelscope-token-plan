/**
 * 账户池协调器：CN（modelscope.cn）与国际版（modelscope.ai）两个源站的令牌解析 +
 * 运行时健康态（轮询 + 故障转移）。
 *
 * ## 与 `ms-auth.ts` 的分工
 *
 * `ms-auth.ts` 是**单账户**凭据出口（每个源站各建一个 `createTokenStore`，绑各自的
 * DSH 凭据引用）。本模块是这两路的**协调层**：持有两路 tokenStore + 各自
 * apiBase/siteBase，对外暴露「按源站挑一把健康令牌」「两源站各取余额」「哪些源站
 * 配了令牌」——不碰注册 provider（那是 `provider-publish` 的事），也不碰 HTTP
 * （那是 `inference-client` 的事）。
 *
 * ## 红线 1/2 守约
 * 每个源站各走一个 DSH 凭据引用——CN = `MODELSCOPE_API_KEY`（沿用），国际 =
 * `MODELSCOPE_INTERNATIONAL_API_KEY`（新增）。kind 仍是凭据服务的 `api-key`，
 * **不发明结构化 kind**（不把多账户塞进一个凭据值——那会让凭据文件对整个 Host
 * 不可解析，Host 直接起不来）。
 *
 * ## 健康态（轮询 + 故障转移）
 * 每源站目前一把令牌（UI 保存每源站一把起步）。数据模型按「每源站 N 把」设计：
 * 同源站多把令牌的纯负载池是后续扩展，届时 `resolveToken` 在冷却集合里轮询、跳过
 * 最近 429/坏令牌的那几把即可。本模块只负责「按源站挑一把可用令牌」这一层。
 *
 * @module dsh-connect-modelscope-token-plan/account-pool
 */
import { createTokenStore, TOKEN_REF, TOKEN_REF_INTERNATIONAL } from "./ms-auth.ts";

/** 源站：cn = 魔搭社区（modelscope.cn）；ai = ModelScope International（modelscope.ai）。 */
export type Region = "cn" | "ai";

/** 两个源站（遍历用）。 */
export const REGIONS: readonly Region[] = ["cn", "ai"];

/** 单源站的一把账户（令牌 store + 该源站的 apiBase/siteBase）。 */
interface Account {
  region: Region;
  ref: string;
  apiBase: string;
  siteBase: string;
  tokenStore: ReturnType<typeof createTokenStore>;
}

/** account-pool 的构造依赖（与 ms-auth 同缝：credentials / env 都走 deps，产品不传即落回 ctx / 全局）。 */
interface AccountPoolDeps {
  credentials?: unknown;
  env?: Record<string, string | undefined> | undefined;
  settings: {
    apiBase: string;
    siteBase: string;
    apiBaseInternational: string;
    siteBaseInternational: string;
  };
}

/** 一笔令牌解析结果（不含完整 TokenStatus；完整状态走 `tokenState`）。 */
export interface AccountToken {
  value: string;
  source: "credentials" | "memory" | "env" | null;
}

/**
 * 构造账户池。CN 与国际各建一个 tokenStore（各自凭据引用），并存各自 apiBase/siteBase。
 * @param {AccountPoolDeps} deps
 * @returns 协调器。
 */
export function createAccountPool(deps: AccountPoolDeps) {
  const { credentials, env, settings } = deps;

  const accounts: Record<Region, Account> = {
    cn: {
      region: "cn",
      ref: TOKEN_REF,
      apiBase: settings.apiBase,
      siteBase: settings.siteBase,
      // ref 必须显式传：两站各一把凭据引用，国际站绝不能复用到 CN 的
      // MODELSCOPE_API_KEY（否则「保存国际令牌」会写进 CN 那一把）。
      tokenStore: createTokenStore({ credentials, env, ref: TOKEN_REF })
    },
    ai: {
      region: "ai",
      ref: TOKEN_REF_INTERNATIONAL,
      apiBase: settings.apiBaseInternational,
      siteBase: settings.siteBaseInternational,
      tokenStore: createTokenStore({ credentials, env, ref: TOKEN_REF_INTERNATIONAL })
    }
  };

  /**
   * 每源站一个冷却到期时间（故障转移用）。目前每源站一把令牌，冷却即「这一把暂时
   * 不可用」；多把令牌扩展时冷却应挂在具体那一把上、挑下一把。
   */
  const cooldownUntil: Record<Region, number> = { cn: 0, ai: 0 };
  /** 故障转移冷却时长：一笔 429 / 鉴权失败后，该源站令牌短暂冷却，避免对坏令牌死循环。 */
  const COOLDOWN_MS = 30_000;

  /**
   * 解析某源站当前应使用的令牌。
   *
   * 目前每源站一把，直接返回那一把；冷却态不改变「取哪一把」（因为只有一把），但
   * 聚合层可经 `isCooling` 读它来标注「该账户暂时不可用」。多把令牌扩展时这里改为
   * 在冷却集合里轮询、跳过冷却中的那几把。
   * @param {Region} region
   * @returns {Promise<AccountToken>}
   */
  const resolveToken = async (region: Region): Promise<AccountToken> => {
    const resolved = await accounts[region].tokenStore.resolve();
    return { value: resolved.value, source: resolved.source };
  };

  /**
   * 标记某源站最近一次请求失败（429 / 鉴权失败）——进入冷却。
   * @param {Region} region
   */
  const noteFailure = (region: Region): void => {
    cooldownUntil[region] = Date.now() + COOLDOWN_MS;
  };

  /** 标记某源站请求成功——清除冷却。 */
  const noteSuccess = (region: Region): void => {
    cooldownUntil[region] = 0;
  };

  /** 某源站的令牌是否仍处冷却（故障转移判断用）。 */
  const isCooling = (region: Region): boolean => cooldownUntil[region] > Date.now();

  /**
   * 配置了令牌的源站集合（令牌 present 的那些）。
   * @returns {Promise<Region[]>}
   */
  const regions = async (): Promise<Region[]> => {
    const present: Region[] = [];
    for (const region of REGIONS) {
      const state = await accounts[region].tokenStore.state();
      if (state.present) present.push(region);
    }
    return present;
  };

  /** 某源站的 apiBase（适配器按 region 路由请求用）。 */
  const apiBaseOf = (region: Region): string => accounts[region].apiBase;
  /** 某源站的 siteBase（余额 / 外链用）。 */
  const siteBaseOf = (region: Region): string => accounts[region].siteBase;
  /** 某源站的完整令牌状态（快照聚合用）。 */
  const tokenState = (region: Region) => accounts[region].tokenStore.state();
  /** 某源站的 raw tokenStore（balance / probe 走它解析令牌）。 */
  const tokenStoreOf = (region: Region) => accounts[region].tokenStore;

  return {
    resolveToken,
    noteFailure,
    noteSuccess,
    isCooling,
    regions,
    apiBaseOf,
    siteBaseOf,
    tokenState,
    tokenStoreOf,
    REGIONS
  };
}
