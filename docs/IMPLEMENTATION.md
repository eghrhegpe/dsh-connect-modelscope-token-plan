# IMPLEMENTATION — 0.1.0 的实施过程档案

> **这份文件是什么**：`CHANGELOG.md` 记「变了什么」，本文件记**「为什么这么变」**——每一轮的
> 病灶、取证、判据、以及那些「看起来能省但不能省」的取舍。发版时压缩过程进CHANGELOG 会把
> 它们埋进 git历史，而其中不少是**踩过的坑**：照着做能绕开，不知道就再踩一遍。
>
> **与 `PROVIDER-M4.md` 的分工**：`PROVIDER-M4.md` 是 **provider 怎么接入**的契约（目录→descriptor
> 映射、发布状态机、快照形状）——写代码前照它做。本文件是**接入过程中发生了什么**——写完
> 代码后回头看它，才知道哪些地方看着多余却不能删。
>
> **按时间倒序**，每节标注对应的 CHANGELOG 条目。

---

## 截图接进发版链路（`release.test.mjs` 门禁）

**病灶**：三张截图长期挂在 `?? assets/`（未跟踪），`package.json` 的 `files` 白名单**既没有
`assets` 也没有 `screenshots.json`**（后者根本不存在），README 一张图都没引用。三者叠加，
市场投稿指南里那条「截图通过插件仓库自己的 `screenshots.json` 声明」对本仓**完全落空**：
清单不存在，市场页只能回退去抓 README 里的图，而README 里没有图。

姊妹插件 agnes 2026-10-01 在这件事上栽过一次：`assets/` 与 git 都换了新名，唯独
`screenshots.json` 还指着两个已不存在的文件——工作树干净、构建通过、其余检查全绿，
**没有任何东西在报错**，而市场按这份清单取图，推上去就是图裂。本仓比那次更早：不是清单
指空，是清单压根不存在。

**修法**：新建 `screenshots.json`（额度/ 模型两张 tab 截图）；`files` 补 `assets` 与
`screenshots.json`；README「面板长什么样」一节上图，且**`assets/` 与清单必须同一次提交**
（改名就必须同步清单——这是那次事故的直接教训）；新增 `test/release.test.mjs`。

**门禁为什么必须两段判据**：

| 段 | 抓什么 | 为什么单查磁盘抓不到 |
|---|---|---|
| SCREENSHOTS | 清单里的图在磁盘上存在、是真图、条目数 1–8 | —— |
| SHIPPED | 清单里的图**被 `files` 白名单打包** | 「磁盘有 + 清单有 + 包里没有」——本地一切正常，装到用户机器上的包缺图 |

**逆检查也补了**：`assets/` 存在而 `files` 不含它时直接报红。
（姊妹仓 sensenova 就有这个洞：磁盘有图、`files` 无 `assets`。）

**门禁自己必须验过会红**：把清单改成指向 `assets/does-not-exist.png` 后跑，`exit=1`、报
「清单指空，市场按它取图必然裂」；恢复后重新全绿。一条从没红过的门禁和没有门禁等价。

**踩坑：`npm pack --dry-run --json` 解析失败**。`prepack` 会跑 tsdown，构建日志
（`ℹ tsdown v0.23.0...`）混进 stdout，JSON 解析直接炸。加 `--ignore-scripts` 绕开。

**`icon-preview.png` 不进清单**：它是卡片头部的 icon + 标题条示意，不是面板 tab 截图。市场按
清单取图是给「AppStore 式大图」用的，混进去等于用一张装饰图占掉一个图位。仍随包发布。

---

## 本地计数层在接入 provider 之后没有任何生产者

**病灶**：`usageStore.recordCall` 全仓只有 `routes/probe.ts` 一处调用，且只在
`kind:"usage"` 分支。而面板的 usage 试调按钮已随目录表删除（client 只发 `kind:"validity"`，
validity 按设计不记调用），接入 provider 后 DSH 的真实对话走 pi-ai 适配器、**没有任何计数
钩子**。

