# Changelog

## 0.1.0-M4+（未发布）— 修：本地计数层在接入 provider 之后没有任何生产者

- **病灶**：`usageStore.recordCall` 全仓只有 `routes/probe.ts` 一处调用，且只在
  `kind:"usage"` 分支。而面板的 usage 试调按钮已随目录表删除（client 只发
  `kind:"validity"`，validity 按设计不记调用），接入 provider 后 DSH 的真实对话
  走 pi-ai 适配器、**没有任何计数钩子**。于是「额度」tab 的三块面板——今日调用
  （`cards.ts` 的 `daily.usedLocal`）、单模型分布、趋势、429 事件流——**恒为 0 与
  空**，唯二能往事件流里写东西的动作是手动点「验令牌」且恰好失败。插件叫
  `-token-plan`，`quota.note` 写着「本地口径：只统计经本插件的调用」，而经本插件
  的调用从未被计过。`tools/doctor.mjs` 现场佐证：磁盘上 1 个天桶、0 条事件。
- **修法**：新增 `src/host/usage-observer.ts`（peer-free，纯函数 + 生成器，离线可测）
  观察 harness 流出口——`StreamChunk` 自带 `{type:'usage', usage: TokenUsage}` 与
  带 `reason.failure` 的 `finish` chunk，一次遍历同时拿到 token 与失败分类，不必碰
  provider 私有 API，也不必改 vendor peer。接线：`llm-adapter.ts` 组合观察层 →
  `provider-publish.ts` 的 deps 增加 `usage?: UsageSinks` 并透传给工厂 →
  `index.ts` 把上面那个 usage-store 的两条方法接上（写**同一个** store 实例，所以
  面板读到的就是这里写的账，不会分叉到别的 profile 目录）。
- **不重复造第二本账**：DSH 自己有 `@linxin666/dsh-usage`，按
  `days→provider→model` 折 token，但它只订阅 session 的 `assistant/message`
  ——**失败调用一次都不记**。所以边界划在这里：成功的 token 总量交给全局账本（插件
  不重复记），本插件只生产全局账本答不了的两件：①经本插件的分布/趋势；②**429/
  错误事件流**（官方只给总额度余额，不给「哪个模型刚才在限频」）。
- **顺序承重**：观察层套在 `llm-error-fix` 重分类层**之外**，事件分诊读的是改写
  后的 code。顺序反了，被纠正成 `RATE_LIMIT` 的 rpm 限频会被记成 `quota`——面板
  说「额度耗尽」而退避策略在同一刻按限频处理，两边说两套话。
- **刻意不动 `llm-adapter-core.ts`**：那个文件是三族插件受控复制的共享层，往里加一个
  只有魔搭需要的观测钩子，等于给三份副本之间再造一个漂移面（`patchPayload`、签名
  比对、三态口径都栽在这类地方）。观察层独立成文件、由魔搭自己的 `llm-adapter.ts`
  组合；无 sinks 时**不套 Proxy**，那条路径零开销。
- **记账口径**：每次流结束记一次 call（正常/用户中断/内层抛错都走同一个 `finally`），
  **含失败**——魔搭按次数计费，限频掉的请求同样是一次上游调用；token 上游没给时是
  `null` 而非 0。写 sinks 的任何失败（同步抛与异步拒）都在 `safe()` 里吞掉：观测
  失败不是对话失败。已知偏差方向是**少记**（peer 的重试在同一条流内部重发，观察器
  只看到一条流）——宁可少记也不虚增。
- **测试**：新增 `test/usage-observer.test.mjs`（已接入 `npm test`，现 14 套件），
  钉死 token 读取/累计值语义、429 四类分诊、`aborted` 不算事件、凭据脱敏、
  透传不丢 chunk、失败/中断/崩溃三种结束都恰好记一次、sinks 炸了不影响对话、
  `options.model` 缺失就不记（分布图不能凭空多出一行）、`prepareCall` 两条路都包。
- 全量 `npm test`（14 套件）、`npm run typecheck`、`npm run build`、`npm run doctor` 全绿。

## 0.1.0-M4+（未发布）— 修：重启丢清单、轮询空转失效、计数与分类口径漂移

- **重启后允许清单静默丢失（fix A / fix C）**：`index.ts` 的目录轮询原本读
  `publisher.state.enabledIds`（纯内存，重启即空）当允许清单，而 `provider-store`
  其实**已落盘**该清单。改为 `runPoll()`：拉目录后从 `providerStore.enabledIds()`
  读落盘清单（读不到回退内存），再 `publish`；挂载时立即 `runPoll()` 取代原来的空
  `publish([], [], [])` seed，使重启的 Host 用用户保存的清单注册而非空清单。
