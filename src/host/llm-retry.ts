/**
 * The directly-registered ModelScope provider's 429 retry policy — the peer-FREE
 * half of the 429 self-healing work.
 *
 * The *decision* (which failure classes this shared-pool provider retries, and
 * how gently) is pure, so it lives here — importable on a clean checkout where
 * the `@deepseek-ai/dsh-llm` peer is not resolvable — and is handed to the peer's
 * `resolveRetryPolicy` from `llm-adapter.ts`. `test/retry.test.mjs` pins its
 * shape without importing that peer.
 *
 * The peer classifies a ModelScope 429 into two codes (`isQuotaExceededError` →
 * `rate.?limit` inside `classifyPiAiError`). That classification ORDER is not
 * pinned by any test — verifying it needs the runtime peer, which is not
 * vendored here (see docs/ROADMAP.md Backlog). Read on with that in mind:
 *
 *   - `QUOTA` / `ACCOUNT_QUOTA` — the Token Plan pool is depleted. Retrying
 *     cannot refill it, and the pool is SHARED across every model on this key,
 *     so hammering it only extends the cool-down (the same lesson `st-rotator`
 *     bakes into its AIMD limiter). Deliberately NOT retried: fast-fail and let
 *     the panel say why.
 *   - `RATE_LIMIT` — a transient throttle that self-clears. Retried, with a
 *     backoff biased longer than the peer default so one shared pool is not
 *     re-hit immediately: ModelScope's daytime rpm/tpm ceiling is aggressive
 *     (`llm-error-fix.ts`: its `quota_exceeded_error` code 8 is really a
 *     per-minute rate cap), so we ride it out with more attempts and a gentler
 *     first step.
 *
 * @module dsh-connect-modelscope-token-plan/llm-retry
 */

/**
 * The failure-class codes this provider reasons about, in peer-canonical
 * spelling.
 *
 * The strings mirror the `@deepseek-ai/dsh-llm` peer's error-code constants
 * (`QUOTA_EXCEEDED_CODE = "QUOTA"`, `ACCOUNT_QUOTA_EXCEEDED_CODE =
 * "ACCOUNT_QUOTA"`, `EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE"`). They are stable
 * protocol codes, not implementation details, so pinning them here is what the
 * qoder route does too; `llm-adapter.ts` still imports the live constants from
 * the peer and passes them through `resolveRetryPolicy`, so a peer rename would
 * surface at the adapter, not silently drift here.
 */
export const QUOTA_CODES = Object.freeze({
  /** Depleted Token Plan pool (per-pool quota). Not retried. */
  quota: "QUOTA",
  /** Depleted account-level quota. Not retried. */
  accountQuota: "ACCOUNT_QUOTA",
  /** Empty/truncated response. Retried. */
  emptyResponse: "EMPTY_RESPONSE",
  /** Transient throttle (429 rate). Retried with backoff. */
  rateLimit: "RATE_LIMIT",
  /** Upstream 5xx. Retried. */
  server: "SERVER",
  /** Request deadline exceeded. Retried. */
  timeout: "TIMEOUT",
  /** Connection-level failure. Retried. */
  transport: "TRANSPORT"
});

/**
 * The failure classes this provider retries, in peer-canonical order.
 *
 * Excludes both quota codes on purpose: a depleted pool cannot be retried into
 * health, and retrying it against a shared credit pool only prolongs the
 * cool-down. `RATE_LIMIT` stays — transient throttles self-clear.
 * @returns {string[]} the retryable code list (no duplicates, non-empty).
 */
export function retryableCodes() {
  return [
    QUOTA_CODES.emptyResponse,
    QUOTA_CODES.rateLimit,
    QUOTA_CODES.server,
    QUOTA_CODES.timeout,
    QUOTA_CODES.transport
  ];
}

/**
 * Build the provider's retry-policy config.
 *
 * The shape is exactly what `@deepseek-ai/dsh-llm`'s `resolveRetryPolicy`
 * accepts (`mode: "normal"` → `{ mode, maxRetries, retryableCodes, backoff }`).
 * We pin it explicitly rather than passing `undefined` so a future change to
 * the peer's default policy cannot silently alter this provider's behaviour.
 * This module's shape is pinned by `test/retry.test.mjs`. The live peer's
 * `resolveRetryPolicy` contract is NOT covered by any test: verifying it needs
 * the runtime peer, which is not vendored here and so cannot run inside the
 * offline `npm test` gate (docs/ROADMAP.md Backlog). If the peer ever changes
 * its policy shape, this provider fails silently at runtime — no gate turns red.
 *
 * Tuned for ModelScope's daytime rate ceiling (rpm/tpm), which the peer mislabels
 * as `QUOTA` — `llm-error-fix.ts` pulls those back to `RATE_LIMIT` so they
 * reach this policy. The numbers: more attempts (8) and a gentler, longer
 * backoff than the peer default (initial 1.5s → cap 20s, jitter 0.25) so a
 * single shared credit pool is not stampeded while the rate window refills.
 * Still bounded: a genuine outage fails after ~90s of backed-off retries rather
 * than spinning forever. QUOTA stays excluded (a depleted pool cannot be retried
 * into health; retrying it only prolongs the cool-down — ROADMAP §1).
 * @returns {{mode: "normal", maxRetries: number, retryableCodes: string[], backoff: {initialDelayMs: number, maxDelayMs: number, jitterRatio: number}}}
 */
export function buildRetryPolicyConfig() {
  return {
    mode: "normal",
    maxRetries: 8,
    retryableCodes: retryableCodes(),
    backoff: {
      initialDelayMs: 1_500,
      maxDelayMs: 20_000,
      jitterRatio: 0.25
    }
  };
}
