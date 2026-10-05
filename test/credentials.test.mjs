// 凭据红线门禁（家规 AGENTS.md 红线 1：凭据永不进日志、永不进面板响应）。
//
// ## 为什么这些用例长这样
//
// 它们守的不是「函数行为」，是**一条不许被悄悄放宽的闸**。三条都对应一次
// 已修的真实缺陷：
//
//   1. `redactSecrets` 的 `ms-` 正则硬编码了 UUID 的 `8-4-4-4-12` 分组形状，
//      于是紧凑写法 `ms-3f2a1b8c1111222233334444555566` 整条漏网——而脱敏闸是
//      正则，遮不住它不认识的形状。改入口（`isPlausibleToken`）是这个问题的
//      另一半：不让非法形状的令牌存得进来。
//   2. `forget()` 曾吞掉凭据服务的 unset 失败，让路由回 `ok: true`，而令牌**仍在
//      凭据文件里并且仍被读回来**。「忘掉令牌」是安全动作，谎报成功比失败更糟。
//   3. `state().ephemeral` 曾答「有没有凭据服务」，而 wire 定义是「这个值重启
//      会不会丢」——env 来源的值重启不丢却被标成 ephemeral。

import { strict as assert } from "node:assert";
import { redactSecrets } from "../src/host/util.ts";
import { createTokenStore, isPlausibleToken, TOKEN_REF } from "../src/host/ms-auth.ts";

// ── §1 脱敏闸：形状无关性 ──
//
// 判据是**输出里不含原值**，而不是「有没有被替换成特定文案」——后者会因为改文案
// 而误报。
//
// 注意每条模板都**必须带 `ms-` 标识符**：脱敏闸是形状闸，不是万能的密钥嗅探器，
// 一段没有前缀的裸十六进制在世界上无法与任何哈希区分（那正是它不被遮的原因）。
// 真实泄漏路径全都是「`ms-` 值被上游回显」，所以用例也照那个形状写。
const SECRETS = [
  "ms-3f2a1b8c1111222233334444555566",           // 紧凑，32 位无连字符（曾漏网）
  "ms-3f2a1b8c-1111-2222-3333-444455556666",     // 标准 UUID
  "ms-abcdef0123456789abcdef01",                  // 短但合法的十六进制
  "ms-deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef0"
];
for (const secret of SECRETS) {
  for (const template of [
    (s) => `upstream said ${s} for you`,
    (s) => `{"token":"${s}"}`,
    (s) => `prefix ${s} suffix`,
    (s) => `Authorization: Bearer ${s}`
  ]) {
    const out = redactSecrets(template(secret));
    assert.equal(
      out.includes(secret),
      false,
      `令牌 ${secret.slice(0, 14)}… 泄漏了：${JSON.stringify(out)}`
    );
  }
}

// §1b 其它形状的凭据仍在闸内（别为了修ms- 把别的弄丢了）。
assert.equal(redactSecrets("sk-abcdefgh12345678").includes("abcdefgh12345678"), false, "sk- 键");
assert.equal(redactSecrets('{"api_key":"zzz-secret-value"}').includes("zzz-secret-value"), false, "api_key 键值对");
assert.equal(redactSecrets("password=hunter2xyz").includes("hunter2xyz"), false, "password= 对");
assert.equal(redactSecrets("Authorization: Bearer abcdefgh1234").includes("abcdefgh1234"), false, "Bearer 头");
assert.equal(redactSecrets("Authorization: zzz-custom-value").includes("zzz-custom-value"), false, "Authorization 非 Bearer");

// §1c 非字符串输入不炸。
assert.equal(redactSecrets(undefined), "");
assert.equal(redactSecrets(42), "");

// ── §2 入口收紧：形状校验 ──
assert.equal(isPlausibleToken("ms-3f2a1b8c-1111-2222-3333-444455556666"), true, "标准 UUID 接受");
assert.equal(isPlausibleToken("ms-3f2a1b8c1111222233334444555566"), true, "紧凑写法接受");
for (const bad of ["", "   ", "short-abc", "ms-short-abc", "ms-", "ms-123", "not-a-token", "sk-abcdefgh12345678"]) {
  assert.equal(isPlausibleToken(bad), false, `非法形状必须被拒：${JSON.stringify(bad)}`);
}