- **轮询签名空转从未接线（fix B）**：`provider-publish.ts` 注释声称「按
  `catalogSignature` 比对，未变则空转」，但 `publishProviderOnce` 从不做比较——于是
  每 30s 轮询都完整摘下再挂上同一个 provider 对，期间在途请求可能被打断。现补上：
  - `catalogSignature` 扩展到覆盖 `name` / `contextWindow` / `maxOutputLength`（任一属性
    翻了也会触发重建，与 descriptor 形状一致）；
  - 注册 / 注销两条路径都在「offer 与失败状态都没变」时返回 `{ok:true, skipped:true}`
    空转；并在每次成功 `publish` 后调用 `syncSignaturesAfterPublish(state)` 同步基准。
- **`allowed` 三态分类两处口径漂移（fix D）**：`snapshot-aggregate.ts` 用
  `includes(HIDE_ALL_MODELS)→"none"`，`routes/provider.ts` 用 `length===1 && [0]===sentinel
  →"none"`——`["__hide_all__","other"]` 会被后者错判成 `"list"`。抽出唯一口径
  `resolveAllowedList(enabledIds)`（空=`"all"` / 含哨兵=`"none"` / 其余=`"list"`）放
  `llm-models.ts`，两处统一调用；`filterByEnabled` / `isModelEnabled` 也按哨兵=「什么都不
  提供」对齐。
- **`enabledCount` 两处算法不一致（fix D 续）**：`routes/provider.ts` 用
  `enabledIds.length`（含过期/哨兵 id 虚增计数），`snapshot-aggregate.ts` 用
  `roster∩allowSet`。现两处都按「roster 中真正命中的条数」计（`"all"`=roster 全量、
  `"none"`=0、`"list"`=命中数）。
- **快照读取持久清单（fix E）**：`snapshot-aggregate.ts` 原从内存
  `publisher.state.enabledIds` 读清单，与 fix A 同样的重启丢失问题；改为优先
  `providerStore.enabledIds()`、回退内存。
- **`cordis.patch.yml` 计数范围写错（fix G）**：原文称注册 provider 后「本地计数同时覆盖
  全部 DSH 魔搭调用」，但适配器路径没有挂计数钩子（grep 确认 `recordCall` 只在 probe /
  usage-store），本地计数只反映探测用量。已更正注释，避免误导。
- **幽灵测试引用（fix F）**：`switch-precedence.ts` / `llm-retry.ts` / `llm-error-fix.ts`
  注释引用的 `test/peer-contract.test.mjs` 依赖未 vendored 进仓库的运行时 peer。改为说明
  该契约测试在 `npm test` 离线门禁之外，并补上三个**纯函数**离线套件钉死本模块自身行为：
  `test/switch-precedence.test.mjs`、`test/retry.test.mjs`、`test/error-fix.test.mjs`（已
  接入 `package.json` 的 test 脚本，现共 13 套件）。
- 根因：上述重启丢清单 + 空转失效均源于 M4 单次提交 `8c9dc53` 内 doc/code 漂移——
  `docs/PROVIDER-M4.md` 写明「开关/清单落盘在 provider-store」，但 `index.ts` 轮询从未
  迁移去读落盘值；签名比对在文档与设计意图里存在，实现却漏接。
- 全量 `npm test`（13 套件）、`npm run typecheck`、`npm run build` 全绿。

## 0.1.0-M4+（未发布）— 修：开关值写不进磁盘、保存开关会抹掉清单

- **`provider-store.ts` 的 `patchPayload` 去掉 `mergeEnabled` 参数**（两个 bug 同源）。
  该参数对 `enabled` 无条件走「保留磁盘现值」分支，于是 `save(value)` 转交的开关值
  被**静默丢弃**：磁盘上没有 `enabled` 键时展开成 `{}`，写入的 payload 根本不含开关。
  同时 body 只在 `patch.enabledIds !== undefined` 时才带 `enabledIds`，而 `save()`
  只传 `{enabled}` —— 所以**每点一次开关都会把已保存的清单整个删掉**。
- **症状**（用户报告）：点「保存清单」后上面的开关变成「未接入」、源标注「配置」、
  状态「未注册」，但模型列表照旧完整可见。三者是同一件事的三个读数：`enabled` 从未
  落盘 → `store.enabled()` 返回 `null` → `resolveSwitchEnabled(null, false)` = false
  → 开关「未接入」+ 源「配置」；`publisher.state.registered` 走 `registerWanted=false`
  分支 → 「未注册」；而 roster 渲染**不读开关**，它来自 `inference.fetchModels()` 的
  目录条目，所以模型全在。面板当场显示正确值是因为 `cache.remember()` 绕过了磁盘，
  30s 后轮询重读磁盘（`use-snapshot-polling.ts`）就把开关打回「未接入」。
