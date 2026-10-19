/**
 * 对话框用量胶囊 —— 输入框工具栏 `conversation.input.right` 座席。
 *
 * **为什么不是百分比**：本插件没有可画的「已用 / 上限」。魔粒余额是**存量**，
 * 官方没有发布窗口上限，也没有任何「低额阈值」——给它配一个分母就等于发明一个
 * 没人公布过的数字（口径纪律见 README「诚实声明」一节：本仓库没有单独的计量文档，
 * 那两段就是唯一家）。所以胶囊只显示两个
 * 真实存在的读数，且各标各的来源：
 *   - 官方魔粒余额：`snapshot.balance.available`，来自官方 `openapi/v1/magicubes/balance`；
 *   - 今日本地调用次数：`snapshot.quota.daily.usedLocal`，Host 侧按本地日聚合、
 *     只统计经本插件的调用——所以正文里必须带「本地」二字，否则会被读成官方口径。
 * 正因为两个数字来源不同，正文写成 `魔搭 · 143 魔粒 · 今日本地 7 次`：前缀说
 * 「哪套额度」，后两段各自说「这个数字是谁给的」。
 *
 * **null ≠ 0**：读不到（Host 软失败、上游没给该字段）渲染「—」，绝不渲染 0。
 * 0 是读数（余额确实耗尽，走告警色），null 是「不知道」。面板里
 * `cards.ts` 的 BalanceCard / LocalDailyCard 是同一条纪律，这里不破例。
 *
 * **门控在组件边界**（本组件「切模型即消失、切回来又出现」的关键）：外层
 * `ComposerUsagePill` 只在会话当前选中的 provider 是本插件时挂内层
 * `ModelscopePill`，轮询 hook 全在内层调用，于是每一帧的 hook 顺序恒定。若在
 * 同一组件里先调 hook 再按门控 `return null`，切模型会踩 Rules of Hooks
 * （组件被 React 甩出树，切回归属模型也起不来）。
 *
 * 归属判定读 `useProjection("modelSelection")`（`next` 优先于 `lastUsed`；一切
 * 形状判定的细节见 {@link selectedProviderOf}）。这个 prop 由槽系统按 session
 * 作用域物化注入——宿主侧 `@deepseek-ai/dsh-client-ui-session` 声明
 * `keyedHooks: ["projection"]`，`standardHookPropName("projection")` 得到
 * `useProjection`——所以本文件只声明它、绝不自己 import react 以外的东西。
 * Node 侧单测把替身直接当 prop 传进来即可。
 *
 * 数据复用面板的同一个轮询内核（`useSnapshotPolling`），不新开接口、不新列路由：
 * 胶囊与面板读同一份快照，失败降级也一致（保留上次数值并标「上次数据」）。
 *
 * 样式：本组件不注入样式表，全部外观是 inline style，取自 `styles.ts` 的
 * `S.pill*` 一族——那一族按**宿主工具栏**的尺度定（28px 高 / 12px 字 / 无框 /
 * 透明底），不按本插件卡片自己的 13px 框按钮尺度。`className` 只作测试选择器。
 * @module dsh-connect-modelscope-token-plan/client/composer-usage-pill
 */
import { h } from "./runtime.ts";
import { S } from "./styles.ts";
import { count, format, isoTime, statedCadenceMs } from "./format.ts";
import { useSnapshotPolling } from "./use-snapshot-polling.ts";
import type { Tt } from "./runtime.ts";
import type { BalanceData, Snapshot } from "../shared/wire.ts";

/**
 * 本胶囊认领的 provider id，与 Host 侧 `src/host/llm-models.ts` 的
 * `LLM_PROVIDER_ID` 必须是同一个字面量——客户端不能 import host 模块，所以
 * `test/composer-pill.test.mjs` 直接读那两个文件把这条一致性钉死。拼错一处就是
 * 「接入了魔搭模型但胶囊永远不出现」。
 */
export const MODELSCOPE_PROVIDER = "modelscope-token-plan";

/** 面板默认轮询周期（Host 未声明 `pollSeconds` 时的回退，与 useSnapshotPolling 同值）。 */
const DEFAULT_CADENCE_MS = 30_000;

/**
 * 连续多少个轮询周期没读到新快照，就把数字标成「上次数据」。
 *
 * 取 3 而不是 1：`updatedAt` 只在**成功**时变，而失败退避本身就会拉长间隔；卡在
 * 1 个周期上会让一次偶发失败立刻把读数打成陈旧的。3 个周期（默认 30s → 90s）
 * 意味着「已经错过了两轮本该到来的成功读」，这时的数字才真的可能骗人。
 */
const STALE_CADENCES = 3;

/** `modelSelection` 投影里本胶囊用到的字段（宿主 schema 的子集）。 */
export interface ModelSelectionLike {
  next?: { provider?: string; model?: string } | null;
  lastUsed?: { provider?: string; model?: string } | null;
}

/** 槽位递来的 props（外加渲染器物化注入的 `useProjection`）。 */
export interface ComposerPillProps {
  tt: Tt;
  useProjection?: (key: "modelSelection") => ModelSelectionLike | undefined;
}

