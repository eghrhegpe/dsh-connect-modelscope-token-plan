# AGENTS.md — AI 会话纪律

给 AI 协作会话的第一站。不重复 `docs/` 的内容，只钉死：**怎么验证、什么红线、去哪查**。
每次会话先读本文件；细节按下面的文档地图跳。

## 项目一句话

DSH 插件：把魔搭社区（modelscope.cn）API-Inference 免费额度的本地用量面板接入 DeepSeek Harness 的 Plugins 页（三个 tab：额度 / 模型 / 接入），并可选把魔搭注册成 DSH 的 LLM provider（id `modelscope-token-plan`，直连 `apiBase`，OpenAI 兼容）。
Host（Node/cordis）走静态令牌（`ms-…`，无 OIDC / 无 refresh）；Client（React bundle）轮询本地路由。

**三条事实**（写代码前先认清你在动哪一条）：

1. **面板是地基**：官方魔粒余额（真实值）+ 本地调用计数（按模型分布/趋势/429 事件流）。本地计数只统计**经本插件的调用**，且**按 profile（客户端）分段**——注册 provider 后该客户端的全部魔搭调用都经本插件，但桌面端与 Web 端各记各的账、互不可见（`$DSH_HOME/state/<profile>/<插件名>/`，裁定见 `usage-store.ts` 头注；`npm run doctor` 并排列出各 profile）。别把它当跨端总量——这是被实测抓过一次的过度宣称。
2. **Provider 注册与出图工具是两条独立开关**，都是 **opt-in 默认关**，任何失败必须降级为「面板照常用、该模块缺席」。出图工具注册**不可撤销**（peer 的 tools registry 没有 unregister），开关翻转要**下次 Host 启动**才生效。
3. **凭据只有一把静态钥匙**（`MODELSCOPE_API_KEY`，形如 `ms-…`）：无 OIDC、无密码、无 refresh。默认读 DSH 凭据服务已有的 `MODELSCOPE_API_KEY` 引用；令牌永不入日志、永不进插件目录。

**定位变更**：从「只做额度信息」转向**额度 + provider + 出图 + 上下文窗口策展**的多功能集成。

---

## 验证（按域裁剪，禁止无脑全量）

```bash
node test/run-all.mjs           # 全量离线测试门禁
node test/run-all.mjs --only=<子串>   # 按域裁剪
node test/run-all.mjs --skip=<子串>   # 反向裁剪
npm run typecheck               # tsc 类型检查
npm run build                   # 改 src/ 后必跑：重建 lib/ 与根 client.js
npm run doctor                  # 只读盘点状态文件
```

- **改了契约/接缝文件，跑全量**。`src/shared/*`、`client.js`、`lib/index.js` 以及被多个模块消费的文件，消费者不可枚举——按域裁剪会漏掉跨域契约。判断标准：这个文件的消费者我数得清吗？数不清就全量。
- **全量现在是安全的**：跑完所有套件再汇总，失败项逐个点名。别因为怕卡机器而只跑自己那一个域。
- **`--only` / `--skip` 给了值才算数**：从前 runner 只认 `--only <值>` 空格式，而本文件写的正是 `--only=<子串>` 等号式——等号式取不到值就**静默退化成全量**（你以为在裁剪，实际跑了 39 个套件），还因为 build-gate 当时挂在「未裁剪」分支里，连唯一的产物门禁一起跳过。现在两种写法都认，解析不出值或以 `--only-wire` 这种连字符形式出现就直接以退出码 2 报错；裁剪时 build-gate 照跑（「只跑一个域」恰恰是「改了 src 没重建」最容易蒙混的场景）。
- **撞了封闭集合检查，别绕过，按它的修法补进去**。仓库的高 ROI 门禁都是闭合清单，每条都能在 `test/docs.test.mjs` 里点出行号：**§14（:692）**`src/` 四目录文件登记表（每个 `.ts` 都得在地图里，且不许写幽灵行）、**§14b（:721）**地图第三列的关键导出名必须真的导得出、**§15（:797）**口径表面集合 `SCOPE_FILES`（新增规范性表面必须补进这个数组）、**§17（:873）**状态 store 头注裁定集合、**§13（:616）**根目录手册禁令、**§6（:156）**套件数与 runner 契约。被它拦住 = 你动了未登记成员，正确动作是把新成员补进清单（连代码带测试），不是放宽或删掉这条检查。
  - 判断「这条检查到底在哪」时**先跑命令再写进文档**：本文件曾把三条门禁写成「panel 的 tt 白名单 / degrade marker grep / 聚合器纯度断言」，2026-10-18 清点发现前两条在代码里查无此物（`test/panel.test.mjs` 只有 zh/en 键集一致 + 值域断言，没有白名单；degrade 留痕只有 `test/draw-store.test.mjs:211` 一处 warn 日志断言），第三条同样不存在。指导文档点名门禁时必须带**文件:行**。
