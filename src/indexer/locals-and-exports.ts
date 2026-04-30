import { isJsSyntaxTree, parseWithJsLanguage, type JsSyntaxTree } from "../jsFallback.js";
import { logWithLevel, type LogLevel } from "../logging.js";
import { isGraphOnlyLanguage } from "../documentLinks.js";
import { capturesByName, capturesNamed, rangeFromNativeCapture } from "../native/queryResults.js";
import { ProjectedSyntaxTree } from "../native/projectedTree.js";
import {
  executeJsQueryAsNativeMatches,
  getNativeSyntaxTreeExecution,
  isNativeBindingLoadedForLanguage,
  type NativeCapture,
  type NativeQueryResults,
  type NativeRuntimeMode,
} from "../native/treeSitterNative.js";
import { maskJsLikeCommentsAndStrings, sliceText, toRange, unquote } from "../util.js";
import { buildScopeIndexFromSource } from "./scope.js";
import { QUERY_DRIVEN_LOCALS_LANGUAGES } from "./shared.js";
import { SymbolKind } from "./types.js";
import type { LanguageSupport } from "../languages.js";
import type { JsLanguage, SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { ExportEntry, ImportBinding, ModuleIndex, SymbolDef } from "./types.js";
import type { Range } from "../types.js";
function appendJsLikeRegexFallbackExports(
  file: string,
  source: string,
  locals: SymbolDef[],
  exports: ExportEntry[],
): void {
  const maskedSource = maskJsLikeCommentsAndStrings(source);
  const reDecl = /\bexport\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  const reDefault = /\bexport\s+default\s+([A-Za-z_$][\w$]*)/g;
  const reExportAssign = /\bexport\s*=\s*([A-Za-z_$][\w$]*)/g;
  const reReexport = /\bexport\s*\{\s*([^}]+)\}\s*from\s*("|')([^"']*)\2/g;
  const reReexportNs = /\bexport\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*("|')([^"']*)\2/g;
  const reStar = /\bexport\s*\*\s*from\s*("|')([^"']*)\1/g;
  const reCjsFn = /(?:^|[;\n\r])\s*(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=\s*(function\b|\([^)]*\)\s*=>)/g;
  const reCjsObjFn = /([A-Za-z_$][\w$]*)\s*:\s*(function\b|\([^)]*\)\s*=>)/g;
  const moduleExportsObject = /module\.exports\s*=\s*\{([^}]*)\}/s;
  let match: RegExpExecArray | null;

  while ((match = reDecl.exec(maskedSource))) {
    const name = match[1]!;
    if (!exports.some((entry) => entry.type === "local" && entry.exportedAs === name)) {
      const local = locals.find((def) => def.localName === name);
      if (local) exports.push({ type: "local", exportedAs: name, target: local });
    }
  }

  while ((match = reDefault.exec(maskedSource))) {
    const name = match[1]!;
    if (!exports.some((entry) => entry.type === "local" && entry.exportedAs === "default")) {
      const local = locals.find((def) => def.localName === name);
      if (local) {
        exports.push({
          type: "local",
          exportedAs: "default",
          target: { ...local, kind: SymbolKind.Default },
        });
      }
    }
  }

  while ((match = reExportAssign.exec(maskedSource))) {
    const name = match[1]!;
    if (!exports.some((entry) => entry.type === "local" && entry.exportedAs === "default")) {
      const local = locals.find((def) => def.localName === name);
      if (local) {
        exports.push({
          type: "local",
          exportedAs: "default",
          target: { ...local, kind: SymbolKind.Default },
        });
      }
    }
  }

  while ((match = reReexport.exec(maskedSource))) {
    const list = match[1]!
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const from = source.slice(match.index, reReexport.lastIndex).match(/from\s*("|')([^"']+)\1/)?.[2];
    if (!from) continue;
    for (const spec of list) {
      const entryMatch = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!entryMatch) continue;
      const srcName = entryMatch[1]!;
      const alias = entryMatch[2] ?? srcName;
      if (
        !exports.some((entry) => entry.type === "reexport" && entry.exportedAs === alias && entry.fromModule === from)
      ) {
        exports.push({
          type: "reexport",
          exportedAs: alias,
          fromModule: from,
          sourceSpecifier: srcName,
        });
      }
    }
  }

  while ((match = reReexportNs.exec(maskedSource))) {
    const alias = match[1]!;
    const from = source.slice(match.index, reReexportNs.lastIndex).match(/from\s*("|')([^"']+)\1/)?.[2];
    if (!from) continue;
    if (
      !exports.some(
        (entry) =>
          (entry.type === "reexport" || entry.type === "namespaceReexport") &&
          entry.exportedAs === alias &&
          entry.fromModule === from,
      )
    ) {
      exports.push({
        type: "namespaceReexport",
        exportedAs: alias,
        fromModule: from,
      });
    }
  }

  while ((match = reStar.exec(maskedSource))) {
    const from = source.slice(match.index, reStar.lastIndex).match(/("|')([^"']+)\1/)?.[2];
    if (!from) continue;
    if (!exports.some((entry) => entry.type === "exportStar" && entry.fromModule === from)) {
      exports.push({
        type: "exportStar",
        fromModule: from,
        sourceSpecifier: from,
      });
    }
  }

  while ((match = reCjsFn.exec(maskedSource))) {
    const exportedAs = match[1]!;
    let local = locals.find((def) => def.localName === exportedAs);
    if (!local) {
      const idx = match.index + match[0].indexOf(exportedAs);
      const pos = { line: 1, column: 1, index: idx };
      local = {
        file,
        localName: exportedAs,
        kind: SymbolKind.Function,
        range: { start: pos, end: pos },
      };
      locals.push(local);
    }
    if (!exports.some((entry) => entry.type === "local" && entry.exportedAs === exportedAs)) {
      exports.push({ type: "local", exportedAs, target: local });
    }
  }

  const moduleExportsObjMatch = moduleExportsObject.exec(maskedSource);
  if (!moduleExportsObjMatch || moduleExportsObjMatch.index === undefined) {
    return;
  }

  const objContent = moduleExportsObjMatch[1]!;
  let objectMatch: RegExpExecArray | null;
  while ((objectMatch = reCjsObjFn.exec(objContent))) {
    const exportedAs = objectMatch[1]!;
    let local = locals.find((def) => def.localName === exportedAs);
    if (!local) {
      const idx = moduleExportsObjMatch.index + moduleExportsObjMatch[0].indexOf(exportedAs);
      const pos = { line: 1, column: 1, index: idx };
      local = {
        file,
        localName: exportedAs,
        kind: SymbolKind.Function,
        range: { start: pos, end: pos },
      };
      locals.push(local);
    }
    if (!exports.some((entry) => entry.type === "local" && entry.exportedAs === exportedAs)) {
      exports.push({ type: "local", exportedAs, target: local });
    }
  }
}

export function collectLocalsAndExportsFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  lang?: JsLanguage,
  imports: ImportBinding[] = [],
  opts?: {
    tree?: SyntaxTreeLike;
    nativeQueries?: NativeQueryResults | null;
    nativeMode?: NativeRuntimeMode;
    logLevel?: LogLevel;
  },
): ModuleIndex {
  if (isGraphOnlyLanguage(support.id)) {
    return { file, exports: [], imports, locals: [] };
  }

  const normalizeDocstringLine = (line: string) => line.replace(/^\s*(?:\/\/\/?\s?|#\s?)/, "").replace(/^\s*\*\s?/, "");

  const _sourceLines = source.split(/\r?\n/);

  const extractLeadingDocstring = (node: SyntaxNodeLike | null): string | undefined => {
    if (!node) return undefined;
    // If we're looking at an identifier, look at its parent (the declaration)
    let target = node;
    if (target.type === "identifier" || target.type === "type_identifier" || target.type === "property_identifier") {
      if (target.parent) target = target.parent;
    }
    // Handle variable declarators - climb to declaration statement
    if (target.type === "variable_declarator" && target.parent) {
      target = target.parent;
    }
    // Handle export statements wrapping the declaration
    if (target.parent && target.parent.type === "export_statement") {
      target = target.parent;
    }

    const comments: string[] = [];
    let prev = target.previousNamedSibling;
    // Walk backwards through comments
    while (prev && (prev.type === "comment" || prev.type === "line_comment" || prev.type === "block_comment")) {
      const text = sliceText(prev, source);
      // Clean up comment syntax
      const clean = text
        .replace(/^\s*\/\*\*?/, "") // /** or /*
        .replace(/\*\/\s*$/, "") // */
        .replace(/^\s*\/\/\/?/, "") // // or ///
        .replace(/^\s*#/, "") // #
        .split("\n")
        .map((l) => normalizeDocstringLine(l))
        .join("\n");
      comments.unshift(clean.trim());
      prev = prev.previousNamedSibling;
    }
    return comments.length > 0 ? comments.join("\n").trim() : undefined;
  };

  const countMatches = (text: string, re: RegExp): number => {
    const matches = text.match(re);
    return matches ? matches.length : 0;
  };

  const estimateComplexity = (range: Range, languageId: string): number | undefined => {
    const startIdx = range.start.index;
    const endIdx = range.end.index;
    if (startIdx === undefined || endIdx === undefined || endIdx <= startIdx) return undefined;
    const snippet = source.slice(startIdx, endIdx);
    if (!snippet.trim()) return undefined;
    const keywordPatterns = [/\bif\b/g, /\bfor\b/g, /\bwhile\b/g, /\bcase\b/g, /\bcatch\b/g, /\belse\s+if\b/g];
    if (languageId === "python") {
      keywordPatterns.push(/\belif\b/g, /\bexcept\b/g);
    }
    const operatorPatterns = [/&&/g, /\|\|/g, /\?\s*[^:]/g];
    let count = 0;
    for (const re of keywordPatterns) count += countMatches(snippet, re);
    for (const re of operatorPatterns) count += countMatches(snippet, re);
    return 1 + count;
  };

  const buildSymbolDef = (localName: string, kind: SymbolKind, range: Range, node?: SyntaxNodeLike): SymbolDef => {
    let lineSpan: number | undefined;
    if (
      typeof range.start.line === "number" &&
      typeof range.end.line === "number" &&
      range.end.line >= range.start.line
    ) {
      lineSpan = Math.max(1, range.end.line - range.start.line + 1);
    }
    let docstring: string | undefined;
    if (node) {
      docstring = extractLeadingDocstring(node);
    }
    const shouldEstimateComplexity = kind === SymbolKind.Function || kind === SymbolKind.Class;
    const complexity = shouldEstimateComplexity ? estimateComplexity(range, support.id) : undefined;
    const base: SymbolDef = {
      file,
      localName,
      kind,
      range,
    };
    if (docstring) base.docstring = docstring;
    if (lineSpan) base.lineSpan = lineSpan;
    if (typeof complexity === "number") base.complexity = complexity;
    return base;
  };

  const nativeQueries = opts?.nativeQueries ?? null;
  let tree: SyntaxTreeLike | null = opts?.tree ?? null;
  let treeAttempted = !!tree;
  let jsQueryTree = opts?.tree && isJsSyntaxTree(opts.tree) ? opts.tree : null;
  let jsQueryTreeAttempted = !!jsQueryTree;
  let resolvedLang = lang;
  const ensureResolvedLang = (): JsLanguage => {
    resolvedLang ??= support.language(file);
    return resolvedLang;
  };

  // Lazily parse the JS tree on first access. This avoids re-parsing files
  // in JS when native queries already cover the needed data and downstream
  // logic never touches the tree (e.g. languages where native locals/exports
  // succeed without needing tree-based enrichment).
  const ensureTree = (): SyntaxTreeLike | null => {
    if (tree || treeAttempted) return tree;
    treeAttempted = true;
    try {
      const nativeTreeExecution = getNativeSyntaxTreeExecution(source, support, opts?.nativeMode);
      if (nativeTreeExecution.tree) {
        tree = new ProjectedSyntaxTree(source, nativeTreeExecution.tree);
        return tree;
      }
      const parsedTree = parseWithJsLanguage(source, ensureResolvedLang());
      tree = parsedTree;
      jsQueryTree = parsedTree;
      jsQueryTreeAttempted = true;
    } catch {
      /* parse fallback: ignore */
    }
    return tree;
  };

  const ensureJsQueryTree = (): JsSyntaxTree | null => {
    if (jsQueryTree || jsQueryTreeAttempted) return jsQueryTree;
    jsQueryTreeAttempted = true;
    try {
      jsQueryTree = parseWithJsLanguage(source, ensureResolvedLang());
    } catch {
      /* parse fallback: ignore */
    }
    return jsQueryTree;
  };

  const locals: SymbolDef[] = [];
  const seenLocals = new Set<string>();
  const toKind = (s: string): SymbolKind => {
    if (s === "function") return SymbolKind.Function;
    if (s === "class") return SymbolKind.Class;
    if (s === "interface") return SymbolKind.Interface;
    if (s === "type") return SymbolKind.TypeAlias;
    return SymbolKind.Variable;
  };

  const pushLocal = (localName: string, kind: SymbolKind, range: Range, node?: SyntaxNodeLike) => {
    const key = `${localName}:${range.start.index ?? 0}:${range.end.index ?? 0}`;
    if (seenLocals.has(key)) return;
    seenLocals.add(key);
    locals.push(buildSymbolDef(localName, kind, range, node));
  };

  const classifyLocalCapture = (
    capture: NativeCapture | { name: string },
    range: Range,
    node?: SyntaxNodeLike,
  ): SymbolKind => {
    if (node) return toKind(support.classifyDefinition(node));
    if ("name" in capture && capture.name === "tname") {
      return SymbolKind.TypeAlias;
    }
    return SymbolKind.Variable;
  };

  const extractLocalsFromNativeQueries = (): boolean => {
    if (!nativeQueries) return false;
    if (!QUERY_DRIVEN_LOCALS_LANGUAGES.has(support.id)) return false;
    try {
      // Lazily get the tree only for enrichment (classification + docstrings).
      // If the tree was already provided or the language benefits from it, use
      // it. Otherwise native captures still succeed without tree enrichment.
      const enrichmentTree = ensureTree();
      for (const match of nativeQueries.locals) {
        for (const capture of match.captures) {
          if (capture.name !== "name" && capture.name !== "tname") continue;
          const nativeRange = rangeFromNativeCapture(capture);
          const node =
            enrichmentTree?.rootNode.descendantForIndex(nativeRange.start.index ?? 0, nativeRange.end.index ?? 0) ??
            undefined;
          pushLocal(capture.text, classifyLocalCapture(capture, nativeRange, node), nativeRange, node);
        }
      }
      return true;
    } catch {
      return false;
    }
  };

  const extractLocalsFromJsQueries = (): boolean => {
    if (isNativeBindingLoadedForLanguage(support.id, opts?.nativeMode)) {
      return false;
    }
    const jsTree = ensureJsQueryTree();
    if (!jsTree || !support.queries.locals.trim()) return false;
    if (!QUERY_DRIVEN_LOCALS_LANGUAGES.has(support.id)) return false;
    try {
      const matches = executeJsQueryAsNativeMatches(
        source,
        support,
        ensureResolvedLang(),
        support.queries.locals,
        jsTree,
      );
      for (const match of matches) {
        for (const cap of match.captures) {
          if (cap.name !== "name" && cap.name !== "tname") continue;
          const range = rangeFromNativeCapture(cap);
          const node = jsTree.rootNode.descendantForIndex(range.start.index ?? 0, range.end.index ?? 0) ?? undefined;
          pushLocal(cap.text, classifyLocalCapture(cap, range, node), range, node);
        }
      }
      return true;
    } catch (error) {
      logWithLevel(opts?.logLevel, "warn", `Warning: Query error in locals for ${support.id}:`, error);
      return false;
    }
  };

  const usedNativeLocals = extractLocalsFromNativeQueries();
  const usedQueryLocals = usedNativeLocals || extractLocalsFromJsQueries();
  if (!usedQueryLocals) {
    const scopeTree = ensureTree();
    if (scopeTree) {
      const scopeIdx = buildScopeIndexFromSource(file, source, support, lang, imports, { tree: scopeTree });
      for (const b of scopeIdx.all) {
        if (!b.def) continue;
        let kind: SymbolKind = SymbolKind.Variable;
        if (b.kind === "function") kind = SymbolKind.Function;
        else if (b.kind === "class") kind = SymbolKind.Class;
        else if (b.kind === "type") kind = SymbolKind.TypeAlias;
        pushLocal(b.name, kind, b.def, b.node);
      }
    }
  }

  const mergeTypeScriptNamespaceDeclarations = (items: SymbolDef[]): SymbolDef[] => {
    if (support.id !== "ts" && support.id !== "tsx") return items;
    const byName = new Map<string, SymbolDef[]>();
    for (const item of items) {
      const group = byName.get(item.localName);
      if (group) group.push(item);
      else byName.set(item.localName, [item]);
    }
    const out: SymbolDef[] = [];
    const rank = (k: SymbolKind): number => {
      if (k === SymbolKind.Class) return 5;
      if (k === SymbolKind.Interface) return 4;
      if (k === SymbolKind.TypeAlias) return 3;
      if (k === SymbolKind.Function) return 2;
      return 1;
    };
    for (const group of byName.values()) {
      if (group.length === 1) {
        out.push(group[0]!);
        continue;
      }
      const sorted = [...group].sort((a, b) => rank(b.kind) - rank(a.kind));
      out.push(sorted[0]!);
    }
    return out;
  };
  const mergedLocals = mergeTypeScriptNamespaceDeclarations(locals);

  const exports: ExportEntry[] = [];
  const pythonAllExports = new Set<string>();
  let hasPythonAll = false;

  const appendExportsFromMatches = (
    matches: NativeQueryResults["exports"],
    treeForEnrichment?: SyntaxTreeLike,
  ): void => {
    const nodeForCapture = (capture: NativeCapture | undefined): SyntaxNodeLike | undefined => {
      if (!capture || !treeForEnrichment) return undefined;
      const range = rangeFromNativeCapture(capture);
      return treeForEnrichment.rootNode.descendantForIndex(range.start.index ?? 0, range.end.index ?? 0) ?? undefined;
    };

    for (const match of matches) {
      const map = capturesByName(match);
      const stmtText = map["stmt"]?.text ?? "";
      const isTypeOnly = support.isTypeOnly(stmtText);

      if (support.id === "python") {
        const leftText = map["left"]?.text ?? "";
        const methodText = map["method"]?.text ?? "";
        const isAllAssignment = leftText === "__all__";
        const isAllMethod = leftText === "__all__" && (methodText === "extend" || methodText === "append");

        if (isAllAssignment || isAllMethod) {
          hasPythonAll = true;
          const items = capturesNamed(match, "all_item");
          for (const item of items) {
            const name = unquote(item.text);
            pythonAllExports.add(name);
            const local = mergedLocals.find((def) => def.localName === name);
            if (
              local &&
              !exports.some(
                (entry) => entry.type !== "exportStar" && "exportedAs" in entry && entry.exportedAs === name,
              )
            ) {
              exports.push({
                type: "local",
                exportedAs: name,
                target: local,
              });
            }
          }
          if (isAllAssignment && map["stmt"]) {
            const assignmentText = map["stmt"].text;
            const hasTuple = /=\s*\(/.test(assignmentText);
            if (items.length === 0 || hasTuple) {
              const strRe = /["']([^"']+)["']/g;
              for (let submatch; (submatch = strRe.exec(assignmentText)); ) {
                const name = submatch[1]!;
                pythonAllExports.add(name);
                const local = mergedLocals.find((def) => def.localName === name);
                if (
                  local &&
                  !exports.some(
                    (entry) => entry.type !== "exportStar" && "exportedAs" in entry && entry.exportedAs === name,
                  )
                ) {
                  exports.push({
                    type: "local",
                    exportedAs: name,
                    target: local,
                  });
                }
              }
            }
          }
          continue;
        }
        if (map["name"]) {
          const nameText = map["name"].text;
          const local = locals.find((def) => def.localName === nameText);
          if (local && !nameText.startsWith("_")) {
            exports.push({
              type: "local",
              exportedAs: nameText,
              target: local,
            });
          }
          continue;
        }
      }

      if (map["from"]) {
        const from = unquote(map["from"].text);
        if (map["src"]) {
          const srcName = map["src"].text;
          const alias = map["alias"]?.text ?? srcName;
          exports.push({
            type: "reexport",
            exportedAs: alias,
            fromModule: from,
            moduleSpecifier: from,
            sourceSpecifier: srcName,
            typeOnly: isTypeOnly,
          });
        } else if (/^\s*export\s*\*/.test(stmtText)) {
          exports.push({
            type: "exportStar",
            fromModule: from,
            moduleSpecifier: from,
            sourceSpecifier: from,
            typeOnly: isTypeOnly,
          });
        }
        continue;
      }
      if (map["cjs_shorthand"]) {
        const nameText = map["cjs_shorthand"].text;
        const local = locals.find((def) => def.localName === nameText);
        if (local) {
          exports.push({
            type: "local",
            exportedAs: nameText,
            target: local,
          });
        }
        continue;
      }
      if (map["cjs_export_name"] && map["cjs_local"]) {
        const exportedAs = map["cjs_export_name"].text;
        const localName = map["cjs_local"].text;
        const local = locals.find((def) => def.localName === localName);
        if (local) exports.push({ type: "local", exportedAs, target: local });
        continue;
      }
      if (map["cjs_export_name"] && map["cjs_fn"]) {
        const exportedAs = map["cjs_export_name"].text;
        const fnNode = nodeForCapture(map["cjs_fn"]);
        const sym = buildSymbolDef(exportedAs, SymbolKind.Function, rangeFromNativeCapture(map["cjs_fn"]), fnNode);
        locals.push(sym);
        exports.push({ type: "local", exportedAs, target: sym });
        continue;
      }
      if (map["default"]) {
        const nameText = map["default"].text;
        const local = locals.find((def) => def.localName === nameText);
        if (local) {
          exports.push({
            type: "local",
            exportedAs: "default",
            target: { ...local, kind: SymbolKind.Default },
          });
        }
        continue;
      }
      if (map["anon_default"]) {
        const defaultNode = nodeForCapture(map["anon_default"]);
        const sym = buildSymbolDef(
          "__default_export__",
          SymbolKind.Default,
          rangeFromNativeCapture(map["anon_default"]),
          defaultNode,
        );
        locals.push(sym);
        exports.push({ type: "local", exportedAs: "default", target: sym });
        continue;
      }
      const tsExportAssignMatch =
        support.id === "ts" || support.id === "tsx"
          ? stmtText.match(/^\s*export\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/)
          : null;
      if (tsExportAssignMatch) {
        const ident = tsExportAssignMatch[1]!;
        const local = locals.find((def) => def.localName === ident);
        if (local) {
          exports.push({
            type: "local",
            exportedAs: "default",
            target: { ...local, kind: SymbolKind.Default },
          });
        }
        continue;
      }
      if (map["ts_export_assign"]) {
        const ident = map["ts_export_assign"].text;
        const local = locals.find((def) => def.localName === ident);
        if (local) {
          exports.push({
            type: "local",
            exportedAs: "default",
            target: { ...local, kind: SymbolKind.Default },
          });
        }
        continue;
      }
      if (map["name"]) {
        const nameText = map["name"].text;
        const local = locals.find((def) => def.localName === nameText);
        if (local) {
          const isDefaultExport = /^\s*export\s+default\b/.test(stmtText);
          if (!isDefaultExport) {
            exports.push({
              type: "local",
              exportedAs: nameText,
              target: local,
            });
          }
          if (isDefaultExport) {
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
          }
        }
        continue;
      }
      if (map["src"]) {
        const srcName = map["src"].text;
        const alias = map["alias"]?.text ?? srcName;
        const local = locals.find((def) => def.localName === srcName);
        if (local) {
          exports.push({
            type: "local",
            exportedAs: alias,
            target: local,
          });
        }
        continue;
      }
    }
  };

  let usedNativeExports = false;
  if (support.queries.exports.trim() && nativeQueries) {
    try {
      appendExportsFromMatches(nativeQueries.exports);
      if (!exports.some((entry) => entry.type === "local" && entry.exportedAs === "default")) {
        const mDefFn = source.match(/\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)/);
        const mDefCls = source.match(/\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/);
        const name = mDefFn?.[1] ?? mDefCls?.[1];
        if (name) {
          const local = locals.find((def) => def.localName === name);
          if (local) {
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
          }
        }
      }
      usedNativeExports = true;
    } catch {
      usedNativeExports = false;
    }
  }
  const jsExportTree =
    !usedNativeExports && !isNativeBindingLoadedForLanguage(support.id, opts?.nativeMode) ? ensureJsQueryTree() : null;
  if (support.queries.exports.trim() && jsExportTree && !usedNativeExports) {
    try {
      appendExportsFromMatches(
        executeJsQueryAsNativeMatches(source, support, ensureResolvedLang(), support.queries.exports, jsExportTree),
        jsExportTree,
      );
      if (!exports.some((e) => e.type === "local" && e.exportedAs === "default")) {
        const mDefFn = source.match(/\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)/);
        const mDefCls = source.match(/\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/);
        const name = mDefFn?.[1] ?? mDefCls?.[1];
        if (name) {
          const local = locals.find((d) => d.localName === name);
          if (local)
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
        }
      }
    } catch {
      // fall through to regex fallback below
    }
  }

  // Regex fallback for JS/TS exports when queries miss some patterns (e.g., re-exports)
  if (support.id === "ts" || support.id === "tsx" || support.id === "js") {
    appendJsLikeRegexFallbackExports(file, source, locals, exports);
  }

  if (support.id === "python" && hasPythonAll) {
    const seen = new Set<string>();
    const filtered = exports.filter((e) => {
      if (e.type === "local") {
        if (!pythonAllExports.has(e.exportedAs)) return false;
        if (seen.has(e.exportedAs)) return false;
        seen.add(e.exportedAs);
        return true;
      }
      if (e.type === "reexport") return pythonAllExports.has(e.exportedAs);
      return true;
    });
    exports.length = 0;
    exports.push(...filtered);
  }

  if (
    (support.id === "ts" || support.id === "js") &&
    !exports.some((e) => e.type === "local" && e.exportedAs === "default")
  ) {
    const defFn = source.match(/\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)/);
    const defCls = source.match(/\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/);
    const defIdent = source.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\b/);
    const name = defFn?.[1] ?? defCls?.[1] ?? defIdent?.[1];
    if (name) {
      const local = locals.find((d) => d.localName === name);
      if (local)
        exports.push({
          type: "local",
          exportedAs: "default",
          target: { ...local, kind: SymbolKind.Default },
        });
    }
  }

  return { file, exports, imports, locals };
}