// §2b 入口与脱敏闸必须**同宽**——这是本文件最要紧的一条不变量。
//
// 两道闸各管一头：入口拒「遮不住的」，脱敏闸遮「认得出的」。宽度一旦不一致就出
// 两种缝：入口比脱敏闸宽 → 值存得进来却遮不住（凭据外泄）；入口比脱敏闸窄 →
// 合法令牌被无谓拒掉。曾经的 `{8,64}+分段` 与现在的 `{16,}` 就出过第一种缝，
// 所以这里逐档比对，不靠注释维持。
for (let hexLen = 12; hexLen <= 80; hexLen += 4) {
  const value = `ms-${"a".repeat(hexLen)}`;
  const accepted = isPlausibleToken(value);
  const redacted = !redactSecrets(`upstream said ${value}`).includes(value);
  assert.equal(
    accepted,
    redacted,
    `宽度不一致：${hexLen} 位hex——入口${accepted ? "接受" : "拒绝"}，脱敏闸${redacted ? "遮住" : "没遮"}`
  );
}

// ── §3 save 拒绝非法形状（不再让遮不住的值进得来）──
{
  const store = createTokenStore({ credentials: null, env: {} });
  await assert.rejects(() => store.save("ms-short-abc"), /does not look like/, "非法形状被 save 拒绝");
  await assert.rejects(() => store.save("   "), /required/i, "空白被拒");
  await assert.rejects(() => store.save(""), /required/i, "空串被拒");
  await store.save("ms-3f2a1b8c1111222233334444555566");   // 合法 → 不抛
  const state = await store.state();
  assert.equal(state.present, true, "合法令牌已存下");
}

// ── §4 forget 的失败必须传播（安全动作不许谎报）──
{
  let unsetCalls = 0;
  const failing = {
    resolve: async () => ({ value: "ms-3f2a1b8c1111222233334444555566" }),
    set: async () => {},
    unset: async () => {
      unsetCalls += 1;
      throw new Error("EACCES: credentials file is read-only");
    }
  };
  const store = createTokenStore({ credentials: () => failing, env: {} });
  await store.save("ms-3f2a1b8c1111222233334444555566");
  // unset 抛错 → forget 必须reject，不许吞。
  await assert.rejects(
    () => store.forget(),
    /read-only/,
    "凭据服务 unset 失败时 forget 必须报错（曾被吞掉，路由回 ok:true 而令牌仍在文件里）"
  );
  assert.equal(unsetCalls, 1, "确实尝试了 unset");
}

// §4b unset 正常时干净通过，且不碰 env 回退。
{
  const map = new Map();
  const service = {
    resolve: async (k) => (map.has(k) ? { value: map.get(k) } : undefined),
    set: async (k, v) => { map.set(k, v); },
    unset: async (k) => { map.delete(k); }
  };
  const env = { [TOKEN_REF]: "ms-ffffffffffffffffffffffffffffffff" };
  const store = createTokenStore({ credentials: () => service, env });
  await store.save("ms-3f2a1b8c1111222233334444555566");
  assert.equal((await store.state()).source, "credentials");
  await store.forget();
  // env 回退不该被动：清面板引用不能删操作者的 .env。
  assert.equal((await store.state()).source, "env", "forget 只清面板引用，env 回退保留");
}

// ── §5 ephemeral 答的是「这个值重启会不会丢」──
{
  const env = { [TOKEN_REF]: "ms-ffffffffffffffffffffffffffffffff" };
  // env 来源：重启不丢 → 不是 ephemeral。
  const envOnly = createTokenStore({ credentials: null, env });
  assert.equal((await envOnly.state()).ephemeral, false, "env 值重启不丢 → ephemeral=false");

  // 内存来源（无凭据服务，save 走内存）：真的只在本次进程存活 → ephemeral=true。
  const memOnly = createTokenStore({ credentials: null, env: {} });
  await memOnly.save("ms-3f2a1b8c1111222233334444555566");
  const memState = await memOnly.state();
  assert.equal(memState.source, "memory");
  assert.equal(memState.ephemeral, true, "内存值重启即丢 → ephemeral=true");

  // 凭据服务在场：面板保存的值落在文件里 → 不是 ephemeral。
  const map = new Map();
  const persisted = createTokenStore({
    credentials: () => ({ resolve: async (k) => (map.has(k) ? { value: map.get(k) } : undefined), set: async (k, v) => { map.set(k, v); }, unset: async (k) => { map.delete(k); } }),
    env: {}
  });
  await persisted.save("ms-3f2a1b8c1111222233334444555566");
  assert.equal((await persisted.state()).ephemeral, false, "落在凭据文件里的值不是 ephemeral");
}

console.log("credentials.test.mjs: all checks passed");
