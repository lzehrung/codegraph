#!/usr/bin/env tsx
/**
 * dep-graph-and-symbols.ts
 *
 * Foundation for a multi-language repository navigator powered by Tree-sitter.
 * - Repo-wide module dependency graph (JS/TS marks type-only edges; Python resolves files incl. relative).
 * - Symbol index (locals + exports).
 * - Re-exports (incl. `export * from ...`) and TS `export =`.
 * - Go to definition (cross-file for TS/JS; intra-file for Python).
 * - Find references (project-wide).
 * - AST grep utility.
 *
 * Robust for monorepos:
 * - Per-file tsconfig discovery (nearest up the tree) for TS path alias resolution.
 * - Python `__all__` interpretation and `from pkg import *` expansion.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import Parser from "tree-sitter";
import tsGrammars from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";
import PythonLang from "tree-sitter-python";
import { createMatchPath } from "tsconfig-paths";

/* -------------------------------------------------------------------------- */
/* Language adapter interface                                                 */
/* -------------------------------------------------------------------------- */

export type IdentifierNodeType = string;

export type LanguageSupport = {
  id: string;
  matchExts: string[];
  language: (filename: string) => Parser.Language;
  nodeTypes: {
    identifier: IdentifierNodeType[];
    propertyIdentifier?: IdentifierNodeType[];
    shorthandPropertyIdentifier?: IdentifierNodeType[];
    memberExpression?: string;
  };
  queries: {
    imports: string; // captures @mod for edges; optionally @stmt for type-only tagging
    exports: string;
    locals: string;
    importBindings: string; // captures: @stmt, @from, @def, @iname, @alias, @ns, @star, etc.
  };
  classifyDefinition: (nameNode: Parser.SyntaxNode) => SymbolKind;
  isDeclarationName: (node: Parser.SyntaxNode) => boolean;
  createsBlockScope: (node: Parser.SyntaxNode) => boolean;
  createsFunctionScope: (node: Parser.SyntaxNode) => boolean;
  supportsCrossModuleSymbols: boolean;
};

/* -------------------------------------------------------------------------- */
/* JS/TS adapter                                                              */
/* -------------------------------------------------------------------------- */

const LangTS = (tsGrammars as any).typescript as Parser.Language;
const LangTSX = (tsGrammars as any).tsx as Parser.Language;
const LangJS = JavaScript as unknown as Parser.Language;

const TS_JS_SUPPORT: LanguageSupport = {
  id: "ts-js",
  matchExts: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
  language: (filename) => {
    const ext = path.extname(filename).toLowerCase();
    if (ext === ".ts" || ext === ".mts" || ext === ".cts") return LangTS;
    if (ext === ".tsx") return LangTSX;
    return LangJS;
  },
  nodeTypes: {
    identifier: ["identifier", "type_identifier"],
    propertyIdentifier: ["property_identifier"],
    shorthandPropertyIdentifier: ["shorthand_property_identifier"],
    memberExpression: "member_expression",
  },
  queries: {
    imports: `
      (import_statement) @stmt
      (import_statement (string) @mod)
      (import_statement (import_clause) (from_clause (string) @mod))
      (export_statement (from_clause (string) @mod)) @stmt
      (call_expression function: (identifier) @fn arguments: (arguments (string) @mod)) (#eq? @fn "require")
      (import_call_expression arguments: (arguments (string) @mod))
    `,
    exports: `
      (export_statement) @stmt
      (export_statement (function_declaration name: (identifier) @name))
      (export_statement (class_declaration name: (identifier) @name))
      (export_statement (lexical_declaration (variable_declarator name: (identifier) @name)))

      (export_clause (export_specifier name: (identifier) @src alias: (identifier)? @alias))
      (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier)? @alias)) (from_clause (string) @from))
      (export_statement (export_clause (asterisk)) (from_clause (string) @from))
      (export_statement (export_default_declaration (identifier) @default))

      (export_statement (export_default_declaration (function) @anon_default))
      (export_statement (export_default_declaration (class) @anon_default))
      (export_statement (export_assignment right: (identifier) @ts_export_assign))
    `,
    locals: `
      (function_declaration name: (identifier) @name)
      (class_declaration name: (identifier) @name)
      (lexical_declaration (variable_declarator name: (identifier) @name))
      (variable_declaration (variable_declarator name: (identifier) @name))
      (interface_declaration name: (type_identifier) @tname)
      (type_alias_declaration name: (type_identifier) @tname)
    `,
    importBindings: `
      (import_statement) @stmt
      (import_statement (import_clause (import_specifier name: (identifier) @def)) (from_clause (string) @from))
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname alias: (identifier)? @alias)+)) (from_clause (string) @from))
      (import_statement (import_clause (namespace_import (identifier) @ns)) (from_clause (string) @from))
      (import_equals_declaration) @stmt
      (import_equals_declaration name: (identifier) @def module: (call_expression (identifier) @req (arguments (string) @from))) (#eq? @req "require")
    `,
  },
  classifyDefinition: (n) => {
    const t = n.parent?.type;
    if (t === "function_declaration") return SymbolKind.Function;
    if (t === "class_declaration") return SymbolKind.Class;
    if (t === "interface_declaration") return SymbolKind.Interface;
    if (t === "type_alias_declaration") return SymbolKind.TypeAlias;
    return SymbolKind.Variable;
  },
  isDeclarationName: (node) => {
    const p = node.parent?.type;
    return (
      !!p &&
      [
        "function_declaration",
        "class_declaration",
        "variable_declarator",
        "interface_declaration",
        "type_alias_declaration",
        "import_specifier",
        "namespace_import",
        "import_clause",
        "import_equals_declaration",
      ].includes(p)
    );
  },
  createsBlockScope: (n) => n.type === "program" || n.type === "block",
  createsFunctionScope: (n) =>
    n.type === "function_declaration" ||
    n.type === "function" ||
    n.type === "function_expression" ||
    n.type === "arrow_function" ||
    n.type === "method_definition",
  supportsCrossModuleSymbols: true,
};

