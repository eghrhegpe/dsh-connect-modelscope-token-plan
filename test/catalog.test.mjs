// 目录排序 + 高亮家族（FEATURED_OWNERS）的纯函数离线套件。peer-free，裸 node 跑。
import { strict as assert } from "node:assert";
import { FEATURED_OWNERS, catalogOwner, sortCatalogIds } from "../src/client/const.ts";

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
// sortCatalogIds：featured 置顶（按 FEATURED_OWNERS 顺序），其余按 owner 字母序，
// 同 owner 内按 id 字母序；集合不变、稳定。
// ─────────────────────────────────────────────────────────────────────────────
{
  const ids = [
    "ZhipuAI/GLM-5.2",
    "Qwen/Qwen3.8-Flash-Next",
    "deepseek-ai/DeepSeek-V4.1-Flash",
    "MiniMax/MiniMax-M1-80k",
    "deepseek-ai/DeepSeek-V4-Pro",
    "Qwen/Qwen-Image-Edit",
  ];
  const sorted = sortCatalogIds(ids);
  // 集合不变
  assert.deepEqual([...sorted].sort(), [...ids].sort());
  const owners = sorted.map(catalogOwner);
  // 1) featured 全部在 non-featured 之前
  const firstNon = owners.findIndex((o) => !FEATURED_OWNERS.includes(o));
  assert.ok(firstNon >= 0 && firstNon < owners.length, "存在 non-featured");
  assert.ok(owners.slice(0, firstNon).every((o) => FEATURED_OWNERS.includes(o)), "featured 全在 non-featured 之前");
  // 2) featured 内部顺序 = FEATURED_OWNERS
  assert.deepEqual([...new Set(owners.slice(0, firstNon))], [...FEATURED_OWNERS], "featured 内部顺序正确");
  // 3) 末尾是 non-featured（MiniMax，本例唯一非 featured）
  assert.equal(catalogOwner(sorted[sorted.length - 1]), "MiniMax", "non-featured 在末尾");
  // 4) 同 owner 内按 id 字母序（验证 Qwen 组：Qwen-Image-Edit < Qwen3.8-Flash-Next）
  const qwen = sorted.filter((id) => catalogOwner(id) === "Qwen");
  assert.deepEqual(qwen, [...qwen].sort(), "同 owner 内按 id 字母序");
  // 5) 幂等：再排一次结果相同
  assert.deepEqual(sortCatalogIds(sorted), sorted, "排序幂等");
  // 6) 原数组未被排序原地改动（不可变）
  assert.equal(ids[0], "ZhipuAI/GLM-5.2", "输入数组保持不变");
}
