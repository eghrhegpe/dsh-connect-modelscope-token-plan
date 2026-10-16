# SPIKE 2026-10-10 — 魔搭生图（`/v1/images/generations`）实测

> **定位**：本文件回答「魔搭能不能接生图、怎么接」。结论：**能接，但与感知的形态不同，且不是照抄姊妹插件能得到的**。
> 截至本文件，**出图功能尚未实现**——本仓库 provider 只注册 chat 模型（见 `README.md` 与
> `llm-adapter.ts`）。本文是实现前的事实档案，承 `SPIKE.md` 的体例：先实测落档，再写代码。
>
> **三份外部资料的可信度不一致，全部经实测对照**（见 §5）。第一份把轮询写成
> `result["status"]` / `SUCCEEDED` / `output.image_url` 三个错，且漏了必需头，**照抄必挂**；
> 第二份正确指出必需头与 `task_status` / `output_images`，但「`X-ModelScope-Async-Mode`
> 是必须的」与「`FAILED` 读 `message`」两处与实测不符。

目的：回答两个问题——**上游目录返不返生图模型**（决定候选列表是否有内容）、以及
**端点协议是什么**（决定要不要新写异步模块）。结论影响 `llm-models.ts` 的能力标注与
出图接入的形状。

环境：本机 Windows，PowerShell。令牌来自 `MODELSCOPE_API_KEY`（`ms-` 前缀，长度 39），
全程未回显。本轮共提交 9 次生图任务 + 1 次 chat 对照。

## 结论摘要

1. **目录里有生图模型**：`/v1/models` 的 35 条目录包含 **2 条** `image-to-image` 模型——
   `Qwen/Qwen-Image-Edit` 与 `MusePublic/Qwen-Image-Edit`（详情端点 `Data.Tasks[].Name`
   均为 `image-to-image`，`created` 1760111983）。
   ⚠️ 精确地说：`llm-models.ts` 那句「没有任何**文生图**模型」**至今仍为真**（目录里
   确实没有 `text-to-image`）；被推翻的是它的**推论**——「所以出图候选列表仍为空」。
   实测这 2 条图生图模型经 `/v1/images/generations` 出图成功，候选列表**非空**。
   该注释已于本轮更正（把事实与推论分开写）。
2. **端点存在且可用**，但**必须异步两段式**：提交得 `task_id`，轮询才出结果。
3. **轮询必须带 `X-ModelScope-Task-Type: image_generation`**，否则一律返回
   `task not found` + `task_status: FAILED`——**这是假失败**，任务其实正常。
4. **提交响应里的 `task_status: "SUCCEED"` 不可信**：最终确实失败的 FLUX 那次，提交也回
   `SUCCEED`。**唯一可信信号是轮询终态。**
5. **`/v1/images/edits` 是 404**：图生图只能走 `/v1/images/generations` 带 `image_url`。
6. **计费已分离**（2026-10-10 实测）：**出图不从魔粒余额扣减，chat 才扣**（1 次 = 1
   魔粒），全程 `frozen=0`。推翻了「生图按魔粒计费」的说法，也意味着**面板不能显示出图
   计数**（详见 §计费）。
7. **`image_url` 是数组**，支持**多图编辑**（官方示例 + 实测 #17）；另有 **`loras`**
   字段（官方注明 ≤6 个、权重和 1.0；实测 #18 证明被消费）。
8. **耗时**：实测 61s–**537s**，单调恶化（免费池排队），**与轮询密度无关**（§坑 4 的
   旧归因已推翻）。超时取 15 分钟；**超时放弃 ≠ 任务死亡**。
9. **终态不幂等**：任务记录会被回收，已 `SUCCEED` 的 id 事后复查会变成 `FAILED`
   （§坑 5）。图片 URL 必须**当场取走**，不能靠 task_id 回查。

## 协议（实测，非文档转述）

