import path from "node:path";
import Parser from "tree-sitter";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { supportForFile } from "./languages.js";
import { prepareParserInput } from "./languages/filePrep.js";
import type { LanguageSupport } from "./languages.js";
import type { FileId, EdgeTo, Edge, Graph } from "./types.js";
import {
  listProjectFiles,
  sliceText,
  unquote,
  toRange,
  loadNearestTsconfigFor,
  loadWorkspaceConfig,
  resolveSpecifier,
  resolvePythonModule,
} from "./util.js";
import { stripJsLikeComments, acquireParser, releaseParser } from "./util.js";
// Intentionally compile only the imports query locally to avoid compiling
// unrelated queries (which may differ per grammar) and causing warnings.
import { extractJsTsSpecifiers, extractPythonSpecifiers, normalizePath } from "./util.js";
import type { ImportBinding, ProjectIndex, SymbolDef } from "./index.js";

// Shared types imported from ./types

export function collectModuleSpecifiersFromSource(
  support: LanguageSupport,
  lang: Parser.Language,
  source: string,
  opts?: { tree?: Parser.Tree; fast?: boolean }
): { spec: string; typeOnly?: boolean }[] {
  const out: { spec: string; typeOnly?: boolean }[] = [];

  if (support.id === "python") {
    try {
      const key = "py";
      const parser = acquireParser(lang, key);
      try {
        parser.setLanguage(lang);
        const tree = opts?.tree ?? parser.parse(source);
        const q = new Parser.Query(lang, support.queries.imports);
        for (const m of q.matches(tree.rootNode)) {
          const caps = Object.fromEntries(
            m.captures.map((x: Parser.QueryCapture) => [x.name, x] as const)
          );
          const stmtNode = caps["stmt"]?.node ?? m.captures[0]?.node;
          if (!stmtNode) continue;
          const stmtText = sliceText(stmtNode, source);
          // Handle: import a, b as c
          const mImport = /^\s*import\s+([^\n#]+)/.exec(stmtText);
          if (mImport) {
            const list = mImport[1]!
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            for (const spec of list) {
              const mm = spec.match(/^([A-Za-z_][\w\.]*)(?:\s+as\s+[A-Za-z_][\w_]*)?$/);
              if (mm) out.push({ spec: mm[1]! });
            }
            continue;
          }
          // Handle: from ..pkg.sub import x, y
          const mFrom = /^\s*from\s+(\.*)([A-Za-z_][\w\.]*)?\s+import\b/.exec(
            stmtText
          );
          if (mFrom) {
            const dots = mFrom[1] ?? "";
            const name = mFrom[2] ?? "";
            const mod = `${dots}${name}`;
            if (mod) out.push({ spec: mod });
            continue;
          }
        }
      } finally {
        releaseParser(parser, key);
      }
      if (out.length > 0) return out;
    } catch {}
    // Fallback to regex-based extractor
    for (const s of extractPythonSpecifiers(source)) out.push({ spec: s });
    return out;
  }

  // Fast path for JS/TS: regex-based extraction after comment stripping
  if ((support.id === "ts" || support.id === "js") && opts?.fast) {
    try {
      for (const s of extractJsTsSpecifiers(source)) out.push(s);
    } catch {}
    return out;
  }

  try {
    const key = (support.id === "python" ? "py" : support.id === "js" ? "js" : "ts");
    const parser = acquireParser(lang, key);
    try {
      parser.setLanguage(lang);
      const tree = opts?.tree ?? parser.parse(source);
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
      if (out.length > 0) return out;
    } finally {
      releaseParser(parser, key);
    }
  } catch (error) {
    console.warn(
      `Warning: Query error in collectModuleSpecifiersFromSource for ${support.id}:`,
      error
    );
    // fall through to regex fallback
  }

  // Regex fallback if the query path produced no results
  if (support.id === "ts" || support.id === "js") {
    try {
      for (const s of extractJsTsSpecifiers(source)) out.push(s);
    } catch {}
  }
  return out;
}

export async function collectGraph(
  projectRoot: string,
  files: string[],
  opts?: {
    parsed?: Map<
      string,
      {
        source: string;
        tree: Parser.Tree;
        sup: LanguageSupport;
        lang: Parser.Language;
      }
    >;
    fast?: boolean;
    threads?: number;
    resolveNodeModules?: boolean;
  }
): Promise<Graph> {
  const graph: Graph = { nodes: new Set(files.map((f) => f.replace(/\\/g, "/"))), edges: [] };
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);

  const conc = Math.max(1, Math.min(Number(opts?.threads || 0) || 32, 128));

  async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let idx = 0;
    let running = 0;
    return new Promise((resolve, reject) => {
      const next = () => {
        if (idx >= items.length && running === 0) {
          resolve(out);
          return;
        }
        while (running < limit && idx < items.length) {
          const cur = idx++;
          running++;
          fn(items[cur]!)
            .then((res) => {
              out[cur] = res;
              running--;
              next();
            })
            .catch(reject);
        }
      };
      next();
    });
  }

  const filePromises = await mapLimit(files, conc, async (file) => {
    try {
      const parsed = opts?.parsed?.get(file);
      let sup = parsed?.sup;
      let lang = parsed?.lang;
      let src = parsed?.source;
      if (!sup || !lang || src === undefined) {
        const prep = await prepareParserInput(file);
        sup = prep.sup;
        lang = prep.lang;
        src = prep.source;
      }
      const fast = !!opts?.fast;
      const specs = collectModuleSpecifiersFromSource(
        sup,
        lang,
        src,
        parsed?.tree ? { tree: parsed.tree, fast } : { fast }
      );
      const { matchPath } =
        sup.id === "ts" ? await loadNearestTsconfigFor(file) : ({});

      const edges: Edge[] = [];
      for (const { spec, typeOnly } of specs) {
        let to: EdgeTo;
        if (sup.id === "python") {
          const relDotsMatch = spec.startsWith(".") ? spec.match(/^\.+/) : null;
          const relDots = relDotsMatch ? relDotsMatch[0].length : 0;
          const res = await resolvePythonModule(
            projectRoot,
            file,
            spec.includes(".") || !spec.startsWith(".") ? spec : null,
            relDots
          );
          to =
            typeof res === "string"
              ? { type: "file", path: res.replace(/\\/g, "/") }
              : { type: "external", name: res.external };
        } else {
          const res = await resolveSpecifier(
            file,
            spec,
            projectRoot,
            matchPath,
            workspaceConfig,
            { resolveNodeModules: !!opts?.resolveNodeModules }
          );
          to =
            typeof res === "string"
              ? { type: "file", path: res.replace(/\\/g, "/") }
              : { type: "external", name: res.external };
        }
        edges.push({
          from: file.replace(/\\/g, "/"),
          to,
          raw: spec,
          ...(typeOnly !== undefined && { typeOnly }),
        });
        if (to.type === "file") graph.nodes.add(to.path);
      }
      return edges;
    } catch (error) {
      console.warn(`Warning: Failed to process file ${file} for graph:`, error);
      return [] as Edge[];
    }
  });

  const allEdges = filePromises;
  graph.edges = allEdges.flat();
  return graph;
}

