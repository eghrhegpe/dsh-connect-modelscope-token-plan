# M4 — 正式接入 DSH 作为 LLM provider（实现契约）

本文件是本次改动的**实现契约**：每条要新建/修改的模块、每个必须存在的
导出符号、每个模块必须遵守的接线，都在这里钉死。实现按本文件分片进行，
分片之间**只通过这里声明的符号**通信；任何分片不得自造另一个分片要读的名字。
（**未归档**：本文件仍是 M4 及其后续改动的契约与事实参照，不再改名。
原计划的 `docs/PROVIDER.md` 未创建，见 §14。）

姊妹插件（`dsh-connect-sensenova-token-plan`）的对应实现是**事实参照**，
本文件的每一节都标注了「照抄 / 改写 / 新建」，照抄的只改 import 与措辞。

## 0. 三条不变的事实（写代码前先认清）

1. **凭据只有一把静态钥匙**（`MODELSCOPE_API_KEY`，形如 `ms-…`）：无 OIDC、
   无 refresh。凭据永不入库、永不进日志（家规红线）；`ms-auth.ts` 的
   `tokenStore.resolve()` 是本插件**唯一**的凭据出口。
2. **上游 OpenAI 兼容**：`apiBase`（默认 `https://api-inference.modelscope.cn/v1`）
   直接吃 `/chat/completions` 与 `/models`。这就是为什么 M4 可以复用姊妹插件的
   `PiAiAdapter` 装配——魔搭不需要 sensenova 那套 OIDC/JWE。
3. **额度信号不存在于推理响应**：本地计数只统计**经本插件的调用**。provider
   注册后，DSH 的全部魔搭调用都经过本插件注册的适配器，因此本地计数**覆盖全部
   DSH 魔搭调用**（这是注册 provider 的第二个收益，第一个是把模型带进模型选择器）。
   该结论自 `src/host/usage-observer.ts` 接上流出口后才成立，**当前以该文件为准**
   （M4 当时不成立，见下更正块）。

   > **更正（M4+，2026-10-05）**：上面这个结论**在 M4 当时是错的**——M4 的适配器
   > 路径并没有挂计数钩子，本地计数实际只反映探针用量。`usage-observer.ts` 接上
   > 流出口之后该结论才成立（见 [IMPLEMENTATION.md](IMPLEMENTATION.md)「本地计数层
   > 无生产者」与 [ROADMAP.md](ROADMAP.md) M4+）。此处保留原文是契约的历史记录。

## 1. Provider 身份（单一真源：`src/host/llm-models.ts`）

```ts
export const LLM_PROVIDER_ID = "modelscope-token-plan";
export const LLM_DISPLAY_NAME = "ModelScope Token Plan";
export const LLM_API_KEY_NAME  = "ModelScope token";
```

- id **绝不能**是裸 `"modelscope"`：操作者可能已手写一条 `llm-pi-ai`
  （apiKeyEnv `MODELSCOPE_API_KEY`、base `https://api-inference.modelscope.cn/v1`），
  `registerAdapter` 对冲突 id 直接拒绝。自有 slug 形 id 不会撞。
- 三个常量被 `llm-adapter.ts`、`provider-publish.ts`、`routes/provider.ts`、
  快照、client.js 消费；改名必须连着所有消费方一起改。

## 2. 目录条目（`src/host/inference-client.ts` 改写）

当前 `fetchModels()` 只返回 `{ids, fetchedAt}`，M4 需要**整条**目录条目来建
descriptor，所以改成：

```ts
interface CatalogEntry {
  id: string;
  name: string;          // 展示名，回退 id
  vision: boolean;       // 是否吃图
  contextWindow: number; // 声明的窗口，未知用 128k 兜底
  maxOutputLength: number; // 声明的单次输出上限，0 = 未声明
}
async fetchModels(): Promise<{ entries: CatalogEntry[]; fetchedAt: string }>
```

- `entries` 从 `/v1/models` 的 `data[]` 归一：`id` 必取；`name` 取 `name`
  回退 id；`vision`/`contextWindow`/`maxOutputLength` 由 `llm-models.ts` 的
  `normalizeEntry` 判（见 §3）——**inference-client 只透传原始对象，不做判断**，
  判断集中一份。
- 为了不破坏现有消费方（`routes/models.ts`、`snapshot-aggregate.ts` 读
  `catalog.ids`），`fetchModels()` **同时**返回
  `{ entries, ids: entries.map(e => e.id), fetchedAt }`。两条路线读同一份条目，
  不会漂移。