- **修法**：`patchPayload(patch)` 改为一参、`enabled` 与 `enabledIds` **对称**三态 ——
  省略（`undefined`）保留磁盘键、显式 `null` 清成「键不存在」（`forget()` 的语义，
  原先靠写 `"enabled": null` 侥幸工作）、其余值照存。三处调用点（`save` /
  `saveEnabledIds` / `forget`）同步收敛为单参。
- **测试**：`test/provider.test.mjs` 原先只经 `store.enabled()` 断言，而它读的是
  `cache.remember()` 填的内存值 —— 「面板显示对了」不等于「磁盘写对了」，所以整套
  断言对这两个 bug 全盲。新增**冷读**断言：另开一个空缓存 store 读同一目录，并直接
  解析 `provider.json` 核对 `enabled` / `enabledIds` 两个键。已确认新断言在有 bug 的
  代码上失败（`开关值必须落盘，不能只活在缓存里`）、在修复后通过。
- 全量 `npm test`（10 套件）、`npm run typecheck`、`npm run build` 全绿。

## 0.1.0-M4+（未发布）— 面板收敛：删目录表、推荐改小卡片

- **删掉「模型目录（免认证，不耗额度）」整张表**（模型 tab 底部）。/models 是
  免认证的裸 id 列表，而同一 tab 顶部的 provider roster 已经是「接入后实际提供
  哪些模型」（带可用性 / 额度耗尽 / 视觉标记）——两份列表并排只会让人对着两个
  数字发愣。`modelsBody` 现在只有「接入为 DSH 模型」一个区块；`MODELS_PATH`
  不再被 client 读取，Host 路由保留（无请求即无成本）。
- **逐行「试调」按钮一并删除**（usage probe）。它只服务那张表，且不在 DSH 的
  调用路径上（真调用经 provider adapter）；**零额度的 validity probe（验令牌）
  保留在「接入」tab**，`POST /probe` 路由不动。相邻的 `runProbe` 状态机、
  试调结果/错误行、`probeBusy` 随之移除。
- **高亮降级为推荐卡片**：原先 deepseek/glm/qwen 三家在目录表里整行染色（左边线
  + 底色 + 圆角 + ★ + 品牌色加粗名），把「一批里的三个 owner」渲染成了「被选中的
  三行」。现在 roster 每行只挂一枚 **「推荐」pill**，与既有的「视觉」pill 同构
  （同尺寸/同底色，仅字色用品牌色）——行背景、名字字号一律不动。判定仍走
  `FEATURED_OWNERS` + `catalogOwner`（roster 用 `row.name` 显示、`row.id` 判定）。
- 词汇表随之收敛：删 `section.catalog`、`models.count`、`models.fetched`、
  `models.probeUsage`、`models.probeKept`、`probe.usage`、`probe.busy`、
  `probe.ok`（zh/en 同步）；新增 `provider.featured`。
- 无用的目录样式删除：`trendRowFeatured`、`trendModelFeatured`、`catalogStar`；
  新增 `modelBadgeFeatured`。`catalogOwner` / `sortCatalogIds` / `FEATURED_OWNERS`
  仍是承重导出（roster 判定 + `test/catalog.test.mjs` 冻结的排序契约）。
- 测试：`panel.test.mjs` / `catalog.test.mjs` 全绿（目录排序纯函数契约未动）；
  `npm run typecheck` / `npm run build` 全绿。

## 0.1.0-M4+（未发布）— 能力分类器 `resolveModelCapability`

- **把二值「是不是 vision」升级为能力路由**：新增 `resolveModelCapability(entry)`，
  返回 `ModelCapability = unknown|text|vision-input|image-to-text|image-to-image|
  text-to-image|text-to-video`；`isVisionModel` 退化为它的布尔投影
  （`vision-input` / `image-to-text` 才算吃图，图出图 / 文生图不算）。
- 判定顺序（权威→兜底）：结构化 `input_modalities` → 详情端点 `Tasks[].Name` 任务
  标签（`TASK_TO_CAPABILITY`，多标签按 `CAPABILITY_RANK` 取最具体）→ 策展清单
  `KNOWN_VISION_IDS` → 名字启发；有标签但全不认识 → `unknown`，**绝不猜**。
