# 0.3.0 发布指令（复制粘贴即可）

> 仓库：`<repo>`（本机插件目录，形如 `~/.dsh/plugins/dsh-connect-modelscope-token-plan`）
> 远端：`https://github.com/eghrhegpe/dsh-connect-modelscope-token-plan`
> **全部命令按 PowerShell 写**（`&&` 不可用，用 `;` 分行）。临时文件路径是
> `$env:TEMP`，不是 `/tmp`。
>
> 第 3、5、6 步是不可逆动作：tag 一旦推出、版本一旦上 npm 就钉死，删不掉也改不了。
> 命令都**显式带 `--registry=https://registry.npmjs.org`**——本机默认 registry 是
> npmmirror 镜像，漏了会读到镜像缓存的旧版。
>
> 0.3.0 内容：对话框用量胶囊、「上下文窗口」全局档位 + 内置策展表（三级真值链）、
> CI 门禁修复、真 DOM 渲染门禁两档、写守卫与注册状态机六处修正。明细见
> `CHANGELOG.md` 的 `## [0.3.0]` 节。

---

## 1. 门禁全绿才准提交

```powershell
cd "<repo>"
npm run typecheck ; npm test
```

版本号烧在**两处**，改一处会红（`test/config.test.mjs` 正在钉它们一致）：

- `package.json` 的 `"version"`（0.3.0）
- `src/host/host-config.ts` 的 `PLUGIN_VERSION`（0.3.0）

改完 `src/` 必须重建再提交，否则 `test/build-gate.mjs` 报红（它红得对——`lib/` + `client.js`
是入库产物，`github:` 源安装不跑 `prepack`，不重建则用户装到旧代码）：

```powershell
npm run build
```

## 2. 提交并推 main（只 add 点名文件，禁止 `-A`/`-u`）

```powershell
git status --short
git add package.json src/host/host-config.ts CHANGELOG.md RELEASE-0.3.0.md
git add lib client.js                     # 第 1 步重建过的产物
git commit -m "chore(release): 0.3.0"
npm test                                  # 提交后复跑一次，产物门禁必须仍绿
git push origin main
```

## 3. 等 CI（绿了才准打 tag）

```powershell
gh run list --repo eghrhegpe/dsh-connect-modelscope-token-plan --limit 3
gh run watch --repo eghrhegpe/dsh-connect-modelscope-token-plan --exit-status
```

**红了不要打 tag**——修完重来，别把 tag 钉在一个失败的提交上。

## 4. 打 tag 并推 tag

```powershell
git tag -a v0.3.0 -m "v0.3.0"
git push origin v0.3.0
git ls-remote --tags origin v0.3.0
```

## 5. 发 npm

先 preflight（`E401` 才是没登录；能回用户名就不用 `npm login`）：

```powershell
npm whoami --registry=https://registry.npmjs.org
npm view dsh-connect-modelscope-token-plan dist-tags --registry=https://registry.npmjs.org
```

发布：

```powershell
npm publish --registry=https://registry.npmjs.org
```

> `--access public` 不是必需的（无 `@scope` 前缀，0.2.0 就是不带它成功的）。
> 若报 `EOTP`：浏览器打开它打印的 auth 链接走完 2FA，把 6 位码追加成
> `--otp 123456`。OTP 30 秒刷一次，过期就重新取一个。
> 若报 `DEPTH_ZERO_SELF_SIGNED_CERT`（0.2.0 时出现过、同日复查不复现）：只在**这一条**
> 命令上加 `--strict-ssl=false`，**不要**改全局。

验证（`latest` 必须翻到 0.3.0）：

```powershell
npm view dsh-connect-modelscope-token-plan dist-tags --registry=https://registry.npmjs.org
```

## 6. 建 GitHub Release（最容易漏，且漏了不报错）

正文写进临时文件（**只写用户看得到的事实，不写操作步骤**；不抄 CHANGELOG）：

```powershell
@'
（正文见下）
'@ | Set-Content "$env:TEMP\release-0.3.0.md" -Encoding utf8

gh release create v0.3.0 `
  --repo eghrhegpe/dsh-connect-modelscope-token-plan `
  --verify-tag `
  --title "v0.3.0 — 面板胶囊 + 上下文窗口三级真值链" `
  --notes-file "$env:TEMP\release-0.3.0.md"
```

一次确认：

```powershell
gh release list --repo eghrhegpe/dsh-connect-modelscope-token-plan
gh release view v0.3.0 --repo eghrhegpe/dsh-connect-modelscope-token-plan --json tagName,isDraft,isPrerelease,assets
```

- [ ] `tagName` = `v0.3.0`，且与第 4 步推的是同一个
- [ ] `isDraft` / `isPrerelease` 均为 false
- [ ] `assets` 为空（不经 Release 发二进制）
- [ ] 正文不是 CHANGELOG 的复制粘贴
- [ ] `--verify-tag` 保留了（去掉它会新建一个指向 HEAD 的 tag）

## 7. 收尾

- 本文件（`RELEASE-0.3.0.md`）留在根目录；把 `RELEASE-0.2.0.md` 移入 `releases/archive/`
  （`git mv RELEASE-0.2.0.md releases/archive/`，随下一笔提交入库）。
- 市场收录与发版解耦，本版不涉及。

---

## 出问题怎么办

| 症状 | 真相 | 动作 |
|---|---|---|
| `npm publish` 报 `EOTP` | 账号开了两步验证，**不是**登录失败 | 打开它打印的 auth 链接走完 2FA，命令末尾加 `--otp 123456`；30 秒刷一次 |
| `npm publish` 报 `E401` | 未登录或 token 失效 | `npm login --registry=https://registry.npmjs.org` 后原版本号重发 |
| `DEPTH_ZERO_SELF_SIGNED_CERT` | TLS 校验被拦，与登录无关 | 该条命令加 `--strict-ssl=false`；`npm login` 修不了它 |
| `build-gate` 红「产物过期」 | 改了 `src/` 没 `npm run build` | 先 build 再提交，**不要**改门禁让它变绿 |
| `gh release create` 报 `tag not found` | tag 没推 | 回第 4 步。**别**去掉 `--verify-tag` |
| `gh run list` 空 | 第 2 步没推成功 | 核对 `git rev-parse --short origin/main` |

**已发布 ⇒ tag 不可移。** 一旦 publish 成功，`v0.3.0` 就钉死了；之后发现漏改，
正确动作是**升版本发新版**，绝不回移 tag——否则 npm 上的内容与 tag 所指不符。