- `routes/models.ts` 的响应加 `entries` 字段（`[{id,name,vision,contextWindow,maxOutputLength}]`），
  保留 `models`/`count`/`fetchedAt`/`cacheSeconds` 兼容旧面板。

## 3. 目录 → pi-ai descriptor 映射（`src/host/llm-models.ts`，新建，peer-free）

不 import 任何 Host peer（离线可测）。导出：

```ts
export interface CatalogEntry { id?: unknown; name?: unknown; [k: string]: unknown }
export const FALLBACK_CONTEXT_WINDOW = 128_000;
export const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const HIDE_ALL_MODELS = "__hide_all__";

export function normalizeEntry(raw: unknown): CatalogEntry        // 见 §2
export type ModelCapability = "unknown" | "text" | "vision-input" | "image-to-text" | "image-to-image" | "text-to-image" | "text-to-video";
export function resolveModelCapability(entry: CatalogEntry): ModelCapability   // 见下
export function isVisionModel(entry: CatalogEntry): boolean       // 见下（capability 的布尔投影）
export function isChatModel(entry: CatalogEntry): boolean         // 见下
export function contextWindowOf(entry: CatalogEntry): number
export function maxOutputLengthOf(entry: CatalogEntry): number    // 0 = 未声明
export function toPiDescriptor(entry: CatalogEntry, options: { providerId?: string; baseUrl?: string }): object
export function filterByEnabled(entries: unknown, enabledIds?: unknown): object[]
export function isModelEnabled(enabledIds: string[] | undefined, id: string): boolean
export function rosterOf(entries: unknown): { id: string; name: string; vision: boolean; capability: ModelCapability }[]
export function buildDescriptors(entries: unknown, options: { providerId?: string; baseUrl?: string; enabledIds?: string[]; unavailableModelIds?: string[] }): object[]
export function rosterWithAvailability(entries: unknown, unavailableIds: string[]): { id: string; name: string; vision: boolean; capability: ModelCapability; available: boolean; quotaExhausted: boolean; contextWindow: number; maxOutputLength: number }[]
export function summarizeCatalog(entries: unknown): { modelCount: number; visionCount: number; visionIds: string[] }
```

**判断规则（每一条都有理由，别改成「猜」）**：

- `resolveModelCapability`（M4+ 取代原来单薄的二值判定）：把「是不是 vision」升级为
  **能力类型**。判定顺序（权威→兜底）：① 结构化 `input_modalities`/`modalities`
  （含 `image`/`vision` 即 `vision-input`，否则 `text`）；② 详情端点
  `Tasks[].Name` 任务标签 → `TASK_TO_CAPABILITY`（多标签按 `CAPABILITY_RANK` 取最具体）；
  ③ 策展清单 `KNOWN_VISION_IDS`；④ 名字启发
  `/(vl|vision|qwen2?\.?\d*-?vl|glm.*v|internvl|llava|pixtral)/i`。**有标签但全不认识
  → `unknown`，绝不猜。** 词表真机核实：api-inference 只出现 `text-generation`/
  `image-text-to-text`/`image-to-image`/`text2text-generation`；hub 详情端点对文生图
  返回 `text-to-image-synthesis`，文生视频 `text-to-video-synthesis`。⚠️ 能力标签
  ≠ 可用端点——api-inference 目录里目前**没有**文生图模型。
- `isVisionModel`：`resolveModelCapability` 的布尔投影——`vision-input`（图进文出）
  或 `image-to-text`（图出文）算吃图；`image-to-image`/`text-to-image` 不算。漏判 =
  模型收图时报 `UNSUPPORTED_CONTENT`，面板能看见，不算静默失败。
- `isChatModel`：**宽松方向**。只有明确是图像**生成**模型的 id/名字才排除：
  `/(wanx|qwen-image|cogview|flux|stable-diffusion|sdxl|sd3|txt2img|text-to-image|draw|seedream|kolors|hunyuan-?image|imagen)/i`
  或 `output_modalities` 只含 `image`。魔搭目录里这些是纯生图模型，打
  `/chat/completions` 会 404。**没标注的一律算 chat**（缺失字段不等于不能用）。
