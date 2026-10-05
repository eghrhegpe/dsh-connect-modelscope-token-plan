# SPIKE 2026-10-04 — 魔搭额度信号实测

> **后记（同日，推翻 §结论 1 的一半）**：用户带来线索后实测，官方「魔粒」余额端点
> **真实存在**：`GET https://modelscope.cn/openapi/v1/magicubes/balance`（Bearer
> 访问令牌；匿名 401）。返回
> `{"success":true,"request_id":"…","data":{"total_balance":143,"available_balance":143,"frozen_amount":0}}`。
> `records/consumptions/usage/history` 等派生端点全部 404——官方只给余额快照。
> 因此面板设计升级：**官方魔粒余额为主数据源**（真余额），本地计数降级为辅助
> （经本插件的调用/token），原 §结论 1 只对「推理响应头」成立。魔粒的计费语义
> （每次调用扣多少、24h/90d 有效期分层）官方未在端点中披露，待观察。
>
> **后记 2（拉取官方仓库后补齐，docs/REFERENCES.md）**：把 `modelscope_hub`
> （官方 Python 客户端，内嵌 OpenAPI spec v1.1.0）等三个仓库拉进 `upstream/`
> 全量盘点后确认/补齐：
> - `/magicubes/*` 家族**只有 balance 一个端点**——官方 OpenAPI 无消费记录端点，
>   消费明细只在网页 `https://modelscope.cn/magicube/usage?tab=consume`；
> - `frozen_amount` 官方语义 = **预扣额度**（进行中任务未返回结果时暂扣），
>   `total_balance` = 可用 + 预扣；
> - OpenAPI 错误体是统一 `ErrorResponse`（带业务 `code`，如 `QuotaLimitExceed`），
>   余额解析的错误分诊照此对齐（401 unauthorized / 403 forbidden）；
> - 官方 OpenAPI 另有 `GET /models`、`GET /users/me`（面板账号名展示可作 M4）；
> - 同类插件 `dsh-plugin-model-usage-meter` 的经验口径：**每日 250 魔豆/人/天**
>   作额度环总长（非官方数据）；与「单模型 200/250/500 次/日」是两套口径，
>   我们的配置常数只作参考线，两者都不冒充官方；
> - 签到领魔粒 = 登录态**访问网页**触发（用户脚本实证），不是 API——token 体系
>   做不了自动签到，M4 只做外链/提醒。
> - 教训已写入 REFERENCES：**接平台先拉 OpenAPI/SDK 仓库进 upstream/ 盘点端点
>   家族，再写代码**——纯试探漏掉了 /users/me、/models 与错误码家族。

目的：在写第一行实现前，回答一个问题——**魔搭上游到底有没有任何额度/限流信号可供面板消费？** 这决定 v1 面板走「响应头派」还是「本地计数派」。

环境：本机 Windows（Git Bash curl），Node 24.16。令牌来自 DSH 凭据服务既有的 `MODELSCOPE_API_KEY` 引用（长度 39，`ms-` 前缀形态），全程未回显。

## 实测记录

| # | 请求 | 认证 | 状态 | 限流/额度相关响应头 | 备注 |
|---|---|---|---|---|---|
| 1 | `GET /v1/models` | 无 | 200 | 无 | 免认证可读；OpenAI 目录格式 |
| 2 | `POST /v1/chat/completions`（`deepseek-ai/DeepSeek-V4.1-Flash`，`max_tokens:1`） | 无 | 401 | 无 | body：`{"error":{"message":"Authentication failed, please make sure that a valid ModelScope token is supplied.","request_id":"…"}}` |
| 3 | 同 #2 | `Authorization: Bearer <令牌>` | 200 | 无 | body 带 `usage:{prompt_tokens,completion_tokens,total_tokens}` |
| 4 | `GET /v1/models` | Bearer 同上 | 200 | 无 | 与 #1 无差别 |

四次请求的**完整**响应头都看过：除 CDN 样板（`acw_tc` cookie、`Strict-Transport-Security`、CORS `Access-Control-*`、`Cache-Control`）外没有任何业务头——不存在 `X-RateLimit-*`、`x-ms-*`、quota/remaining 字样的任何变体。

## 结论

1. **上游不携带额度信息**（成功、401、models 都没有）。社区流传的「从响应读 `x-ratelimit-remaining`」（Greasy Fork 用户脚本）在当前魔搭实现中**无法复现**——可能是别的服务、或旧行为。「响应头派」被实测否决。
2. 响应体带 `usage`（token 计数）→ 面板可本地累计展示 token 消耗，但**调用次数只能自己数**。
3. `/v1/models` 免认证可读 → 模型目录轮询**零额度成本**。
4. 429 响应形状未知（未触发；单模型约 500 次/天的上限不值得烧掉去触发）。v1 按 OpenAI 惯例兼容解析（`error.message` 含 quota/rate 字样 → 分诊），漂移靠快照 `shapeWarnings` 提示，真机首撞后回填本文件。
5. 「主动探测换数据」无意义：探测也读不到余额，只是白烧一次调用。探测唯一保留用途是**令牌有效性检查**，且真机已回填（2026-10-04）：缺 `messages` 的请求**不返回 400 而是返回 200**——魔搭不先校验消息体，鉴权失败才是 401。所以 validity probe 的判定规则定为：**401/403 = 令牌坏；200/400 = 令牌好；429 = 限频中**。该空壳响应 `created:0`，疑似零额度，未证实——validity 结果**不计入**本地用量。

## 对设计的影响

- v1 面板 = **本地计数派**：经本插件 provider/路由的调用计数（天桶，持久化到插件私有状态文件）＋ 429 事件流 ＋ 免认证模型目录 ＋ 令牌状态。
- ~~额度常数（`dailyQuotaTotal: 2000`、`dailyQuotaPerModel: 500`）只进 `cordis.patch.yml` 配置、绝不进代码~~——**已作废**：发现官方魔粒余额端点后（见上文与 README「三条事实」），面板头条改为官方余额，次数口径的推算条连同这两个常数一起删除。规则漂移史（1000→500→实名后约 2000）仍见 README。
- 面板文案标注「本地计数，仅统计经本插件的调用」——**已不是**「本地推算，非官方余额」：推算口径已删除，头条数字就是官方值。

## 外部参照（搜索结果，未含完整 URL）

- linux.do 帖《魔搭将免费额度从1k砍到了500》（2025-07）
- CSDN《魔搭免费API额度申请指南：绑定阿里云与实名认证全流程》（2026-09，约 2000 次/天）
- 魔搭官方文档「API推理介绍」（SPA，正文需浏览器渲染）
