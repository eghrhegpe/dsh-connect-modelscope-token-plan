# Changelog

## [未发布]

**CI 门禁修好两处「上游数据引发的红」**（都与功能改动无关：同一个提交在 10-06 是绿的，10-15 重跑同一提交也红）

- **npm 10（Node 22 自带）装不上依赖**：`npm error Cannot read properties of null (reading 'edgesOut')`，十几秒就死在 `npm install`。根因链条实测为：tsdown 声明可选 peer `@vitejs/devtools: "*"` → 该包 `0.8.0`（2026-10-14 发布）的 peer 里新增 `@vitejs/devtools-vitest` → vitest 的可选 peer 是 jsdom / happy-dom / canvas，**npm 10 的 peer 解析在那里崩**，npm 11 正常。`overrides` 回退 rolldown / cac / rolldown-plugin-dts 都无效、`--omit=optional` 无效，而 `--legacy-peer-deps` 立即成功——所以崩点在 peer 解析而非某个包。修法：项目根加 `.npmrc`（`legacy-peer-deps=true`），CI 与本地开发者（npm 10）一起修好，不必改 workflow。本仓库的 peerDependencies **全部**标了 optional，peer 校验本就没有可执行对象，关掉自动 peer 解析无实际损失。
- **build-gate 报「client.js 与当前 src 不同源」**：lockfile 有意不入库，于是 CI 全新安装解析到 **tsdown 0.23.1 + rolldown 1.2.14**，打出的字节与入库产物不同——门禁红在一个「看着像改了 src 忘 build」的地方，真因是工具链漂了。修法：把工具链精确钉在**产出当前入库产物**的那一组（`tsdown: 0.23.0` + `overrides: rolldown 1.2.12 / rolldown-plugin-dts 0.28.6`），并在 `tsdown.config.mjs` 头部写下升级流程（改 pin 必须把新产物与 pin 放进同一个提交）。验证方式：在没有 lockfile 的干净 worktree 上全新安装，钉住后 build-gate 逐字节绿、不钉则与 CI 同样红。

**门禁：新增真 DOM 渲染/交互套件 `test/dom-render.test.mjs`**（devDependencies 加 `jsdom`，是本仓库第一个测试用第三方包；仍然离线，不联网）

- 补的缺口：client 半边此前只由 `test/panel.test.mjs` 的**替身 React**钉着——`createElement` 返回一个普通对象，`onClick` 只是对象上一个属性值，于是事件绑定、受控输入、busy 期间该不该 `disabled`、effect 与卸载的时序全都不可观察；更糟的是替身把 children 放在 `props` **旁边**，而 `SectionCard` 从 `props` 里解构 `children`——折叠体里的卡片在那个套件里**从来没被渲染过**。新套件把**构建产物 `client.js`** 挂进 jsdom 的真 document，配一套最小替身 React（hook 槽位按「路径 + 组件名」、setState 触发真重渲染、effect 在 commit 之后跑、卸载跑 cleanup），钉住：九条面板路由各自被真实点击驱动过且 payload 正确（打字经 state 回流进 `/token` 的 body、哨兵独占态、`已启用 N / M` 与勾选态一致）、`disabled` 的控件点不动、挂载即首轮轮询与 locale 订阅、切后台 `clearInterval` / 回前台补一发 / 失败退避不低于 60s、顶替与卸载真的 abort 在途请求、慢响应不覆盖快响应、写失败与契约漂移那两句话真的上屏。
- 阴性对照：同一批 16 条 src 变异（拆 handler、把开关值取反、混排哨兵、不 `clearInterval`、不记 `inFlight`、`ok:false` 判成功、缺键不报漂移……），`panel.test.mjs` 抓住 **0** 条，新套件抓住 **16** 条。跑法与「为什么必须带 `DSH_DOM_TARGET=src`」（产物入口看不见 src 变异，首轮曾得到 24/24 全绿的假象）见 `tools/dev/README.md`；spec 是 `tools/dev/mutate-dom-render.json`。
- 这一档没覆盖的部分见下一条（真 React 那一档），以及 `docs/ROADMAP.md` 的 Backlog：并发与错误边界、fake timers 下跑满 cadence 的长周期行为。

**再加一档：真 React 渲染门禁 `test/dom-render-react.test.mjs`**（devDependencies 精确钉 `react@18.3.1` + `react-dom@18.3.1`）

