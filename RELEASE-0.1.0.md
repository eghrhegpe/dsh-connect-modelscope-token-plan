# 0.1.0 发布指令（复制粘贴即可）

> 仓库：`C:\Users\zhujieling11\.dsh\plugins\dsh-connect-modelscope-token-plan`
> 状态：本地已就绪（`eb9842c`、工作树干净、tag `v0.1.0` 指向该提交、15 套件 + typecheck 全绿、pack 预演 16 条含三张图）。
> **下面 1–2 步是外部动作，谨慎执行；3–5 步需要你的登录态。**

---

## 1. 推代码与 tag

```bash
cd "C:/Users/zhujieling11/.dsh/plugins/dsh-connect-modelscope-token-plan"
git push origin main
git push origin v0.1.0
```

> 本地领先远端 16 个提交（建仓后一直没推）。`v0.1.0` 一定要跟着 main 一起推完——
> 顺序反了会出现 tag 已存在但 main 上没有对应内容的窗口。

**推完自检**（两项都过再往下）：

```bash
git rev-parse --short origin/main    # 应为 eb9842c
git rev-list -n1 v0.1.0 | cut -c1-7   # 应为 eb9842c
```

---

## 2. 处理 npm 证书（本机实测拦路点）

查询 registry 时报过 `DEPTH_ZERO_SELF_SIGNED_CERT`（TLS 自签证书拦截）。**这不是包不存在**，
别顺着这条线去查包名或重建 tarball。两个解法，任选：

```bash
# 方案 A：给 npm 配 strict-ssl=false（一次性，作用于本机 npm）
npm config set strict-ssl false

# 方案 B：装企业根证书到系统信任库（更干净，但要走 IT/证书流程）
```

**装完先验证**，别直接 publish：

```bash
npm whoami --registry=https://registry.npmjs.org    # 应打印你的 npm 用户名
```

> **本机默认 registry 是 npmmirror 镜像**，所以每条命令都必须显式带
> `--registry=https://registry.npmjs.org`，包括 `login` / `whoami` / `view`。
> 漏了会登到镜像、或读到镜像缓存的旧版。

未登录就登录（同样要带 `--registry`）：

```bash
npm login --registry=https://registry.npmjs.org
```

---

## 3. 发布到 npm

```bash
npm publish --registry=https://registry.npmjs.org
```

**发布后必须验证**（`latest` 必须翻到 0.1.0）：

```bash
npm view dsh-connect-modelscope-token-plan version --registry=https://registry.npmjs.org
npm view dsh-connect-modelscope-token-plan time    --registry=https://registry.npmjs.org
```

> 包名**当前未被占用**（registry 返回 Not found），0.1.0 可直接发。
> 已发布版本不可覆盖——以后发新版必须先升 `package.json` 的 `version`。
> `prepack` 会跑 tsdown，构建日志混进 stdout；想预览包内容要加 `--ignore-scripts`。

---

## 4. 建 GitHub Release（最容易漏，且漏了不报错）

先写正文到临时文件：

```bash
cat > /tmp/release-0.1.0.md <<'EOF'
# 🐋 v0.1.0 — 魔搭免费额度进DSH，附可选 provider 接入

首个发布版。把魔搭（modelscope.cn）API-Inference 免费额度的用量面板接入 DeepSeek Harness
的 Plugins 页，并可选把魔搭注册为 DSH 的 LLM provider —— 注册后魔搭模型直接进入模型
选择器，可对话调用。

---

## 一、面板：额度 / 模型 / 接入三个 tab

- **额度tab** —— 头条是官方魔粒余额（真实值），下面接本地调用分布与趋势、429 事件流；
- **模型 tab** —— 一行一个魔搭模型，可勾选启用，开关打开即注册为 provider；
- **接入 tab** —— 粘贴 ms- 访问令牌，零额度的「验令牌」验活入口就在这。

**不重复造第二本账**：成功的 token 总量交给 DSH 全局账本，本插件只生产它答不了的两件——
经本插件的分布/趋势，以及 429/错误事件流（官方只给总额度余额，不给「哪个模型刚才在限频」）。

## 二、诚实边界

- 本地计数**只统计经本插件的调用**；次数口径的「推算剩余」已移除（官方改魔粒计费后两个单位并排是误导）。
- 429/错误分类读的是 `llm-error-fix` **重分类之后**的 code——被误判成 QUOTA 的 rpm 限频记作 `rate_limit`，与退避策略说同一件事。
- `reasoning` **恒为 false**：魔搭是多模型代理，是否吃 `reasoning_effort` 取决于背后那个模型，离线无法得知每个 id 的档位表。「宁可不选，不可错发」——发错档位会整条请求 400。
- 能力标签 ≠ 可用端点：api-inference 目录目前**没有**文生图模型。

过程与踩坑见仓库 `docs/IMPLEMENTATION.md`。
EOF
```