于是「额度」tab 的三块面板——今日调用、单模型分布、趋势、429 事件流——**恒为 0 与空**。唯二
能往事件流里写东西的动作是手动点「验令牌」且恰好失败。插件叫 `-token-plan`，
`quota.note` 写着「本地口径：只统计经本插件的调用」，而经本插件的调用从未被计过。
`tools/doctor.mjs` 现场佐证：磁盘上 1 个天桶、0 条事件。

**这类病的形状**：「计数的生产者没了」不会报错——**恒为 0 是一种合法状态**，没有任何门禁会红。
`tools/doctor.mjs` 之所以能当场抓到，是因为它盘点的是磁盘真相而非内存状态。

**修法**：新增 `src/host/usage-observer.ts`（peer-free，纯函数 + 生成器，离线可测）观察
harness 流出口——`StreamChunk` 自带 `{type:'usage', usage: TokenUsage}` 与带
`reason.failure` 的 `finish` chunk，**一次遍历同时拿到 token 与失败分类**，不必碰provider
私有 API，也不必改 vendor peer。接线：`llm-adapter.ts` 组合观察层 → `provider-publish.ts` 的
deps 增加 `usage?: UsageSinks` 并透传给工厂 → `index.ts` 把上面那个 usage-store 的两条方法
接上（写**同一个** store 实例，所以面板读到的就是这里写的账，不会分叉到别的 profile 目录）。

**不重复造第二本账**：DSH 自己有 `@linxin666/dsh-usage`，按 `days→provider→model` 折 token，
但它只订阅 session 的 `assistant/message`——**失败调用一次都不记**。所以边界划在这里：成功
的 token 总量交给全局账本（插件不重复记），本插件只生产全局账本答不了的两件：①经本插件的
分布/趋势；②**429/错误事件流**（官方只给总额度余额，不给「哪个模型刚才在限频」）。

**顺序承重**：观察层套在 `llm-error-fix` 重分类层**之外**，事件分诊读的是改写后的 code。顺序
反了，被纠正成 `RATE_LIMIT` 的 rpm 限频会被记成 `quota`——面板说「额度耗尽」而退避策略在同
一刻按限频处理，两边说两套话。

**刻意不动 `llm-adapter-core.ts`**：那个文件是三族插件受控复制的共享层，往里加一个只有魔搭
需要的观测钩子，等于给三份副本之间再造一个漂移面（`patchPayload`、签名比对、三态口径都栽在
这类地方）。观察层独立成文件、由魔搭自己的 `llm-adapter.ts` 组合；**无 sinks 时不套 Proxy**，
那条路径零开销。

**记账口径**：每次流结束记一次 call（正常/用户中断/内层抛错都走同一个 `finally`），**含
失败**——魔搭按次数计费，限频掉的请求同样是一次上游调用；token 上游没给时是 `null` 而非0。
写 sinks 的任何失败（同步抛与异步拒）都在 `safe()` 里吞掉：**观测失败不是对话失败**。已知
偏差方向是**少记**（peer 的重试在同一条流内部重发，观察器只看到一条流）——宁可少记也不虚增。

---

## 重启丢清单、轮询空转失效、计数与分类口径漂移

这一节五处修复**同源**：M4 单次提交 `8c9dc53` 内 doc/code 漂移——`docs/PROVIDER-M4.md` 写明
「开关/清单落盘在 provider-store」，但 `index.ts` 轮询从未迁移去读落盘值；签名比对在文档与
设计意图里存在，实现却漏接。

- **重启后允许清单静默丢失**：`index.ts` 的目录轮询原本读 `publisher.state.enabledIds`
  （**纯内存，重启即空**）当允许清单，而 `provider-store` 其实**已落盘**该清单。改为
  `runPoll()`：拉目录后从 `providerStore.enabledIds()` 读落盘清单（读不到回退内存），再
  `publish`；挂载时立即 `runPoll()` 取代原来的空`publish([], [], [])` seed。
