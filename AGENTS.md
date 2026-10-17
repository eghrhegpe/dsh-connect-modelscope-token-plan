# AGENTS.md — AI 会话纪律

给 AI 协作会话的第一站。不重复 `docs/` 的内容，只钉死：**怎么验证、什么红线、去哪查**。
每次会话先读本文件；细节按下面的文档地图跳。

## 项目一句话

DSH 插件：把魔搭社区（modelscope.cn）API-Inference 免费额度的本地用量面板接入 DeepSeek Harness 的 Plugins 页（三个 tab：额度 / 模型 / 接入），并可选把魔搭注册成 DSH 的 LLM provider（id `modelscope-token-plan`，直连 `apiBase`，OpenAI 兼容）。
Host（Node/cordis）走静态令牌（`ms-…`，无 OIDC / 无 refresh）；Client（React bundle）轮询本地路由。

**三条事实**（写代码前先认清你在动哪一条）：

1. **面板是地基**：官方魔粒余额（真实值）+ 本地调用计数（按模型分布/趋势/429 事件流）。本地计数只统计**经本插件的调用**——注册 provider 后 DSH 的全部魔搭调用都经本插件，所以覆盖全部 DSH 魔搭调用。
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
- **撞了封闭集合检查，别绕过，按它的修法补进去**。仓库的高 ROI 门禁多是闭合清单（panel 的 tt 白名单、degrade marker grep、聚合器纯度断言）。被它拦住 = 你动了未登记成员，正确动作是把新成员补进清单（连代码带测试），不是放宽或删掉这条检查。
- **测试期望要对齐实现语义**：改测试前先读被测模块的注释——很多「看起来怪」的行为（如 `valid: null` 不是 `false`）是刻意的语义区分。

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

---

## 并行会话纪律

工作树常同时有**他人未提交改动**（多会话并行开发是常态）：

- **不碰 `git stash / push / pop`**（`list`/`show` 只读可用）。
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
| 上游端点全景 / 第三方方案对比 | `docs/REFERENCES.md`、`docs/REFERENCE-modelsdev.md` |
| v1 要做什么、做到哪了 | `docs/ROADMAP.md` |
| 魔搭 OpenAPI 契约全文 | `docs/modelscope.cn-openapi/modelscope.cn-openapi.md` |
| 开发者校验工具（变异测试 / 覆盖率） | `tools/dev/README.md` |
| 发布流程 | `RELEASING.md` |

---

## 进入代码库的读取顺序（AI 会话）

约 50 个 src 文件 + 约 35 个测试文件，乱序读会把时间花在「重新验证文档已写明的事实」上。

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
| `routes.ts` | 路由注册门面（6 条路由） | `registerRoutes()` |
| **── 数据层 ──** | | |
| `ms-auth.ts` | 凭据存取（唯一出口，静态令牌） | `createTokenStore()` |
| `inference-client.ts` | HTTP 出口：模型目录 + 魔粒余额 + 探针 | `createInferenceClient()` |
| `usage-store.ts` | 本地计数持久化（天桶/单模型/事件流） | `createFileUsageStore()` |
| `provider-store.ts` | 开关 + 允许清单 + 窗口覆盖的持久化 | `createFileProviderStore()` |
| `state-store.ts` | 文件状态原语（原子写/版本守卫/读缓存/写队列） | 被上面三个 store 共用 |
| `context-catalog.ts` | 内置上下文窗口策展表（models.dev 交叉真值） | `curatedWindowOf()` |
| **── Provider 注册 ──** | | |
| `llm-models.ts` | 目录→descriptor 映射（peer-free） | `buildDescriptors()`, `rosterWithAvailability()` |
| `llm-adapter.ts` | 魔搭适配器装配（peer-dependent 半边） | `createModelScopeAdapter()` |
| `llm-adapter-core.ts` | 三族插件共享的适配器装配层 | `assemblePiAiAdapter()` |
| `provider-publish.ts` | **发布状态机**：队列/disposed 闸/回滚 | `createProviderPublisher()` |
| `provider-reconcile.ts` | desired-state 收敛器（轮询+路由统一触发） | `createProviderReconciler()` |
| `publish-core.ts` | 三族插件共享的发布原语 | `createPublishQueue()`, `swapRegistration()` |
| `switch-precedence.ts` | 开关优先级：面板值 > patch 默认 | `resolveSwitchEnabled()` |
| **── 观测与纠正 ──** | | |
| `usage-observer.ts` | **流出口观测**：真实对话→本地计数/事件 | `withUsageObserver()`, `observeStream()` |
| `llm-error-fix.ts` | 429 误判纠正（QUOTA→RATE_LIMIT） | `reclassifyStream()`, `shouldReclassifyQuotaToRate()` |
| `llm-retry.ts` | 重试策略（按 code 决定退避） | `resolveRetryPolicy()` |
| `coalesced-fetch.ts` | 有界并发缓存（目录/余额/标签共用） | `createCoalescedFetch()` |
| **── 出图工具 ──** | | |
| `draw-register.ts` | 出图工具注册（挂载时一次性） | `registerDrawTool()` |
| `draw-store.ts` | 出图开关 + 模型偏好的持久化 | `createFileDrawStore()` |
| `draw-runtime.ts` | 出图运行时（两段式：提交→轮询） | `submitDrawJob()`, `pollDrawJob()` |
| `draw-jobs.ts` | 出图任务状态管理 | `createDrawJobStore()` |
| `draw-tool-state.ts` | 出图缺席原因（内存） | `drawToolNote()` |
| **── 路由 ──** | | |
| `routes/snapshot.ts` | 面板轮询的唯一只读路由 | `registerSnapshotRoute()` |
| `routes/models.ts` | 模型目录路由 | `registerModelsRoute()` |
| `routes/token.ts` | 令牌保存/忘掉/验证路由 | `registerTokenRoute()` |
| `routes/probe.ts` | 零额度鉴权探针路由 | `registerProbeRoute()` |
| `routes/provider.ts` | provider 开关/清单/窗口/重置路由 | `registerProviderRoute()` |
| `routes/draw.ts` | 出图开关/模型/重置路由 | `registerDrawRoute()` |
| `routes/paths.ts` | 路由路径常量 | `SNAPSHOT_PATH`, `PROVIDER_PATH`, ... |
| `routes/http.ts` | HTTP 辅助（CORS/JSON/错误脱敏） | `withOrigin()`, `writeJson()` |
| **── 聚合与工具 ──** | | |
| `snapshot-aggregate.ts` | 快照聚合（软失败，绝不白屏） | `buildSnapshotBody()` |
| `doctor.ts` | 只读盘点工具（排查用） | `createDoctor()` |
| `codes.ts` | 错误分类单一真源 | `classifyRateLimit()`, `parseRetryAfterMs()` |
| `util.ts` | 通用工具（脱敏/错误消息/类型守卫） | `redactSecrets()`, `pluginError()` |
| `types.ts` | Host 侧类型定义 | `Wiring`, `HostDeps` |

