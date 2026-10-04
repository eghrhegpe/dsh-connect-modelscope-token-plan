/**
 * The shared bones of a provider publisher — the parts that MUST NOT differ
 * between upstreams, factored out so they cannot drift.
 *
 * The publisher (`provider-publish.ts` for the ModelScope provider) runs the
 * same control plane: a publish queue, a `disposed` gate, and a single-point
 * pair registration that doubles as the rollback path. Those three are
 * load-bearing and pinned by tests (PITFALLS §18 for the queue, §19 for the
 * register shape) — and the rollback is the worst place to discover a
 * divergence, because it only runs once something has already failed. When
 * they were written twice, keeping them in sync relied on comments in one file
 * pointing at the other; here there is one copy.
 *
 * What is deliberately NOT shared: the publish GATE and the state shape. The
 * ModelScope side decides from "switch on?" plus a persisted catalog and an
 * allow-list, and restores `entries`/`enabledIds`/quota ids on a rollback;
 * another provider's publisher decides from "switch on?" plus "is there a
 * credential?" and restores its roster. That difference is real domain
 * difference, and folding it into one parameterized state machine would make a
 * publish unreadable — every reader would have to read the configuration to
 * know what one does.
 *
 * Peer-free: touches no runtime peer.
 *
 * @module dsh-connect-modelscope-token-plan/publish-core
 */

import { redactSecrets, errMsg } from "./util.ts";
import { name } from "./host-config.ts";

/** The event a successful (re)registration emits so readers refresh. */
export const ADAPTERS_UPDATED_EVENT = "llm/adapters-updated";

/**
 * The state fields EVERY publisher shares — the part `publish-core` itself
 * reads (`createPairReleaser`, `registerProviderPair`, `unregister`).
 *
 * Declared here, not per publisher (docs/IMPROVEMENTS.md §8): the two
 * publishers' inline literals each pinned `error: null` to the type `null` and
 * `built: null`/`releaseAdapter: null` likewise, so assigning a real error
 * string or release function was a type error in both. The domain fields
 * (`entries`/`enabledIds` vs `rows`/`signature`) stay on each publisher's own
 * interface — the split publish-core.ts's header calls out.
 */
export interface PublisherStateBase {
  /** Whether an `llm` service answering `registerAdapter` is present. */
  llmAvailable: boolean;
  /** Whether our provider pair is currently registered without error. */
  registered: boolean;
  /** The last registration error, surfaced secret-free in the snapshot. */
  error: string | null;
  /** Release functions for the registered pair (recorded by `registerProviderPair`). */
  releaseAdapter: (() => void) | null;
  releaseDirectory: (() => void) | null;
  /** The built adapter the active release functions belong to. */
  built: unknown;
}

/** The error a publisher reports when the Host exposes no `llm` service. */
export const NO_LLM_SERVICE_ERROR = "the Host exposes no llm registration service";

/** The shape check message both publishers raise on a bad factory result. */
export const BAD_FACTORY_SHAPE_ERROR = "the adapter factory did not return { adapter, providerIds }";

/**
 * A publish queue: every publish runs after all the ones in flight.
 *
 * Concurrent publishes are not hypothetical — a mount seed can still be
 * mid-flight when the first panel poll publishes the catalog it just fetched,
 * and a switch flip or a logout can land on top of either. Two publishes
 * interleaving means the SLOWER one wins: it releases the pair the faster one
 * registered and then registers its own, so the Host serves a stale (possibly
 * empty) set while the snapshot reports the fresh one (PITFALLS §18).
 *
 * The chain is the same shape `token-store.ts` uses for `getToken`: no lock
 * object, and a rejected link never poisons the ones behind it.
 * @returns {{
 *   enqueue: (task: () => Promise<unknown>) => Promise<unknown>,
 *   isDisposed: () => boolean,
 *   dispose: () => void
 * }}
 */
