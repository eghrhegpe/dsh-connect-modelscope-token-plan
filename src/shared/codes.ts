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
export const CODE = Object.freeze({
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

export type CodeValue = (typeof CODE)[keyof typeof CODE];