/* -------------------------------------------------------------------------- */
/* Python adapter (robust 80/20)                                              */
/* -------------------------------------------------------------------------- */

const PY_SUPPORT: LanguageSupport = {
  id: "python",
  matchExts: [".py"],
  language: () => PythonLang as unknown as Parser.Language,
  nodeTypes: {
    identifier: ["identifier"],
    propertyIdentifier: ["attribute"],
    memberExpression: "attribute",
  },
  queries: {
    // Import edges (also used for importBindings)
    imports: `
      (import_statement) @stmt
      (import_statement (import_list (aliased_import (dotted_name) @mod (identifier)? @alias)+))
      (import_statement (import_list (dotted_name) @mod))

      (import_from_statement) @stmt
      (import_from_statement module_name: (dotted_name) @mod)
      (import_from_statement module_name: (relative_import) @dots)

      (call
        function: (attribute object: (identifier) @obj attribute: (identifier) @attr)
        arguments: (argument_list (string) @mod))
      (#eq? @obj "importlib")
      (#eq? @attr "import_module")
    `,
    // __all__ = ["a","b"] — interpret as exports
    exports: `
      (assignment left: (identifier) @left right: (list (string)+ @all_item)) @stmt
    `,
    locals: `
      (function_definition name: (identifier) @name)
      (class_definition name: (identifier) @name)
      (assignment left: (identifier) @name)
    `,
    // Import bindings used to seed per-file scopes
    importBindings: `
      (import_statement) @stmt
      (import_statement (import_list (aliased_import (dotted_name) @iname (identifier)? @alias)+))
      (import_statement (import_list (dotted_name) @iname))

      (import_from_statement) @stmt
      (import_from_statement module_name: (dotted_name) @from (import_list (aliased_import (identifier) @iname (identifier)? @alias)+))
      (import_from_statement module_name: (dotted_name) @from (import_list (identifier) @iname))
      (import_from_statement module_name: (relative_import) @reldots (import_list (identifier) @iname))
      (import_from_statement module_name: (relative_import) @reldots (import_list (aliased_import (identifier) @iname (identifier)? @alias)+))
      (import_from_statement module_name: (dotted_name) @from (import_list (wildcard_import) @star))
      (import_from_statement module_name: (relative_import) @reldots (import_list (wildcard_import) @star))
    `,
  },
  classifyDefinition: (n) => {
    const t = n.parent?.type;
    if (t === "function_definition") return SymbolKind.Function;
    if (t === "class_definition") return SymbolKind.Class;
    return SymbolKind.Variable;
  },
  isDeclarationName: (node) => {
    const t = node.parent?.type;
    return (
      !!t &&
      [
        "function_definition",
        "class_definition",
        "assignment",
        "aliased_import",
      ].includes(t)
    );
  },
  createsBlockScope: (n) => n.type === "module" || n.type === "block",
  createsFunctionScope: (n) =>
    n.type === "function_definition" || n.type === "lambda",
  supportsCrossModuleSymbols: false, // we still build graph edges + import scopes
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const LANGUAGE_SUPPORTS: LanguageSupport[] = [TS_JS_SUPPORT, PY_SUPPORT];

/* -------------------------------------------------------------------------- */
/* Core types                                                                  */
/* -------------------------------------------------------------------------- */

export enum SymbolKind {
  Function = "function",
  Class = "class",
  Variable = "variable",
  Interface = "interface",
  TypeAlias = "type",
  Default = "default",
}

export type Pos = { line: number; column: number; index: number };
export type Range = { start: Pos; end: Pos };
export type FileId = string;

export type SymbolDef = {
  file: FileId;
  localName: string;
  kind: SymbolKind;
  range: Range;
};

export type ExportEntry =
  | { type: "local"; exportedAs: string; target: SymbolDef }
  | {
      type: "reexport";
      exportedAs: string;
      fromModule: string;
      sourceSpecifier: string;
      typeOnly?: boolean;
    }
  | {
      type: "exportStar";
      fromModule: string;
      sourceSpecifier: string;
      typeOnly?: boolean;
    };

export type ImportBinding =
  | {
      kind: "default";
      local: string;
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
    }
  | {
      kind: "named";
      local: string;
      imported: string;
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
    }
  | {
      kind: "namespace";
      localNS: string;
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
    }
  | {
      kind: "star";
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
    };

export type Edge = {
  from: FileId;
  to: FileId | { external: string };
  raw: string;
  typeOnly?: boolean;
};
 // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars -- Graph type is exported for external consumers without local references
export type Graph = { nodes: Set<FileId>; edges: Edge[] };

export type ModuleIndex = {
  file: FileId;
  exports: ExportEntry[];
  imports: ImportBinding[];
  locals: SymbolDef[];
};

export type ProjectIndex = {
  graph: Graph;
  modules: Map<FileId, ModuleIndex>;
  byFile: Map<FileId, ModuleIndex>;
  exportCache: Map<string, ResolvedExport | null>;
};
export type ResolvedExport = { kind: "resolved"; def: SymbolDef };

export type Reference = {
  file: FileId;
  range: Range;
  context?: string;
  via?: { import?: ImportBinding; namespaceMember?: string };
};

/* -------------------------------------------------------------------------- */
/* Utils & file discovery                                                     */
/* -------------------------------------------------------------------------- */

function supportForFile(filename: string): LanguageSupport {
  const ext = path.extname(filename).toLowerCase();
  return (
    LANGUAGE_SUPPORTS.find((s) => s.matchExts.includes(ext)) ?? TS_JS_SUPPORT
  );
}
function languageForFile(filename: string): Parser.Language {
  return supportForFile(filename).language(filename);
}

function sliceText(node: Parser.SyntaxNode, src: string) {
  return src.slice(node.startIndex, node.endIndex);
}
function unquote(s: string) {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith("`") && t.endsWith("`"))
    ? t.slice(1, -1)
    : t;
}
function toRange(node: Parser.SyntaxNode): Range {
  return {
    start: {
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      index: node.startIndex,
    },
    end: {
      line: node.endPosition.row + 1,
      column: node.endPosition.column + 1,
      index: node.endIndex,
    },
  };
}

