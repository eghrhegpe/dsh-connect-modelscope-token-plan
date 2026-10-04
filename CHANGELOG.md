# Changelog

## 0.1.0-M4（未发布）— 正式接入 DSH 作为 LLM provider

- **provider 注册**（id `modelscope-token-plan`，直连 apiBase，OpenAI 兼容）：
  `llm-models.ts`（目录→pi-ai descriptor，含 vision/chat 判定、窗口兜底、
  `supportsDeveloperRole:false`、`reasoning:false` 保守默认）、
  `llm-adapter-core.ts`（照抄姊妹插件的 PiAiAdapter 装配，inert auth + image hook）、
  `llm-adapter.ts`、`publish-core.ts` + `provider-publish.ts`（publish 队列化 /
  `disposed` 闸 / `registerPair` 单点 + rollback 恢复旧对 三条承重语义）、
  `provider-store.ts`（面板开关 + 允许清单，同文件同载荷，按 profile 分段）、
  `switch-precedence.ts`、`routes/provider.ts`（GET 读 / POST 开关 / POST roster /
  POST reset，含 `HIDE_ALL_MODELS` 哨兵）。
- **429 自愈**：`llm-retry.ts`（QUOTA 快速失败 vs RATE_LIMIT 退避）+
  `llm-error-fix.ts`（peer 把限频 429 误判成 QUOTA 的纠正层），照抄姊妹插件两件套。
- **面板「接入为 DSH 模型」**：模型 tab 顶部 provider 区块（开关 + roster 勾选 +
  全部/全部隐藏/保存清单/回到默认，额度耗尽行灰显禁用），原「试调」按钮降级为次要
  动作；`toggle-switch.ts` 照抄；i18n zh/en 各补 21 键。
- **快照**：`Snapshot.provider` 块（开关/来源/注册状态/roster），软失败降级，
  `SNAPSHOT_REQUIRED_KEYS` 14→15。
- **Host 装配**：`index.ts` 挂 seed + 目录轮询 publish（`pollSeconds`），
  teardown 先 `dispose` 再 `release`；`inference-client.fetchModels()` 改回
  `{entries, ids, fetchedAt}`（`ids` 保留兼容旧消费方）。
- **测试**：新增 `test/provider.test.mjs`（目录映射 / 开关+清单 / publish 三条语义）
  与 `test/provider-routes.test.mjs`（路由形状 / 哨兵 / 信任围栏），共 8 套件全绿；
  typecheck / build / doctor 全绿。
- 设计契约见 docs/PROVIDER-M4.md。
- **模型行外链魔搭详情页**：`const.ts` 新增 `MODELSCOPE_MODEL_URL_BASE` 与
  `modelscopeModelUrl(id)`（拼 `https://www.modelscope.cn/models/{owner}/{model}`，
  id 即标准 `owner/model`）；面板「模型」tab 完整目录 + 「接入为 DSH 模型」roster
  的每行加「在魔搭查看 →」外链（新标签页打开模型详情页，魔粒单价只在网页展示，方便
  人工核对；非数据源）。i18n zh/en 补 `models.viewOnSite` / `models.viewOnSiteTitle`。
- **docs/REFERENCES.md** 补「为什么没有按模型消耗 API」一节：三份证据（官方 OpenAPI
  spec / SPIKE / api-inference 探测）坐实魔搭无按模型消耗接口，消费明细只在登录态网页；
  对比姊妹插件（sensenova/agnes 读服务端聚合余额），魔搭只能做余额差值趋势；按模型魔粒
  单价在网页模型详情页、不在 OpenAPI，不进主数据源。README 诚实声明同步一句。

## 0.1.0（未发布）

- 仓库起步：清单 / 配置面 / 构建纪律（与姊妹插件同构）。
- Spike 完成（docs/SPIKE.md）：推理响应无额度头 → 本地计数；**同日实测推翻一半**——
  官方魔粒余额端点 `GET /openapi/v1/magicubes/balance` 真实可用，升级为主数据源。
- Host 半边：ms-auth（凭据引用 + env 回退）、inference-client（免认证模型目录 +
  魔粒余额 + probe 双形态 + 429 文案分诊）、usage-store（天桶/单模型/事件流，
  原子写 + 版本只读闸）、snapshot 软失败聚合、四条路由。
- Client 半边：Plugins 页插件卡，三 tab（额度 / 模型 / 接入），zh+en 字典，
  Host 下发 cadence 的快照轮询（隐藏页暂停、失败退避、generation guard）。
- `npm run build` 产物（lib/ + client.js）入库。
- 测试五套件全绿（wire / config / usage-store / routes / panel），strict
  typecheck 过；真机冒烟：魔粒余额 143、模型目录 35、零漂移警告。
- 待做：e2e（真 Host + 假魔搭）、装机验证、build-freshness 门禁。
- 审核修复（2026-10-04）：
  - `tools/doctor.mjs` 落地（+`src/host/doctor.ts`，六套件）：只读盘点
    `$DSH_HOME/state` 下各 profile 的 usage.json（损坏 / 未知版本 → 症状）与
    env 令牌在场性；绝不写盘、绝不打印令牌值。
  - 快照失败线格式统一为 `{ok, code, error}`：wire.ts 的 `SnapshotFailure`
    此前声明 `message`，与路由写入、client 读取漂移；routes 测试补钉。
  - 单模型 tokens 改**今日口径**（`dayTokens`，跨日清零）：原「今日」行并排
    历史累计是误导；v1 加性字段，旧载荷缺失按 0 起，STATE_VERSION 不变。
  - README 诚实声明与魔粒现状对齐；面板补「验令牌」入口（目录样本首个模型，
    目录不可读时诚实降级）与未配置令牌提示，四个死文案键全部接线；
    `SnapshotFailure` 视图形状改名 `PanelFailure` 消除同名异形。
