import {
  parseSync,
  Visitor,
  type AssignmentExpression,
  type BindingIdentifier,
  type BindingPattern,
  type CallExpression,
  type Comment,
  type ExportAllDeclaration,
  type ExportDefaultDeclaration,
  type ExportNamedDeclaration,
  type ExportSpecifier,
  type Expression,
  type Function,
  type ImportDeclaration,
  type ImportDeclarationSpecifier,
  type MemberExpression,
  type ModuleExportName,
  type Node,
  type ObjectExpression,
  type ObjectPattern,
  type ObjectPropertyKind,
  type Program,
  type PropertyKey,
  type Span,
  type Statement,
  type StringLiteral,
  type TSExportAssignment,
  type TSGlobalDeclaration,
  type TSExternalModuleReference,
  type TSImportEqualsDeclaration,
  type TSModuleDeclaration,
  type TSTypeAliasDeclaration,
  type TSInterfaceDeclaration,
  type VariableDeclarator,
} from "oxc-parser";

import type { Range } from "../types.js";

export type OxcSymbolKind = "function" | "class" | "variable" | "interface" | "type" | "default";

export type OxcSymbolDef = {
  file: string;
  localName: string;
  kind: OxcSymbolKind;
  range: Range;
  docstring?: string;
  lineSpan?: number;
  complexity?: number;
};

export type OxcExportEntry =
  | { type: "local"; exportedAs: string; target: OxcSymbolDef }
  | {
      type: "reexport";
      exportedAs: string;
      fromModule: string;
      moduleSpecifier?: string;
      sourceSpecifier: string;
      typeOnly?: boolean;
    }
  | {
      type: "namespaceReexport";
      exportedAs: string;
      fromModule: string;
      moduleSpecifier?: string;
      typeOnly?: boolean;
    }
  | {
      type: "exportStar";
      fromModule: string;
      moduleSpecifier?: string;
      sourceSpecifier: string;
      typeOnly?: boolean;
    };

export type OxcImportBinding =
  | {
      kind: "default";
      local: string;
      from: string;
      typeOnly?: boolean;
      mechanism?: "es" | "cjs";
    }
  | {
      kind: "named";
      local: string;
      imported: string;
      from: string;
      typeOnly?: boolean;
      mechanism?: "es" | "cjs";
    }
  | {
      kind: "namespace";
      localNS: string;
      from: string;
      typeOnly?: boolean;
      mechanism?: "es" | "cjs";
    };

export type OxcModuleSpecifier = {
  spec: string;
  typeOnly?: boolean;
};

export type OxcModuleAnalysis = {
  imports: OxcImportBinding[];
  exports: OxcExportEntry[];
  locals: OxcSymbolDef[];
  specifiers: OxcModuleSpecifier[];
};

type CommentInfo = {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  text: string;
};

type Position = {
  line: number;
  column: number;
};

const JS_TS_LANGUAGE_IDS = new Set(["js", "ts", "tsx"]);

export function supportsOxcLanguage(languageId: string): boolean {
  return JS_TS_LANGUAGE_IDS.has(languageId);
}

