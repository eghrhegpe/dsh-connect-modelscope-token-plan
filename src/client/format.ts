/**
 * Time and number formatters（与 sensenova 的 format.ts 同源、按需裁剪——去注释后
 * 代码行重叠 73%，与 agnes 那份已分家（45%）。2026-10-16 实测，复核
 * `node tools/dev/cross-repo-drift.mjs`）。
 */

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

/**
 * 大数字的紧凑文本：`< 1000` 原样，`< 1e6` 用 `k`，`≥ 1e6` 用 `m`（各留 1~2 位小数，
 * 去尾零）。**只给 token 这类会自然到百万级的读数用**——调用次数一天几十上百，千分位
 * 逗号反而更好读，那条路径继续走 `count()`。
 *
 * 单位用小写 k/m：视觉上与 SI 前缀一致，也避开「兆」的歧义（`M` 在中文语境里常被读成
 * 万亿）。负值与 NaN 分别返回 `-1.2k` 与 `NaN`——不做掩饰，异常值该在面板上现形。
 *
 * **与 `const.ts` 的 `formatWindow()` 刻意不同，不是漏统一**：那个印的是**上下文窗口
 * 规格**（`128K` / `256K` / `1M`，按上游与市场的叫法、K=1024 口径），回答「大概能放
 * 多少上下文」；这里印的是**实测用量读数**（`1.2k` / `3.4m`，十进制、小写），回答
 * 「实际用了多少」。同一数字在两处印法不同，是因为它们量纲不同（规格 vs 读数）。
 */
export function compactCount(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  const trim = (number: number) => String(Number(number.toFixed(number >= 100 ? 0 : number >= 10 ? 1 : 2)));
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs < 1000) return `${sign}${trim(abs)}`;
  // 分档判定用**进位后**的量级：999_999/1e3 = 999.999，在 k 档 trim 成 "1000"
  // 会写出非规范的 "1000k"——同一个数进 m 档才是 "1m"。整数 token 读数里
  // 999_999 可达（2026-10-18 评审实测的旧行为，旧实现按原始量级分档、四档各写
  // 一条 if），所以跨档进位在这里判掉，不留给显示层各自原谅。
  const tiers: Array<[number, string]> = [[1e3, "k"], [1e6, "m"], [1e9, "b"]];
  // entries() 而非下标：`noUncheckedIndexedAccess` 下 `tiers[i]` 带 undefined，
  // 解构当场 TS2488。迭代器吐的元组没有这问题。
  for (const [i, [divisor, unit]] of tiers.entries()) {
    const shown = trim(abs / divisor);
    if (i === tiers.length - 1 || Number(shown) < 1000) return `${sign}${shown}${unit}`;
  }
  return `${sign}${trim(abs)}b`; // 不可达（最高档已 return）；给 tsc 一句可返回的收尾
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