/**
 * 一个候选自带的 provider，空串算「没有」。
 *
 * `typeof provider === "string"` 是不够的判据：`""` 也是字符串。照类型判定会让
 * `{ provider: "" }` 被当成一个「可用的 next」，于是它遮住仍然可用的 `lastUsed`
 * ——切模型那一帧胶囊就消失。所以这里判的是**非空字符串**。
 */
function providerOf(candidate: { provider?: string; model?: string } | null | undefined): string | undefined {
  const provider = candidate?.provider;
  return typeof provider === "string" && provider !== "" ? provider : undefined;
}

/**
 * 会话当前指向的 provider。
 *
 * `next` 优先于 `lastUsed`（切换已落地但还没发出去时，选择器显示的就是 `next`），
 * 但**只在 `next` 真的带了一个非空 provider 时**才优先：picker 刚切完、新选择还没
 * 落到 `next` 上的那几帧 `next` 是 `{}` 或 `{ provider: "" }`，照「有 next 就用
 * next」读会得到 `undefined`，于是归属模型在「切换」这个动作本身上把胶囊藏起来。
 * 两侧都没有可用 provider 时返回 `undefined`——那才是真的判不出来。
 */
export function selectedProviderOf(projection: ModelSelectionLike | undefined): string | undefined {
  const source = projection ?? {};
  return providerOf(source.next) ?? providerOf(source.lastUsed);
}

/**
 * 余额读数；`null` 表示**不知道**（没读到 / 上游没给 / 字段不是有限数）。
 *
 * 特意不接受 `error` 参数做二次判断：错误文本只影响 tooltip 的措辞，不影响
 * 「数字可不可信」。把两者揉在一个判定里，会让「上次读到的 143 仍然有效」这种
 * 情形（`error` 非空但 `available` 有值）被误打成未知。
 */
export function availableOf(balance: BalanceData | null | undefined): number | null {
  const available = balance?.available;
  return typeof available === "number" && Number.isFinite(available) ? available : null;
}

/** 今日本地调用次数；`null` 同上，表示读不到（不是 0）。 */
export function usedTodayOf(snapshot: Snapshot | null | undefined): number | null {
  const used = snapshot?.quota?.daily?.usedLocal;
  return typeof used === "number" && Number.isFinite(used) ? used : null;
}

/**
 * 三档告警色。**没有 `warn` 档**是有意的：黄色在姊妹插件里表示「已用 ≥80%」，
 * 而魔粒余额没有官方上限，任何「低于 N 魔粒算黄」的阈值都是本插件凭空发明的，
 * 画上去就是让操作者按一个不存在的标准做决定。要么绿（余额是正数）、要么红
 * （官方给出的读数确实是 0）、要么灰（读不到）。
 */
export type Tier = "ok" | "exhausted" | "unknown";

/** 由余额读数定档；`null`（未读到）与 `0`（读到了、就是零）在此分道。 */
export function tierOf(available: number | null): Tier {
  if (available === null) return "unknown";
  return available > 0 ? "ok" : "exhausted";
}

/** 三档的圆点墨色（绿色 / 红色 / 灰色）。 */
const TIER_INK: Record<Tier, string> = {
  ok: S.pillTierOk,
  exhausted: S.pillTierExhausted,
  unknown: S.pillTierUnknown
};

/** 「余额」段的正文：读不到画「—」+ 单位，读到了画数字 + 单位。 */
export function balanceText(available: number | null, tt: Tt): string {
  const value = available === null ? "—" : count(available);
  return `${value} ${tt("composer.balanceUnit")}`;
}

/** 「今日本地」段的正文：读不到画「—」，读到了画次数。 */
export function callsText(usedToday: number | null, tt: Tt): string {
  return format(tt("composer.localCalls"), { calls: usedToday === null ? "—" : count(usedToday) });
}

/**
 * 胶囊正文：余额段 + 本地次数段，各带各的口径。两段都必须出现——只画有值的那
 * 一段会让「哪一段是空的」变成排版事故（读者分不清是没读到还是这一栏根本不在），
 * 而「—」明确说了是前者。
 */
export function readingText(available: number | null, usedToday: number | null, tt: Tt): string {
  return `${balanceText(available, tt)} · ${callsText(usedToday, tt)}`;
}

/**
 * 数字是否已经算「上次数据」。
 *
 * 两个触发条件各自独立：读失败（`error` 非空，上一轮的数值还留在屏幕上）本身就是
 * 陈旧；而长时间没有**成功**的读（`updatedAt` 不动）说明定时轮询没在按时回来
 * ——失败退避或页面被挂起都会这样。取 3 个声明周期而不是 1 个：一次偶发失败就会
 * 拉长间隔，卡在 1 个周期上会让每一次抖动都把读数打成陈旧的。
 *
 * **`hasReading` 是承重输入**：`updatedAt > 0` 只说明**曾经**读到过，不说明屏幕上
 * 此刻有数字——读失败时轮询 hook 会 `setData(null)` 却保留 `updatedAt`
 * （`use-snapshot-polling.ts`），只看 updatedAt 就会在两个读数都是「—」时挂上
 * 「上次数据」，描述一份不在屏幕上的数据（2026-10-19 锐评实测）。调用方必须把
 * 「本帧有没有读数」传进来。
 *
 * `hasReading === false` 表示**从没读到过 / 这一帧没有读数**，那不是「陈旧」而是
 * 「还没有」——调用方据此不标；本函数据此返回 false。
 */