export function createPublishQueue() {
  let publishChain = Promise.resolve();
  let disposed = false;
  return {
    /**
     * Queue `task` behind everything in flight and resolve with its result.
     * @param {() => Promise<unknown>} task - the publish to run, in turn.
     * @returns {Promise<unknown>} the task's own settled value.
     */
    enqueue(task: () => Promise<unknown>): Promise<unknown> {
      const queued = publishChain.then(task, task);
      publishChain = queued.then(() => undefined, () => undefined);
      return queued;
    },
    /**
     * Whether the publisher has been disposed. A publish that arrives after
     * dispose registers a provider into a Host that has already withdrawn the
     * plugin: no owner, no release, nothing on screen.
     * @returns {boolean}
     */
    isDisposed: () => disposed,
    /** Mark the publisher disposed; every later publish becomes a no-op. */
    dispose() {
      disposed = true;
    }
  };
}

/**
 * Build the releaser for one publisher's `state`.
 *
 * Releases are idempotent in the Host, and a release that throws must not
 * abort the one behind it — during shutdown or a rollback the service may
 * already be gone.
 * @param {object} state - the publisher state holding the release functions.
 * @returns {() => void} release, safe to call any number of times.
 */
export function createPairReleaser(state: PublisherStateBase) {
  return () => {
    const releaseFn = (fn: (() => void) | null) => {
      try {
        fn?.();
      } catch {
        // The service may already be gone during shutdown or rollback.
      }
    };
    releaseFn(state.releaseAdapter);
    releaseFn(state.releaseDirectory);
    state.releaseAdapter = null;
    state.releaseDirectory = null;
  };
}

/**
 * Hand one built adapter to the `llm` service and record its release
 * functions onto `target`.
 *
 * Defined ONCE because the publish path and the rollback path both register a
 * pair, and two copies drift: a change to the directory row made in one place
 * and not the other leaves the ROLLBACK registering a provider the publish
 * path would never have built — and a rollback only runs once something has
 * already gone wrong, which is the worst possible moment to find out
 * (PITFALLS §19).
 *
 * The releases are written straight onto `target` rather than returned: if the
 * directory call throws AFTER the adapter was registered, the adapter's
 * release must still be reachable, or `release()` cannot undo it and the
 * adapter outlives the plugin.
 * @param {object} llm - the registration service.
 * @param {{providerIds: string[], adapter: unknown}} built - what to register.
 * @param {object} target - where the release functions are recorded.
 * @param {object} identity - the provider's row on the models settings page.
 * @param {string} identity.providerId
 * @param {string} identity.displayName
 * @returns {void}
 */
export function registerProviderPair(llm: { registerAdapter: (providerIds: string[], adapter: unknown) => () => void; registerConfigurableProviders?: (rows: object[]) => () => void }, built: { providerIds: string[]; adapter: unknown }, target: PublisherStateBase, { providerId, displayName }: { providerId: string; displayName: string }): void {
  target.releaseAdapter = llm.registerAdapter(built.providerIds, built.adapter);
  // `registerConfigurableProviders` is how a provider gains its row on the
  // models settings page; an older runtime without it still gets models
  // through the adapter registration above.
  target.releaseDirectory = typeof llm.registerConfigurableProviders === "function"
    ? llm.registerConfigurableProviders([{
        provider: providerId,
        displayName,
        // This plugin's OWN row namespace; declared:false because the row
        // exists as a patch already, not as a provider-declared schema.
        settingsNs: name,
        settingsPath: [],
        declared: false
      }])
    : null;
}

/**
 * Memoize the peer-dependent adapter factory for one publisher.
 *
 * The module is loaded once and the factory is read off it once, so a Host
 * whose peers resolve slowly pays that cost one time, not per publish.
 * @param {() => Promise<object>} loadModule - resolves the adapter module.
 * @param {string} exportName - the factory export to read off the module.
 * @returns {() => Promise<Function>} the memoized factory resolver.
 */
export function createAdapterFactoryResolver(loadModule: () => Promise<object>, exportName: string): () => Promise<((options: unknown) => unknown) | undefined> {
  let adapterFactoryPromise: Promise<((options: unknown) => unknown) | undefined> | undefined;
  return async () => {
    if (adapterFactoryPromise === undefined) {
      adapterFactoryPromise = Promise.resolve(loadModule()).then((mod) => (mod as Record<string, unknown>)?.[exportName] as ((options: unknown) => unknown) | undefined);
    }
    return adapterFactoryPromise;
  };
}

