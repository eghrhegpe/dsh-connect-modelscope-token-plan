# Changelog

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