```
POST /v1/images/generations
  Authorization: Bearer <ms-…>
  Content-Type: application/json
  （X-ModelScope-Async-Mode: true —— 实测**可省略**，见 §3）
  { model, prompt, image_url?, size?, steps?, guidance?, seed?, negative_prompt?, loras? }
  → { task_id, task_status:"SUCCEED"(不可信), request_id }

  image_url 是**数组**（图生图/多图编辑；顺序即语义），实测单张以数组或裸字符串
  发均通。loras 为单个 repo id 或 {id: weight}（官方：≤6 个、权重和 1.0）。

GET /v1/tasks/{task_id}
  Authorization: Bearer <ms-…>
  X-ModelScope-Task-Type: image_generation     ← 缺此头 = 假 FAILED
  → { task_status: PENDING|RUNNING|SUCCEED|FAILED, output_images: [url], errors?, request_id }
```

实测的完整字段（`SUCCEED`）：顶层 `input`、`output_images`、`request_id`、`task_id`、
`task_status`、`time_taken`。`time_taken` 恒为 `null`，**不能用来估时**。

`FAILED` 的完整字段（FLUX 那次）：`errors`、`request_id`、`task_id`、`task_status`——
**没有顶层 `message`**，它在 `errors.message` 里，且实测为**空字符串**，`errors.code` 为 `0`。

## 实测记录

| # | 请求 | 认证 | 结果 | 备注 |
|---|---|---|---|---|
| 1 | `GET /v1/models` | 无 | 200，35 条 | 免认证零成本；含 2 条 `Qwen-Image-Edit` |
| 2 | `POST /v1/images/generations`（匿名） | 无 | **401** | 端点存在（区别于 404 的 `/images/edits`） |
| 3 | `GET /v1/images/tasks/{id}` 等 4 种轮询变体 | Bearer | **全 404** | 猜错的轮询路径 |
| 4 | `GET /v1/tasks/{id}` **不带** Task-Type 头 | Bearer | `task not found` + `FAILED` | **假失败**，任务实际正常 |
| 5 | `GET /v1/tasks/{id}` **带** Task-Type 头 | Bearer | `RUNNING` → 正常推进 | 头是必需的 |
| 6 | 同一 task，仅换头 | Bearer | `SUCCEED` + PNG URL | A/B 对照，见 §2 |
| 7 | `POST` `Qwen/Qwen-Image-Edit`（无 `image_url`） | Bearer | `SUCCEED`，出 PNG 308KB | 文生图可用 |
| 8 | `POST` `Qwen/Qwen-Image-Edit` + `image_url` | Bearer | `SUCCEED`，耗时 >150s | **图生图可用** |
| 9 | 同上 + `size`/`steps`/`guidance`/`seed`/`negative_prompt` | Bearer | `SUCCEED`，约 185s | 参数被接受，未逐项验证效果 |
| 10 | `POST` `black-forest-labs/FLUX.1-Kontext-dev` | Bearer | 提交 `SUCCEED` → 终态 **`FAILED`** | **不在目录 35 条里**；`errors.code:0` 空错误 |
| 11 | `GET /v1/chat/completions`（chat 模型对照） | Bearer | 200 正常流 | 对照组，确认端点链路本身健康 |
| 12 | `HEAD` 产出的 OSS URL | 无 | 200 `image/png` 308177 B | 链接**当时**可取字节 |
| 13 | `POST` 生图（邮箱验证后复测） | Bearer | `SUCCEED` | 验证账号态恢复，见 §计费 |
| 14 | 同上，**每 30s 轮询** | Bearer | **61s** 即 `SUCCEED` | 与 #8/#9 的 5s 轮询对照，见 §坑 4 |
| 15 | 余额：出图任务前后 | Bearer | `frozen=0`，available 未减 | 出图**不扣**魔粒 |
| 16 | 余额：1 次 chat 前后 | Bearer | **229 → 228** | chat **扣 1** 魔粒（对照） |
| 17 | `image_url` 以**数组**发（官方形状，两张图） | Bearer | `SUCCEED`，231s | **多图编辑可用**；顺序即语义 |
| 18 | 带**伪造** LoRA id | Bearer | **HTTP 500**（提交阶段） | 证明 `loras` 是真被消费的字段 |
| 19 | 同参数连测（15s 轮询） | Bearer | 61s → 261s → **537s** | 排队时长**单调恶化**，见 §坑 4 |
| 20 | 已 `SUCCEED` 的任务隔十几分钟复查 | Bearer | **`FAILED`、`imgs=0`** | 任务记录被回收，**终态不幂等** |
| 21 | 同参数再测（15s 轮询） | Bearer | **859s** `SUCCEED` | 继续恶化；提交仍在 1s 内返回 |
| 22 | 一次 900s 预算的 e2e | Bearer | **905s 超时放弃** | 与 #21 的 859s 相邻——预算卡在边界 |

