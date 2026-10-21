# 第三方致谢与合规（Third-Party Notices）

本插件的源码与文档均为本仓库原创，按根目录 [LICENSE](./LICENSE)（MIT）授权。下列是**唯一的**
第三方内容：

## 1. `docs/modelscope.cn-openapi/` —— 魔搭站点 OpenAPI 规格转储

| 项 | 内容 |
|---|---|
| 出处 | 魔搭社区站点 `https://modelscope.cn/openapi/v1`（机读规格），2026-10-10 单提交入库（`6b9f1c0`），此后未更新 |
| 内容 | `modelscope.cn-openapi.md`（可读全文）与 `modelscope.cn-openapi.json.gz`（原始规格）；目录内的 `README.md` 由本仓编写，说明转储口径 |
| 用途 | **契约参照**：核对面板外链/接口字段时查，不是数据源，也不参与任何请求 |
| 代码是否消费 | **否**——`test/docs.test.mjs` 的 `isVendoredSpec` 按目录前缀把整个目录排除在文档断言之外 |
| 权利 | 文档内容版权归魔搭社区 / 阿里巴巴所有，此处按「引用与核对」用途收录，未做商业再分发 |
| 是否随 npm 包发布 | **否**。`package.json#files` 不含 `docs/` |

## 2. 与本插件通信的上游服务

- **魔搭 API-Inference**（`api-inference.modelscope.cn`）与站点（`modelscope.cn`）：插件以使用者
  自己的访问令牌调用其模型目录、对话接口与官方余额接口。这些**不是**本仓库的代码，也不随包分发；
  使用须遵守魔搭的服务条款。
- **DSH（DeepSeek Harness）**：宿主运行时提供 `webServer` / `settings` / `llm` / `credentials`
  等 peer 服务，由宿主安装，不随本包分发。

## 3. 开发期工具链

构建与测试使用的开源包（如 `tsdown`、`typescript`、`react` 作为 peer）按其各自许可证使用，
**不复制其源码进本仓库**；依赖清单见 `package.json`，锁文件入库。

## 4. 与厂商的关系

本项目为个人集成作品，与魔搭社区、阿里巴巴、DeepSeek 均无关联，未获其背书。
