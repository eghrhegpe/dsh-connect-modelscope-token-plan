# 发布流程（Release Flow）

> 本文档是本仓库的**唯一权威发布流程**。姊妹插件的同文件可作参照（`dsh-connect-agnes-token-plan`
> / `dsh-connect-sensenova-token-plan`），本文件只写本仓**特有**的部分与共同纪律。
>
> **先讲清一个常见误解**：本仓库**没有发布自动化**——没有会自动打 tag / 发 npm / 建 Release 的
> 工作流。但**有一条 CI 门禁**：`.github/workflows/gate.yml` 在 push 到 `main` 与所有 PR 上跑
> `npm run typecheck` + `npm test`（全部离线套件，含尾部的 `build-gate`），几秒跑完。它是唯一能
> 抓到「提交了忘 build」的地方——**发版前务必确认它绿**。GitHub Releases 页面上的发布说明仍是
> **手动** `gh release create` 出来的：它对安装、测试、打 tag **都没有任何影响**，漏掉时只有
> Release 页会缺一条，没有任何东西会报错。

## 前置条件

- `gh` 已登录且带 `repo` 权限：`gh auth status` 应显示账号 `eghrhegpe`、scope 含 `repo`。
- npm 已登录。**本机默认 registry 是 npmmirror 镜像**，发布与登录都必须显式带
  `--registry=https://registry.npmjs.org`。
- 仓库 `https://github.com/eghrhegpe/dsh-connect-modelscope-token-plan`（默认分支 `main`）。
- 本地 `main` 与远端同步，且工作树处于干净、可发布状态。

## 0. 发版前的状态核对

### 0.1 当前分支必须是 `main`，且不领先远端

```bash
git rev-parse --abbrev-ref HEAD      # 应输出 main
git rev-parse --short HEAD
git rev-parse --short origin/main
git log --oneline origin/main..HEAD  # 应为空
```

**`HEAD` 不是 `main` 时不要直接 `git push origin main`**——那条命令推的是本地 `main` 分支，
与你正在工作的分支无关；本地 `main` 若已与远端同步，你会得到一个毫无提示的
`Everything up-to-date`，而刚打的 tag 却落在**非 main** 的提交上，用户拿到的是一个
「main 上根本不存在」的版本。正解：`git push origin <当前分支>:main`（需 `origin/main` 是该
分支的祖先）。

**tag 必须打在「最终会成为 main 的那个提交」上**，推出去就跟那个提交走了。

### 0.2 不要给历史补造 tag

本仓 0.1.0 之前有 8 个`## 0.1.0-M4+（未发布）` 式的内部里程碑节，**它们从未对应任何发布**。
发版时它们已被压成一节 `## [0.1.0]`，实施过程搬进 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。

**不要**为了「让每个里程碑都有版本」而回头补打 tag：`M4` / `M4+` 是内部开发代号，对外**从未
存在**，打出来的tag 指向的提交在 npm 上没有对应版本——而 npm 一个包名只能有一个 `latest`，
`dsh plugin add` 装到的永远是 `latest`。结果是 **tag 指向的内容与用户实际拿到的东西完全
脱钩**，且 tag 一旦推出去就钉死、不可撤销（见下方 FAQ）。

### 0.3 npm 必须先验证登录

```bash
npm whoami --registry=https://registry.npmjs.org   # 401 说明没登录
```

**未登录时的表象会误导你**：`npm publish` 报的`404 Not Found ... you do not have permission`
**不是「包不存在」**，是「你没有发布权限」。别去查包名、别重建tarball，去登录。

**本机2026-10-05 实测**：查询 registry 时报 `DEPTH_ZERO_SELF_SIGNED_CERT`（自签证书）。
这是 TLS 拦截导致的，**不是包不存在**。发版前需先解决（本机装企业根证书、或给 npm 配
`strict-ssl=false`），否则第 5 步会卡住。

## 每次发布的完整步骤

### 1. 确认测试与代码

```bash
npm test        # 全部离线套件（含 release.test.mjs 与尾部的 build-gate.mjs）
npm run typecheck
npm run build
```

> 并行开发是常态：改哪个域就先跑哪个域，全量留给 pre-push。
> **不要为了「确认」连续跑全量 `npm test`**——会把本机卡死。

### 1.5 并行会话纪律

工作树常同时有**他人未提交改动**。发布提交只收**自己本轮**的文件，**禁止 `git add -A` /
`git add -u`**：

```bash
git add package.json CHANGELOG.md
git commit -m "chore: 版本升级至 X.Y.Z"
```

- 不要 `git stash / push / pop` 去腾「干净基线」——会把别人的未提交改动一并卷走。
- 提交后 `git status --short` 复核：没带走别人的东西。
- **发布必须从「完全提交」的状态切出版本**，否则 tag 指向的提交里会缺文件。

### 2. 更新版本号

手动改 `package.json` 的 `version`（语义化版本 `X.Y.Z`）。

### 3. 更新 CHANGELOG.md

顶部开一节 `## [X.Y.Z] — YYYY-MM-DD`，沿用本仓写法（**主题化要点**，不是 agnes 那种
`Features/Fixes` 分组——二者都合法，本仓用前者）。

- **CHANGELOG 记「变了什么」**；「为什么这么变」（病灶、取证、判据、「看起来能省但不能省」的
  取舍）记进 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)，CHANGELOG 里链过去。
  0.1.0 那一节就是这么处理的：8 节压成 1 节，过程 24KB 搬进 docs。
- 一节的体量控制在 20–30 行内。超过就该问：这节是不是混进了实施过程？

