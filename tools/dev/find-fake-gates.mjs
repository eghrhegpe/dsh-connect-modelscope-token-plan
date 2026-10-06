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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
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
  // （assertText 已不再需要——A 类检测改为扫描全文件而非仅断言文本。）

  // A. 变量声明后从未在**任何地方**被使用
  //
  // 原实现只检查变量是否出现在 assertText（所有 assert.* 的参数文本）里，
  // 导致 makeReact / walk / makeReq 等工具函数被误报为「未使用」——它们被
  // 测试的其他代码调用，但不在 assert.* 的参数里直接出现。修复：检查变量
  // 是否在声明行之外的任何地方出现（包括函数调用、赋值、return 等）。
  const declRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  const declared = [];
  while ((m = declRe.exec(text))) {
    const name = m[1];
    if (["assert", "console"].includes(name)) continue;
    declared.push({ name, line: text.slice(0, m.index).split("\n").length });
  }
  for (const d of declared) {
    const withoutDeclLine = lines.slice(0, d.line - 1).concat(lines.slice(d.line)).join("\n");
    if (!new RegExp(`\\b${d.name}\\b`).test(withoutDeclLine)) {
      findings.push(`  A  L${d.line}  变量 \`${d.name}\` 声明后从未在任何地方使用`);
    }
  }

  // B/C. 断言里出现纯字面量（不含任何被测标识符）
  //
  // 原实现只检查第一个参数（逗号分割后的 parts[0]），导致
  // `assert.equal(name, pkg.name)` 这类有效断言被误报——因为 `parts[0]`
  // 只有 `name`，而 `pkg.name` 在 `parts[1]` 里。修复：检查整个 body。
  for (const a of asserts) {
    const b = a.body.trim();
    // 整个 body 里没有任何标识符 → 纯字面量比较（恒真或测副本）
    if (!/[A-Za-z_$][\w$]*/.test(b)) {
      findings.push(`  C  L${a.line}  断言表达式无被测标识符（恒真）: assert.${a.kind}(${b.slice(0, 60)})`);
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
