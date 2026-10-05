# 0.2.0 发布指令（复制粘贴即可）

> **本文件已于 2026-10-05 执行完毕，保留作历史记录**（0.2.0 已上 npm、`v0.2.0` tag
> 已推、GitHub Release 已建——第 5 步「2026-10-05 发 0.2.0 就是不带它成功的」即执行
> 记录）。**发新版请照 `RELEASING.md`（通用流程）新开一份 `RELEASE-0.3.0.md`**，
> 别把这份已执行的当现行手册。
>
> 仓库：`C:\Users\zhujieling11\.dsh\plugins\dsh-connect-modelscope-token-plan`
> 远端：`https://github.com/eghrhegpe/dsh-connect-modelscope-token-plan`
> **本文件全部命令按 PowerShell 写**（`&&` 不可用，用 `;` 分行）。临时文件路径是
> `$env:TEMP`，不是 `/tmp`。
>
> 第 3、5、6 步是不可逆动作：tag 一旦推出、版本一旦上 npm 就钉死，删不掉也改不了。
> 命令都**显式带 `--registry=https://registry.npmjs.org`**——本机默认 registry 是 npmmirror
> 镜像，漏了会读到镜像缓存的旧版。

---

## 1. 门禁全绿才准提交

```powershell
cd "C:\Users\zhujieling11\.dsh\plugins\dsh-connect-modelscope-token-plan"
npm run typecheck ; npm test
```

版本号烧在**两处**，改一处会红（`test/config.test.mjs` 正在钉它们一致）：

- `package.json` 的 `"version"`
- `src/host/host-config.ts` 的 `PLUGIN_VERSION`

改完 `src/` 必须重建再提交，否则 `test/build-gate.mjs` 报红（它红得对——`lib/` + `client.js`
是入库产物，`github:` 源安装不跑 `prepack`，不重建则用户装到旧代码）：

```powershell
npm run build
```

## 2. 提交并推 main（只 add 点名文件，禁止 `-A`/`-u`）

```powershell
git status --short
git add package.json src/host/host-config.ts CHANGELOG.md docs/IMPLEMENTATION.md RELEASE-0.2.0.md RELEASING.md
git add lib client.js                     # 第 1 步重建过的产物
git commit -m "chore(release): 0.2.0"
npm test                                  # 提交后复跑一次，产物门禁必须仍绿
git push https://github.com/eghrhegpe/dsh-connect-modelscope-token-plan main
```

## 3. 等 CI（本仓第一次真跑远程门禁）

```powershell
gh run list  --repo https://github.com/eghrhegpe/dsh-connect-modelscope-token-plan --limit 5
gh run watch --repo https://github.com/eghrhegpe/dsh-connect-modelscope-token-plan
```

绿了才往下。**红了不要打 tag**——修完重来，别把 tag 钉在一个失败的提交上。

## 4. 打 tag 并推 tag

```powershell
git tag -a v0.2.0 -m "v0.2.0"
git push https://github.com/eghrhegpe/dsh-connect-modelscope-token-plan v0.2.0
git ls-remote --tags https://github.com/eghrhegpe/dsh-connect-modelscope-token-plan v0.2.0
```

## 5. 发 npm

先 preflight（`E401` 才是没登录；能回用户名就不用 `npm login`）：

```powershell
npm whoami --registry=https://registry.npmjs.org
npm view dsh-connect-modelscope-token-plan versions --registry=https://registry.npmjs.org
```

发布：

```powershell
npm publish --registry=https://registry.npmjs.org
```

> 就这一条，不用加别的。`--access public` **不是必需的**：包名没有 `@scope` 前缀，默认就是
> public——2026-10-05 发 0.2.0 就是不带它成功的（留着也无害）。
> 若报 `EOTP`（账号开了两步验证）：浏览器打开它打印的 auth 链接走完 2FA，把 6 位码追加成
> `--otp 123456`。OTP 30 秒刷一次，过期就重新取一个。
> 若报 `DEPTH_ZERO_SELF_SIGNED_CERT`（本机 2026-10-05 出现过、同日复查不复现），只在**这一条**
> 命令上加 `--strict-ssl=false`，**不要** `npm config set strict-ssl false` 改全局——那会把本机
> 所有 TLS 校验一起关掉。

