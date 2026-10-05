// switch-precedence 离线套件：面板值 vs 配置默认 的唯一裁决方言，peer-free。
// 注释里被引用（test/peer-contract.test.mjs 是真 peer 在位时才跑的契约钉，
// 本仓库未 vendored 那份 peer，所以这里只钉本模块的纯函数行为）。
import { strict as assert } from "node:assert";
import { resolveSwitchEnabled, resolveSwitchValue, switchSource } from "../src/host/switch-precedence.ts";

// 布尔开关：面板保存值永远赢，否则落配置默认（§9 / §11 的 panel??config）。
{
  assert.equal(resolveSwitchEnabled(null, false), false, "未保存 + 默认关 → 关");
  assert.equal(resolveSwitchEnabled(null, true), true, "未保存 + 默认开 → 开");
  assert.equal(resolveSwitchEnabled(true, false), true, "面板开优先于默认关");
  assert.equal(resolveSwitchEnabled(false, true), false, "面板关优先于默认开");
  assert.equal(resolveSwitchEnabled(true, true), true);
  assert.equal(resolveSwitchEnabled(false, false), false);
}

// 字符串偏好：同样的 panel??config 方言（本插件用于 draw 模型等）。
{
  assert.equal(resolveSwitchValue(null, "cfg-model"), "cfg-model", "未保存 → 配置默认");
  assert.equal(resolveSwitchValue("panel-model", "cfg-model"), "panel-model", "面板值优先");
  assert.equal(resolveSwitchValue(null, undefined), undefined, "无默认 → 仍 undefined");
}

// source 标签始终随答案一起回传，让面板说出哪一侧在掌权。
{
  assert.equal(switchSource(null), "config", "未保存（null）→ config 来源");
  assert.equal(switchSource(true), "panel", "面板值 → panel 来源");
  assert.equal(switchSource("x"), "panel", "面板字符串值 → panel 来源");
  // 仅 `null` 视为未保存；`undefined` 按实现归为 panel（保留既有口径，本模块不在本次修）。
  assert.equal(switchSource(undefined), "panel", "undefined 按既有口径归 panel");
}

// 卫语：所有调用都是同步纯函数，不触网、不读文件，离线 checkout 直接跑。
console.log("switch-precedence.test.mjs: all checks passed");
