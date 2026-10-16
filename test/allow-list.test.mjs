// shared/allow-list.ts 判别联合的语义钉：三态解析、哨兵独占、计数、序列化。
//
// ## 为什么这个文件存在
//
// `enabledIds` 的线编码（`[]` = 全部 / `[哨兵]` = 全不 / `[ids]` = 白名单）
// 曾经在六个地方被各自解释，而且解释得不完全一致：`resolveAllowedList` 与
// `isModelEnabled` 判「含哨兵即 none」，`filterByEnabled` 却会把
// `[哨兵, "a/A"]` 过滤成「提供 a/A」——同一个清单，「提供什么」有两个答案，
// 面板计数与真实 offer 会撒谎。联合把解释收敛成一次 parseAllowedList，本
// 套件钉住收敛后的每一态，尤其是混排这个曾经的漂移点。

import { strict as assert } from "node:assert";
import {
  parseAllowedList,
  isIdAllowed,
  enabledCountOf,
  normalizeRosterSave,
  rosterSaveOf,
  hideAllRoster
} from "../src/shared/allow-list.ts";
import { HIDE_ALL_MODELS } from "../src/shared/wire.ts";

// §1 三态解析：空/缺省 → all；含哨兵 → none；其余 → list。
assert.deepEqual(parseAllowedList([]), { mode: "all" }, "空清单 = 不过滤");
assert.deepEqual(parseAllowedList(undefined), { mode: "all" }, "缺省同空清单");
assert.deepEqual(parseAllowedList("not-an-array"), { mode: "all" }, "非数组按空清单");
assert.deepEqual(parseAllowedList([HIDE_ALL_MODELS]), { mode: "none" }, "哨兵 = 什么都不提供");
assert.deepEqual(parseAllowedList(["a/A", "b/B"]), { mode: "list", ids: ["a/A", "b/B"] }, "白名单严格");

// §2 混排：哨兵语义优先——这一条是修复点。旧 filterByEnabled 会把
// `[哨兵, "a/A"]` 过滤成「提供 a/A」，与 resolveAllowedList 的 none 判断矛盾。
{
  const mixed = parseAllowedList([HIDE_ALL_MODELS, "a/A"]);
  assert.equal(mixed.mode, "none", "含哨兵即 none，哪怕还混着真实 id");
  assert.equal(isIdAllowed(mixed, "a/A"), false, "混排里的真实 id 也不提供（旧实现的漏洞）");
  assert.equal(enabledCountOf(mixed, ["a/A", "b/B"]), 0, "混排计数为 0");
}

// §3 脏清单归 list 且滤空：`[""]` 匹配不到任何真实 id（与旧行为一致），
// 不塌缩成 all——「读不懂」不能静默扩成「全部提供」。
{
  const dirty = parseAllowedList(["", "a/A", "a/A", 42]);
  assert.equal(dirty.mode, "list");
  assert.deepEqual(dirty.mode === "list" ? dirty.ids : null, ["a/A"], "空串/非字符串/重复被滤掉");
}

// §4 isIdAllowed 三态。
assert.equal(isIdAllowed(parseAllowedList([]), "anything"), true, "all 提供一切");
assert.equal(isIdAllowed(parseAllowedList([HIDE_ALL_MODELS]), "anything"), false, "none 什么都不提供");
assert.equal(isIdAllowed(parseAllowedList(["a/A"]), "a/A"), true, "list 命中");
assert.equal(isIdAllowed(parseAllowedList(["a/A"]), "b/B"), false, "list 未命中");

// §5 enabledCountOf：过期 id 不虚增（roster 里没有它就数不到它）。
const rosterIds = ["a/A", "b/B", "c/C"];
assert.equal(enabledCountOf(parseAllowedList([]), rosterIds), 3, "all = roster 全部");
assert.equal(enabledCountOf(parseAllowedList([HIDE_ALL_MODELS]), rosterIds), 0, "none = 0");
assert.equal(enabledCountOf(parseAllowedList(["a/A", "过期/id"]), rosterIds), 1, "list 只数 roster 里命中的");

// §6 序列化（parse 的逆运算）与面板保存归一：哨兵独占。
assert.deepEqual(rosterSaveOf({ mode: "all" }), [], "all 序列化成空清单（「不过滤」的拼写）");
assert.deepEqual(rosterSaveOf({ mode: "none" }), [HIDE_ALL_MODELS], "none 序列化成哨兵清单");
assert.deepEqual(rosterSaveOf({ mode: "list", ids: ["a/A"] }), ["a/A"], "list 原样带出");
assert.deepEqual(hideAllRoster(), [HIDE_ALL_MODELS], "hideAllRoster = none 的序列化");
assert.deepEqual(normalizeRosterSave([]), [], "草稿空 → 落盘空（全部提供）");
assert.deepEqual(normalizeRosterSave(["a/A"]), ["a/A"], "草稿白名单原样");
assert.deepEqual(normalizeRosterSave([HIDE_ALL_MODELS]), [HIDE_ALL_MODELS], "草稿哨兵 → 哨兵");
assert.deepEqual(normalizeRosterSave([HIDE_ALL_MODELS, "a/A"]), [HIDE_ALL_MODELS],
  "草稿混排 → 只留哨兵（面板不把混排里的真实 id 画成勾中）");
assert.deepEqual(normalizeRosterSave(["", "a/A"]), ["a/A"], "草稿空串被滤掉");

// §7 roundtrip：parse(serialize(x)) === x（三个模态都不丢）。
const roundtripCases = [
  { mode: "all" },
  { mode: "none" },
  { mode: "list", ids: ["a/A", "b/B"] }
];
for (const list of roundtripCases) {
  assert.deepEqual(parseAllowedList(rosterSaveOf(list)), list, `roundtrip 失败：${JSON.stringify(list)}`);
}

console.log("allow-list.test.mjs: all checks passed");