function edgeTargetToString(t: EdgeTo): string {
  return t.type === "file" ? t.path : t.name;
}

function buildNodeIdMap(graph: Graph): {
  idOf: Map<string, string>;
  labels: Map<string, string>;
} {
  const idOf = new Map<string, string>();
  const labels = new Map<string, string>();
  let i = 0;
  const ensure = (label: string) => {
    if (!idOf.has(label)) {
      const id = `n${i++}`;
      idOf.set(label, id);
      labels.set(id, label);
    }
  };
  for (const f of graph.nodes) ensure(f);
  for (const e of graph.edges) {
    ensure(e.from);
    ensure(edgeTargetToString(e.to));
  }
  return { idOf, labels };
}

export function graphToDOT(graph: Graph): string {
  const { idOf } = buildNodeIdMap(graph);
  const lines: string[] = [];
  lines.push("digraph G {");
  lines.push("  rankdir=LR;");
  lines.push('  node [shape=box, fontsize=10, fontname="Arial"];\n');

  const declared = new Set<string>();
  const declare = (label: string, attrs: string) => {
    const id = idOf.get(label)!;
    if (declared.has(id)) return;
    declared.add(id);
    const safeLabel = label.replace(/\\/g, "/");
    lines.push(`  ${id} [label=\"${safeLabel}\"${attrs ? ", " + attrs : ""}];`);
  };

  for (const f of graph.nodes) declare(f, "");
  for (const e of graph.edges) {
    const toStr = edgeTargetToString(e.to);
    if (e.to.type === "external") declare(toStr, "shape=ellipse, style=dashed");
    else declare(toStr, "");
  }
  for (const e of graph.edges) {
    const fromId = idOf.get(e.from)!;
    const toId = idOf.get(edgeTargetToString(e.to))!;
    const attrs: string[] = [];
    if (e.typeOnly) attrs.push("style=dotted");
    lines.push(
      `  ${fromId} -> ${toId}${
        attrs.length ? " [" + attrs.join(",") + "]" : ""
      };`
    );
  }
  lines.push("}");
  return lines.join("\n");
}

export function graphToMermaid(graph: Graph): string {
  const { idOf } = buildNodeIdMap(graph);
  const declared = new Set<string>();
  const lines: string[] = ["flowchart LR"];
  const declare = (label: string, isExternal: boolean) => {
    const id = idOf.get(label)!;
    if (declared.has(id)) return;
    declared.add(id);
    const safe = label.replace(/\\/g, "/");
    lines.push(isExternal ? `${id}([\"${safe}\"])` : `${id}[\"${safe}\"]`);
  };
  for (const f of graph.nodes) declare(f, false);
  for (const e of graph.edges)
    declare(edgeTargetToString(e.to), e.to.type === "external");
  for (const e of graph.edges) {
    const fromId = idOf.get(e.from)!;
    const toId = idOf.get(edgeTargetToString(e.to))!;
    lines.push(e.typeOnly ? `${fromId} -.-> ${toId}` : `${fromId} --> ${toId}`);
  }
  return lines.join("\n");
}
export type AstGrepHit = {
  file: string;
  capture: string;
  line: number;
  column: number;
  snippet: string;
};