- `contextWindowOf`：读 `context_length`/`context_window`/`contextWindow`/
  `max_context_tokens`，命中一个正数就用；否则 `FALLBACK_CONTEXT_WINDOW`
  （pi-ai 对 undefined 的 contextWindow 当 0 算，会坏掉 max-token 计算）。
- `maxOutputLengthOf`：读 `max_output_length`/`maxOutputLength`/`max_output_tokens`，
  0 = 未声明。**descriptor 只在 >0 时声明 `maxTokens`**：harness 对未声明
  maxTokens 会用 `defaultMaxTokens ?? 32768` 兜底，那是「平台没说」的诚实
  处理，别猜数字填。
- `toPiDescriptor` 的返回形状（对齐 qoder/sensenova 已知可用的那条）：
  ```ts
  { id, name, api: "openai-completions", provider, baseUrl,
    input: vision ? ["text","image"] : ["text"],
    reasoning: false,                       // §4 有解释
    cost: { ...NO_COST }, contextWindow,
    compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false } }
  ```
- `supportsDeveloperRole: false` **是承重墙**：pi-ai 在该标志缺省时会自动探测，
  对非标准 provider 一律猜 `true`，于是每条请求都用 `developer` 角色——魔搭
  这个多模型代理不认识，会 400 或 403。qoder 路由证明必须显式写 false。
- `rosterOf`/`rosterWithAvailability`/`buildDescriptors` 都要**按 id 去重且保留
  末次出现**（与 `filterByEnabled` 一致），否则面板清单和注册结果会就
  「哪些模型存在」说两套话。
- 面板清单（roster）**保留**额度耗尽的模型（灰显 + 原因），picker 用
  `buildDescriptors` **丢弃**它们（`unavailableModelIds`）——避免发出注定 429
  的请求。两处口径不同是故意的，别统一。

## 4. 关于 `reasoning: false`（重要，别随手改成 true）

**现行理由（2026-10-05 真机实测，取代 M4 的推测）**：魔搭对 `reasoning_effort`
**既不校验、也不保证生效**——拼错的值 `"bogus"` 同样返回 200，说明很可能被静默
忽略。所以真正的障碍**不是**「错发会 400」，而是两条更硬的：

1. **无法区分「参数生效」与「参数被静默忽略」**——两者都是 200；
2. **该端点在真响应与空壳 200 之间摇摆**（空壳形如
   `{"created":0,"choices":null,"usage":{全 0}}`，正是 validity 探针见到的那种形状）。
   在不稳定信道上做 A/B 探测得出的档位表不可信。

保守默认（`reasoning: false` **保持不动**）：

- `reasoning: false` → 不发 `reasoning_effort`，模型用自己的默认；
- `thinkingLevelMap` **不设** → picker 不给思考强度选择器。

它是无操作：模型不在 pi-ai 安装目录里，`base === undefined`，`dsh-llm-pi-ai` 的
`resolveModelReasoning` 会兜底成 `false`。**文档里必须把这条写成已知限制。**

> **历史记录（M4 原文，400 理由已被证伪）**：M4 的推测是「发错档位会整条请求
> 400」，依据是魔搭 API-Inference 是**多模型代理**，是否吃 `reasoning_effort`
> 取决于背后那个具体模型，本插件无法离线得知每个 id 的档位表（sensenova 那份是
> 拿真令牌逐模型探测 200/400 才钉出来的，见其 `PROBED_EFFORT`）。2026-10-05 真机
> 验证（`ZhipuAI/GLM-4.7-Flash`，`POST /v1/chat/completions`）推翻该理由：
>
> | 请求 | 结果 |
> |---|---|
> | 不带 `reasoning_effort` | 200（可能返回空壳，见上） |
> | `reasoning_effort: "low"` | 200（真响应带 `reasoning_content`；复测同一请求变成空壳 200） |
> | `reasoning_effort: "bogus"` | **200**——参数名被接受，**值不被校验** |

## 5. 适配器（`src/host/llm-adapter-core.ts` 照抄、`src/host/llm-adapter.ts` 新建）

- `llm-adapter-core.ts`：**照抄** sensenova 的 `llm-adapter-core.ts`，只改
  `import { name } from "./host-config.ts"`（sensenova 是 `name as pluginName`，
  语义相同）。导出 `assemblePiAiAdapter`、`imageBudgets`、`PiAiAdapterParts`。
  照抄理由：inert pi-ai auth 平面、image hook、429 重分类 Proxy 都是
  **对运行时 peer 的装配**，与上游是谁无关；抄两份必然漂移，而这类差异
  一旦漏一份就是「某条 provider 的 429 静默不再退避」。
