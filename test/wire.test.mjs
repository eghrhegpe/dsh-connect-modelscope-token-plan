// 契约冻结测试：SNAPSHOT_REQUIRED_KEYS 与 Snapshot 形状互相钉死。
// Host 的 snapshot-aggregate 与 Client 的 wire 消费同一份 src/shared/wire.ts；
// 这里冻的是「顶层键集合 + 关键语义常量」，字段语义漂移时先改这里。
import { strict as assert } from "node:assert";
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

console.log("wire.test.mjs: all checks passed");
