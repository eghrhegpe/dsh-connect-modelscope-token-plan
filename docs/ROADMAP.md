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

- **peer 契约的测试覆盖**（2026-10-16 `3ad4b07` 补掉「我方调用形状」一侧）：`test/llm-adapter.test.mjs`
  经 `test/helpers/peer-stub-loader.mjs`（Node module customization hooks 拦截四个 peer 入口、记录式假
  peer）钉住了 `llm-adapter.ts` / `llm-adapter-core.ts` 整条装配链——`createProvider` 调用形状与
  descriptor 契约、`resolveRetryPolicy` 传参形状、`PiAiAdapter` 构造（profiles 行 / auth 惰性 / 图片
  hook）、观察层「传了才包」且**重分类先于观察**的顺序、允许清单 / maxTokens 条件出现。
  **仍然钉不住的是 peer 真身**：真 `classifyPiAiError` 的措辞命中面与判定顺序、真 `resolveRetryPolicy`
  的接受面——假 peer 是我们写的，peer 升级改形状时本侧无门禁会红（`llm-adapter.ts` 头注已写明这条
  诚实边界，`test/retry.test.mjs` / `test/error-fix.test.mjs` 头注同）。剩余解法就是下面的 e2e：
  真 Host + 假魔搭平台进 CI，让真 peer 在门禁里跑一遍装配链。
- **e2e**（真 Host + 假魔搭平台）进 CI 门禁；
- **client 的 DOM / 事件 / 时序层已补上门禁**（`test/dom-render.test.mjs`：真产物 + jsdom 真 DOM + 一套最小替身 React，2026-10-15）。现在钉得住的：`props.onClick` / `onChange` 真的绑成了真事件、打字经 state 回流进写盘 payload、busy 期间控件真的 `disabled`（真浏览器语义：点不动）、挂载即首轮轮询、切后台 `clearInterval` / 回前台补一发 / 失败退避不低于 60s、在途请求在顶替与卸载时真的 abort、慢响应不覆盖快响应、写失败以 `role=alert` 上屏、契约漂移那句话上屏。变异审计：同一批 16 条变异，旧的结构套件抓住 0 条，这套抓住 16 条（spec 见 [tools/dev/README.md](tools/dev/README.md)）。
- **client hooks 剩下的覆盖缺口**（2026-10-15 补掉一半）：reconciler 那一侧已由
  `test/dom-render-react.test.mjs` 钉住——真 React 18.3.1 + `react-dom/client` + jsdom，承载 mini 替身
  结构上表达不了的其中五类：真 CSSOM 里的选中态、重渲染复用同一批 DOM 节点、**焦点不丢**（面板每
  30s 一次 `setData` 就重渲染一次，正在输入的框被打断是真实缺陷形态）、列表换序的 id 身份、以及
  React 开发期告警为零。同一批 3 条变异：真 React 档抓 3、mini 档抓 0，两档互补不重复。
  **仍然缺**：并发与错误边界、fake timers 下的**长周期**行为（30s cadence 走满、连续多轮退避的指数
  形状——两档都只能观察到「重建时用了哪个间隔」）。
  没有为此引 jest/vitest/@testing-library：React 18.3 自带 `act`，jsdom + 原生 setter 够用了。
  **代价是版本耦合**：`react` / `react-dom` 在 devDependencies 里被**精确钉住**，钉的是宿主浏览器
  实际注入的那一份（`node tools/dev/probe-host-react.mjs` 从 app.asar 读，2026-10-15 实测 18.3.1）；
  升级 DSH 后先重跑核对，再一起改 pin——门禁静默测着旧 reconciler 比不测更坏。这条与
  [types/dsh-peer-modules.d.ts](../types/dsh-peer-modules.d.ts) 「不声明 React 形状」的立场不冲突：
  产物里永远没有 React（`tsdown` 的 `neverBundle`），被钉的只是测试用的一份副本。
  **另一条已经踩到的纪律**：两档渲染套件默认入口都是**产物** `client.js`，所以改 `src/**` 不重新
  build 时它们（和 `panel.test.mjs` 一样）看不见改动——变异审计必须带 `DSH_DOM_TARGET=src`。
- **余额差值趋势**：usage-store 记录每日首末两次官方余额观察，日消耗 = 首减末——OpenAPI 无记录端点，只能这样做（见 [REFERENCES.md](REFERENCES.md)）；
- `GET /users/me` 展示账号名（官方 OpenAPI 端点，端点家族盘点见 [REFERENCES.md](REFERENCES.md)）；
- 「每日签到领魔粒」提醒：签到是**网页行为**（登录态访问 magicube/usage 页触发，非 API），只能做面板外链 + 待办提醒（见 [REFERENCES.md](REFERENCES.md) 的 userscripts 上游）；
- ~~按模型探测 `reasoning_effort` 档位表后，再按模型开启思考~~——**已探测，判定不可行**（2026-10-05 真机）：魔搭对 `reasoning_effort` 既不校验值（`"bogus"` 也 200）也不保证生效，且端点会在真响应与空壳 200 之间摇摆，无法区分「生效」与「静默忽略」，档位表做不出来。理由详见 [PROVIDER-M4.md](PROVIDER-M4.md) §4（现行理由与历史记录）。`reasoning: false` 保持。
