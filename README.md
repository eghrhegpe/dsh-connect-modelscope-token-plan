# dsh-connect-modelscope-token-plan

把魔搭社区（modelscope.cn）**API-Inference 免费额度**的本地用量面板接入 DeepSeek Harness 的 Plugins 页（插件卡内联，三个 tab：额度 / 模型 / 接入），并可选把魔搭注册成 OpenAI 兼容 LLM provider。

姊妹插件：`dsh-connect-sensenova-token-plan`、`dsh-connect-agnes-token-plan`（同族结构，受控复制）。

**状态：开发中（v0.1.0），尚未安装进任何 profile。**

## 三条事实（写代码前先认清）

1. **魔搭没有余额查询接口**。2026-10-04 实测：推理成功响应、401、`/v1/models` 都不带任何 `X-RateLimit-*` / 额度头（详见 [docs/SPIKE.md](docs/SPIKE.md)）。社区流传的「读 `x-ratelimit-remaining`」在当前实现中不存在。
2. 所以面板是**本地计数派**：「剩余」= 可配置的额度常数 − 插件本地计数（只统计经本插件 provider 的调用）。额度常数（`dailyQuotaTotal` / `dailyQuotaPerModel`）**只进配置不进代码**——魔搭规则漂移史（1000→500→实名后约 2000/天，单模型约 500/天）决定了它必须是随时可改的配置项。
3. **凭据只有一把静态钥匙**：魔搭访问令牌（个人中心生成，形如 `ms-…`），无 OIDC、无密码、无 refresh。默认读 DSH 凭据服务已有的 `MODELSCOPE_API_KEY` 引用，`MODELSCOPE_API_KEY` 环境变量作回退；令牌永不入日志、永不进插件目录。

## 免费额度怎么算（2026-10 快照，以官方为准）

- 每日免费调用次数按账户计（当前约 2000 次/天，需绑定阿里云 + 实名；规则多次调整过）；
- 单模型另有每日上限（社区数据约 500 次/天）与每分钟限频；
- 额度按天重置；耗尽返回 429。
- `/v1/models` 免认证可读，**不消耗额度**。

## 文档地图

| 何时 | 查 |
|---|---|
| 「上游到底有没有额度信号」 | [docs/SPIKE.md](docs/SPIKE.md)（实测记录 + 结论） |
| v1 要做什么、做到哪了 | [docs/ROADMAP.md](docs/ROADMAP.md) |
| Host/Client 两半怎么分 | sensenova 仓库 `docs/ARCHITECTURE.md`（本仓库按同构落地后再补自己的） |

## 诚实声明

- 面板的「剩余次数」是**本地推算**，不是官方余额；只在「所有调用都经过本插件」的前提下准确。直连魔搭的其它客户端不计入。
- 额度常数来自社区公开信息，非官方数据；官方调整后需要手动更新配置。
- 429 响应形状未实测（不值得烧额度去触发），解析按 OpenAI 惯例兼容，漂移时面板会给 `shapeWarnings`。
