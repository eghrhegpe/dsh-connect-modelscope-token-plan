/**
 * The provider-registration switch AND its model allow-list — this plugin's OWN
 * state file, never the Host's configuration.
 *
 * Why a file at all: `registerProvider` in `cordis.patch.yml` is a DEPLOYMENT
 * default the operator edits with a reload, but the panel needs a live switch
 * that takes effect on the next request. The switch state therefore lives in
 * `$DSH_HOME/state/<plugin>/provider.json`, exactly like the plugin's other
 * state stores (`usage-store.ts`): operational state, not an operator decision
 * baked into the patch layer.
 *
 * The allow-list rides in the SAME file, not a second one: both fields answer
 * "what does THIS profile want the provider to offer", so they must be read and
 * written as one payload — two files (or two caches over one file) would let a
 * switch flip clobber a list save that landed a tick earlier.
 *
 * Precedence at read time:
 *
 *   1. a value SAVED FROM THE PANEL (enabled: true|false, enabledIds: [...])
 *      always wins;
 *   2. no saved value (never touched, or the file was unreadable) falls back
 *      to the patch's `registerProvider` for the switch, and to "no filter"
 *      (empty list) for the allow-list.
 *
 * Integrity follows `state-store.ts`: a versioned payload, a temp file plus an
 * atomic rename (two Host processes can share the directory), owner-only
 * modes, and "anything unrecognised reads as not set" — a corrupted or
 * downgraded file costs one re-toggle, never a crash. The write side refuses
 * to overwrite a version this build cannot read (ADR-006); the read side stays
 * permissive but REPORTS the disagreement via `versionNote()`, because for the
 * allow-list "unreadable" and "never saved" would otherwise collapse to the
 * same answer — and that answer is "offer every model".
 *
 * The allow-list's empty-vs-absent distinction is the one this module guards:
 * an EMPTY list means "no filter, offer every model", while `HIDE_ALL_MODELS`
 * (`llm-models.ts`) is the caller-side sentinel for "offer nothing". Neither
 * spelling is stored here as `null` — absence of a saved list reads as "no
 * filter", which is the only safe default for a fresh install. A foreign file
 * reads the same way, which is precisely why `versionNote()` exists.
 *
 * @module dsh-connect-modelscope-token-plan/provider-store
 */
import { obj, degrade } from "./util.ts";
import { join } from "node:path";
import { name } from "./host-config.ts";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, readStateVersion, isKnownStateVersion, createStateReadCache, STATE_READ_TTL_MS, profileStateDir, stateDir as sharedStateDir } from "./state-store.ts";

/** The store's constructor options (declared here; `types.ts` carries none). */
interface StoreOptions {
  dir?: string;
  profile?: string | null;
  ttlMs?: number;
  logger?: { warn?: (m: string) => void };
}

/**
 * The payload shape read off `provider.json`. Absence of a key is the same as
 * `null` here (the file may be a legacy build that stored only one of them).
 * `version` is the file's own declaration carried through for the READ side —
 * without it a foreign file would read exactly like an empty one.
 */
interface ProviderPayload {
  enabled: boolean | null;
  enabledIds: string[] | null;
  /**
   * The version number the file declared, or `null` when the file is absent or
   * unreadable. Carried through so the READ side can tell "never saved" apart
   * from "saved by a build this one cannot read" — see {@link versionNote}.
   */
  version: number | null;
}

/**
 * The "nothing stored" payload. Every absent / unreadable / foreign read
 * collapses here, so the three call sites that produce it stay in step instead
 * of each spelling out the same three `null`s.
 */
const EMPTY_PAYLOAD: ProviderPayload = { enabled: null, enabledIds: null, version: null };

/** Shape version, bumped when the persisted form changes incompatibly. */
export const PROVIDER_VERSION = 1;

/**
 * Every persisted shape THIS build can read: the current version plus any
 * historical ones. Bumping {@link PROVIDER_VERSION} means adding the new number
 * here too — otherwise this build would refuse its own newest files.
 *
 * This list is asked in THREE places:
 *   - the write side ({@link writePayload}, ADR-006): an on-disk version not in
 *     this list was written by a NEWER build and must not be clobbered. That
 *     caller asks `isKnownStateVersion(existing, ...)` rather than
 *     {@link isKnownProviderVersion} on purpose — it must also admit `null`
 *     ("no file at all"), which is the one situation where a write belongs.
 *   - the READ side ({@link parseAt}) and the report ({@link versionNote} /
 *     {@link describeProviderPayload}), which ask {@link isKnownProviderVersion}.
 * Keeping the read side and the report on one predicate is what makes them
 * unable to disagree about what a foreign version means.
 */