- **测试期望要对齐实现语义**：改测试前先读被测模块的注释——很多「看起来怪」的行为（如 `valid: null` 不是 `false`）是刻意的语义区分。
- **投稿门禁要装依赖**：投稿副本与市场条目这两个门禁共用 `test/helpers/submission-entry.mjs`，它用 **js-yaml**——市场的同款解析器（上游 `scripts/lib/entries.mjs` 就用它），所以我们读到的是市场看到的那份条目。js-yaml 是 `devDependencies`，裸 checkout 上跑这两个套件会抛「js-yaml is not installed」：先 `npm install`。

---

## 红线（违反任一都会炸到用户机器）

1. **凭据不入库**：令牌只进 DSH 凭据服务（`~/.dsh/.credentials.yaml`，owner-only），永不写入插件目录、永不进 git、永不进日志。`ms-auth.ts` 的 `tokenStore.resolve()` 是本插件**唯一**的凭据出口。
2. **credentials 记录 kind 只能是 `grant` / `api-key`**。发明私有 kind 会让凭据文件对整个 Host 不可解析，而该服务是 required —— **Host 直接起不来**。
3. **读不到 ≠ 0**：本地计数文件损坏/形状不对/更新构建写的版本时是 `null`（面板渲染「—」），`0` 是可信日常值。把「不知道」画成 0 是欺骗。
4. **观测失败不是对话失败**：`usage-observer` 的任何异常都不能打断对话。`safe()` 吞掉同步抛与异步拒。
5. **不碰 vendor peer**：`pi-ai`、`dsh-llm`、`dsh-llm-pi-ai` 等 peer 不在本仓库，不可改。host 侧的防御性包装（`llm-error-fix`、`withUsageObserver`、`coalesced-fetch`）是**正确的**，不是绕过 peer。
6. **Host 侧改动必须完全重启 DSH 才生效**：改 `src/host/` 后必须重启 DSH 进程（不只是关窗口），面板才会读到新值。
7. **文件状态原子写**：temp file + rename，损坏即忽略，版本守卫拒覆写。`state-store.ts` 的原语被 `usage-store`、`provider-store`、`draw-store` 三方共用——改原语必须跑全量。

---

## 评审纪律（锐评代码 / 给质量结论前）

先取证、后判决——修复阶段的证据闭环前移到评审阶段，别等用户问「属实吗」才核实。

- **量化断言必须可复现**：任何「多少个」先跑命令数出来，分子（命中问题的）与分母（全部候选）都写清。禁止凭印象报数。
- **先读裁定，再读代码**：本仓多数「看起来怪」的写法在 README「三条事实」、`docs/PROVIDER-M4.md`、`docs/IMPLEMENTATION.md` 有明文出处。定罪前先搜出处，有出处的是设计，不是缺陷。
- **每条问题先做一次无罪搜索**：判「吞错误」前先读 catch 上方注释是否在解释故意降级；判「缺某能力」前先搜有没有「不引入」的裁定。
- **结论分四级**：实测属实 / 部分属实（标注数字或归因修正）/ 设计取舍（附文档行号）/ 无法证实。后两类不得包装成缺陷。
- **门禁全绿不等于没事**：本仓有两类缺陷**跑测试永远挖不到**——① 语法合法、语义不变、类型也对，只是折行/排版被挤坏（`typecheck` 与全部套件都抓不到）；② 门禁本身在**核错对象**（判据绿着，因为它检查的是另一个文件）。两类都是「绿灯撒谎」。这类只能靠**读代码 + 变异实证**：故意把文档写错、跑一次门禁，看它到底点不点得中。变异实证用一次性脚本改文件 → `spawnSync(process.execPath, ["test/run-all.mjs", "--only=<域>"])` 读退出码与点名 → 按原字节还原（不要用 `git checkout`，会带走并行会话的未提交改动）。
- **先划轴，再读文件**：评审是读密集型活。开读前先定 2–3 条高价值轴（例如「新提交改了什么契约」「门禁的判据指向谁」），只读这几条轴涉及的文件；逐文件通读 50 个 src 会把上下文烧光，且挖不到上面那两类问题。用户要求继续审核时才使用子代理；最多2个，且 subagent **只回「问题 + 文件:行号」清单**。
- **排版损伤用机械扫描兜底**：折行损伤靠肉眼扫不出来。全仓扫 `;\s{3,}\S` / `\}\s{3,}\S` / `\{\s{3,}\S` 并排除 `//` 行尾注释，命中即人工看一眼——本次两处真损伤（`provider-reconcile.ts` 的两条接口声明挤一行、`runtime.ts:21` 的 `export interface ReactApi {  createElement: H;`）都是这么捞出来的，而当时 39/39 全绿。

