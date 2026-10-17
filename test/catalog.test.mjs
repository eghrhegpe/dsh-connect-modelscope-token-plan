// 高亮家族（FEATURED_OWNERS）与 owner 提取的纯函数离线套件。peer-free，裸 node 跑。
//
// 曾住在这里的 `sortCatalogIds`（featured 置顶排序）已随「模型目录表」一起退役：
// 面板现在按 Host 返回的顺序渲染，只保留 featured 徽标，不再按 owner 重排——
// 所以排序规则连同它的 6 条性质断言一起删了，不留「有契约无实现」的孤儿。
import { strict as assert } from "node:assert";
import { FEATURED_OWNERS, catalogOwner, trimOwnerPrefix, formatWindow } from "../src/client/const.ts";

// ─────────────────────────────────────────────────────────────────────────────
// catalogOwner：从 owner/model 取 owner
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.equal(catalogOwner("deepseek-ai/DeepSeek-V4.1-Flash"), "deepseek-ai");
  assert.equal(catalogOwner("ZhipuAI/GLM-5.2"), "ZhipuAI");
  assert.equal(catalogOwner("Qwen/Qwen3.8-Flash-Next"), "Qwen");
  assert.equal(catalogOwner("no-slash-id"), "no-slash-id");
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURED_OWNERS 即用户认可的三家（顺序 = 置顶内展示序）
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.deepEqual([...FEATURED_OWNERS], ["deepseek-ai", "ZhipuAI", "Qwen"]);
}

// ─────────────────────────────────────────────────────────────────────────────
// trimOwnerPrefix：组头说过 owner，行里就别再说一遍
//
// 真实形态是「name === id」：魔搭目录只回 id，Host 侧 `str(entry.name, id)` 的兜底
// 让每行都带 `owner/` 前缀——分组之后那截前缀与组头逐字重复十几遍。
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.equal(
    trimOwnerPrefix("deepseek-ai/DeepSeek-V4-Pro", "deepseek-ai/DeepSeek-V4-Pro"),
    "DeepSeek-V4-Pro",
    "name === id（目录的真实形态）→ 切掉组头说过的那截前缀"
  );
  assert.equal(
    trimOwnerPrefix("deepseek-ai/DeepSeek-V4.1-Flash", "DeepSeek V4.1 Flash"),
    "DeepSeek V4.1 Flash",
    "目录给的是人话名字 → 原样返回"
  );
  assert.equal(
    trimOwnerPrefix("Qwen/Qwen3-8B", "ZhipuAI/GLM-5.2"),
    "ZhipuAI/GLM-5.2",
    "名字带的是**别的** owner 的前缀 → 不按位置硬切"
  );
  assert.equal(trimOwnerPrefix("no-slash-id", "no-slash-id"), "no-slash-id", "没有斜杠的 id 不动");
  assert.equal(trimOwnerPrefix("a/b/c", "a/b/c"), "b/c", "只切 owner 这一截，后面原样");
}


//
// 这些期望值都取自真实数据：2 的幂那组来自档位表与策展表的出厂规格，十进制那组
// 来自 models.dev / 目录自己写的数（见 host/context-catalog.ts 的逐条来源）。
// ─────────────────────────────────────────────────────────────────────────────
{
  const cases = [
    // 2 的幂（档位 131072…1048576、出厂规格 262144）
    [131072, "128K"],
    [262144, "256K"],
    [524288, "512K"],
    [1048576, "1M"],
    // 十进制（目录声明 / models.dev / 策展表）
    [128000, "128K"],
    [131000, "131K"],
    [200000, "200K"],
    [205000, "205K"],
    [256000, "256K"],
    [979000, "979K"],
    [1000000, "1M"],
    [1200000, "1.2M"],
    [2500000, "2.5M"],
    // 两个进制都不整除的零散声明 → 十进制取整；进位到四位数就交给 M 档
    [40960, "40K"],
    [123456, "123K"],
    [999999, "1M"],
    // 千位以下原样
    [512, "512"],
    [1024, "1K"]
  ];
  for (const [tokens, expected] of cases) {
    assert.equal(formatWindow(tokens), expected, `${tokens} → "${expected}"`);
  }
  // 撞车是有意的（头注写了代价）：128000 两个进制都整除，走十进制，
  // 于是与 131072 同读 "128K"。钉住它，免得日后被当成 bug「修」回去。
  assert.equal(
    formatWindow(128000),
    formatWindow(131072),
    "128000 与 131072 同读 128K —— 有意撞车，理由见 formatWindow 头注"
  );
}

console.log("catalog.test.mjs: all checks passed");
