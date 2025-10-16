#!/usr/bin/env tsx
/**
 * dep-graph-and-symbols.ts
 *
 * Foundation for a multi-language repository navigator powered by Tree-sitter.
 * - Repo-wide module dependency graph (JS/TS mark type-only edges; Python resolves packages and relative modules, incl. __init__.py).
 * - Symbol index (locals + exports).
 * - Re-exports (incl. `export * from ...`) and TS `export =`.
 * - Go to definition (cross-file for TS/JS/Python).
 * - Find references (project-wide).
 * - AST grep utility.
 *
 * Monorepo-aware:
 * - Workspace discovery: `package.json` workspaces (preferred), `pnpm-workspace.yaml`, `lerna.json`.
 * - Workspace package resolution: `exports` (root/subpaths; import/require/default/module), `main`, and index fallbacks.
 * - Per-file tsconfig discovery (nearest) and path alias resolution via `tsconfig-paths`.
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

// Workspace support types and caches (monorepo detection and resolution)
type WorkspacePackageInfo = {
  name: string;
  path: string;
  main?: string;
  exports?: unknown;
};

type WorkspaceConfig = {
  packages: Map<string, WorkspacePackageInfo>; // package name -> info
  rootDir: string;
};

const workspaceCache = new Map<string, WorkspaceConfig>();

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

const TS_SUPPORT: LanguageSupport = {
  id: "ts",
  matchExts: [".ts", ".tsx", ".mts", ".cts"],
  language: (filename) => {
    const ext = path.extname(filename).toLowerCase();
    if (ext === ".tsx") return LangTSX;
    return LangTS;
  },
  nodeTypes: {
    identifier: ["identifier", "type_identifier"],
    propertyIdentifier: ["property_identifier"],
    shorthandPropertyIdentifier: ["shorthand_property_identifier"],
    memberExpression: "member_expression",
  },
  queries: {
    imports: `
      (import_statement (string) @mod) @stmt
      (export_statement (string) @mod) @stmt
    `,
    exports: `
      (export_statement) @stmt
      (export_statement (function_declaration name: (identifier) @name)) @stmt
      (export_statement (class_declaration name: (identifier) @name)) @stmt
      (export_statement (lexical_declaration (variable_declarator name: (identifier) @name))) @stmt
      (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias)) (string) @from)
      (export_statement (export_clause (export_specifier name: (identifier) @src)) (string) @from)
      (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias)))
      (export_statement (export_clause (export_specifier name: (identifier) @src)))
      (export_statement (string) @from)
      (export_statement (function_declaration name: (identifier) @default)) @stmt (#match? @stmt "default")
      (export_statement (class_declaration name: (identifier) @default)) @stmt (#match? @stmt "default")
      (export_assignment (identifier) @ts_export_assign)
    `,
    locals: `
      (function_declaration name: (identifier) @name)
      (class_declaration name: (identifier) @name)
      (variable_declarator name: (identifier) @name)
    `,
    importBindings: `
      (import_statement) @stmt
      (import_statement (string) @from)
      (import_statement (import_clause (identifier) @def) (string) @from)
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname alias: (identifier) @alias))) (string) @from)
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname))) (string) @from)
      (import_statement (import_clause (namespace_import (identifier) @ns)) (string) @from)
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

const JS_SUPPORT: LanguageSupport = {
  id: "js",
  matchExts: [".js", ".jsx", ".mjs", ".cjs"],
  language: () => LangJS,
  nodeTypes: {
    identifier: ["identifier"],
    propertyIdentifier: ["property_identifier"],
    shorthandPropertyIdentifier: ["shorthand_property_identifier"],
    memberExpression: "member_expression",
  },
  queries: {
    imports: `
      (import_statement (string) @mod) @stmt
      (export_statement (string) @mod) @stmt
      (call_expression function: (identifier) @fn arguments: (arguments (string) @mod)) (#eq? @fn "require")
    `,
    exports: `
      (export_statement) @stmt
      (export_statement (function_declaration name: (identifier) @name))
      (export_statement (class_declaration name: (identifier) @name))
      (export_statement (lexical_declaration (variable_declarator (identifier) @name)))
      (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias)) (string) @from)
      (export_statement (export_clause (export_specifier name: (identifier) @src)) (string) @from)
      (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias)))
      (export_statement (export_clause (export_specifier name: (identifier) @src)))
      (export_statement (string) @from)
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (shorthand_property_identifier) @cjs_shorthand)))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (identifier) @cjs_local))))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (member_expression object: (identifier) @mod property: (property_identifier) @prop) property: (property_identifier) @cjs_export_name)
        right: (identifier) @cjs_local))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @exp property: (property_identifier) @cjs_export_name)
        right: (identifier) @cjs_local))
        (#eq? @exp "exports")
    `,
    locals: `
      (function_declaration name: (identifier) @name)
      (class_declaration name: (identifier) @name)
      (variable_declarator name: (identifier) @name)
    `,
    importBindings: `
      (import_statement) @stmt
      (import_statement (string) @from)
      (import_statement (import_clause (identifier) @def) (string) @from)
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname alias: (identifier) @alias))) (string) @from)
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname))) (string) @from)
      (import_statement (import_clause (namespace_import (identifier) @ns)) (string) @from)
      (lexical_declaration (variable_declarator name:(identifier) @def value: (call_expression (identifier) @req arguments: (arguments (string) @from)))) (#eq? @req "require")
      (lexical_declaration (variable_declarator (object_pattern) @pattern value: (call_expression (identifier) @req arguments: (arguments (string) @from)))) (#eq? @req "require")
    `,
  },
  classifyDefinition: (n) => {
    const t = n.parent?.type;
    if (t === "function_declaration") return SymbolKind.Function;
    if (t === "class_declaration") return SymbolKind.Class;
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
        "import_specifier",
        "namespace_import",
        "import_clause",
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
      (import_from_statement) @stmt
    `,
    // Exports: __all__, function/class definitions, and assignments
    exports: `
      (assignment left: (identifier) @left right: (list (string)+ @all_item)) @stmt
      (function_definition name: (identifier) @name)
      (class_definition name: (identifier) @name)
      (assignment left: (identifier) @name)
    `,
    locals: `
      (function_definition name: (identifier) @name)
      (class_definition name: (identifier) @name)
      (assignment left: (identifier) @name)
    `,
    // Import bindings used to seed per-file scopes
    importBindings: `
      (import_statement) @stmt
      (import_from_statement) @stmt
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
  supportsCrossModuleSymbols: true, // enable cross-file symbol navigation
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const LANGUAGE_SUPPORTS: LanguageSupport[] = [
  TS_SUPPORT,
  JS_SUPPORT,
  PY_SUPPORT,
];

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
  return LANGUAGE_SUPPORTS.find((s) => s.matchExts.includes(ext)) ?? TS_SUPPORT;
}
function languageForFile(filename: string): Parser.Language {
  return supportForFile(filename).language(filename);
}

function sliceText(node: Parser.SyntaxNode, src: string) {
  if (!node || !src) return "";
  return src.slice(node.startIndex, node.endIndex);
}
function unquote(s: string) {
  if (!s || typeof s !== "string") return s;
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith("`") && t.endsWith("`"))
    ? t.slice(1, -1)
    : t;
}
function toRange(node: Parser.SyntaxNode): Range {
  if (!node) {
    return {
      start: { line: 0, column: 0, index: 0 },
      end: { line: 0, column: 0, index: 0 },
    };
  }
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
  try {
    return await fg(patterns, {
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
  } catch (error) {
    console.warn(`Warning: Failed to list files in ${projectRoot}:`, error);
    return [];
  }
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

/* ----------------------------- Workspace discovery ------------------------- */
async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function findWorkspaceRoot(startDir: string): Promise<string | null> {
  let dir = startDir;
  while (true) {
    const pkgJson = path.join(dir, "package.json");
    const pnpmYaml = path.join(dir, "pnpm-workspace.yaml");
    const lernaJson = path.join(dir, "lerna.json");
    if (await fileExists(pkgJson)) {
      try {
        const raw = await fsp.readFile(pkgJson, "utf8");
        const json = JSON.parse(raw);
        if (json.workspaces) return dir;
      } catch {}
    }
    if (await fileExists(pnpmYaml)) return dir;
    if (await fileExists(lernaJson)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function loadJSON<T = any>(p: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function loadWorkspaceConfig(
  projectRoot: string
): Promise<WorkspaceConfig | undefined> {
  const root = (await findWorkspaceRoot(projectRoot)) ?? projectRoot;
  if (workspaceCache.has(root)) return workspaceCache.get(root)!;

  const packages = new Map<string, WorkspacePackageInfo>();

  // npm/yarn workspaces from root package.json
  const rootPkgPath = path.join(root, "package.json");
  const rootPkg = await loadJSON<any>(rootPkgPath);
  let workspaceGlobs: string[] = [];
  if (rootPkg?.workspaces) {
    if (Array.isArray(rootPkg.workspaces)) workspaceGlobs = rootPkg.workspaces;
    else if (Array.isArray(rootPkg.workspaces?.packages))
      workspaceGlobs = rootPkg.workspaces.packages;
  }

  // pnpm-workspace.yaml (parse minimally to avoid adding dependency here)
  const pnpmYamlPath = path.join(root, "pnpm-workspace.yaml");
  if (await fileExists(pnpmYamlPath)) {
    try {
      const raw = await fsp.readFile(pnpmYamlPath, "utf8");
      // naive parse: look for lines under 'packages:' list
      const lines = raw.split(/\r?\n/);
      let inPackages = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("packages:")) {
          inPackages = true;
          continue;
        }
        if (!inPackages) continue;
        if (/^\w/.test(trimmed)) break; // end of section
        const m = trimmed.match(/^[-]\s*['\"]?([^'\"\s]+)['\"]?/);
        if (m && m[1]) workspaceGlobs.push(m[1]);
      }
    } catch {}
  }

  // lerna.json
  const lernaPath = path.join(root, "lerna.json");
  const lerna = await loadJSON<any>(lernaPath);
  if (lerna?.packages && Array.isArray(lerna.packages)) {
    workspaceGlobs.push(...lerna.packages);
  }

  // De-duplicate globs
  workspaceGlobs = Array.from(new Set(workspaceGlobs));

  if (workspaceGlobs.length > 0) {
    // Find all package.json files under workspace globs
    const patterns = workspaceGlobs.map((g) =>
      path.posix.join(g.replace(/\\/g, "/"), "package.json")
    );
    const found = await fg(patterns, {
      cwd: root,
      absolute: true,
      dot: true,
      ignore: ["**/node_modules/**"],
    });
    for (const pkgPath of found) {
      const info = await loadJSON<any>(pkgPath);
      const name: string | undefined = info?.name;
      if (!name) continue;
      const dir = path.dirname(pkgPath);
      packages.set(name, {
        name,
        path: dir,
        main: typeof info.main === "string" ? info.main : undefined,
        exports: info.exports,
      });
    }
  }

  const cfg: WorkspaceConfig = { packages, rootDir: root };
  workspaceCache.set(root, cfg);
  return cfg;
}

function resolvePackageSubpath(spec: string): {
  name: string;
  subpath?: string | undefined;
} {
  // spec can be '@scope/name/foo/bar' or 'name/foo'
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    const name = parts.slice(0, 2).join("/");
    const sub = parts.slice(2).join("/");
    return { name, subpath: sub || undefined };
  }
  const parts = spec.split("/");
  const name = parts[0]!;
  const sub = parts.slice(1).join("/");
  return { name, subpath: sub || undefined };
}

async function resolveWorkspacePackage(
  spec: string,
  ws: WorkspaceConfig | undefined
): Promise<string | null> {
  if (!ws) return null;
  const { name, subpath } = resolvePackageSubpath(spec);
  const pkg = ws.packages.get(name);
  if (!pkg) return null;
  const baseDir = pkg.path;

  const exts = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
  const tryResolveRelative = async (rel: string): Promise<string | null> => {
    const raw = path.resolve(baseDir, rel);
    const candidates: string[] = [raw];
    for (const e of exts) candidates.push(raw + e);
    for (const e of exts) candidates.push(path.join(raw, "index" + e));
    for (const c of candidates) if (await fileExists(c)) return path.resolve(c);
    return null;
  };
  const pickExportTarget = (target: any): string | null => {
    if (!target) return null;
    if (typeof target === "string") return target as string;
    if (typeof target === "object") {
      const cand = (target as any).import ?? (target as any).default ?? (target as any).require ?? (target as any).module;
      if (typeof cand === "string") return cand;
    }
    return null;
  };
  // Exports field resolution (root and subpaths)
  if (pkg.exports) {
    const key = subpath ? `./${subpath}` : ".";
    if (typeof pkg.exports === "string" && key === ".") {
      const hit = await tryResolveRelative(pkg.exports as string);
      if (hit) return hit;
    } else if (typeof pkg.exports === "object") {
      const map = pkg.exports as any;
      const target = map[key] ?? (key === "." ? map["."] : undefined);
      const rel = pickExportTarget(target);
      if (rel) {
        const hit = await tryResolveRelative(rel);
        if (hit) return hit;
      }
    }
  }

  // If subpath provided, try resolving inside package
  if (subpath) {
    const raw = path.join(baseDir, subpath);
    const candidates: string[] = [raw];
    for (const e of exts) candidates.push(raw + e);
    for (const e of exts) candidates.push(path.join(raw, "index" + e));
    for (const c of candidates) {
      if (await fileExists(c)) return path.resolve(c);
    }
    return null;
  }

  // No subpath: use package.json exports/main or index files
  const mainField = pkg.main ? path.resolve(baseDir, pkg.main) : null;
  if (mainField && (await fileExists(mainField))) return mainField;

  const idxCandidates = exts.flatMap((e) => [path.join(baseDir, "index" + e)]);
  for (const c of idxCandidates) {
    if (await fileExists(c)) return path.resolve(c);
  }
  return baseDir; // fallback to dir (some packages import directory)
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
    const matchPath = createMatchPath(baseUrl, paths ?? {});
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
  matchPath?: MatchPathFn,
  workspaceConfig?: WorkspaceConfig
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
  // Workspace packages
  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    const resolvedWs = await resolveWorkspacePackage(spec, workspaceConfig);
    if (resolvedWs) return resolvedWs;
  }
  if (matchPath) {
    const m = matchPath(
      spec,
      undefined,
      (candidate: string) => {
        try {
          fs.accessSync(candidate, fs.constants.R_OK);
          return true;
        } catch {
          return false;
        }
      },
      [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
    );
    if (m) {
      const cand = path.resolve(m);
      const hasExt = !!path.extname(cand);
      if (hasExt) return cand;
      const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
      for (const e of exts) {
        const pth = cand + e;
        try { fs.accessSync(pth, fs.constants.R_OK); return pth; } catch {}
      }
      for (const e of exts) {
        const pth = path.join(cand, "index" + e);
        try { fs.accessSync(pth, fs.constants.R_OK); return pth; } catch {}
      }
      return cand;
    }
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
  // Python relative imports: one leading dot keeps current package, additional dots climb parents
  const climb = Math.max(0, relativeDots - 1);
  for (let i = 0; i < climb; i++) baseDir = path.dirname(baseDir);

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
  const out: { spec: string; typeOnly?: boolean }[] = [];

  // Python: use regex fallback for import detection
  if (support.id === "python") {
    // Match: import module
    const reImport = /^import\s+([A-Za-z_][\w\.]*)/gm;
    for (const m of source.matchAll(reImport)) {
      out.push({ spec: m[1]! });
    }

    // Match: from module import ... (including relative imports)
    const reFrom = /^from\s+([A-Za-z_][\w\.]*|\.+[A-Za-z_][\w\.]*)\s+import/gm;
    for (const m of source.matchAll(reFrom)) {
      out.push({ spec: m[1]! });
    }

    return out;
  }

  try {
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    const q = new Parser.Query(lang, support.queries.imports);
    for (const m of q.matches(tree.rootNode)) {
      const caps = Object.fromEntries(
        m.captures.map((x: Parser.QueryCapture) => [x.name, x] as const)
      );
      const modNodes = m.captures.filter(
        (x: Parser.QueryCapture) => x.name === "mod"
      );
      const stmtText = caps["stmt"] ? sliceText(caps["stmt"].node, source) : "";
      const typeOnly = /^\s*(import|export)\s+type\b/.test(stmtText);
      for (const cap of modNodes)
        out.push({ spec: unquote(sliceText(cap.node, source)), typeOnly });
    }
    return out;
  } catch (error) {
    console.warn(
      `Warning: Query error in collectModuleSpecifiersFromSource for ${support.id}:`,
      error
    );
    return out;
  }
}

/* -------------------------------------------------------------------------- */
/* Module indexing (locals/exports/imports)                                   */
/* -------------------------------------------------------------------------- */

export function collectLocalsAndExportsFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  lang: Parser.Language,
  imports: ImportBinding[] = []
): ModuleIndex {
  let tree: Parser.Tree | null = null;
  try {
    const parser = new Parser();
    parser.setLanguage(lang);
    tree = parser.parse(source);
  } catch {}

  const locals: SymbolDef[] = [];
  if (tree) {
    if (support.id === "python") {
      try {
        const q = new Parser.Query(lang, support.queries.locals);
        for (const m of q.matches(tree.rootNode))
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
      } catch (error) {
        console.warn(
          `Warning: Query error in locals for ${support.id}:`,
          error
        );
      }
    } else {
      // JS/TS: build locals via AST walk (Tree-sitter only, no regex)
      const scopeIdx = buildScopeIndexFromSource(
        file,
        source,
        support,
        lang,
        imports
      );
      for (const b of scopeIdx.all) {
        if (!b.def) continue;
        let kind: SymbolKind = SymbolKind.Variable;
        if (b.kind === "function") kind = SymbolKind.Function;
        else if (b.kind === "class") kind = SymbolKind.Class;
        else if (b.kind === "type") kind = SymbolKind.TypeAlias;
        locals.push({ file, localName: b.name, kind, range: b.def });
      }
    }
  }

  const exports: ExportEntry[] = [];
  if (support.queries.exports.trim() && tree) {
    try {
      const q = new Parser.Query(lang, support.queries.exports);
      for (const m of q.matches(tree.rootNode)) {
        const map = Object.fromEntries(
          m.captures.map((x: Parser.QueryCapture) => [x.name, x] as const)
        );
        const stmtText = map["stmt"] ? sliceText(map["stmt"].node, source) : "";
        const isTypeOnly = /^\s*export\s+type\b/.test(stmtText);

        // Python exports
        if (support.id === "python") {
          // Handle __all__ exports
          if (
            map["left"] &&
            sliceText(map["left"].node, source) === "__all__"
          ) {
            const items = m.captures.filter(
              (c: Parser.QueryCapture) => c.name === "all_item"
            );
            for (const it of items) {
              const name = unquote(sliceText(it.node, source));
              const local = locals.find((d) => d.localName === name);
              if (local)
                exports.push({
                  type: "local",
                  exportedAs: name,
                  target: local,
                });
            }
            continue;
          }

          // Handle function/class definitions and assignments as exports
          if (map["name"]) {
            const nameText = sliceText(map["name"].node, source);
            const local = locals.find((d) => d.localName === nameText);
            if (local) {
              // Only export if not starting with underscore (Python convention)
              if (!nameText.startsWith("_")) {
                exports.push({
                  type: "local",
                  exportedAs: nameText,
                  target: local,
                });
              }
            }
            continue;
          }
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
              sourceSpecifier: srcName,
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
        // CommonJS captures
        if (map["cjs_shorthand"]) {
          const nameText = sliceText(map["cjs_shorthand"].node, source);
          const local = locals.find((d) => d.localName === nameText);
          if (local)
            exports.push({
              type: "local",
              exportedAs: nameText,
              target: local,
            });
          continue;
        }
        if (map["cjs_export_name"] && map["cjs_local"]) {
          const exportedAs = sliceText(map["cjs_export_name"].node, source);
          const localName = sliceText(map["cjs_local"].node, source);
          const local = locals.find((d) => d.localName === localName);
          if (local) exports.push({ type: "local", exportedAs, target: local });
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
          const nameNode = map["name"].node;
          const nameText = sliceText(nameNode, source);
          const local = locals.find((d) => d.localName === nameText);
          if (local) {
            exports.push({ type: "local", exportedAs: nameText, target: local });
            // Try to detect `export default function Name` by inspecting the nearest export_statement
            let cur: Parser.SyntaxNode | null = nameNode;
            let exportStmt: Parser.SyntaxNode | null = null;
            while (cur) {
              if (cur.type === "export_statement") { exportStmt = cur; break; }
              cur = cur.parent;
            }
            const exportText = exportStmt ? sliceText(exportStmt, source) : stmtText;
            if (/^\s*export\s+default\b/.test(exportText)) {
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
          const srcName = sliceText(map["src"].node, source);
          const alias = map["alias"]
            ? sliceText(map["alias"].node, source)
            : srcName;
          const local = locals.find((d) => d.localName === srcName);
          if (local)
            exports.push({ type: "local", exportedAs: alias, target: local });
        }
      }
      // If no explicit default export captured, add best-effort TS default function/class export
      if ((support.id === "ts" || support.id === "js") && !exports.some(e => e.type === "local" && e.exportedAs === "default")) {
        const mDefFn = source.match(/\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)/);
        const mDefCls = source.match(/\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/);
        const name = mDefFn?.[1] ?? mDefCls?.[1];
        if (name) {
          const local = locals.find(d => d.localName === name);
          if (local) exports.push({ type: "local", exportedAs: "default", target: { ...local, kind: SymbolKind.Default } });
        }
      }
    } catch {
      // Fallback: regex-based exports extraction for JS/TS
      if (support.id === "ts" || support.id === "js") {
        const reNamed =
          /\bexport\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
        const reDefault = /\bexport\s+default\s+([A-Za-z_$][\w$]*)/g;
        let m: RegExpExecArray | null;
        while ((m = reNamed.exec(source))) {
          const name = m[1]!;
          const local = locals.find((d) => d.localName === name);
          if (local)
            exports.push({ type: "local", exportedAs: name, target: local });
        }
        while ((m = reDefault.exec(source))) {
          const name = m[1]!;
          const local = locals.find((d) => d.localName === name);
          if (local)
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
        }
      }
    }
  }

  // Ensure default export is captured for TS/JS even if query missed it
  if ((support.id === "ts" || support.id === "js") && !exports.some(e => e.type === "local" && e.exportedAs === "default")) {
    const defFn = source.match(/\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)/);
    const defCls = source.match(/\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/);
    const defIdent = source.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\b/);
    const name = defFn?.[1] ?? defCls?.[1] ?? defIdent?.[1];
    if (name) {
      const local = locals.find(d => d.localName === name);
      if (local) exports.push({ type: "local", exportedAs: "default", target: { ...local, kind: SymbolKind.Default } });
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
  const imports: ImportBinding[] = [];

  // Python: use robust regex fallback to avoid query fragility
  if (sup.id === "python") {
    const pushStar = async (moduleSpec: string) => {
      const m = moduleSpec.match(/^(\.+)(.*)$/);
      const relDots = m ? m[1]!.length : 0;
      const mod = m ? m[2] || null : moduleSpec;
      const resolved = await resolvePythonModule(
        projectRoot,
        file,
        mod,
        relDots
      );
      imports.push({ kind: "star", from: moduleSpec, resolved });
    };
    const pushNamed = async (
      moduleSpec: string,
      imported: string,
      local: string
    ) => {
      const m = moduleSpec.match(/^(\.+)(.*)$/);
      const relDots = m ? m[1]!.length : 0;
      const mod = m ? m[2] || null : moduleSpec;
      const resolved = await resolvePythonModule(
        projectRoot,
        file,
        mod,
        relDots
      );
      imports.push({
        kind: "named",
        local,
        imported,
        from: moduleSpec,
        resolved,
      });
    };
    const pushDefault = async (dotted: string, local: string) => {
      const resolved = await resolvePythonModule(projectRoot, file, dotted, 0);
      imports.push({ kind: "default", local, from: dotted, resolved });
    };

    const reFromLine = /\bfrom\s+([^\s]+)\s+import\s+([^\n#]+)/g;
    for (const m of source.matchAll(reFromLine)) {
      const mod = m[1]!.trim();
      const items = m[2]!.split(",").map((s) => s.trim());
      for (const it of items) {
        if (it === "*") {
          await pushStar(mod);
          continue;
        }
        const am = it.match(
          /^([A-Za-z_][\w_]*)(?:\s+as\s+([A-Za-z_][\w_]*))?$/
        );
        if (am) {
          const imported = am[1]!;
          const local = am[2] ?? imported;
          await pushNamed(mod, imported, local);
        }
      }
    }
    const reImp =
      /^(?:\s*)import\s+([A-Za-z_][\w\.]*)\s*(?:as\s+([A-Za-z_][\w_]*))?/gm;
    for (const m of source.matchAll(reImp)) {
      const dotted = m[1]!;
      const local = (m[2] ?? dotted.split(".")[0]) as string;
      await pushDefault(dotted, local);
    }
    return imports;
  }

  // TS/JS path: try Query first; on failure, regex fallback
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  const tsCfg = sup.id === "ts" ? await loadNearestTsconfigFor(file) : {};
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);

  const resolveFrom = async (from: string) =>
    await resolveSpecifier(
      file,
      from,
      projectRoot,
      tsCfg.matchPath,
      workspaceConfig
    );

  const runFallback = async () => {
    const typeOnlyImport = /\bimport\s+type\b/;
    // import ... from 'mod'
    const reFrom = /\bimport\s+([^;]*?)\s+from\s+(["'])(?<m>[^"']+)\2/g;
    for (const m of source.matchAll(reFrom)) {
      const clause = m[1]!.trim();
      const mod = (m.groups as any).m as string;
      const typeOnly = typeOnlyImport.test(m[0]!);
      const resolved = await resolveFrom(mod);
      const ns = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (ns) {
        imports.push({
          kind: "namespace",
          localNS: ns[1]!,
          from: mod,
          resolved,
          typeOnly,
        });
        continue;
      }
      const parts = clause.split(",");
      if (parts.length) {
        const first = parts[0]!.trim();
        if (first && !first.startsWith("{"))
          imports.push({
            kind: "default",
            local: first,
            from: mod,
            resolved,
            typeOnly,
          });
        const namedBlock =
          parts.slice(1).join(",").trim() ||
          (first.startsWith("{") ? first : "");
        const names = namedBlock
          .replace(/[{}]/g, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const spec of names) {
          const nm = spec.match(
            /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/
          );
          if (!nm) continue;
          const imported = nm[1]!;
          const local = nm[2] ?? imported;
          imports.push({
            kind: "named",
            local,
            imported,
            from: mod,
            resolved,
            typeOnly,
          });
        }
      }
    }
    // require patterns
    const reReqDefault =
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(["'])(?<m>[^"']+)\2\s*\)/g;
    for (const m of source.matchAll(reReqDefault)) {
      const local = m[1]!;
      const mod = (m.groups as any).m as string;
      const resolved = await resolveFrom(mod);
      imports.push({ kind: "default", local, from: mod, resolved });
    }
    const reReqNamed =
      /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*(["'])(?<m>[^"']+)\2\s*\)/g;
    for (const m of source.matchAll(reReqNamed)) {
      const specs = m[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const mod = (m.groups as any).m as string;
      const resolved = await resolveFrom(mod);
      for (const spec of specs) {
        const nm = spec.match(
          /^([A-Za-z_$][\w$]*)(?::\s*([A-Za-z_$][\w$]*))?$/
        );
        if (!nm) continue;
        const imported = nm[1]!;
        const local = nm[2] ?? imported;
        imports.push({ kind: "named", local, imported, from: mod, resolved });
      }
    }
  };

  try {
    const q = new Parser.Query(lang, sup.queries.importBindings);
    for (const m of q.matches(tree.rootNode)) {
      const caps = Object.fromEntries(
        m.captures.map((x: Parser.QueryCapture) => [x.name, x] as const)
      );
      const stmtText = caps["stmt"] ? sliceText(caps["stmt"].node, source) : "";
      const typeOnly = sup.id === "ts" && /^\s*import\s+type\b/.test(stmtText);
      const from = caps["from"]
        ? unquote(sliceText(caps["from"].node, source))
        : undefined;

      // Handle destructuring assignment with require (process even if from is undefined)
      const patterns = m.captures.filter(
        (c: Parser.QueryCapture) => c.name === "pattern"
      );
      for (const pattern of patterns) {
        const patternNode = pattern.node;
        if (patternNode.type === "object_pattern") {
          // Extract property names and aliases from destructuring pattern
          for (const child of patternNode.namedChildren) {
            if (child.type === "shorthand_property_identifier") {
              // { helperFunction } = require('./helpers.js')
              const name = sliceText(child, source);
              imports.push({
                kind: "named",
                local: name,
                imported: name,
                from: from || "",
                resolved: from ? await resolveFrom(from) : { external: "" },
                typeOnly,
              });
            } else if (child.type === "pair_pattern") {
              // { helperFunction: requireHelper } = require('./helpers.js')
              const key = child.childForFieldName("key");
              const value = child.childForFieldName("value");
              if (
                key &&
                value &&
                key.type === "property_identifier" &&
                value.type === "identifier"
              ) {
                const imported = sliceText(key, source);
                const local = sliceText(value, source);
                imports.push({
                  kind: "named",
                  local,
                  imported,
                  from: from || "",
                  resolved: from ? await resolveFrom(from) : { external: "" },
                  typeOnly,
                });
              }
            }
          }
        }
      }

      if (!from) continue;
      const resolved = await resolveFrom(from);
      if (caps["def"]) {
        imports.push({
          kind: "default",
          local: sliceText(caps["def"].node, source),
          from,
          resolved,
          typeOnly,
        });
      }
      if (caps["ns"]) {
        const nsName = sliceText(caps["ns"].node, source);
        imports.push({
          kind: "namespace",
          localNS: nsName,
          from,
          resolved,
          typeOnly,
        });
      }
      const inames = m.captures.filter(
        (c: Parser.QueryCapture) => c.name === "iname"
      );
      const aliases = m.captures.filter(
        (c: Parser.QueryCapture) => c.name === "alias"
      );
      for (let i = 0; i < inames.length; i++) {
        const imported = sliceText(inames[i]!.node, source);
        const alias = aliases[i]
          ? sliceText(aliases[i]!.node, source)
          : imported;
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
  } catch {
    await runFallback();
  }
  return imports;
}

/* -------------------------------------------------------------------------- */
/* Build project index + graph                                                */
/* -------------------------------------------------------------------------- */

export async function collectGraph(
  projectRoot: string,
  files: string[]
): Promise<Graph> {
  const graph: Graph = { nodes: new Set(files), edges: [] };
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);

  // Process files in parallel for better performance
  const filePromises = files.map(async (file) => {
    try {
      const sup = supportForFile(file);
      const lang = languageForFile(file);
      const src = await fsp.readFile(file, "utf8");
      const specs = collectModuleSpecifiersFromSource(sup, lang, src);
      const { matchPath } =
        sup.id === "ts" ? await loadNearestTsconfigFor(file) : {};

      const edges: Edge[] = [];
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
          to = await resolveSpecifier(
            file,
            spec,
            projectRoot,
            matchPath,
            workspaceConfig
          );
        }
        edges.push({
          from: file,
          to,
          raw: spec,
          ...(typeOnly !== undefined && { typeOnly }),
        });
      }
      return edges;
    } catch (error) {
      console.warn(`Warning: Failed to process file ${file} for graph:`, error);
      return [];
    }
  });

  const allEdges = await Promise.all(filePromises);
  graph.edges = allEdges.flat();
  return graph;
}

export async function buildProjectIndex(
  projectRoot: string
): Promise<ProjectIndex> {
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);
  const files = await listProjectFiles(projectRoot);
  if (files.length === 0) {
    console.warn(`Warning: No files found in project root: ${projectRoot}`);
  }
  const modules = new Map<FileId, ModuleIndex>();

  // First pass: per-file locals/exports and imports (parallel processing)
  const filePromises = files.map(async (f) => {
    try {
      const sup = supportForFile(f);
      const lang = languageForFile(f);
      const src = await fsp.readFile(f, "utf8");
      const imports = await collectImportsForFile(f, projectRoot);
      const mod = collectLocalsAndExportsFromSource(f, src, sup, lang, imports);
      mod.imports = imports;

      // Resolve re-exports to files (TS/JS and Python)
      if (sup.supportsCrossModuleSymbols) {
        if (sup.id === "ts" || sup.id === "js") {
          const { matchPath } = await loadNearestTsconfigFor(f);
          for (const e of mod.exports)
            if (e.type !== "local") {
              if (e.fromModule.startsWith(".")) {
                const resolved = await resolveSpecifier(
                  f,
                  e.fromModule,
                  projectRoot,
                  matchPath,
                  workspaceConfig
                );
                if (typeof resolved === "string") e.fromModule = resolved;
              } else {
                // Try workspace/package resolution for bare specifiers
                const ws = await loadWorkspaceConfig(projectRoot);
                const pkgResolved = await resolveWorkspacePackage(e.fromModule, ws);
                if (pkgResolved) e.fromModule = pkgResolved;
              }
            }
        } else if (sup.id === "python") {
          // Python doesn't have re-exports like TS/JS, but we ensure module resolution works
          // The exports are already resolved during import collection
        }
      }
      return [f, mod] as const;
    } catch (error) {
      console.warn(`Warning: Failed to process file ${f}:`, error);
      // Return a minimal module index for failed files
      const mod: ModuleIndex = {
        file: f,
        exports: [],
        imports: [],
        locals: [],
      };
      return [f, mod] as const;
    }
  });

  const fileResults = await Promise.all(filePromises);
  for (const [f, mod] of fileResults) {
    modules.set(f.replace(/\\/g, "/"), mod);
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
  const normalizedFile = file.replace(/\\/g, "/");
  const mod = index.byFile.get(normalizedFile);
  if (!mod) return null;
  const key = cacheKey(normalizedFile, exportedName);
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
        resolveExport(index, e.fromModule, e.sourceSpecifier || exportedName) ||
        resolveExport(index, e.fromModule, exportedName);
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
      via?: {
        importedFrom?: string | undefined;
        exportedName?: string | undefined;
      };
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

  // If we found a variable_declarator, try to find the identifier within it
  if (node && node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && value.type === "call_expression") {
      // Try different field names for the function being called
      let callee = value.childForFieldName("function");
      if (!callee) callee = value.childForFieldName("callee");
      if (!callee) callee = value.child(0); // First child is often the function
      if (callee && sup.nodeTypes.identifier.includes(callee.type)) {
        node = callee;
      }
    }
  }

  while (node && (node.type === "," || node.type === ".")) node = node.parent;
  if (!node) return { status: "not_found", reason: "No node at position" };

  // If inside a member expression (e.g., ns.member), handle namespace resolution first
  if (
    sup.supportsCrossModuleSymbols &&
    ((node.type === (sup.nodeTypes.propertyIdentifier?.[0] ?? "property_identifier") &&
      node.parent &&
      node.parent.type === (sup.nodeTypes.memberExpression ?? "member_expression")) ||
     (node.type === (sup.nodeTypes.memberExpression ?? "member_expression")))
  ) {
    const memberNode = node.type === (sup.nodeTypes.memberExpression ?? "member_expression") ? node : node.parent!;
    const obj = memberNode.child(0);
    const prop = memberNode.child(2);
    if (obj && prop && obj.type === "identifier") {
      const nsName = sliceText(obj, source);
      const member = sliceText(prop, source);
      const nsImport = mod.imports.find((i) => i.kind === "namespace" && i.localNS === nsName);
      if (nsImport) {
        const resolved = resolveImported(index, nsImport, member);
        if (resolved)
          return {
            status: "ok",
            definition: resolved,
            via: {
              ...(toModuleRef(nsImport.resolved) ? { importedFrom: toModuleRef(nsImport.resolved) } : {}),
              exportedName: member,
            },
          };
      }
    }
  }

  const isId = sup.nodeTypes.identifier.includes(node.type);
  let name: string | null = isId ? sliceText(node, source) : null;

  // If the caret is on whitespace/keywords, walk up to find the nearest declaration's name
  if (!name) {
    const findDeclNameNode = (
      n: Parser.SyntaxNode | null
    ): Parser.SyntaxNode | null => {
      let cur: Parser.SyntaxNode | null = n;
      while (cur) {
        if (
          cur.type === "function_declaration" ||
          cur.type === "class_declaration" ||
          cur.type === "variable_declarator" ||
          cur.type === "interface_declaration" ||
          cur.type === "type_alias_declaration" ||
          cur.type === "function_definition" ||
          cur.type === "class_definition" ||
          cur.type === "assignment"
        ) {
          let named = cur.childForFieldName("name");
          if (!named && cur.type === "assignment") {
            const left = cur.child(0);
            if (left && sup.nodeTypes.identifier.includes(left.type))
              named = left;
          }
          if (named && sup.nodeTypes.identifier.includes(named.type))
            return named;
        }
        cur = cur.parent;
      }
      return null;
    };
    const declNameNode = findDeclNameNode(node);
    if (declNameNode) name = sliceText(declNameNode, source);
  }

  if (name) {
    // Check locals first
    const local = mod.locals.find((d) => d.localName === name);
    if (local) {
      return { status: "ok", definition: local };
    }

    if (sup.supportsCrossModuleSymbols) {
      // Try resolving as an exported name from this module (re-exports/local exports)
      const hit = resolveExport(index, file, name);
      if (hit) {
        return { status: "ok", definition: hit.def, via: { exportedName: name } };
      }

      for (const imp of mod.imports) {
        if (imp.kind === "default" && imp.local === name) {
          const target = resolveImported(index, imp, "default");
          if (target)
            return {
              status: "ok",
              definition: target,
              via: {
                ...(toModuleRef(imp.resolved)
                  ? { importedFrom: toModuleRef(imp.resolved) }
                  : {}),
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
                ...(toModuleRef(imp.resolved)
                  ? { importedFrom: toModuleRef(imp.resolved) }
                  : {}),
                exportedName: imp.imported,
              },
            };
        } else if (imp.kind === "namespace" && imp.localNS === name) {
          // For namespace imports, we need to find the actual module definition
          const targetFile =
            typeof imp.resolved === "string"
              ? imp.resolved.replace(/\\/g, "/")
              : undefined;
          if (targetFile) {
            const targetMod = index.byFile.get(targetFile);
            if (targetMod) {
              // Return the first export as the namespace definition
              const firstExport = targetMod.exports.find(
                (e) => e.type === "local"
              );
              if (firstExport) {
                return {
                  status: "ok",
                  definition: firstExport.target,
                  via: {
                    ...(toModuleRef(imp.resolved)
                      ? { importedFrom: toModuleRef(imp.resolved) }
                      : {}),
                    exportedName: firstExport.exportedAs,
                  },
                };
              }
            }
          }
        }
      }
    }
  }

  // namespace member handled earlier

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

  const idSet = new Set([
    ...support.nodeTypes.identifier,
    ...((support.nodeTypes.shorthandPropertyIdentifier ?? []) as string[]),
  ]);

  const addDecl = (nameNode: Parser.SyntaxNode, kind: BindingKind) => {
    const name = sliceText(nameNode, source);
    let target = stack[stack.length - 1];
    if (kind === "function" || kind === "class") {
      // For function and class declarations, always add to module scope (rootScope)
      target = rootScope;
    }
    const b: Binding = { name, kind, def: toRange(nameNode), occurrences: [] };
    target?.map.set(name, b);
  };

  const lookup = (name: string): Binding | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const hit = stack[i]!.map.get(name);
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
      if (name) {
        addDecl(name, "function");
      }
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

    // references: record all identifier occurrences that aren't declarations
    if (idSet.has(node.type) && !support.isDeclarationName(node)) {
      const name = sliceText(node, source);
      const b = lookup(name);
      if (b) {
        b.occurrences.push(toRange(node));
      }
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

function rangeContains(
  range: Range,
  pos: { row: number; column: number }
): boolean {
  if (pos.row < range.start.line || pos.row > range.end.line) return false;
  if (pos.row === range.start.line && pos.column < range.start.column)
    return false;
  if (pos.row === range.end.line && pos.column > range.end.column) return false;
  return true;
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
  // Ensure the definition itself is included as a reference
  refs.push({ file: definitionFile, range: def.range });

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
        if (imp.kind === "namespace") {
          // For namespace imports, check if the namespace contains the exported name
          const hit = resolveExport(index, targetFile, name);
          if (!hit || !sameDef(hit.def, def)) continue;

          const scopeIdx = await ensure();
          const nsName = imp.localNS;
          const member = name;
          const ranges = await collectNamespaceMemberRefs(f, nsName, member);
          for (const r of ranges)
            refs.push({
              file: f,
              range: r,
              via: { import: imp, namespaceMember: member },
            });
        } else {
          // For named and default imports, check if the import matches the exported name
          if (imp.kind === "star") {
            // Star imports are handled separately, skip them here
            continue;
          }

          const exported =
            imp.kind === "named"
              ? imp.imported
              : imp.kind === "default"
              ? "default"
              : name;
          const hit = resolveExport(index, targetFile, exported);
          if (!hit || !sameDef(hit.def, def)) continue;

          const scopeIdx = await ensure();
          const localName = imp.kind === "default" ? imp.local : imp.local;
          const binds = scopeIdx.bindings.get(localName) ?? [];
          for (const b of binds)
            for (const occ of b.occurrences)
              refs.push({ file: f, range: occ, via: { import: imp } });
        }
        // Python star imports are expanded into named during indexing
      }
    }
  }

  // Deduplicate references by file + position
  const seen = new Set<string>();
  const uniqueRefs: typeof refs = [];
  for (const ref of refs) {
    const key = `${ref.file}:${ref.range.start.line}:${ref.range.start.column}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRefs.push(ref);
    }
  }

  uniqueRefs.sort((a, b) =>
    a.file === b.file
      ? a.range.start.index - b.range.start.index
      : a.file.localeCompare(b.file)
  );
  return { status: "ok", definition: def, references: uniqueRefs };
}

async function collectNamespaceMemberRefs(
  file: string,
  nsName: string,
  member: string
): Promise<Range[]> {
  const lang = languageForFile(file);
  const sup = supportForFile(file);
  const parser = new Parser();
  parser.setLanguage(lang);
  const src = await fsp.readFile(file, "utf8");
  const tree = parser.parse(src);
  const out: Range[] = [];

  const walk = (n: Parser.SyntaxNode) => {
    const memberExprType =
      sup.nodeTypes.memberExpression ?? "member_expression";
    const propIdType =
      sup.nodeTypes.propertyIdentifier?.[0] ?? "property_identifier";

    if (n.type === memberExprType) {
      const obj = n.child(0);
      const prop = n.child(2);

      if (
        obj &&
        prop &&
        obj.type === "identifier" &&
        sliceText(obj, src) === nsName &&
        (prop.type === propIdType ||
          prop.type === "identifier" ||
          prop.type === "attribute") &&
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
    try {
      const lang = languageForFile(file);
      const parser = new Parser();
      parser.setLanguage(lang);
      const src = await fsp.readFile(file, "utf8");
      const tree = parser.parse(src);
      const query = new Parser.Query(lang, querySource);
      for (const m of query.matches(tree.rootNode)) {
        for (const cap of m.captures) {
          const p = cap.node.startPosition;
          const line = p.row + 1;
          const col = p.column + 1;
          const snippet = sliceText(cap.node, src).replace(/\n/g, " ");
          writeStdoutLine(
            `${path.relative(projectRoot, file)}:${line}:${col}: ${
              cap.name
            }: ${snippet}`
          );
        }
      }
    } catch (error) {
      console.warn(
        `Warning: Failed to process file ${file} for AST grep:`,
        error
      );
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

  // Test basic functionality
  if (cmd === "test") {
    writeStderrLine("Debug: Test command executed successfully");
    writeJSONLine({ status: "ok", message: "Script is working" });
    return;
  }

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

  if (cmd === "dumpmod") {
    const [fileArg] = rest;
    const file = path.isAbsolute(fileArg!)
      ? fileArg!.replace(/\\/g, "/")
      : path.resolve(root, fileArg!).replace(/\\/g, "/");
    const index = await buildProjectIndex(root);
    const mod = index.byFile.get(file);
    if (!mod) {
      writeJSONLine({ status: "not_found", reason: "Module not indexed", file });
      return;
    }
    writeJSONLine({
      file,
      locals: mod.locals.map(l => ({ name: l.localName, kind: l.kind, start: l.range.start })),
      exports: mod.exports.map(e => e.type === "local" ? ({ type: e.type, exportedAs: e.exportedAs, def: { name: e.target.localName, kind: e.target.kind, start: e.target.range.start } }) : e),
      imports: mod.imports,
    });
    return;
  }

  if (cmd === "goto") {
    const [fileArg, lineArg, colArg] = rest;
    const file = path.isAbsolute(fileArg!)
      ? fileArg!.replace(/\\/g, "/")
      : path.resolve(root, fileArg!).replace(/\\/g, "/");
    const line = Number(lineArg!);
    const column = Number(colArg!);
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
    const file = path.isAbsolute(args.file!)
      ? args.file!.replace(/\\/g, "/")
      : path.resolve(root, args.file!).replace(/\\/g, "/");
    const line = Number(args.line!);
    const column = Number(args.col ?? args.column!);
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
    await astGrep(root, querySource!);
    return;
  }

  writeStderrLine(`Unknown command: ${cmd}`);
  process.exit(1);
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith("index.ts")
) {
  main().catch((e) => {
    writeError(e);
    process.exit(1);
  });
}