- `llm-adapter.ts`：新建，peer-dependent（import `pi-ai`/`dsh-llm`/
  `dsh-llm-pi-ai`）。只导出：
  ```ts
  export function createModelScopeAdapter({ entries, enabledIds = [], baseUrl, resolveApiKey, get, unavailableModelIds = [] }: {
    entries: unknown; enabledIds?: string[]; baseUrl: string;
    resolveApiKey: () => Promise<string>; get?: (service: string) => unknown;
    unavailableModelIds?: string[] }): { adapter: object; providerIds: string[] }
  ```
  内部：`buildDescriptors(entries, {providerId, baseUrl, enabledIds, unavailableModelIds})`
  → `assemblePiAiAdapter({providerId, displayName: LLM_DISPLAY_NAME,
  apiKeyName: LLM_API_KEY_NAME, models, resolveCredential: resolveApiKey,
  ...(get ? {get} : {})})`。**不传 `reasoning`**（§4：profile 不钉 effort）。
- 每次重建**换新实例**（`PiAiAdapter` 内部 memoize profiles 快照），
  目录/key 变化时重注册并 `emit("llm/adapters-updated")`——和 qoder 一致。

## 6. 429 自愈（`src/host/llm-retry.ts`、`src/host/llm-error-fix.ts`，照抄）

两个文件**照抄** sensenova，只改文档措辞里的「商汤/SenseNova」字样为
「魔搭/ModelScope」。不 import 任何 peer。理由：魔搭 429 同样有
`quota_exceeded`（真配额耗尽，**不重试**）与限频（误判成 QUOTA 的 rpm/tpm
体，**要重试**）两副面孔，`shouldReclassifyQuotaToRate` 的判据是平台无关的
协议字符串，直接可用。

## 7. 发布状态机（`src/host/publish-core.ts` 照抄、`src/host/provider-publish.ts` 改写）

- `publish-core.ts`：**照抄** sensenova，只改 `import { name } from "./host-config.ts"`
  与 `import { redactSecrets, errMsg } from "./util.ts"`（本地 util 已具备两者）。
  导出全部原样：`ADAPTERS_UPDATED_EVENT`、`PublisherStateBase`、
  `NO_LLM_SERVICE_ERROR`、`BAD_FACTORY_SHAPE_ERROR`、`createPublishQueue`、
  `createPairReleaser`、`registerProviderPair`、`createAdapterFactoryResolver`、
  `isBuiltAdapter`、`describeBuildFailure`、`warnBuildFailure`、
  `resolveRegistrationService`、`unregister`、`swapRegistration`、
  `emitAdaptersUpdated`。
  照抄理由（三条承重语义）：publish 队列化（慢 publish 不能被快 publish 覆盖）、
  `disposed` 闸（dispose 后的 publish 不得注册进已撤下本插件的 Host）、
  单点 `registerPair`（publish 与 rollback 共用，失败时**恢复旧对**，坏 publish
  不会把已在服务的模型也拉下来）。
- `provider-publish.ts`：**改写** sensenova 同名文件。导出：
  ```ts
  export interface ProviderPublisherState extends PublisherStateBase {
    entries: CatalogEntry[]; enabledIds: string[]; unavailableIds: string[];
    signature: string; quotaSignature: string;
  }
  export function createProviderPublisher(deps: {
    settings?: { registerProvider?: boolean; apiBase?: string };
    panelSwitch?: () => Promise<boolean | null>;
    loadAdapterModule?: () => Promise<object>;      // 默认 () => import("./llm-adapter.ts")
    getLlm?: (service: string) => object | null;
    resolveApiKey?: () => Promise<string>;
    emit?: (event: string) => void;
    logger?: { warn?: (m: string) => void } }): {
      state: ProviderPublisherState;
      publish: (entries: object[], enabledIds: string[], unavailableModelIds?: string[]) => Promise<object>;
      release: () => void; dispose: () => void; isDisposed: () => boolean }
  export function seedPublisherFromCatalog(publisher, listCatalog: () => Promise<object[]>, listEnabled: () => Promise<string[]>, signatureOf: (e: object[], i: string[]) => string): Promise<void>
  export function catalogSignature(entries: unknown, enabledIds: unknown): string
  export function quotaSignatureOf(unavailableIds: string[]): string
  export function syncSignaturesAfterPublish(state: ProviderPublisherState): void
  ```
  与 sensenova 的差异**只有**：工厂导出名 `"createModelScopeAdapter"`、
  `registerPair` 用的 `LLM_PROVIDER_ID`/`LLM_DISPLAY_NAME`、`warnBuildFailure`
  的 label `"ModelScope"`、factory 不再传 `unavailableModelIds` 之外的同名键
  之外不传别的。**publish 队列 / disposed 闸 / registerPair 单点 / rollback
  恢复旧对** 四条语义必须原样保留——它们是 `publish-core.ts` 的骨头。

