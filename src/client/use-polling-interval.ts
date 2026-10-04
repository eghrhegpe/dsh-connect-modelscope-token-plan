/**
 * The shared polling loop: one interval, paused while the tab is hidden, with
 * an error back-off.
 *
 * Why this module exists: the quota tab and the Raccoon tab each grew their own
 * copy of "set an interval, run `load`, clear it on unmount", and then they
 * drifted in exactly the way duplicated logic always does — the quota copy
 * learned to stop while `document.visibilityState === "hidden"`, the Raccoon
 * copy never did. A user who left the Raccoon tab open in a background window
 * kept it hammering `/api/<ns>/raccoon` every 60 s (every 2 s mid-scan) while
 * the quota tab beside it had gone quiet, and README's "polling stops when the
 * panel is closed" was only true of one of the two. Neither loop had a back-off
 * either: while the Host was down both retried at full cadence until the panel
 * closed. This module is the one definition, so the next tab inherits both
 * behaviours instead of re-deciding them.
 *
 * Two things it deliberately does NOT own: the request itself (each tab has its
 * own generation guard and AbortController) and the "should I even poll" answer
 * (the Raccoon tab must not poll before it is switched on). The caller passes
 * `enabled` and a stable `run`.
 *
 * @module dsh-connect-modelscope-token-plan/use-polling-interval
 */
import { useEffect, useRef } from "./runtime.ts";

/**
 * How long to wait after a failure before trying again.
 *
 * The Host owns the healthy cadence; it does not own this one, because it never
 * sees the failure — a panel whose Host is down is exactly the case where there
 * is no answer to state a cadence in. 60 s is the same floor the Raccoon poll
 * already used in its healthy state, so a failure never polls FASTER than the
 * steady state it is backing off from.
 */
export const ERROR_BACKOFF_MS = 60_000;

/**
 * Run `run()` on an interval that stops while the page is hidden, and slows
 * down while `failed` is true.
 *
 * @param run - the poll body; must be stable (wrap it in `useCallback`), since
 *   it is an effect dependency and a fresh identity would restart the loop on
 *   every render.
 * @param intervalMs - the healthy cadence, in milliseconds.
 * @param options - loop control.
 * @param options.enabled - when false the loop does not run at all (the caller
 *   has decided polling is not wanted); defaults to true.
 * @param options.failed - when true the loop backs off to
 *   {@link ERROR_BACKOFF_MS}, never faster than `intervalMs`.
 */
export function usePollingInterval(
  run: () => void,
  intervalMs: number,
  options: { enabled?: boolean; failed?: boolean } = {}
): void {
  const { enabled = true, failed = false } = options;
  // The interval is clamped to at least 1 ms: a cadence of 0 (or a negative
  // number reaching here from a Host-stated field) would make `setInterval`
  // fire as fast as the event loop allows.
  const healthy = Math.max(1, Math.floor(intervalMs));
  const effective = failed ? Math.max(healthy, ERROR_BACKOFF_MS) : healthy;

  // `run` is read through a ref so a caller that passes a fresh closure each
  // render does not tear the loop down and rebuild it on every render. The
  // loop is about WHEN to run, not WHICH function; the caller's own generation
  // guard is what makes a late answer harmless.
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const fire = () => {
      if (alive) runRef.current();
    };
    const start = () => {
      if (timer === null) timer = setInterval(fire, effective);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    // A mount or a rebuild that lands while the tab is hidden must not start
    // polling: nobody is looking, and the immediate load below would be a
    // request made for no reader.
    if (!hidden()) {
      fire();
      start();
    }
    const onVisibility = () => {
      if (!alive) return;
      if (hidden()) stop();
      else {
        // Coming back gets one fresh read, so a stale screen does not sit there
        // showing numbers from before the tab was hidden.
        fire();
        start();
      }
    };
    if (typeof document !== "undefined" && "addEventListener" in document) {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      alive = false;
      stop();
      if (typeof document !== "undefined" && "addEventListener" in document) {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [effective, enabled]);
}