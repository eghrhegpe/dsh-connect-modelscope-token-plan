# Changelog

## [未发布]

**代码质量收敛**（内部重构 + 门禁强化，用户可见的只有 a11y 与两处防御性修正）

- tab 键盘焦点不可见：`outline: "none"` 是内联样式，优先级高于外壳的焦点环，把键盘用户的焦点提示也一起压掉了。改为 `outlineOffset: -2`，保留可见性。
- 令牌输入框缺 `aria-label`、ToggleSwitch 缺 `busyLabel`：屏幕阅读器读不出「正在切换」。补两条 i18n 键（zh/en 各 +1）。
- `modelscopeModelUrl` 用 `encodeURI` 不转义 `#`/`?`，模型 id 含这些字符时 URL 语义被破坏。改为分段 `encodeURIComponent`。
- `modelCount`/`enabledCount` 的 `typeof === "number"` 对 NaN 也返回 true，面板会显示「NaN 个模型」。补 `Number.isFinite`。
- 嵌套降层：`swapRegistration` 的 rollback 路径从 4 层 try/catch 降到 2 层（提取 `restorePreviousPair`）；`publishProviderOnce` 两处空转守卫的重复签名比对提取为 `offerUnchanged()`；`runPoll` 的 fallback 逻辑提取为 `currentEnabledIds()`。
- 新增 `docs.test.mjs` §11 引用有效性门禁：扫描 `src/` 与 `test/` 里所有 `test/*.test.mjs` 引用，文件不存在即失败。补 HIDE_ALL_MODELS 双端交叉断言与 locale key 集合一致性断言。三处恒真/死断言换成真断言。
- 六处 `test/peer-contract.test.mjs` 虚假引用全删（文件从未存在，但注释声称 peer 契约被它钉死），改为诚实的缺口声明并记入 ROADMAP backlog。`find-fake-gates.mjs` 误报率从 200+ 降到 3 条。

**发布状态机的两处自伤**（受控复制的分叉实证：兄弟仓各自持有对方缺的修复）

- 工厂加载的 rejection 被 memo 死：`createAdapterFactoryResolver` memo 的对象是 promise 本身，一次失败的 `import()`（典型 `ERR_MODULE_NOT_FOUND`）把错误钉在槽里直到进程结束——此后每次 publish 重抛同一个错，provider 再也注册不上。要命的是 `describeBuildFailure` 的补救提示恰好叫人修安装，照提示修好依然无效、必须重启 Host。现在只 memo 成功，失败清槽、下一次 publish 真重试（与 `dsh-connect-sensenova-token-plan` 对齐）。钉子：`provider-publish.test.mjs` §9（阴性对照实测：旧代码第二次 publish `ok:false`）。
- `!llmAvailable` 分支漏清 `state.built`：残留 `built` 成为**下一次** publish 的回滚目标，注册失败时回滚会把一只 release 已调用过的适配器重新挂上 Host——回滚只在别处已出错时才跑，是最坏的发现时机。改为统一路由 `unregister`（与 `dsh-connect-agnes-token-plan` 对齐）。钉子：`provider-publish.test.mjs` §10（阴性对照实测：旧代码 `state.built` 仍是 `{adapter…}`）。

## [0.2.0] — 2026-10-05

**凭据与红线**
- 上游报错原文经 `soft()` 直进面板与快照（实测 `errMsg` 把 `upstream said ms-…` 原样带出）；聚合层与 `configError`、注销警告两处出口统一走 `redactSecrets`。
- `ms-` 脱敏只认 UUID 分组，紧凑 32 位写法整条漏网；放宽到 `ms-[0-9a-f-]{16,}`，保存入口同步拒收遮不住的短值。
- `forget()` 吞掉凭据服务失败仍回 `ok:true`，谎报删除成功；现在向上传播。
- 面板 `token.hint` 把环境变量说成「回退」——分层正好相反：env 在 DSH 启动时读一次、优先级高于面板保存值。README 与 `cordis.patch.yml` 的同源假话一并更正。

**数据不再悄悄没了**
- usage-store 版本守卫的判据晚于探测一步：旧构建会用 version 1 降级覆写 version 2 文件（实测 110 条历史归零）；`readOnly` 只置位不复位，删文件后永久静默丢弃。
- provider-store 无写串行化：两次点击只活下来一次；读-改-写整体排队，legacy 回填同链。
- `writeStateFile` rename 前补 `fsync`（崩溃后残缺 JSON 会被静默读成「没数据」）；rename 失败时清理临时文件；两处未取消的 body 占住连接。

**可用性**
- 快照缺 `models` / `trend` / `token` 任一键即 TypeError 白屏整页；按必需键校验、缺失补空形状，并把缺失名单显式冒出来。
- 429 分诊把 rpm 限频误判成「额度耗尽」——恰好是刻意不重试的那条路；判据改为复用 `llm-error-fix` 词表。
- `parseRetryAfterMs` 只认中文单位，补英文时又抓到一处 30 倍退避差（`2 minutes` 被当 2 秒）。
- `pollSeconds` 等三项无上界：填 3000000 时 `setInterval` 钳到 **1ms**，每毫秒打一次上游；按语义封顶。
- HTML 响应体不再被塞进面板正文；`internal_error` 有引导文案；`state().ephemeral` 按来源答。
- dispose × 在途 publish 竞态造出「僵尸 provider」——picker 里还能路由、面板已注销；`swapRegistration` 前补第二次闸门检查。

**移除**
- probe 的 `kind:"usage"` 分支：缺省即计费调用、裸 POST 真花魔粒，客户端早已发不出、服务端仍在。
- `dailyQuotaTotal` / `dailyQuotaPerModel`（面板不消费，wire 收窄为 `quota.daily.usedLocal`）；`maxEvents` 自创建起从未进文档与测试，本轮补登记。

**门禁**：新增产物新鲜度（内容哈希对比，红得对）、文档一致性（凭据分层 / 已回填预告 / 递归子目录清单）与 state-store、provider-publish、codes、credentials、retry、route-shape 套件；`.github/workflows/gate.yml` 首次落地；变异测试工具自己的两个缺陷修复（此前所有审计报告不可信）。

> **实施过程（病灶、取证、判据）全部在 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)**——那几轮里不少是踩过的坑，照着做能绕开。

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