export function analyzeJsTsModuleWithOxc(
  file: string,
  source: string,
  languageId: string,
): OxcModuleAnalysis | null {
  if (!supportsOxcLanguage(languageId)) return null;

  try {
    const parserLang = getOxcLang(file, languageId);
    const result = parseSync(file, source, {
      lang: parserLang,
      sourceType: "unambiguous",
    });
    const lineStarts = buildLineStarts(source);
    const commentInfos = buildCommentInfos(result.comments, source, lineStarts);

    const locals: OxcSymbolDef[] = [];
    const imports: OxcImportBinding[] = [];
    const exports: OxcExportEntry[] = [];
    const specifiers: OxcModuleSpecifier[] = [];

    const localByName = new Map<string, OxcSymbolDef[]>();
    const importKeys = new Set<string>();
    const exportKeys = new Set<string>();
    const specifierKeys = new Set<string>();

    const addSpecifier = (spec: string, typeOnly = false) => {
      if (!spec) return;
      const key = `${spec}::${typeOnly ? 1 : 0}`;
      if (specifierKeys.has(key)) return;
      specifierKeys.add(key);
      specifiers.push({ spec, typeOnly });
    };

    const addLocal = (
      localName: string,
      kind: OxcSymbolKind,
      span: Span,
      docAnchorStart = span.start,
    ): OxcSymbolDef => {
      const key = `${localName}::${span.start}`;
      const existing = locals.find(
        (item) => item.localName === localName && item.range.start.index === span.start,
      );
      if (existing) {
        if (!existing.docstring) {
          const docstring = findLeadingDocstring(commentInfos, source, docAnchorStart);
          if (docstring) existing.docstring = docstring;
        }
        return existing;
      }

      const range = spanToRange(span, lineStarts);
      const lineSpan =
        range.end.line >= range.start.line
          ? Math.max(1, range.end.line - range.start.line + 1)
          : undefined;
      const complexity =
        kind === "function" || kind === "class"
          ? estimateComplexity(source, range, languageId)
          : undefined;
      const symbol: OxcSymbolDef = {
        file,
        localName,
        kind,
        range,
        ...(lineSpan ? { lineSpan } : {}),
        ...(complexity !== undefined ? { complexity } : {}),
      };
      const docstring = findLeadingDocstring(commentInfos, source, docAnchorStart);
      if (docstring) {
        symbol.docstring = docstring;
      }
      locals.push(symbol);
      const group = localByName.get(localName);
      if (group) group.push(symbol);
      else localByName.set(localName, [symbol]);
      return symbol;
    };

    const getLocal = (name: string): OxcSymbolDef | undefined => {
      const matches = localByName.get(name);
      if (!matches || matches.length === 0) return undefined;
      return matches[matches.length - 1];
    };

    const addImport = (entry: OxcImportBinding) => {
      const key =
        entry.kind === "default"
          ? `default:${entry.local}:${entry.from}:${entry.typeOnly ? 1 : 0}:${entry.mechanism ?? ""}`
          : entry.kind === "named"
            ? `named:${entry.local}:${entry.imported}:${entry.from}:${entry.typeOnly ? 1 : 0}:${entry.mechanism ?? ""}`
            : `namespace:${entry.localNS}:${entry.from}:${entry.typeOnly ? 1 : 0}:${entry.mechanism ?? ""}`;
      if (importKeys.has(key)) return;
      importKeys.add(key);
      imports.push(entry);
      addSpecifier(entry.from, entry.typeOnly ?? false);
    };

    const addExport = (entry: OxcExportEntry) => {
      const key =
        entry.type === "local"
          ? `local:${entry.exportedAs}:${entry.target.localName}:${entry.target.range.start.index ?? 0}`
          : entry.type === "reexport"
            ? `reexport:${entry.exportedAs}:${entry.fromModule}:${entry.sourceSpecifier}:${entry.typeOnly ? 1 : 0}`
            : entry.type === "namespaceReexport"
              ? `ns:${entry.exportedAs}:${entry.fromModule}:${entry.typeOnly ? 1 : 0}`
              : `star:${entry.fromModule}:${entry.typeOnly ? 1 : 0}`;
      if (exportKeys.has(key)) return;
      exportKeys.add(key);
      exports.push(entry);
      if (entry.type !== "local") addSpecifier(entry.fromModule, entry.typeOnly ?? false);
    };

    const getPropertyName = (key: PropertyKey): string | undefined => {
      if (key.type === "Identifier") return key.name;
      if (key.type === "Literal" && typeof key.value === "string") return key.value;
      return undefined;
    };

    const getModuleExportName = (name: ModuleExportName): string | undefined => {
      if (name.type === "Identifier") return name.name;
      if (name.type === "Literal" && typeof name.value === "string") return name.value;
      return undefined;
    };

    const extractBindingIdentifiers = (pattern: BindingPattern): BindingIdentifier[] => {
      if (pattern.type === "Identifier") return [pattern];
      if (pattern.type === "AssignmentPattern") {
        return extractBindingIdentifiers(pattern.left);
      }
      if (pattern.type === "ArrayPattern") {
        const out: BindingIdentifier[] = [];
        for (const item of pattern.elements) {
          if (!item) continue;
          if (item.type === "RestElement") out.push(...extractBindingIdentifiers(item.argument));
          else out.push(...extractBindingIdentifiers(item));
        }
        return out;
      }
      if (pattern.type === "ObjectPattern") {
        const out: BindingIdentifier[] = [];
        for (const property of pattern.properties) {
          if (property.type === "RestElement") {
            out.push(...extractBindingIdentifiers(property.argument));
            continue;
          }
          out.push(...extractBindingIdentifiers(property.value));
        }
        return out;
      }
      return [];
    };

    const getRequireSpecifier = (call: CallExpression): string | undefined => {
      if (call.callee.type !== "Identifier" || call.callee.name !== "require") return undefined;
      const firstArg = call.arguments[0];
      if (!firstArg || firstArg.type !== "Literal" || typeof firstArg.value !== "string") {
        return undefined;
      }
      return firstArg.value;
    };

    const memberExpressionPath = (expr: MemberExpression): string[] | null => {
      const names: string[] = [];
      let current: Expression = expr;
      while (current.type === "MemberExpression") {
        if (current.computed) return null;
        if (current.property.type !== "Identifier") return null;
        names.unshift(current.property.name);
        current = current.object;
      }
      if (current.type !== "Identifier") return null;
      names.unshift(current.name);
      return names;
    };

    const exportLocalName = (exportedAs: string, localName: string) => {
      const local = getLocal(localName);
      if (!local) return;
      const target =
        exportedAs === "default"
          ? { ...local, kind: "default" as const }
          : local;
      addExport({ type: "local", exportedAs, target });
    };

    const createSyntheticFunctionLocal = (
      localName: string,
      span: Span,
      kind: OxcSymbolKind = "function",
    ): OxcSymbolDef => addLocal(localName, kind, span);

    const processImportDeclaration = (node: ImportDeclaration) => {
      const from = node.source.value;
      const declarationTypeOnly = node.importKind === "type";
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportDefaultSpecifier") {
          addImport({
            kind: "default",
            local: specifier.local.name,
            from,
            ...(declarationTypeOnly ? { typeOnly: true } : {}),
            mechanism: "es",
          });
          continue;
        }
        if (specifier.type === "ImportNamespaceSpecifier") {
          addImport({
            kind: "namespace",
            localNS: specifier.local.name,
            from,
            ...(declarationTypeOnly ? { typeOnly: true } : {}),
            mechanism: "es",
          });
          continue;
        }
        const imported = getModuleExportName(specifier.imported);
        if (!imported) continue;
        const typeOnly = declarationTypeOnly || specifier.importKind === "type";
        addImport({
          kind: "named",
          local: specifier.local.name,
          imported,
          from,
          ...(typeOnly ? { typeOnly: true } : {}),
          mechanism: "es",
        });
      }
      if (node.specifiers.length === 0) addSpecifier(from);
    };

    const processImportEquals = (node: TSImportEqualsDeclaration) => {
      if (node.moduleReference.type !== "TSExternalModuleReference") return;
      const ref = node.moduleReference.expression.value;
      addImport({ kind: "default", local: node.id.name, from: ref, mechanism: "cjs" });
    };

    const processExportNamedDeclaration = (node: ExportNamedDeclaration) => {
      const declarationTypeOnly = node.exportKind === "type";
      if (node.source) {
        const from = node.source.value;
        for (const specifier of node.specifiers) {
          const sourceSpecifier = getModuleExportName(specifier.local);
          const exportedAs = getModuleExportName(specifier.exported);
          if (!sourceSpecifier || !exportedAs) continue;
          const typeOnly = declarationTypeOnly || specifier.exportKind === "type";
          addExport({
            type: "reexport",
            exportedAs,
            fromModule: from,
            moduleSpecifier: from,
            sourceSpecifier,
            ...(typeOnly ? { typeOnly: true } : {}),
          });
        }
        if (node.specifiers.length === 0) addSpecifier(from, declarationTypeOnly);
        return;
      }

      if (node.declaration) {
        ensureExportDeclarationLocals(node);
        const declarationNames = extractDeclarationNames(node.declaration);
        for (const name of declarationNames) exportLocalName(name, name);
      }
      for (const specifier of node.specifiers) {
        const sourceSpecifier = getModuleExportName(specifier.local);
        const exportedAs = getModuleExportName(specifier.exported);
        if (!sourceSpecifier || !exportedAs) continue;
        exportLocalName(exportedAs, sourceSpecifier);
      }
    };

    const processExportAllDeclaration = (node: ExportAllDeclaration) => {
      const from = node.source.value;
      const typeOnly = node.exportKind === "type";
      const exportedAs = node.exported ? getModuleExportName(node.exported) : undefined;
      if (exportedAs) {
        addExport({
          type: "namespaceReexport",
          exportedAs,
          fromModule: from,
          moduleSpecifier: from,
          ...(typeOnly ? { typeOnly: true } : {}),
        });
        return;
      }
      addExport({
        type: "exportStar",
        fromModule: from,
        moduleSpecifier: from,
        sourceSpecifier: from,
        ...(typeOnly ? { typeOnly: true } : {}),
      });
    };

    const processExportDefaultDeclaration = (node: ExportDefaultDeclaration) => {
      const declaration = node.declaration;
      if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id) {
        ensureDefaultDeclarationLocal(node);
        exportLocalName("default", declaration.id.name);
        return;
      }
      if (declaration.type === "Identifier") {
        exportLocalName("default", declaration.name);
        return;
      }
      const synthetic = addLocal("__default_export__", "default", declaration);
      addExport({ type: "local", exportedAs: "default", target: synthetic });
    };

    const processTsExportAssignment = (node: TSExportAssignment) => {
      if (node.expression.type === "Identifier") {
        exportLocalName("default", node.expression.name);
      }
    };

    const ensureExportDeclarationLocals = (node: ExportNamedDeclaration) => {
      const declaration = node.declaration;
      if (!declaration) return;
      if (declaration.type === "FunctionDeclaration" && declaration.id) {
        addLocal(declaration.id.name, "function", declaration.id, node.start);
        return;
      }
      if (declaration.type === "ClassDeclaration" && declaration.id) {
        addLocal(declaration.id.name, "class", declaration.id, node.start);
        return;
      }
      if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          for (const binding of extractBindingIdentifiers(declarator.id)) {
            addLocal(binding.name, "variable", binding, node.start);
          }
        }
        return;
      }
      if (declaration.type === "TSInterfaceDeclaration") {
        addLocal(declaration.id.name, "interface", declaration.id, node.start);
        return;
      }
      if (declaration.type === "TSTypeAliasDeclaration") {
        addLocal(declaration.id.name, "type", declaration.id, node.start);
      }
    };

    const ensureDefaultDeclarationLocal = (node: ExportDefaultDeclaration) => {
      const declaration = node.declaration;
      if (declaration.type === "FunctionDeclaration" && declaration.id) {
        addLocal(declaration.id.name, "function", declaration.id, node.start);
        return;
      }
      if (declaration.type === "ClassDeclaration" && declaration.id) {
        addLocal(declaration.id.name, "class", declaration.id, node.start);
      }
    };

    const processAmbientModuleDeclaration = (
      node: TSModuleDeclaration | TSGlobalDeclaration,
    ) => {
      if (!node.declare || node.global) return;
      if (node.id.type !== "Literal" || typeof node.id.value !== "string") return;
      addSpecifier(node.id.value, true);
    };

    const visitor = new Visitor({
      FunctionDeclaration(node: Function) {
        if (node.id) addLocal(node.id.name, "function", node.id, findDocAnchorStart(node));
      },
      ClassDeclaration(node: Function | import("oxc-parser").Class) {
        if (node.type === "ClassDeclaration" && node.id) {
          addLocal(node.id.name, "class", node.id, findDocAnchorStart(node));
        }
      },
      VariableDeclarator(node: VariableDeclarator) {
        const from =
          node.init && node.init.type === "CallExpression"
            ? getRequireSpecifier(node.init)
            : undefined;
        if (from) {
          if (node.id.type === "Identifier") {
            addImport({ kind: "default", local: node.id.name, from, mechanism: "cjs" });
            return;
          }
          if (node.id.type === "ObjectPattern") {
            for (const property of node.id.properties) {
              if (property.type === "RestElement") continue;
              if (property.value.type !== "Identifier") continue;
              const imported = getPropertyName(property.key);
              if (!imported) continue;
              addImport({
                kind: "named",
                local: property.value.name,
                imported,
                from,
                mechanism: "cjs",
              });
            }
            return;
          }
        }

        for (const binding of extractBindingIdentifiers(node.id)) {
          addLocal(binding.name, "variable", binding, findDocAnchorStart(node));
        }
      },
      TSInterfaceDeclaration(node: TSInterfaceDeclaration) {
        addLocal(node.id.name, "interface", node.id, findDocAnchorStart(node));
      },
      TSTypeAliasDeclaration(node: TSTypeAliasDeclaration) {
        addLocal(node.id.name, "type", node.id, findDocAnchorStart(node));
      },
      ImportExpression(node: import("oxc-parser").ImportExpression) {
        if (node.source.type !== "Literal" || typeof node.source.value !== "string") return;
        addSpecifier(node.source.value);
      },
      AssignmentExpression(node: AssignmentExpression) {
        if (node.left.type !== "MemberExpression") return;
        const targetPath = memberExpressionPath(node.left);
        if (!targetPath) return;

        const exportName =
          targetPath[0] === "exports" && targetPath.length === 2
            ? targetPath[1]
            : targetPath[0] === "module" && targetPath[1] === "exports" && targetPath.length === 3
              ? targetPath[2]
              : undefined;

        if (exportName) {
          if (node.right.type === "Identifier") {
            exportLocalName(exportName, node.right.name);
            return;
          }
          if (
            node.right.type === "FunctionExpression" ||
            node.right.type === "ArrowFunctionExpression"
          ) {
            const synthetic = createSyntheticFunctionLocal(exportName, node.right);
            addExport({ type: "local", exportedAs: exportName, target: synthetic });
          }
          return;
        }

        const isModuleExportsObject =
          targetPath.length === 2 && targetPath[0] === "module" && targetPath[1] === "exports";
        if (!isModuleExportsObject || node.right.type !== "ObjectExpression") return;
        for (const property of node.right.properties) {
          if (property.type !== "Property") continue;
          const exportedAs = getPropertyName(property.key);
          if (!exportedAs) continue;
          if (property.shorthand && property.value.type === "Identifier") {
            exportLocalName(exportedAs, property.value.name);
            continue;
          }
          if (property.value.type === "Identifier") {
            exportLocalName(exportedAs, property.value.name);
            continue;
          }
          if (
            property.value.type === "FunctionExpression" ||
            property.value.type === "ArrowFunctionExpression"
          ) {
            const synthetic = createSyntheticFunctionLocal(exportedAs, property.value);
            addExport({ type: "local", exportedAs, target: synthetic });
          }
        }
      },
    });

    visitor.visit(result.program);

    for (const statement of result.program.body) {
      if (statement.type === "ImportDeclaration") {
        processImportDeclaration(statement);
        continue;
      }
      if (statement.type === "TSImportEqualsDeclaration") {
        processImportEquals(statement);
        continue;
      }
      if (statement.type === "ExportNamedDeclaration") {
        processExportNamedDeclaration(statement);
        continue;
      }
      if (statement.type === "ExportAllDeclaration") {
        processExportAllDeclaration(statement);
        continue;
      }
      if (statement.type === "ExportDefaultDeclaration") {
        processExportDefaultDeclaration(statement);
        continue;
      }
      if (statement.type === "TSExportAssignment") {
        processTsExportAssignment(statement);
        continue;
      }
      if (statement.type === "TSModuleDeclaration") {
        processAmbientModuleDeclaration(statement);
      }
    }

    return { imports, exports, locals, specifiers };
  } catch {
    return null;
  }
}

