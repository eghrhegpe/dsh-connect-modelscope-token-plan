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
| `src/host/ms-auth.ts` | 令牌读取：凭据服务 `MODELSCOPE_API_KEY` 引用（kind `api-key`）→ env 回退；零额度有效性探针（400-vs-401，验证后落地） | `token-store/*` 的极简替代 |
| `src/host/inference-client.ts` | `/v1/models`（免认证，带缓存+单飞）、429/401/400 分诊 | `console-client.ts` + `coalesced-fetch.ts` |
| `src/host/usage-store.ts` | 本地计数：天桶（`trendDays`）、每模型计数、429 事件流；原子写 0600，profile 分段 | `state-store.ts` + `throttle-store.ts` |
| `src/host/snapshot-aggregate.ts` | 软失败聚合：每个源 `soft()` 包裹，严格区分 null 与 0 | `snapshot-aggregate.ts` |
| `src/host/routes.ts` | 只读快照路由 `GET /api/<name>/snapshot`（HTTP 恒 200，成败看 body）+ `GET /api/<name>/models` | `routes.ts` |
| `src/shared/wire.ts` | Host ⇄ Client 契约（type-only） | `wire.ts` |

红线（沿 AGENTS.md 家规）：

1. 凭据只进 DSH 凭据服务 / env，永不入库、永不进日志；
2. credentials 记录 kind 只能是 `grant` / `api-key`，私有状态一律进插件状态文件；
3. Host 侧改动必须完全重启 DSH 才生效（README 已声明）。

## M2 — Client 半边（面板）

- `src/client/`：index / apply（`plugins.bundle.config` 槽） / panel-page（三 tab：额度 / 模型 / 接入）/ cards / http / i18n（zh+en）/ runtime / styles / wire。
- React 由 loader 注入，`h()` + 内联 style token，无 JSX。
- 轮询 hook：隐藏页暂停、错误退避、generation guard；cadence 以 Host 下发的 `pollSeconds` 为准。
- 「额度」tab 必须标注：本地推算、非官方余额、计数范围（仅经本插件的调用）。

## M3 — 测试 + 装机验证

- 离线套件（裸 node + strip-types，`erasableSyntaxOnly` 约束）：wire / config / usage-store / snapshot / routes / panel 决策 / i18n 字典一致。
- fake 魔搭平台（本地 http server）做 routes 级测试；live-contract 脚本打真平台（信息性不阻塞）。
- `npm run build` → lib/ + client.js 入库。
- **测试绿之前不装进 profile**（PITFALLS：半成品插件会让 Host startup failed，爆炸半径是整机）。
- 装机：`dsh plugin --profile <profile> add <本目录绝对路径>`，重启 DSH 验证。

## M4 — 可选增强（默认关）

- `registerProvider`：OpenAI 兼容 provider 注册（`modelscope-token-plan`），复用姊妹插件 `provider-publish.ts` 形态；
- 429 自愈接入（QUOTA 快速失败 vs RATE_LIMIT 退避）；
- `doctor` 工具。
