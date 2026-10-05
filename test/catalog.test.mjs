// 高亮家族（FEATURED_OWNERS）与 owner 提取的纯函数离线套件。peer-free，裸 node 跑。
//
// 曾住在这里的 `sortCatalogIds`（featured 置顶排序）已随「模型目录表」一起退役：
// 面板现在按 Host 返回的顺序渲染，只保留 featured 徽标，不再按 owner 重排——
// 所以排序规则连同它的 6 条性质断言一起删了，不留「有契约无实现」的孤儿。
import { strict as assert } from "node:assert";
import { FEATURED_OWNERS, catalogOwner } from "../src/client/const.ts";

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

console.log("catalog.test.mjs: all checks passed");
