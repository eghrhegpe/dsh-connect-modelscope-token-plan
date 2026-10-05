# REFERENCES — upstream/ 容器清单

家规（沿用姊妹插件）：`upstream/` 里每个上游占一个「用各自仓库原名」的子目录，
各带独立 `.git` 与 remote，仅本地容纳、绝不进本仓库历史（`.gitignore` 的
`/upstream/` 规则）。本文件回答三件事：来源、版本、**承重在哪**（我们参考了
它的什么，丢了会漏看什么）。

拉取方式：`git clone --depth 1 --single-branch <url> upstream/<name>`（在
`upstream/` 里手动 `git pull` 即可更新）。

---

## modelscope/modelscope_hub

- 来源：`https://github.com/modelscope/modelscope_hub`（魔搭官方 Python 客户端）
- 本地版本：`0b2a3ba`（shallow，2026-10-04 拉取）；OpenAPI spec 内嵌版本
  `1.1.0+master.20260813T030041Z`；许可 **Apache-2.0**
- **承重：`tests/data/openapi.json` 是魔搭 OpenAPI 的权威契约**，我们的
  balance 解析与错误分诊以它为准：
  - `GET {servers[0]}/magicubes/balance`（servers[0] =
    `https://modelscope.cn/openapi/v1`）——`operationId: getBalance`，
    查询当前用户魔粒余额；security `bearerAuth`（匿名 401，实测一致）。
  - 响应 schema `GetBalanceResponse`：`success:boolean` + `data`：
    `total_balance`（= 可用 + **预扣**）、`available_balance`（可用）、
    `frozen_amount`（**预扣额度：进行中任务未返回结果时预扣减**——面板
    tooltip 语义来源）。
  - 错误家族：统一 `ErrorResponse`（bad-request / unauthorized / forbidden /
    not-found / internal-server-error / service-unavailable）；测试夹具里
    出现业务码 `QuotaLimitExceed`（"magicube balance exhausted"）——OpenAPI
    错误体带业务 `code` 字段，`inference-client` 的余额错误分诊照此对齐。
  - **端点家族全量盘点（防漏看）**：`/magicubes/*` 只有 balance 一个——
    没有消费记录 / 日消耗端点，趋势只能本地累计或做余额差值。其余相关：
    `GET /models`（OpenAPI 模型列表，≠ api-inference 的 /v1/models）、
    `GET /users/me`（当前用户，可做面板账号名展示，M4）。
- 更新方式：官方 spec 更新后重拉，重跑 `test/routes.test.mjs` 的余额形状
  用例即可发现契约漂移。

## iamyours/dsh-plugin-model-usage-meter

- 来源：`https://github.com/iamyours/dsh-plugin-model-usage-meter`
- 本地版本：`fd65e3e`（shallow）；许可 **MIT**（package.json）
- **承重：同类先行者的经验事实**（README 自述，非官方数据，标注后采用）：
  - 魔搭站点的额度环以「**每日 250 魔豆/人/天**」为进度条总长——即每日
    魔粒上限量级是 250 而非 2000 次；与用户转述的「单模型 200/250/500 次/日」
    是两套口径（每日魔粒上限 vs 单模型调用次数上限）。我们的
    `dailyQuotaTotal` / `dailyQuotaPerModel` 曾按**参考线配置**处理，两套口径
    都写进注释，谁也不冒充官方——**该配置已随次数口径推算条一并删除**（见
    README「三条事实」第 2 条），此处保留「两套口径」这一事实本身，它仍是
    理解魔粒上限 ≠ 调用次数上限的依据。
  - API key 只存服务端、浏览器只打本插件代理路由——与我们同构，佐证
    provider 注册（M4）阶段的安全边界设计。
- 它读的端点与我们相同（仅 balance），无额外端点知识；未读其实现细节，
  避免拷贝其代码（许可 MIT，但保持自研 + 受控复制纪律）。

## Weidows/userscripts

- 来源：`https://github.com/Weidows/userscripts`
- 本地版本：`c0fda6d`（shallow）；许可：见仓库 LICENSE 文件
- **承重：`scripts/modelscope-magicube-checkin.user.js` 的三个 URL 事实**：
  - `https://modelscope.cn/magicube/usage?tab=consume` —— **官方「魔粒用量
    明细」网页**（消费记录只在这，API 没有）；签到领魔粒 = 登录态访问此页
    触发，不是 API 端点 → 我们的 M4「每日签到」只能做成外链或提醒，token
    体系做不了（网页会话 cookie 才认）。
  - `https://modelscope.cn/my/account?from=magicube` —— 登录页。
  - `https://modelscope.cn/openapi/v1/magicubes/balance` —— 与我们实测一致
    （第三方交叉印证）。

---

## 为什么没有「按模型消耗」API（以及只能本地计数）

实测结论：**魔搭没有「按模型积分/魔粒消耗」的官方接口**，消费明细只存在于登录态
网页 `https://modelscope.cn/magicube/usage?tab=consume`，API/SDK 都拿不到。三份证据：

