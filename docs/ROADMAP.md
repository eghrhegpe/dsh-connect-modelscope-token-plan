# ROADMAP

## M0 — 仓库起步 + Spike（已完成，2026-10-04）

- 仓库骨架：package.json / cordis.patch.yml / tsconfig / tsdown / .gitignore，
  与姊妹插件（sensenova/agnes）同构。
- Spike 完成：上游无额度信号，v1 定为本地计数派（[SPIKE.md](SPIKE.md)）。

## M1 — Host 半边最小竖切

文件清单（目标规模 ~1200 行，对照 sensenova 1.9 万行的裁剪结果）：

| 文件 | 职责 | 参考（sensenova） |
|---|---|---|
| `src/host/index.ts` | thin router：注册路由 + 挂载/卸载副作用；只强依赖 `webServer` | `index.ts` |
| `src/host/host-config.ts` | CONFIG_DEFAULTS / resolveSettings / isAdmitted 信任围栏 | `host-config.ts` |
| `src/host/ms-auth.ts` | 令牌读取：凭据服务 `MODELSCOPE_API_KEY` 引用（kind `api-key`）→ 内存 → 环境（模块自身读序；注意 service.resolve 存在时环境快照经凭据服务**压过**面板保存值，见 README 坑与 ms-auth 文件头）；零额度有效性探针（已真机回填：401/403=坏、200/400=好） | `token-store/*` 的极简替代 |
| `src/host/inference-client.ts` | `/v1/models`（免认证，带缓存+单飞）、429/401/400 分诊 | `console-client.ts` + `coalesced-fetch.ts` |
| `src/host/usage-store.ts` | 本地计数：天桶（`trendDays`）、每模型计数、429 事件流；原子写 0600，profile 分段 | `state-store.ts` + `throttle-store.ts` |
| `src/host/snapshot-aggregate.ts` | 软失败聚合：每个源 `soft()` 包裹，严格区分 null 与 0 | `snapshot-aggregate.ts` |
| `src/host/routes.ts` | 只读快照路由 `GET /api/<name>/snapshot`（HTTP 恒 200，成败看 body）+ `GET /api/<name>/models` | `routes.ts` |
| `src/shared/wire.ts` | Host ⇄ Client 契约（type-only） | `wire.ts` |

红线（沿 AGENTS.md 家规）：

1. 凭据只进 DSH 凭据服务 / env，永不入库、永不进日志；
2. credentials 记录 kind 只能是 `grant` / `api-key`，私有状态一律进插件状态文件；
3. Host 侧改动必须完全重启 DSH 才生效（README 已声明）。

## M2 — Client 半边（面板）（已完成）

- `src/client/`：index（三世界注册）/ apply（`plugins.bundle.config` 槽）/
  panel-page（三 tab：额度 / 模型 / 接入）/ cards / const / http / i18n（zh+en）
  / runtime（React seam）/ styles / snapshot（决策层）/ format / use-snapshot-polling
  / use-polling-interval。
- React 由 loader 注入，`h()` + 内联 style token，无 JSX。
- 「额度」tab 头条 = **官方魔粒余额**（spike 后记的升级）；本地计数带口径标注。
- 模型 tab：**只有**「接入为 DSH 模型」区块（provider 开关 + roster 勾选）。
  ~~每行「试调」按钮~~ 与底部的「模型目录（免认证，不耗额度）」表已在 M4+
  的面板收敛里删除——roster 本身就是「接入后实际提供哪些模型」，免认证目录表
  与它并排只是重复；usage probe 只服务那张表，随之移除。零额度的 validity
  probe（验令牌）留在「接入」tab。服务端的 `kind:"usage"` 分支当时留着，第六轮
  才随「它是缺省值、会消耗额度」一并删除。

## M3 — 测试 + 装机验证（进行中）

- 离线套件（裸 node + strip-types）：wire / config / usage-store / routes / panel
  / doctor —— 全绿；panel 套件加载**构建产物** client.js（替身 React 渲染 PanelPage）。
- 真机冒烟已过（真令牌 + 真上游，只读零额度）。
- doctor 工具已落地（tools/doctor.mjs + src/host/doctor.ts，只读盘点）。
- 待做：e2e（真 Host + 假魔搭平台）、build-freshness 门禁。
- **测试绿之后**装机：`dsh plugin --profile <profile> add <本目录绝对路径>`，
  重启 DSH 验证。

## M4 — 正式接入 DSH 作为 LLM provider（已完成，2026-10-04）

