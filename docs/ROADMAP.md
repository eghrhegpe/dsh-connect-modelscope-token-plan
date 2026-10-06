# ROADMAP

## 现状（v0.2.0，2026-10-05）

M0–M4+ 全部落地，当前版本 0.2.0：

- **本地用量面板**（Plugins 页插件卡，额度 / 模型 / 接入三 tab）：头条是官方魔粒余额（真实值），下面接经本插件的调用分布 / 趋势 / 429 事件流（本地计数口径见 README「三条事实」）；
- **可选 provider 接入**：模型 tab「接入为 DSH 模型」开关（默认关，opt-in），目录→pi-ai descriptor 映射、发布状态机、429 自愈（QUOTA 快速失败 vs RATE_LIMIT 退避 + peer 误判纠正层）；
- **门禁体系**：全套离线测试（含产物新鲜度 `test/build-gate.mjs` 与文档一致性 `test/docs.test.mjs`）+ CI（`.github/workflows/gate.yml`）。

每一步的病灶、判据、取舍见 [IMPLEMENTATION.md](IMPLEMENTATION.md)（实施过程档案）与
[PROVIDER-M4.md](PROVIDER-M4.md)（M4 契约）；上游端点全景见 [REFERENCES.md](REFERENCES.md)。

开发红线（任何时候都有效）：

1. 凭据只进 DSH 凭据服务 / env，永不入库、永不进日志；
2. credentials 记录 kind 只能是 `grant` / `api-key`，私有状态一律进插件状态文件；
3. Host 侧改动必须完全重启 DSH 才生效（README 已声明）。

## Backlog（未做，按优先级）

- **peer 契约的测试覆盖**（当前**完全为零**）：`@deepseek-ai/dsh-llm` 的 `resolveRetryPolicy` 形状、
  `dsh-llm-pi-ai` 的 `classifyPiAiError` 判定顺序与措辞命中面、以及 `llm-adapter.ts` / `llm-adapter-core.ts`
  的整条 peer-dependent 装配链，都没有任何测试钉住。验证它们需要运行时 peer，而 peer 未 vendored 进本仓库，
  所以进不了 `npm test` 离线门禁。后果：peer 若改策略形状或分类顺序，本 provider 会在运行时静默失效，
  没有门禁会红。这是本仓库最大的覆盖缺口，与下面的 e2e 是同一条路径的两种解法（vendored 假 peer，或真 Host e2e）。
- **e2e**（真 Host + 假魔搭平台）进 CI 门禁；
- **client hooks 的行为测试**（`use-polling-interval` 的 visibility 暂停 / 失败退避 / 卸载停止，`use-snapshot-polling` 的 generation guard 防乱序覆盖）：需要 React 测试框架（fake timers + DOM mock + `renderHook`），而本仓库的测试全部是离线裸 node（不引 React 测试依赖，`package.json` 里没有 jest/vitest/@testing-library）。当前 `panel.test.mjs` 的替身 React 能钉住组件的输出结构（卡片渲染了什么），钉不住 hooks 的时序行为（什么时候调 `setInterval`、什么时候 `clearInterval`）。后果：轮询节奏漂移、generation guard 失效、或卸载后仍有在途请求，都不会被任何门禁抓住。解法要么引入 React 测试框架（打破离线裸 node 的约束），要么用替身 React 模拟时序（工作量大且脆弱）。
- **余额差值趋势**：usage-store 记录每日首末两次官方余额观察，日消耗 = 首减末——OpenAPI 无记录端点，只能这样做（见 [REFERENCES.md](REFERENCES.md)）；
- `GET /users/me` 展示账号名（官方 OpenAPI 端点，端点家族盘点见 [REFERENCES.md](REFERENCES.md)）；
- 「每日签到领魔粒」提醒：签到是**网页行为**（登录态访问 magicube/usage 页触发，非 API），只能做面板外链 + 待办提醒（见 [REFERENCES.md](REFERENCES.md) 的 userscripts 上游）；
- ~~按模型探测 `reasoning_effort` 档位表后，再按模型开启思考~~——**已探测，判定不可行**（2026-10-05 真机）：魔搭对 `reasoning_effort` 既不校验值（`"bogus"` 也 200）也不保证生效，且端点会在真响应与空壳 200 之间摇摆，无法区分「生效」与「静默忽略」，档位表做不出来。理由详见 [PROVIDER-M4.md](PROVIDER-M4.md) §4（现行理由与历史记录）。`reasoning: false` 保持。