## 8. 面板开关持久层（`src/host/provider-store.ts` 照抄改写、`src/host/switch-precedence.ts` 照抄）

- `switch-precedence.ts`：照抄，导出 `resolveSwitchEnabled`、`resolveSwitchValue`、
  `switchSource`。
- `provider-store.ts`：照抄 sensenova，只改 import 为本地
  `state-store.ts`（本插件已有同款原语：`ensureStateDir`/`temporaryOf`/
  `writeStateFile`/`readStateJson`/`readStateVersion`/`isKnownStateVersion`/
  `createStateReadCache`/`STATE_READ_TTL_MS`/`profileStateDir`/`stateDir`）与
  本地 `util.ts` 的 `obj`/`degrade`。`StoreOptions` 类型本插件 `types.ts`
  没有，**在本文件内声明**：
  ```ts
  interface StoreOptions { dir?: string; profile?: string | null; ttlMs?: number; logger?: { warn?: (m: string) => void } }
  ```
  导出：`PROVIDER_VERSION = 1`、`KNOWN_PROVIDER_VERSIONS = [1]`、
  `providerDir(profile)`、`normalizeEnabled(raw)`、
  `createFileProviderStore(options)` → `{ enabled(), isSet(), save(value), forget() }`。
- 存储位置：`$DSH_HOME/state/<profile>/<name>/provider.json`（**按 profile
  分段**：回答的是「这个 profile 要不要注册 provider」，两个 profile 不能互相
  覆盖；这与节流的故意共享不同）。
- 读取优先级：面板保存值 > patch 的 `registerProvider` 默认。

## 9. provider 路由（`src/host/routes/provider.ts`，新建）

- `routes/paths.ts` 加：`export const PROVIDER_PATH = "/api/dsh-connect-modelscope-token-plan/provider";`
- `client/const.ts` 加：`export const PROVIDER_PATH = \`/api/${NS}/provider\`;`
  （两边由 `test/panel.test.mjs` §6b 钉住相等——它把 client 的模板与 Host 的字面量
  /派生路由**都解析成完整路径**再逐一比对，改错任何一边都会红。**M4 当时并没有
  这条断言**：原句声称 `test/config.test.mjs` 钉住相等，而该文件零引用；§6 的路由
  清单也整条漏掉三条 provider 路由。§6b 是 2026-10-05 补上的。）
- 路由三件事，`withOrigin` 围栏、`refuseMethod` 一律照现有路由：

  | 方法 | 路径后缀 | 作用 |
  |---|---|---|
  | GET | `PROVIDER_PATH` | 读当前开关 + 目录 + 允许清单 + 注册状态（无副作用） |
  | POST | `PROVIDER_PATH` | body `{enabled?: boolean}` → 保存面板开关并触发重注册 |
  | POST | `PROVIDER_PATH/roster` | body `{enabledIds?: string[]}` → 保存允许清单并触发重注册 |
  | POST | `PROVIDER_PATH/reset` | 忘掉面板开关与允许清单，回到 patch 默认 |

  统一把 `HIDE_ALL_MODELS` 当作「什么都不提供」的哨兵（不是 `[]`——空清单的
  语义是「不过滤」）。响应形状（client 与 snapshot 同读）：
  ```ts
  { ok: true, enabled: boolean, source: "panel"|"config",
    llmAvailable: boolean, registered: boolean, error: string|null,
    modelCount: number, enabledCount: number, allowed: "all"|"none"|"list",
    enabledIds: string[], roster: {id,name,vision,available,quotaExhausted}[] }
  ```
  写开关/清单失败**必须传播**（返回 `ok:false, error`），不静默吞：这是用户的
  显式操作，面板必须看到它没生效。

## 10. Host 装配（`src/host/index.ts` 改写、`src/host/types.ts` 改写）

