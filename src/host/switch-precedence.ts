/**
 * 所有 opt-in 开关共用的唯一裁决：「面板保存值 vs 配置默认值」。
 *
 * 规则只有一条：**面板保存值赢，否则配置默认值说了算**。来源标签（`panel` /
 * `config`）随答案一起返回，面板才能说出是谁在管。规则收在一处，是为了让开关
 * 再也无法各自发明一套优先级方言；`test/switch-precedence.test.mjs` 钉死这个
 * 方言，照抄形状的新调用方会被它标成异类。
 *
 * 不服务「纯面板拥有、无配置默认值」的开关——那种没有可裁决的配置默认值，
 * 调用方直接读即可。peer-free，纯函数。
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
