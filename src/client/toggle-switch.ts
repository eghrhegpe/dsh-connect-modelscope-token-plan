/**
 * 共用的 on/off 控件：滑杆开关 + 短标签 + 承载说明的 title 提示。
 *
 * 为什么不做原生 checkbox：provider 开关的标签是「把魔搭模型接入 DSH 模型
 * 选择器」一整句，塞进复选框后面读起来像一行带方框的散文，而不是开关；
 * 说明文字应该待在 tooltip 里做它该做的事。这段实现照抄姊妹插件的
 * `toggle-switch.ts`，只把品牌色换成魔搭的 `#7B3FF2`。
 *
 * 隐藏的 `<input type="checkbox">` 不是装饰，它是承重的三处：
 *   - 真正的控件：键盘焦点、空格翻转、浏览器自己的 checked 语义都从它来；
 *   - 隐式 label（input 嵌在 `<label>` 里）就是可访问名，所以 input 不写
 *     aria-label——这也是渲染测试区分开关与 roster 复选框的契约；
 *   - 渲染套件用 `props.type === "checkbox"` 匹配，元素必须仍是 checkbox。
 *
 * 轨道/滑块用绝对定位的 span 盖在 input 上（pointer-events: none，点击仍落
 * 在下面的 input）。本插件不注入样式表，所以开关不能用 CSS `::before`——内联
 * 样式是唯一可用的表面，按状态给条件样式就是诚实的等价物。
 * @module dsh-connect-modelscope-token-plan/client/toggle-switch
 */

import { h } from "./runtime.ts";

/** 轨道 30×17，12px 滑块走 13px——姊妹插件/Qoder 的形状。 */
const TRACK_W = 30;
const TRACK_H = 17;
const THUMB = 12;
const TRAVEL = 13;

/** {@link ToggleSwitch} 的 props。 */
export interface ToggleSwitchProps {
  /** 开关是否开着。 */
  checked: boolean;
  /** 翻转它。input 自己的 change 调这个；写盘归调用方。 */
  onChange: () => void;
  /** 开关旁的短标签——几个词，不是一整句。 */
  label: string;
  /** busy 时替换 `label` 的忙碌文案（如「切换中…」）。 */
  busyLabel?: string;
  /** 禁用控件并变暗，光标读成等待。 */
  busy?: boolean;
  /** 承载说明的 tooltip（标签已装不下的那句）。 */
  title?: string;
}

/**
 * 滑杆开关 + 短标签 + tooltip。
 * @param props - 见 {@link ToggleSwitchProps}。
 * @returns 包着真 checkbox input 的 `<label>` 树。
 */
export function ToggleSwitch({ checked, onChange, label, busyLabel, busy = false, title }: ToggleSwitchProps): unknown {
  const on = checked === true;
  const text = busy && busyLabel !== undefined ? busyLabel : label;
  return h(
    "label",
    {
      style: {
        display: "inline-flex", alignItems: "center", gap: 8, position: "relative",
        cursor: busy ? "wait" : "pointer", opacity: busy ? 0.55 : 1, verticalAlign: "middle"
      },
      ...(title !== undefined && title !== "" ? { title } : {})
    },
    h(
      "span",
      { style: { position: "relative", display: "inline-block", width: TRACK_W, height: TRACK_H, flex: "none" } },
      // 真控件，隐形但活着：铺满轨道，点击/键盘焦点都落在它上；画的轨道
      // pointer-events: none 盖在上面。不写 aria-label——外层 label 给它命名。
      h("input", {
        type: "checkbox",
        checked: on,
        disabled: busy,
        onChange,
        style: { position: "absolute", inset: 0, width: TRACK_W, height: TRACK_H, margin: 0, opacity: 0, cursor: busy ? "wait" : "pointer" }
      }),
      h(
        "span",
        {
          "aria-hidden": "true",
          style: {
            position: "absolute", inset: 0, borderRadius: 999, pointerEvents: "none",
            border: `1px solid ${on ? "var(--modelscope-brand, #7B3FF2)" : "var(--dsw-alias-border-l2, #36373b)"}`,
            background: on ? "var(--modelscope-brand, #7B3FF2)" : "var(--dsw-alias-bg-layer-2, #2a2b31)",
            transition: "background .15s, border-color .15s"
          }
        },
        h("span", {
          style: {
            position: "absolute", top: 1.5, left: 1.5, width: THUMB, height: THUMB, borderRadius: "50%",
            background: on ? "#fff" : "var(--dsw-alias-label-tertiary, #999)",
            transform: on ? `translateX(${TRAVEL}px)` : "translateX(0)",
            transition: "transform .15s, background .15s"
          }
        })
      )
    ),
    h("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, text)
  );
}