## 排队时长的实测序列（同日，同参数，15s 轮询）

`Qwen/Qwen-Image-Edit`，纯文生图，prompt 各不相同但复杂度相当：

```
61s → 261s → 537s → 859s    （提交本身始终在 1s 内返回）
```

**单调恶化，四倍以上。** 提交健康、轮询健康、终态正常——慢的**只有排队**。

这条序列是本档案最有说服力的一处证据，因为它同时否掉了两个候选解释：

- **不是轮询密度**：四次全用 15s 间隔，耗时照样翻倍；
- **不是我的实现**：同一时间段内 `chat/completions` 正常，`/v1/images/generations`
  提交 1s 返回，`/v1/tasks/{id}` 轮询正常响应——链路每一段都对，只有出图队列在变长。

**实践含义**：出图的等待时间**不可预测**，从 1 分钟到 15 分钟量级都有可能，且与
请求本身无关。所以

- 超时必须有，且要宽（15 分钟）——但即便如此也可能不够（#22 就是这么撞上的）；
- **超时消息必须说清「任务还在跑」**，而不是让用户以为出图失败了。当前
  `describeDrawFailure` 的超时文案报了轮询次数与截止时间，但**没有**说任务可能仍在
  生成——这是下一轮该补的一处文案；
- 任何「出图应该很快」的 UI 承诺（进度条、预计时长）都是错的，不要做。

## 坑 5：终态**不幂等**，已完成的任务会被回收

一个已经 `SUCCEED` 并给出图片 URL 的任务（`f36237a0-…`），十几分钟后再查同一个
`/v1/tasks/{id}`，返回的是：

```json
{"errors":{"code":0,"message":""},"task_id":"f36237a0-…","task_status":"FAILED"}
```

**没有图片。** 也就是说终态**不是**永久记录，任务会被清理，之后查询得到的是一个
与真实结果相反的 `FAILED`。

后果（对实现有约束力）：

- **图片 URL 必须当场取走并持久化**，不能只存 `task_id` 事后回查——回查可能已经
  查不到了。第二份外部资料提到「URL 是临时链接、应立刻下载」，与本条方向一致；
- **不要用 `task_id` 做「任务重放/重试」**：同一个 id 的答案会从 SUCCEED 变成 FAILED；
- 这也意味着 `FAILED` 有时**不代表当时失败**，只代表「现在查不到」。诊断时要注意
  区分「轮询当场就 FAILED」与「事后复查 FAILED」——实测的空错误形状两者一样，
  **从响应上分不开**。

## 轮询节奏：结论再次修正（§坑 4 续）

§坑 4 曾据一次 5s vs 30s 的对照提出「轮询越密、任务越慢」。**该归因现被推翻。**

同一模型（`Qwen/Qwen-Image-Edit`）、同样 **15s** 轮询、连续三次同参数请求：

| 次序 | 完成耗时 |
|---|---|
| 第 1 次 | **61s** |
| 第 2 次 | **261s** |
| 第 3 次 | **537s** |

轮询间隔**完全没变**，耗时却在单调恶化——所以拖慢任务的**不是**轮询密度，而是
**上游免费池的排队时长在随时间波动**。

那次构成「证据」的 5s vs 30s 对照，两边的变量不止一个（早先那次带 `image_url`
走图生图，多一步拉取输入图），控制变量本来就没做。**当时已在档案里标注了这条
边界，但后文仍按因果写了建议，这是本档案自身的一次漂移**，此处一并更正。