- **轮询签名空转从未接线**：`provider-publish.ts` 注释声称「按 `catalogSignature` 比对，未变则
  空转」，但 `publishProviderOnce` 从不做比较——于是每 30s 轮询都**完整摘下再挂上同一个
  provider 对**，期间在途请求可能被打断。修法：`catalogSignature` 扩展到覆盖 `name` /
  `contextWindow` / `maxOutputLength`；注册/注销两条路径都在「offer 与失败状态都没变」时返回
  `{ok:true, skipped:true}` 空转，并在每次成功 `publish` 后调`syncSignaturesAfterPublish(state)`
  同步基准。
- **`allowed` 三态分类两处口径漂移**：`snapshot-aggregate.ts` 用
  `includes(HIDE_ALL_MODELS)→"none"`，`routes/provider.ts` 用
  `length===1 && [0]===sentinel →"none"`——`["__hide_all__","other"]` 会被后者错判成
  `"list"`。抽出唯一口径 `resolveAllowedList(enabledIds)`（空=`"all"` / 含哨兵=`"none"` /
  其余=`"list"`）放 `llm-models.ts`，两处统一调用。
- **`enabledCount` 两处算法不一致**：`routes/provider.ts` 用 `enabledIds.length`（含过期/哨兵
  id 虚增计数），`snapshot-aggregate.ts` 用 `roster∩allowSet`。现两处都按「roster 中真正
  命中的条数」计。
- **快照读取持久清单**：`snapshot-aggregate.ts` 原从内存读清单，与上面同样的重启丢失问题。
- **`cordis.patch.yml` 计数范围写错**：原文称注册 provider 后「本地计数同时覆盖全部 DSH 魔搭
  调用」，但适配器路径没有挂计数钩子，本地计数只反映探测用量。已更正注释。

**幽灵测试引用**：`switch-precedence.ts` / `llm-retry.ts` / `llm-error-fix.ts` 注释引用的
`test/peer-contract.test.mjs` 依赖未vendored 进仓库的运行时 peer。改为说明该契约测试在
`npm test` 离线门禁之外，并补上三个**纯函数**离线套件钉死本模块自身行为
（`switch-precedence` / `retry` / `error-fix`）。

**通用教训**：注释与 doc 里的「已实现」**不构成实现**。签名比对、落盘读取这类「设计意图里存在
但没人接线」的东西，只有对照真实调用链逐条grep 才能发现。

---

## 开关值写不进磁盘、保存开关会抹掉清单

**两个 bug 同源**：`provider-store.ts` 的 `patchPayload` 带了个 `mergeEnabled` 参数，该参数对
`enabled` **无条件**走「保留磁盘现值」分支，于是 `save(value)` 转交的开关值被**静默丢弃**：
磁盘上没有 `enabled` 键时展开成 `{}`，写入的 payload 根本不含开关。同时 body 只在
`patch.enabledIds !== undefined` 时才带 `enabledIds`，而 `save()` 只传 `{enabled}`——所以
**每点一次开关都会把已保存的清单整个删掉**。

**症状的三个读数是同一件事**：点「保存清单」后开关变「未接入」、源标注「配置」、状态
「未注册」，但模型列表照旧完整可见。`enabled` 从未落盘 → `store.enabled()` 返回 `null` →
`resolveSwitchEnabled(null, false)` = false → 开关与源；`registered` 走 `registerWanted=false`
分支 → 「未注册」；而 roster 渲染**不读开关**（来自 `inference.fetchModels()` 的目录条目），
所以模型全在。面板当场显示正确值是因为 `cache.remember()` **绕过了磁盘**，30s 后轮询
`use-snapshot-polling.ts` 重读磁盘就把开关打回原样。

**修法**：`patchPayload(patch)` 改为一参，`enabled` 与 `enabledIds` **对称**三态——省略
（`undefined`）保留磁盘键、显式 `null` 清成「键不存在」（`forget()` 的语义，原先靠写
`"enabled": null` 侥幸工作）、其余值照存。三处调用点（`save` / `saveEnabledIds` / `forget`）
同步收敛为单参。

