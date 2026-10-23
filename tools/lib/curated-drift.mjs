// curated-drift.mjs —— 内置策展表 vs models.dev 上游的漂移判定（纯逻辑，零 IO）。
//
// 存在理由：`src/host/context-catalog.ts` 是**静态知识**，上游（models.dev 的
// api.json）与魔搭目录都会动。2026-10-23 抓到的实证：DeepSeek-V4.1-Flash-1017
// 上架一周后表里还没有它，面板一直显示 128k 兜底——而它在 35 个 host 下众数
// 都是 1M。腐烂是静默的，这个模块把「静默」变成一次可判定的 diff。
//
// 算法是 2026-10-23 四轮探针迭代后的定稿（`.probe-mdev6~9.mjs` 的产物）：
//
//   1. api.json 里每个 provider 的每个模型，canonical_model_id（缺省用模型键）
//      归并成「模型族」；族内按 provider 收集 limit.context 列表。
//   2. 魔搭目录 id（`owner/Base-Name`）先按整串归一化匹配模型键，miss 后按
//      **尾段**（owner 之后那段）匹配——models.dev 的模型键普遍不带 owner
//      前缀（`deepseek-v4-pro`），而我们的 id 带（`deepseek-ai/DeepSeek-V4-Pro`）。
//   3. 多个候选族时取**收录 host 数最多**的那个（并列取字典序最小，保证确定性）。
//   4. 窗口值取族内全部 host 取值的**众数**（并列取小——不放大窗口）。
//
// 已知局限（检查器的定位是「给人看的 diff」，不是权威真值）：
//   - 尾段匹配是启发式：不同 owner 的同名基模型会竞争同一个候选集，靠 host 数
//     决胜。判错时报告里带着 canon 与 host 数，人能一眼看出攀错亲。
//   - 众数与人工策展并不总是一致：2026-10-23 实测 19 条旧条目 3 条对不上，全是
//     十进制/二进制拼写差（1M vs 1MiB = 4.86%、256K vs 256KiB = 2.4%）。这类
//     差不该每周骚扰人，所以单列 `spelling`（≤5%），不进 actionable。
//
// 本模块不做任何网络/文件 IO：取数在 `tools/check-context-catalog.mjs`，
// 测试在 `test/context-catalog-drift.test.mjs` 喂内存夹具。

/**
 * 拼写差容忍度（相对差，按两者较大者为分母）。
 *
 * 5% 卡住的是「同一量级的两种进制拼写」：1MiB/1M = 4.86%、256KiB/256K = 2.4%
 * 都算拼写；128K→1M（87%）这种量级差必须进 drifted。面板展示层两者同文
 * （compactCount 都印 1M/256K），但注册给 provider 的窗口值是实数，差 5% 以上
 * 就该有人看一眼。
 */
export const SPELLING_TOLERANCE = 0.05;

/** 归一化：小写、非字母数字成一串、去首尾连字符。 */
const norm = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** 取 id 的尾段（owner 之后那段）。没有斜杠时原样返回。 */
const baseOf = (value) => String(value).split("/").pop();

/** 众数；并列取较小值（宁可少算窗口，不放大）。 */
function modeOf(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = null;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && (best === null || value < best))) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** 读 modalities 的一个方向（input/output），容错所有坏形状。 */
function modalitiesOf(model, key) {
  const modalities = model?.modalities;
  if (!modalities || typeof modalities !== "object") return [];
  const list = modalities[key];
  if (!Array.isArray(list)) return [];
  return list.map((entry) => String(entry)).filter((entry) => entry !== "");
}

/**
 * 把 api.json 建成可查索引。形状不认识或一个模型都读不出来时**抛错**——
 * 读不出东西而报「没有差异」是绿灯撒谎，调用方必须把这件事当红色处理。
 * @param {unknown} apiJson - models.dev api.json 的解析产物。
 * @returns {{fam: Map<string, Map<string, number[]>>, byFull: Map<string, Set<string>>,
 *           byBase: Map<string, Set<string>>, canonMeta: Map<string, {input: string[], output: string[]}>,
 *           stats: {providers: number, models: number}}}
 */
export function buildUpstreamIndex(apiJson) {
  const providers = apiJson !== null && typeof apiJson === "object"
    ? ((apiJson).providers ?? apiJson)
    : null;
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error("models.dev api.json 形状不认识（既没有 providers 键，顶层也不是 provider 映射）");
  }

  /** canon → Map<providerId, limit.context[]> */
  const fam = new Map();
  /** norm(模型键) → Set<canon>；norm(尾段) → Set<canon>（两条匹配路径）。 */
  const byFull = new Map();
  const byBase = new Map();
  /** canon → modalities 并集（input/output 分开）。 */
  const canonMeta = new Map();

  const add = (map, key, canon) => {
    let set = map.get(key);
    if (set === undefined) {
      set = new Set();
      map.set(key, set);
    }
    set.add(canon);
  };

  let providerCount = 0;
  let modelCount = 0;
  for (const [providerId, provider] of Object.entries(providers)) {
    const models = provider !== null && typeof provider === "object" ? provider.models : null;
    if (models === null || typeof models !== "object" || Array.isArray(models)) continue;
    providerCount += 1;
    for (const [modelKey, model] of Object.entries(models)) {
      if (model === null || typeof model !== "object") continue;
      const context = model.limit !== null && typeof model.limit === "object" ? model.limit.context : undefined;
      if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) continue;
      modelCount += 1;
      const canon = typeof model.canonical_model_id === "string" && model.canonical_model_id !== ""
        ? model.canonical_model_id
        : modelKey;
      let perProvider = fam.get(canon);
      if (perProvider === undefined) {
        perProvider = new Map();
        fam.set(canon, perProvider);
      }
      const list = perProvider.get(providerId) ?? [];
      list.push(context);
      perProvider.set(providerId, list);
      add(byFull, norm(modelKey), canon);
      add(byBase, norm(baseOf(modelKey)), canon);
      const meta = canonMeta.get(canon) ?? { input: [], output: [] };
      for (const entry of modalitiesOf(model, "input")) if (!meta.input.includes(entry)) meta.input.push(entry);
      for (const entry of modalitiesOf(model, "output")) if (!meta.output.includes(entry)) meta.output.push(entry);
      canonMeta.set(canon, meta);
    }
  }
  if (modelCount === 0) {
    throw new Error("models.dev api.json 里一个带 limit.context 的模型都没读到——上游改了形状，这个脚本要跟上");
  }
  return { fam, byFull, byBase, canonMeta, stats: { providers: providerCount, models: modelCount } };
}

