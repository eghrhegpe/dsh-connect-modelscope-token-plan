# Changelog

## [0.1.0] — 2026-10-05

**首个发布版。**把魔搭社区（modelscope.cn）API-Inference 免费额度的本地用量面板接入
DeepSeek Harness 的 Plugins 页，并可选把魔搭注册为 DSH 的 LLM provider（id
`modelscope-token-plan`，直连 apiBase，OpenAI 兼容）——注册后魔搭模型进入 DSH 模型选择器，
可直接对话调用。

- **面板**（Plugins 页插件卡，三个 tab：额度 / 模型 / 接入）：头条是官方魔粒余额（真实值），
  下面接本地调用分布与趋势、429 事件流。zh+en 字典，Host 下发 cadence 的快照轮询（隐藏页
  暂停、失败退避、generation guard）。
- **provider 接入**：模型 tab 顶部「接入为 DSH 模型」开关 + roster 勾选，默认关（opt-in）。
  目录→pi-ai descriptor 映射、发布状态机（队列化 / `disposed` 闸 / `registerPair` 单点 +
  rollback 恢复旧对）、面板开关持久层、429 自愈（QUOTA 快速失败 vs RATE_LIMIT 退避 +
  peer 误判纠正层）。设计契约见 [docs/PROVIDER-M4.md](docs/PROVIDER-M4.md)。
- **本地计数接上真实对话**：新增 peer-free 的 `usage-observer` 观察 harness 流出口，一次遍历
  同时拿到 token 与失败分类。**不重复造第二本账**——成功的 token 总量交给DSH 全局账本，本
  插件只生产它答不了的两件：经本插件的分布/趋势、429/错误事件流。
- **能力分类器 `resolveModelCapability`**：二值「是不是 vision」升级为七档能力路由。判定走
  详情端点 `Tasks[].Name` 精确任务标签，策展清单 `KNOWN_VISION_IDS`（14 条实测吃图模型）兜底，
  全不认识则 `unknown`——**绝不猜**。
- **模型目录**：featured owner 置顶排序、逐行外链魔搭详情页（人工核对魔粒单价，非数据源）、
  推荐 pill 取代整行染色高亮。删去与roster 并排重复的「模型目录」表与逐行「试调」按钮。
- **诊断工具** `tools/doctor.mjs`：只读盘点各 profile 的 usage.json 与 env 令牌在场性，绝不
  写盘、绝不打印令牌值。抓「恒为 0 / 恒为空」这类不会报错的状态。
- **发版链路**：截图接入 `screenshots.json` 清单 + `files` 白名单；新增 `test/release.test.mjs`
  （SCREENSHOTS / SHIPPED 两道门禁，防止市场取图裂图）。
- **测试**：15 套件离线门禁（wire / config / usage-store / routes / provider / inference-vision
  / provider-routes / panel / doctor / catalog / switch-precedence / retry / error-fix /
  usage-observer / release），strict typecheck 与 build 全绿。真机冒烟：魔粒余额 143、模型目录
  35、零漂移警告。

> **实施过程（病灶、取证、判据、「看起来能省但不能省」的取舍）记在
> [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)** —— 那几轮里有不少踩过的坑，照着做能
> 绕开，不知道就再踩一遍。
