// peer-imports.mjs —— src/** 里「从 peer 包取符号」的地方，两套独立实现扫同一件事。
//
// 为什么不能只用正则：
//
//   正则认不全导入形态。具名导入（`import { a } from "p"`）只是其中一种；默认
//   导入、命名空间导入、动态 `import("p")`、再导出（`export { a } from "p"`）
//   都是合法的取符号姿势，而本仓真的有一处动态 import
//   （src/host/draw-register.ts:158）。正则漏掉一处真导入不是「判错」，是「没判」——
//   绿灯比红灯危险，因为它连提示都没有。
//
//   而且正则会误捕：注释里提到 peer 名字（本仓 13 处）会被当成导入点，
//   于是门禁去核对一个根本不存在的符号。
//
// 为什么是「两套」而不是「一套扫得更狠」：
//
//   单一实现只有一种故障模式：它坏了，门禁跟着一起坏，然后一片绿。
//   这里有两条互不依赖的路——
//     1) AST（typescript 编译器 API）：认出导入形态，并算出绑定名上被读到的属性路径；
//     2) token 流（同一套编译器的扫描器，只看词法）：只回答「这个文件里出现了几次
//        从 peer 取值的导入、分别是什么 spec」。
//   两条路必须得出同一个答案；对不上就是门禁自己出了问题，当场判红。
//   两条路都不联网、不装东西。
//
// 依赖：typescript（devDependency，`npm install` 之后才有）。选它的理由不是「现成」，
// 是「同一份语法事实」：`npm run typecheck` 已经用这套解析器判本仓的语法，
// 门禁不该再养一套自己的近似实现。
//
// 判据是硬事实（这个文件里有没有这样的导入语句、绑定了哪些名字），
// 不猜语义：类型导入（`import type` 与内联 `type` 修饰）不算取符号——类型面
// 由 types/dsh-peer-modules.d.ts 的桩负责。

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * spec 归属哪个 peer 包（认子路径：`@scope/peer/sub` 归 `@scope/peer`）。
 * @param {string} spec
 * @param {string[]} peerNames
 * @returns {string | null}
 */
export function ownerOf(spec, peerNames) {
  return peerNames.find((name) => spec === name || spec.startsWith(`${name}/`)) ?? null;
}

/** 剥掉只影响类型/优先级的包装节点。 */
function unwrap(node) {
  let cur = node;
  while (
    cur &&
    (ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur))
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * 属性访问链的根标识符与路径段。
 * `mod?.default?.defineTool` → { root: "mod", parts: ["default", "defineTool"] }。
 * 根不是标识符（动态下标之类）时返回 null——算不出来就不猜。
 * @param {object} node
 * @returns {{ root: string, parts: string[] } | null}
 */
function accessPath(node) {
  const parts = [];
  let cur = node;
  while (ts.isPropertyAccessExpression(cur)) {
    parts.unshift(cur.name.text);
    cur = unwrap(cur.expression);
  }
  if (ts.isElementAccessExpression(cur)) return null; // 动态下标：路径算不出来
  if (!ts.isIdentifier(cur)) return null;
  return { root: cur.text, parts };
}

/**
 * 这个读取是不是某条 `??` 回退链的一环；是的话给出链编号。
 * `a ?? b ?? c` 里 a、b、c 属于同一条链——链上有一条走得通就够了。
 * @param {object} node
 * @param {Map<object, string>} chainIds
 * @returns {string | null}
 */
function fallbackChain(node, chainIds) {
  let cur = node.parent;
  let chain = null;
  while (cur) {
    if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      chain = cur; // `??` 左结合：继续往上走，整条链共用一个编号
    }
    cur = cur.parent;
  }
  if (!chain) return null;
  if (!chainIds.has(chain)) chainIds.set(chain, `chain${chainIds.size + 1}`);
  return chainIds.get(chain);
}

/**
 * 某个绑定名上被读到的属性路径（多段路径也记）。
 * @param {object} sf - SourceFile
 * @param {string} binding - 绑定名
 * @param {object | null} scope - 只在这个子树里找（null = 整个文件）
 * @param {Map<object, string>} chainIds
 * @returns {Array<{ parts: string[], chain: string | null }>}
 */
function usageReads(sf, binding, scope, chainIds) {
  const reads = [];
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const path = accessPath(node);
      if (path && path.root === binding) {
        reads.push({ parts: path.parts, chain: fallbackChain(node, chainIds) });
        return; // 不再往里走：外层已经给出完整路径，子节点会重复计入
      }
    }
    ts.forEachChild(node, visit);
  };
  if (scope) visit(scope);
  else ts.forEachChild(sf, visit);
  return reads;
}

