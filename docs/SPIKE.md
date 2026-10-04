# SPIKE 2026-10-04 — 魔搭额度信号实测

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
5. 「主动探测换数据」无意义：探测也读不到余额，只是白烧一次调用。探测唯一保留用途是**令牌有效性检查**——候选方案：故意发一个缺 `messages` 的请求，预期 401（令牌坏）先于 400（请求坏）返回，即零额度鉴权探针；此思路待验证后回填。

## 对设计的影响

- v1 面板 = **本地计数派**：经本插件 provider/路由的调用计数（天桶，持久化到插件私有状态文件）＋ 可配置额度常数 ＋ 429 事件流 ＋ 免认证模型目录 ＋ 令牌状态。
- 额度常数（`dailyQuotaTotal: 2000`、`dailyQuotaPerModel: 500`）只进 `cordis.patch.yml` 配置、绝不进代码——规则漂移史（1000→500→实名后约 2000）见 README。
- 面板文案必须标注「本地推算，非官方余额」。

## 外部参照（搜索结果，未含完整 URL）

- linux.do 帖《魔搭将免费额度从1k砍到了500》（2025-07）
- CSDN《魔搭免费API额度申请指南：绑定阿里云与实名认证全流程》（2026-09，约 2000 次/天）
- 魔搭官方文档「API推理介绍」（SPA，正文需浏览器渲染）