**对实现的取值**（不依赖哪个解释成立）：

- 间隔 **15s**：理由从「更密会更慢」改为「**够用且不浪费**」——实测最慢 537s，
  15s 间隔最多几十次查询，代价可忽略；没有观测收益支持更密；
- 超时 **15 分钟**：覆盖已观测最慢一次（537s）并留一倍余量。**5 分钟的预算实测被
  击穿**——一次真实 e2e 在 300s 处放弃，而那个任务当时仍活着（超时 ≠ 任务死亡）。

## 官方文档示例的核对（2026-10-10）

官方 API-Inference 文档给的示例（`Qwen/Qwen-Image-2.1-Turbo` + 狗/飞盘两张图）与实测
**机制完全一致**，这是最强的交叉印证：提交带 `X-ModelScope-Async-Mode`、轮询带
`X-ModelScope-Task-Type: image_generation`、`task_status` 四态、成功取
`output_images[0]`——全部对上。

但它**补充了两处本档案此前不知道的能力**（均已实测复核）：

1. **`image_url` 是数组，支持多图编辑**（实测 #17）。本档案早先只验了单张裸字符串
   （#8），据此以为它是标量。官方示例展示的是「图一中的狗，去追图二中的飞盘」——
   多图输入，**顺序即语义**。实现据此改为**一律发数组**（单张也发数组，超集更贴近
   上游本意）。
2. **存在 `loras` 字段**（实测 #18）：官方注明最多 6 个、权重系数和须为 1.0，单个
   可用裸 repo id。用伪造 id 探测 → 提交阶段 **HTTP 500**，证明该字段真被消费。

**一处仍存疑**：官方示例用的 `Qwen/Qwen-Image-2.1-Turbo` **不在** `/v1/models` 的
35 条目录里。与 FLUX.1-Kontext-dev 同为「目录外模型」，但 FLUX 实测 `FAILED`。所以
**目录外模型能否可靠调用仍未定**，实现只应从目录内挑模型（见 §候选模型）。

**一处分歧（诚实记录）**：官方示例轮询用 `time.sleep(5)`，即 5s。而本档案 §坑 4 的
两次对照显示更密的轮询**只与更慢相关**（5s → >185s；30s → 61s）。控制变量未做，
两者都不能算定论；本实现取 **15s**——不比官方更激进，也不至于每次都等满 30s。
官方给的是「能跑通」的示例，不是性能建议。

## 三个非直觉的坑

### 1. `task not found` 是头的问题，不是端点的问题

同一个 `task_id`，只差一个头：

```
不带 X-ModelScope-Task-Type → {"errors":{"code":500,"message":"task not found"},"task_status":"FAILED"}
带   X-ModelScope-Task-Type → {"task_status":"SUCCEED","output_images":["https://…/59a8913a….png"]}
```

上一轮曾据此判定「任务长时间不落地、疑似桩实现，建议先别写代码」——**该判断错误，已推翻**。
任务始终正常，4 分钟仍在 `RUNNING` 的观测完全由缺头造成。教训：**「假失败」与真失败在
状态码和状态值上无法区分**，必须用同一 task 做头 A/B 才能定性。

### 2. 提交态恒为 `SUCCEED`，与终态无关

FLUX 提交 → `{"task_status":"SUCCEED","task_id":"8179954"}`；轮询终态 → `FAILED`。
（它的 `task_id` 是短 id `8179954`，而成功任务是 UUID——**短 id 可作为失败信号的旁证，
但不足以判定**。）

任何「提交即算成功、不去轮询」的实现在这里会**静默丢图**。这是本轮最危险的一条。

### 3. `image_url` 图生图可用；**耗时结论已被一次对照推翻**

`/v1/images/edits` 是 404，一度以为图生图不通。实测走 `/images/generations` 带
`image_url`（用模型自己刚产出的 OSS 图作输入）→ `SUCCEED` 出图。