验证（`latest` 必须翻到 0.2.0）：

```powershell
npm view dsh-connect-modelscope-token-plan dist-tags --registry=https://registry.npmjs.org
```

## 6. 建 GitHub Release（最容易漏，且漏了不报错）

正文写进临时文件（**只写用户看得到的事实，不写操作步骤**），然后：

```powershell
gh release create v0.2.0 `
  --repo https://github.com/eghrhegpe/dsh-connect-modelscope-token-plan `
  --verify-tag `
  --title "v0.2.0 — 凭据不再外泄，数据不再悄悄没了" `
  --notes-file "$env:TEMP\release-0.2.0.md"
```

补建 v0.1.0（历史上 npm 发过但 Release 页从来没有过它）：

```powershell
gh release create v0.1.0 `
  --repo https://github.com/eghrhegpe/dsh-connect-modelscope-token-plan `
  --verify-tag `
  --title "v0.1.0 — 魔搭免费额度进 DSH，附可选 provider 接入" `
  --notes-file "$env:TEMP\release-0.1.0.md"
```

一次确认五点：

```powershell
gh release list --repo https://github.com/eghrhegpe/dsh-connect-modelscope-token-plan
gh release view v0.2.0 --repo https://github.com/eghrhegpe/dsh-connect-modelscope-token-plan --json tagName,isDraft,isPrerelease,assets
```

- [ ] `tagName` = `v0.2.0`，且与第 4 步推的是同一个
- [ ] `isDraft` / `isPrerelease` 均为 false
- [ ] `assets` 为空（不经 Release 发二进制）
- [ ] 正文不是 CHANGELOG 的复制粘贴
- [ ] `--verify-tag` 保留了（去掉它会新建一个指向 HEAD 的 tag）

## 7. 补仓库 topic（市场收录的硬门槛）

```powershell
gh api --method PUT -H "Accept: application/vnd.github+json" `
  repos/eghrhegpe/dsh-connect-modelscope-token-plan/topics -f "names[]=dsh-plugin"
gh api repos/eghrhegpe/dsh-connect-modelscope-token-plan/topics
```

---

## 出问题怎么办

| 症状 | 真相 | 动作 |
|---|---|---|
| `npm publish` 报 `EOTP` | 账号开了两步验证，**不是**登录失败 | 打开它打印的 auth 链接走完 2FA，命令末尾加 `--otp 123456`；30 秒刷一次 |
| `npm publish` 报 `E401` | 未登录或 token 失效 | `npm login --registry=https://registry.npmjs.org` 后原版本号重发 |
| `npm publish` 报 `404` | 多半还是登录态或权限，**不一定是包不存在** | 先 `npm whoami` + `npm view <包名> versions` 看清真实状态，别急着改名 |
| `DEPTH_ZERO_SELF_SIGNED_CERT` | TLS 校验被拦，与登录无关 | 该条命令加 `--strict-ssl=false`；`npm login` 修不了它 |
| `build-gate` 红「产物过期」 | 改了 `src/` 没 `npm run build` | 先 build 再提交，**不要**改门禁让它变绿 |
| `gh release create` 报 `tag not found` | tag 没推 | 回第 4 步。**别**去掉 `--verify-tag` |
| `gh run list` 空 | 第 2 步没推成功 | 核对 `git rev-parse --short origin/main` |
| 改了 README 但用户看不到 | 改动没发版 | `npm view dsh-connect-modelscope-token-plan readme --registry=https://registry.npmjs.org` |

**已发布 ⇒ tag 不可移。** 一旦 publish 成功，`v0.2.0` 就钉死了；之后发现漏改，
正确动作是**升版本发新版**，绝不回移 tag——否则 npm 上的内容与 tag 所指不符。

市场收录 PR（`data/plugins/eghrhegpe__dsh-connect-modelscope-token-plan.yml`）与发版解耦，
投稿前用 `node tools/check-market-entry.mjs` 校验，不在本表范围。