export async function listProjectFiles(
  projectRoot: string,
  patterns = ["**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py}"]
) {
  return fg(patterns, {
    cwd: projectRoot,
    absolute: true,
    ignore: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/.venv/**",
      "**/__pycache__/**",
    ],
  });
}

/* ------------------------- Per-file tsconfig discovery --------------------- */

type MatchPathFn = ReturnType<typeof createMatchPath>;
const tsconfigCache = new Map<string, { matchPath?: MatchPathFn }>();

async function findNearestTsconfig(
  startFromFile: string
): Promise<string | null> {
  let dir = path.dirname(startFromFile);
  while (true) {
    const cand = path.join(dir, "tsconfig.json");
    try {
      await fsp.access(cand, fs.constants.R_OK);
      return cand;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function loadNearestTsconfigFor(
  file: string
): Promise<{ matchPath?: MatchPathFn }> {
  const dir = path.dirname(file);
  if (tsconfigCache.has(dir)) return tsconfigCache.get(dir)!;

  const cfgPath = await findNearestTsconfig(file);
  if (!cfgPath) {
    tsconfigCache.set(dir, {});
    return {};
  }

  try {
    const raw = await fsp.readFile(cfgPath, "utf8");
    const json = JSON.parse(raw);
    const baseUrl = path.resolve(
      path.dirname(cfgPath),
      json.compilerOptions?.baseUrl ?? "."
    );
    const paths = json.compilerOptions?.paths as
      | Record<string, string[]>
      | undefined;
    const matchPath = createMatchPath(baseUrl, paths ?? {}, [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
    ]);
    const val = { matchPath };
    tsconfigCache.set(dir, val);
    return val;
  } catch {
    const val = {};
    tsconfigCache.set(dir, val as any);
    return val as any;
  }
}

/* ---------------------- JS/TS & Python import resolution ------------------- */

async function resolveSpecifier(
  fromFile: string,
  spec: string,
  projectRoot: string,
  matchPath?: MatchPathFn
): Promise<FileId | { external: string }> {
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = spec.startsWith("/")
      ? path.join(projectRoot, spec)
      : path.resolve(path.dirname(fromFile), spec);
    const candidates: string[] = [base];
    const exts = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
    for (const e of exts) candidates.push(base + e);
    for (const e of exts) candidates.push(path.join(base, "index" + e));
    for (const c of candidates) {
      try {
        await fsp.access(c, fs.constants.R_OK);
        return path.resolve(c);
      } catch {}
    }
    return { external: spec };
  }
  if (matchPath) {
    const m = matchPath(spec, undefined, [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
    ]);
    if (m) return path.resolve(m);
  }
  return { external: spec };
}

/* --------------------------- Python module resolution ---------------------- */

async function findPythonPackageAnchor(startDir: string): Promise<string> {
  let dir = startDir;
  let topWithInit = startDir;
  while (true) {
    try {
      await fsp.access(path.join(dir, "__init__.py"), fs.constants.R_OK);
      topWithInit = dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return topWithInit;
}

async function resolvePythonModule(
  projectRoot: string,
  fromFile: string,
  moduleName: string | null,
  relativeDots: number
): Promise<FileId | { external: string }> {
  const fromDir = path.dirname(fromFile);
  const anchor = await findPythonPackageAnchor(fromDir);

  let baseDir = anchor;
  for (let i = 0; i < relativeDots; i++) baseDir = path.dirname(baseDir);

  const parts = (moduleName ? moduleName.split(".") : []).filter(Boolean);
  const relPath = parts.length ? path.join(...parts) : "";
  const candidates: string[] = [];
  if (relPath) {
    candidates.push(path.join(baseDir, relPath + ".py"));
    candidates.push(path.join(baseDir, relPath, "__init__.py"));
  } else {
    candidates.push(path.join(baseDir, "__init__.py"));
  }
  for (const c of candidates) {
    try {
      await fsp.access(c, fs.constants.R_OK);
      return path.resolve(c);
    } catch {}
  }

  if (moduleName) {
    const abs = path.join(projectRoot, ...moduleName.split("."));
    for (const c of [abs + ".py", path.join(abs, "__init__.py")]) {
      try {
        await fsp.access(c, fs.constants.R_OK);
        return path.resolve(c);
      } catch {}
    }
  }
  return { external: ".".repeat(relativeDots) + (moduleName ?? "") };
}

/* -------------------------------------------------------------------------- */
/* Collect module specifiers (for graph edges)                                 */
/* -------------------------------------------------------------------------- */

export function collectModuleSpecifiersFromSource(
  support: LanguageSupport,
  lang: Parser.Language,
  source: string
): { spec: string; typeOnly?: boolean }[] {
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  const q = new Parser.Query(lang, support.queries.imports);
  const c = new Parser.QueryCursor();
  const out: { spec: string; typeOnly?: boolean }[] = [];
  for (const m of c.matches(q, tree.rootNode)) {
    const caps = Object.fromEntries(
      m.captures.map((x) => [x.name, x] as const)
    );
    const modNodes = m.captures.filter((x) => x.name === "mod");
    const stmtText = caps["stmt"] ? sliceText(caps["stmt"].node, source) : "";
    const typeOnly = /^\s*(import|export)\s+type\b/.test(stmtText);
    for (const cap of modNodes)
      out.push({ spec: unquote(sliceText(cap.node, source)), typeOnly });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Module indexing (locals/exports/imports)                                   */
/* -------------------------------------------------------------------------- */

export function collectLocalsAndExportsFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  lang: Parser.Language
): ModuleIndex {
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);

  const locals: SymbolDef[] = [];
  {
    const q = new Parser.Query(lang, support.queries.locals);
    const c = new Parser.QueryCursor();
    for (const m of c.matches(q, tree.rootNode))
      for (const cap of m.captures) {
        if (cap.name === "name" || cap.name === "tname") {
          locals.push({
            file,
            localName: sliceText(cap.node, source),
            kind: support.classifyDefinition(cap.node),
            range: toRange(cap.node),
          });
        }
      }
  }

  const exports: ExportEntry[] = [];
  if (support.queries.exports.trim()) {
    const q = new Parser.Query(lang, support.queries.exports);
    const c = new Parser.QueryCursor();
    for (const m of c.matches(q, tree.rootNode)) {
      const map = Object.fromEntries(
        m.captures.map((x) => [x.name, x] as const)
      );
      const stmtText = map["stmt"] ? sliceText(map["stmt"].node, source) : "";
      const isTypeOnly = /^\s*export\s+type\b/.test(stmtText);

      // Python __all__
      if (
        support.id === "python" &&
        map["left"] &&
        sliceText(map["left"].node, source) === "__all__"
      ) {
        const items = m.captures.filter((c) => c.name === "all_item");
        for (const it of items) {
          const name = unquote(sliceText(it.node, source));
          const local = locals.find((d) => d.localName === name);
          if (local)
            exports.push({ type: "local", exportedAs: name, target: local });
        }
        continue;
      }

      // JS/TS
      if (map["from"]) {
        const from = unquote(sliceText(map["from"].node, source));
        if (map["src"]) {
          const srcName = sliceText(map["src"].node, source);
          const alias = map["alias"]
            ? sliceText(map["alias"].node, source)
            : srcName;
          exports.push({
            type: "reexport",
            exportedAs: alias,
            fromModule: from,
            sourceSpecifier: from,
            typeOnly: isTypeOnly,
          });
        } else {
          exports.push({
            type: "exportStar",
            fromModule: from,
            sourceSpecifier: from,
            typeOnly: isTypeOnly,
          });
        }
        continue;
      }
      if (map["default"]) {
        const nameText = sliceText(map["default"].node, source);
        const local = locals.find((d) => d.localName === nameText);
        if (local)
          exports.push({
            type: "local",
            exportedAs: "default",
            target: { ...local, kind: SymbolKind.Default },
          });
        continue;
      }
      if (map["anon_default"]) {
        const sym: SymbolDef = {
          file,
          localName: "__default_export__",
          kind: SymbolKind.Default,
          range: toRange(map["anon_default"].node),
        };
        locals.push(sym);
        exports.push({ type: "local", exportedAs: "default", target: sym });
        continue;
      }
      if (map["ts_export_assign"]) {
        const ident = sliceText(map["ts_export_assign"].node, source);
        const local = locals.find((d) => d.localName === ident);
        if (local)
          exports.push({
            type: "local",
            exportedAs: "default",
            target: { ...local, kind: SymbolKind.Default },
          });
        continue;
      }
      if (map["name"]) {
        const nameText = sliceText(map["name"].node, source);
        const local = locals.find((d) => d.localName === nameText);
        if (local)
          exports.push({ type: "local", exportedAs: nameText, target: local });
        continue;
      }
      if (map["src"]) {
        const srcName = sliceText(map["src"].node, source);
        const alias = map["alias"]
          ? sliceText(map["alias"].node, source)
          : srcName;
        const local = locals.find((d) => d.localName === srcName);
        if (local)
          exports.push({ type: "local", exportedAs: alias, target: local });
      }
    }
  }

  return { file, exports, imports: [], locals };
}

async function collectImportsForFile(
  file: string,
  projectRoot: string
): Promise<ImportBinding[]> {
  const sup = supportForFile(file);
  const lang = languageForFile(file);
  const source = await fsp.readFile(file, "utf8");
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  const q = new Parser.Query(lang, sup.queries.importBindings);
  const c = new Parser.QueryCursor();
  const imports: ImportBinding[] = [];
  const tsCfg = sup.id === "ts-js" ? await loadNearestTsconfigFor(file) : {};

  for (const m of c.matches(q, tree.rootNode)) {
    const caps = Object.fromEntries(
      m.captures.map((x) => [x.name, x] as const)
    );
    const stmtText = caps["stmt"] ? sliceText(caps["stmt"].node, source) : "";
    const typeOnly = sup.id === "ts-js" && /^\s*import\s+type\b/.test(stmtText);
    const from = caps["from"]
      ? unquote(sliceText(caps["from"].node, source))
      : undefined;

    if (sup.id === "python") {
      // from ... import ...
      if (caps["from"] || caps["reldots"]) {
        let relDots = 0;
        if (caps["reldots"])
          relDots = sliceText(caps["reldots"].node, source).length;
        const moduleName = caps["from"]
          ? sliceText(caps["from"].node, source)
          : null;
        const resolved = await resolvePythonModule(
          projectRoot,
          file,
          moduleName,
          relDots
        );

        if (m.captures.some((c) => c.name === "star")) {
          imports.push({
            kind: "star",
            from: moduleName ?? ".".repeat(relDots),
            resolved,
          });
          continue;
        }

        const inames = m.captures.filter((c) => c.name === "iname");
        const aliases = m.captures.filter((c) => c.name === "alias");
        for (let i = 0; i < inames.length; i++) {
          const imported = sliceText(inames[i].node, source);
          const alias = aliases[i]
            ? sliceText(aliases[i].node, source)
            : imported;
          imports.push({
            kind: "named",
            local: alias,
            imported,
            from: moduleName ?? ".".repeat(relDots),
            resolved,
          });
        }
        continue;
      }
      // import package[.sub] [as alias]
      if (m.captures.some((c) => c.name === "iname")) {
        const inames = m.captures.filter((c) => c.name === "iname");
        const aliases = m.captures.filter((c) => c.name === "alias");
        for (let i = 0; i < inames.length; i++) {
          const dotted = sliceText(inames[i].node, source);
          const baseName = dotted.split(".")[0];
          const local = aliases[i]
            ? sliceText(aliases[i].node, source)
            : baseName;
          const resolved = await resolvePythonModule(
            projectRoot,
            file,
            dotted,
            0
          );
          imports.push({ kind: "default", local, from: dotted, resolved });
        }
        continue;
      }
      continue;
    }

    // TS/JS
    if (caps["def"] && caps["req"]) {
      const resolved = await resolveSpecifier(
        file,
        from!,
        projectRoot,
        tsCfg.matchPath
      );
      imports.push({
        kind: "default",
        local: sliceText(caps["def"].node, source),
        from: from!,
        resolved,
        typeOnly,
      });
      continue;
    }
    if (!from) continue;
    const resolved = await resolveSpecifier(
      file,
      from,
      projectRoot,
      tsCfg.matchPath
    );
    if (caps["def"])
      imports.push({
        kind: "default",
        local: sliceText(caps["def"].node, source),
        from,
        resolved,
        typeOnly,
      });
    if (caps["ns"])
      imports.push({
        kind: "namespace",
        localNS: sliceText(caps["ns"].node, source),
        from,
        resolved,
        typeOnly,
      });
    const inames = m.captures.filter((c) => c.name === "iname");
    const aliases = m.captures.filter((c) => c.name === "alias");
    for (let i = 0; i < inames.length; i++) {
      const imported = sliceText(inames[i].node, source);
      const alias = aliases[i] ? sliceText(aliases[i].node, source) : imported;
      imports.push({
        kind: "named",
        local: alias,
        imported,
        from,
        resolved,
        typeOnly,
      });
    }
  }
  return imports;
}

/* -------------------------------------------------------------------------- */
/* Build project index + graph                                                */
/* -------------------------------------------------------------------------- */

async function collectGraph(
  projectRoot: string,
  files: string[]
): Promise<Graph> {
  const graph: Graph = { nodes: new Set(files), edges: [] };
  for (const file of files) {
    const sup = supportForFile(file);
    const lang = languageForFile(file);
    const src = await fsp.readFile(file, "utf8");
    const specs = collectModuleSpecifiersFromSource(sup, lang, src);
    const { matchPath } =
      sup.id === "ts-js" ? await loadNearestTsconfigFor(file) : {};
    for (const { spec, typeOnly } of specs) {
      let to: FileId | { external: string };
      if (sup.id === "python") {
        // best effort: try Python resolution for path-like/absolute; otherwise external
        const res = await resolvePythonModule(
          projectRoot,
          file,
          spec.includes(".") || !spec.startsWith(".") ? spec : null,
          spec.startsWith(".") ? spec.match(/^\.+/)?.[0].length ?? 0 : 0
        );
        to = res;
      } else {
        to = await resolveSpecifier(file, spec, projectRoot, matchPath);
      }
      graph.edges.push({ from: file, to, raw: spec, typeOnly });
    }
  }
  return graph;
}

export async function buildProjectIndex(
  projectRoot: string
): Promise<ProjectIndex> {
  const files = await listProjectFiles(projectRoot);
  const modules = new Map<FileId, ModuleIndex>();

  // First pass: per-file locals/exports and imports
  for (const f of files) {
    const sup = supportForFile(f);
    const lang = languageForFile(f);
    const src = await fsp.readFile(f, "utf8");
    const mod = collectLocalsAndExportsFromSource(f, src, sup, lang);
    mod.imports = await collectImportsForFile(f, projectRoot);

    // Resolve JS/TS re-exports to files (nearest tsconfig)
    if (sup.supportsCrossModuleSymbols) {
      const { matchPath } = await loadNearestTsconfigFor(f);
      for (const e of mod.exports)
        if (e.type !== "local") {
          if (e.fromModule.startsWith(".")) {
            const resolved = await resolveSpecifier(
              f,
              e.fromModule,
              projectRoot,
              matchPath
            );
            if (typeof resolved === "string") e.fromModule = resolved;
          }
        }
    }
    modules.set(f, mod);
  }

  // Expand Python `from x import *` using __all__ or public locals
  for (const [file, m] of modules) {
    for (const imp of [...m.imports]) {
      if (imp.kind === "star" && typeof imp.resolved === "string") {
        const target = modules.get(imp.resolved);
        if (target) {
          let exported: string[] = [];
          const viaAll = target.exports.filter((e) => e.type === "local");
          if (viaAll.length) exported = viaAll.map((e: any) => e.exportedAs);
          else
            exported = target.locals
              .map((l) => l.localName)
              .filter((n) => !n.startsWith("_"));
          for (const name of exported) {
            m.imports.push({
              kind: "named",
              local: name,
              imported: name,
              from: imp.from,
              resolved: imp.resolved,
            });
          }
        }
      }
    }
  }

  const graph = await collectGraph(projectRoot, files);
  return { graph, modules, byFile: modules, exportCache: new Map() };
}

/* -------------------------------------------------------------------------- */
/* Cross-file export resolution (JS/TS)                                       */
/* -------------------------------------------------------------------------- */

function cacheKey(file: FileId, name: string) {
  return `${file}::${name}`;
}

export function resolveExport(
  index: ProjectIndex,
  file: FileId,
  exportedName: string
): ResolvedExport | null {
  const mod = index.byFile.get(file);
  if (!mod) return null;
  const key = cacheKey(file, exportedName);
  if (index.exportCache.has(key)) return index.exportCache.get(key)!;

  for (const e of mod.exports)
    if (e.type === "local" && e.exportedAs === exportedName) {
      const res: ResolvedExport = { kind: "resolved", def: e.target };
      index.exportCache.set(key, res);
      return res;
    }
  for (const e of mod.exports)
    if (
      e.type === "reexport" &&
      e.exportedAs === exportedName &&
      typeof e.fromModule === "string"
    ) {
      const down =
        resolveExport(index, e.fromModule, exportedName) ||
        resolveExport(index, e.fromModule, e.exportedAs);
      if (down) {
        index.exportCache.set(key, down);
        return down;
      }
    }
  for (const e of mod.exports)
    if (e.type === "exportStar" && typeof e.fromModule === "string") {
      const down = resolveExport(index, e.fromModule, exportedName);
      if (down) {
        index.exportCache.set(key, down);
        return down;
      }
    }
  index.exportCache.set(key, null);
  return null;
}

/* -------------------------------------------------------------------------- */
/* Go To Definition                                                           */
/* -------------------------------------------------------------------------- */

export type GoToRequest = { file: FileId; line: number; column: number };
export type GoToResult =
  | {
      status: "ok";
      definition: SymbolDef;
      via?: { importedFrom?: string; exportedName?: string };
    }
  | { status: "not_found"; reason: string };

export async function goToDefinition(
  index: ProjectIndex,
  req: GoToRequest
): Promise<GoToResult> {
  const { file, line, column } = req;
  const mod = index.byFile.get(file);
  if (!mod) return { status: "not_found", reason: "File not indexed" };

  const lang = languageForFile(file);
  const sup = supportForFile(file);
  const parser = new Parser();
  parser.setLanguage(lang);
  const source = await fsp.readFile(file, "utf8");
  const tree = parser.parse(source);

  const pos = { row: Math.max(0, line - 1), column: Math.max(0, column - 1) };
  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition(
    pos,
    pos
  );
  while (node && (node.type === "," || node.type === ".")) node = node.parent;
  if (!node) return { status: "not_found", reason: "No node at position" };

  const isId = sup.nodeTypes.identifier.includes(node.type);
  const name = isId ? sliceText(node, source) : null;

  if (name) {
    const local = mod.locals.find((d) => d.localName === name);
    if (local) return { status: "ok", definition: local };

    if (sup.supportsCrossModuleSymbols) {
      for (const imp of mod.imports) {
        if (imp.kind === "default" && imp.local === name) {
          const target = resolveImported(index, imp, "default");
          if (target)
            return {
              status: "ok",
              definition: target,
              via: {
                importedFrom: toModuleRef(imp.resolved),
                exportedName: "default",
              },
            };
        } else if (imp.kind === "named" && imp.local === name) {
          const target = resolveImported(index, imp, imp.imported);
          if (target)
            return {
              status: "ok",
              definition: target,
              via: {
                importedFrom: toModuleRef(imp.resolved),
                exportedName: imp.imported,
              },
            };
        }
      }
    }
  }

  // namespace member (JS/TS): ns.member
  if (
    sup.supportsCrossModuleSymbols &&
    node.type ===
      (sup.nodeTypes.propertyIdentifier?.[0] ?? "property_identifier") &&
    node.parent &&
    node.parent.type === (sup.nodeTypes.memberExpression ?? "member_expression")
  ) {
    const obj = node.parent.child(0);
    const prop = node;
    if (obj && prop && obj.type === "identifier") {
      const nsName = sliceText(obj, source);
      const member = sliceText(prop, source);
      const nsImport = mod.imports.find(
        (i) => i.kind === "namespace" && i.localNS === nsName
      );
      if (nsImport) {
        const resolved = resolveImported(index, nsImport, member);
        if (resolved)
          return {
            status: "ok",
            definition: resolved,
            via: {
              importedFrom: toModuleRef(nsImport.resolved),
              exportedName: member,
            },
          };
      }
    }
  }

  return {
    status: "not_found",
    reason: "No matching local or imported definition",
  };
}

function toModuleRef(resolved?: FileId | { external: string }) {
  return !resolved
    ? undefined
    : typeof resolved === "string"
    ? resolved
    : resolved.external;
}
function resolveImported(
  index: ProjectIndex,
  imp: ImportBinding,
  exportedName: string
): SymbolDef | null {
  const targetFile =
    typeof imp.resolved === "string" ? imp.resolved : undefined;
  if (!targetFile) return null;
  const hit = resolveExport(index, targetFile, exportedName);
  return hit?.def ?? null;
}

/* -------------------------------------------------------------------------- */
/* Scope & References                                                         */
/* -------------------------------------------------------------------------- */

export type BindingKind =
  | "local"
  | "param"
  | "function"
  | "class"
  | "type"
  | "importDefault"
  | "importNamed"
  | "namespace";
export type Binding = {
  name: string;
  kind: BindingKind;
  def?: Range;
  occurrences: Range[];
  import?: ImportBinding;
};
export type ScopeIndex = { bindings: Map<string, Binding[]>; all: Binding[] };

export function buildScopeIndexFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  lang: Parser.Language,
  imports: ImportBinding[] = []
): ScopeIndex {
  type Scope = {
    kind: "module" | "function" | "block";
    map: Map<string, Binding>;
  };
  const rootScope: Scope = { kind: "module", map: new Map() };
  const stack: Scope[] = [rootScope];

  // Seed imports in module scope
  for (const imp of imports) {
    if (imp.kind === "default")
      rootScope.map.set(imp.local, {
        name: imp.local,
        kind: "importDefault",
        occurrences: [],
        import: imp,
      });
    if (imp.kind === "named")
      rootScope.map.set(imp.local, {
        name: imp.local,
        kind: "importNamed",
        occurrences: [],
        import: imp,
      });
    if (imp.kind === "namespace")
      rootScope.map.set(imp.localNS, {
        name: imp.localNS,
        kind: "namespace",
        occurrences: [],
        import: imp,
      });
  }

  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);

  const idSet = new Set(support.nodeTypes.identifier);

  const addDecl = (nameNode: Parser.SyntaxNode, kind: BindingKind) => {
    const name = sliceText(nameNode, source);
    let target = stack[stack.length - 1];
    if (kind === "function" || kind === "class") {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind !== "block") {
          target = stack[i];
          break;
        }
      }
    }
    const b: Binding = { name, kind, def: toRange(nameNode), occurrences: [] };
    target.map.set(name, b);
  };

  const lookup = (name: string): Binding | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const hit = stack[i].map.get(name);
      if (hit) return hit;
    }
    return rootScope.map.get(name);
  };

  const walk = (node: Parser.SyntaxNode) => {
    if (support.createsFunctionScope(node))
      stack.push({ kind: "function", map: new Map() });
    else if (support.createsBlockScope(node)) {
      if (node.type !== "program" && node.type !== "module")
        stack.push({ kind: "block", map: new Map() });
    }

    // declarations (JS/TS + Python 80/20)
    if (
      node.type === "function_declaration" ||
      node.type === "function_definition"
    ) {
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "function");
      const params = node.childForFieldName("parameters");
      if (params) {
        const q: Parser.SyntaxNode[] = [params];
        while (q.length) {
          const n = q.pop()!;
          if (n.type === "identifier") addDecl(n, "param");
          for (const ch of n.namedChildren) q.push(ch);
        }
      }
    }
    if (node.type === "class_declaration" || node.type === "class_definition") {
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "class");
    }
    if (
      node.type === "variable_declaration" ||
      node.type === "lexical_declaration" ||
      node.type === "assignment"
    ) {
      for (const ch of node.namedChildren) {
        if (ch.type === "variable_declarator") {
          const nm = ch.childForFieldName("name");
          if (nm) addDecl(nm, "local");
        } else if (ch.type === "identifier" && node.type === "assignment") {
          addDecl(ch, "local");
        }
      }
    }
    if (
      node.type === "interface_declaration" ||
      node.type === "type_alias_declaration"
    ) {
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "type");
    }

    // references
    if (idSet.has(node.type) && !support.isDeclarationName(node)) {
      const b = lookup(sliceText(node, source));
      if (b) b.occurrences.push(toRange(node));
    }

    for (const ch of node.namedChildren) walk(ch);

    if (
      support.createsFunctionScope(node) ||
      (support.createsBlockScope(node) &&
        node.type !== "program" &&
        node.type !== "module")
    )
      stack.pop();
  };

  walk(tree.rootNode);

  // flatten
  const bindings = new Map<string, Binding[]>();
  const all: Binding[] = [];
  const flush = (scope: Scope) => {
    for (const b of scope.map.values()) {
      if (!bindings.has(b.name)) bindings.set(b.name, []);
      bindings.get(b.name)!.push(b);
      all.push(b);
    }
  };
  for (const s of stack) flush(s);
  flush(rootScope);
  return { bindings, all };
}

