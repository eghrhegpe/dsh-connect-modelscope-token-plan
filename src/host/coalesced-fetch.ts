/**
 * One coalescing read-through cache: a TTL cache plus ONE in-flight promise
 * per key.
 *
 * Two properties every caller needs, and that are easy to get wrong when each
 * fetch re-implements them by hand (as `console-client.ts` once did twice):
 *
 *   1. **Single flight** — N concurrent readers of one key share ONE upstream
 *      call. Without it, every open panel (or tab) polling at once issues its
 *      own request, which is how a Host walks into the platform's own rate
 *      limiter.
 *   2. **Read-through TTL** — a fresh answer is served from memory; a stale one
 *      is refetched.
 *
 * A REJECTED producer is shared but never cached: a failure is not an answer,
 * and caching one would pin an error on the panel for a whole TTL after a
 * single transient hiccup. Sharing the rejection is still correct — the callers
 * asked for the same thing at the same time and get the same outcome.
 *
 * The maps are injectable so a caller can share one cache across modules (the
 * console route's `cache`/`inflight` pair is created in `index.ts` and cleared
 * wholesale when the account or key changes).
 *
 * @module dsh-connect-modelscope-token-plan/coalesced-fetch
 */

/**
 * The longest TTL any caller may use; entries older than this are swept so the
 * map cannot grow without bound when keys are per-credential and credentials
 * rotate.
 */
export const MAX_CACHE_AGE_MS = 3600_000;

/**
 * The generation state for one shared cache map.
 *
 * Keyed by the cache MAP rather than held per instance, and that is load
 * bearing: a caller may construct a fresh `createCoalescedFetch` on every
 * request while injecting one long-lived shared map (which is exactly what
 * `console-client.ts` does, over the `cache`/`inflight` pair created in
 * `index.ts`). Per-instance counters would reset to 0 on every call, so a
 * `clear()` bump would be invisible to the very next read and a pre-clear
 * flight's answer would be served to the account that just signed in.
 * Hanging the counters off the map makes every instance over that map share
 * one generation state, so the guard holds no matter how the caller builds it.
 */
const GENERATIONS = new WeakMap<object, { global: number; keys: Map<string, number> }>();

/** The (created-on-demand) generation state belonging to one cache map. */
function generationsOf(cache: object) {
  let state = GENERATIONS.get(cache);
  if (state === undefined) {
    state = { global: 0, keys: new Map<string, number>() };
    GENERATIONS.set(cache, state);
  }
  return state;
}

/**
 * Drop one key's cached answer, or the whole cache, bumping generations.
 *
 * Exported separately from the instance so a caller that only owns the raw
 * maps — the account and api-key routes, which must invalidate the console
 * cache the moment the credential changes — can invalidate WITHOUT having to
 * construct an instance first. It shares `generationsOf`, so an instance's own
 * `clear()` and this function are the same operation.
 * @param {Map<string, unknown>} cache - the cache map to drop from.
 * @param {Map<string, Promise<unknown>>} inflight - its in-flight companion.
 * @param {string} [key] - the key to drop; omit to drop everything.
 * @returns {void}
 */
export function clearCoalescedFetch(
  cache: Map<string, unknown>,
  inflight: Map<string, Promise<unknown>>,
  key?: string
): void {
  const gens = generationsOf(cache);
  if (key === undefined) {
    gens.global += 1;
    cache.clear();
    // A pre-clear flight must not be joinable by the next read either.
    inflight.clear();
    gens.keys.clear();
    return;
  }
  gens.keys.set(key, (gens.keys.get(key) ?? gens.global) + 1);
  cache.delete(key);
  inflight.delete(key);
}

/**
 * A coalescing read-through cache.
 * @param {object} [options]
 * @param {Map<string, {body: unknown, at: number, gen: number}>} [options.cache] -
 *   an existing cache map to share; a fresh one is created when omitted.
 * @param {Map<string, Promise<unknown>>} [options.inflight] - an existing
 *   in-flight map to share.
 * @param {number} [options.maxAgeMs] - the sweep ceiling.
 * @returns {{
 *   read: (key: string, producer: () => Promise<unknown>, ttlMs: number) => Promise<unknown>,
 *   clear: (key?: string) => void
 * }}
 */
