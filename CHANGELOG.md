# Changelog

## [Unreleased]

两轮：先是发布前的漂移收口与门禁补强，再是一轮由双路深审挖出的**数据安全与红线修复**。

### 第三轮：状态机与配置边界

派代理专门核实三个「需要真peer 才能判定」的疑点——它在DSH 发行版里找到了
`@deepseek-ai/dsh-llm@0.1.7-rc.2` 的**本机真实源码**，把三个疑点从推断升级为读代码判定。

- **修 dispose × 在途 publish 竞态（僵尸 provider 泄漏）**：`publishProviderOnce` 只在
  **入口**查一次 `queue.isDisposed()`，而注册发生在最后一个 await 之后（动态 import
  是最宽的窗口）。teardown 落在这段窗口里时闸门不重跑，于是 `registerAdapter` 把适配器
  注册进一个**已撤下本插件的 Host**，而 teardown 早已跑完、release 永不调用（全仓只有
  一个 `.release()` 调用点）。泄漏的对持有 `tokenStore` 与整个 Cordis `ctx` 的闭包 →
  **僵尸 provider**：picker 里那个 provider 还在、还能路由，而面板路由已注销，用户没有
  界面能关掉它。
  peer 源码证实 fiber 兜底救不了：`registerAdapter` 用的是 **llm 服务自己的**
  `ctx.effect`（`.bind(this)` 到 llm 服务），插件卸载不会 dispose 它。
  修法：在 `swapRegistration` 前补第二次闸门检查——从那里到 `registerAdapter` 之间
  **没有任何 await**，单线程下无法插入 teardown，两种时序都正确。
- **给 provider-store 加写串行化（并发丢数据）**：这个 store 曾**完全没有写串行化**
  （`usage-store` 有 `writeChain`，这里没有），而 `patchPayload` 是读-改-写。面板开关
  POST 与 roster POST 是两个独立请求，各自读到同一个 `current`，后写的赢——实测用户勾了
  模型又开了开关，两次点击只活下来一次。文件头说「两个字段必须作为一个载荷读写」防住了
  「不同字段互相覆盖」，但缺串行化后「两次都基于同一快照」的互相覆盖照样发生。现在整段
  读-改-写排队，`writePayload` 的版本拒绝语义一起搬进临界区。**legacy 继承回填**（读路径
  内触发的写）也走同一条链，否则它会覆盖用户刚保存的清单，且因只发生一次而永久生效。
- **给三个时长配置补上界**：`cacheSeconds` / `pollSeconds` / `inferenceTimeoutMs` 的
  `clampInt` 只传了 min（max 默认 `Infinity`）。`pollSeconds × 1000` 超过 2^31-1 ms 时
  Node 把 `setInterval` 延时**钳到 1ms**（实测 pollSeconds=3000000 → `_idleTimeout=1`），
  插件变成每毫秒打一次魔搭目录并打穿单飞缓存；`inferenceTimeoutMs` 同理让每次请求立刻超时。
  现在按语义夹到轮询 1 小时 / 缓存 10 分钟 / 超时 10 分钟。
- **新增 `test/provider-publish.test.mjs`**：`provider-publish.ts` 此前**零测试覆盖**
  （ROADMAP 声称 `test/provider.test.mjs` 测「publish 三条语义」，实际上没有）——零覆盖
  正是这个 P0 能藏住的原因。新套件覆盖 dispose 闸门（含 await 窗口竞态）、publish 队列
  串行性、回滚恢复旧对、空转守卫（指标是 `registerAdapter` 次数而非工厂次数——守卫在工厂
  之后，被跳过的 publish 也跑过工厂）、签名的确定性。
- **核实并排除两条疑点**（避免误改）：`{...handle}` 展开丢私有字段**不是问题**——peer
  的 `prepareCall` 返回 plain object literal（源码 `:1827-1833`），无原型方法无私有字段；
  `resolveRegistrationService` 漏清 `state.built` **不构成 bug**——重新注册旧适配器是安全的
  （无 DUPLICATE_ADAPTER、A 上无注册域状态、新 release 有记录），只是语义不一致。

### 第二轮：深审挖出的真问题（每条都有复现证据，不是推断）

- **修 usage-store 版本守卫（数据静默销毁）**：守卫检查写在 `enqueue` 开头，而
  `readOnly` 的置位发生在其后的 `cache.read()` 内部——判据比真正的探测**晚了一
  步**。实测：磁盘预置 version 2 含 110 次真实调用，一次 `recordCall` 后 version
  降级成 1、历史归零，而日志还在说「recording disabled to avoid clobbering」——
  旧构建正在降级覆写新构建的数据，日志与磁盘状态互相撒谎。同一处 `readOnly` 只
  置位不复位，于是用户按 doctor 建议删掉 usage.json 后写入永久静默丢弃、面板
  还在显示内存残留。现在版本探测由写路径自己做（判据与写入之间不再隔 await），
  且「版本已知」时复位闩锁。回归用例见 `test/usage-store.test.mjs` §7b/§7c（已验证
  它们在修复前确实变红）。
