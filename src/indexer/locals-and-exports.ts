import type { LogLevel } from "../logging.js";
import { isGraphOnlyLanguage } from "../documentLinks.js";
import { capturesByName, capturesNamed, rangeFromNativeCapture } from "../native/queryResults.js";
import { buildByteToStringIndexMap, type ByteToStringIndexMap } from "../native/byteIndex.js";
import { ProjectedSyntaxTree } from "../native/projectedTree.js";
import {
  assertNativeRequiredAvailable,
  getNativeSyntaxTreeExecution,
  isNativeRequiredUnavailableError,
  type NativeCapture,
  type NativeQueryResults,
  type NativeRuntimeMode,
} from "../native/treeSitterNative.js";
import { maskJsLikeCommentsAndStrings } from "../util/comments.js";
import { sliceText, toRange, unquote } from "../util/ast.js";
import { bindingKindToSymbolKind } from "./declarations.js";
import { buildScopeIndexFromSource } from "./scope.js";
import { SymbolKind } from "./types.js";
import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { ExportEntry, ImportBinding, ModuleIndex, SymbolDef } from "./types.js";
import type { Range } from "../types.js";

import { ECMASCRIPT_IDENTIFIER_SOURCE } from "../util/identifiers.js";

const JS_FALLBACK_DECLARATION_PATTERN = new RegExp(
  String.raw`\bexport\s+(?:const|let|var|function|class)\s+(${ECMASCRIPT_IDENTIFIER_SOURCE})`,
  "gu",
);
const JS_FALLBACK_DEFAULT_PATTERN = new RegExp(
  String.raw`\bexport\s+default\s+(${ECMASCRIPT_IDENTIFIER_SOURCE})`,
  "gu",
);
const JS_FALLBACK_EXPORT_ASSIGN_PATTERN = new RegExp(
  String.raw`\bexport\s*=\s*(${ECMASCRIPT_IDENTIFIER_SOURCE})`,
  "gu",
);
const JS_FALLBACK_REEXPORT_SPECIFIER_PATTERN = new RegExp(
  String.raw`^(${ECMASCRIPT_IDENTIFIER_SOURCE})(?:\s+as\s+(${ECMASCRIPT_IDENTIFIER_SOURCE}))?$`,
  "u",
);
const JS_FALLBACK_REEXPORT_NAMESPACE_PATTERN = new RegExp(
  String.raw`\bexport\s*\*\s+as\s+(${ECMASCRIPT_IDENTIFIER_SOURCE})\s+from\s*("|')([^"']*)\2`,
  "gu",
);
const JS_FALLBACK_CJS_FUNCTION_PATTERN = new RegExp(
  String.raw`(?:^|[;\n\r])\s*(?:exports|module\.exports)\.(${ECMASCRIPT_IDENTIFIER_SOURCE})\s*=\s*(function\b|\([^)]*\)\s*=>)`,
  "gu",
);
const JS_FALLBACK_CJS_OBJECT_FUNCTION_PATTERN = new RegExp(
  String.raw`(${ECMASCRIPT_IDENTIFIER_SOURCE})\s*:\s*(function\b|\([^)]*\)\s*=>)`,
  "gu",
);
const JS_FALLBACK_TS_EXPORT_ASSIGN_PATTERN = new RegExp(
  String.raw`^\s*export\s*=\s*(${ECMASCRIPT_IDENTIFIER_SOURCE})\s*;?\s*$`,
  "u",
);
const JS_DEFAULT_FUNCTION_PATTERN = new RegExp(
  String.raw`\bexport\s+default\s+(?:async\s+)?function\b\s*\*?\s*(${ECMASCRIPT_IDENTIFIER_SOURCE})`,
  "u",
);
const JS_DEFAULT_CLASS_PATTERN = new RegExp(
  String.raw`\bexport\s+default\s+(?:abstract\s+)?class\s+(${ECMASCRIPT_IDENTIFIER_SOURCE})`,
  "u",
);
const JS_DEFAULT_IDENTIFIER_PATTERN = new RegExp(
  String.raw`\bexport\s+default\s+(${ECMASCRIPT_IDENTIFIER_SOURCE})(?![$_\p{ID_Continue}\u200c\u200d])`,
  "u",
);
const METHOD_LIKE_BINDING_NODE_TYPES = new Set([
  "method_definition",
  "method_signature",
  "abstract_method_signature",
  "method_declaration",
  "method",
  "function_item",
  "function_declaration",
  "function_definition",
]);

