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
 * downgraded file costs one re-toggle, never a crash.
 *
 * The allow-list's empty-vs-absent distinction is the one this module guards:
 * an EMPTY list means "no filter, offer every model", while `HIDE_ALL_MODELS`
 * (`llm-models.ts`) is the caller-side sentinel for "offer nothing". Neither
 * spelling is stored here as `null` — absence of a saved list reads as "no
 * filter", which is the only safe default for a fresh install.
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
 */
interface ProviderPayload {
  enabled: boolean | null;
  enabledIds: string[] | null;
}

/** Shape version, bumped when the persisted form changes incompatibly. */
export const PROVIDER_VERSION = 1;

/**
 * Every persisted shape THIS build can read: the current version plus any
 * historical ones. Bumping {@link PROVIDER_VERSION} means adding the new number
 * here too — otherwise this build would refuse its own newest files.
 *
 * This is the ADR-006 write-side guard's whitelist: an on-disk version not in
 * this list was written by a NEWER build, and must not be clobbered (see
 * {@link writePayload}).
 */
export const KNOWN_PROVIDER_VERSIONS: readonly number[] = [1];

/**
 * The directory this plugin's state lives in — per-profile when the Host names
 * one, shared otherwise (PITFALLS §23). Unlike the THROTTLE, which is
 * deliberately shared across profiles, this answers "does THIS profile want the
 * provider registered" and must not be overwritten by the other profile's Host.
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
   * §23 legacy adoption) — several copies of this is exactly the drift this
   * module keeps getting bitten by.
   *
   * ADR-006 write-side guard: never overwrite a state file this build cannot
   * read. An unknown NUMERIC version means a NEWER build wrote it; clobbering
   * it destroys data we cannot even see. So the write is refused with a
   * `degrade` signal, not a silent no-op — the PITFALLS §37 discipline: swallow
   * the failure, not the reason.
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

  /** Read ONE payload off the disk, shape-checked. */
  const parsePayload = async (): Promise<ProviderPayload> => {
    const raw = await readStateJson(filePath);
    const source = obj(raw);
    if (source.version !== PROVIDER_VERSION) return { enabled: null, enabledIds: null };
    return {
      enabled: normalizeEnabled(source.enabled),
      enabledIds: normalizeEnabledIds(source.enabledIds)
    };
  };

  /**
   * Read one payload, then hand it to `write` — the read-modify-write that keeps
   * the switch and the list from clobbering each other.
   *
   * Three-state keys, and they are SYMMETRIC between `enabled` and `enabledIds`:
   * a key the caller omits (`undefined`) keeps whatever is on disk, an explicit
   * `null` clears it back to "not set" (the ABSENCE of the key — that is how
   * {@link forget} expresses "fall back to the config default"), and any other
   * value is stored as given. An earlier `mergeEnabled` flag applied the
   * "keep what is on disk" rule to `enabled` unconditionally, which silently
   * discarded the very value a switch save was asked to store.
   * @param {object} patch - `{ enabled?, enabledIds? }` to persist.
   * @returns {Promise<string|null>} the write refusal reason, or `null`.
   */
  const patchPayload = async (patch: { enabled?: boolean | null; enabledIds?: string[] | null }) => {
    const current = await parsePayload();
    /** `undefined` keeps the stored key; `null` clears it (key absent). */
    const body: Record<string, unknown> = { version: PROVIDER_VERSION };
    const enabled = patch.enabled === undefined ? current.enabled : patch.enabled;
    if (enabled !== null) body.enabled = enabled;
    const enabledIds = patch.enabledIds === undefined ? current.enabledIds : patch.enabledIds;
    if (enabledIds !== null) body.enabledIds = enabledIds;
    body.updatedAt = new Date().toISOString();
    return writePayload(body);
  };

  // Short-TTL read cache over the WHOLE payload: "someone else edited this
  // file" must become visible here within a tick, not after a restart, but one
  // poll must not re-read the file for every question it asks.
  const cache = createStateReadCache<ProviderPayload>(async () => {
    const own = await parsePayload();
    if (own.enabled !== null || own.enabledIds !== null || legacyFile === null) return own;
    const legacy = await parsePayloadFrom(legacyFile);
    if (legacy.enabled === null && legacy.enabledIds === null) return own;
    try {
      await writePayload({
        version: PROVIDER_VERSION,
        ...(legacy.enabled === null ? {} : { enabled: legacy.enabled }),
        ...(legacy.enabledIds === null ? {} : { enabledIds: legacy.enabledIds }),
        updatedAt: new Date().toISOString()
      });
    } catch {
      // Read-only Home, or another process won the race.
    }
    return legacy;
  }, { ttlMs });
  const read = () => cache.read();

  /**
   * The payload the callers actually read. The short-TTL cache's `read()` is
   * typed `Promise<T | null>` because it doubles as "never read" signalling for
   * the §23 legacy adoption; a provider payload is always an object, so the
   * `null` branch collapses here, in one place, rather than at every caller.
   * @returns {Promise<ProviderPayload>} the payload; `{enabled:null,enabledIds:null}` when nothing is stored.
   */
  const readPayload = async (): Promise<ProviderPayload> =>
    (await read()) ?? { enabled: null, enabledIds: null };

  /** Read one payload off an explicit path (the legacy shared file). */
  const parsePayloadFrom = async (file: string): Promise<ProviderPayload> => {
    const raw = await readStateJson(file);
    const source = obj(raw);
    if (source.version !== PROVIDER_VERSION) return { enabled: null, enabledIds: null };
    return {
      enabled: normalizeEnabled(source.enabled),
      enabledIds: normalizeEnabledIds(source.enabledIds)
    };
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
      cache.remember({ enabled, enabledIds: (await readPayload()).enabledIds ?? [] });
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
      cache.remember({ enabled: (await readPayload()).enabled ?? null, enabledIds: list });
    },
    /**
     * Forget the panel-saved values: the config default and "no filter" rule
     * again.
     * @returns {Promise<void>}
     */
    async forget() {
      // No `enabled`/`enabledIds` keys: "not set" is the absence of an answer,
      // not `false`/an empty list. Remember only once the write landed — a
      // refused write (ADR-006) leaves the file exactly as it was.
      const refusal = await patchPayload({ enabled: null, enabledIds: null });
      if (refusal !== null) throw new Error(refusal);
      cache.remember({ enabled: null, enabledIds: null });
    }
  };
}