### 4. 提交并打 git tag

```bash
git add package.json CHANGELOG.md
git commit -m "chore: 版本升级至 X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z: <一句话说明>"
git push origin main        # 当前分支不是 main 时：git push origin <分支>:main
git push origin vX.Y.Z
```

> ⚠️ **tag 必须指向包含本次代码的提交**。用 `git rev-list -n1 vX.Y.Z` 核对。
>
> **「删除并强制移动 tag」只在两个前提下合法**：① 该版本**尚未** `npm publish`；② 尚未创建
> GitHub Release。只要二者之一已发生，tag 就**钉死**了——移动它会让 npm 上那一版的内容与 tag
> 所指不符，而 npm 不可覆盖。此时**唯一正解是发新版本**。
>
> ```bash
> npm view <pkg> versions --registry=https://registry.npmjs.org   # 已在列？→ 不可移
> gh release view vX.Y.Z --json tagName                           # 已存在？→ 不可移
> ```
>
> `-m` 用**冒号**（`vX.Y.Z: <一句话>`），第 6 步 `--title` 用**破折号**（`vX.Y.Z — <一句话>`）。

### 5. 发布到 npm

**npm 发布是必走步骤**，不是可选项——DSH 插件页从 npm 拉取本包，GitHub Release 与 npm 是两条
独立通道，任一成功都不会自动触发另一条。

```bash
# 本机默认 registry 是 npmmirror 镜像，发布必须显式指向 npmjs
npm publish --registry=https://registry.npmjs.org

# 验证（必须带同样的 --registry，否则读到的是镜像缓存的旧版）
npm view dsh-connect-modelscope-token-plan version --registry=https://registry.npmjs.org
```

- **已发布版本不可覆盖**：发新版前必须先升 `version`。
- **`files` 已限定发布内容**，测试与 `node_modules/` 不会进包。`assets/` 与
  `screenshots.json` **都在白名单里**（`test/release.test.mjs` 的 SHIPPED 段守住这条）——
  漏了会导致市场条目在 npm 安装路径下图裂。
- 发布前可用 `npm pack --dry-run --ignore-scripts` 预览 tarball 内容。
  **必须加 `--ignore-scripts`**：`prepack` 的 tsdown 构建日志会混进 stdout，`--json` 解析直接炸。

### 6. 创建 GitHub Release（**最容易漏，务必做**）

**tag 推送成功 ≠ 发布完成。**

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z — <一句话说明>" \
  --notes-file /tmp/release-X.Y.Z.md \
  --verify-tag
```

- `--verify-tag` 务必带上：漏了它会在 tag 不存在时**悄悄新建一个指向当前 HEAD 的 tag**。
- **不附任何构建产物**：本插件经 npm 分发，不通过 Release 发二进制。别塞 `.tgz`。

核对清单：

- [ ] `gh release list` 能看到本次版本，标题以 `vX.Y.Z — ` 开头（破折号）
- [ ] Release 指向的 tag 与第 4 步推的是同一个：`gh release view vX.Y.Z --json tagName`
- [ ] 不是 draft、不是 prerelease
- [ ] `assets` 为空
- [ ] 正文不是 CHANGELOG 的复制粘贴，单独读也讲得通

### 7. （可选，与发版解耦）收录到插件市场

向 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR，增加且仅增加一个文件
`data/plugins/eghrhegpe__dsh-connect-modelscope-token-plan.yml`。投稿指南（唯一权威，改规则以
它为准）：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>

**硬门槛**（CI 自动查 + 维护者人工读码）：

| 项 | 说明 |
|---|---|
| `dsh.bundle` 必须在 `package.json` 声明 | 只声明 `dsh.client` **不可安装**，是最常见的被拒原因 |
| GitHub 仓库打 `dsh-plugin` topic | — |
| 仓库创建满 1 天 | CI 按 `created_at` 卡 |
| 真实可用代码、非占位 | 维护者会读源码 |
| 一个 PR 最多 3 条 | 超过 CI 直接拒 |
| `description.en` 必填、禁营销词 | 维护者**逐句对照源码核验**，夸大是唯一的打回理由 |
| 分类从有效列表里选 | 选错维护者会自己改，不打回 |

**截图不是 yml 字段**，而是放在本仓根目录的 `screenshots.json`（1–8 张，相对路径）。
不声明时市场回退去抓 README 里的图——而 README 里**有**图（见
[README「面板长什么样」](README.md)），两条路都通。`test/release.test.mjs` 守住清单与资产的
一致性。

**本仓分类建议 `usage`**（额度/用量面板）。

## 常见问题

- **改了 README 但用户看不到**：`files` 白名单里有 README，随包发布。但仓库里的 README
  **不代表**用户读到的是新版——验证：`npm view <pkg> readme --registry=https://registry.npmjs.org | grep -c '<关键词>'`，
  返回 0 就说明还停在上一版，需要发新版。
- **发布后才发现 tag 落后于 HEAD**（`git log --oneline vX.Y.Z..HEAD` 有输出）：**不要**动 tag。
  该版本已在 npm / Release 上，正确动作是**开下一个版本**。
- **npm 包 / `dsh plugin add` 没刷到新版本**：确认第 5 步已成功，且 `npm view <pkg> version
  --registry=https://registry.npmjs.org` 显示新版本号（不带 `--registry` 会读到镜像缓存的
  旧版）。GitHub Release 建了不等于发了包。
- **发布提交卷走了别人的改动**：回退用 `git reset --soft HEAD~1`（仅撤提交保留文件改动），
  重新按 1.5 只`git add` 自己的文件。