然后创建（**`--verify-tag` 务必带上**）：

```bash
gh release create v0.1.0 \
  --title "v0.1.0 — 魔搭免费额度进DSH，附可选 provider 接入" \
  --notes-file /tmp/release-0.1.0.md \
  --verify-tag
```

**一次确认五点**：

```bash
gh release view v0.1.0 --json name,tagName,isDraft,isPrerelease,assets
```

- [ ] 标题以 `v0.1.0 — ` 开头（**破折号**，不是冒号）
- [ ] `tagName` = `v0.1.0`，且与第 1 步推的是同一个
- [ ] `isDraft` / `isPrerelease` 均为 false
- [ ] `assets` 为空（不经 Release 发二进制）
- [ ] 正文不是 CHANGELOG 的复制粘贴

---

## 5. （可选）收录到插件市场

> 与发版解耦，可之后做。**硬门槛里唯一没满足的是 `dsh-plugin` topic**，先补：

```bash
gh api --method PUT repos/eghrhegpe/dsh-connect-modelscope-token-plan/topics \
  --input '{"names":["dsh-plugin"]}'
gh api repos/eghrhegpe/dsh-connect-modelscope-token-plan/topics   # 确认返回 {"names":["dsh-plugin"]}
```

然后向 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR，**加且仅加一个文件**
`data/plugins/eghrhegpe__dsh-connect-modelscope-token-plan.yml`：

```yaml
url: https://github.com/eghrhegpe/dsh-connect-modelscope-token-plan
name: eghrhegpe/dsh-connect-modelscope-token-plan
category: usage
description:
  en: 'ModelScope API-Inference free-tier quota panel rendered as a config card on the Harness Plugins page: the official Magicube balance plus local call distribution by model, a daily trend, and 429 event stream, all read from ModelScope endpoints. One opt-in switch, off by default, registers ModelScope models as an LLM provider so they can be used in DSH conversation.'
  zh: '在 Harness 的 Plugins 页以插件卡显示魔搭 API-Inference 免费额度：官方魔粒余额，加上按模型的本地调用分布、按日趋势与429 事件流，全部读自魔搭端点。另有一个默认关闭的可选开关：把魔搭模型注册为 DSH 推理提供方，启用后可直接在对话里调用。'
```

-含 `: ` 的描述**必须加引号**（上面已加），否则 YAML 解析失败。
- `description.en` 必填、以句号结尾；`zh` 可选。
- **禁营销词**——维护者逐句对照源码核验，夸大是唯一的打回理由。
- 分类选 `usage`（额度/用量面板）。
- **不要**在 yml 里写 `npm:` 字段，CI 会拒。
- 截图**不是 yml 字段**：市场读本仓根目录的 `screenshots.json`（已就位，两张tab 截图）。

官方投稿指南（唯一权威）：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>

---

## 出问题怎么办

| 症状 | 真相 | 动作 |
|---|---|---|
| `npm publish` 报 `404 ... you do not have permission` | **不是包不存在**，是未登录 | `npm login --registry=https://registry.npmjs.org` 后原版本号直接重发 |
| `npm whoami` 报 401 | 未登录 | 同上 |
| `DEPTH_ZERO_SELF_SIGNED_CERT` | TLS 拦截 | 第 2 步，不是包的问题 |
| `gh release create` 报 `tag not found` | tag 没推 | 回第 1 步。**别**去掉 `--verify-tag`——那会新建一个指向 HEAD 的 tag |
| 改了 README 但用户看不到 | 改动没发版 | `npm view <pkg> readme --registry=https://registry.npmjs.org \| grep -c '<关键词>'`，返回 0 就是还停在旧版 |
| npm 装到的版本旧 | 读的是镜像缓存 | 查询/安装都带 `--registry=https://registry.npmjs.org` |

**已发布 ⇒ tag 不可移。** 一旦 npm publish 成功且 Release 建好，`v0.1.0` 就钉死了。
之后发现漏改，正确动作是**升版本发新版**，不要回移 tag——否则 npm 上的内容与 tag 所指不符。
