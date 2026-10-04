# Changelog

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