- **修信任围栏的前缀匹配**：`hostName` 对 `Host: [::1]evil.com` 读成 `[::1]` 并
  **通过**白名单——白名单是精确集合，前缀匹配等于把它放宽成「以成员开头」。现在
  校验 `]` 之后只允许空或 `:port`。
- **修面板缺键即白屏**：`interpretSnapshot` 对 `ok:true` 的 body 是裸 cast，
  `SNAPSHOT_REQUIRED_KEYS` 只在测试里被引用、运行时零防线。缺 `models` / `trend` /
  `token` 任一 → TypeError炸掉整个面板（那一行在**所有 tab 上都执行**），而只有
  `provider` 有防御。现在按 `SNAPSHOT_REQUIRED_KEYS` 校验并把缺失块补成与 Host
  降级同构的空形状，缺失名单作为 `missingKeys` 冒到面板上（不静默）。顺带收口同
  族裸解引用（`data?.models.sample` 的 `?.` 没到底、`TokenForm` 的 `=== null` 漏
  `undefined`、`LocalDailyCard` 裸解构）。
- **修 429 分诊把限频误判成额度耗尽**：`classifyRateLimit` 曾把 `"limit reached"` /
  `"daily"` / `"次数"` 归进 quota 桶，于是「Rate limit reached, retry after 60s」
  被判成耗尽 → `llm-retry` 刻意排除 QUOTA → **瞬时限频快失败且不重试**；面板事件
  流还把 rpm 限频显示成「额度耗尽」，与 `llm-error-fix` 的纠正层自相矛盾。现在判据
  **复用** `llm-error-fix` 的 `looksLikeRateLimit` + `hasHardQuotaWordingIn`（消除
  第二份词表），并补上 `daily|monthly … limit` 这组硬额度措辞。
- **修 `internal_error` 没有引导**：聚合器兜底码曾不在 `CODE` 表里，于是 Client 的
  `GUIDANCE_BY_CODE` 映射不了它，最需要人看的内部错误反而没有引导文案，且因为不
  在 `FORM_EXCLUDED_CODES` 里被引导去「配令牌」——方向反了。现在
  `CODE.INTERNAL_ERROR` 正式进表，两端同一份真源。
- **修令牌脱敏漏紧凑写法（红线 1）**：`redactSecrets` 的 `ms-` 正则硬编码 UUID 的
  `8-4-4-4-12` 分组形状，紧凑写法 `ms-3f2a1b8c1111222233334444555566` 整条漏网；
  而 `ms-auth.save()` 不做形状校验，非标准形状的令牌是**可达状态**，上游一旦回显
  即进日志与面板响应。两头都堵：脱敏闸放宽到 `ms-[0-9a-f-]{16,}`，入口新增形状
  校验拒收遮不住的短值。
- **修 `forget()` 谎报删除成功（红线 1）**：曾吞掉凭据服务的 `unset` 失败，让路由回
  `ok: true`，而令牌**仍在凭据文件里且仍被读回来**。安全动作谎报成功比失败更糟，
  现在失败向上传播（路由已有脱敏呈现路径）。
- **修 `state().ephemeral` 答错问题**：wire 定义是「这个值重启会不会丢」，实现却答
  「有没有凭据服务」——于是 env 来源的值（重启不丢）被标成 ephemeral。现在按来源
  答：只有 `memory` 才真 ephemeral。
- **修 `parseRetryAfterMs` 漏英文单位**：只认中文单位，上游文案换成
  `retry after 5 seconds` 就静默退化成「无时长」。补英文单位时还抓到一个**新引入的
  30 倍退避差**——单位写成了非捕获组 `(?:...)`，`en[2]` 恒为 undefined，`2 minutes`
  会被当成 2 秒。
- **修 HTML 响应被塞进面板**：`use-snapshot-polling` 的裸 `await response.json()`
  在反向代理/登录墙回 HTML 时抛 SyntaxError，而 `errorText` 对 Error 返回
  `.message`，于是那段 HTML 源码会显示在面板正文（同仓 `http.ts` 早有 `.catch`，
  这里是漏）。
- 新增两个套件：`test/codes.test.mjs`（`classifyRateLimit` 此前**零测试覆盖**，所以
  它能悄悄漂移）、`test/credentials.test.mjs`（红线 1 的专属门禁，此前也没有）。
  后者逐档比对入口与脱敏闸**同宽**——这是防「进得来却遮不住」的关键不变量。

### 第一轮：漂移收口与门禁补强

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
- **新增 CI**（`.github/workflows/gate.yml`）：typecheck + 19 套件离线门禁。CI 是唯一能
  抓到「提交了忘 build」的地方。`on` 加了引号（裸 `on` 被 YAML 1.1 解析成布尔 true，
  工作流不报错但永不触发）。

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