---

## 并行会话纪律

工作树常同时有**他人未提交改动**（多会话并行开发是常态）：

- **`git stash` / `git pop`：建议别用**——它们作用于整棵工作树，会连带卷走他人的未提交改动；只读的 `git stash list` / `git stash show` 不受影响，随时可用。
- **`git push`：不设禁区，改走自检**——推前过三条：① 要推的提交是不是自己的活；② 提交是否路径限定（见下条）；③ `git status --short` 复核没带走别人的东西。三条过完直接推，用户明确要求推时不必再确认。注意本仓多会话共用同一 git 身份，`git log --format=%ae` 分不出归属，别拿作者字段当归属证据。
- 路径限定提交，比如：`git commit -m "<说明>" -- <自己的文件…>`，禁 `git add -u` / `git add -A` 全量卷入。
- 提交后 `git status --short` 复核：没带走别人的东西。
- 看到非自己改动的文件处于 modified，**不要**替它做对照实验，用 targeted 复跑定性。
- **产物必须入库**：`lib/` 与根 `client.js` 已版本化入库。改 `src/` 后必须 `npm run build` 并把产物一并提交（GitHub 直装源不跑 prepack）。

---

## 去哪查（docs/ 地图）

| 何时 | 查 |
|---|---|
| 上游到底有没有额度信号 | `docs/SPIKE.md`（实测记录 + 结论） |
| 出图协议是什么 | `docs/SPIKE-image-gen.md`（2026-10-10 实测） |
| provider 怎么接入（写代码前） | `docs/PROVIDER-M4.md`（实现契约） |
| 这版是怎么做出来的、踩过什么坑 | `docs/IMPLEMENTATION.md`（0.1.0 / M4 实施过程档案） |
| v0.2.0 的十二轮修复细节（已冻结） | `docs/archive/2026-10-05-closeout.md` |
| 各版修复过程档案（0.3.0–0.6.1，按版本命名，已冻结） | `docs/archive/`（本轮 0.6.1：迁移窗口期状态可见性 + inheritFrom 死参数删除） |
| 上游端点全景 / 第三方方案对比 | `docs/REFERENCES.md`、`docs/REFERENCE-modelsdev.md` |
| v1 要做什么、做到哪了 | `docs/ROADMAP.md` |
| 魔搭 OpenAPI 契约全文 | `docs/modelscope.cn-openapi/modelscope.cn-openapi.md` |
| 开发者校验工具（变异测试 / 覆盖率） | `tools/dev/README.md` |
| 发布流程 | `RELEASING.md` |

---

## 进入代码库的读取顺序（AI 会话）

约 59 个 src 文件（`.ts`）+ 41 个测试套件（`test/*.test.mjs`；连同脚本与 helpers 共 48 个 `.mjs`），乱序读会把时间花在「重新验证文档已写明的事实」上。