function getOxcLang(
  file: string,
  languageId: string,
): "js" | "jsx" | "ts" | "tsx" | "dts" {
  const lower = file.toLowerCase();
  if (lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts")) {
    return "dts";
  }
  if (languageId === "tsx") return "tsx";
  if (lower.endsWith(".jsx")) return "jsx";
  return languageId === "ts" ? "ts" : "js";
}

function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function positionForOffset(offset: number, lineStarts: number[]): Position {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = lineStarts[middle] ?? 0;
    if (value <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, high);
  const lineStart = lineStarts[lineIndex] ?? 0;
  return {
    line: lineIndex + 1,
    column: offset - lineStart + 1,
  };
}

function spanToRange(span: Span, lineStarts: number[]): Range {
  const start = positionForOffset(span.start, lineStarts);
  const end = positionForOffset(span.end, lineStarts);
  return {
    start: { ...start, index: span.start },
    end: { ...end, index: span.end },
  };
}

function buildCommentInfos(
  comments: Comment[],
  source: string,
  lineStarts: number[],
): CommentInfo[] {
  return comments
    .map((comment) => {
      const start = positionForOffset(comment.start, lineStarts);
      const end = positionForOffset(comment.end, lineStarts);
      const raw = source.slice(comment.start, comment.end);
      return {
        start: comment.start,
        end: comment.end,
        startLine: start.line,
        endLine: end.line,
        text: normalizeCommentText(raw),
      };
    })
    .sort((left, right) => left.start - right.start);
}

