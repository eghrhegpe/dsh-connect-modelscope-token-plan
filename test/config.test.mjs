// 配置契约测试：CONFIG_DEFAULTS ↔ cordis.patch.yml 双向钉住（与姊妹插件
// config.test.mjs 同纪律）。浏览器 bundle 与 patch 行无法 import 本模块，
// 字面量漂移必须在这里变红，而不是在运行时变成「配置改了没生效」。
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { CONFIG_DEFAULTS, PLUGIN_VERSION, name, resolveSettings, clampInt, hostName, isAdmitted } from "../src/host/host-config.ts";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

// §1 身份一致性：slug / 版本 / manifest。
assert.equal(name, pkg.name, "host-config.name 与 package.json#name 必须一致");
assert.equal(PLUGIN_VERSION, pkg.version, "PLUGIN_VERSION 与 package.json#version 必须一致（改版本号两处同步）");

// §2 patch 行的 id/name 与 slug 一致。
const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
assert.ok(patch.includes(`- id: ${name}`), "cordis.patch.yml 的 - id: 必须等于 slug");
assert.ok(patch.includes(`name: ${name}`), "cordis.patch.yml 的 name: 必须等于 slug");

// §3 patch 行里的配置项与 CONFIG_DEFAULTS 一致（字段在两边都出现时才可比）。
// 不含 dailyQuotaTotal / dailyQuotaPerModel：官方改魔粒计费后次数口径的推算已
// 从面板删除，两个社区快照常数随之删掉（见 cordis.patch.yml 与 host-config.ts
// 文件头）。这里显式钉住「它们不回来」，否则删掉容易、加回来无声。
for (const key of ["dailyQuotaTotal", "dailyQuotaPerModel"]) {
  assert.equal(key in CONFIG_DEFAULTS, false, `${key} 已删除，不该回到 CONFIG_DEFAULTS`);
  // 只看**配置项行**（`key:` 顶格），不看注释——注释里可以解释这两个名字为何消失。
  assert.ok(
    !new RegExp(String.raw`^\s*${key}\s*:`, "m").test(patch),
    `cordis.patch.yml 不该再有 ${key} 配置项（面板不消费它）`
  );
}
for (const key of ["trendDays", "cacheSeconds", "pollSeconds", "inferenceTimeoutMs", "maxEvents", "apiBase", "siteBase"]) {
  const patchValue = patch.match(new RegExp(String(key) + String.raw`:\s*([^#\n]+)`));
  assert.ok(patchValue, `cordis.patch.yml 缺少 ${key}（配置面与默认值必须同场）`);
  const literal = String(patchValue[1]).trim().replace(/^["']|["']$/g, "");
  assert.equal(literal, String(CONFIG_DEFAULTS[key]), `${key} 在 patch 与 CONFIG_DEFAULTS 之间漂移`);
}

// §4 clampInt：floor → 下限 → 上限；非正/非有限回退默认。
assert.equal(clampInt("x", 5, 1), 5);
assert.equal(clampInt(0, 5, 1), 5);
assert.equal(clampInt(-3, 5, 1), 5);
assert.equal(clampInt(2.9, 5, 1), 2);
assert.equal(clampInt(99, 5, 1, 30), 30);

// §5 resolveSettings：正常路径与兜底路径同构。
const good = resolveSettings({ pollSeconds: 7, trendDays: 21 });
assert.equal(good.configError, null);
assert.equal(good.settings.pollSeconds, 7);
assert.equal(good.settings.trendDays, 21);
assert.ok(good.settings.allowedHosts.has("localhost"));
const bad = resolveSettings({ trendDays: -5 });
assert.equal(bad.settings.trendDays, CONFIG_DEFAULTS.trendDays, "非法值回退默认");
assert.equal(bad.settings.registerProvider, false, "registerProvider 是严格布尔");

// §5b 喂给定时器与超时的三个值必须有上界。
//
// 回归用例：这三个字段曾只传 min 不传 max（clampInt 的 max 默认 Infinity）。
// pollSeconds × 1000 超过 2^31-1 ms 时 Node 把 setInterval 延时**钳到 1ms**
// （TimeoutOverflowWarning）——插件变成每毫秒打一次魔搭目录，顺手把单飞缓存
// 也打穿（缓存 TTL 60s，而请求每 1ms 一次）。inferenceTimeoutMs 同理会让每次
// 上游请求立刻超时。实测 pollSeconds=3000000 → _idleTimeout=1。
assert.equal(resolveSettings({ pollSeconds: 3_000_000 }).settings.pollSeconds, 3_600, "pollSeconds 超上界 → 拉回 1 小时");
assert.equal(resolveSettings({ pollSeconds: Number.MAX_SAFE_INTEGER }).settings.pollSeconds, 3_600, "pollSeconds 极大值同样被夹");
assert.equal(resolveSettings({ inferenceTimeoutMs: 3_000_000_000 }).settings.inferenceTimeoutMs, 600_000, "超时的上界");
assert.equal(resolveSettings({ cacheSeconds: 999_999 }).settings.cacheSeconds, 600, "缓存秒数的上界");
// 上界之内不该被改动（别把合法配置也夹掉）。
assert.equal(resolveSettings({ pollSeconds: 3_600 }).settings.pollSeconds, 3_600, "上界本身是合法的");
assert.equal(resolveSettings({ pollSeconds: 5 }).settings.pollSeconds, 5, "下界之上不改动");

// §6 allowedHosts 只增不替。
const widened = resolveSettings({ allowedHosts: ["MyHost.Example"] });
assert.ok(widened.settings.allowedHosts.has("myhost.example"), "追加的 host 名转小写收进集合");
assert.ok(widened.settings.allowedHosts.has("localhost"), "默认集不被替换");

// §7 hostName：IPv6/端口剥离的边界。
assert.equal(hostName("localhost:3080"), "localhost");
assert.equal(hostName("[::1]:19387"), "[::1]");
assert.equal(hostName("::1"), "::1");
assert.equal(hostName("::1:3080"), "::1");
assert.equal(hostName("fe80::1"), "fe80::1");

// §7b 围栏必须是**精确**匹配，不是前缀匹配。
//
// 回归用例：`[::1]evil.com` 曾读成 `[::1]` 并通过白名单——截断到第一个 `]` 就
// 返回，把「集合成员」放宽成了「以成员开头」。白名单的意义正在于精确。
for (const bad of ["[::1]evil.com", "[::1]:8080@evil.com", "[::1]evil.com:3080", "[::1", "::1]evil", "[]", "[::1]:"]) {
  assert.equal(isAdmitted({ headers: { host: bad } }, new Set(["[::1]", "::1"])), false, `Host "${bad}" 必须被拒绝（围栏不允许前缀匹配）`);
}
// 合法的 IPv6 形状仍要放行，别把围栏收得太紧误伤真浏览器。
for (const good of ["[::1]", "[::1]:3080", "[2001:db8::1]:443"]) {
  const parsed = hostName(good);
  assert.notEqual(parsed, "", `Host "${good}" 应被解析成合法形状`);
}

// §8 isAdmitted：Host 对白名单；Origin 与 Host 一致；无 Origin 放行。
const allowed = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
assert.equal(isAdmitted({ headers: { host: "localhost:3080" } }, allowed), true, "同源无 Origin 放行");
assert.equal(isAdmitted({ headers: { host: "localhost:3080", origin: "http://localhost:3080" } }, allowed), true);
assert.equal(isAdmitted({ headers: { host: "localhost:3080", origin: "http://evil.example" } }, allowed), false, "跨站 Origin 拒绝");
assert.equal(isAdmitted({ headers: { host: "evil.example" } }, allowed), false, "白名单外的 Host 拒绝");
assert.equal(isAdmitted({ headers: { host: "localhost:3080", origin: "null" } }, allowed), false, "Origin: null（沙箱页）拒绝");
assert.equal(isAdmitted({ headers: {} }, allowed), false, "无 Host 头拒绝");

console.log("config.test.mjs: all checks passed");