1. **先文档，后代码**：本文件 → `README.md`（功能全貌 + 三条事实）→ `docs/PROVIDER-M4.md`（设计契约）。这些是判断「代码对不对」的坐标系。
2. **git 先行**：`git log --oneline -15` + `git status --short`。并行会话常驻，优先读新鲜改动。
3. **装配点优先**：先读 `src/host/index.ts`（apply 是唯一装配点，建立依赖图），再读 `src/host/routes.ts`（路由门面），顺着依赖走，别按文件名猜。
4. **错误语义先行**：先读 `src/host/codes.ts` + `src/host/llm-error-fix.ts`（单一 taxonomy + 重分类）。全仓错误分类以它们为真源。
5. **凭据域必读**：`src/host/ms-auth.ts` 是红线 1/2 的落点，无论大小照单全读。
6. **数据流优先**：读「数据怎么流」比读「代码怎么排布」重要。看下面的数据流图。
7. **改行为前先读测试**：`test/` 目录每个模块有对应 `.test.mjs`。测试里 `assert` 的 `name` 本身就是契约。
8. **验证闭环**：改完跑对应域单测 → 全量 `npm test`。

---

## 代码地图

### Host 侧（`src/host/`）— 跑在 DSH 进程里

| 文件 | 一句话职责 | 关键导出 |
|---|---|---|
| `index.ts` | **装配入口**：wiring 全部模块、注册路由、挂载/卸载副作用 | `apply()` |
| `host-config.ts` | 配置解析 + 插件名 + 信任围栏 | `resolveSettings()`, `name` |
| `routes.ts` | 路由注册门面（7 条路由） | `registerRoutes()` |
| **── 数据层 ──** | | |
| `ms-auth.ts` | 凭据存取（唯一出口，静态令牌） | `createTokenStore()` |
| `inference-client.ts` | HTTP 出口：模型目录 + 魔粒余额 + 探针 | `createInferenceClient()` |
| `usage-store.ts` | 本地计数持久化（天桶/单模型/事件流） | `createFileUsageStore()` |
| `provider-store.ts` | 开关 + 允许清单 + 窗口覆盖的持久化 | `createFileProviderStore()` |
| `state-store.ts` | 文件状态原语（原子写/版本守卫/读缓存/写队列） | 被上面四个 store 共用 |
| `usage-prefs-store.ts` | 用量面板显示偏好（趋势显示窗口）的持久化 | `createFileUsagePrefsStore()`, `resolveWindowDays()` |
| `context-catalog.ts` | 内置上下文窗口策展表（models.dev 交叉真值） | `curatedWindowOf()` |
| **── Provider 注册 ──** | | |
| `llm-models.ts` | 目录→descriptor 映射（peer-free） | `buildDescriptors()`, `rosterWithAvailability()` |
| `llm-adapter.ts` | 魔搭适配器装配（peer-dependent 半边） | `createModelScopeAdapter()` |
| `llm-adapter-core.ts` | 三族插件共享的适配器装配层 | `assemblePiAiAdapter()` |
| `provider-publish.ts` | **发布状态机**：队列/disposed 闸/回滚 | `createProviderPublisher()` |
| `provider-reconcile.ts` | desired-state 收敛器（轮询+路由统一触发） | `createProviderReconciler()` |
| `publish-core.ts` | 三族插件共享的发布原语 | `createPublishQueue()`, `swapRegistration()` |
| `switch-precedence.ts` | 开关优先级：面板值 > patch 默认 | `resolveSwitchEnabled()`, `resolveSwitchNumber()` |
| **── 观测与纠正 ──** | | |
| `usage-observer.ts` | **流出口观测**：真实对话→本地计数/事件 | `withUsageObserver()`, `observeStream()` |
| `llm-error-fix.ts` | 429 误判纠正（QUOTA→RATE_LIMIT） | `reclassifyStream()`, `shouldReclassifyQuotaToRate()`, `reclassifyReason()`（可观测判定路径） |
| `llm-retry.ts` | 重试策略（按 code 决定退避） | `buildRetryPolicyConfig()`, `retryableCodes()` |
| `coalesced-fetch.ts` | 有界并发缓存（目录/余额/标签共用） | `createCoalescedFetch()` |
| **── 出图工具 ──** | | |
| `draw.ts` | **出图协议纯逻辑半边**（endpoint/请求体/响应解析/状态判定/失败分诊，peer-free） | `parseDrawResult()`, `readTaskStatus()`, `buildDrawBody()`, `describeDrawFailure()` |
| `draw-register.ts` | 出图工具注册（挂载时一次性） | `registerDrawTool()` |
| `draw-store.ts` | 出图开关 + 模型偏好的持久化 | `createFileDrawStore()` |
| `draw-runtime.ts` | 出图运行时（两段式：提交→轮询） | `submitDrawTask()`, `awaitDrawTask()` |
| `draw-jobs.ts` | 出图任务状态管理 | `createDrawJobs()` |
| `draw-tool-state.ts` | 出图缺席原因 + 本次挂载注册位（内存） | `setDrawToolNote()`, `drawToolNote()`, `setDrawToolMounted()`, `drawToolMounted()` |
| **── 路由 ──** | | |
| `routes/snapshot.ts` | 面板轮询的唯一只读路由 | `registerSnapshotRoute()` |
| `routes/models.ts` | 模型目录路由 | `registerModelsRoute()` |
| `routes/token.ts` | 令牌保存/忘掉/验证路由 | `registerTokenRoute()` |
| `routes/probe.ts` | 零额度鉴权探针路由 | `registerProbeRoute()` |
| `routes/provider.ts` | provider 开关/清单/窗口/重置路由 | `registerProviderRoute()` |
| `routes/draw.ts` | 出图开关/模型/重置路由 | `registerDrawRoute()` |
| `routes/usage-prefs.ts` | 趋势显示窗口路由 | `registerUsagePrefsRoute()` |
| `routes/paths.ts` | 路由路径常量 | `SNAPSHOT_PATH`, `PROVIDER_PATH`, ... |
| `routes/http.ts` | HTTP 辅助（CORS/JSON/错误脱敏） | `withOrigin()`, `writeJson()` |
| **── 聚合与工具 ──** | | |
| `snapshot-aggregate.ts` | 快照聚合（软失败，绝不白屏） | `buildSnapshotBody()` |
| `doctor.ts` | 只读盘点工具（排查用） | `diagnose()`, `renderReport()` |
| `codes.ts` | 错误分类单一真源 | `classifyRateLimit()`, `parseRetryAfterMs()` |
| `util.ts` | 通用工具（脱敏/错误消息/类型守卫） | `redactSecrets()`, `pluginError()` |
| `types.ts` | Host 侧类型定义 | `Wiring`, `HostDeps` |