- `types.ts` 的 `Wiring` 加：
  ```ts
  providerStore: ReturnType<typeof import("./provider-store.ts").createFileProviderStore>;
  publisher: ReturnType<typeof import("./provider-publish.ts").createProviderPublisher>;
  ```
  `HostDeps` 加 `fetchImpl` 之外的可选测试缝（如 `pollMs`、`getLlm`、`emit`、
  `credentials`），保持向后兼容。
- `index.ts` 在装配 wiring 后：
  1. 建 `providerStore = createFileProviderStore({ profile, logger: ctx.logger })`；
  2. 建 `publisher = createProviderPublisher({ settings, panelSwitch: () => providerStore.enabled(),
     getLlm: (s) => ctx.get(s) ?? null, resolveApiKey: async () => (await tokenStore.resolve()).value,
     emit: (e) => ctx.emit?.(e), logger: ctx.logger })`；
  3. `registerRoutes(ctx, wiring)` 里加 provider 路由；
  4. `ctx.effect` 里注册**目录轮询 + seed** 的副作用（见 fix A/C 与 fix B）：
     - 挂载时立即 oid runPoll()（fire-and-forget）：一次 inference.fetchModels() + 读**落盘**的允许清单（`providerStore.enabledIds()` 经共用的 `resolveEnabledIds` 解析：可读清单优先、**空清单 = 不过滤**，只有读抛错才回退内存 `publisher.state.enabledIds`），再 publish——重启的 Host 用用户保存的清单注册而非空清单（见 fix A/C）；
     - setInterval 轮询 unPoll()（间隔取 pollSeconds）；publishProviderOnce 内部按 catalogSignature / quotaSignatureOf 比对，未变则空转不重建 provider 对（见 fix B）；开关翻转、清单保存由 provider 路由直接 publish；
       路由直接 `publish`；
     - `ctx.effect` 的清理函数里 `clearInterval` + `publisher.dispose()` +
       `publisher.release()`。
  5. `snapshot-aggregate.ts` 加一个 `provider` 块（见 §11）。

  需要读持久化目录/清单的辅助：本插件**没有** catalog-store（目录不落盘，
  走 inference-client 缓存）。所以 seed 只 seed 允许清单与开关，目录等第一次
  轮询（或干脆省略 seed，直接轮询 publish——**M4 采用轮询 publish**，
  `seedPublisherFromCatalog` 允许清单为空、目录为空，publish 一次空集再等轮询，
  与 sensenova 的持久目录 seed 不同，属可接受差异，文档注明）。简化：不落盘
  目录，每次轮询 `publish`；开关/清单落盘在 `provider-store`。

## 11. 快照契约（`src/shared/wire.ts`、`src/host/snapshot-aggregate.ts` 改写）

`wire.ts` 加：
```ts
export interface ProviderStatus {
  enabled: boolean; source: "panel"|"config"; llmAvailable: boolean;
  registered: boolean; error: string|null; modelCount: number; enabledCount: number;
  allowed: "all"|"none"|"list"; enabledIds: string[];
  roster: { id: string; name: string; vision: boolean; available: boolean; quotaExhausted: boolean }[];
}
// Snapshot 加字段：
provider: ProviderStatus;
// 并把它加进 SNAPSHOT_REQUIRED_KEYS。
```
`snapshot-aggregate.ts` 用 `soft()` 包 provider 读（开关 + 注册状态 + 目录
roster），失败给降级形状（`enabled:false, error, roster:[]`），**绝不 ok:false**。
`test/wire.test.mjs` 的钉死清单同步更新。

## 12. 客户端 UI（`src/client/*`）

目标（用户诉求的落点）：**把抽象的「试调」按钮换成真接入**。

> **后记（M4+ 面板收敛）**：本节描述的「试调按钮降级为次要动作」已被推翻——
> 那张免认证目录表连同每行 usage 试调**整块删除**，模型 tab 现在只有
> `section.provider` 一个区块。roster 自身就是「接入后实际提供哪些模型」，
> 与免认证目录并排属于重复；usage probe 也只服务那张表，且根本不在 DSH 的调用
> 路径上（真调用经 provider adapter）。**保留**的是零额度 validity probe
> （`probe.validity`，接入 tab 的验令牌，`POST /probe` 路由不动）。
> **再后记（第六轮）**：服务端那条 `kind:"usage"` 分支也删了——当时只删客户端，
> 留下一条没有入口、却因「缺省即 usage」而会被裸 POST 触发真实计费的服务端路径。
> 现在 `POST /probe` 只接受 `{modelId}`。
> 目录表时代的整行染色（`trendRowFeatured`）同时降级为 roster 行上一枚
> 「推荐」pill（`S.modelBadgeFeatured`，与「视觉」pill 同构）。细节见 CHANGELOG
> 「0.1.0-M4+ — 面板收敛」。

