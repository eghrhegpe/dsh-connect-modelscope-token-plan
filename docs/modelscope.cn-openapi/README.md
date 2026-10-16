# modelscope.cn OpenAPI — vendored dump

魔搭站点 OpenAPI（`https://modelscope.cn/openapi/v1`，64 path）的机读规格转储，
2026-10-10 单提交入库（`6b9f1c0`），此后未更新。仅作契约参照，**无代码消费**——
`test/docs.test.mjs` 的 `isVendoredSpec` 按目录前缀把本目录整体排除在文档断言之外。

| 文件 | 说明 |
| --- | --- |
| `modelscope.cn-openapi.md` | 官方文档页的渲染转储（人读） |
| `modelscope.cn-openapi.json.gz` | 官方 OpenAPI JSON 的 gzip 转储（机读，530,567 B → 65,146 B） |

JSON 于 2026-10-17 压成 `.gz` 入库：原文件 518 KB，仓库与 working tree 都要长期
背着它，而 `package.json` 的 `files` 白名单根本不发 docs/——明文躺在 git 里没有
任何受益方。gzip 前后做过逐字节 roundtrip。需要展开时：

```console
node -e "const{readFileSync,writeFileSync}=require('fs'),z=require('zlib');writeFileSync('modelscope.cn-openapi.json',z.gunzipSync(readFileSync('modelscope.cn-openapi.json.gz')))"
```

注意：这份规格**不含** `images/generations`、`tasks`、任何 `X-ModelScope-*`——它
描述站点 OpenAPI，与 api-inference 是两套体系（结论与证据见 `docs/SPIKE-image-gen.md`）。
