// 契约冻结测试：SNAPSHOT_REQUIRED_KEYS 与 Snapshot 形状互相钉死。
// Host 的 snapshot-aggregate 与 Client 的 wire 消费同一份 src/shared/wire.ts；
// 这里冻的是「顶层键集合 + 关键语义常量」，字段语义漂移时先改这里。
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { SNAPSHOT_REQUIRED_KEYS, SNAPSHOT_VERSION, PLUGIN_ID } from "../src/shared/wire.ts";

assert.equal(SNAPSHOT_VERSION, 1, "SNAPSHOT_VERSION 变更 = 双端契约破裂，需两侧同步升版");
assert.equal(PLUGIN_ID, "dsh-connect-modelscope-token-plan");

assert.ok(Object.isFrozen(SNAPSHOT_REQUIRED_KEYS), "SNAPSHOT_REQUIRED_KEYS 必须冻结");
assert.deepEqual(
  [...SNAPSHOT_REQUIRED_KEYS],
  [
    "ok",
    "name",
    "version",
    "now",
    "pollSeconds",
    "cacheSeconds",
    "token",
    "balance",
    "quota",
    "events",
    "trend",
    "models",
    "shapeWarnings",
    "quotaError",
  ],
  "顶层键集合变更 = 双端契约破裂，需两侧同步",
);

// quota.countingNote 是闭集（面板据它渲染「本地推算」说明）。
assert.equal(
  SNAPSHOT_REQUIRED_KEYS.length,
  14,
  "顶层键数量变化时，同步更新 Snapshot 接口与本清单",
);

// ── 可选块不得进必给清单 ────────────────────────────────────────────────
//
// 事故：`provider` 在 53c9902 里改成可选（Host 软失败时省略）却没从本清单移除，
// 客户端把「按契约省略」当成契约破裂——补假块、兜底路由一次都没跑、还挂假漂移
// 警告。完整经过见 docs/archive/2026-10-17-0.4.0-process.md:111。
//
// 判据写死在这里而不是靠人记得：**接口里带 `?` 的顶层字段，本清单必须没有**。
// 判据本身由下面「机械解析 Snapshot 接口」的三向交叉钉住（清单腐化、可选块漏登记
// 都会判红），不再依赖人读接口守。
const OPTIONAL_BLOCK_KEYS = ["provider", "draw"];
{
  // 正面清单：Snapshot 里声明为可选的顶层块，一个都不许出现在必给清单里。
  for (const key of OPTIONAL_BLOCK_KEYS) {
    assert.ok(
      !SNAPSHOT_REQUIRED_KEYS.includes(key),
      `${key} 是可选块（Host 软失败时省略），不得出现在 SNAPSHOT_REQUIRED_KEYS——`
        + `进了清单就会让客户端误判契约破裂、填出假块、跳过路由兜底`
    );
  }

  assert.ok(
    OPTIONAL_BLOCK_KEYS.length > 0,
    "可选块清单不得清空——清空等于这条纪律失去对象"
  );
}

// ── 机械解析 Snapshot 接口（三向交叉）──────────────────────────────────────
//
// 「带 `?` 的顶层字段不许进清单」若只靠人读接口守，就是本仓评审指出的最高频
// 缺陷类（注释当契约写、没有机制保护）。这里直接解析 wire.ts 源码，机械钉死：
//   ① 接口必给顶层字段集合 === SNAPSHOT_REQUIRED_KEYS（双向，堵清单腐化与漏登记）；
//   ② 接口可选字段 ∩ 清单 = ∅（53c9902 事故类：可选块混进必给清单）；
//   ③ 接口可选字段集合 === OPTIONAL_BLOCK_KEYS（新增可选块时两条清单都要加）。
// 解析约定：顶层属性恰好 2 空格缩进，嵌套 4+ 空格；先去块注释再花括号配平。
// 约定变了（比如接口体折行成 4 空格）先修解析再改断言。
{
  const src = readFileSync(new URL("../src/shared/wire.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const marker = "export interface Snapshot {";
  const start = code.indexOf(marker);
  assert.ok(start >= 0, "wire.ts 里找不到 export interface Snapshot {");
  let depth = 0;
  let end = -1;
  for (let i = code.indexOf("{", start); i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > start, "Snapshot 接口花括号没有配平");
  const body = code.slice(start, end + 1);
  const optional = [...body.matchAll(/^  ([A-Za-z_$][\w$]*)\?:/gm)].map((m) => m[1]);
  const top = [...body.matchAll(/^  ([A-Za-z_$][\w$]*)(\?)?:/gm)].map((m) => m[1]);
  const required = top.filter((k) => !optional.includes(k));
  assert.ok(
    required.length + optional.length >= 14,
    `机械解析 Snapshot 顶层字段只得到 ${required.length + optional.length} 个（至少应 14）——`
      + "解析约定（2 空格缩进）可能已变，先看解析再改断言",
  );

  // ① 必给集合 === 清单（双向）
  assert.deepEqual(
    [...required].sort(),
    [...SNAPSHOT_REQUIRED_KEYS].sort(),
    "Snapshot 接口的必给顶层字段与 SNAPSHOT_REQUIRED_KEYS 不一致——"
      + "顶层字段改名或 `?` 增删必须同步清单",
  );
  // ② 可选字段一个都不许在清单里
  for (const key of optional) {
    assert.ok(
      !SNAPSHOT_REQUIRED_KEYS.includes(key),
      `${key} 在接口上是可选（带 ?），却出现在 SNAPSHOT_REQUIRED_KEYS——53c9902 事故类：`
        + "客户端会把「Host 按契约省略」误判成契约破裂、填出假块、跳过路由兜底",
    );
  }
  // ③ 可选集合 === 命名清单
  assert.deepEqual(
    [...optional].sort(),
    [...OPTIONAL_BLOCK_KEYS].sort(),
    "可选块名字清单与接口实际可选字段不一致——新增可选块时两条清单都要加",
  );
}

console.log("wire.test.mjs: all checks passed");
