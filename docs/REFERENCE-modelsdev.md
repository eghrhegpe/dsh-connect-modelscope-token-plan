# 第三方参考方案：models.dev 如何编码魔搭（ModelScope）模型能力

> 本文件是**第三方参照说明**，记录社区库 `models.dev` 处理「魔搭模型能力（尤其是视觉/模态）」
> 的做法，作为我们插件 `isVisionModel` 判定方案的对照。它**不是主数据源**，也不改变本插件
> 的检测逻辑——结论见末尾「对我们的意义」。
>
> 本地已拉取副本：`/tmp/models.dev`（`git clone --depth 1 https://github.com/anomalyco/models.dev.git`，
> 2026-10-04 拉取，钉在 `a5c9719`——副本丢失时按此 SHA 重拉即可复现本节全部对照结论）。
> **为何不在 `upstream/`**：REFERENCES.md 的家规要求「接入目标平台」的 OpenAPI/SDK
> 仓库进 `upstream/` 各带独立 `.git`；models.dev 是**第三方策展参照**（对照 `isVisionModel`
> 方案用），不是魔搭的 OpenAPI/SDK，故只钉版本、不进 `upstream/`。

## 1. 这个仓库是什么

- **仓库**：`https://github.com/anomalyco/models.dev`（anomalyco / opencode 团队维护，MIT 许可）
- **定位**：社区维护的开放 AI 模型规格库（价格、上下文窗口、能力、模态），数据以 **TOML** 文件
  存储于仓库内，经构建生成 JSON API（`models.dev/api.json`）。
- **它被谁消费**：**Mastra** 的 ModelScope provider 文档明确写道——「Model availability,
  capabilities, context windows, and pricing are **sourced from models.dev**」。也就是说，
  Mastra 文档里那些 `imageInput` / `imageOutput` 列，来自 models.dev，而非魔搭官方 API。

## 2. 它怎么编码魔搭模型的模态能力

### 2.1 Provider 定义（`providers/modelscope/provider.toml`）

```toml
name = "ModelScope"
env = ["MODELSCOPE_API_KEY"]
npm = "@ai-sdk/openai-compatible"
api = "https://api-inference.modelscope.cn/v1"
doc = "https://modelscope.cn/docs/model-service/API-Inference/intro"
```

只定义了路由与鉴权，**不携带任何模态/能力信息**——能力在逐模型文件里。

### 2.2 模型定义（`providers/modelscope/models/<Owner>/<Model>.toml`）

每个模型一个 TOML，核心能力字段：

```toml
name = "Qwen3 235B A22B Instruct 2507"
family = "qwen"
attachment = false        # 是否支持文件附件
reasoning = false
tool_call = true
temperature = true
knowledge = "2025-04"
open_weights = true

[cost]
input = 0.00
output = 0.00

[limit]
context = 262_144
output = 131_072

[modalities]
input  = ["text"]
output = ["text"]
```

**视觉判定就看 `[modalities].input`**：含 `"image"` 即能吃图。佐证（仓库内其他视觉模型）：

```toml
# models/alibaba/qwen-vl-max.toml（节选）
[modalities]
input  = ["text", "image"]
output = ["text"]
```

这正是 Mastra 文档 `imageInput` 列的底层来源。

## 3. 关键事实：它对魔搭的覆盖极薄，且不含我们要的视觉模型

`providers/modelscope/models/` 下只有两个 owner 子目录：

```
providers/modelscope/models/
├── Qwen/
│   ├── Qwen3-235B-A22B-Instruct-2507.toml
│   ├── Qwen3-235B-A22B-Thinking-2507.toml
│   ├── Qwen3-30B-A3B-Instruct-2507.toml
│   ├── Qwen3-30B-A3B-Thinking-2507.toml
│   └── Qwen3-Coder-30B-A3B-Instruct.toml
└── ZhipuAI/
    ├── GLM-4.5.toml
    └── GLM-4.6.toml
```

- 共 **7 个模型**，全部 `modalities.input = ["text"]`（纯文本，无视觉）。
- **没有** `deepseek-ai/DeepSeek-V4.1-Flash`、`Qwen/Qwen3.8-Flash-Next`、
  `OpenGVLab/InternVL3_5-*` 这些我们重点要识别的视觉模型。
- 聚合 API（`models.json`，`data` 键，364 条）里**搜不到 `modelscope`**——魔搭的同名模型
  走的是各厂自家 host（如 `alibaba` 下的 Qwen-VL 系列），魔搭 provider 仅收编了 7 个。

## 4. 对照表：models.dev 策展 vs 本插件实时探测

| 维度 | models.dev（第三方策展） | 本插件（`inference-client.ts` 实时） |
|---|---|---|
| 数据形态 | 静态 TOML，社区 PR 维护 | 运行时拉 `modelscope.cn/api/v1/models/{id}` |
| 模态字段 | `[modalities].input` 含 `image` | `Data.Tasks[].Name == "image-text-to-text"` |
| 魔搭覆盖 | 7 个，全文本 | 全量 35 个目录模型 |
| 含 `V4.1-Flash` 等视觉模型 | ❌ 无 | ✅ 有 |
| 时效性 | 滞后（依赖人工同步） | 实时（随目录缓存刷新） |
| 成本 | 零（只读库） | 免认证、零推理额度（与余额同主机） |

## 5. 对我们的意义

1. **我们的实时详情端点方案是对的**。models.dev 那套结构化 `[modalities]` 是「理想能力模型」，
   但它在魔搭侧的覆盖只有 7 个文本模型，根本不含我们要的视觉模型——**不能作 drop-in 替代**。
   本插件改用魔搭自己的详情端点 `Tasks[].Name` 一步判定 `image-text-to-text`，覆盖全、零额度，
   正是为了补上这个缺口（见 `docs/REFERENCES.md` 的 vision 一节）。

2. **可选的反哺路径**。若希望「社区策展 + 实时探测」双保险，可向 models.dev 提 PR，
   为 `DeepSeek-V4.1-Flash` 等补 `[modalities] input = ["text","image"]`。但这属于
   upstream 贡献，不在本插件职责内，优先级低于现有详情端点方案。

3. **名字启发 / 策展清单仍是兜底**。`isVisionModel` 的三级判定
   （结构化 → 详情端点 `Tasks[].Name` → 策展 `KNOWN_VISION_IDS` → 名字启发）不变；
   models.dev 的存在只是再次证明「魔搭无单一权威模态字段」这一判断，并给出一种社区解法参照。

## 6. 引用来源

- 仓库：`https://github.com/anomalyco/models.dev`
- 魔搭 provider 数据：`providers/modelscope/`（provider.toml + models/{Qwen,ZhipuAI}/*.toml）
- 视觉编码样例：`models/alibaba/qwen-vl-max.toml`（`[modalities] input = ["text","image"]`）
- Mastra 文档声明：「capabilities ... sourced from models.dev」— https://mastra.ai/models/providers/modelscope