/**
 * 动态 import() 绑定到哪个变量（往上找变量声明）。
 * 找不到就是没绑定（例如 `await import("p")` 直接用）——那就只有「模块能加载」这一条。
 * @param {object} node - CallExpression
 * @returns {string | null}
 */
function dynamicBinding(node) {
  let cur = node.parent;
  while (cur) {
    // 注意：TypeScript 的公开 API 没有 isVariableDeclarator，变量声明用 kind 判。
    if (cur.kind === ts.SyntaxKind.VariableDeclaration && ts.isIdentifier(cur.name)) {
      return cur.name.text;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * 动态 import() 所在的作用域（最近的函数体）；没有就整个文件。
 * @param {object} node
 * @param {object} sf
 * @returns {object}
 */
function dynamicScope(node, sf) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return sf;
}

/**
 * 扫描一段源码里从 peer 包取符号的地方（AST 实现，主判据）。
 *
 * 一个 import 声明算一个 site：默认导入与具名导入写在同一句里
 * （`import def, { a } from "p"`）也只算一个——符号合成一张表。
 *
 * @param {string} text - 源码
 * @param {{ file?: string, peerNames?: string[] }} options
 * @returns {Array<{ file: string, spec: string, owner: string, kind: string, symbols: string[], binding: string | null, reads: Array<{ parts: string[], chain: string | null }> }>}
 */
export function scanImportsInText(text, options = {}) {
  const file = options.file ?? "<memory>";
  const peerNames = options.peerNames ?? [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const chainIds = new Map();
  const sites = [];

  const site = (spec, kind, symbols, binding, reads) => ({
    file,
    spec,
    owner: ownerOf(spec, peerNames),
    kind,
    symbols,
    binding,
    reads,
  });

  for (const stmt of sf.statements) {
    // --- import 声明 ---
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text;
      if (!ownerOf(spec, peerNames)) continue;
      const clause = stmt.importClause;
      if (clause?.isTypeOnly) continue; // 整句类型导入：类型面由 .d.ts 桩负责
      if (!clause) {
        sites.push(site(spec, "side-effect", [], null, []));
        continue;
      }
      const symbols = [];
      let binding = null;
      let kind = null;
      if (clause.name) {
        symbols.push("default");
        binding = clause.name.text;
        kind = "default";
      }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        kind = "namespace";
        binding = bindings.name.text;
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue; // 内联 `type` 修饰：类型面不归这里管
          symbols.push(element.propertyName?.text ?? element.name.text);
        }
        if (!kind) kind = "named";
      }
      if (!symbols.length && kind !== "namespace") continue; // 全是类型导入：不算取符号
      const reads = kind === "namespace" ? usageReads(sf, binding, null, chainIds) : [];
      sites.push(site(spec, kind, symbols, binding, reads));
      continue;
    }

    // --- 再导出：export { a } from "p" / export * from "p" ---
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text;
      if (!ownerOf(spec, peerNames)) continue;
      if (stmt.isTypeOnly) continue;
      const clause = stmt.exportClause;
      if (!clause) {
        // `export * from "p"`：再导出对方的全部具名导出——符号是取了的，
        // 只是取不到具体名字（对方加了什么符号我们这侧就多出什么）。
        // 契约是「模块能加载」，不是「某个具名导出在不在」。
        sites.push(site(spec, "star", [], null, []));
        continue;
      }
      if (ts.isNamespaceExport(clause)) {
        sites.push(site(spec, "namespace", [], clause.name.text, usageReads(sf, clause.name.text, null, chainIds)));
        continue;
      }
      const symbols = [];
      for (const element of clause.elements) {
        if (element.isTypeOnly) continue;
        symbols.push(element.propertyName?.text ?? element.name.text);
      }
      if (!symbols.length) continue;
      sites.push(site(spec, "named", symbols, null, []));
    }
  }

  const visitDynamic = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const spec = node.arguments[0].text;
      if (ownerOf(spec, peerNames)) {
        const binding = dynamicBinding(node);
        sites.push(
          site(
            spec,
            "dynamic",
            [],
            binding,
            binding ? usageReads(sf, binding, dynamicScope(node, sf), chainIds) : [],
          ),
        );
      }
    }
    ts.forEachChild(node, visitDynamic);
  };
  ts.forEachChild(sf, visitDynamic);

  return sites;
}