### Client 侧（`src/client/`）— 跑在浏览器里

| 文件 | 一句话职责 | 关键导出 |
|---|---|---|
| `index.ts` | Client 入口（IIFE 注册物：id + 工厂，三模块世界共用） | `—`（无 ESM 导出；注册物经 __ModuleLoader__ 与 module.exports 交出） |
| `panel-page.ts` | **面板主页面**：三 tab 布局 + 全部状态管理 | `PanelPage` |
| `cards.ts` | 展示组件（余额/计数/趋势/事件/令牌/Provider/出图） | `BalanceCard`, `ProviderCard`, ... |
| `snapshot.ts` | 快照解读（降级形状 + 兜底路由） | `viewOf()`, `providerOf()` |
| `http.ts` | HTTP 客户端（GET/POST + 超时 + 错误） | `getJson()`, `postJson()` |
| `format.ts` | 格式化辅助（数字/时间/错误） | `format()`, `isoTime()` |
| `const.ts` | Client 侧常量（路径/URL/特性 owner） | `PROVIDER_PATH`, `TOKEN_PATH`, ... |
| `styles.ts` | 样式 token | `S` |
| `runtime.ts` | React 运行时桥接（h/useState/useEffect） | `h`, `useState`, `useEffect` |
| `i18n.ts` | 国际化字典 | — |
| `composer-usage-pill.ts` | 对话框胶囊（魔粒余额 + 本地计数） | `ComposerUsagePill()`, `ModelscopePill()` |
| `toggle-switch.ts` | 开关组件 | `ToggleSwitch` |
| `use-snapshot-polling.ts` | 快照轮询 hook（退避/后台暂停/慢响应保护） | `useSnapshotPolling()` |
| `use-polling-interval.ts` | 轮询间隔计算 hook | `usePollingInterval()` |
| `apply.ts` | Client apply 入口（inject 声明 + ctx 装配） | `apply()`, `inject`, `ClientCtx` |