/**
 * Verify a built adapter is really one before it is registered Host-wide.
 *
 * An adapter is registered Host-wide, so a factory that returns anything else
 * must fail here rather than publish a provider that cannot serve a request.
 * @param {unknown} built - what the factory returned.
 * @returns {boolean} whether it is `{ adapter, providerIds }`.
 */
export function isBuiltAdapter(built: unknown): boolean {
  return built !== null && typeof built === "object"
    && Array.isArray((built as { providerIds?: unknown }).providerIds) && (built as { adapter?: unknown }).adapter !== undefined;
}

/**
 * Turn a build failure into a secret-free note plus a hint.
 *
 * A credential never reaches the panel or a log. The failure a reader cannot
 * diagnose from the message alone: the llm peer packages ship INSIDE the Host,
 * so a plugin directory the Host's node_modules cannot be reached from — a dev
 * checkout symlinked into the profile, say — has no way to import them. Say
 * so, with the remedy, because the panel can only report "provider absent".
 * @param {unknown} error - the thrown value (may not be an Error at all).
 * @returns {{note: string, hint: string, error: unknown}} the redacted message,
 *   the optional remedy suffix, and the original value for re-raising.
 */
export function describeBuildFailure(error: unknown): { note: string; hint: string; error: unknown } {
  const annotated = error as Error & { code?: unknown };
  const why = errMsg(error);
  return {
    note: redactSecrets(why),
    hint: annotated?.code === "ERR_MODULE_NOT_FOUND"
      ? " — the llm peer packages ship with the Host; install this plugin where they resolve" +
        " (or link them into its own node_modules)"
      : "",
    error
  };
}

/**
 * Log one build failure the way both publishers log it.
 * @param {object} [logger] - `ctx.logger`.
 * @param {string} label - the upstream's name for the message ("ModelScope").
 * @param {{note: string, hint: string}} described - from `describeBuildFailure`.
 * @returns {void}
 */
export function warnBuildFailure(logger: { warn?: (message: string) => void } | undefined, label: string, described: { note: string; hint: string }): void {
  logger?.warn?.(`${name}: cannot build the ${label} adapter: ${described.note}${described.hint}`);
}

/**
 * Resolve the `llm` registration service, or bail out with the pair released.
 *
 * Both upstreams answer the same question the same way, and the answer is a
 * fact about the Host — not about the provider — so it is one copy: a Host
 * with no `llm` service gets no registration and a stated reason, never a
 * half-built one.
 * @param {object} job
 * @param {object} job.state - the publisher state.
 * @param {(service: string) => object|null} job.getLlm - the service resolver.
 * @param {() => void} job.release - the publisher's releaser.
 * @returns {object|null} the service, or null when it cannot register.
 */
export function resolveRegistrationService({ state, getLlm, release }: { state: PublisherStateBase; getLlm: (service: string) => any; release: () => void }) {
  const llm = getLlm("llm");
  state.llmAvailable = llm !== null && typeof llm.registerAdapter === "function";
  if (!state.llmAvailable) {
    release();
    state.registered = false;
    state.error = NO_LLM_SERVICE_ERROR;
    return null;
  }
  return llm;
}

/**
 * Take the registration down and record why it is gone.
 *
 * `state.built` is cleared along with it, and that matters: a stale `built`
 * survives into the NEXT publish as its rollback target, so a later failed
 * publish would re-register an adapter whose release has already been called.
 * (The Raccoon publisher's "no credential" branch used to leave it standing.)
 * @param {object} job
 * @param {object} job.state - the publisher state.
 * @param {() => void} job.release - the publisher's releaser.
 * @param {string|null} [job.error] - why nothing is registered; null when the
 *   absence is the wanted state (switch off).
 * @returns {{ok: boolean, skipped: boolean}} the publish outcome.
 */
export function unregister({ state, release, error = null }: { state: PublisherStateBase; release: () => void; error?: string | null }) {
  release();
  state.registered = false;
  state.built = null;
  state.error = error;
  return { ok: true, skipped: true };
}

