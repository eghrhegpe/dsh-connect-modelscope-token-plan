# Changelog

## [Unreleased]

发布前的漂移收口与门禁补强（0.1.0 已在市场可装，故这批改动单独记一条）：

- **修配置面漂移（会误导用户的那一处）**：`cordis.patch.yml` 仍写着「本地计数只覆盖
  probe、不覆盖 provider 接入后的对话推理调用」——该说法在 `usage-observer` 落地时就
  已作废，而这份文件正是操作者改配置时唯一在手边的文档。改为准确描述：计数经流出口
  观察器覆盖**全部 DSH 魔搭调用**，并写明已知偏差方向是**少记**（peer 的重试在同一条
  流内部重发）。
- **新增产物新鲜度门禁 `test/build-gate.mjs`**：`lib/` 与根 `client.js` 是故意入库的
  产物（`github:` 安装源不跑 prepack），此前 `.gitignore` 里「后续接入」的 build-gate
  并不存在——**改了`src/` 忘build，市场装到旧代码，而工作树干净、测试与typecheck 全绿，
  没有任何东西会红**。判据是**内容哈希不是 mtime**（clone / 解压都会重写时间戳）：重新
  构建到系统临时目录，与入库产物逐字节比对，且**只读工作树**。已挂进 `npm test` 尾部。
- **删死配置 `dailyQuotaTotal` / `dailyQuotaPerModel`**：面板早已移除次数口径的推算条，
  「M4 阈值提醒预留」的前提（M4）已落地且阈值提醒不存在。客户端对两者零消费，故连同
  wire 的 `quota.daily.limit` / `remainingComputed` / `quota.perModelLimit` 一并收窄为
  `quota.daily.usedLocal` 单字段。`test/config.test.mjs` 显式钉死「它们不回来」。
- **清悬空引用**：源码里 20+ 处引用本仓库不存在的 `PITFALLS §NN` / `docs/IMPROVEMENTS.md`、
  以及一个本仓库没有的 Raccoon 插件的 bug 史。**保留知识、删掉死指针**——坑是什么仍写
  在注释里，只是不再指向查不到的编号。
- **新增 CI**（`.github/workflows/gate.yml`）：typecheck + 16 套件离线门禁。CI 是唯一能
  抓到「提交了忘 build」的地方（本地若产物是入库的，差异只存在于提交内容里）。

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