export function createCoalescedFetch(options: {
  cache?: Map<string, { body: unknown; at: number; gen: number }>;
  inflight?: Map<string, Promise<unknown>>;
  maxAgeMs?: number;
} = {}) {
  const {
    cache = new Map(),
    inflight = new Map(),
    maxAgeMs = MAX_CACHE_AGE_MS
  } = options;

  // Generation counters, one per key and one global: `clear()` bumps them so a
  // STALE in-flight producer — the one that started before the clear and lands
  // after it — cannot write its answer back where a newer identity now owns the
  // key. Each cache entry carries the generation it was written under; a read
  // only accepts entries whose generation matches the key's CURRENT one, so a
  // late write from a pre-clear flight is written but immediately invisible,
  // and the next read simply refetches. This is what makes `clear()`'s promise
  // (below) actually hold in the concurrent case.
  //
  // The counters live on the cache map (see `generationsOf`), NOT in this
  // closure: a fresh instance over an existing map must observe the bumps a
  // previous instance — or `clearCoalescedFetch` — already made.
  const gens = generationsOf(cache);
  const genOf = (key: string) => gens.keys.get(key) ?? gens.global;

  /** Drop entries past the sweep ceiling; called after every write. */
  const sweep = () => {
    const nowMs = Date.now();
    for (const [key, entry] of cache) {
      if (nowMs - entry.at > maxAgeMs) cache.delete(key);
    }
  };

  /**
   * Read one key through the cache, coalescing concurrent misses.
   * @param {string} key - the cache key: a URL, or a key that also carries a
   *   credential fingerprint when the answer depends on which token is in play.
   * @param {() => Promise<unknown>} producer - what to call on a miss.
   * @param {number} ttlMs - how long an answer stays fresh (`0` = never
   *   reuse; the single-flight sharing still applies).
   * @returns {Promise<unknown>} the value.
   */
  const read = async (key: string, producer: () => Promise<unknown>, ttlMs: number) => {
    const cached = cache.get(key);
    if (cached !== undefined && cached.gen === genOf(key) && Date.now() - cached.at < ttlMs) return cached.body;
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    // Capture the generation the flight is born under: if `clear()` runs while
    // this producer is in flight, the write below lands under the OLD gen and
    // is ignored by every later read.
    const born = genOf(key);
    const flight = (async () => {
      const body = await producer();
      cache.set(key, { body, at: Date.now(), gen: born });
      sweep();
      return body;
    })().finally(() => {
      // Runs on BOTH paths: a rejection must not leave a poisoned promise
      // behind, or every later reader of this key inherits that failure.
      //
      // The identity check is load-bearing, not a micro-optimization. This
      // finally belongs to a flight born under an OLD generation, and it can
      // settle LONG after a `clear()` (which does `inflight.delete(key)` and a
      // later read installs a FRESH flight for the same key). Deleting
      // unconditionally would let the discarded flight evict its own
      // successor: the next reader would find the slot empty and start a
      // SECOND producer for a key that is already in flight — silently
      // breaking the single-flight property this module exists to provide,
      // and sending the panel back into the platform's rate limiter.
      // Deleting only the promise that still occupies the slot leaves an
      // unrelated flight untouched. (The evicted flight's own cache write is
      // already handled by the `gen` check on read.)
      if (inflight.get(key) === flight) inflight.delete(key);
    });
    inflight.set(key, flight);
    return flight;
  };

  /**
   * Drop one key's cached answer, or the whole cache.
   *
   * The drop bumps the key's (or the global) generation AND evicts the
   * in-flight map entry, so the NEXT read cannot join a pre-clear flight nor be
   * served a pre-clear cache entry — the previous identity's answer is gone for
   * good even when its producer was still in flight when the change happened.
   * In-flight calls themselves are NOT cancelled: a reader that already took a
   * flight's promise still settles with what it asked for; only NEW reads miss.
   * @param {string} [key] - the key to drop; omit to drop everything.
   * @returns {void}
   */
  const clear = (key?: string) => clearCoalescedFetch(cache, inflight, key);

  return { read, clear };
}