/**
 * 另一条独立的路：只扫 token 流（词法），回答「这个文件里有几次从 peer 取值的导入」。
 * 不看语法结构，所以认不出绑定名与属性路径——它只做交叉核对。
 *
 * 这条路认不出的东西（都算「本路没看见」，AST 那路必须看见）：
 *   - 注释里的 peer 名字（本路跳过 trivia，天然看不见）；
 *   - 字符串里的 import 语句（`const s = "import { a } from 'p'"`）。
 *
 * @param {string} text - 源码
 * @param {{ peerNames?: string[] }} options
 * @returns {Array<{ spec: string, kind: "static" | "dynamic" }>}
 */
export function scanImportsByTokens(text, options = {}) {
  const peerNames = options.peerNames ?? [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true, // skipTrivia：注释与空白不参与，注释里的 peer 名字自然被排除
    ts.LanguageVariant.Standard,
    text,
  );
  const tokens = [];
  // 带 `${}` 的模板字面量必须按词法规则续扫：`scan()` 只给出 TemplateHead，后续片段要
  // `reScanTemplateToken()` 才拿得到。不续扫的话，成对的 backtick 会互相错位——夹在中间
  // 的 `import("peer")` 会被吞进一个假的「模板 token」，于是另一条路（AST）看见了、这条路
  // 看不见，门禁红却指向错的地方（src/host/draw-register.ts 就这么被漏过过一次）。
  const templateDepths = []; // 每个未闭合模板里 `${ … }` 的花括号深度
  for (;;) {
    let kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
    if (kind === ts.SyntaxKind.TemplateHead) {
      templateDepths.push(0);
    } else if (kind === ts.SyntaxKind.OpenBraceToken && templateDepths.length > 0) {
      templateDepths[templateDepths.length - 1] += 1;
    } else if (kind === ts.SyntaxKind.CloseBraceToken && templateDepths.length > 0) {
      const top = templateDepths.length - 1;
      if (templateDepths[top] > 0) {
        templateDepths[top] -= 1;
      } else {
        // 这个 `}` 结束的是 `${ … }`，不是普通代码块：从它开始重扫模板片段。
        kind = scanner.reScanTemplateToken(false);
        if (kind === ts.SyntaxKind.TemplateTail) templateDepths.pop();
        tokens.push({ kind, text: scanner.getTokenText() });
        continue;
      }
    }
    tokens.push({ kind, text: scanner.getTokenText() });
  }

  const found = [];
  const unquote = (raw) => raw.replace(/^['"]|['"]$/g, "");

  /** 具名导入的花括号里，每个元素是不是都以 `type` 修饰。 */
  const namedElements = (open) => {
    const elements = [];
    let depth = 0;
    let current = null;
    for (let k = open; k < tokens.length; k++) {
      const { kind } = tokens[k];
      if (kind === ts.SyntaxKind.OpenBraceToken) {
        depth++;
        if (depth === 1) {
          current = [];
          continue;
        }
      }
      if (kind === ts.SyntaxKind.CloseBraceToken) {
        depth--;
        if (depth === 0) {
          if (current) elements.push(current);
          break;
        }
      }
      if (depth !== 1) continue;
      if (kind === ts.SyntaxKind.CommaToken) {
        elements.push(current ?? []);
        current = [];
        continue;
      }
      if (!current) current = [];
      current.push(kind);
    }
    return elements;
  };

  /** 从 from 关键字往后找那个字符串字面量（找不到就 null）。 */
  const literalAfterFrom = (from) => {
    for (let k = from + 1; k < tokens.length; k++) {
      if (tokens[k].kind === ts.SyntaxKind.SemicolonToken) return null;
      if (tokens[k].kind === ts.SyntaxKind.StringLiteral) return tokens[k];
    }
    return null;
  };

  /** 找 import/export 子句里的 from；遇到句子边界就停（不越界到下一句）。 */
  const findFrom = (start, stopAtEquals) => {
    let depth = 0;
    for (let k = start; k < tokens.length; k++) {
      const { kind } = tokens[k];
      if (kind === ts.SyntaxKind.OpenBraceToken) depth++;
      else if (kind === ts.SyntaxKind.CloseBraceToken) depth--;
      else if (kind === ts.SyntaxKind.SemicolonToken && depth <= 0) return -1;
      else if (kind === ts.SyntaxKind.EqualsToken && stopAtEquals && depth <= 0) return -1;
      else if (kind === ts.SyntaxKind.FromKeyword && depth <= 0) return k;
    }
    return -1;
  };

  const record = (spec, kind) => {
    if (ownerOf(spec, peerNames)) found.push({ spec, kind });
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const isImport = token.kind === ts.SyntaxKind.ImportKeyword;
    const isExport = token.kind === ts.SyntaxKind.ExportKeyword;
    if (!isImport && !isExport) continue;
    const next = tokens[i + 1];
    if (!next) continue;

    if (isImport && next.kind === ts.SyntaxKind.OpenParenToken) {
      // import("spec")
      const literal = tokens.slice(i + 2).find((t) => t.kind === ts.SyntaxKind.StringLiteral);
      if (literal) record(unquote(literal.text), "dynamic");
      continue;
    }

    if (isImport && next.kind === ts.SyntaxKind.StringLiteral) {
      // 副作用导入：import "spec"
      record(unquote(next.text), "static");
      continue;
    }

    if (isExport && next.kind !== ts.SyntaxKind.OpenBraceToken && next.kind !== ts.SyntaxKind.AsteriskToken) {
      continue; // export const / export default / export function：不是从别处取符号
    }

    if (isImport && next.kind === ts.SyntaxKind.TypeKeyword) {
      const after = tokens[i + 2];
      if (after && after.kind === ts.SyntaxKind.FromKeyword) {
        // `import type from "p"`：名叫 type 的默认导入（是取符号）
      } else {
        // `import type { X } from "p"` / `import type X from "p"`：类型导入，跳过整句
        continue;
      }
    }

    if (next.kind === ts.SyntaxKind.OpenBraceToken) {
      const elements = namedElements(i + 1);
      if (elements.length > 0 && elements.every((kinds) => kinds[0] === ts.SyntaxKind.TypeKeyword)) {
        // `import { type X } from "p"` / `export { type X } from "p"`：全是类型，跳过整句
        continue;
      }
    }

    const from = findFrom(i + 1, isImport);
    if (from < 0) continue;
    const literal = literalAfterFrom(from);
    if (!literal) continue;
    record(unquote(literal.text), "static");
  }
  return found;
}

/**
 * 属性路径在模块对象上走得通吗（`["default","defineTool"]` → mod.default.defineTool）。
 * @param {object} mod - 模块命名空间对象
 * @param {string[]} parts
 * @returns {boolean}
 */
export function pathResolves(mod, parts) {
  let cur = mod;
  for (const part of parts) {
    if (cur === null || cur === undefined) return false;
    if (typeof cur !== "object" && typeof cur !== "function") return false;
    if (!(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}

/**
 * 把一个 site 的读取分成「必须各自走通」与「同链任一走通即可」两组。
 * @param {Array<{ parts: string[], chain: string | null }>} reads
 * @returns {Array<{ chain: string | null, paths: string[][] }>}
 */
export function readGroups(reads) {
  const groups = [];
  const byChain = new Map();
  for (const read of reads) {
    if (read.chain === null) {
      groups.push({ chain: null, paths: [read.parts] });
      continue;
    }
    if (!byChain.has(read.chain)) {
      const group = { chain: read.chain, paths: [] };
      byChain.set(read.chain, group);
      groups.push(group);
    }
    byChain.get(read.chain).paths.push(read.parts);
  }
  return groups;
}

/**
 * 这个 site 在宿主那份模块上缺什么（空数组 = 齐了）。
 * @param {object} mod - 模块命名空间对象
 * @param {{ symbols: string[], reads: Array<{ parts: string[], chain: string | null }> }} site
 * @returns {string[]}
 */
export function missingOnHost(mod, site) {
  const missing = [];
  for (const symbol of site.symbols) {
    if (!(symbol in mod)) missing.push(`导出 ${symbol}`);
  }
  for (const group of readGroups(site.reads ?? [])) {
    if (group.paths.some((parts) => pathResolves(mod, parts))) continue;
    missing.push(`属性 ${group.paths.map((parts) => parts.join(".")).join(" 或 ")}`);
  }
  return missing;
}

/**
 * 扫 src/** 下所有 .ts 文件。
 * @param {{ root: string, peerNames: string[] }} options
 * @returns {{ ast: ReturnType<typeof scanImportsInText>, tokens: Array<{ file: string, spec: string, kind: string }> }}
 */
export function scanPeerImports({ root, peerNames }) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  };
  walk(join(root, "src"));
  const ast = [];
  const tokens = [];
  for (const file of files.sort()) {
    const rel = relative(root, file).replaceAll("\\", "/");
    const text = readFileSync(file, "utf8");
    ast.push(...scanImportsInText(text, { file: rel, peerNames }));
    for (const hit of scanImportsByTokens(text, { peerNames })) {
      tokens.push({ file: rel, spec: hit.spec, kind: hit.kind });
    }
  }
  return { ast, tokens };
}