/**
 * Swap the registered pair: take down the old one, register the new one, and
 * restore the OLD one if the new registration throws.
 *
 * This is the other half of PITFALLS §19, and the reason it is shared: the
 * rollback is the path that only runs once something has already gone wrong.
 * A registration that fails AFTER the old pair was released must put the
 * previous one back, or a bad publish takes down models that were already
 * serving. Written twice, the two copies drift; written once, a fix to the
 * rollback reaches both upstreams.
 *
 * @param {object} job
 * @param {object} job.llm - the registration service.
 * @param {{providerIds: string[], adapter: unknown}} job.built - the new pair.
 * @param {unknown} job.previousBuilt - the pair that was serving, or null.
 * @param {object} job.state - the publisher state to record onto.
 * @param {() => void} job.release - the publisher's releaser.
 * @param {(llm: object, built: object, target: object) => void} job.registerPair -
 *   the single-point registrar.
 * @param {(event: string) => void | undefined} job.emit - the Host's raw
 *   `ctx.emit`, if it has one. Optional so the absent case is handled once, in
 *   {@link emitAdaptersUpdated}, rather than by every call site inventing a
 *   no-op stand-in before it gets there.
 * @param {() => void} [job.onRollback] - restore the domain snapshot fields
 *   (`entries`/`enabledIds`, or the roster) to what is really serving.
 * @returns {{ok: boolean, error?: unknown}} the publish outcome.
 */
export function swapRegistration({
  llm,
  built,
  previousBuilt,
  state,
  release,
  registerPair,
  emit,
  onRollback
}: {
  llm: any;
  built: any;
  previousBuilt: any;
  state: PublisherStateBase;
  release: () => void;
  registerPair: (llm: any, built: any, target: PublisherStateBase) => void;
  // `| undefined` inside the optional is deliberate, not a workaround: under
  // `exactOptionalPropertyTypes` a bare `emit?:` would forbid the caller from
  // passing a present-but-absent emitter, which is exactly the state a Host
  // without `ctx.emit` puts this in. A conditional spread would satisfy the
  // compiler too, but only by making "no emitter" and "emitter that is
  // undefined" two different things at the call site.
  emit?: ((event: string) => void) | undefined;
  onRollback?: () => void;
}) {
  // Build first (it can throw); only then take down the old pair.
  release();
  try {
    registerPair(llm, built, state);
  } catch (error) {
    release();
    state.built = null;
    // The snapshot's `offered` set must describe what is really serving, so a
    // failed re-registration restores the previous pair's identity too.
    onRollback?.();
    state.error = redactSecrets(errMsg(error));
    // Restore the pair that was serving, if any.
    if (previousBuilt !== null) {
      try {
        registerPair(llm, previousBuilt, state);
        state.built = previousBuilt;
        state.registered = true;
      } catch {
        state.built = null;
        state.registered = false;
      }
    } else {
      state.registered = false;
    }
    return { ok: false, error };
  }
  state.built = built;
  state.registered = true;
  state.error = null;
  emitAdaptersUpdated(emit);
  return { ok: true };
}

/**
 * Emit the adapter-update event, tolerating a Host that has no `emit` and a
 * Host whose `emit` refuses.
 *
 * This is the ONE place the emit path is defended, and it absorbs both halves
 * of what used to be three layers. The assembly point (`index.ts`) used to wrap
 * `ctx.emit` in its own `try { ctx.emit?.(event) } catch {}`, and each
 * publisher then defaulted a missing `emit` to a no-op
 * (`emit ?? (() => {})`) before handing it here — where a third `try/catch`
 * waited. The middle layer could never do anything: the layer above it had
 * already swallowed every throw, so the no-op fallback was unreachable except
 * for a literal `undefined`, which the outer `?.` had already covered too.
 *
 * @param {((event: string) => void) | undefined} emit - the Host's raw
 *   `ctx.emit`, or `undefined` on a Host that has none.
 * @returns {void}
 */
export function emitAdaptersUpdated(emit: ((event: string) => void) | undefined): void {
  try {
    emit?.(ADAPTERS_UPDATED_EVENT);
  } catch {
    // Deliberately swallowed; see the note above.
  }
}
