/**
 * provider 允许清单的**三态判别联合**——`enabledIds` 线编码的唯一解释者。
 *
 * 线格式（`shared/wire.ts` 的 `ProviderStatus.enabledIds`）是一个字符串数组，
 * 用哨兵编码三态：
 *
 *   - `[]`                       → `all`（不过滤，提供全部模型）；
 *   - `[HIDE_ALL_MODELS, ...]`   → `none`（什么都不提供；哨兵语义优先）；
 *   - `[id, ...]`                → `list`（严格白名单）。
 *
 * 这个编码曾经在六个地方被各自解释一遍（`resolveAllowedList` / `filterByEnabled` /
 * `isModelEnabled` / 快照的 `enabledCount` / 路由的 `enabledCount` / 客户端
 * `saveRoster` 归一），而且解释得不完全一致——`filterByEnabled` 会把
 * `[哨兵, "a/A"]` 过滤成「提供 a/A」，而 `resolveAllowedList` 同时说那是
 * `none`：同一个清单，「提供什么」有两个答案。联合把六种解释塌缩成一次
 * `parseAllowedList`，其余操作都是联合上的模式匹配——新增第四态或改哨兵
 * 语义时， TypeScript 会把每个没跟上的 `switch` 标红。
 *
 * 纯函数、零依赖（只读 `wire.ts` 的哨兵字面量），双端同 import。
 *
 * @module dsh-connect-modelscope-token-plan/allow-list
 */

import { HIDE_ALL_MODELS } from "./wire.ts";

/** 允许清单的三种模态。`ids` 已归一（去重、去空、保序）。 */
export type AllowedList =
  | { readonly mode: "all" }
  | { readonly mode: "none" }
  | { readonly mode: "list"; readonly ids: readonly string[] };

/**
 * 把线编码的 `enabledIds` 解析成联合——**全插件只有这一处解释**。
 *
 * 判据（与旧 `resolveAllowedList` 的承诺一致，且现在 `filterByEnabled` 等
 * 消费者也真的按它做）：
 *   1. 非数组或空数组            → `all`（新装没做过选择，仍提供全部）；
 *   2. 含哨兵（哪怕还混着别的 id）→ `none`（哨兵是独占态，优先于任何真实 id）；
 *   3. 其余非空清单              → `list`（严格白名单；条目滤掉非字符串与空串、
 *      去重保序——落盘前 `provider-store` 已归一遍，这里是解释不是归一）。
 *
 * 注意 `[""]` 这类「滤完什么都不剩」的脏清单归 `list` 且 `ids: []`：过滤
 * 结果为空，与旧行为一致（它匹配不到任何真实 id）。
 * @param {unknown} enabledIds - 线编码的允许清单。
 * @returns {AllowedList} 联合。
 */
export function parseAllowedList(enabledIds: unknown): AllowedList {
  if (!Array.isArray(enabledIds) || enabledIds.length === 0) return { mode: "all" };
  if (enabledIds.includes(HIDE_ALL_MODELS)) return { mode: "none" };
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of enabledIds) {
    const id = typeof entry === "string" ? entry : "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { mode: "list", ids };
}

/**
 * 某个模型 id 在这个联合下会不会被提供。
 * @param {AllowedList} list - 联合。
 * @param {string} id - 模型 id（调用方负责 `str()` 归一）。
 * @returns {boolean}
 */
export function isIdAllowed(list: AllowedList, id: string): boolean {
  switch (list.mode) {
    case "all":
      return true;
    case "none":
      return false;
    case "list":
      return list.ids.includes(id);
  }
}

/**
 * 「已启用数」：roster 里真正会被提供的行数。
 *
 * 快照与 provider 路由的 `enabledCount` 共用这一份（旧实现各写一遍三元
 * 链，且 `none` 分支的 0 与 `all` 分支的 roster 长度靠注释对齐）。过期 id
 * 不虚增计数——roster 里没有它，就数不到它。
 * @param {AllowedList} list - 联合。
 * @param {readonly string[]} rosterIds - roster 各行的 id（目录序）。
 * @returns {number}
 */
export function enabledCountOf(list: AllowedList, rosterIds: readonly string[]): number {
  switch (list.mode) {
    case "all":
      return rosterIds.length;
    case "none":
      return 0;
    case "list": {
      const allow = new Set(list.ids);
      let count = 0;
      for (const id of rosterIds) {
        if (allow.has(id)) count += 1;
      }
      return count;
    }
  }
}

/**
 * 面板草稿 → 落盘清单的归一：哨兵独占态。
 *
 * 草稿含哨兵（「全部隐藏」）时落盘值只保留哨兵——不能让它与真实 id 混排：
 * Host 把混排判 `none`，而面板会把混排里的真实 id 画成勾中，「已启用 N」
 * 与实际提供 0 个撒谎（踩过，见 cards.ts 的注释）。其余情况剥掉哨兵、
 * 滤掉空串后原样落盘。
 * @param {readonly unknown[]} draft - 面板勾选的草稿。
 * @returns {string[]} 落盘的 `enabledIds`。
 */
export function normalizeRosterSave(draft: readonly unknown[]): string[] {
  return rosterSaveOf(parseAllowedList(draft));
}

/**
 * 联合 → 落盘清单（{@link parseAllowedList} 的逆运算）：`none` 序列化成
 * 哨兵清单，`all` 序列化成空清单（「不过滤」的拼写），`list` 原样带出 id。
 * @param {AllowedList} list - 联合。
 * @returns {string[]} 线编码的 `enabledIds`。
 */
export function rosterSaveOf(list: AllowedList): string[] {
  switch (list.mode) {
    case "all":
      return [];
    case "none":
      return [HIDE_ALL_MODELS];
    case "list":
      return [...list.ids];
  }
}

/** 「全部隐藏」的落盘清单（{@link rosterSaveOf} 的 `none` 特例；每次新数组）。 */
export function hideAllRoster(): string[] {
  return rosterSaveOf({ mode: "none" });
}