/* -------------------------------------------------------------------------- */
/* Find references                                                            */
/* -------------------------------------------------------------------------- */

export type FindRefsRequest =
  | { file: FileId; line: number; column: number }
  | { def: SymbolDef };
export type FindRefsResult =
  | { status: "ok"; definition: SymbolDef; references: Reference[] }
  | { status: "not_found"; reason: string };

function sameDef(a: SymbolDef, b: SymbolDef) {
  return (
    a.file === b.file &&
    a.localName === b.localName &&
    a.range.start.index === b.range.start.index
  );
}

export async function findReferences(
  index: ProjectIndex,
  req: FindRefsRequest
): Promise<FindRefsResult> {
  let def: SymbolDef | null = null;
  if ("def" in req) def = req.def;
  else {
    const got = await goToDefinition(index, req);
    if (got.status === "ok") def = got.definition;
  }
  if (!def)
    return { status: "not_found", reason: "Could not resolve definition" };

  const definitionFile = def.file;
  const sup = supportForFile(definitionFile);
  const lang = languageForFile(definitionFile);
  const src = await fsp.readFile(definitionFile, "utf8");
  const scope = buildScopeIndexFromSource(
    definitionFile,
    src,
    sup,
    lang,
    index.byFile.get(definitionFile)?.imports
  );

  const refs: Reference[] = [];

  // local occurrences
  const localBindings = scope.bindings.get(def.localName) ?? [];
  const localBinding = localBindings.find(
    (b) => b.def && b.def.start.index === def!.range.start.index
  );
  if (localBinding)
    for (const occ of localBinding.occurrences)
      refs.push({ file: definitionFile, range: occ });

  // exported names that refer to this def
  const exportedNames: string[] = [];
  const mod = index.byFile.get(definitionFile);
  if (mod)
    for (const e of mod.exports)
      if (e.type === "local" && sameDef(e.target, def))
        exportedNames.push(e.exportedAs);
  if (!exportedNames.length) exportedNames.push(def.localName);

  // other files
  for (const [f, m] of index.byFile) {
    if (f === definitionFile) continue;

    let sc: ScopeIndex | null = null;
    const ensure = async () => {
      if (!sc) {
        const s = await fsp.readFile(f, "utf8");
        sc = buildScopeIndexFromSource(
          f,
          s,
          supportForFile(f),
          languageForFile(f),
          m.imports
        );
      }
      return sc;
    };

    for (const imp of m.imports) {
      const targetFile =
        typeof imp.resolved === "string" ? imp.resolved : undefined;
      if (!targetFile) continue;
      for (const name of exportedNames) {
        const exported =
          imp.kind === "named"
            ? imp.imported
            : imp.kind === "default"
            ? "default"
            : name;
        const hit = resolveExport(index, targetFile, exported);
        if (!hit || !sameDef(hit.def, def)) continue;

        const scopeIdx = await ensure();
        if (imp.kind === "named" || imp.kind === "default") {
          const localName = imp.kind === "default" ? imp.local : imp.local;
          const binds = scopeIdx.bindings.get(localName) ?? [];
          for (const b of binds)
            for (const occ of b.occurrences)
              refs.push({ file: f, range: occ, via: { import: imp } });
        } else if (imp.kind === "namespace") {
          const nsName = imp.localNS;
          const member = name;
          const ranges = await collectNamespaceMemberRefs(f, nsName, member);
          for (const r of ranges)
            refs.push({
              file: f,
              range: r,
              via: { import: imp, namespaceMember: member },
            });
        }
        // Python star imports are expanded into named during indexing
      }
    }
  }

  refs.sort((a, b) =>
    a.file === b.file
      ? a.range.start.index - b.range.start.index
      : a.file.localeCompare(b.file)
  );
  return { status: "ok", definition: def, references: refs };
}

