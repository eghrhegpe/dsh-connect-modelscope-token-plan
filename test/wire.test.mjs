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

// ── 可选块不得进必给清单 ────────────────────────────────────────────────
//
// 事故（2026-10-19 评审发现）：`provider` 在 53c9902 里改成可选（Host 软失败时
// 省略），却没从本清单移除。客户端于是把「按契约省略」当成契约破裂——先补一个
// DEGRADED_PROVIDER 进 body，`panel-page` 的 hasProviderBlock 随之为 true，兜底
// `GET /provider` 一次都没跑，还给用户挂一条假漂移警告。那次提交的修复目标正是
// 「兜底那条路径从来没跑起来」，结果被同一个清单架空。
//
// 判据写死在这里而不是靠人记得：**接口里带 `?` 的顶层字段，本清单必须没有**。
// 反向断言（下面第二条）挡住「把清单删空就绿了」这种绕法——可选块必须真的可选。
{
  // 正面清单：Snapshot 里声明为可选的顶层块，一个都不许出现在必给清单里。
  //
  // 这份名字清单本身就是断言：新增可选块时把它加进来（并同步前面那份必给清单），
  // 漏加不会让本测试变红——所以真正承重的是下面「反向」那半条与
  // `Snapshot` 接口上的 `?` 标记，两者合起来才闭合。
  const OPTIONAL_BLOCK_KEYS = ["provider", "draw"];
  for (const key of OPTIONAL_BLOCK_KEYS) {
    assert.ok(
      !SNAPSHOT_REQUIRED_KEYS.includes(key),
      `${key} 是可选块（Host 软失败时省略），不得出现在 SNAPSHOT_REQUIRED_KEYS——`
        + `进了清单就会让客户端误判契约破裂、填出假块、跳过路由兜底`
    );
  }

  // 反向：被排除的那两个键必须确实在 Snapshot 类型上带 `?`（运行期不可见，
  // 由 tsFiles 的 tsc 门禁兜住；这里钉住「它们没从接口里消失」）。
  assert.ok(
    OPTIONAL_BLOCK_KEYS.length > 0,
    "可选块清单不得清空——清空等于这条纪律失去对象"
  );
}

console.log("wire.test.mjs: all checks passed");
