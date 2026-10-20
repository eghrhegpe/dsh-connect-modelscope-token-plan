/**
 * submission-entry.mjs — 投稿副本 YAML 的共享解析器。
 *
 * 两个门禁读同一份字节：离线的 `docs.test.mjs`（投稿副本块，每次 push 都跑）与
 * 联网的 `test/submission-drift.mjs`（投稿 vs 市场线上条目）。它们必须对同一
 * 个文件给出同一个读法——两处各写一份、只靠一句注释要求「Keep identical」治
 * 不住漂移（这正是 tools/dev/cross-repo-drift.mjs 头注治过的病），共用一份实
 * 现才能让「相同」成为结构事实而不是纪律。
 *
 * 逐行扫描，不用正则：模板字面量里的 `\s` 会被当成转义吃掉，写出来的正则静默
 * 变成 `^url:s*(S+)s*$`，永远不匹配——一个只会通过的门禁。
 *
 * 单引号标量里引号靠重复转义（`model''s` 就是 `model's`），不反转义会把每个
 * 撇号都读成漂移。
 *
 * 行尾注释：YAML 允许 `#` 起注释，但 `#` 前面必须是空白。旧实现用
 * `endsWith("'")` 判定标量，于是上游写成 `en: '…' # note` 时该行被判成
 * 「不是解析器认的标量」（undefined）——离线门禁红得指向一个假病因，联网门禁
 * 则把「上游带注释 vs 草稿不带」判成一次假 DRIFT。现在两侧都在闭引号之后只允
 * 许「空白 + #」收尾，并在比对前剥掉行尾注释。`'text'#note`（无空白）仍是
 * undefined：那不是 YAML 认的标量行，宁红不猜。
 *
 * @module test/helpers/submission-entry
 */

/** `#` 前必须是空白（或行首）才算注释起点——URL 片段 `#readme` 不受影响。 */
function stripTrailingComment(raw) {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== "#") continue;
    if (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t") return raw.slice(0, i).trimEnd();
  }
  return raw;
}

/** 闭引号之后的尾巴：空、纯空白，或「空白 + # 注释」。其它一律不是合法收尾。 */
function tailAfterClosingQuote(rest) {
  if (rest === "") return true;
  const stripped = rest.replace(/^[ \t]+/, "");
  if (stripped === rest) return false; // 没有前导空白：# 直接贴在引号后面，YAML 不接受
  return stripped === "" || stripped.startsWith("#");
}

/** 单引号标量：找配对闭引号（跳过 `''` 转义），闭引号后只允许注释/空白收尾。 */
function quotedScalar(line, key) {
  const prefix = `${key}: '`;
  if (!line.startsWith(prefix)) return undefined;
  const body = line.slice(prefix.length);
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "'") {
      i += 1;
      continue;
    }
    if (body[i + 1] === "'") {
      i += 2; // '' 是转义的引号，不是收尾
      continue;
    }
    if (!tailAfterClosingQuote(body.slice(i + 1))) return undefined;
    return body.slice(0, i).replaceAll("''", "'");
  }
  return undefined; // 没找到闭引号
}

/** 无引号 field：剥掉「空白 + #」起的行尾注释，其余原样（URL 片段 # 不受影响）。 */
function plainField(line, key) {
  const prefix = `${key}: `;
  if (!line.startsWith(prefix)) return undefined;
  return stripTrailingComment(line.slice(prefix.length).trim()).trim();
}

/** 解析一份投稿 YAML，取出这个门禁比对的五个字段。 */
export function parseEntry(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim());
  return {
    url: plainField(lines.find((c) => c.startsWith("url: ")) ?? "", "url"),
    name: plainField(lines.find((c) => c.startsWith("name: ")) ?? "", "name"),
    category: plainField(lines.find((c) => c.startsWith("category: ")) ?? "", "category"),
    "description.en": quotedScalar(lines.find((c) => c.startsWith("en: '")) ?? "", "en"),
    "description.zh": quotedScalar(lines.find((c) => c.startsWith("zh: '")) ?? "", "zh"),
  };
}