### 共享（`src/shared/`）

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `wire.ts` | **契约类型**：Snapshot/TokenStatus/ProviderStatus/... 的 wire 形状 | `Snapshot`, `SnapshotResponse`, `SNAPSHOT_REQUIRED_KEYS` |
| `codes.ts` | 共享错误码 | `CODE`, `CodeValue` |
| `allow-list.ts` | 允许清单解析（哨兵/空/列表三态） | `parseAllowedList()`, `isIdAllowed()` |

---

## 数据流（从上游到面板）

```
┌─────────────────────────────────────────────────────────────────────┐
│                          ModelScope API                              │
│  /openapi/v1/magicubes/balance  │  /v1/models  │  /v1/chat/completions│
└──────────┬──────────────────────┴──────┬───────┴──────────┬──────────┘
           │                             │                  │
           ▼                             ▼                  ▼
┌──────────────────┐  ┌──────────────────────┐  ┌─────────────────────┐
│  inference-client │  │  inference-client     │  │  llm-adapter-core   │
│  .fetchBalance()  │  │  .fetchModels()       │  │  → PiAiAdapter      │
│  → 魔粒余额       │  │  → 归一目录条目        │  │  → DSH 对话调用     │
└────────┬─────────┘  └──────────┬───────────┘  └──────────┬──────────┘
         │                       │                         │
         │                       ▼                         │
         │              ┌────────────────┐                │
         │              │ provider-reconcile              │
         │              │ → 拉目录 + 读清单 + publish     │
         │              └────────┬───────┘                │
         │                       │                         │
         │                       ▼                         ▼
         │              ┌────────────────┐         ┌─────────────────┐
         │              │ provider-publish│         │ usage-observer  │
         │              │ → 注册 provider │         │ → 记调用/事件   │
         │              └────────────────┘         └────────┬────────┘
         │                                                   │
         ▼                                                   ▼
┌─────────────────┐                               ┌─────────────────┐
│ snapshot-aggregate│                              │  usage-store    │
│ → 拼 Snapshot    │                              │ → 持久化计数    │
└────────┬────────┘                               └─────────────────┘
         │
         ▼
┌─────────────────┐       ┌──────────────────────────────────────┐
│ routes/snapshot  │──────→│  Client 面板（panel-page.ts）         │
│ → GET /snapshot  │       │  额度 tab / 模型 tab / 接入 tab        │
└─────────────────┘       └──────────────────────────────────────┘
```

---

## 关键设计决策速查

> 这些「为什么」的详细答案已在各处文档写明，这里只做索引——别在 AGENTS.md 里
> 重复写答案，否则改了一处另一处会漂移。

| 问题 | 去哪查 |
|---|---|
| 为什么本地计数和官方余额是两个数？ | `README.md` 三条事实 #2 |
| 为什么读不到 ≠ 0？ | `usage-store.ts` `daily()` 注释 |
| 为什么 reasoning 恒为 false？ | `docs/PROVIDER-M4.md` §4 |
| 为什么出图开关要下次启动才生效？ | `src/host/draw-register.ts` 文件头注释 |
| 为什么重分类层在观察层之内？ | `src/host/llm-adapter.ts` 注释 |
| 为什么 commitPublish 不是 async？ | `src/host/provider-publish.ts` |
| 为什么策展表只收 19 个模型？ | `src/host/context-catalog.ts` |
| 为什么 DSH 有自己的账本还要本地计数？ | `src/host/usage-observer.ts` 文件头 |
| 为什么环境变量压过面板保存的值？ | `src/host/ms-auth.ts` 注释 |
| 为什么目录取数不阻塞在余额取数之后？ | `src/host/snapshot-aggregate.ts` 注释 |
| 为什么开关值写不进磁盘？（已修） | `docs/IMPLEMENTATION.md`「开关值写不进磁盘」 |
| 为什么面板收敛删了目录表？（已决） | `docs/IMPLEMENTATION.md`「面板收敛」 |
| 为什么同一个 256000 在面板上有三种印法？ | `src/client/format.ts` `compactCount()` 头注（规格 `256K` vs 读数 `256k` vs 千分位 `256,000`，量纲不同） |
| 为什么胶囊和面板是两条轮询？ | `src/client/index.ts` 头注（各调一次 `useSnapshotPolling()`；共享的是 Host 路由，不是客户端实例） |