### Client 侧（`src/client/`）— 跑在浏览器里

| 文件 | 一句话职责 | 关键导出 |
|---|---|---|
| `index.ts` | Client 入口（Cordis client 插件） | `apply()` |
| `panel-page.ts` | **面板主页面**：三 tab 布局 + 全部状态管理 | `PanelPage` |
| `cards.ts` | 展示组件（余额/计数/趋势/事件/令牌/Provider/出图） | `BalanceCard`, `ProviderCard`, ... |
| `snapshot.ts` | 快照解读（降级形状 + 兜底路由） | `viewOf()`, `providerOf()` |
| `http.ts` | HTTP 客户端（GET/POST + 超时 + 错误） | `getJson()`, `postJson()` |
| `format.ts` | 格式化辅助（数字/时间/错误） | `format()`, `isoTime()` |
| `const.ts` | Client 侧常量（路径/URL/特性 owner） | `PROVIDER_PATH`, `TOKEN_PATH`, ... |
| `styles.ts` | 样式 token | `S` |
| `runtime.ts` | React 运行时桥接（h/useState/useEffect） | `h`, `useState`, `useEffect` |
| `i18n.ts` | 国际化字典 | — |
| `composer-usage-pill.ts` | 对话框胶囊（魔粒余额 + 本地计数） | `UsagePill` |
| `toggle-switch.ts` | 开关组件 | `ToggleSwitch` |
| `use-snapshot-polling.ts` | 快照轮询 hook（退避/后台暂停/慢响应保护） | `useSnapshotPolling()` |
| `use-polling-interval.ts` | 轮询间隔计算 hook | `usePollingInterval()` |
| `apply.ts` | Client apply 入口 | — |

### 共享（`src/shared/`）

| 文件 | 职责 |
|---|---|
| `wire.ts` | **契约类型**：Snapshot/TokenStatus/ProviderStatus/... 的 wire 形状 |
| `codes.ts` | 共享错误码 |
| `allow-list.ts` | 允许清单解析（哨兵/空/列表三态） |

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

## 测试策略

```
test/
├── run-all.mjs              # 入口：跑全部测试
├── helpers/
│   └── peer-stub-loader.mjs # Node module hooks 拦截 peer 入口
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
├── state-store.test.mjs     # 文件状态原语
├── panel.test.mjs           # 面板路由契约
├── routes.test.mjs          # 路由族
├── composer-pill.test.mjs   # 对话框胶囊
├── family-kernel.test.mjs   # 三族插件一致性
├── env-hermetic.test.mjs    # 环境隔离
├── inference-vision.test.mjs # 视觉判定
└── draw*.test.mjs           # 出图工具全套
```
