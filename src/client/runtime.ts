/**
 * The React seam.
 *
 * The loader materializes `clientFactory(loaderRequire)` with the browser
 * module table's own React — the client never imports a React package, and
 * the Node suites hand the factory a recording stand-in instead. Every other
 * module reads React through here: `provideClientReact` runs once at factory
 * entry, and the forwarded `h`/hooks below resolve through it at render time.
 *
 * Call sites stay identical to the pre-split closure form (`h("div", ...)`,
 * `useState(...)`), so the components are transcriptions, not rewrites.
 *
 * The factory parameter is named `loaderRequire` — NOT `require` — on purpose:
 * a bare `require("react")` in bundled ESM is module-system syntax as far as a
 * bundler is concerned (it may rewrite or resolve it); any other identifier is
 * verifiably a plain parameter call and survives the bundle untouched.
 */
import type { zh } from "./i18n.ts";

/** Minimal structural view of the React API the client actually uses. */
export interface ReactApi {  createElement: H;
  useState: <S>(initial: S | (() => S)) => [S, (value: S | ((prev: S) => S)) => void];
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => void;
  useCallback: <F extends (...args: never[]) => unknown>(callback: F, deps: unknown[]) => F;
  useMemo: <T>(factory: () => T, deps: unknown[]) => T;
  useRef: <T>(initial: T) => { current: T };
}

/** createElement's face: element trees are untyped here, as in the original. */
export type H = (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;

/**
 * One dictionary key, as the `zh` key-set declares it.
 *
 * Named so a call site that must widen beyond compile-time sight (a template
 * family the HOST enumerates, like `llm.level.…` or `llm.src.…`) can say
 * `as DictionaryKey` instead of importing `zh` and spelling the type twice.
 */
export type DictionaryKey = keyof typeof zh;

/**
 * The dictionary lookup face every component receives as `tt`.
 *
 * The key is `DictionaryKey`, NOT `string`: `zh` is the key-set source of
 * truth (see `i18n.ts`), so a misspelled key in a component is a compile error
 * instead of a raw key on screen. `i18n.ts` already types `en` as `typeof zh`
 * for the same reason — this extends that pin from "the two dictionaries agree"
 * to "the call sites ask for keys that exist".
 *
 * Two escapes stay open on purpose, and both are visible at the call site:
 *   - a table whose VALUES are dictionary keys (`GUIDANCE_BY_CODE`,
 *     `REFUSAL_TEXT`) is typed as `Record<string, DictionaryKey>`, so its
 *     lookup needs no cast at all;
 *   - a template family the HOST enumerates (`llm.level.…`, `llm.src.…`) cannot
 *     be listed here, so its call site casts to `DictionaryKey` explicitly —
 *     the cast is the admission that compile-time cannot see it, and
 *     `test/panel.test.mjs` F6 still scans those families at runtime.
 */
export type Tt = (key: DictionaryKey) => string;

let api: ReactApi | null = null;

/** Hand the loader-provided React to the rest of the client. One-shot. */
export function provideClientReact(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throw new Error("client: the loader did not hand over a react module");
  }
  api = value as ReactApi;
}

function reactApi(): ReactApi {
  if (api === null) throw new Error("client: react used before clientFactory ran");
  return api;
}

export const h: H = (type, props, ...children) => reactApi().createElement(type, props, ...children);

export const useState: ReactApi["useState"] = (initial) => reactApi().useState(initial);

export const useEffect: ReactApi["useEffect"] = (effect, deps) => reactApi().useEffect(effect, deps);

export const useCallback: ReactApi["useCallback"] = (callback, deps) => reactApi().useCallback(callback, deps);

export const useMemo: ReactApi["useMemo"] = (factory, deps) => reactApi().useMemo(factory, deps);

export const useRef: ReactApi["useRef"] = (initial) => reactApi().useRef(initial);