/**
 * 查一个魔搭目录 id 在上游的窗口推导值。未收录返回 null（调用方自行落兜底）。
 * @param {ReturnType<typeof buildUpstreamIndex>} index
 * @param {string} id - 魔搭目录 id（`owner/Base-Name`）。
 * @returns {{value: number, canon: string, hosts: number, input: string[], output: string[], chatworthy: boolean}|null}
 */
export function deriveWindow(index, id) {
  if (typeof id !== "string" || id === "") return null;
  let candidates = index.byFull.get(norm(id));
  if (candidates === undefined || candidates.size === 0) candidates = index.byBase.get(norm(baseOf(id)));
  if (candidates === undefined || candidates.size === 0) return null;
  let best = null;
  let bestHosts = -1;
  for (const canon of candidates) {
    const hosts = index.fam.get(canon)?.size ?? 0;
    if (hosts > bestHosts || (hosts === bestHosts && (best === null || canon < best))) {
      best = canon;
      bestHosts = hosts;
    }
  }
  const perProvider = index.fam.get(best);
  if (perProvider === undefined) return null;
  const all = [];
  for (const list of perProvider.values()) all.push(...list);
  const meta = index.canonMeta.get(best);
  const output = meta?.output ?? [];
  return {
    value: modeOf(all),
    canon: best,
    hosts: perProvider.size,
    input: meta?.input ?? [],
    output,
    // 策展表纪律 4：生图/语音模型（无对话上下文）不进表。机械代理： modalities
    // 缺省时放行（老条目普遍没有），声明了 output 且不含 text 的标记出来给人看。
    chatworthy: output.length === 0 || output.includes("text"),
  };
}

/**
 * 内置策展表 vs 上游索引 + live 目录的完整 diff。
 *
 * 分类（报告与退出码的依据）：
 *   - `missing`    目录在、上游推得出、表里没有 → **该补**（1017 事故的类别）。
 *   - `drifted`    表值与上游众数差 >5% → **该复核**。
 *   - `spelling`   差 ≤5%（十进制/二进制拼写）→ 仅备注，不红。
 *   - `delisted`   表里条目不在 live 目录了 → **该删**（纪律：表不是历史档案）。
 *   - `unverifiable` 表里条目上游推不出 → 值失去交叉核对，备注。
 *   - `unsourced`  目录在、上游没有 → 继续落 128k 兜底，信息项。
 *   - `stable`     其余一致条目（只计数）。
 *
 * `catalogIds` 为 null 表示 live 目录没取到：missing/delisted/unsourced 三类
 * **不判**（没有目录事实就不能说人家下架了），drift 侧照常。
 * @param {Record<string, number>} curated - CURATED_CONTEXT_WINDOWS。
 * @param {ReturnType<typeof buildUpstreamIndex>} index
 * @param {string[]|null} catalogIds - live 目录 id 列表，或 null（未知）。
 */
export function diffCuratedTable(curated, index, catalogIds = null) {
  const missing = [];
  const drifted = [];
  const spelling = [];
  const delisted = [];
  const unverifiable = [];
  const unsourced = [];
  let stable = 0;
  const catalogSet = catalogIds === null ? null : new Set(catalogIds);

  for (const [id, curatedValue] of Object.entries(curated)) {
    if (catalogSet !== null && !catalogSet.has(id)) {
      // 目录里没有了 → 该删。live 值还推得出就一并带上（删之前给人看一眼）。
      const live = deriveWindow(index, id);
      delisted.push({ id, curated: curatedValue, live: live === null ? null : live.value });
      continue;
    }
    const live = deriveWindow(index, id);
    if (live === null) {
      unverifiable.push({ id, curated: curatedValue });
      continue;
    }
    if (live.value === curatedValue) {
      stable += 1;
      continue;
    }
    const ratio = Math.abs(live.value - curatedValue) / Math.max(curatedValue, live.value);
    const row = { id, curated: curatedValue, live: live.value, hosts: live.hosts, canon: live.canon };
    if (ratio <= SPELLING_TOLERANCE) spelling.push(row);
    else drifted.push(row);
  }

  if (catalogSet !== null) {
    for (const id of catalogIds) {
      if (Object.hasOwn(curated, id)) continue;
      const live = deriveWindow(index, id);
      if (live === null) unsourced.push(id);
      else missing.push({ id, value: live.value, hosts: live.hosts, input: live.input, output: live.output, canon: live.canon, chatworthy: live.chatworthy });
    }
  }

  return { missing, drifted, spelling, delisted, unverifiable, unsourced, stable, catalogKnown: catalogSet !== null };
}

/**
 * 一次 diff 里「需要人动手」的条目数（退出码 1 的判据）。
 * spelling/unverifiable/unsourced 不计数——它们是信息，不是待办。
 */
export function actionableCount(report) {
  return report.missing.length + report.drifted.length + report.delisted.length;
}
