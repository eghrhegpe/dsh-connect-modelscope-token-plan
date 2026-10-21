# 配置字段（人读清单）

> **这份文件是什么**：`cordis.patch.yml` 里 `config:` 下**每一个键**的人读表——叫什么、默认多少、
> 能被夹到哪、什么时候生效、为什么是这个值。
>
> **为什么单独成篇**：README 是给装它的人看的，`cordis.patch.yml` 是给改它的人看的（注释很长、
> 按「为什么留/为什么删」写）。但「我只想知道 `drawEnabled` 是干什么的」这件事，此前**只能读
> YAML 注释或源码**——`drawEnabled` 曾在全仓零文档，15 个键里 README 只提过 1 个。

**真源与优先级**

| 层 | 位置 | 谁说了算 |
|---|---|---|
| 字段语义 + 默认值 | `src/host/host-config.ts` 的 `CONFIG_DEFAULTS` | **代码** |
| 部署默认值 | `cordis.patch.yml` 的 `config:`（或在 profile 的 `cordis.patch.yml` 里覆盖同 id 字段） | 改配置的人 |
| 运行时覆盖 | 面板「模型」tab 的三个开关（`registerProvider` / `drawEnabled` / 首选出图模型） | **面板保存值优先于 patch 默认**，且立即生效（`drawEnabled` 的工具挂载例外，见 §3） |

改默认值要同时改三处：`CONFIG_DEFAULTS`、`cordis.patch.yml`、本表。**表里的数字与代码不一致
就是文档在骗人**——这张表的每一格都抄自上面那两处，不是回忆。

改完配置要**重装/重载插件**才生效（`registerProvider` / `drawEnabled` / 首选模型的**开关值**
除外，面板翻转即时生效；`drawEnabled` 的**工具挂载**例外）。

## 1. 源站

| 字段 | 默认 | 生效前提 | 说明 |
|---|---|---|---|
| `apiBase` | `https://api-inference.modelscope.cn/v1` | 合法的 http(s) 绝对地址 | OpenAI 兼容推理源站：模型目录（`/v1/models`）+ 探测/计数 + provider 直连。**不是合法绝对地址会在挂载时抛 `config_error`**（而不是等第一次轮询变成莫名其妙的网络错误）。平台搬端点时才需要动 |
| `siteBase` | `https://modelscope.cn` | 同上 | 站点源站，**只**用于面板里的外链（访问令牌页 / 文档页）；不参与任何 API 调用 |
| `allowedHosts` | `[]` | 字符串数组，**只增不替** | 追加可信 `Host` 名。默认已含 `localhost` / `127.0.0.1` / `[::1]` / `::1`；写进来的是**补充**，不能删掉默认那四条 |

## 2. 面板读数（趋势 / 事件 / 轮询）

| 字段 | 默认 | 硬夹 | 说明 |
|---|---|---|---|
| `trendDays` | `14` | 1 – `retentionDays` | 趋势图**显示**天数（面板标题「近 N 天」与图上柱数），面板里可改看多长 |
| `retentionDays` | `90` | 1 – 365 | 本地趋势**保留**天数（天桶修剪窗口，超出即删）。与 `trendDays` 是两件事：显示只决定「画多少」，保留决定「留多少」；显示窗口恒被夹在保留之内，所以「画得比留得多（把已剪的日子画成 0、与那天真没调用无法区分）」这个组合不会出现 |
| `maxEvents` | `50` | 1 – 1000 | 429/错误事件环形缓冲上限（面板只展示最近的） |
| `exhaustionWindowMinutes` | `60` | 5 – 1440 | 单模型「额度耗尽」的**推断**窗口：某模型最近在这个窗口内出现过 `kind=quota` 事件，picker 不再提供它、面板 roster 灰显，事件移出窗口即恢复。官方只有账户级魔粒余额、没有 per-model 额度端点，所以这是推断不是读数；**恢复不可观测**是已知代价（成功的调用不发事件，模型最多灰显满一个窗口） |
| `cacheSeconds` | `60` | 5 – 600 | Host 侧对 `/v1/models` 的缓存秒数；面板脚注直接引用此值 |
| `pollSeconds` | `30` | 5 – 3600 | 面板轮询间隔，由 Host 下发、面板跟随。**别调到几小时**：`pollSeconds × 1000` 超过 `2^31-1` ms 时 Node 会把 `setInterval` 的延时钳到 1 ms（`TimeoutOverflowWarning`），插件就变成每毫秒打一次魔搭目录——上界 3600 正是为了不让你走到那一步 |
| `inferenceTimeoutMs` | `30000` | 1000 – 600000 | 单次魔搭请求超时（毫秒）。只影响**对话/计数**那条链路，出图有自己的预算（§3） |