⚠️ **早先据 150s+/185s 得出的「超时须放宽到 10 分钟量级」结论错误，已撤回。**
见下一节的轮询密度对照：真实耗时是 **61s**，185s 那次是被**轮询太密**拖出来的，
不是任务慢。**图生图是否比文生图更慢，本轮仍未定**（变量没控住，见 §对照的诚实边界）。

### 4. 轮询越密，任务完成得越慢（两个数据点，控制变量未做）

同一模型、同一类请求（`Qwen/Qwen-Image-Edit` 纯文生图）：

| 轮询节奏 | 观察到的完成耗时 |
|---|---|
| 每 5s（早先那次） | >185s，40 次查询期间一直 `RUNNING` |
| 每 30s（2026-10-10 后测） | **61s**（+30s 仍 RUNNING，+61s 即 SUCCEED） |

早先那次（每 5s、40 次查询全 RUNNING）曾被记成「任务长时间不落地、疑似桩实现」，
上一轮据此建议「先别写代码」——**该判断错误**。任务始终正常，观测异常来自轮询密度。

**诚实边界**：两个数据点，**控制变量未做**。早先那次带 `image_url`（走图生图，多一步
拉取输入 OSS 图），后测是纯文生图。所以「5s 轮询拖慢」与「图生图天生更慢」**解释
分不开**，上面的对照表**不足以钉死因果**。

**对实现的取值（无论哪个解释都成立）**：

- 轮询间隔取 **15–30s**，**不要用社区常见的 5s**——更密没有观测收益，且在两次观测里
  只与更慢相关；
- 超时按 **5 分钟量级**设（不再是 10 分钟）；
- `time_taken` 恒为 `null`，**拿不到服务端真实耗时**，耗时只能靠客户端墙钟——两个
  观测差 3 倍，更说明不可信。

## 外部资料对照（§5）

| 声明 | 第一份 | 第二份 | 实测裁定 |
|---|---|---|---|
| `X-ModelScope-Task-Type: image_generation` 必需 | ❌ 未提 | ✅ | ✅ **正确**（#6） |
| `X-ModelScope-Async-Mode: true` 必需 | ❌ 未提 | ⚠️ 称「必须」 | ❌ **错**：不带照样返回 `task_id` |
| 终态字段 `task_status` | ❌ 写作 `status` | ✅ | ✅ 第二份对 |
| 终态值 `SUCCEED` | ❌ 写作 `SUCCEEDED` | ✅ | ✅ 第二份对 |
| 结果在 `output_images[]` | ❌ 写作 `output.image_url` | ✅ | ✅ 第二份对 |
| `FAILED` 读 `message` | ❌ 未提 | ⚠️ 称读 `message` | ❌ **错**：无顶层 `message`，在 `errors.message` 且为空串 |
| 默认模型 `black-forest-labs/FLUX.1-Kontext-dev` | ⚠️ 称默认 | ⚠️ 称默认 | ❌ **实测 FAILED**，且不在目录 35 条内 |
| `ref_image.url` 传参 | — | ⚠️ 称部分模型用 | ❌ 未见该字段，`image_url` 一次即通 |
| `size` 为 `"宽x高"` 字符串 | — | ✅ | ✅ 被接受（#9，未验渲染尺寸） |
| `steps`/`guidance` 而非 `num_inference_steps`/`guidance_scale` | — | ✅ | ✅ 被接受（#9） |

**结论：第一份不可用**（轮询三处字段名皆错且漏必需头）；**第二份机制正确**，但两条
「必须/必填」的强断言需按实测放宽。

官方 OpenAPI 规格（`docs/modelscope.cn-openapi/modelscope.cn-openapi.json.gz`，2026-10-17
起 gzip 入库，展开见该目录 README；64 path，
server `https://modelscope.cn/openapi/v1`）**不含** `images/generations`、`tasks` 或任何
`X-ModelScope-*`——它描述站点 OpenAPI，与 api-inference 是两套体系。**出图协议无规格可依，
只能靠官方文档页与实测。**

## 候选模型与已知失败

- ✅ `Qwen/Qwen-Image-Edit`、`MusePublic/Qwen-Image-Edit`——目录内，均实测出图。
- ❌ `black-forest-labs/FLUX.1-Kontext-dev`——**不在 35 条目录**，实测 `FAILED` 且错误为空。
  **不要设为默认模型。**

