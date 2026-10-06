/** Time and number formatters（与姊妹插件 format.ts 受控复制，按需裁剪）。 */

/**
 * Host 声明的 cadence（秒）转毫秒；无可用数字时回退。Host 在源头已 clamp，
 * 面板不做第二次 opinion；亚秒值向上取整到 1s（setInterval 的 0 = 尽快）。
 */
export function statedCadenceMs(seconds: unknown, fallbackMs: number): number {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.max(1, Math.floor(seconds)) * 1000;
}

/** `MM-DD HH:mm`（事件时间戳用）。 */
export function clockLong(epoch: unknown): string {
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
  const date = new Date(epoch * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ISO 字符串 → `MM-DD HH:mm`；非法输入返回 "—"。 */
export function isoTime(iso: unknown): string {
  if (typeof iso !== "string" || iso === "") return "—";
  const epoch = Date.parse(iso);
  return Number.isNaN(epoch) ? "—" : clockLong(epoch / 1000);
}

/** 数字文本：≥10000 整数千分位，否则最多两位小数。 */
export function count(value: unknown): string {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (number >= 10000) return Math.round(number).toLocaleString();
  return String(Math.round(number * 100) / 100);
}

/** 填 `{key}` 模板：vars 的每个键对应模板里的同名占位符。 */
export function format(template: string, vars?: Record<string, unknown> | null): string {
  let text = template;
  for (const [key, value] of Object.entries(vars || {})) {
    text = text.split(`{${key}}`).join(String(value));
  }
  return text;
}

/** catch 到的值 → 面板唯一错误行；绝不 `[object Object]`。 */
export function errorText(why: unknown): string {
  if (why instanceof Error) return why.message;
  if (typeof why === "string") return why;
  if (why === null || why === undefined) return String(why);
  try {
    return JSON.stringify(why) ?? String(why);
  } catch {
    return String(why);
  }
}
