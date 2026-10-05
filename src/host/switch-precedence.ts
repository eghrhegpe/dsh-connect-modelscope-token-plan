/**
 * The single adjudicator for "panel-saved value vs config default" across
 * every opt-in switch.
 *
 * Historically the rule was hand-copied at three call sites (the provider
 * route, the models route, the draw route) in two look-alike dialects:
 *
 *   - the boolean switch: `(panel ?? config) === true` plus
 *     `panel === null ? "config" : "panel"`;
 *   - the model preference: `panel ?? config` plus the same source probe.
 *
 * A fourth dialect existed where no config default exists at all (the Raccoon
 * switch — a profile without a saved value falls to `off` with no fallback),
 * which is exactly the shape this module does NOT serve: that one has no
 * config default to adjudicate against, so it is the caller's plain read.
 *
 * This module is peer-free and deliberately tiny: the whole point is that a
 * switch can never again invent its own precedence dialect, and the source
 * label (`panel` / `config`) always rides with the answer so the panel can
 * say which side is in charge. `test/switch-precedence.test.mjs` pins the
 * dialect so a new caller copying the shape is the odd one out.
 *
 * 注：本模块自带的 `test/switch-precedence.test.mjs` 钉死纯函数行为；部分旧注释里
 * 提到的 `test/peer-contract.test.mjs`（钉死真 peer 的 classifyPiAiError /
 * resolveRetryPolicy 协议）依赖未 vendored 进本仓库的运行时 peer，不在 `npm test`
 * 离线门禁内。
 *
 * @module dsh-connect-modelscope-token-plan/switch-precedence
 */

/**
 * Resolve the effective boolean switch: a panel-saved value always wins,
 * otherwise the config default rules.
 * @param {boolean|null} panel - the panel-saved value (`null` = never saved).
 * @param {boolean} config - the patch-declared default.
 * @returns {boolean} the effective switch.
 */
export function resolveSwitchEnabled(panel: boolean | null, config: boolean): boolean {
  return (panel ?? config) === true;
}

/**
 * Resolve the effective string preference (e.g. a draw-model id): a
 * panel-saved value wins, otherwise the config default rules.
 * @param {string|null} panel - the panel-saved value (`null` = never saved).
 * @param {string|undefined} config - the patch-declared default.
 * @returns {string|undefined} the effective preference.
 */
export function resolveSwitchValue(panel: string | null, config: string | undefined): string | undefined {
  return panel ?? config;
}

/**
 * Where the effective value came from — the panel when it saved one, the
 * config otherwise. Rides with every resolved answer so the panel can name
 * the side in charge.
 * @param {boolean|string|null} panel - the panel-saved value.
 * @returns {"panel"|"config"}
 */
export function switchSource(panel: boolean | string | null): "panel" | "config" {
  return panel === null ? "config" : "panel";
}