1. **官方 OpenAPI spec**（内嵌于 `modelscope_hub` SDK，v1.1.0；`tests/data/openapi.json`
   是权威契约）：`/magicubes/*` 家族**只有一个端点** `balance`，响应 `Magicube` schema
   只有 `total_balance` / `available_balance` / `frozen_amount`，**没有按模型拆解、也
   没有任何消费记录端点**。全 spec 与「价格/优惠」相关的只有 `cost_after_discount` /
   `original_cost`——那是 **Studio 云主机部署的硬件价格**（ECS 规格），与推理魔粒
   无关。唯一的 quota 信号是业务错误码 `QuotaLimitExceed`（E3027，"magicube balance
   exhausted"），它是**请求被拒**的报错，不是「这个模型用了多少」。
2. **真机 spike 记录**（SPIKE.md）：`records/consumptions/usage/history` 等派生端点
   **全部 404**；推理响应无任何限流/额度响应头，body 只有标准 `usage`（prompt/
   completion/total_tokens），**没有魔粒字段**。
3. **刚跑的 api-inference 探测（零成本）**：`/openapi.json`、`/v1/openapi.json`、
   `/v1/usage` → **全 404**；只有 `/v1/models` → 200。即 api-inference 的 OpenAI 兼容
   面就是 `models` + `chat/completions`，没暴露 usage/quota 路径。

**因此**：「每个模型消耗」只能本地计数——就是插件现在做的（本地计数
store，写入侧是 `src/host/usage-observer.ts` 在流出口观测 provider 调用与
失败事件；早先的 usage 探针已随模型目录表一起删除，见 IMPLEMENTATION.md）。对比姊妹插件：sensenova 读官方余额端点、agnes 读
`/api/v2/subscription/credits-balance`，**都是服务端聚合余额，同样不是按模型消耗**；
魔搭情况更差——连消费记录 API 都没有，只能做**余额差值趋势**（每日首末两次读
balance，差值≈当日总消耗，见 ROADMAP 的 backlog）。

**按模型的魔粒单价**（每 1K token 多少魔粒）在网页**模型详情页**有展示，但**不在
官方 OpenAPI 里**——要拿只能抓网页/模型卡，脆弱且会漂移，**不进主数据源**。面板用
模型详情页 URL（`https://www.modelscope.cn/models/{owner}/{model}`，`owner/model` 即
标准模型 id）做**外链**（client 半边每个模型行的「在魔搭查看 →」），方便人工核对单价；
这只是网页跳转，**不是数据源**。

### 模型「能否吃图」（vision）：`/v1/models` 无模态，但详情端点有精确任务标签

`isVisionModel` 判定顺序：① 目录条目的结构化模态字段（`input_modalities`/`modalities`，
魔搭 `/v1/models` 实测每条只返回 `id`/`object`(空串)/`owned_by`/`created`，**这条对所有
模型都走不通**，不像 sensenova 有 `type` 字段）→ ② **详情端点
`modelscope.cn/api/v1/models/{owner}/{name}` 的 `Tasks[].Name` 精确信号**：`image-text-to-text`
= 图进文出（能吃图），`image-to-image`/`text-to-image` 是图出（不含）→ ③ 策展清单
`KNOWN_VISION_IDS`（详情端点不可达时的离线兜底）→ ④ 名字启发 `VISION_NAME_PATTERN`。

为什么 ① 走不通却能靠 ②：`/v1/models` 这个 OpenAI 兼容桩不返回任何模态字段；但模型
详情端点（hub API，与余额同主机 `siteBase`，**免认证、零推理额度**，实测匿名 200）会
返回 `Data.Tasks[].Name`。`fetchModels` 在拿到目录 id 后**并行拉取**（有界并发 6，
`Promise.allSettled`，单失败不影响整体）每个详情，把标签挂到 `entry.tasks`，再交
`isVisionModel` 判。标签随目录一起被 `cacheSeconds` 缓存，不会每次开面板都打几十个请求。

实测词表（已验证）：`DeepSeek-V4.1-Flash`、`Qwen/Qwen3.8-Flash-Next`、`OpenGVLab/InternVL3_5`
→ `image-text-to-text`（吃图）；`Qwen/Qwen-Image-Edit` → `image-to-image`（图出，非吃图）；
`ZhipuAI/GLM-5.2` → `text-generation`。`image-text-to-text` 天然排除生图模型，比
`task=multimodal` 粗筛精确得多。**注意**：`/v1/models?task=multimodal` 在推理端点
**无效**（返回同一份条目），`task` 过滤只存在于主站 hub 检索 API，不在 `api-inference`。

详情拉取失败/超时时该模型 `tasks` 为空 → 回退 ③ 策展 + ④ 名字启发（不静默失败）。策展清单
`KNOWN_VISION_IDS` 是「我们已知」（模型卡/用户反馈），不是平台声明；新增已确知多模态模型时
在此追加 id 即可。

---

## 通用教训（对应「有了工作区就要把数据拉下来」）

本次 spike 只靠猜端点 + 试探，漏掉了 OpenAPI 里现成的 `/users/me`、`/models`
与错误码家族；把官方客户端与同类插件拉进 upstream/ 全量盘点后才补齐。规则：
**接入任何平台前，先找它的 OpenAPI/SDK 仓库拉进 upstream/ 全量盘点端点家族，
再动手写代码。**
