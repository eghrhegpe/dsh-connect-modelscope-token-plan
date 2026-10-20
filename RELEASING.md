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
>
> **本文件是唯一的发版知识源，不产生每版手册。** Release 正文写在**临时文件**里喂给
> `gh release create --notes-file`（姊妹插件同款做法），草稿留在 `CHANGELOG.md` 该版节里。
>
> 这条是 2026-10-17 的裁定，推翻了本仓 2026-10-05 自造的「每次发版新开一份
> `RELEASE-X.Y.Z.md`，上一版移入 `releases/archive/`」惯例。推翻依据（实测）：
> 姊妹插件（agnes / sensenova / qoder / trae / workbuddy）**都没有**这套，它们只有
> `CHANGELOG.md` + 本文件，那句 `RELEASE-X.Y.Z.md` 是 `/tmp` 下的**临时**正文；
> 而本仓那套的实测形态是——`RELEASE-0.5.0.md` 的 130 个非空行里 **48% 与上一版逐行相同**、
> 另 23% 只是把版本号代进去，同时**把流程知识困在某一版里**（`EOTP` 怎么办、`E401`、
> 版本号烧在**两处**、`release.test` 的截图白名单——这些当时在本文件里一个字都没有）。
> 独占文件一多，知识就长在文件上，而文件会随版本轮换。

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

**TLS 拦截在本机是偶发的**：2026-10-05 曾报 `DEPTH_ZERO_SELF_SIGNED_CERT`，同日复查时
`strict-ssl=true` 下 `npm view … --registry=https://registry.npmjs.org` 直读成功、`npm whoami`
正常——**不是常态，别为它改全局 npm 配置**（`npm config set strict-ssl false` 会把本机所有
校验一起关掉）。若 publish 时真的再报证书错，用**单条命令级**开关：
`npm publish --registry=https://registry.npmjs.org --strict-ssl=false`。注意它与登录无关：
`npm login` 修的是 401，修不了证书；whoami 能回用户名就不需要 login。

**谁负责跑 `npm publish`**：账号开了两步验证时（本机 `eghrhegpe` 就是），`npm publish`
**必须由账号持有者本人在终端执行**并输入一次性密码——OTP 不该经 AI 会话之手，而 AI 代跑
只会撞 `EOTP`：它打印的授权链接在日志里被脱敏（`auth/cli/***`），拿不到可转发的完整 URL，
也无法代你打开浏览器。让用户在终端跑，npm 会交互式提示输入 6 位码；`--otp <码>` 只在
用户主动把码交给执行者时才用。

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

### 1.6 peer 依赖升级的验证（升级 peer 与发版分开做）

本仓库**没有 lockfile**（`.gitignore` 明确排除），`npm install` 每次解析最新版本；
`peerDependencies` 又是宽范围（`@deepseek-ai/*` / `@earendil-works/pi-ai` 等
`>=0.1.5 <0.3`）。因此**升级 peer 时离线测试全绿不能作为放行依据**——
`test/llm-adapter.test.mjs` 用记录式假 peer（`test/helpers/peer-stub-loader.mjs`）钉住
的是**我们自己**对 peer 的调用形状；假 peer 是我们写的，不会跟着 peer 真身漂移。
`resolveRetryPolicy` 的形状、`classifyPiAiError` 的判定顺序这些**真身行为**若被 peer
改掉，唯一防线是真机冒烟。

升级 `@deepseek-ai/dsh-llm*` / `@earendil-works/pi-ai` 后必做：

1. `npm test` + `npm run typecheck`（离线侧至少不能更坏）；
2. 在 CI 上用 `workflow_dispatch` 手动触发一次 gate（换大版本时尤其）；
3. **真机冒烟**：真 Host + 魔搭 API（或假魔搭平台），各跑一次「额度耗尽 429 快失败
   不重试」与「rpm 限频 429 退避重试」——确认 peer 的新分类顺序没把两类 429 颠倒；
4. 把「升级 peer」单独提交（不要混进发版提交），peer 漂移导致回退时可单点 revert。

### 2. 更新版本号（**两处**，只改一处会红）

```bash
# 1) package.json 的 "version"
# 2) src/host/host-config.ts 的 PLUGIN_VERSION
```

`test/config.test.mjs` 钉着这两处相等——`PLUGIN_VERSION` 会进快照与日志，只改 `package.json`
会让面板报的版本与包的实际版本对不上。

改完 `src/` 必须 `npm run build` 再提交：`lib/` + `client.js` 是**入库产物**，`github:` 源
安装不跑 `prepack`，不重建则用户装到旧代码。`test/build-gate.mjs` 会红——**红得对**。

### 3. 更新 CHANGELOG.md

顶部开一节 `## [X.Y.Z] — YYYY-MM-DD`，沿用本仓写法（**主题化要点**，不是 agnes 那种
`Features/Fixes` 分组——二者都合法，本仓用前者）。