export function staleOf(input: { error: unknown; hasReading: boolean; updatedAt: number; now: number; cadenceMs: number }): boolean {
  if (!input.hasReading) return false;
  if (input.error !== null && input.error !== undefined) return input.updatedAt > 0;
  return input.updatedAt > 0 && input.now - input.updatedAt > input.cadenceMs * STALE_CADENCES;
}

/**
 * tooltip 的一行：只把**读者下一步会问的**事实拼进来——数字是哪来的（前缀）、
 * 余额为什么没有（错误原文）、什么时候读的（fetchedAt）、本地计数为什么没有
 * （quota 那一路的提示）、以及数字是不是旧的。逐段 `filter` 掉空值，不留下
 * 「 ·  · 」这样的空槽。
 */
function titleOf(props: {
  tt: Tt;
  balance: BalanceData | null;
  usedToday: number | null;
  stale: boolean;
}): string {
  const { tt, balance, usedToday, stale } = props;
  const parts: Array<string | null> = [tt("composer.pillTitle")];
  const failure = balance?.error;
  parts.push(typeof failure === "string" && failure !== "" ? format(tt("balance.unavailable"), { error: failure }) : null);
  const fetchedAt = balance?.fetchedAt;
  parts.push(
    typeof fetchedAt === "string" && fetchedAt !== "" ? format(tt("balance.fetched"), { time: isoTime(fetchedAt) }) : null
  );
  parts.push(usedToday === null ? tt("quota.unavailable") : null);
  parts.push(stale ? tt("composer.stale") : null);
  return parts.filter((part): part is string => part !== null).join(" · ");
}

/**
 * 内层：只在会话选中本插件的模型时挂载。轮询 hook 在这里，被挂/摘即起停——
 * 非归属 provider 的会话不发任何请求。
 */
export function ModelscopePill(props: { tt: Tt }): unknown {
  const { tt } = props;
  const { data, error, loadedOnce, updatedAt } = useSnapshotPolling();

  const balance = data?.balance ?? null;
  const available = availableOf(balance);
  const usedToday = usedTodayOf(data);

  // cadence 跟 Host 声明走（`pollSeconds`），不跟常量走：Host 改声明周期，
  // 「多久算陈旧」必须跟着改，否则退避期里每一帧都误报陈旧。
  const cadenceMs = statedCadenceMs(data?.pollSeconds, DEFAULT_CADENCE_MS);
  const stale = staleOf({ error, hasReading: data !== null, updatedAt, now: Date.now(), cadenceMs });
  const pending = !loadedOnce && data === null;
  const tier = tierOf(available);

  const title = titleOf({ tt, balance, usedToday, stale });

  return h(
    "button",
    {
      type: "button",
      // 只作测试选择器与用户样式钩子；外观全在下面的 inline style 里。
      className: "dsh-modelscope-composer-pill",
      title,
      "aria-label": title,
      style: S.pillTrigger
    },
    h("span", {
      className: "dsh-modelscope-composer-pill-dot",
      "aria-hidden": "true",
      style: { ...S.pillDot, background: TIER_INK[tier] }
    }),
    // 前缀说明「下面这些数字属于哪套额度」——会话里可以同时有别的 provider 的
    // 模型，不写清楚读者无法判断 143 是谁的余额。
    h("span", { className: "dsh-modelscope-composer-pill-plan", style: S.pillPlan }, `${tt("composer.prefix")} · `),
    h(
      "span",
      {
        className: "dsh-modelscope-composer-pill-text",
        // 只有「官方读数是 0」才把正文染成告警色。健康读数保持宿主自己的字色，
        // 胶囊才安静——否则一个正常数字会和模型选择器本身的字样一样吵。
        style: tier === "exhausted" ? S.pillTierExhaustedText : undefined
      },
      pending ? "…" : readingText(available, usedToday, tt)
    ),
    stale
      ? h("span", { className: "dsh-modelscope-composer-pill-stale", style: S.pillStale }, ` · ${tt("composer.stale")}`)
      : null
  );
}

/**
 * 外层门控：固定一处调 `useProjection`，再决定内层挂谁。非归属 provider 返回
 * `null`（不渲染任何东西，也不跑任何请求）。
 */
export function ComposerUsagePill(props: ComposerPillProps): unknown {
  const selection = props.useProjection?.("modelSelection");
  if (selectedProviderOf(selection) !== MODELSCOPE_PROVIDER) return null;
  return h(ModelscopePill, { tt: props.tt });
}
