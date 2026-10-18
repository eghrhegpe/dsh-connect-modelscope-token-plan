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
| `probe-host-react.mjs` | `node tools/dev/probe-host-react.mjs <app.asar 路径>` | 从 DSH 安装目录的 `app.asar` 里读出**宿主浏览器实际注入的 React 版本**（路径必须传参，仓库里不写死本机绝对路径）。`test/dom-render-react.test.mjs` 钉的是宿主那一份的 reconciler 语义，pin 漂了就等于测着旧版本——升级 DSH 后先跑它核对（2026-10-15 实测：18.3.1）。 |

**为什么变异测试是必要的**：新写的断言第一次跑就绿，**什么都不能证明**——它可能
恒真、可能断言了个永远相等的值、可能根本没被执行到。`mutate.mjs` 是唯一能区分
「门禁绿」与「门禁有效」的手段。本仓库每加一条关键断言，都应当至少被变异检验一次
（拿掉实现里对应的那一行，断言必须变红）。

### 假门禁的两类形态（`find-fake-gates.mjs` 的射程边界）

扫描器抓的是**静态可判**的形态；下面两类是 2026-10-18 实测补进来的：

1. **恒真表达式**（扫描器 C 规则抓不到）：表达式含标识符、语法合法、构造上却不可能
   抛错或不可能不等。`test/panel.test.mjs` §3b 曾有一个 `assert.doesNotThrow` 包住
   七条「可选链 + `??` 兜底」的解引用——49 种输入组合零抛错，永远绿。C 规则只抓
   「断言体里没有任何标识符」，这类有标识符所以漏过。**识别法**：把表达式单独拎出来，
   喂 `undefined`/`null`/`{}`/`[]`/`0`/`""` 各一遍，都不抛就是恒真。
2. **聚合后断言被误报**：D 规则（循环里唯一断言不引用循环变量）曾用非贪婪正则取循环
   体，缩进闭合括号匹配不上，把**循环外**的收口断言当成体内唯一断言。合法写法
   「循环累加 offenders、循环外一次 `deepEqual`」（`test/credentials.test.mjs:259`）
   因此被误报。**已于 2026-10-18 改为括号配平取体**。

判定原则不变：扫描器报出来的先做一次无罪搜索，确认是误报就修扫描器本身，不要
为了让扫描器安静而改掉合法写法。

### `spec.test` 的写法

`test` 是**仓库相对路径**：`"test/routes.test.mjs"`（多个可给数组）。裸文件名
（`"routes.test.mjs"`）也会被补上 `test/` 前缀。

### 跑 client 的 DOM 门禁：`mutate-dom-render.json` 必须带 `DSH_DOM_TARGET=src`

```
DSH_DOM_TARGET=src node tools/dev/mutate.mjs tools/dev/mutate-dom-render.json
```

`test/dom-render.test.mjs`（以及 `test/panel.test.mjs`）默认被测物是**构建产物**
`client.js`，而变异改的是 `src/**`——不重新 build，产物里根本没有那个改动，于是
**每一条变异都会报告「漏过」**，看起来像门禁全瞎，其实是变异没进到被测物。这个坑
真实踩过一次（2026-10-15 首轮审计：24/24 全绿假象）。`dom-render.test.mjs` 因此带
第二个入口：`DSH_DOM_TARGET=src` 让它直接挂载 `src/client/panel-page.ts`（同一批
断言、同一个替身 React），变异审计要跑这一档。产物入口仍是 `npm test` 的默认，
「改了 src 忘 build」由 `test/build-gate.mjs` 单独负责。

同一轮审计的两条结论，记在这里免得被当成矛盾：
- 16 条 client 事件/时序/载荷变异，`panel.test.mjs` 抓住 **0** 条，
  `dom-render.test.mjs`（src 入口）抓住 **16** 条。这就是那条 ROADMAP 缺口的量度。
- 「全部隐藏」发混排清单那条变异（卡里那条防线拆掉）**抓不到**，因为调用方
  `saveRoster` 还有一道归一——它是**冗余防线**，不是门禁盲区；拆那道归一的变异
  （S1）确实会红。哨兵独占态的两条防线各自都有对应的变异钉着。

### 跑真 React 那一档：`mutate-dom-render-react.json`

```
DSH_DOM_TARGET=src node tools/dev/mutate.mjs tools/dev/mutate-dom-render-react.json
```

`test/dom-render-react.test.mjs` 用**真 React 18.3.1 + react-dom/client + jsdom**挂载
同一块面板，只承载 mini 替身结构上无法表达的五类（真 CSSOM 的选中态、节点复用、
焦点保持、列表换序的 id 身份、React 开发期告警为零）。实测结论，记在这里免得重测：

- 同一批 3 条变异，真 React 档抓住 **3** 条，mini 档（`dom-render.test.mjs`）抓住
  **0** 条——两档不是重复，是互补。
- 「删掉 roster 行的 `key`」那条是被 **§5 的零告警**抓住的，不是被 §4 的顺序断言抓住
  的：checkbox 全受控（`checked: draft.includes(id)`），删 key 不会串位。**凡是「React
  自己的规矩」类缺陷，都归 §5**，别指望 §4。
- 两个必踩的坑（都写进了套件的注释，改文件时别删）：`react-dom/client` 必须在
  `window`/`document` 就位之后再 import（它在模块求值时算死 `canUseDOM`，否则 input
  事件被整条吞掉，表现为「打字进不去、payload 是空串」，看着像被测代码坏了）；受控
  input 必须用 `HTMLInputElement.prototype` 的原生 setter 改值，否则被值追踪器判成
  「没有变化」。写第一版时当场踩了前者。

