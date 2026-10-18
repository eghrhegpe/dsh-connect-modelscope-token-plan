# ROADMAP

## 现状（0.6.2，2026-10-18）

M0–M4+ 全部落地，其后又交付 0.2–0.5 四个版本（出图工具、用量胶囊、上下文窗口、
面板收敛与只读盘点等，逐版公开行为变化见 [CHANGELOG.md](CHANGELOG.md)）。当前
能力面：

- **本地用量面板**（Plugins 页插件卡，额度 / 模型 / 接入三 tab）：头条是官方魔粒
  余额（真实值），下面接**本客户端（本 profile）内经本插件**的调用分布 / 趋势 /
  429 事件流（口径见 README「诚实声明」；profile 分段的裁定见 `usage-store.ts`
  头注）；
- **可选 provider 接入**：模型 tab「接入为 DSH 模型」开关（默认关，opt-in），
  目录→pi-ai descriptor 映射、发布状态机、429 自愈（QUOTA 快速失败 vs
  RATE_LIMIT 退避 + peer 误判纠正层）；保存与轮询已收编为单一 desired-state
  收敛链（`provider-reconcile.ts`）；
- **上下文窗口四级真值链**：目录声明 > 用户档位 > 内置策展表（models.dev 交叉
  核对，带核对日期与过期提醒）> 128K 兜底；
- **出图工具**（opt-in，默认关）：两段式（提交→带 jobId 续查），一次工具调用不
  把整轮对话堵在 await 上；
- **对话框用量胶囊**：归属会话显示官方魔粒余额 + 今日本地次数（读不到渲染「—」，
  绝不渲染 0）；
- **额度耗尽集合接线**（2026-10-18）：窗口内出现过 quota 事件的模型不进
  picker、面板 roster 灰显——从本插件事件流推断的保守口径（恢复不可观测，
  规则与取舍见 [PROVIDER-M4.md](PROVIDER-M4.md) §15）；
- **门禁体系**：全套离线测试（含产物新鲜度 `test/build-gate.mjs`、文档一致性
  `test/docs.test.mjs`、两档真 DOM/真 React 渲染套件）+ CI
  （`.github/workflows/gate.yml`）。

每一步的病灶、判据、取舍见 [IMPLEMENTATION.md](IMPLEMENTATION.md)（实施过程档案）与
[PROVIDER-M4.md](PROVIDER-M4.md)（M4 契约）；上游端点全景见 [REFERENCES.md](REFERENCES.md)。

开发红线（任何时候都有效）：

1. 凭据只进 DSH 凭据服务 / env，永不入库、永不进日志；
2. credentials 记录 kind 只能是 `grant` / `api-key`，私有状态一律进插件状态文件；
3. Host 侧改动必须完全重启 DSH 才生效（README 已声明）。

## Backlog

### 真缺口（未做，按优先级）

- **e2e**（真 Host + 假魔搭平台）进 CI 门禁——也是「peer 真身契约」缺口的唯一解：
  `test/llm-adapter.test.mjs` 经假 peer 钉住了**我方调用形状**（2026-10-16），但真
  `classifyPiAiError` 的措辞命中面与判定顺序、真 `resolveRetryPolicy` 的接受面
  仍无门禁（诚实边界见 `llm-adapter.ts` 头注）；
- **余额差值趋势**：usage-store 记录每日首末两次官方余额观察，日消耗 = 首减末
  ——OpenAPI 无记录端点，只能这样做（见 [REFERENCES.md](REFERENCES.md)）；
- `GET /users/me` 展示账号名（官方 OpenAPI 端点，端点家族盘点见 [REFERENCES.md](REFERENCES.md)）；
- 「每日签到领魔粒」提醒：签到是**网页行为**（登录态访问 magicube/usage 页触发，
  非 API），只能做面板外链 + 待办提醒（见 [REFERENCES.md](REFERENCES.md) 的
  userscripts 上游）。

### 已交付（曾在此清单里，保留条目只为记录来路）

- **迁移窗口期的状态可见性**（2026-10-18，评审落地）：doctor 共享布局在场就报
  （`shared (legacy)` 作用域，修前只有零个 profile 时才报）；usage-prefs 跟势显示窗口
  从 pre-profile 共享布局一次性继承（与 provider.json 同款）；迁移规则补记在各 store
  头注。过程档案见 `docs/archive/2026-10-18-0.6.1-process.md`；

- **额度耗尽集合（unavailableIds）接线**（2026-10-18）：picker 丢弃 + 面板
  roster 灰显；从 429 事件流按纯函数推断（quota 窗口，恢复不可观测），规则见
  [PROVIDER-M4.md](PROVIDER-M4.md) §15，过程档案见
  `docs/archive/2026-10-18-0.6.0-process.md`；
- **client 的 DOM / 事件 / 时序门禁**（2026-10-15）：`test/dom-render.test.mjs`
  （真产物 + jsdom 真 DOM + 最小替身 React）与 `test/dom-render-react.test.mjs`
  （真 React 18.3.1 + react-dom/client）两档，互补不重复；变异审计见
  `tools/dev/README.md`；
- **peer 契约「我方调用形状」一侧**（2026-10-16）：`test/llm-adapter.test.mjs`
  经 `test/helpers/peer-stub-loader.mjs` 钉住装配链；
- ~~按模型探测 `reasoning_effort` 档位表后，再按模型开启思考~~——**已探测，
  判定不可行**（2026-10-05 真机）：魔搭对 `reasoning_effort` 既不校验值
  （`"bogus"` 也 200）也不保证生效，且端点会在真响应与空壳 200 之间摇摆，
  无法区分「生效」与「静默忽略」，档位表做不出来。理由详见
  [PROVIDER-M4.md](PROVIDER-M4.md) §4。`reasoning: false` 保持。