export async function astGrep(
  projectRoot: string,
  querySource: string,
  patterns = ["**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py,vue,svelte}"]
): Promise<AstGrepHit[]> {
  const hits: AstGrepHit[] = [];
  const files = await listProjectFiles(projectRoot, patterns);
  for (const file of files) {
    try {
      const prep = await prepareParserInput(file);
      const lang = prep.lang;
      const sup = prep.sup;
      const key = (sup.id === "python" ? "py" : sup.id === "js" ? "js" : "ts");
      const parser = acquireParser(lang, key);
      parser.setLanguage(lang);
      const src = prep.source;
      const tree = parser.parse(src);
      const query = new Parser.Query(lang, querySource);
      for (const m of query.matches(tree.rootNode)) {
        for (const cap of m.captures) {
          const p = cap.node.startPosition;
          hits.push({
            file: path.relative(projectRoot, file),
            capture: cap.name,
            line: p.row + 1,
            column: p.column + 1,
            snippet: sliceText(cap.node, src).replace(/\n/g, " "),
          });
        }
      }
      releaseParser(parser, key);
    } catch (error) {
      console.warn(
        `Warning: Failed to process file ${file} for AST grep:`,
        error
      );
    }
  }
  return hits;
}

// --------------------------- Symbol graph utilities ---------------------------

export type SymbolNodeKind =
  | "function"
  | "class"
  | "variable"
  | "interface"
  | "type"
  | "default"
  | "import"
  | "namespaceImport";
export type SymbolNode = {
  id: string;
  file: FileId;
  name: string;
  kind: SymbolNodeKind;
};
export type SymbolEdge = { from: string; to: string; label?: string };
export type SymbolGraph = {
  nodes: Map<string, SymbolNode>;
  edges: SymbolEdge[];
};

function defNodeId(def: {
  file: string;
  localName: string;
  range?: { start: { index: number } };
}) {
  const idx = def.range?.start?.index ?? 0;
  const f = typeof def.file === 'string' ? def.file.replace(/\\/g, '/') : def.file;
  return `${f}::${def.localName}::${idx}`;
}

function nodeForDef(def: {
  file: string;
  localName: string;
  kind: string;
  range?: { start: { index: number } };
}): SymbolNode {
  return {
    id: defNodeId(def),
    file: def.file,
    name: def.localName,
    kind: (def.kind as SymbolNodeKind) ?? "variable",
  };
}

export async function buildSymbolGraph(index: ProjectIndex): Promise<SymbolGraph> {
  const nodes = new Map<string, SymbolNode>();
  const edges: SymbolEdge[] = [];

  // Add definition nodes for all locals
  for (const [, mod] of index.byFile) {
    for (const def of mod.locals) {
      const n = nodeForDef(def);
      if (!nodes.has(n.id)) nodes.set(n.id, n);
    }
  }

  const normalizePath = (p: string) => p.replace(/\\/g, "/");

  // Resolve imports to exported locals and add edges from aliases to defs
  for (const [file, mod] of index.byFile) {
    for (const imp of mod.imports) {
      if (!imp) continue;
      const targetFile =
        typeof imp.resolved === "string"
          ? normalizePath(imp.resolved)
          : undefined;
      const targetMod = targetFile ? index.byFile.get(targetFile) : undefined;

      if (imp.kind === "named") {
        const aliasId = `${file}::${imp.local}::import`;
        if (!nodes.has(aliasId))
          nodes.set(aliasId, {
            id: aliasId,
            file,
            name: imp.local,
            kind: "import",
          });
        if (targetMod) {
          let exp = targetMod.exports.find(
            (e) => e.type === "local" && e.exportedAs === imp.imported
          );
          if (!exp) {
            // fallback: match local by name
            const loc = targetMod.locals.find(
              (l) => l.localName === imp.imported
            );
            if (loc)
              exp = {
                type: "local",
                exportedAs: imp.imported,
                target: loc,
              };
          }
          if (exp && exp.type === "local") {
            const def = exp.target;
            const toId = defNodeId(def);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(def));
            edges.push({ from: aliasId, to: toId, label: imp.imported });
          }
        }
      } else if (imp.kind === "default") {
        const aliasId = `${file}::${imp.local}::import`;
        if (!nodes.has(aliasId))
          nodes.set(aliasId, {
            id: aliasId,
            file,
            name: imp.local,
            kind: "import",
          });
        if (targetMod) {
          // try explicit default export; else fall back to a single export
          let exp = targetMod.exports.find(
            (e) => e.type === "local" && e.exportedAs === "default"
          );
          if (!exp)
            exp = targetMod.exports.find((e) => e.type === "local");
          if (exp && exp.type === "local") {
            const def = exp.target;
            const toId = defNodeId(def);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(def));
            edges.push({ from: aliasId, to: toId, label: "default" });
          }
        }
      } else if (imp.kind === "namespace") {
        const aliasId = `${file}::${imp.localNS}::import`;
        if (!nodes.has(aliasId))
          nodes.set(aliasId, {
            id: aliasId,
            file,
            name: imp.localNS,
            kind: "namespaceImport",
          });
        if (targetMod) {
          const exportedLocals = targetMod.exports.filter(
            (e) => e.type === "local"
          );
          for (const e of exportedLocals) {
            const def = e.target;
            const toId = defNodeId(def);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(def));
            edges.push({
              from: aliasId,
              to: toId,
              label: e.exportedAs,
            });
          }
        }
      }
    }
  }

  return { nodes, edges };
}