- 词表真机核实（2026-10-04）：api-inference 35 条目录只出现
  `text-generation`/`image-text-to-text`/`image-to-image`/`text2text-generation`；
  hub 详情端点对文生图返回 `text-to-image-synthesis`（`Qwen/Qwen-Image`、
  `FLUX.1-schnell`、`Z-Image-Turbo`），文生视频 `text-to-video-synthesis`。
  ⚠️ 能力标签 ≠ 可用端点：api-inference 目录里目前**没有**文生图模型。
- `normalizeEntry` 输出 `capability`，roster（`rosterOf` / `rosterWithAvailability`）
  与 provider 路由响应都带上 `capability`，供将来的出图 / 改图工具按能力路由。
- 测试：`provider.test.mjs` 增补任务标签→能力断言；`provider-routes.test.mjs` 断言
  roster 携带 `capability`。

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
- **模型目录排序 + 高亮**：原目录是 `/v1/models` 原始返回序，三家好用模型被拆散
  （deepseek 在顶、Qwen 在中间、glm/ZhipuAI 在底）。新增 `FEATURED_OWNERS`
  （`deepseek-ai`/`ZhipuAI`/`Qwen`）与 `sortCatalogIds`：featured 置顶分组、其余按
  owner 字母序、同 owner 内按 id 字母序；置顶行加 ★ 标记 + 品牌色左边线 + 加粗名
  （`styles.ts` 新增 `trendRowFeatured`/`catalogStar`/`trendModelFeatured`，仅视觉不改层级）。
- **第三方参考方案说明 `docs/REFERENCE-modelsdev.md`**：拉取 `anomalyco/models.dev`
  （Mastra 文档 `imageInput` 列的真正数据源），记录其用 `[modalities].input`
  含 `"image"` 标记视觉模型的编码方式；对比本插件「详情端点实时判定
  `Tasks[].Name == "image-text-to-text"`」方案——models.dev 对魔搭仅收编 7 个纯文本
  模型、不含 `DeepSeek-V4.1-Flash` 等视觉模型，故本插件不用其作 drop-in 数据源，
  文档并附可选的反哺 PR 路径。
  i18n zh/en 补 `models.featuredTitle`；新增 `test/catalog.test.mjs` 覆盖排序与高亮判定。
- **vision 判定升级为详情端点精确信号**：`/v1/models` 仍无模态字段，但
  `modelscope.cn/api/v1/models/{owner}/{name}` 的 `Data.Tasks[].Name` 提供精确任务标签
  （`image-text-to-text`=图进文出=能吃图；`image-to-image`/`text-to-image`=图出，排除）。
  `fetchModels` 在拿到目录 id 后**并行拉取**（有界并发 6、`Promise.allSettled`、单失败不影响
  整体）每个详情，标签挂到 `entry.tasks`，`isVisionModel` 据此精确判定；详情端点不可达时回退
  策展清单（`KNOWN_VISION_IDS`，降级为离线兜底）+ 名字启发。`inference-client.ts` 新增
  `mapWithConcurrency`/`fetchTaskTags`；`llm-models.ts` 新增 `VISION_INPUT_TASKS`/`tasksOf`。
  免认证、零推理额度（与余额同主机 siteBase）。新增 `test/inference-vision.test.mjs`（mock
  详情端点端到端验证）+ `provider.test.mjs` 补 4 条 tasks 断言。docs/REFERENCES.md「vision」
  一节据实重写（此前「零模态元数据、只能策展」的断言不准确）。
- **vision 词表真机全量核实 + 策展清单补全**：逐条拉当前 35 条目录的详情端点，确认任务名
  词表只有 4 个——`text-generation`(16)、`image-text-to-text`(14)、`image-to-image`(2)、
  `text2text-generation`(1)，**没有任何模型被标成正则扩展位里的词**，故 `VISION_INPUT_TASKS`
  实际只命中 `image-text-to-text`（扩展位保持防御性，未放宽到会误伤图出的词）。
  `KNOWN_VISION_IDS` 由 2 条补全到全部 14 条实测吃图模型——其中 `MiniMax-M3`/`Intern-S1`
  系列/`Step-3.7-Flash` 名字不含 vl/vision，名字启发会漏，详情端点整段不可达时也能保住准确
  视觉标签。`provider.test.mjs` 逐条断言 14 条兜底覆盖 + 3 条「名字无视觉 token 靠策展捞回」。
  （`early-access/EA-29B-A4B` 详情端点 404、`Step-3.5-Flash` 无 Tasks，均自动回退名字启发。）

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