- 上面那档 mini 替身每次 commit 整棵重建，所以「React 的 reconciler 说了算」的那一类它**结构上没法表达**。这一档用真 `react-dom/client` + jsdom 挂同一块面板（**不引** jest/vitest/@testing-library：React 18.3 自带 `act`，`HTMLInputElement` 的原生 setter 够用），只承载五类：真 CSSOM 里选中态与未选中态确有区别、重渲染复用**同一批 DOM 节点**（对象身份）、重渲染**不丢焦点**、roster 换序后勾选跟着模型 id 走、React 开发期告警必须为零。焦点那条不是学术问题：面板每 30s 一次 `setData` 就重渲染一次，正在输入令牌的框被打断是用户会遇到的事，而 mini 档实测那里 `activeElement = BODY`、节点复用三条全 false——它根本看不见。
- 阴性对照：同一批 3 条变异（把 `tabActive` 压平、给令牌区块塞一个不稳定 key、删掉 roster 行的 `key`），真 React 档抓 **3** 条，mini 档抓 **0** 条；其中「删 key」是被**零告警**那条抓住的，不是被顺序断言抓住（checkbox 全受控，删 key 不串位）——凡「React 自己的规矩」类缺陷都归零告警那条。spec：`tools/dev/mutate-dom-render-react.json`。
- **代价是版本耦合**：pin 的是宿主浏览器实际注入的那一份 React，用 `tools/dev/probe-host-react.mjs` 从 `app.asar` 读出来（2026-10-15 实测 18.3.1），套件启动时把 `React.version` 与期望值硬比，漂了就红并让人先去核对——不这么办的话，门禁会静默测着一个旧的 reconciler。产物里仍然永远没有 React（`tsdown` 的 `neverBundle` 不变），被钉的只是测试副本；这与 `types/dsh-peer-modules.d.ts`「不声明 React 形状」的立场不冲突。
- 两个必踩的坑写进了套件文件头（别删注释）：`react-dom/client` 必须在 `window`/`document` 就位之后再 import，否则它按「没有 DOM」求值，input 事件被整条吞掉、payload 变空串，看着像被测代码坏了；受控 input 要用原型上的原生 setter 改值，否则被 React 的值追踪器判成「没有变化」。写第一版时当场踩了前者。

**写守卫与注册状态机的六处修正**（每条都做了阴性对照：把修复前的源码放回去，新用例确实红）

- **允许清单三处判据漂移**：`snapshot-aggregate.ts` 与 `routes/provider.ts` 把**可读的空清单**当「不过滤」（正确），而 `index.ts` 的轮询写成 `stored.length > 0` 才算数、否则回退内存——于是操作者按 `versionNote` 给的建议删掉 `provider.json`（或清单被保存为空）之后，面板说 `allowed:"all"` 且 `enabledCount` 数上全部模型，轮询却继续按内存里的旧清单注册：面板与 Host 对「正在提供什么」各说一套。判据收进 `provider-store.resolveEnabledIds` 一份，三处共用（只有读**抛错**才回退内存）。钉子：`provider.test.mjs` §9/§11（阴性对照：旧源码下 §11 的源码级断言直接红）。
- **版本守卫 fail-open**：`readStateVersion` 把 EACCES/EBUSY/EIO（以及路径被目录占住）与「文件不存在」一起折成 `null`，而写守卫只把 `null` 读作「没有东西要保护」——ADR-006「绝不覆盖读不懂的文件」在自己那一侧漏了：**存在却读不出**的文件被判为可写。现在只有 ENOENT 返回 `null`（写是恢复手段），其余 fs 错误抛给写守卫；`provider-store` / `usage-store` 据此拒写并说明理由（usage 侧复用既有的只读闩锁，文件恢复可读即复位）。钉子：`state-store.test.mjs` §6、`provider.test.mjs` §10（阴性对照：`notStrictEqual` 红）。
- **回滚路径漏 release**：`restorePreviousPair` 的 catch 只清 `built`/`registered`，而 `registerProviderPair` 是**先 registerAdapter 再挂目录行**——后者抛错时 `state.releaseAdapter` 已经握着一次成功的注册，于是「面板说不注册、Host 里却还在路由」。现在那条 catch 先 `release()`。钉子：`provider-publish.test.mjs` §12。
- **回滚成功后 `error` 不清，空转守卫形同不存在**：注册失败回滚恢复旧对之后，若恢复出来的 offer 与本次请求**相同**，`error !== null` 会让两处空转守卫永远跳过不了——每个轮询周期把同一对摘下再挂上（fix B 明确要避免的「期间在途请求可能被打断」），面板还挂着一个已不成立的错误。现在只有「请求的 offer 确实没兑现」才留 `error`。钉子：`provider-publish.test.mjs` §11（阴性对照：`actual 'transient registration failure'` / `expected null`）。
- **成功的 probe 被报成失败**：成功分支里 `await tokenStore.state()` 住在 try 内，凭据服务读状态一抛错就落进 catch——一次已成功的验令牌回报 `ok:false`，还往面板事件流写一条假 `error`（事件流是该面板的独家数据源）。补 `.catch(() => null)`，与失败分支同形。钉子：`routes.test.mjs` 的 probe 节（阴性对照：`actual false` / `expected true`）。
- **「忘掉令牌」整条丢掉 body.ok**：`postJson` 只把 HTTP/解析失败折成 `null`，域失败是 `{ok:false, error}`；`saveToken` 与 provider 写入都检查了，唯独「忘掉令牌」直接往下走。而 Host 侧 `ms-auth.forget` 的失败是**刻意传播**的（凭据文件只读时抛错，其文件头写着「谎报成功比失败更糟——用户以为凭据已删干净」），于是界面上表现为「什么都没发生」。三个写回调收敛到 `http.ts#writeFailure` 一份判据。钉子：`panel.test.mjs` §8/§8b（阴性对照：§8b 的 `match` 红）。

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