> 上述「硬夹」是 `clampInt` 的实际行为：越界值被**拉到边界**而不是报错，非数字回退默认值。

## 3. Provider 与出图（四个 opt-in 项）

| 字段 | 默认 | 面板可覆盖 | 说明 |
|---|---|---|---|
| `registerProvider` | `false` | ✓ 立即生效 | 把魔搭注册成 DSH 的 LLM provider（id `modelscope-token-plan`，直连 `apiBase`）。开启后魔搭模型进 DSH 模型选择器。**默认关**：注册模型源是 Host 级变更。任意失败必须降级为「面板照常用、该模块缺席」 |
| `maxTokensOverrides` | `{}` | ✗ | 逐模型的**单次输出上限**覆盖（精确模型 id → tokens）。优先级 `覆盖 > 目录声明 > 不声明`。键是**精确 id**，不做子串匹配（上限是请求参数，键写 `flash` 会顺手改掉七八条）；值必须是正整数，非法值（非整数 / `0` / 负数 / 字符串数字）**丢弃**而不是夹取。为什么要它：魔搭 `/v1/models` 从不返回输出上限，于是每个模型的 descriptor 都不带 `maxTokens`，harness 用 `defaultMaxTokens ?? 32768` 兜底——32768 既不是魔搭声明的数、也不是实测过的数。空对象 = 完全维持旧行为。例：`maxTokensOverrides: { "deepseek-ai/DeepSeek-V4.1-Flash": 65536 }` |
| `drawEnabled` | `false` | ✓ **开关值立即生效，工具挂载等下次 Host 启动** | 给 agent 注册出图工具 `modelscope_draw_image`。**与 `registerProvider` 是两条独立开关**：那个管「魔搭作为 chat provider」，这个管「agent 能不能出图」。工具一旦注册就摘不下来（peer 的 tools registry 没有 unregister），所以真实挂载/缺席发生在**下一次 Host 启动**——面板会就这一点给提示（`draw.restartHint`）；机制与后果的完整论述见 [`src/host/draw-register.ts`](../src/host/draw-register.ts) 文件头注 |
| `drawModelId` | `""` | ✓ 面板选择的模型优先于它 | 首选**出图**模型 id；留空 = 自动取目录里第一个出图模型。只有目录内**平台声明**出图能力的模型才进候选（实测目录 35 条里只有 2 条 image-to-image，没有 text-to-image；官方示例里的 `Qwen/Qwen-Image-2.1-Turbo`、`black-forest-labs/FLUX.1-Kontext-dev` 都不在目录内，后者实测 FAILED） |
| `drawTimeoutMs` | `900000`（15 分钟） | ✗ | 单次出图的**总预算**（含提交与全部轮询），上界 `1800000`（30 分钟）。取 15 分钟的依据是实测最慢一次 537 s 并留一倍余量；此前的 5 分钟预算**已被实测击穿**（一次 e2e 在 300 s 放弃而任务仍活着）。**超时放弃 ≠ 任务死亡**：上游会继续跑。别再调小 |
| `drawWaitMs` | `90000` | ✗ | 单次出图**工具调用**愿意等多久；与上一条是两件事（那是「这张图值不值得继续等」，这是「一轮对话被占住多久」）。等不到就返回 `status: pending` + `jobId`，agent 带 `jobId` 再调用即续查。实际取值夹在 `10000` 与 `drawTimeoutMs` 之间 |

## 4. 已经删掉的键（别照着老文章配）

| 键 | 为什么删 |
|---|---|
| `dailyQuotaTotal` / `dailyQuotaPerModel` | 官方改按「魔粒」计费后，次数口径的「每日 N 次 / 推算剩余」是社区快照而非官方数据，与魔粒余额并排展示会误导（README「诚实声明」）。面板不消费它们，留着只会让人以为面板能算「还剩几次」——它算不出 |

## 5. 令牌不在配置里

魔搭访问令牌（形如 `ms-…`）**不是** `config:` 字段：插件读 DSH 凭据服务里的
`MODELSCOPE_API_KEY` 引用（面板保存即生效）。环境变量 `MODELSCOPE_API_KEY` 只在**启动时读一次**、
且优先级高于引用值——设了它就别再用面板存（见 README 与 `src/host/ms-auth.ts` 文件头）。
令牌永不入日志、永不进插件目录。