`Qwen/Qwen-Image-Edit` 与 `MusePublic/Qwen-Image-Edit` 同名不同 owner，行为未分别验证
（验证的是前者）；目录去重时注意 id 完整。

## 计费（2026-10-10 邮箱验证后实测）

用余额端点当探针，同一账号前后对比（`frozen_amount` 是官方「预扣额度」语义，
异步任务从提交到出图有 1–3 分钟窗口，本可用它观察预扣——实测全程 `frozen=0`）：

| 动作 | total | available | frozen | 判读 |
|---|---|---|---|---|
| 起点 | 182 | 182 | 0 | — |
| 1 次出图任务（`Qwen-Image-Edit`，61s SUCCEED） | 229 | 229 | 0 | 余额**涨了 47**（赠送到账），**未扣** |
| 紧接着 1 次 chat 调用 | 228 | 228 | 0 | **扣 1 魔粒** |

**结论**：**出图不从魔粒余额扣减，chat 才扣（实测 1 次 = 1 魔粒）**。全程 `frozen=0`，
未见预扣。

⚠️ **边界**：`frozen` 始终为 0 也可能是「预扣窗口已过」或「出图走另一套计费」，
本轮只观测了**出图完成后**的余额，**没有在提交后立刻连查**——所以「过程中是否预扣过」
未排除。扣减机制本身（是否异步结算、是否按模型分级）也未证实。

**这推翻第二份资料的计费说法**：「轻量约 0.5/次、标准 1/次、旗舰 2/次」在本账号上
与实测不符（出图 0）。每日赠送 200 这条**可能**成立（观测到 +47），但那是登录行为，
与出图无关。

**对面板的直接后果**：**不要显示出图计数**。魔粒余额是 chat 口径的，出图不参与；
把出图次数与魔粒余额并排，正是**已删除的** `dailyQuotaTotal` / `dailyQuotaPerModel`
那次「两个单位并排是误导」的同一形状（那两个次数常数已从配置中移除，面板不再消费）。
真计费口径出来前，宁可不出这一条。

## 对实现的影响

- **不能照抄 `sensenova/src/host/host/draw.ts`**：那份是**同步单发**（`drawOnce` 一次
  fetch 即 `parseDrawResponse(data)` 取 `data[0].url`），魔搭是**异步两段式**且提交态
  不可信。可复用的只有外壳：endpoint 拼接、失败冷却门、失败文案分诊（`describeDrawFailure`）。
  核心的「提交 + 带 Task-Type 轮询 + 取 `output_images[0]`」必须新写。
- **失败分诊要重做**：魔搭 `FAILED` 无 `message` 且实测 `errors.code` 为 `0`、message
  空串，现有 `describeDrawFailure` 依赖 body 文本分类，**对它不成立**。且**原因本身
  可能不可知**——只观测到一个空错误的 FAILED，无法分诊。实现须明确承认这点，不得
  从空错误里编出原因。
- **轮询节奏**：间隔 **15s**（理由是「够用且不浪费」，**不是**「更密会更慢」——那
  条归因已撤回），超时 **15 分钟**。依据见 §坑 4 与「轮询节奏：结论再次修正」。
- **图片必须当场取走**：终态不幂等（§坑 5），URL 会随任务回收失效。任何「先记
  task_id、稍后再取图」的设计都会在几分钟后拿到 `FAILED`。
- **能力标注**：`llm-models.ts` 的 `ModelCapability` 已有 `text-to-image` / `image-to-image`
  分支，hub 详情端点对这类模型返回 `image-to-image`，可直接驱动出图候选列表——
  **但注意目录 35 条里没有 `text-to-image`**，只有 `image-to-image`。

## 待办（Backlog 候选）

- 端到端 e2e（真 Host + 假魔搭，含异步轮询与假失败）——承 ROADMAP 既有的 e2e 缺口。
- **轮询密度的控制变量对照**（纯文生图 + 5s 轮询 vs 30s 轮询，各一次）——§坑 4 的因果
  未钉死，两种解释分不开。