export const KNOWN_PROVIDER_VERSIONS: readonly number[] = [1];

/**
 * Whether this build can read a file declaring `version`.
 *
 * THE single answer to that question. Note it is deliberately NOT
 * `version === PROVIDER_VERSION`: the whitelist includes shapes this build can
 * read but no longer writes, so comparing against the write version would make a
 * version bump unreadable-of-its-own-files. The original bug behind this function
 * was exactly that split — `parseAt` compared against the write version while the
 * report asked the whitelist, so a bumped build read its own v1 files as "not
 * set" while its report said "nothing to say": the silent collapse the read side
 * exists to kill, resurrected by the upgrade procedure.
 * @param {unknown} version - the value read off disk (may not be a number at all).
 * @returns {boolean}
 */
export function isKnownProviderVersion(version: unknown): boolean {
  return typeof version === "number" && KNOWN_PROVIDER_VERSIONS.includes(version);
}

/**
 * The directory this plugin's state lives in — per-profile when the Host names
 * one, shared otherwise. Unlike the THROTTLE, which is deliberately shared
 * across profiles, this answers "does THIS profile want the provider registered"
 * and must not be overwritten by the other profile's Host.
 * @param {string|null} [profile] - the profile name; `null` means shared.
 * @returns {string} the directory.
 */
export function providerDir(profile: string | null) {
  return profileStateDir(name, profile);
}

/**
 * Normalize an on/off switch: only booleans are real answers.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
 */