- `client/const.ts`：加 `PROVIDER_PATH`（§9）。
- `client/i18n.ts`：zh/en 各加一组 provider 文案键（`tab.provider`、
  `provider.enable`、`provider.enabled`、`provider.disabled`、
  `provider.models`、`provider.allowAll`、`provider.hideAll`、
  `provider.enabledCount`、`provider.registered`、`provider.notRegistered`、
  `provider.error`、`provider.rosterHint`、`provider.save`、`provider.featured`
  等），en 键集钉为 typeof zh。（`provider.probeKept` 随目录表一起删除。）
- `client/panel-page.ts`：**模型 tab** 加一个「接入为 DSH 模型」开关区块
  （enable switch + 模型勾选 + 保存）。具体：
  - 新增第四个 tab `provider`（「接入模型」）或并入「接入」tab。**采用：
    「模型」tab 顶部加 provider 开关行 + 「接入」tab 保留令牌管理**，并新增
    「接入模型」为模型 tab 的 section（`section.provider`）。这样三个 tab
    不变，改动最小、最不打断用户。
  - provider 开关：读 `data.provider`（§11 快照块）或 GET `PROVIDER_PATH`，
    切换即 POST `{enabled}`；状态显示 `registered/notRegistered/error`。
  - 模型勾选：`roster` 每行 checkbox（预选 = 当前 `enabledIds`），勾选变化
    点「保存清单」POST roster。提供「全部 / 清空 / 隐藏全部（哨兵）」快捷。
- `client/cards.ts`：加 `ProviderCard`（开关 + 状态 + roster + 快捷 + 保存）。
- `client/snapshot.ts`：`interpretSnapshot` 透传 `provider` 块；失败分支给
  provider 降级形状。
- `client/styles.ts`：加 `S.providerRow`、`S.checkbox`、`S.switch` 等 token
  （若 sensenova 的 `toggle-switch.ts` 可直接搬，**照抄** `toggle-switch.ts`）。

## 13. 测试与验证

- 新增离线套件（裸 node + strip-types，风格对齐现有 `test/*.test.mjs`）：
  - `test/provider-store.test.mjs`：开关读写/优先级/损坏即忽略/ADR-006 拒绝；
  - `test/llm-models.test.mjs`：`normalizeEntry`/`isVisionModel`/`isChatModel`/
    `toPiDescriptor`/`buildDescriptors`/roster 去重/哨兵；
  - `test/publish-core.test.mjs`：队列串行、disposed 闸、swapRegistration 失败
    恢复旧对；
  - `test/provider-routes.test.mjs`：GET/POST 开关、roster 保存、哨兵、信任围栏。
- `npm test` 现有套件必须仍绿（wire/config/routes/panel/doctor）。
- 改完跑 `npm run typecheck`、`npm run build`（`tsdown` 重出 `lib/` 与根
  `client.js`——**两者已入库**，见 sensenova AGENTS.md，M4 同样要提交产物）。

## 14. 文档与红线

- `README.md` 状态从「v0.1 未实现 M4」改为已接入，写明 provider id、开关位置、
  已知限制（§4 reasoning、§2 目录整条读取）。
- `cordis.patch.yml` 的 `registerProvider` 注释从「占位未实现」改为真实默认
  （默认 `false`，opt-in，与姊妹插件一致）。
- `docs/ROADMAP.md` M4 勾掉。
  ~~本文件归档为 `docs/PROVIDER.md`~~ —— **未执行，且已决定不执行**：M4 之后本文件
  仍继续承担契约职责（M4+ 的 usage-observer 接线、面板收敛都在此登记），改名会
  丢掉「这份文档记录的是 M4 那次改动的契约」这层信息。文件头第 6 行的同一承诺
  一并作废。
- 红线：凭据只经 `tokenStore.resolve()`；`redactSecrets` 过所有日志/错误/
  响应；`registerAdapter` 只在 `llm` 服务存在时调用（`resolveRegistrationService`
  已处理）；Host 侧改动需完全重启 DSH。
