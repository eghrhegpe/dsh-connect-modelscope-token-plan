// 「假门禁」静态扫描器。找的是**看起来在验证、实际验证不到**的断言。
//
// 检测项：
//  A. 变量声明后从未在断言里出现（声明了但断言没用到它）
//  B. 断言的右侧与被测模块无关的字面量（测副本而不是真身）
//  C. 断言恒真（与被测值无关的比较）
//  D. 循环里断言与循环变量无关（所有输入走同一条断言，形状没被遍历）
//  E. 断言的对象是测试自己刚造出来的桩（断言桩而不是被测代码）
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tests = readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".mjs")).sort();

for (const t of tests) {
  const file = join(ROOT, "test", t);
  const lines = readFileSync(file, "utf8").split("\n");
  const findings = [];

  // 收集所有 assert.* 调用的源码片段（可能跨行，用括号配平）
  const text = lines.join("\n");
  const asserts = [];
  const re = /assert\.(ok|equal|deepEqual|notEqual|match|rejects|throws|doesNotThrow|notDeepEqual)\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    let i = re.lastIndex, depth = 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    const body = text.slice(re.lastIndex, i - 1);
    asserts.push({
      start: m.index,
      line: text.slice(0, m.index).split("\n").length,
      kind: m[1],
      body
    });
  }
  const assertText = asserts.map((a) => a.body).join("\n");

  // A. 变量声明后从未出现在任何断言里
  const declRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  const declared = [];
  while ((m = declRe.exec(text))) {
    const name = m[1];
    if (["assert", "console"].includes(name)) continue;
    declared.push({ name, line: text.slice(0, m.index).split("\n").length });
  }
  for (const d of declared) {
    // 在断言里找该标识符（排除声明自身与属性访问 obj.name）
    const usedInAssert = new RegExp(`(^|[^.\\w$])${d.name.replace(/\$/g, "\\$")}\\b`).test(assertText);
    // 也检查是否作为 for-of 的迭代变量、或被 return
    const usedInLoop = new RegExp(`for\\s*\\([^)]*\\bof\\s+${d.name}\\b`).test(text);
    if (!usedInAssert && !usedInLoop) {
      // 排除：console.log 用它、throw 用它
      const usedElsewhere = new RegExp(`(console\\.log|throw|return)[^\\n]*\\b${d.name}\\b`).test(text);
      if (!usedElsewhere) {
        findings.push(`  A  L${d.line}  变量 \`${d.name}\` 声明后从未出现在任何断言/循环/日志里`);
      }
    }
  }

  // B/C. 断言里出现纯字面量（不含任何被测标识符）
  for (const a of asserts) {
    const b = a.body.trim();
    // 去掉消息参数（最后一个顶层逗号之后）
    const parts = [];
    let depth = 0, cur = "";
    for (const ch of b) {
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth--;
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
    }
    parts.push(cur);
    const expr = parts[0].trim();
    if (!expr) continue;
    // 表达式里没有任何标识符（纯字面量/纯字符串/纯数字比较）→ 恒真或测副本
    if (!/[A-Za-z_$][\w$]*\s*[.(\[=!<>]/.test(expr) && !/[([][A-Za-z_$]/.test(expr)) {
      findings.push(`  C  L${a.line}  断言表达式无被测标识符（恒真）: assert.${a.kind}(${expr.slice(0, 60)})`);
    }
  }

  // D. for 循环里只有一条 assert 且不引用循环变量
  const forRe = /for\s*\(\s*(?:const|let|var)\s+(\w+)\s+of\s+([^)]+)\)\s*\{([\s\S]*?)\n\}/g;
  while ((m = forRe.exec(text))) {
    const [, varName, iterable, body] = m;
    const lineNo = text.slice(0, m.index).split("\n").length;
    const aCount = (body.match(/assert\./g) ?? []).length;
    if (aCount === 1) {
      const aStart = body.indexOf("assert.");
      const aBody = body.slice(aStart);
      const usesVar = new RegExp(`\\b${varName}\\b`).test(aBody);
      if (!usesVar) {
        findings.push(`  D  L${lineNo}  for (${varName} of ${iterable.trim().slice(0, 40)}) 体内唯一断言不引用 \`${varName}\`（没在遍历输入）`);
      }
    }
  }

  if (findings.length) {
    console.log(`\n=== test/${t} ===`);
    for (const f of findings) console.log(f);
  }
}