export function normalizeEnabled(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * Normalize a persisted allow-list: an array of non-empty strings, de-duplicated
 * and order-preserved. Anything else reads as "no saved list".
 *
 * The de-dup matters: the route publishes this list straight into
 * `filterByEnabled`, and a list carrying one id twice would still filter
 * correctly, but the snapshot echoes `enabledCount` off it — counting a
 * duplicate twice is the kind of drift that takes a while to notice.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {string[]|null} the list, or `null` when nothing usable.
 */
export function normalizeEnabledIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The file-backed provider switch + allow-list.
 * @param {object} [options]
 * @param {string} [options.dir] - override the state directory (tests).
 * @param {string|null} [options.profile] - the profile name; see {@link providerDir}.
 * @param {number} [options.ttlMs] - how long a parsed payload may be reused
 *   before disk is consulted again; defaults to {@link STATE_READ_TTL_MS}.
 * @returns {object} the store.
 */
export function createFileProviderStore(options: StoreOptions = {}) {
  const { dir, profile = null, ttlMs = STATE_READ_TTL_MS, logger } = options;
  const stateDir = dir ?? providerDir(profile);
  const filePath = join(stateDir, "provider.json");

  /**
   * Write one payload atomically to this file.
   *
   * The single writer for every caller (save / saveEnabledIds / forget / the
   * legacy adoption path) — several copies of this is exactly the drift this
   * module keeps getting bitten by.
   *
   * ADR-006 write-side guard: never overwrite a state file this build cannot
   * read. An unknown NUMERIC version means a NEWER build wrote it; clobbering
   * it destroys data we cannot even see. So the write is refused with a
   * `degrade` signal, not a silent no-op — swallow the failure, not the reason.
   * @param {object} body - the JSON body to persist.
   * @returns {Promise<string|null>} the refusal reason when the write was
   *   refused (already `degrade`-logged), or `null` when it landed — the caller
   *   decides whether to surface the refusal to a user.
   */
  const writePayload = async (body: object): Promise<string | null> => {
    const existing = await readStateVersion(filePath);
    if (!isKnownStateVersion(existing, KNOWN_PROVIDER_VERSIONS)) {
      const reason = `provider: refusing to overwrite provider.json holding version ${existing} (this build knows ${KNOWN_PROVIDER_VERSIONS.join("/")})`;
      degrade(reason, null, logger, null);
      return reason;
    }
    const temporary = temporaryOf(stateDir, "provider.json");
    await ensureStateDir(stateDir);
    await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary });
    return null;
  };

  // Pre-§23 machines kept this state in the SHARED directory. A profile-scoped
  // store inherits it once, when its own file is missing — see the note on
  // `createStateReadCache` (`state-store.ts`). An explicit `dir` (the tests)
  // never inherits: it was never part of the shared layout.
  const legacyFile = dir === undefined && profile ? join(sharedStateDir(name), "provider.json") : null;

  /**
   * Read ONE payload off the disk, shape-checked.
   *
   * "Can this build read it" is asked through {@link isKnownProviderVersion} —
   * the same predicate the report and the write guard use. Comparing against
   * {@link PROVIDER_VERSION} instead would say "cannot read" about the OLDEST
   * shapes this build still knows, which is exactly wrong when it is bumped:
   * the header's upgrade rule adds the new number to {@link KNOWN_PROVIDER_VERSIONS},
   * so a v1 file must stay readable while v2 is written. Getting that wrong
   * makes this reader disagree with {@link versionNote} — reads "not set" while
   * the note says "nothing to say", which is the silent collapse this module
   * exists to kill. That split once existed in production code for one release.
   *
   * A version this build cannot read reads as EMPTY, but REMEMBERS which version
   * it was. The ADR-006 guard already refuses to overwrite such a file, so the
   * read side has to be able to say "there is an answer in there, it just is
   * not one we can see" — collapsing it to "never saved" is what made a saved
   * allow-list look like a deliberate "offer every model". See {@link versionNote}.
   */
  const parseAt = async (file: string): Promise<ProviderPayload> => {
    const source = obj(await readStateJson(file));
    const version = typeof source.version === "number" ? source.version : null;
    if (!isKnownProviderVersion(version)) return { enabled: null, enabledIds: null, version };
    return {
      enabled: normalizeEnabled(source.enabled),
      enabledIds: normalizeEnabledIds(source.enabledIds),
      version
    };
  };

  /** Read the profile's own file, shape-checked. */
  const parsePayload = async (): Promise<ProviderPayload> => parseAt(filePath);

  /** Read one payload off an explicit path (the legacy shared file). */
  const parsePayloadFrom = async (file: string): Promise<ProviderPayload> => parseAt(file);

  // The write chain. Declared BEFORE the cache so the cache's read-through (which
  // queues the legacy adoption onto it) refers only to things above it.
  let writeChain: Promise<string | null> = Promise.resolve(null);

  // Short-TTL read cache over the WHOLE payload: "someone else edited this
  // file" must become visible here within a tick, not after a restart, but one
  // poll must not re-read the file for every question it asks.
  //
  // legacy 回填是**读路径内**触发的写，所以它也走 `writeChain`：否则它与并发的
  // `patchPayload` 竞争——用户刚保存的清单会被旧布局的继承值盖掉（而继承只发生
  // 一次，所以那次覆盖是永久的）。
  const cache = createStateReadCache<ProviderPayload>(async () => {
    const own = await parsePayload();
    if (own.enabled !== null || own.enabledIds !== null || legacyFile === null) return own;
    // A file that CARRIES a version reads as EMPTY too, and that case covers
    // TWO different files — neither of which the adoption write would serve:
    //   - a version this build cannot read: the write is certain to be refused
    //     by the ADR-006 guard, so skipping it saves a `degraded:` warning every
    //     read-TTL (60/minute) for a write that could not land anyway;
    //   - a file THIS build wrote with no answers in it: `forget()` produces
    //     exactly `{version, updatedAt}`. Adoption must NOT resurrect pre-§23
    //     values there — the operator explicitly reset, and a legacy file must
    //     not undo that on the next tick.
    // An absent file reads as version null, so the one case where adoption
    // belongs (nothing stored yet) still falls through.
    if (own.version !== null) return own;
    const legacy = await parsePayloadFrom(legacyFile);
    if (legacy.enabled === null && legacy.enabledIds === null) return own;
    const inherited = {
      version: PROVIDER_VERSION,
      ...(legacy.enabled === null ? {} : { enabled: legacy.enabled }),
      ...(legacy.enabledIds === null ? {} : { enabledIds: legacy.enabledIds }),
      updatedAt: new Date().toISOString()
    };
    await writeChain.then(
      () => writePayload(inherited).then(() => undefined, () => undefined),
      () => writePayload(inherited).then(() => undefined, () => undefined)
    );
    return legacy;
  }, { ttlMs });
  const read = () => cache.read();

  /**
   * The payload the callers actually read. The short-TTL cache's `read()` is
   * typed `Promise<T | null>` because it doubles as "never read" signalling for
   * the §23 legacy adoption; a provider payload is always an object, so the
   * `null` branch collapses here, in one place, rather than at every caller.
   * @returns {Promise<ProviderPayload>} the payload; the empty payload when nothing is stored.
   */
  const readPayload = async (): Promise<ProviderPayload> => (await read()) ?? EMPTY_PAYLOAD;

  /**
   * Read one payload, then hand it to {@link writePayload} — the read-modify-
   * write that keeps the switch and the list from clobbering each other.
   *
   * Three-state keys, and they are SYMMETRIC between `enabled` and `enabledIds`:
   * a key the caller omits (`undefined`) keeps whatever is on disk, an explicit
   * `null` clears it back to "not set" (the ABSENCE of the key — that is how
   * {@link forget} expresses "fall back to the config default"), and any other
   * value is stored as given. An earlier `mergeEnabled` flag applied the
   * "keep what is on disk" rule to `enabled` unconditionally, which silently
   * discarded the very value a switch save was asked to store.
   *
   * 读-改-写**整段排队**：两个并发 patch 不能互相覆盖。这个 store 以前完全没有
   * 写串行化（对比 `usage-store.ts` 的 `writeChain`），于是面板开关 POST 与
   * roster POST —— 两个独立请求，外加 `index.ts` 轮询同时在调 `enabledIds()` ——
   * 会各自读到同一个 `current`，后写的赢。实测：先存清单，再并发 `save(true)` +
   * `saveEnabledIds([...])`，其中一次保存被**整个丢掉**（用户勾了模型又开了开关，
   * 两次点击只活下来一次）。文件头说「两个字段必须作为一个载荷读写，否则开关会
   * 覆盖清单」——设计意图是对的，但那只防住了「**不同字段**互相覆盖」；缺了串行化，
   * **同字段**与「两次都基于同一快照」的互相覆盖照样发生。链的形状与
   * `usage-store` 一致，且必须把 `writePayload` 的版本拒绝语义一起搬进临界区
   * （否则拒绝判断会落在锁外）。
   *
   * 链吞掉自己的失败继续走：一次只读 Home 上的写失败不该毒化后续所有保存。
   *
   * 写成功的同时更新读缓存，调用方不再各自回读一遍：缓存里永远是刚写下去的那份，
   * 而 `patchPayload` 的 `current` 来自磁盘（`parsePayload`，不走缓存），所以合并
   * 结果不会带进过期值。此前的写法是写完再 `readPayload()` 读回另一半——那条回读
   * 走的是 TTL 缓存，拿到的是**写入前**的值，并发时会把一个较新的缓存项顶成旧值。
   *
   * @param {object} patch - `{ enabled?, enabledIds? }` to persist.
   * @returns {Promise<string|null>} the write refusal reason, or `null`.
   */
  const patchPayload = (patch: { enabled?: boolean | null; enabledIds?: string[] | null }): Promise<string | null> => {
    const run = writeChain.then(async () => {
      const current = await parsePayload();
      /** `undefined` keeps the stored key; `null` clears it (key absent). */
      const body: Record<string, unknown> = { version: PROVIDER_VERSION };
      const enabled = patch.enabled === undefined ? current.enabled : patch.enabled;
      if (enabled !== null) body.enabled = enabled;
      const enabledIds = patch.enabledIds === undefined ? current.enabledIds : patch.enabledIds;
      if (enabledIds !== null) body.enabledIds = enabledIds;
      body.updatedAt = new Date().toISOString();
      const refusal = await writePayload(body);
      if (refusal === null) cache.remember({ enabled, enabledIds, version: PROVIDER_VERSION });
      return refusal;
    });
    writeChain = run.catch(() => null);
    return run;
  };

  return {
    /**
     * The saved switch value.
     * @returns {Promise<boolean|null>} `null` = not set, fall back to config.
     */
    async enabled() {
      return (await readPayload()).enabled;
    },
    /**
     * The saved model allow-list.
     * @returns {Promise<string[]>} the saved ids; an EMPTY list means "no
     *   filter, offer every model" (also the answer for a never-saved list).
     */
    async enabledIds() {
      return (await readPayload()).enabledIds ?? [];
    },
    /**
     * Whether the panel has ever saved a value here.
     * @returns {Promise<boolean>}
     */
    async isSet() {
      const payload = await readPayload();
      return payload.enabled !== null || payload.enabledIds !== null;
    },
    /**
     * A human-readable note when the file holds a version this build cannot
     * read, or `null` when there is nothing to say.
     *
     * The READ side is permissive on purpose: a foreign file reads as "not set",
     * so the panel keeps working instead of failing the whole snapshot. The cost
     * is that it cannot tell "never saved" from "saved but unreadable" — and
     * for the allow-list those two read differently in the dangerous direction
     * (an empty list means "offer every model"). Writes are already protected by
     * the ADR-006 guard in {@link writePayload}; this note is the read side's
     * half of the same promise. The snapshot aggregate pushes it into
     * `shapeWarnings`, and `doctor.ts` reports the same file, so the operator
     * sees the disagreement instead of a switch that looks merely unset.
     *
     * @returns {Promise<string|null>}
     */
    async versionNote(): Promise<string | null> {
      const version = (await readPayload()).version;
      // `null` is silent for a different reason than a known version: there is
      // no version number to report at all (no file, or the file does not parse).
      // The predicate alone cannot say that, and it must not — the write side
      // reads `null` as "no file, a write belongs" (see isKnownStateVersion).
      if (version === null || isKnownProviderVersion(version)) return null;
      return (
        `provider-state: provider.json holds version ${version}, which this build cannot read` +
        ` (this build knows ${KNOWN_PROVIDER_VERSIONS.join("/")}); the saved switch and allow-list` +
        ` are being answered as "not set", so the allow-list reads as "no filter, offer every model"` +
        ` while the switch falls back to the config default. Upgrade this build to see the saved values,` +
        " or delete the file to reset them."
      );
    },
    /**
     * Persist a switch value. The write is atomic (temp file + rename) so a
     * concurrent reader never sees a partial payload, and it PRESERVES the
     * saved allow-list.
     * @param {boolean} value - the new switch state.
     * @returns {Promise<void>}
     */
    async save(value: boolean) {
      const enabled = normalizeEnabled(value);
      if (enabled === null) throw new TypeError("provider switch expects a boolean");
      // Write failures PROPAGATE on purpose: a switch the panel ordered must
      // not silently stay off because the state file could not be written.
      // An ADR-006 refusal SURFACES, not just logs: this is an explicit user
      // action, and the route re-reads the value on the same request — silence
      // here left the panel showing an unchanged switch with no reason to act.
      const refusal = await patchPayload({ enabled });
      if (refusal !== null) throw new Error(refusal);
    },
    /**
     * Persist the model allow-list, preserving the saved switch.
     * @param {string[]} ids - the ids to offer (empty = offer all).
     * @returns {Promise<void>}
     */
    async saveEnabledIds(ids: string[]) {
      const list = normalizeEnabledIds(ids);
      if (list === null) throw new TypeError("provider allow-list expects an array of strings");
      const refusal = await patchPayload({ enabledIds: list });
      if (refusal !== null) throw new Error(refusal);
    },
    /**
     * Forget the panel-saved values: the config default and "no filter" rule
     * again.
     * @returns {Promise<void>}
     */
    async forget() {
      // No `enabled`/`enabledIds` keys: "not set" is the absence of an answer,
      // not `false`/an empty list. A refused write (ADR-006) leaves the file
      // exactly as it was, so the throw below is the only signal.
      const refusal = await patchPayload({ enabled: null, enabledIds: null });
      if (refusal !== null) throw new Error(refusal);
    }
  };
}

