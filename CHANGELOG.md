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
- 待做：doctor 工具、e2e（真 Host + 假魔搭）、装机验证。