---

## 常见任务的入口

| 我想... | 看哪里 |
|---|---|
| 改面板 UI | `src/client/cards.ts` + `src/client/panel-page.ts` |
| 改快照聚合逻辑 | `src/host/snapshot-aggregate.ts` |
| 改 provider 注册逻辑 | `src/host/provider-publish.ts` + `src/host/provider-reconcile.ts` |
| 改错误分类规则 | `src/host/llm-error-fix.ts` + `src/host/codes.ts` |
| 改本地计数口径 | `src/host/usage-store.ts` + `src/host/usage-observer.ts` |
| 加新路由 | `src/host/routes/` 对应文件 + `src/host/routes/paths.ts` + `src/client/const.ts` |
| 改凭据存储 | `src/host/ms-auth.ts` |
| 改模型能力判定 | `src/host/llm-models.ts` + `src/host/context-catalog.ts` |
| 改出图逻辑 | `src/host/draw-runtime.ts` + `src/host/draw-register.ts` |
| 改投稿副本 / 查市场收录漂移 | `awesome-dsh-plugin-submission/` + `test/submission-drift.mjs`（联网）+ `test/submission-drift.test.mjs`（离线夹具）+ `test/market-entry.test.mjs`（市场规则合规） |
| 改测试 | `test/` 目录，每个模块有对应 `.test.mjs` |
| 改契约类型 | `src/shared/wire.ts` |
| 排查线上问题 | `npm run doctor` + `docs/IMPLEMENTATION.md` 踩坑档案 |

---

## 已知的真实坑（改前先看这里有没有）

- **改 `src/` 不重新 build，测试看不见改动**：测试默认入口是产物 `client.js`（`dom-render.test.mjs` 等）。改 `src/**` 后必须先 `npm run build`，否则测试跑的是旧产物。
- **凭据环境变量压过面板保存的值**：DSH 凭据服务启动时冻结环境快照，`MODELSCOPE_API_KEY` 一旦存在就压过面板保存的值，而面板仍显示「已保存」。最省事的做法是直接在面板里保存令牌。
- **轮询签名空转**：`catalogSignature` 没接线时，每 30s 轮询都完整摘下再挂上同一个 provider 对。签名比对是承重的，不能省。
- **`usage.json` 版本守卫曾只置位不复位**：旧构建用空载荷把新构建的 usage.json 降级覆写（version 2 → 1，110 次历史归零），而日志还在说 "recording disabled"。写路径必须在 mutate 之前**自己**读盘。
- **观察层与重分类层顺序不可反**：反了事件流会把纠正后的 RATE_LIMIT 又记成 QUOTA——面板说「额度耗尽」而退避策略按限频处理。
- **允许清单的空 vs 缺失是两件事**：`[]` = 不过滤（全部提供），`null` = 没保存过。读侧必须能区分两者，否则「保存了空清单」会被读成「从未保存」。

---

## 会话工具踩坑（2026-10-18 记账，编辑文档/跑门禁前看）

- **含中文的字符串替换，先用 Python `repr()` 核对磁盘原文**：Read 输出带行号前缀，全角标点（——/、/「」/节线 U+2500）在眼里极易看串。0.6.1 修文档时三次 mismatch 全是这么来的（「读过但没有」看丢「、」、节线 U+2500 看成 U+2014、README 锚点看串）。命令：`python -c "print(repr(open('f',encoding='utf-8').read()))"` 打出真身再抄。
- **Git Bash 的 `/tmp` 与 Windows Python 不通用**：bash heredoc 写 `/tmp/x`，Windows 的 python 打开 `/tmp/x` 是 FileNotFoundError（两边看到的不是同一个目录）。跨 shell 传临时文件用品仓内相对路径（如 `.x.tmp`），用完即删、别提交。
- **`npm run build` 必须排在跑全量门禁之前**：build-gate（`run-all.mjs` 末尾那道）按设计抓「改了 src 未重建」。把 build 串在 `node test/run-all.mjs` 后面，等于让门禁先红一次再绿——不是 flaky，是顺序错了。改 `src/` 后的正确顺序：build → 全量 → typecheck。
- **别字节扫宿主 `app.asar`**：那是一个 121 MB 的单文件包，绝大部分是打包的第三方库；`readFileSync().toString("utf8")` 之后 `indexOf` 某个 UI 字面串，命中率≈噪声率（2026-10-18 找 GUI 底部「思考×N · 工具×N」那一行，跑了 9 个脚本、约 10 分钟、零有效命中，命中的全是 katex 的 `×` 实体表和轨迹表的关闭按钮）。要查宿主侧事实，**先解包再读具体条目**（`npx asar list <asar>` 找路径 → `npx asar extract-file` 取那一个文件），或直接读 `resources/app.asar.unpacked/dsh/` 子树；宿主 i18n 真值在 asar 内的 `column.*` / `message.turnProcess.*` 附近，不在渲染拼串里。

