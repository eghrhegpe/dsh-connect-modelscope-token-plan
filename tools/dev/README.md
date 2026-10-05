# tools/dev —— 开发者校验工具（不随包发布）

这里放的是**一次性写出来、但反复有用**的校验工具。它们不参与 `npm test`
（`tools/` 不在 `files` 白名单里，也不该进离线门禁——变异测试会故意改源码）。

为什么留在这里而不是删掉：本仓库的多轮修复都是靠它们找到问题的。删掉它们，
下一轮就得从头再写一遍。每个工具的头部注释都写了用法与它验证的不变量。

## 变异测试：验证「门禁真的会红」

| 工具 | 用法 | 它回答的问题 |
|---|---|---|
| `mutate.mjs` | `node tools/dev/mutate.mjs <specFile.json>` | 对源码施加「真实回归」变异，跑指定测试，**报告哪些变异没被抓住**。spec 形如 `[{ target, test, mutants: [{name, from, to}] }]`；`from` 必须唯一命中，否则记 `NOT-APPLIED`（绝不猜）。源码在 `finally` 里恢复。 |
| `find-fake-gates.mjs` | `node tools/dev/find-fake-gates.mjs` | 静态扫描 `test/*.mjs`，找**看起来在验证、实际验证不到**的断言：声明了没进断言的变量、断言与自己造的桩比较、恒真断言、循环里与循环变量无关的断言等。 |

**为什么变异测试是必要的**：新写的断言第一次跑就绿，**什么都不能证明**——它可能
恒真、可能断言了个永远相等的值、可能根本没被执行到。`mutate.mjs` 是唯一能区分
「门禁绿」与「门禁有效」的手段。本仓库每加一条关键断言，都应当至少被变异检验一次
（拿掉实现里对应的那一行，断言必须变红）。

## 覆盖率：看「哪段代码从没被执行」

| 工具 | 用法 | 说明 |
|---|---|---|
| `cov-scan.mjs` | `node tools/dev/cov-scan.mjs` | 对每个 `test/*.mjs` 单独跑、收集 `NODE_V8_COVERAGE`，归并到 `src/**/*.ts`，输出文件级与行级覆盖。 |
| `cov-merge.mjs` | `node tools/dev/cov-merge.mjs <test1> <test2> ...`（不带参 = 全部） | 合并 V8 ranges（**去重嵌套**）后算真实字节 / 行覆盖。V8 的 range 是嵌套的，直接累加会把同一段算很多遍。 |
| `cov-bundle.mjs` | `node tools/dev/cov-bundle.mjs <test> <artifact>` | 测**产物**（`client.js`）被实际执行的比例。 |
| `cov-fn.mjs` | `node tools/dev/cov-fn.mjs [test] [artifactSubstring]` | 输出 `client.js` 里每个具名函数的执行计数（`counts=0` = 该函数从未被调用）。 |

覆盖率在这里的用途不是「刷百分比」，而是**找恒为 0 的路径**——面板那三块
「恒为 0 与空」的卡片，就是通过「某个 `recordCall` 生产者从没被执行」这类
观察抓到的。

## 不在这里的工具

- `tools/doctor.mjs`：**随包发布的诊断工具**（`npm run doctor`），只读盘点各
  profile 的 `usage.json` 与 env 令牌在场性，绝不写盘、绝不打印令牌值。它属于
  `tools/` 根目录，不属于开发工具。
- `tools/check-market-entry.mjs`：投稿市场的条目 YAML 静态校验
  （`node tools/check-market-entry.mjs <含 yml 代码块的 md> [提供 yaml 模块的仓目录]`），
  用真正的 YAML 解析器过一遍——市场 CI 就是这么查的。发版第 7 步用得上。

## 纪律

- 这些工具**会改源码**（`mutate.mjs`）或**会写中间产物**（`cov-*.mjs`）。用它们
  之前先确认工作树是干净的，用完 `git status` 复核一遍。
- 不要把它们的输出目录（`.cov/`、`*.json` trace）提交进版本库。
