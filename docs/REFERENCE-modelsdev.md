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

## 6. 2026-10-16 复查：策展表真值来源（上下文窗口）

本文件 2026-10-04 的结论「魔搭 provider 覆盖极薄（7 个文本模型）」**仍然成立**，但
`api.json` 的用途在插件里扩大了：魔搭目录不声明上下文窗口（`/v1/models` 只回
id/object/owned_by/created + Tasks 标签），未声明条目原本一路落到 128k 兜底。现在
`src/host/context-catalog.ts` 用 **同 id 模型在各厂自家 host 下的主流 `limit.context`**
作为策展真值（目录声明 > 用户覆盖 > 策展表 > 兜底）。

复查要点（`curl https://models.dev/api.json`，5.7MB 全量）：

- 聚合 `api.json` 仍搜不到 `modelscope` 作为 provider 键下的当前目录模型；`modelscope`
  provider 自身仍只有那 7 个旧模型（全不在当前目录）。
- 但**同 id 模型在各厂 host 下普遍收录**（alibaba/deepseek/zhipuai/stepfun/novita/kilo
  等），`limit.context` 可交叉比对。策展表每条取**多数 host 的值**，并注明离群：
  - DeepSeek-V4 全系 1048576（nebius 979000~1048000 离群）；
  - Qwen3.5 系 / Qwen3.8-27B / Step-3.5·3.7-Flash / Nex-N2.5 双子 262144
    （openrouter/novita 把 Qwen3.8 抄成 1000000，ofox 256000、merge-gateway 131072）；
  - MiniMax-M3 1048576（ambient 262144 离群）、MiniMax-M1-80k 全 host 一致 1000000；
  - GLM-5.2 取智谱官方 host 1000000（第三方抄 205000）、GLM-4.7-Flash 官方 200000；
  - LongCat-Flash-Lite 仅 qiniu-ai 收录（256000，单源）；
  - Qwen3.8-Flash-Next 仅 tensorx 收录（262144，单源）。
- **无任何数据源**（不进表，落 128k 兜底）：EA-29B-A4B、AntAngelMed、
  Mistral-Large-Instruct-2407、CompassJudger-1-32B、InternVL3_5、ERNIE-4.5 全系、
  Intern-S1/S1-mini/S2-Preview、XiYanSQL 两版本。
- 生图/语音模型（Qwen-Image-Edit、MusePublic 变体、ACE-Step）无对话上下文，不收。
- 取多数而非最大值的理由：个别网关把窗口抄大（openrouter 抄 1M）不代表魔搭侧真开
  那么宽；跨 host 抄写的开量窗口是模型出厂规格，部署配额才是各网关自己的。

维护纪律见 `context-catalog.ts` 模块头注：只收当前目录存在的 id、每条注明来源与
核对日期、目录下架随手删、永不推翻目录声明。

## 7. 引用来源

- 仓库：`https://github.com/anomalyco/models.dev`
- 魔搭 provider 数据：`providers/modelscope/`（provider.toml + models/{Qwen,ZhipuAI}/*.toml）
- 视觉编码样例：`models/alibaba/qwen-vl-max.toml`（`[modalities] input = ["text","image"]`）
- Mastra 文档声明：「capabilities ... sourced from models.dev」— https://mastra.ai/models/providers/modelscope