- ✅ **provider 注册**：`registerProvider`（id `modelscope-token-plan`，直连 apiBase，
  OpenAI 兼容）。`llm-models.ts` 目录→descriptor、`llm-adapter.ts` +
  `llm-adapter-core.ts` 装配（inert pi-ai auth + image hook）、`publish-core.ts` +
  `provider-publish.ts` 状态机（publish 队列 / disposed 闸 / registerPair 单点 +
  rollback 恢复旧对）、`provider-store.ts` 面板开关 + 允许清单（按 profile 分段）、
  `routes/provider.ts` 三条路径。设计契约见 [PROVIDER-M4.md](PROVIDER-M4.md)。
  ~~注册后 DSH 的全部魔搭调用都经本插件，本地计数即涵盖全部 DSH 魔搭调用~~——
  **这句当时是错的**（M4 单次提交内doc/code 漂移：适配器路径没挂计数钩子，
  `recordCall` 全仓只在 probe 一处调用），M4+ 已由 `usage-observer` 补上，见下。
- ✅ **面板「接入为 DSH 模型」**：模型 tab 顶部 provider 区块（开关 + roster 勾选 +
  全部/全部隐藏/保存清单/回到默认）。~~原「试调」按钮保留为次要动作~~ —— 该按钮
  随后在 M4+ 面板收敛里删除（见上）；roster 里 deepseek/glm/qwen 三家改挂一枚
  「推荐」pill，取代目录表时代的整行染色。
- ✅ **429 自愈接入**：`llm-retry.ts`（QUOTA 快速失败 vs RATE_LIMIT 退避）+
  `llm-error-fix.ts`（peer 把限频 429 误判成 QUOTA 的纠正层）——复用姊妹插件两件套。
- ✅ 离线测试：`test/provider.test.mjs`（目录映射 / 开关+清单 / publish 三条语义）、
  `test/provider-routes.test.mjs`（路由形状 / 哨兵 / 信任围栏）。
- ✅ `docs/PROVIDER-M4.md`：本次改动的实现契约 + 三条承重语义说明。

## M4+ — 0.1.0 发版前收口（已完成，2026-10-05）

- ✅ **本地计数接上真实对话**（`src/host/usage-observer.ts`，peer-free）：观察 harness
  流出口，一次遍历拿到 token 与失败分类。在此之前面板三块（今日调用 / 分布 / 趋势 / 429
  事件流）**恒为 0 与空**——`recordCall` 唯一的生产者是 usage probe，而那个按钮已随目录表
  删除。**恒为 0 是合法状态，没有任何门禁会红**，靠 `tools/doctor.mjs` 盘点磁盘真相才抓到。
  （第六轮补删了服务端残留的 `kind:"usage"` 分支，`recordCall` 的写入侧从此只有本模块。）
- ✅ **能力分类器** `resolveModelCapability`：二值 vision 升级为七档能力路由，判定走详情
  端点 `Tasks[].Name`，`KNOWN_VISION_IDS` 14 条实测吃图模型兜底，全不认识则 `unknown`。
- ✅ **发版链路**：`screenshots.json` 清单 + `files` 白名单补 `assets`；新增
  `test/release.test.mjs`（SCREENSHOTS / SHIPPED 两道门禁）。此前 `assets/` 长期未跟踪且
  不在 `files` 内——直接投稿必然图裂。
- ✅ **文档**：8 个内部里程碑节压成一节 `## [0.1.0]`，实施过程（病灶/ 取证 / 判据）搬进
  [IMPLEMENTATION.md](IMPLEMENTATION.md)；新增 [../RELEASING.md](../RELEASING.md)。
- 离线套件全绿，typecheck / build 全绿。（数量以 `package.json` 的 test 脚本为准——
  写死的数字只会越漂越远；`test/docs.test.mjs` §6 现在会盯着这类断言。）

### M4 之后（backlog，未做）

- **e2e**（真 Host + 假魔搭平台）进 CI 门禁；
- **余额差值趋势**：usage-store 记录每日首末两次官方余额观察，日消耗 = 首减末——官方数据的日消耗曲线（OpenAPI 无记录端点，只能这样做，见 REFERENCES）；
- `GET /users/me` 展示账号名（官方 OpenAPI 端点，端点家族盘点见 REFERENCES）；
- 「每日签到领魔粒」提醒：签到是**网页行为**（登录态访问 magicube/usage 页触发，非 API），只能做面板外链 + 待办提醒，见 REFERENCES 的 userscripts 上游；
- ~~按模型探测 `reasoning_effort` 档位表后，再按模型开启思考~~——**已探测，判定不可行**（第九轮，
  2026-10-05 真机）：魔搭对 `reasoning_effort` 既不校验值（`"bogus"` 也 200）也不保证生效，且端点
  在真响应与空壳 200 之间摇摆，无法区分「生效」与「静默忽略」，档位表做不出来。理由详见
  PROVIDER-M4.md §4 的更正块。`reasoning: false` 保持。