**测试为什么全盲**：`test/provider.test.mjs` 原先只经 `store.enabled()` 断言，而它读的是
`cache.remember()` 填的内存值——**「面板显示对了」不等于「磁盘写对了」**，所以整套断言对这两个
bug 完全无效。新增**冷读**断言：另开一个空缓存 store 读同一目录，并直接解析 `provider.json`
核对两个键。**已确认新断言在有 bug 的代码上失败**（`开关值必须落盘，不能只活在缓存里`）。

**通用教训**：带缓存的持久层，「读」要断言**冷读**——绕过缓存直读磁盘。断言经缓存读，等于
在断言「内存里的东西对」。

---

## 面板收敛：删目录表、推荐改小卡片

- **删掉「模型目录（免认证，不耗额度）」整张表**。`/models` 是免认证的裸 id 列表，而同一 tab
  顶部的 provider roster 已经是「接入后实际提供哪些模型」（带可用性/ 额度耗尽 / 视觉标记）
  ——两份列表并排只会让人对着两个数字发愣。`MODELS_PATH` 不再被 client 读取，Host 路由保留
  （无请求即无成本）。
- **逐行「试调」按钮一并删除**（usage probe）。它只服务那张表，且**不在 DSH 的调用路径上**
  （真调用经 provider adapter）；**零额度的 validity probe（验令牌）保留在「接入」tab**，
  `POST /probe` 路由不动。相邻的 `runProbe` 状态机、试调结果/错误行、`probeBusy` 随之移除。
- **高亮降级为推荐卡片**：原先deepseek/glm/qwen 三家在目录表里**整行染色**（左边线 + 底色 +
  圆角 + ★ + 品牌色加粗名），把「一批里的三个 owner」渲染成了「被选中的三行」。现在 roster
  每行只挂一枚 **「推荐」pill**，与既有的「视觉」pill 同构（同尺寸/同底色，仅字色用品牌色）
  ——行背景、名字字号一律不动。

**词汇表随之收敛**：删 `section.catalog` / `models.count` / `models.fetched` /
`models.probeUsage` / `models.probeKept` / `probe.usage` / `probe.busy` / `probe.ok`
（zh/en 同步）；新增 `provider.featured`。`catalogOwner` / `sortCatalogIds` /
`FEATURED_OWNERS` 仍是承重导出（roster 判定 + `catalog.test.mjs` 冻结的排序契约）。

---

## 能力分类器 `resolveModelCapability`

把二值「是不是 vision」升级为能力路由：返回
`ModelCapability = unknown|text|vision-input|image-to-text|image-to-image|text-to-image|text-to-video`；
`isVisionModel` 退化为它的布尔投影（`vision-input` / `image-to-text` 才算吃图，图出图 / 文生图
不算）。

**判定顺序（权威→兜底）**：结构化 `input_modalities` → 详情端点 `Tasks[].Name` 任务标签
（多标签按 `CAPABILITY_RANK` 取最具体）→ 策展清单 `KNOWN_VISION_IDS` → 名字启发；有标签但全
不认识 → `unknown`，**绝不猜**。

**词表真机核实（2026-10-04）**：api-inference 35 条目录只出现
`text-generation`(16) / `image-text-to-text`(14) / `image-to-image`(2) /
`text2text-generation`(1)，**没有任何模型被标成正则扩展位里的词**，故 `VISION_INPUT_TASKS` 实际
只命中 `image-text-to-text`（扩展位保持防御性，未放宽到会误伤图出的词）。详情端点对文生图返
`text-to-image-synthesis`、文生视频 `text-to-video-synthesis`。

⚠️ **能力标签 ≠ 可用端点**：api-inference 目录里目前**没有**文生图模型。

`KNOWN_VISION_IDS` 由 2 条补全到全部 14 条实测吃图模型——其中 `MiniMax-M3` / `Intern-S1` 系列 /
`Step-3.7-Flash` **名字不含 vl/vision**，名字启发会漏，详情端点整段不可达时也要保住准确视觉
标签。（`early-access/EA-29B-A4B` 详情端点 404、`Step-3.5-Flash` 无 Tasks，均自动回退名字启发。）