- **CHANGELOG 记「变了什么」**；「为什么这么变」（病灶、取证、判据、「看起来能省但不能省」的
  取舍）记进 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)，CHANGELOG 里链过去。
  0.1.0 那一节就是这么处理的：8 节压成 1 节，过程 24KB 搬进 docs。
- 一节的体量控制在 20–30 行内。超过就该问：这节是不是混进了实施过程？

### 4. 提交 → 推 main → **等 CI 绿** → 打 tag

```bash
git add package.json src/host/host-config.ts CHANGELOG.md
git commit -m "chore(release): X.Y.Z"
npm test                                  # 提交后复跑一次，产物门禁必须仍绿
git push origin main                      # 当前分支不是 main 时：git push origin <分支>:main
```

**tag 之前必须有 CI 的独立结论**——本地 `npm test` 与 CI 同源，不是独立证据：

```bash
git log --oneline origin/main..HEAD | wc -l        # 非零 = 这些提交是第一次被独立复核
gh run list --repo <owner>/<repo> --limit 3
gh run watch --repo <owner>/<repo> --exit-status   # 红了就**不要**往下走
```

```bash
git tag -a vX.Y.Z -m "vX.Y.Z: <一句话说明>"
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

**`--access public` 不是必需的**（无 `@scope` 前缀；0.2.0 / 0.3.0 / 0.4.0 都没带它）。

报错与对策（**这三条最容易误判**）：

- `EOTP`：账号开了两步验证，**不是**登录失败。**这一步换人跑**——让账号持有者在终端
  亲自执行 `npm publish`，npm 会提示输入 6 位一次性密码；AI 会话代跑只会撞 `EOTP`，且它
  打印的授权链接在日志里被脱敏（`***`）、拿不到也打不开。若执行者确已拿到码，可
  `--otp 123456`（30 秒刷一次，过期就重新取一个）。
- `E401`：未登录或 token 失效 → `npm login --registry=https://registry.npmjs.org` 后按原版本号重发。
- `DEPTH_ZERO_SELF_SIGNED_CERT`：TLS 被拦，与登录无关（见 §0.3）。只在**这一条**命令上加
  `--strict-ssl=false`，**不要**改全局——`npm login` 修不了它。

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

规则只认上游原文，本仓副本在 `awesome-dsh-plugin-submission/contributing.md`——**别在本文件转述规则**（本节此前那张「硬门槛」表就是转述，已经漂移过）。

本仓只有四件事实：

- 条目文件 `awesome-dsh-plugin-submission/eghrhegpe__dsh-connect-modelscope-token-plan.yml`，提 PR 时原样复制到对方仓库的 `data/plugins/` 下。不要在这里再维护第二份 yaml。
- 截图声明在仓库根 `screenshots.json`；清单与资产由 `test/release.test.mjs` 绑在一起（改名必须同步清单）。
- 市场线上那条条目会随上游维护者的改动漂移，`test/submission-drift.mjs` 每天联网对账一次（定时档在 `.github/workflows/submission-drift.yml`）。**它红了是信息，不是回归**：要么把上游措辞并进草稿，要么重开 PR；别去回滚提交把它刷绿。
- 分歧台账在 `awesome-dsh-plugin-submission/pending-drift.json`：只有 `category` / `description.en` / `description.zh` 这三类**可声明分歧**能进台账，每条必须写清上游→草稿的确切取值，外加终结它的那条 PR 链接。台账**双向核对**——有分歧没声明判红，声明与现实不符（PR 已合、或上游挪了窝）同样判红；声明过期不清理，等于给分歧装了个静音键。`url` / `name` 是身份字段，永远不可声明，只能改草稿。

## 常见问题

- **`npm publish` 打印了 `+ <pkg>@X.Y.Z`，但 `npm view` 查不到**：那是 npm 的扫描/暂存窗口
  （它会自己打印 *being processed and may take a few minutes*）。**等 2–3 分钟再核**，别急着
  重发——重发会撞 `EPUBLISHCONFLICT`。要绕过客户端缓存就直接问 registry：
  `curl -sH "Accept: application/vnd.npm.install-v1+json" https://registry.npmjs.org/<pkg>`
  看里面的 `dist-tags`（`modified` 时间戳没动 = registry 真的还没收到）。
- **`config.test` 红「版本不一致」**：版本号烧在 `package.json` 与 `src/host/host-config.ts`
  两处（见第 2 步），只改了一处。
- **`build-gate` 红「产物过期」**：改了 `src/` 没 `npm run build`。先 build 再提交，
  **不要**改门禁让它变绿。
- **`release.test` 红「截图不在 files 里」**：`assets/` 被移出 `package.json` 的 `files`
  白名单。恢复白名单，不要改门禁。
- **`gh release create` 报 `tag not found`**：tag 没推 → 回第 4 步。**别**去掉 `--verify-tag`
  （去掉它会在 tag 不存在时悄悄新建一个指向当前 HEAD 的 tag）。
- **`gh run list` 空**：第 4 步的 push 没成功 → `git rev-parse --short origin/main` 核对。
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