### 跑对话框胶囊那一档：`mutate-composer-pill.json`

```
DSH_DOM_TARGET=src node tools/dev/mutate.mjs tools/dev/mutate-composer-pill.json
```

两条测试各管一半：`test/composer-pill.test.mjs` 钉纯规则（座席只注册一次、provider
归属四态、`null` ≠ `0`、三档定级、陈旧边界、字典与样式族），`test/dom-render-react.test.mjs`
的 §6 钉它们在真 reconciler 下落到 DOM 上（非归属整块缺席且零请求、两个读数上屏、
28px 与无框进 CSSOM、三档墨色互不相同、失败保留上次读数并标「上次数据」、首帧「读取中」不是 0）。
实测：7 条变异 **全部被抓住**（C1 就是把 `providerOf` 退回「是字符串就算可用」——空串
`next` 于是遮住仍可用的 `lastUsed`，切模型那一帧胶囊消失；这条规则本身就是新套件当场
抓出来的缺陷，所以它的变异必须继续红）。`test/composer-pill.test.mjs` 也有
`DSH_DOM_TARGET=src` 入口，理由同上：变异改 src，产物入口看不见。

### 四个判定，看清它们的区别

| 判定 | 含义 |
|---|---|
| `KILLED (抓到)` | 变异使测试**因断言失败**而红——门禁有效 |
| `STILL-GREEN (漏!)` | 变异后测试仍全绿——**门禁盲区**，是最该看的一行 |
| `HUNG (挂死)` | 测试 90s 未退出（例如变异删掉了 `clearInterval`） |
| `BROKEN (测试没跑起来)` | 测试**根本没加载**（`Cannot find module` 等）——**不能算抓到** |

`BROKEN` 与 `KILLED` 必须分开：两者都是非零退出，但如果把「测试没跑起来」记成
「抓到了变异」，整份审计会**假绿**——而这个工具历史上真的这么错过（`group.test`
被拼成 `test/test/...`，于是每个变异都「被抓住」）。**门禁工具的失效必须是响的。**


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

## 同族插件的同源度：`cross-repo-drift.mjs`

```
node tools/dev/cross-repo-drift.mjs                 # 扫全部姊妹仓库
node tools/dev/cross-repo-drift.mjs --claims        # 只看「自称同源、实测不符」
node tools/dev/cross-repo-drift.mjs --strict        # 有宣称不符时非零退出
node tools/dev/cross-repo-drift.mjs --sibling <dir> # 指定姊妹仓库
node tools/dev/cross-repo-drift.mjs --json          # 机器可读
```

它回答的是**头注里的自我描述还算不算数**。本仓库与 sensenova / agnes 共享一套文件
命名，`src/` 里散着「受控复制」「与姊妹插件同源」这类句子——**那些句子没有任何
门禁**，源码一改它们照旧留着，而读者（包括 AI 协作方）会照着它推理。这个工具把
宣称变成可复核的数字：逐同名文件算去注释后的代码行重叠率，再把「文件自己说同源、
实测却不同源」的项单独列出来。

**判据是顺序无关的行集合重叠（Jaccard），不是 diff 行数、不是 LCS。** 两个坑都是
本仓库实证踩过的，所以写死在 `codeOverlap()`：

- **diff 行数会被注释语言骗**。两侧头注一中一英时，`provider-publish.ts` 报出 464
  行差异，读起来像「两份完全不同的实现」。所以先剥注释再比。
- **LCS 会被函数顺序骗**。`util.ts` 两侧函数集合几乎相同、只是次序不同，LCS 只给
  32%，而真实差异是 **1 个差异块**。所以主判据用顺序无关的重叠率，LCS 只作对照
  （两者差得远 = 主要是重排），报告里单列一节。

**它也会误报，所以边界被钉在代码里**（两处误报都是第一版真踩到的）：

- `同形` / `同款` **不算**宣称——那是输出形状与纪律的对齐，不承诺代码同源；
- 裸「同源」**不算**——`client/const.ts` 头注里的「相对、同源」是 web 的
  **same-origin**；
- **点名提到某个姊妹 ≠ 对它宣称**——「与 agnes 那份已分家」是划界，不是承诺；
- **指名只在它点名的仓库上核对**——「与 sensenova 同源」拿去核对 agnes 是误报
  （`util.ts` 对 sensenova 94%、对 agnes 48%，那句话只承诺前者）。

核查器自己的有效性也做过变异检验（本目录的规矩：新加的断言必须被变异检验一次）：
往 `draw.ts` 塞一句「与姊妹插件 draw.ts 受控复制」，`--claims --strict` 必须报
`[不符]` 并非零退出——第一版**没抓到**（整段头注里的一句「不能照抄」把夹在其中的
宣称一起吞了），改成逐行判宣称之后才抓到。所以别把宣判改回整段判定。

**它不进 `npm test`**：找不到姊妹仓库时正常退出（0）并明说「未发现」——别人的
checkout 里没有这三个仓库，那不是错误。

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
- 不要把它们的输出目录（`.cov/`、`*.json` trace、`.mut-*.json` spec）提交进版本库。
- **移动这些脚本时要同步改 `ROOT`**：它们靠 `resolve(dirname(fileURLToPath(
  import.meta.url)), "..", "..")` 定位仓库根（`tools/dev/` 上溯两级）。第六轮从
  `tools/` 移到 `tools/dev/` 时漏改，六个脚本全部指到 `tools/` 去了。