/**
 * doctor 的只读速览：不构造 store、不碰缓存，直接解析一份 provider.json 载荷，
 * 回答「这份文件本构建还认不认、里面有没有保存过开关与清单」。整个载荷不认识
 * 时是 `null`；认识但版本未知时 `versionKnown:false` —— doctor 据此区分「损坏」
 * 与「更新构建写的」两种提示。
 *
 * 与 usage-store 的 {@link describeUsagePayload} 同形：清单只报条数，不把模型 id
 * 列表带进报告（它们已在目录里，报告里重复一遍只是噪声）。`enabledIds: null` 与
 * `0` 分开 —— 前者是「面板从没保存过」，后者是「保存了空清单 = 不过滤」。
 *
 * 版本判据与本 store 的 `parseAt` 是**同一套**（都问
 * `KNOWN_PROVIDER_VERSIONS`，都不问 `PROVIDER_VERSION`）。这条同源性是承重的：
 * 若 `parseAt` 改成与当前版本比较，`PROVIDER_VERSION` 一旦升级，它就会读作
 * 「未设置」而这里仍报 `versionKnown:true`——读侧与说明互相打脸，静默塌缩复活。
 * doctor 不另立第三套。
 */
export function describeProviderPayload(
  raw: unknown
): { versionKnown: boolean; enabled: boolean | null; enabledIds: number | null } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const version = source.version;
  if (typeof version !== "number") return null;
  const ids = normalizeEnabledIds(source.enabledIds);
  return {
    versionKnown: isKnownProviderVersion(version),
    enabled: normalizeEnabled(source.enabled),
    enabledIds: ids === null ? null : ids.length
  };
}