- **预扣探针**：提交后立刻连查 `frozen`，确认过程中是否预扣过（见 §计费的边界）。
- 计费细账：chat 的 1 魔粒是固定值还是按模型/长度浮动。
- ~~`MusePublic/Qwen-Image-Edit` 是否与 `Qwen/` 版行为一致。~~ **已实测（2026-10-16）：行为不同（前者不能纯文生图），并成了默认模型缺陷的根因，见文末补记。**
- `image_url` 支持 data URL（`data:image/png;base64,…`）——第二份资料称支持，**未实测**。
- **目录外模型**（`Qwen/Qwen-Image-2.1-Turbo`、`black-forest-labs/FLUX.1-Kontext-dev`）
  能否可靠调用：官方示例用的是前者，后者实测 `FAILED`，结论未定。
- 多图编辑的**上限**（几张？）与 `loras` 的可用取值——官方给了规则（≤6、和 1.0），
  未逐项验证。

## 补记 2026-10-16 — MusePublic 与 Qwen 行为不同；默认模型缺陷已修

`2026-10-10` 的待办里那条「`MusePublic/Qwen-Image-Edit` 是否与 `Qwen/` 版行为一致」
本轮给出答案：**两者不同**，且这个差异直接造成了「测试通过、插件用不了」的线上
缺陷——连同默认模型选择一起修复。

### 事实（全部真机，2026-10-16）

1. **`MusePublic/Qwen-Image-Edit` 不能纯文生图**：`POST /v1/images/generations`、
   带 Bearer、不带 `image_url` → 提交阶段即被拒：
   `{"errors":{"message":"image_url is required for model: MusePublic/Qwen-Image-Edit"}}`。
2. **`Qwen/Qwen-Image-Edit` 能纯文生图**：同一请求换模型 → 提交成功、拿到 task_id
   （本轮排队序列：15min 超时 ×2 → 约 9.7min 出图，继续印证「排队不可预测」）。
3. **真实目录顺序**（`/v1/models` 免认证实名拉取，36 条）：`MusePublic/…` 在第 11 位、
   `Qwen/…` 在第 20 位——**MusePublic 在前**。而 `2026-10-10` 写下的
   `test/draw-runtime.test.mjs` 夹具把 `Qwen` 放第一位。
4. **根因**：旧 `pickDrawModel` 取「目录里第一个出图模型」→ 默认挑中 MusePublic →
   纯文生图必挂；测试夹具顺序与真实目录相反 → 测试永远绿。**「测试通过、插件用不了」
   的典型形态：夹具钉住的是「夹具里第一个能出图」，不是「线上目录默认挑中的能纯文生图」。**

### 修复

`pickDrawModel` 优先级改为（`src/host/draw-runtime.ts`）：

1. 工具显式请求（目录外也放行）；
2. 首选模型——面板保存值或配置 `drawModelId`，两者走 `resolveSwitchValue` 同一份
   裁决（此前该配置只在目录为空时生效，等于死配置；修复后面板显示的
   preferredModel 与工具实际挑中的一致）；
3. 平台声明 `text-to-image` 的条目（新增 `textToImageModelIds`，将来目录补上真
   文生图模型时自动优先生效）；
4. `KNOWN_T2I_MODEL_ID = "Qwen/Qwen-Image-Edit"`——目录缺 `text-to-image` 时用
   实测知识兜底（本轮新增常量）；
5. 目录第一个出图模型。

测试夹具已改为真实顺序（MusePublic 在前）并新增回归用例（`test/draw-runtime.test.mjs`）：
默认挑中 `Qwen/Qwen-Image-Edit`、首选模型压过默认、目录外首选放行、`text-to-image`
优先、已知 id 缺席时退回第一个。

**排队现状如实记录**：工具描述已从「typically 1-3 minutes」改为「~1 分钟到 15+
分钟不等（免费池排队）」。今天实测为两次 900s 超时 + 一次 ~9.7min 成功，处于档案
记录的最劣区间。