// TypeScript/TSX and JavaScript class field declarations are absent from
// those languages' native `locals` query (only method-like declarations
// are queried there), so `#private` and public class fields resolve to
// zero definitions without this structural supplement.
const FIELD_LIKE_BINDING_NODE_TYPES = new Set([
  "public_field_definition", // TypeScript/TSX
  "field_definition", // JavaScript
]);

const MEMBER_CONTAINER_NODE_TYPES: Record<string, true> = {
  class_body: true,
  class_declaration: true,
  abstract_class_declaration: true,
  class_definition: true,
  class: true,
  interface_declaration: true,
  impl_item: true,
  trait_item: true,
  enum_declaration: true,
  enum_item: true,
};

const CALLABLE_DECLARATION_NODE_TYPES: Record<string, true> = {
  function_declaration: true,
  generator_function_declaration: true,
  function_definition: true,
  function_item: true,
  method_definition: true,
  method_declaration: true,
  method: true,
  singleton_method: true,
};

function isTypeMemberDeclaration(node: SyntaxNodeLike): boolean {
  let current = node.parent?.parent ?? null;
  while (current) {
    if (MEMBER_CONTAINER_NODE_TYPES[current.type]) return true;
    if (CALLABLE_DECLARATION_NODE_TYPES[current.type]) return false;
    current = current.parent;
  }
  return false;
}