---

## 正式接入 DSH 作为 LLM provider（M4）

**provider 注册**（id `modelscope-token-plan`，直连 apiBase，OpenAI 兼容）的承重文件清单与
设计契约见 [PROVIDER-M4.md](PROVIDER-M4.md)，此处只记实施中额外查证到的三件事。

**vision 判定为什么不用 models.dev**：`/v1/models` 仍无模态字段，但详情端点
`Data.Tasks[].Name` 提供精确任务标签（`image-text-to-text`=图进文出=能吃图；
`image-to-image` / `text-to-image`=图出，排除）。`fetchModels` 拿到目录 id 后**并行拉取**（有界
并发 6、`Promise.allSettled`、单失败不影响整体）每个详情。免认证、零推理额度。
详见 [REFERENCES.md](REFERENCES.md) 与 [REFERENCE-modelsdev.md](REFERENCE-modelsdev.md)——后者
记录 `anomalyco/models.dev` 的编码方式及**为何不用作 drop-in 数据源**（它对魔搭仅收编 7 个纯
文本模型，不含 `DeepSeek-V4.1-Flash` 等视觉模型）。

**为什么魔粒余额是主数据源**：`GET /openapi/v1/magicubes/balance` 真实可用（见
[SPIKE.md](SPIKE.md)），而推理响应本身**不带任何额度头**。同日实测推翻了 Spike 的一半结论。
次数口径的「推算剩余 / 参考上限」因此**从面板移除**——官方改魔粒计费后两个单位并排是误导；
`dailyQuotaTotal` / `dailyQuotaPerModel` 两个社区快照常数**也从配置里一并删除**（面板不消费
它们，留着只会让人以为能算「还剩几次」）。真要加阈值提醒时，那应该是读官方余额的差值，
不是这两个数；`test/config.test.mjs` 已钉住它们不会回来。

**模型目录排序**：`/v1/models` 原始返回序把三家好用模型拆散（deepseek 在顶、Qwen 在中间、
glm/ZhipuAI 在底）。新增 `FEATURED_OWNERS`（`deepseek-ai` / `ZhipuAI` / `Qwen`）与
`sortCatalogIds`：featured 置顶分组、其余按 owner 字母序、同 owner 内按 id 字母序。

**429 响应形状未实测**（不值得烧额度去触发），解析按 OpenAI 惯例兼容，漂移时面板给
`shapeWarnings`。

---

## 仓库起步与审核修复

- **仓库起步**：清单 / 配置面 / 构建纪律（与姊妹插件同构）。`npm run build` 产物
  （`lib/` + `client.js`）**入库**——`files` 白名单不含 `lib/`，不入库则 GitHub 直装的包没有
  宿主入口。
- **`tools/doctor.mjs` 落地**（+`src/host/doctor.ts`）：只读盘点 `$DSH_HOME/state` 下各
  profile 的 usage.json（损坏/ 未知版本 → 症状）与 env 令牌在场性；**绝不写盘、绝不打印令牌值**。
  它的真正价值是抓「恒为 0 / 恒为空」这类不会报错的状态。
- **快照失败线格式统一为 `{ok, code, error}`**：`wire.ts` 的 `SnapshotFailure` 此前声明
  `message`，与路由写入、client 读取漂移。
- **单模型 tokens 改今日口径**（`dayTokens`，跨日清零）：原「今日」行并排历史累计是误导；v1
  加性字段，旧载荷缺失按 0 起，`STATE_VERSION` 不变。
- **`reasoning` 恒为 false 是保守默认**：魔搭 API-Inference 是多模型代理，是否吃
  `reasoning_effort` 取决于背后那个模型；本插件无法离线得知每个 id 的档位表。「宁可不选，
  不可错发」——发错档位会整条请求 400。
- 真机冒烟：魔粒余额 143、模型目录 35、零漂移警告。