---

## 测试策略

```
test/
├── run-all.mjs              # 入口：跑全部测试
├── helpers/
│   ├── peer-stub-loader.mjs # Node module hooks 拦截 peer 入口
│   ├── market-rules.mjs     # 市场的条目规则镜像（手抄上游 scripts/lib/entries.mjs）
│   └── submission-entry.mjs # 投稿 YAML 的共享解析器（js-yaml，市场同款；离线与联网两个门禁共用一份）
├── deps-wiring.test.mjs     # 每个 deps 缝不传时落回 ctx，产品零漂移
├── dom-render.test.mjs      # 产物 + jsdom + mini 替身 React
├── dom-render-react.test.mjs # 真 React 18.3.1 + jsdom
├── provider.test.mjs        # provider 注册全链路
├── provider-publish.test.mjs # 发布状态机
├── provider-routes.test.mjs # provider 路由
├── usage-observer.test.mjs  # 流出口观测
├── error-fix.test.mjs       # 429 重分类
├── llm-adapter.test.mjs     # 适配器装配链
├── snapshot.test.mjs        # 快照聚合
├── wire.test.mjs            # 契约类型一致性
├── docs.test.mjs            # 文档与代码一致性
├── build-gate.mjs           # 产物新鲜度
├── submission-drift.mjs     # 投稿副本 vs 市场线上条目（联网那一半；离线夹具在 submission-drift.test.mjs）
├── submission-drift.test.mjs # 投稿漂移门禁的离线夹具（把脚本复制进临时树跑，零网络）
├── market-entry.test.mjs   # 投稿副本按市场的条目规则校验（合规，不是同源）
├── release.test.mjs         # 发版门禁
├── doctor.test.mjs          # 盘点工具
├── credentials.test.mjs     # 凭据存储
├── context-catalog.test.mjs # 策展表
├── codes.test.mjs           # 错误分类
├── config.test.mjs          # 配置解析
├── catalog.test.mjs         # 模型目录
├── allow-list.test.mjs      # 允许清单
├── reconcile.test.mjs       # 收敛器
├── retry.test.mjs           # 重试策略
├── usage-store.test.mjs     # 本地计数持久化
├── usage-prefs-store.test.mjs # 趋势显示窗口偏好持久化
├── state-store.test.mjs     # 文件状态原语
├── panel.test.mjs           # 面板路由契约
├── routes.test.mjs          # 路由族
├── composer-pill.test.mjs   # 对话框胶囊
├── switch-precedence.test.mjs # 开关优先级：面板值 > patch 默认
├── family-kernel.test.mjs   # 同族同源**宣称**的核对（数值重叠只报告，不判红）
├── env-hermetic.test.mjs    # 环境隔离
├── host-range.test.mjs      # peer 范围 × 已发布版本宇宙的对齐（golden 冻结，零网络）
├── inference-vision.test.mjs # 视觉判定
└── draw*.test.mjs           # 出图工具全套（draw.test.mjs / -jobs / -register / -routes / -runtime / -store）
```

> 这棵树由 §6③（`test/docs.test.mjs`）门禁守着：每个 `test/*.test.mjs` 都必须在这里被点名（`draw*.test.mjs` 那条通配算一条，但括号里要列全实际成员）。新增套件忘了登记会判红——本次清点就抓出 `switch-precedence.test.mjs` 与 `usage-prefs-store.test.mjs` 两个漏登记。