function appendJsLikeRegexFallbackExports(
  file: string,
  source: string,
  locals: SymbolDef[],
  exports: ExportEntry[],
): void {
  const maskedSource = maskJsLikeCommentsAndStrings(source);
  JS_FALLBACK_DECLARATION_PATTERN.lastIndex = 0;
  JS_FALLBACK_DEFAULT_PATTERN.lastIndex = 0;
  JS_FALLBACK_EXPORT_ASSIGN_PATTERN.lastIndex = 0;
  JS_FALLBACK_REEXPORT_NAMESPACE_PATTERN.lastIndex = 0;
  JS_FALLBACK_CJS_FUNCTION_PATTERN.lastIndex = 0;
  JS_FALLBACK_CJS_OBJECT_FUNCTION_PATTERN.lastIndex = 0;
  const reDecl = JS_FALLBACK_DECLARATION_PATTERN;
  const reDefault = JS_FALLBACK_DEFAULT_PATTERN;
  const reExportAssign = JS_FALLBACK_EXPORT_ASSIGN_PATTERN;
  const reReexport = new RegExp(String.raw`\bexport\s*\{\s*([^}]+)\}\s*from\s*("|')([^"']*)\2`, "gu");
  const reReexportNs = JS_FALLBACK_REEXPORT_NAMESPACE_PATTERN;
  const reStar = /\bexport\s*\*\s*from\s*("|')([^"']*)\1/gu;
  const reCjsFn = JS_FALLBACK_CJS_FUNCTION_PATTERN;
  const reCjsObjFn = JS_FALLBACK_CJS_OBJECT_FUNCTION_PATTERN;
  const moduleExportsObject = /module\.exports\s*=\s*\{([^}]*)\}/su;
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
      const entryMatch = JS_FALLBACK_REEXPORT_SPECIFIER_PATTERN.exec(spec);
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
  assertNativeRequiredAvailable(opts?.nativeMode);

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
    return comments.length ? comments.join("\n").trim() : undefined;
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

  const positionForIndex = (index: number): { line: number; column: number; index: number } => {
    let line = 1;
    let lineStart = 0;
    for (let offset = 0; offset < index && offset < source.length; offset += 1) {
      if (source.charCodeAt(offset) === 10) {
        line += 1;
        lineStart = offset + 1;
      }
    }
    return { line, column: index - lineStart + 1, index };
  };

  const rangeFromOffsets = (start: number, end: number): Range => ({
    start: positionForIndex(start),
    end: positionForIndex(end),
  });

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
    if (node && isTypeMemberDeclaration(node)) base.isMember = true;
    if (docstring) base.docstring = docstring;
    if (lineSpan) base.lineSpan = lineSpan;
    if (typeof complexity === "number") base.complexity = complexity;
    return base;
  };

  const nativeQueries = opts?.nativeQueries ?? null;
  let tree: SyntaxTreeLike | null = opts?.tree ?? null;
  let treeAttempted = !!tree;

  // Lazily parse a native-projected tree on first access. In zero-native mode
  // there is no grammar fallback; callers get reduced locals/exports instead.
  const ensureTree = (): SyntaxTreeLike | null => {
    if (tree || treeAttempted) return tree;
    treeAttempted = true;
    try {
      const nativeTreeExecution = getNativeSyntaxTreeExecution(source, support, opts?.nativeMode);
      if (nativeTreeExecution.tree) {
        tree = new ProjectedSyntaxTree(source, nativeTreeExecution.tree);
        return tree;
      }
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) throw error;
      /* reduced mode: ignore */
    }
    return tree;
  };

  // Lazily build once: converts every native capture's UTF-8 byte offsets to UTF-16
  // string indexes in O(1) per capture instead of rescanning the source per offset.
  // `ensureTree()` builds the same map internally when native mode is active, so route
  // through it first and reuse that map instead of scanning the source a second time.
  let byteIndexMap: ByteToStringIndexMap | null = null;
  const ensureByteIndexMap = (): ByteToStringIndexMap => {
    if (byteIndexMap) return byteIndexMap;
    const enrichmentTree = ensureTree();
    byteIndexMap =
      enrichmentTree instanceof ProjectedSyntaxTree ? enrichmentTree.byteIndexMap : buildByteToStringIndexMap(source);
    return byteIndexMap;
  };

  const locals: SymbolDef[] = [];
  const seenLocals = new Set<string>();
  const toKind = (s: string): SymbolKind => {
    if (s === "function") return SymbolKind.Function;
    if (s === "method") return SymbolKind.Function;
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

  const symbolKindForDeclarationNode = (node: SyntaxNodeLike): SymbolKind => {
    if (
      node.type === "function_declaration" ||
      node.type === "generator_function_declaration" ||
      node.type === "function"
    )
      return SymbolKind.Function;
    if (node.type === "class_declaration" || node.type === "abstract_class_declaration") return SymbolKind.Class;
    return SymbolKind.Variable;
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
    if (!support.usesQueryDrivenLocals) return false;
    let capturedLocals = false;
    try {
      // Lazily get the tree only for enrichment (classification + docstrings).
      // If the tree was already provided or the language benefits from it, use
      // it. Otherwise native captures still succeed without tree enrichment.
      const enrichmentTree = ensureTree();
      for (const match of nativeQueries.locals) {
        for (const capture of match.captures) {
          if (capture.name !== "name" && capture.name !== "tname") continue;
          const nativeRange = rangeFromNativeCapture(capture, ensureByteIndexMap());
          const node =
            enrichmentTree?.rootNode.descendantForIndex(nativeRange.start.index ?? 0, nativeRange.end.index ?? 0) ??
            undefined;
          pushLocal(capture.text, classifyLocalCapture(capture, nativeRange, node), nativeRange, node);
          capturedLocals = true;
        }
      }
      return capturedLocals;
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) throw error;
      return false;
    }
  };

  const extractLocalsFromJsQueries = (): boolean => false;

  const usedNativeLocals = extractLocalsFromNativeQueries();
  const usedQueryLocals = usedNativeLocals || extractLocalsFromJsQueries();
  if (!usedQueryLocals) {
    const scopeTree = ensureTree();
    if (scopeTree) {
      const scopeIdx = buildScopeIndexFromSource(file, source, support, imports, { tree: scopeTree });
      for (const b of scopeIdx.all) {
        if (!b.def) continue;
        const kind = bindingKindToSymbolKind(b.kind);
        pushLocal(b.name, kind, b.def, b.node);
      }
    }
  }

  const methodSupplementTree = ensureTree();
  if (methodSupplementTree) {
    supplementMethodLocalsFromSyntaxTree(methodSupplementTree.rootNode);
  }

  function supplementMethodLocalsFromSyntaxTree(node: SyntaxNodeLike): void {
    if (METHOD_LIKE_BINDING_NODE_TYPES.has(node.type)) {
      const name = node.childForFieldName("name");
      if (name) {
        pushLocal(sliceText(name, source), SymbolKind.Function, toRange(name), name);
      }
    } else if (FIELD_LIKE_BINDING_NODE_TYPES.has(node.type)) {
      // TypeScript exposes the field name via the "name" field; JavaScript exposes
      // the same position via "property". Both cover `#private` and public names.
      const name = node.childForFieldName("name") ?? node.childForFieldName("property");
      if (name) {
        pushLocal(sliceText(name, source), SymbolKind.Variable, toRange(name), name);
      }
    }
    for (const child of node.namedChildren) {
      supplementMethodLocalsFromSyntaxTree(child);
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
      if (group.every((item) => item.kind === SymbolKind.Function)) {
        out.push(...group);
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
      const range = rangeFromNativeCapture(capture, ensureByteIndexMap());
      return treeForEnrichment.rootNode.descendantForIndex(range.start.index ?? 0, range.end.index ?? 0) ?? undefined;
    };

    const defaultDeclarationNameNode = (node: SyntaxNodeLike | undefined): SyntaxNodeLike | undefined => {
      if (!node) return undefined;
      return (
        node.childForFieldName("name") ?? node.childForFieldName("declaration")?.childForFieldName("name") ?? undefined
      );
    };

    const hasDefaultExport = (): boolean =>
      exports.some((entry) => entry.type === "local" && entry.exportedAs === "default");

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
            if (!items.length || hasTuple) {
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
      if (map["cjs_spread"]) {
        const spreadName = map["cjs_spread"].text;
        const imported = imports.find(
          (binding) =>
            (binding.kind === "default" && binding.local === spreadName) ||
            (binding.kind === "namespace" && binding.localNS === spreadName),
        );
        if (imported) {
          const fromModule = typeof imported.resolved === "string" ? imported.resolved : imported.from;
          if (!exports.some((entry) => entry.type === "exportStar" && entry.fromModule === fromModule)) {
            exports.push({
              type: "exportStar",
              fromModule,
              moduleSpecifier: imported.from,
              sourceSpecifier: imported.from,
            });
          }
          continue;
        }

        const findLocalObject = (node: SyntaxNodeLike): SyntaxNodeLike | undefined => {
          if (node.type === "variable_declarator") {
            const name = node.childForFieldName("name");
            const value = node.childForFieldName("value");
            if (sliceText(name, source) === spreadName && value?.type === "object") return value;
          }
          for (const child of node.namedChildren) {
            const value = findLocalObject(child);
            if (value) return value;
          }
          return undefined;
        };
        const localObject = treeForEnrichment ? findLocalObject(treeForEnrichment.rootNode) : undefined;
        if (localObject) {
          const addObjectMember = (exportedAs: string, value: SyntaxNodeLike, member: SyntaxNodeLike): void => {
            let local: SymbolDef | undefined;
            if (value.type === "identifier" || value.type === "shorthand_property_identifier") {
              local = locals.find((definition) => definition.localName === sliceText(value, source));
            } else if (value.type === "function" || value.type === "arrow_function") {
              local = buildSymbolDef(exportedAs, SymbolKind.Function, toRange(value), member);
              locals.push(local);
            }
            if (local && !exports.some((entry) => entry.type === "local" && entry.exportedAs === exportedAs)) {
              exports.push({ type: "local", exportedAs, target: local });
            }
          };

          for (const member of localObject.namedChildren) {
            if (member.type === "shorthand_property_identifier") {
              addObjectMember(member.text, member, member);
              continue;
            }
            if (member.type === "pair") {
              const key = member.childForFieldName("key");
              const value = member.childForFieldName("value");
              if (
                key &&
                value &&
                (key.type === "identifier" || key.type === "property_identifier" || key.type === "string")
              ) {
                addObjectMember(key.type === "string" ? unquote(key.text) : key.text, value, member);
              }
              continue;
            }
            if (member.type === "method_definition") {
              const name = member.childForFieldName("name");
              if (name) {
                const local = locals.find(
                  (definition) =>
                    definition.localName === name.text && definition.range.start.index === name.startIndex,
                );
                if (local && !exports.some((entry) => entry.type === "local" && entry.exportedAs === name.text)) {
                  exports.push({ type: "local", exportedAs: name.text, target: local });
                }
              }
            }
          }
          continue;
        }

        // The source exists syntactically but cannot be resolved without executing
        // user code. Keep an explicit API marker instead of silently losing it.
        const unresolvedMarker = `<unresolved cjs spread: ${spreadName}>`;
        exports.push({
          type: "namespaceReexport",
          exportedAs: unresolvedMarker,
          fromModule: unresolvedMarker,
        });
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
        const sym = buildSymbolDef(
          exportedAs,
          SymbolKind.Function,
          rangeFromNativeCapture(map["cjs_fn"], ensureByteIndexMap()),
          fnNode,
        );
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
        if (!/^\s*export\s+default\b/.test(stmtText)) continue;
        if (hasDefaultExport()) continue;
        const defaultNode = nodeForCapture(map["anon_default"]);
        const declaredName = defaultDeclarationNameNode(defaultNode);
        const declaredNameText = declaredName ? sliceText(declaredName, source) : null;
        let declaredLocal = declaredNameText ? locals.find((def) => def.localName === declaredNameText) : undefined;
        if (declaredName && declaredNameText && !declaredLocal && defaultNode) {
          declaredLocal = buildSymbolDef(
            declaredNameText,
            symbolKindForDeclarationNode(defaultNode),
            toRange(declaredName),
            declaredName,
          );
          locals.push(declaredLocal);
        }
        if (declaredLocal) {
          exports.push({
            type: "local",
            exportedAs: "default",
            target: { ...declaredLocal, kind: SymbolKind.Default },
          });
        } else {
          const sym = buildSymbolDef(
            "__default_export__",
            SymbolKind.Default,
            rangeFromNativeCapture(map["anon_default"], ensureByteIndexMap()),
            defaultNode,
          );
          locals.push(sym);
          exports.push({ type: "local", exportedAs: "default", target: sym });
        }
        continue;
      }
      const tsExportAssignMatch =
        support.id === "ts" || support.id === "tsx" ? JS_FALLBACK_TS_EXPORT_ASSIGN_PATTERN.exec(stmtText) : null;
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
          if (isDefaultExport && !hasDefaultExport()) {
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

  if (support.queries.exports.trim() && nativeQueries) {
    try {
      appendExportsFromMatches(nativeQueries.exports, ensureTree() ?? undefined);
      if (!exports.some((entry) => entry.type === "local" && entry.exportedAs === "default")) {
        const mDefFn = JS_DEFAULT_FUNCTION_PATTERN.exec(source);
        const mDefCls = JS_DEFAULT_CLASS_PATTERN.exec(source);
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
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) throw error;
    }
  }

  // Regex fallback for JS/TS exports when queries miss some patterns (e.g., re-exports)
  if (support.id === "ts" || support.id === "tsx" || support.id === "js") {
    appendJsLikeRegexFallbackExports(file, source, locals, exports);
  }

  if (support.id === "python") {
    for (const binding of imports) {
      if (binding.mechanism !== "python" || !binding.moduleLevel || typeof binding.resolved !== "string") continue;
      if (binding.kind === "named") {
        if (binding.local.startsWith("_")) continue;
        exports.push({
          type: "reexport",
          exportedAs: binding.local,
          fromModule: binding.resolved,
          moduleSpecifier: binding.from,
          sourceSpecifier: binding.imported,
        });
      } else if (binding.kind === "namespace" && !binding.localNS.startsWith("_")) {
        exports.push({
          type: "namespaceReexport",
          exportedAs: binding.localNS,
          fromModule: binding.resolved,
          moduleSpecifier: binding.from,
        });
      }
    }
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
    (support.id === "ts" || support.id === "tsx" || support.id === "js") &&
    !exports.some((e) => e.type === "local" && e.exportedAs === "default")
  ) {
    const maskedSource = maskJsLikeCommentsAndStrings(source);
    const defFn = JS_DEFAULT_FUNCTION_PATTERN.exec(maskedSource);
    const defCls = JS_DEFAULT_CLASS_PATTERN.exec(maskedSource);
    const defIdent = JS_DEFAULT_IDENTIFIER_PATTERN.exec(maskedSource);
    const ignoredDefaultIdentifiers = new Set(["abstract", "async", "class", "function"]);
    const identName = defIdent && defIdent[1] && !ignoredDefaultIdentifiers.has(defIdent[1]) ? defIdent[1] : undefined;
    const name = defFn?.[1] ?? defCls?.[1] ?? identName;
    if (name) {
      const local = locals.find((d) => d.localName === name);
      if (local)
        exports.push({
          type: "local",
          exportedAs: "default",
          target: { ...local, kind: SymbolKind.Default },
        });
    } else {
      const anon = maskedSource.match(/\bexport\s+default\s+(?:async\s+)?(?:function\b\s*\*?|(?:abstract\s+)?class\b)/);
      if (anon && anon.index !== undefined) {
        const startIndex = anon.index;
        const endIndex = startIndex + anon[0].length;
        const treeNode = ensureTree()?.rootNode.descendantForIndex(startIndex, endIndex) ?? undefined;
        const sym = buildSymbolDef(
          "__default_export__",
          SymbolKind.Default,
          treeNode ? toRange(treeNode) : rangeFromOffsets(startIndex, endIndex),
        );
        locals.push(sym);
        exports.push({ type: "local", exportedAs: "default", target: sym });
      }
    }
  }

  return { file, exports, imports, locals };
}