async function collectNamespaceMemberRefs(
  file: string,
  nsName: string,
  member: string
): Promise<Range[]> {
  const lang = languageForFile(file);
  const parser = new Parser();
  parser.setLanguage(lang);
  const src = await fsp.readFile(file, "utf8");
  const tree = parser.parse(src);
  const out: Range[] = [];
  const walk = (n: Parser.SyntaxNode) => {
    if (n.type === "member_expression") {
      const obj = n.child(0);
      const prop = n.child(2);
      if (
        obj &&
        prop &&
        obj.type === "identifier" &&
        sliceText(obj, src) === nsName &&
        (prop.type === "property_identifier" || prop.type === "identifier") &&
        sliceText(prop, src) === member
      ) {
        out.push(toRange(prop));
      }
    }
    for (const ch of n.namedChildren) walk(ch);
  };
  walk(tree.rootNode);
  return out;
}

/* -------------------------------------------------------------------------- */
/* AST Grep                                                                   */
/* -------------------------------------------------------------------------- */

export async function astGrep(
  projectRoot: string,
  querySource: string,
  patterns = ["**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py}"]
) {
  const files = await listProjectFiles(projectRoot, patterns);
  for (const file of files) {
    const lang = languageForFile(file);
    const parser = new Parser();
    parser.setLanguage(lang);
    const src = await fsp.readFile(file, "utf8");
    const tree = parser.parse(src);
    const query = new Parser.Query(lang, querySource);
    const cursor = new Parser.QueryCursor();
    for (const m of cursor.matches(query, tree.rootNode)) {
      for (const cap of m.captures) {
        const p = cap.node.startPosition;
        const line = p.row + 1;
        const col = p.column + 1;
        const snippet = sliceText(cap.node, src).replaceAll("\n", " ");
        writeStdoutLine(
          `${path.relative(projectRoot, file)}:${line}:${col}: ${
            cap.name
          }: ${snippet}`
        );
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

function toJSON(obj: any) {
  return JSON.stringify(obj, null, 2);
}

function writeStdoutLine(message: string) {
  process.stdout.write(`${message}\n`);
}

function writeJSONLine(value: unknown) {
  writeStdoutLine(toJSON(value));
}

function writeStderrLine(message: string) {
  process.stderr.write(`${message}\n`);
}

function writeError(error: unknown) {
  if (error instanceof Error) {
    const output = error.stack ?? error.message;
    writeStderrLine(output);
    return;
  }
  writeStderrLine(String(error));
}

async function main() {
  const [cmd = "graph", root = process.cwd(), ...rest] = process.argv.slice(2);

  if (cmd === "graph") {
    const files = await listProjectFiles(root);
    const graph = await collectGraph(root, files);
    writeJSONLine({ nodes: [...graph.nodes], edges: graph.edges });
    return;
  }

  if (cmd === "index") {
    const index = await buildProjectIndex(root);
    writeJSONLine({
      files: [...index.byFile.keys()].length,
      edges: index.graph.edges.length,
    });
    return;
  }

  if (cmd === "goto") {
    const args = Object.fromEntries(
      rest.reduce<[string, string][]>((acc, cur, i, arr) => {
        if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]] as any);
        return acc;
      }, [])
    );
    const file = path.isAbsolute(args.file)
      ? args.file
      : path.resolve(root, args.file);
    const line = Number(args.line);
    const column = Number(args.col ?? args.column);
    const index = await buildProjectIndex(root);
    const res = await goToDefinition(index, { file, line, column });
    writeJSONLine(res);
    return;
  }

  if (cmd === "refs") {
    const args = Object.fromEntries(
      rest.reduce<[string, string][]>((acc, cur, i, arr) => {
        if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]] as any);
        return acc;
      }, [])
    );
    const file = path.isAbsolute(args.file)
      ? args.file
      : path.resolve(root, args.file);
    const line = Number(args.line);
    const column = Number(args.col ?? args.column);
    const pretty = rest.includes("--pretty");
    const index = await buildProjectIndex(root);
    const res = await findReferences(index, { file, line, column });
    if (!pretty) {
      writeJSONLine(res);
      return;
    }
    if (res.status === "ok") {
      for (const r of res.references) {
        const rel = path.relative(root, r.file);
        const { line, column } = r.range.start;
        writeStdoutLine(`${rel}:${line}:${column}`);
      }
    } else {
      writeStdoutLine(`not_found: ${res.reason}`);
    }
    return;
  }

  if (cmd === "grep") {
    const qIdx = rest.indexOf("--query");
    if (qIdx === -1 || !rest[qIdx + 1]) {
      writeStderrLine("Usage: grep <root> --query '<treesitter query>'");
      process.exit(2);
    }
    const querySource = rest[qIdx + 1];
    await astGrep(root, querySource);
    return;
  }

  writeStderrLine(`Unknown command: ${cmd}`);
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    writeError(e);
    process.exit(1);
  });
}