function normalizeCommentText(raw: string): string {
  const line = raw.startsWith("//") ? raw.replace(/^\s*\/\/\/?\s?/, "") : raw;
  const block = line.startsWith("/*")
    ? line.replace(/^\s*\/\*\*?/, "").replace(/\*\/\s*$/, "")
    : line;
  return block
    .split("\n")
    .map((entry) => entry.replace(/^\s*\*\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

function findLeadingDocstring(
  comments: CommentInfo[],
  source: string,
  nodeStart: number,
): string | undefined {
  if (comments.length === 0) return undefined;
  const parts: string[] = [];
  let currentStart = nodeStart;

  for (let index = comments.length - 1; index >= 0; index--) {
    const comment = comments[index];
    if (!comment || comment.end > currentStart) continue;
    const between = source.slice(comment.end, currentStart);
    if (/[^\s]/.test(between)) break;
    if (!isStandaloneComment(comment, source)) break;
    parts.unshift(comment.text);
    currentStart = comment.start;
    if (/\n\s*\n/.test(between)) break;
  }

  const joined = parts.join("\n").trim();
  return joined || undefined;
}

function isStandaloneComment(comment: CommentInfo, source: string): boolean {
  const lineStart = source.lastIndexOf("\n", comment.start - 1) + 1;
  const prefix = source.slice(lineStart, comment.start);
  return prefix.trim().length === 0;
}

function estimateComplexity(
  source: string,
  range: Range,
  languageId: string,
): number | undefined {
  const start = range.start.index;
  const end = range.end.index;
  if (start === undefined || end === undefined || end <= start) return undefined;
  const snippet = source.slice(start, end);
  if (!snippet.trim()) return undefined;
  const patterns = [/\bif\b/g, /\bfor\b/g, /\bwhile\b/g, /\bcase\b/g, /\bcatch\b/g, /\belse\s+if\b/g];
  if (languageId === "python") patterns.push(/\belif\b/g, /\bexcept\b/g);
  patterns.push(/&&/g, /\|\|/g, /\?\s*[^:]/g);
  let count = 0;
  for (const pattern of patterns) {
    count += snippet.match(pattern)?.length ?? 0;
  }
  return 1 + count;
}

function findDocAnchorStart(node: Node): number {
  let anchor = node.start;
  let current: Node | undefined = node;
  while (current?.parent) {
    const parent: Node = current.parent;
    if (
      parent.type === "ExportNamedDeclaration" ||
      parent.type === "ExportDefaultDeclaration" ||
      parent.type === "VariableDeclaration"
    ) {
      anchor = parent.start;
      current = parent;
      continue;
    }
    break;
  }
  return anchor;
}

function extractDeclarationNames(statement: Statement): string[] {
  if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
    return statement.id ? [statement.id.name] : [];
  }
  if (statement.type === "VariableDeclaration") {
    return statement.declarations.flatMap((declaration) =>
      extractPatternNames(declaration.id),
    );
  }
  if (statement.type === "TSInterfaceDeclaration" || statement.type === "TSTypeAliasDeclaration") {
    return [statement.id.name];
  }
  return [];
}

function extractPatternNames(pattern: BindingPattern): string[] {
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "AssignmentPattern") return extractPatternNames(pattern.left);
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((entry) => {
      if (!entry) return [];
      if (entry.type === "RestElement") return extractPatternNames(entry.argument);
      return extractPatternNames(entry);
    });
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) => {
      if (property.type === "RestElement") return extractPatternNames(property.argument);
      return extractPatternNames(property.value);
    });
  }
  return [];
}
