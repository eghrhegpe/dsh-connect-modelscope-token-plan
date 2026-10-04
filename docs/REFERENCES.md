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
    `dailyQuotaTotal` / `dailyQuotaPerModel` 都只是**参考线配置**，两套口径
    都写进注释，谁也不冒充官方。
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

## 通用教训（对应「有了工作区就要把数据拉下来」）

本次 spike 只靠猜端点 + 试探，漏掉了 OpenAPI 里现成的 `/users/me`、`/models`
与错误码家族；把官方客户端与同类插件拉进 upstream/ 全量盘点后才补齐。规则：
**接入任何平台前，先找它的 OpenAPI/SDK 仓库拉进 upstream/ 全量盘点端点家族，
再动手写代码。**