export async function buildSymbolGraphDetailed(
  index: ProjectIndex,
  opts?: {
    scope?: "all" | "imported";
    maxEdges?: number;
    membersOnly?: boolean;
  }
): Promise<SymbolGraph> {
  const base = await buildSymbolGraph(index);
  const nodes = new Map(base.nodes);
  const edges = base.edges.slice();

  const added = new Set<string>();
  const maxEdges =
    typeof opts?.maxEdges === "number" && opts.maxEdges > 0
      ? opts.maxEdges
      : Number.POSITIVE_INFINITY;
  const membersOnly = !!opts?.membersOnly;
  const scopeMode = (opts?.scope ?? "all") as "all" | "imported";

  const normalizePath = (p: string) => p.replace(/\\/g, "/");
  const importedByOthers = new Set<string>();
  if (scopeMode === "imported") {
    for (const [f, m] of index.byFile) {
      for (const imp of m.imports) {
        const target =
          typeof imp.resolved === "string"
            ? normalizePath(imp.resolved)
            : undefined;
        if (target) importedByOthers.add(target);
      }
    }
  }

  let edgeCount = edges.length;
  const maybePushEdge = (fromId: string, toId: string, label?: string) => {
    if (edgeCount >= maxEdges) return false;
    edges.push(
      label ? { from: fromId, to: toId, label } : { from: fromId, to: toId }
    );
    edgeCount++;
    return true;
  };

  const isIdentifierType = (sup: LanguageSupport, t: string) =>
    Array.isArray(sup.nodeTypes?.identifier) &&
    sup.nodeTypes.identifier.includes(t);

  // Resolve an exported symbol definition from a module file, following re-exports recursively
  const resolveExportFrom = (
    file: string,
    exportedName: string,
    cache: Map<string, SymbolDef | null> = new Map()
  ): SymbolDef | null => {
    const normalizedFile = file.replace(/\\/g, "/");
    const key = `${normalizedFile}::${exportedName}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    const mod = index.byFile.get(normalizedFile);
    if (!mod) {
      cache.set(key, null);
      return null;
    }
    // Direct local export
    for (const e of mod.exports)
      if (
        e.type === "local" &&
        e.exportedAs === exportedName
      ) {
        const res = e.target;
        cache.set(key, res);
        return res;
      }
    // Named re-export: export { x as y } from '...'
    for (const e of mod.exports)
      if (
        e.type === "reexport" &&
        e.exportedAs === exportedName &&
        typeof e.fromModule === "string"
      ) {
        const down =
          resolveExportFrom(
            e.fromModule,
            e.sourceSpecifier || exportedName,
            cache
          ) || resolveExportFrom(e.fromModule, exportedName, cache);
        if (down) {
          cache.set(key, down);
          return down;
        }
      }
    // export * from '...'
    for (const e of mod.exports)
      if (
        e.type === "exportStar" &&
        typeof e .fromModule === "string"
      ) {
        const down = resolveExportFrom(
          e.fromModule,
          exportedName,
          cache
        );
        if (down) {
          cache.set(key, down);
          return down;
        }
      }
    // Fallback: treat local with same name as exported (Python or missing export metadata)
    const local = (mod.locals).find(
      (l) => l.localName === exportedName
    );
    if (local) {
      cache.set(key, local);
      return local;
    }
    cache.set(key, null);
    return null;
  };

  for (const [file, mod] of index.byFile) {
    if (scopeMode === "imported") {
      const hasFuncOrClass = (mod.locals).some(
        (l) => l.kind === "function" || l.kind === "class"
      );
      const isImportedOrImports =
        importedByOthers.has(normalizePath(file)) ||
        (mod.imports).length > 0;
      if (!(hasFuncOrClass && isImportedOrImports)) continue;
    }
    try {
      const parsedEntry = index.parsed?.get(file);
      let sup = parsedEntry?.sup;
      let lang = parsedEntry?.lang;
      let src = parsedEntry?.source;
      let tree = parsedEntry?.tree;
      if (!sup || !lang || src === undefined || !tree) {
        const prep = await prepareParserInput(file);
        sup = prep.sup;
        lang = prep.lang;
        src = prep.source;
        const parser = new Parser();
        parser.setLanguage(lang);
        tree = parser.parse(src);
      }
      if (!sup || !lang || src === undefined || !tree) {
        throw new Error(`Failed to parse ${file}`);
      }

      // Build mapping from imported local alias -> target def (best-effort)
      const aliasToTargetDef = new Map<string, SymbolDef>();
      // And for namespace imports: alias -> target module file path (string)
      const aliasToTargetModule = new Map<string, string>();
      const targetModOf = (imp: ImportBinding) => {
        const targetFile =
          typeof imp.resolved === "string"
            ? imp.resolved.replace(/\\/g, "/")
            : undefined;
        return targetFile ? index.byFile.get(targetFile) : undefined;
      };
      for (const imp of mod.imports) {
        if (!imp) continue;
        const tmod = targetModOf(imp);
        const targetFile =
          typeof imp.resolved === "string"
            ? imp.resolved.replace(/\\/g, "/")
            : undefined;
        if (!tmod || !targetFile) continue;
        if (imp.kind === "named") {
          const def =
            resolveExportFrom(targetFile, imp.imported) ||
            tmod.locals.find((l) => l.localName === imp.imported);
          if (def) aliasToTargetDef.set(imp.local, def);
        } else if (imp.kind === "default") {
          const def =
            resolveExportFrom(targetFile, "default") ||
            (tmod.exports.find((e) => e.type === "local")?.target);
          if (def) aliasToTargetDef.set(imp.local, def);
          // Also treat default imports as potential namespace holders for member usage (u.helper())
          aliasToTargetModule.set(imp.local, targetFile);
        } else if (imp.kind === "namespace") {
          aliasToTargetModule.set(imp.localNS, targetFile);
        }
      }

      // Collect function-like declarations (JS/TS: function_declaration, arrow/function expressions bound to vars; Python: function_definition)
      const functionNodes: Array<{ name: string; node: Parser.SyntaxNode; def: SymbolDef }> = [];
      // Collect simple constant string bindings for resolving computed member keys, e.g., const k = "x"; obj[k]
      const constStringOf = new Map<string, string>();
      const collectConsts = (n: Parser.SyntaxNode) => {
        if (n.type === "variable_declarator") {
          const nameNode = n.childForFieldName("name");
          const valueNode = n.childForFieldName("value");
          if (nameNode && valueNode && valueNode.type === "string") {
            const name = sliceText(nameNode, src);
            const val = unquote(sliceText(valueNode, src));
            constStringOf.set(name, val);
          }
        }
        for (const ch of n.namedChildren) collectConsts(ch);
      };
      collectConsts(tree.rootNode);

      // Node type helpers (must be initialized before any walkers that reference them)
      const memberExpressionType =
        sup.nodeTypes.memberExpression ?? "member_expression";
      const propertyIdentifierTypes: string[] = sup.nodeTypes
        .propertyIdentifier ?? ["property_identifier"];
      const optionalMemberTypes = new Set<string>([
        memberExpressionType,
        "optional_member_expression",
        "subscript_expression",
        "optional_chain",
        sup.id === "python" ? "attribute" : "",
      ]);
      const walkCollect = (n: Parser.SyntaxNode) => {
        if (
          n.type === "function_declaration" ||
          n.type === "function_definition"
        ) {
          const nameNode = n.childForFieldName("name");
          const name = nameNode ? sliceText(nameNode, src) : undefined;
          if (name) {
            const def = mod.locals.find((d) => d.localName === name);
            if (def) functionNodes.push({ name, node: n, def });
          }
        } else if (n.type === "variable_declarator") {
          const nameNode = n.childForFieldName("name");
          const valueNode = n.childForFieldName("value");
          if (nameNode && valueNode) {
            const vt = String(valueNode.type || "");
            if (/arrow_function|function/.test(vt)) {
              const name = sliceText(nameNode, src);
              const def = mod.locals.find((d) => d.localName === name);
              if (def) functionNodes.push({ name, node: valueNode, def });
            }
          }
        } else if (n.type === "assignment_expression") {
          const left = n.childForFieldName("left");
          const right = n.childForFieldName("right");
          if (left && right) {
            const vt = String(right.type || "");
            if (/arrow_function|function/.test(vt)) {
              let name: string | null = null;
              if (left.type === memberExpressionType) {
                const prop = left.child(2);
                if (prop && propertyIdentifierTypes.includes(prop.type))
                  name = sliceText(prop, src);
              } else if (left.type === "identifier") {
                name = sliceText(left, src);
              }
              if (name) {
                const def = mod.locals.find((d) => d.localName === name);
                if (def) functionNodes.push({ name, node: right, def });
              }
            }
          }
        }
        for (const ch of n.namedChildren) walkCollect(ch);
      };
      walkCollect(tree.rootNode);

      // For each function, look for identifier occurrences of imported aliases in its subtree
      const scanForAliasUse = (
        node: Parser.SyntaxNode,
        cb: (name: string, atNode: Parser.SyntaxNode) => void
      ) => {
        if (isIdentifierType(sup, node.type)) {
          const name = sliceText(node, src);
          cb(name, node);
        }
        for (const ch of node.namedChildren)
          scanForAliasUse(ch, cb);
      };

      const tryResolveChain = (node: Parser.SyntaxNode, fromId?: string) => {
        const names: string[] = [];
        let cur: Parser.SyntaxNode | null = node;
        let base: Parser.SyntaxNode | null = null;
        const pushProp = (p: Parser.SyntaxNode | null) => {
          if (!p) return;
          if (propertyIdentifierTypes.includes(p.type))
            names.push(sliceText(p, src));
          else if (p.type === "string")
            names.push(unquote(sliceText(p, src)));
          else if (p.type === "identifier") {
            const keyName = sliceText(p, src);
            const v = constStringOf.get(keyName);
            if (typeof v === "string") names.push(v);
          }
        };
        while (cur && optionalMemberTypes.has(cur.type)) {
          if (cur.type === "subscript_expression") {
            base = cur.child(0) ?? base;
            const idx = cur.child(2);
            pushProp(idx);
            cur = base;
          } else if (
            cur.type === memberExpressionType ||
            cur.type === "optional_member_expression" ||
            cur.type === "attribute"
          ) {
            base = cur.child(0) ?? base;
            const prop =
              cur.childForFieldName?.("property") ??
              cur.child(2) ??
              cur.childForFieldName?.("attribute");
            pushProp(prop);
            cur = base;
          } else if (cur.type === "optional_chain") {
            cur = cur.child(0);
          } else {
            break;
          }
        }
        if (!cur || !isIdentifierType(sup, cur.type)) return false;
        const alias = sliceText(cur, src);
        const targetFile = aliasToTargetModule.get(alias);
        if (!targetFile || names.length === 0) return false;
        let file: string | null = targetFile;
        let targetDef: SymbolDef | null = null;
        for (const seg of names.reverse()) {
          if (!file) break;
          // Check if seg is a namespace re-export (export * as seg from '...')
          const m = index.byFile.get(file.replace(/\\/g, "/"));
          const nsReexport = m?.exports.find(
            (e) =>
              e.type === "reexport" &&
              e.exportedAs === seg &&
              e.sourceSpecifier === ""
          );
          if (nsReexport && nsReexport.type === "reexport" && typeof nsReexport.fromModule === "string") {
            file = nsReexport.fromModule.replace(/\\/g, "/");
            continue;
          }
          targetDef = resolveExportFrom(file, seg);
          if (!targetDef) break;
          file = targetDef.file;
        }
        if (targetDef && fromId) {
          const toId = defNodeId(targetDef);
          if (!nodes.has(toId)) nodes.set(toId, nodeForDef(targetDef));
          const key = `${fromId}->${toId}`;
          if (!added.has(key)) {
            added.add(key);
            if (!maybePushEdge(fromId, toId, "uses")) return true;
          }
          return true;
        }
        return !!targetDef;
      };

      // Collect Python decorators on functions and add uses edges
      if (sup.id === "python") {
        const addDecoratorUses = (n: Parser.SyntaxNode) => {
          if (n.type === "function_definition") {
            const nameNode = n.childForFieldName("name");
            if (nameNode) {
              const name = sliceText(nameNode, src);
              const def = mod.locals.find((d) => d.localName === name);
              if (def) {
                const fromId = defNodeId(def);
                if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(def));
                // Python decorators appear before the function; walk preceding siblings to find attributes
                let prev = n.previousSibling;
                while (prev) {
                  if (prev.type === "decorated_definition") {
                    for (const d of prev.namedChildren) {
                      if (d.type === "decorator") {
                        const expr =
                          d.childForFieldName?.("name") ??
                          d.child(1);
                        if (expr) tryResolveChain(expr, fromId);
                      } else if (d.type === "attribute") {
                        tryResolveChain(d, fromId);
                      }
                    }
                  } else if (prev.type === "decorator") {
                    const expr =
                      prev.childForFieldName?.("name") ??
                      prev.child(1);
                    if (expr) tryResolveChain(expr, fromId);
                  }
                  prev = prev.previousSibling;
                }
              }
            }
          }
          for (const ch of n.namedChildren) addDecoratorUses(ch);
        };
        addDecoratorUses(tree.rootNode);
      }

      for (const fn of functionNodes) {
        const fromId = defNodeId(fn.def);
        if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(fn.def));
        const seenAliases = new Set<string>();
        if (!membersOnly)
          scanForAliasUse(fn.node, (name: string, atNode: Parser.SyntaxNode) => {
            if (seenAliases.has(name)) return;
            let target: SymbolDef | null = aliasToTargetDef.get(name) ?? null;
            if (!target) {
              const modFile = aliasToTargetModule.get(name);
              if (modFile) {
                // If used as a member (u.helper), prefer that member name
                let exportedName: string | null = null;
                const p = atNode.parent;
                if (
                  p &&
                  (p.type === memberExpressionType ||
                    p.type === "optional_member_expression")
                ) {
                  const prop =
                    p.childForFieldName?.("property") ?? p.child(2);
                  if (prop && propertyIdentifierTypes.includes(prop.type))
                    exportedName = sliceText(prop, src);
                }
                if (exportedName) {
                  target = resolveExportFrom(modFile, exportedName);
                  if (!target) {
                    const m = index.byFile.get(modFile);
                    target = (m?.locals ?? []).find(
                      (l: SymbolDef) => l.localName === exportedName
                    ) ?? null;
                  }
                }
                // Do not fall back to default or arbitrary first local to avoid spurious edges
              }
            }
            if (!target) return;
            seenAliases.add(name);
            const toId = defNodeId(target);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
            const key = `${fromId}->${toId}`;
            if (added.has(key)) return;
            added.add(key);
            if (!maybePushEdge(fromId, toId, "uses")) return;
          });

        // Walk for member expressions of namespace imports: alias.member
        const walkForMembers = (n: Parser.SyntaxNode) => {
          const tryResolveChainLocal = (node: Parser.SyntaxNode) => {
            const names: string[] = [];
            let cur: Parser.SyntaxNode | null = node;
            let base: Parser.SyntaxNode | null = null;
            const pushProp = (p: Parser.SyntaxNode | null) => {
              if (!p) return;
              if (propertyIdentifierTypes.includes(p.type))
                names.push(sliceText(p, src));
              else if (p.type === "string")
                names.push(unquote(sliceText(p, src)));
              else if (p.type === "identifier") {
                const keyName = sliceText(p, src);
                const v = constStringOf.get(keyName);
                if (typeof v === "string") names.push(v);
              }
            };
            while (cur && optionalMemberTypes.has(cur.type)) {
              if (cur.type === "subscript_expression") {
                base = cur.child(0) ?? base;
                const idx = cur.child(2);
                pushProp(idx);
                cur = base;
              } else if (
                cur.type === memberExpressionType ||
                cur.type === "optional_member_expression" ||
                cur.type === "attribute"
              ) {
                base = cur.child(0) ?? base;
                const prop =
                  cur.childForFieldName?.("property") ??
                  cur.child(2) ??
                  cur.childForFieldName?.("attribute");
                pushProp(prop);
                cur = base;
              } else if (cur.type === "optional_chain") {
                cur = cur.child(0);
              } else {
                break;
              }
            }
            if (!cur || !isIdentifierType(sup, cur.type)) return;
            const alias = sliceText(cur, src);
            const targetFile = aliasToTargetModule.get(alias);
            if (!targetFile || names.length === 0) return;
            let file: string | null = targetFile;
            let targetDef: SymbolDef | null = null;
            for (const seg of names.reverse()) {
              if (!file) break;
              // Check if seg is a namespace re-export (export * as seg from '...')
              const m = index.byFile.get(file.replace(/\\/g, "/"));
              const nsReexport = m?.exports.find(
                (e) =>
                  e.type === "reexport" &&
                  e.exportedAs === seg &&
                  e.sourceSpecifier === ""
              );
              if (nsReexport && nsReexport.type === "reexport" && typeof nsReexport.fromModule === "string") {
                file = nsReexport.fromModule.replace(/\\/g, "/");
                continue;
              }
              targetDef = resolveExportFrom(file, seg);
              if (!targetDef) break;
              file = targetDef.file;
            }
            if (!targetDef) {
              const fileKey =
                typeof file === "string" ? file.replace(/\\/g, "/") : file;
              const m = index.byFile.get(fileKey ?? "");
              const last = names[0];
              if (m)
                targetDef =
                  (m.locals as SymbolDef[]).find((l) => l.localName === last) ?? null;
            }
            if (targetDef) {
              const toId = defNodeId(targetDef);
              if (!nodes.has(toId)) nodes.set(toId, nodeForDef(targetDef));
              const key = `${fromId}->${toId}`;
              if (!added.has(key)) {
                added.add(key);
                if (!maybePushEdge(fromId, toId, "uses")) return;
              }
            }
          };

          if (optionalMemberTypes.has(n.type)) tryResolveChainLocal(n);
          for (const ch of n.namedChildren ?? []) walkForMembers(ch);
        };
        walkForMembers(fn.node);
      }
    } catch (error) {
      console.warn(
        `Warning: Failed to build detailed symbol edges for ${file}:`,
        error
      );
    }
  }

  return { nodes, edges };
}

export function graphToMermaidSymbols(
  sg: SymbolGraph,
  projectRoot?: string
): string {
  const idOf = new Map<string, string>();
  const labels = new Map<string, string>();
  let i = 0;
  const toDisp = (node: SymbolNode) => {
    const rel = projectRoot
      ? path.relative(projectRoot, node.file).replace(/\\/g, "/")
      : node.file;
    const base = path.basename(rel);
    if (node.kind === "import") return `${base}:${node.name} (import)`;
    if (node.kind === "namespaceImport")
      return `${base}:${node.name} (namespace)`;
    return `${base}:${node.name}`;
  };
  for (const [id, n] of sg.nodes) {
    const nid = `n${i++}`;
    idOf.set(id, nid);
    labels.set(nid, toDisp(n));
  }
  const declared = new Set<string>();
  const lines: string[] = ["flowchart LR"];
  for (const [id, label] of labels) {
    if (declared.has(id)) continue;
    declared.add(id);
    const safe = label.replace(/\\/g, "/");
    lines.push(`${id}[\"${safe}\"]`);
  }
  for (const e of sg.edges) {
    const fromId = idOf.get(e.from)!;
    const toId = idOf.get(e.to)!;
    if (e.label) lines.push(`${fromId} -- \"${e.label}\" --> ${toId}`);
    else lines.push(`${fromId} --> ${toId}`);
  }
  return lines.join("\n");
}

export function graphToDOTSymbols(
  sg: SymbolGraph,
  projectRoot?: string
): string {
  const idOf = new Map<string, string>();
  const labels = new Map<string, string>();
  let i = 0;
  const toDisp = (node: SymbolNode) => {
    const rel = projectRoot
      ? path.relative(projectRoot, node.file).replace(/\\/g, "/")
      : node.file;
    const base = path.basename(rel);
    if (node.kind === "import") return `${base}:${node.name} (import)`;
    if (node.kind === "namespaceImport")
      return `${base}:${node.name} (namespace)`;
    return `${base}:${node.name}`;
  };
  for (const [id, n] of sg.nodes) {
    const nid = `n${i++}`;
    idOf.set(id, nid);
    labels.set(nid, toDisp(n));
  }
  const lines: string[] = [];
  lines.push("digraph G {");
  lines.push("  rankdir=LR;");
  lines.push('  node [shape=box, fontsize=10, fontname="Arial"];\n');
  for (const [id, label] of labels) {
    const safeLabel = label.replace(/\\/g, "/");
    lines.push(`  ${id} [label=\"${safeLabel}\"];`);
  }
  for (const e of sg.edges) {
    const fromId = idOf.get(e.from)!;
    const toId = idOf.get(e.to)!;
    const attrs: string[] = [];
    if (e.label) attrs.push(`label=\"${e.label}\"`);
    lines.push(
      `  ${fromId} -> ${toId}${
        attrs.length ? " [" + attrs.join(",") + "]" : ""
      };`
    );
  }
  lines.push("}");
  return lines.join("\n");
}

export function graphToMermaidSymbolsWithFiles(
  sg: SymbolGraph,
  fg: Graph,
  projectRoot?: string
): string {
  const fileIdOf = new Map<string, string>();
  const fileNodeMeta = new Map<string, { label: string; external: boolean }>();
  let fi = 0;
  const fileLabel = (file: string) =>
    projectRoot ? path.relative(projectRoot, file).replace(/\\/g, "/") : file;
  const ensureFile = (file: string) => {
    if (!fileIdOf.has(file)) {
      const id = `f${fi++}`;
      fileIdOf.set(file, id);
      fileNodeMeta.set(id, { label: fileLabel(file), external: false });
    }
  };
  const ensureExternal = (name: string) => {
    if (!fileIdOf.has(name)) {
      const id = `f${fi++}`;
      fileIdOf.set(name, id);
      fileNodeMeta.set(id, { label: name, external: true });
    }
  };
  for (const f of fg.nodes) ensureFile(f);
  for (const e of fg.edges) {
    ensureFile(e.from);
    if (e.to.type === "file") ensureFile(e.to.path);
    else ensureExternal(e.to.name);
  }

  const symIdOf = new Map<string, string>();
  const symLabels = new Map<string, string>();
  let si = 0;
  const symDisp = (node: SymbolNode) => {
    const base = path.basename(node.file);
    if (node.kind === "import") return `${base}:${node.name} (import)`;
    if (node.kind === "namespaceImport")
      return `${base}:${node.name} (namespace)`;
    return `${base}:${node.name}`;
  };
  for (const [id, n] of sg.nodes) {
    const sid = `s${si++}`;
    symIdOf.set(id, sid);
    symLabels.set(sid, symDisp(n));
  }

  const declared = new Set<string>();
  const lines: string[] = ["flowchart LR"];

  for (const [id, meta] of fileNodeMeta) {
    if (declared.has(id)) continue;
    declared.add(id);
    const safe = meta.label.replace(/\\/g, "/");
    lines.push(meta.external ? `${id}([\"${safe}\"])` : `${id}[\"${safe}\"]`);
  }
  for (const [id, label] of symLabels) {
    if (declared.has(id)) continue;
    declared.add(id);
    const safe = label.replace(/\\/g, "/");
    lines.push(`${id}[\"${safe}\"]`);
  }

  for (const e of fg.edges) {
    const fromId = fileIdOf.get(e.from)!;
    const targetKey = e.to.type === "file" ? e.to.path : e.to.name;
    const toId = fileIdOf.get(targetKey)!;
    lines.push(`${fromId} --> ${toId}`);
  }

  for (const [sidKey, sid] of symIdOf) {
    const node = sg.nodes.get(sidKey)!;
    const fid = fileIdOf.get(node.file);
    if (fid) lines.push(`${fid} --> ${sid}`);
  }

  for (const e of sg.edges) {
    const fromId = symIdOf.get(e.from)!;
    const toId = symIdOf.get(e.to)!;
    if (e.label) lines.push(`${fromId} -- \"${e.label}\" --> ${toId}`);
    else lines.push(`${fromId} --> ${toId}`);
  }

  return lines.join("\n");
}

export function graphToDOTSymbolsWithFiles(
  sg: SymbolGraph,
  fg: Graph,
  projectRoot?: string
): string {
  const fileIdOf = new Map<string, string>();
  const fileNodeMeta = new Map<string, { label: string; external: boolean }>();
  let fi = 0;
  const fileLabel = (file: string) =>
    projectRoot ? path.relative(projectRoot, file).replace(/\\/g, "/") : file;
  const ensureFile = (file: string) => {
    if (!fileIdOf.has(file)) {
      const id = `f${fi++}`;
      fileIdOf.set(file, id);
      fileNodeMeta.set(id, { label: fileLabel(file), external: false });
    }
  };
  const ensureExternal = (name: string) => {
    if (!fileIdOf.has(name)) {
      const id = `f${fi++}`;
      fileIdOf.set(name, id);
      fileNodeMeta.set(id, { label: name, external: true });
    }
  };
  for (const f of fg.nodes) ensureFile(f);
  for (const e of fg.edges) {
    ensureFile(e.from);
    if (e.to.type === "file") ensureFile(e.to.path);
    else ensureExternal(e.to.name);
  }

  const symIdOf = new Map<string, string>();
  const symLabels = new Map<string, string>();
  let si = 0;
  const symDisp = (node: SymbolNode) => {
    const base = path.basename(node.file);
    if (node.kind === "import") return `${base}:${node.name} (import)`;
    if (node.kind === "namespaceImport")
      return `${base}:${node.name} (namespace)`;
    return `${base}:${node.name}`;
  };
  for (const [id, n] of sg.nodes) {
    const sid = `s${si++}`;
    symIdOf.set(id, sid);
    symLabels.set(sid, symDisp(n));
  }

  const lines: string[] = [];
  lines.push("digraph G {");
  lines.push("  rankdir=LR;");
  lines.push('  node [shape=box, fontsize=10, fontname="Arial"];\n');
  for (const [id, meta] of fileNodeMeta) {
    const safe = meta.label.replace(/\\/g, "/");
    lines.push(
      `  ${id} [label=\"${safe}\", ${
        meta.external ? "shape=ellipse, style=dashed" : "shape=box"
      }];`
    );
  }
  for (const [id, label] of symLabels) {
    const safe = label.replace(/\\/g, "/");
    lines.push(`  ${id} [label=\"${safe}\"];`);
  }
  for (const e of fg.edges) {
    const fromId = fileIdOf.get(e.from)!;
    const targetKey = e.to.type === "file" ? e.to.path : e.to.name;
    const toId = fileIdOf.get(targetKey)!;
    lines.push(`  ${fromId} -> ${toId};`);
  }
  for (const [sidKey, sid] of symIdOf) {
    const node = sg.nodes.get(sidKey)!;
    const fid = fileIdOf.get(node.file);
    if (fid) lines.push(`  ${fid} -> ${sid};`);
  }
  for (const e of sg.edges) {
    const fromId = symIdOf.get(e.from)!;
    const toId = symIdOf.get(e.to)!;
    const attrs: string[] = [];
    if (e.label) attrs.push(`label=\"${e.label}\"`);
    lines.push(
      `  ${fromId} -> ${toId}${
        attrs.length ? " [" + attrs.join(",") + "]" : ""
      };`
    );
  }
  lines.push("}");
  return lines.join("\n");
}
