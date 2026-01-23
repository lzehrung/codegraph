import path from "node:path";
import fsp from "node:fs/promises";
import Parser from "tree-sitter";
import { prepareParserInput } from "./languages/filePrep.js";
import { type LanguageSupport, getCompiledQueries } from "./languages.js";
import type { FileId, EdgeTo, Edge, Graph } from "./types.js";
import {
  listProjectFiles,
  sliceText,
  unquote,
  loadNearestTsconfigFor,
  loadWorkspaceConfig,
  resolveSpecifier,
  resolveImportSpecifier,
  resolvePythonModule,
  normalizeResolutionHints,
} from "./util.js";
import { acquireParser, releaseParser } from "./util.js";
// Intentionally compile only the imports query locally to avoid compiling
// unrelated queries (which may differ per grammar) and causing warnings.
import {
  extractJsTsSpecifiers,
  extractPythonSpecifiers,
  extractJsTsDynamicSpecifiers,
} from "./util.js";
import {
  type ImportBinding,
  type ProjectIndex,
  type SymbolDef,
  SymbolKind,
} from "./index.js";

export type GraphBuildOptions = {
  fast?: boolean;
  fastRegexDisabledLanguages?: string[];
  resolveNodeModules?: boolean;
  dynamicImportHeuristics?: boolean;
  resolutionHints?: string[];
};

export type FallbackImportExtractionReason =
  | "fast"
  | "query-error"
  | "query-empty";

export type FallbackImportExtractionEvent = {
  file?: string;
  language: string;
  reason: FallbackImportExtractionReason;
};

export type GraphCacheEntry = {
  sig: string;
  gitSig?: string;
  edges: Edge[];
};

export function collectModuleSpecifiersFromSource(
  support: LanguageSupport,
  lang: Parser.Language,
  source: string,
  opts?: {
    tree?: Parser.Tree;
    fast?: boolean;
    file?: string;
    fastRegexDisabledLanguages?: string[];
    onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
  },
): { spec: string; typeOnly?: boolean }[] {
  const out: { spec: string; typeOnly?: boolean }[] = [];
  const fastRegexDisabled = opts?.fastRegexDisabledLanguages?.includes(
    support.id,
  );
  const shouldAttemptFallback =
    support.id === "python"
      ? /\b(import|from)\b/.test(source)
      : /\b(import|export|require)\b/.test(source);
  const reportFallback = (reason: FallbackImportExtractionReason) => {
    const event: FallbackImportExtractionEvent = {
      language: support.id,
      reason,
      ...(opts?.file ? { file: opts.file } : {}),
    };
    opts?.onFallbackImportExtraction?.(event);
  };

  if (support.id === "python") {
    let queryFailed = false;
    try {
      const key = "py";
      const parser = acquireParser(lang, key);
      try {
        parser.setLanguage(lang);
        const tree = opts?.tree ?? parser.parse(source);
        const { imports: q } = getCompiledQueries(lang, support);
        for (const m of q.matches(tree.rootNode)) {
          const caps = Object.fromEntries(
            m.captures.map((x: Parser.QueryCapture) => [x.name, x] as const),
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
              const mm = spec.match(
                /^([A-Za-z_][\w\.]*)(?:\s+as\s+[A-Za-z_][\w_]*)?$/,
              );
              if (mm) out.push({ spec: mm[1]! });
            }
            continue;
          }
          // Handle: from ..pkg.sub import x, y
          const mFrom = /^\s*from\s+(\.*)([A-Za-z_][\w\.]*)?\s+import\b/.exec(
            stmtText,
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
    } catch {
      queryFailed = true;
    }
    // Fallback to regex-based extractor
    if ((queryFailed || out.length === 0) && shouldAttemptFallback) {
      reportFallback(queryFailed ? "query-error" : "query-empty");
      for (const s of extractPythonSpecifiers(source)) out.push({ spec: s });
    }
    return out;
  }

  // Fast path for JS/TS: regex-based extraction after comment stripping
  if (
    (support.id === "ts" || support.id === "js") &&
    opts?.fast &&
    !fastRegexDisabled
  ) {
    try {
      reportFallback("fast");
      for (const s of extractJsTsSpecifiers(source)) out.push(s);
    } catch {}
    return out;
  }

  let queryFailed = false;
  try {
    const key =
      support.id === "python" ? "py" : support.id === "js" ? "js" : "ts";
    const parser = acquireParser(lang, key);
    try {
      parser.setLanguage(lang);
      const tree = opts?.tree ?? parser.parse(source);
      const q = new Parser.Query(lang, support.queries.imports);
      for (const m of q.matches(tree.rootNode)) {
        const caps = Object.fromEntries(
          m.captures.map((x: Parser.QueryCapture) => [x.name, x] as const),
        );
        const modNodes = m.captures.filter(
          (x: Parser.QueryCapture) => x.name === "mod",
        );
        const stmtText = caps["stmt"]
          ? sliceText(caps["stmt"].node, source)
          : "";
        const typeOnly = /^\s*(import|export)\s+type\b/.test(stmtText);
        for (const cap of modNodes)
          out.push({ spec: unquote(sliceText(cap.node, source)), typeOnly });
      }
      if (out.length > 0) return out;
    } finally {
      releaseParser(parser, key);
    }
  } catch (error) {
    queryFailed = true;
    console.warn(
      `Warning: Query error in collectModuleSpecifiersFromSource for ${support.id}:`,
      error,
    );
    // fall through to regex fallback
  }

  // Regex fallback if the query path produced no results
  if (support.id === "ts" || support.id === "js") {
    if ((queryFailed || out.length === 0) && shouldAttemptFallback) {
      reportFallback(queryFailed ? "query-error" : "query-empty");
      try {
        for (const s of extractJsTsSpecifiers(source)) out.push(s);
      } catch {}
    }
  }
  return out;
}

const cloneEdge = (edge: Edge): Edge => ({
  ...edge,
  to:
    edge.to.type === "file"
      ? { type: "file", path: edge.to.path }
      : { type: "external", name: edge.to.name },
});

export async function collectEdgesForFile(
  file: string,
  projectRoot: string,
  workspaceConfig: any,
  opts: {
    parsed?: {
      source: string;
      tree: Parser.Tree;
      sup: LanguageSupport;
      lang: Parser.Language;
    };
    fast?: boolean;
    fastRegexDisabledLanguages?: string[];
    resolveNodeModules?: boolean;
    dynamicImportHeuristics?: boolean;
    resolutionHints?: string[];
    fileSignature?: { sig: string; gitSig?: string; cacheSig?: string };
    cachedFileEdges?: GraphCacheEntry;
    onFileEdges?: (file: string, entry: GraphCacheEntry) => void;
    onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
  },
): Promise<Edge[]> {
  const normalizedFile = file.replace(/\\/g, "/");
  const sigEntry = opts.fileSignature;
  const sig = sigEntry?.sig;
  const gitSig = sigEntry?.gitSig;

  const emitCacheEntry = (edges: Edge[]) => {
    if (!sig || !opts.onFileEdges) return;
    opts.onFileEdges(normalizedFile, {
      sig,
      ...(gitSig ? { gitSig } : {}),
      edges: edges.map(cloneEdge),
    });
  };

  const cached =
    sig || gitSig ? opts.cachedFileEdges : undefined;
  const matchesGitSig =
    !!gitSig && !!cached?.gitSig && cached.gitSig === gitSig;
  const matchesSig = !!sig && !!cached && cached.sig === sig;

  if (cached && (matchesGitSig || matchesSig)) {
    const cloned = cached.edges.map(cloneEdge);
    emitCacheEntry(cloned);
    return cloned;
  }

  const parsed = opts.parsed;
  let sup = parsed?.sup;
  let lang = parsed?.lang;
  let src = parsed?.source;
  if (!sup || !lang || src === undefined) {
    const prep = await prepareParserInput(file);
    sup = prep.sup;
    lang = prep.lang;
    src = prep.source;
  }

  const fast = !!opts.fast;
  const specs = collectModuleSpecifiersFromSource(
    sup,
    lang,
    src,
    {
      ...(parsed?.tree ? { tree: parsed.tree } : {}),
      fast,
      file: normalizedFile,
      ...(opts.fastRegexDisabledLanguages
        ? { fastRegexDisabledLanguages: opts.fastRegexDisabledLanguages }
        : {}),
      ...(opts.onFallbackImportExtraction
        ? { onFallbackImportExtraction: opts.onFallbackImportExtraction }
        : {}),
    },
  );

  if (
    (sup.id === "ts" || sup.id === "js") &&
    opts.dynamicImportHeuristics
  ) {
    const dynamicSpecs = extractJsTsDynamicSpecifiers(
      src,
      normalizedFile,
      projectRoot,
    );
    if (dynamicSpecs.length > 0) {
      const existing = new Set(specs.map((entry) => entry.spec));
      for (const entry of dynamicSpecs) {
        if (existing.has(entry.spec)) continue;
        existing.add(entry.spec);
        specs.push(entry);
      }
    }
  }

  const { matchPath } =
    sup.id === "ts" ? await loadNearestTsconfigFor(file) : { matchPath: undefined };
  const resolveOptions = {
    resolveNodeModules: !!opts.resolveNodeModules,
    ...(opts.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
    ...(matchPath ? { matchPath } : {}),
    ...(workspaceConfig ? { workspaceConfig } : {}),
  };

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
        relDots,
      );
      to =
        typeof res === "string"
          ? { type: "file", path: res.replace(/\\/g, "/") }
          : { type: "external", name: res.external };
    } else if (sup.id === "go") {
      const res = await resolveImportSpecifier(projectRoot, file, spec, sup.id, {
        matchPath,
        workspaceConfig,
        resolveNodeModules: !!opts.resolveNodeModules,
        ...(opts.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
      });
      to =
        typeof res === "string"
          ? { type: "file", path: res.replace(/\\/g, "/") }
          : { type: "external", name: res.external };
    } else if (["java", "csharp", "ruby", "rust"].includes(sup.id)) {
      const { resolvePathLikeModule } = await import("./util.js");
      const res = await resolvePathLikeModule(projectRoot, spec);
      if (res) {
        to = { type: "file", path: res.replace(/\\/g, "/") };
      } else {
        // Fallback to resolveSpecifier for relative paths like ./foo
        const res2 = await resolveSpecifier(file, spec, projectRoot, resolveOptions);
        to =
          typeof res2 === "string"
            ? { type: "file", path: res2.replace(/\\/g, "/") }
            : { type: "external", name: res2.external };
      }
    } else {
      const res = await resolveSpecifier(file, spec, projectRoot, resolveOptions);
      to =
        typeof res === "string"
          ? { type: "file", path: res.replace(/\\/g, "/") }
          : { type: "external", name: res.external };
    }
    edges.push({
      from: normalizedFile,
      to,
      raw: spec,
      ...(typeOnly !== undefined && { typeOnly }),
    });
  }
  emitCacheEntry(edges);
  return edges;
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
    fastRegexDisabledLanguages?: string[];
    threads?: number;
    resolveNodeModules?: boolean;
    dynamicImportHeuristics?: boolean;
    resolutionHints?: string[];
    fileSignatures?: Map<string, { sig: string; gitSig?: string; cacheSig?: string }>;
    cachedFileEdges?: Map<string, GraphCacheEntry>;
    onFileEdges?: (file: string, entry: GraphCacheEntry) => void;
    onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
    baseGraph?: Graph;
    replaceFiles?: Set<string>;
  },
): Promise<Graph> {
  const normalizePath = (file: string) => file.replace(/\\/g, "/");
  const normalizedFiles = files.map(normalizePath);
  const hasExplicitReplace = !!opts?.replaceFiles;
  const replaceSet = hasExplicitReplace
    ? new Set(Array.from(opts.replaceFiles ?? [], (file) => normalizePath(file)))
    : new Set<string>(normalizedFiles);
  const baseGraph = opts?.baseGraph;
  const graph: Graph = baseGraph
    ? {
        nodes: new Set(baseGraph.nodes),
        edges: baseGraph.edges.filter((edge) => !replaceSet.has(edge.from)),
      }
    : { nodes: new Set(normalizedFiles), edges: [] };
  for (const file of normalizedFiles) graph.nodes.add(file);
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);
  const resolutionHints = normalizeResolutionHints(opts?.resolutionHints);

  const conc = Math.max(1, Math.min(Number(opts?.threads || 0) || 32, 128));

  const addEdgeTargetsToGraph = (edges: Edge[]) => {
    for (const edge of edges) {
      if (edge.to.type === "file") graph.nodes.add(edge.to.path);
    }
  };

  if (graph.edges.length > 0) {
    addEdgeTargetsToGraph(graph.edges);
  }

  async function mapLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
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
      const normalizedFile = file.replace(/\\/g, "/");
      const sigEntry = opts?.fileSignatures?.get(normalizedFile);
      const shouldReplace = hasExplicitReplace && replaceSet.has(normalizedFile);
      const cachedFileEdges = !shouldReplace ? opts?.cachedFileEdges?.get(normalizedFile) : undefined;
      const parsedEntry = opts?.parsed?.get(file);
      const edges = await collectEdgesForFile(
        file,
        projectRoot,
        workspaceConfig,
        {
          ...(parsedEntry ? { parsed: parsedEntry } : {}),
          fast: !!opts?.fast,
          ...(opts?.fastRegexDisabledLanguages
            ? { fastRegexDisabledLanguages: opts.fastRegexDisabledLanguages }
            : {}),
          resolveNodeModules: !!opts?.resolveNodeModules,
          dynamicImportHeuristics: !!opts?.dynamicImportHeuristics,
          ...(opts?.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
          ...(sigEntry ? { fileSignature: sigEntry } : {}),
          ...(cachedFileEdges ? { cachedFileEdges } : {}),
          ...(opts?.onFileEdges ? { onFileEdges: opts.onFileEdges } : {}),
          ...(opts?.onFallbackImportExtraction
            ? { onFallbackImportExtraction: opts.onFallbackImportExtraction }
            : {}),
        },
      );
      addEdgeTargetsToGraph(edges);
      return edges;
    } catch (error) {
      console.warn(`Warning: Failed to process file ${file} for graph:`, error);
      return [] as Edge[];
    }
  });

  const allEdges = filePromises;
  const newEdges = allEdges.flat();
  graph.edges = [...graph.edges, ...newEdges];
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
      };`,
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

export type TextGrepHit = {
  file: string;
  line: number;
  column: number;
  match: string;
  snippet: string;
};

export async function astGrep(
  projectRoot: string,
  querySource: string,
  patterns = [
    "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py,vue,svelte,go,java,cs,rb,rs,html,htm,css,scss,less}",
  ],
): Promise<AstGrepHit[]> {
  const hits: AstGrepHit[] = [];
  const files = await listProjectFiles(projectRoot, patterns);
  for (const file of files) {
    try {
      const prep = await prepareParserInput(file);
      const lang = prep.lang;
      const sup = prep.sup;
      const key = sup.id === "python" ? "py" : sup.id === "js" ? "js" : "ts";
      const parser = acquireParser(lang, key);
      parser.setLanguage(lang);
      const src = prep.source;
      const tree = parser.parse(src);
      const query = new Parser.Query(lang, querySource);
      for (const m of query.matches(tree.rootNode)) {
        for (const cap of m.captures) {
          const p = cap.node.startPosition;
          hits.push({
            file: path.relative(projectRoot, file).replace(/\\/g, "/"),
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
        error,
      );
    }
  }
  return hits;
}

export async function textGrep(
  projectRoot: string,
  patternSource: string,
  patterns = [
    "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py,vue,svelte,go,java,cs,rb,rs,html,htm,css,scss,less}",
  ],
  opts?: {
    ignoreCase?: boolean;
    maxHits?: number;
  },
): Promise<TextGrepHit[]> {
  const maxHits = Math.max(1, Math.min(opts?.maxHits ?? 5000, 200_000));
  const flags = `g${opts?.ignoreCase ? "i" : ""}`;

  let re: RegExp;
  try {
    re = new RegExp(patternSource, flags);
  } catch (e) {
    throw new Error(
      `Invalid regex for textGrep: ${patternSource} (${(e as any)?.message ?? String(e)})`,
    );
  }

  const hits: TextGrepHit[] = [];
  const files = await listProjectFiles(projectRoot, patterns);
  for (const file of files) {
    if (hits.length >= maxHits) break;
    let src: string;
    try {
      src = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(projectRoot, file).replace(/\\/g, "/");
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= maxHits) break;
      const lineText = lines[i]!;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lineText)) !== null) {
        hits.push({
          file: rel,
          line: i + 1,
          column: (m.index ?? 0) + 1,
          match: m[0] ?? "",
          snippet: lineText.trim().slice(0, 240),
        });
        if (hits.length >= maxHits) break;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  return hits;
}

// --------------------------- Dependency query helpers ---------------------------

export type DependencyNode = { file: FileId; depth: number };

export function getDependencies(
  graph: Graph,
  startFile: FileId,
  opts: { depth?: number } = {},
): DependencyNode[] {
  const maxDepth = opts.depth ?? Number.POSITIVE_INFINITY;
  const out: DependencyNode[] = [];
  const visited = new Set<string>();
  const queue: Array<{ f: string; d: number }> = [{ f: startFile, d: 0 }];
  visited.add(startFile);

  let qi = 0;
  while (qi < queue.length) {
    const { f, d } = queue[qi++]!;
    if (d > 0) out.push({ file: f, depth: d });
    if (d >= maxDepth) continue;

    for (const edge of graph.edges) {
      if (edge.from === f && edge.to.type === "file") {
        if (!visited.has(edge.to.path)) {
          visited.add(edge.to.path);
          queue.push({ f: edge.to.path, d: d + 1 });
        }
      }
    }
  }
  return out;
}

export function getReverseDependencies(
  graph: Graph,
  targetFile: FileId,
  opts: { depth?: number } = {},
): DependencyNode[] {
  const maxDepth = opts.depth ?? Number.POSITIVE_INFINITY;
  const out: DependencyNode[] = [];
  const visited = new Set<string>();
  const queue: Array<{ f: string; d: number }> = [{ f: targetFile, d: 0 }];
  visited.add(targetFile);

  let qi = 0;
  while (qi < queue.length) {
    const { f, d } = queue[qi++]!;
    if (d > 0) out.push({ file: f, depth: d });
    if (d >= maxDepth) continue;

    for (const edge of graph.edges) {
      if (edge.to.type === "file" && edge.to.path === f) {
        if (!visited.has(edge.from)) {
          visited.add(edge.from);
          queue.push({ f: edge.from, d: d + 1 });
        }
      }
    }
  }
  return out;
}

export function getShortestPath(
  graph: Graph,
  from: FileId,
  to: FileId,
): FileId[] | null {
  const visited = new Map<string, string | null>();
  const queue: string[] = [from];
  visited.set(from, null);

  let qi = 0;
  while (qi < queue.length) {
    const curr = queue[qi++]!;
    if (curr === to) {
      const path: string[] = [];
      let p: string | null = curr;
      while (p !== null) {
        path.push(p);
        p = visited.get(p)!;
      }
      return path.reverse();
    }

    for (const edge of graph.edges) {
      if (edge.from === curr && edge.to.type === "file") {
        if (!visited.has(edge.to.path)) {
          visited.set(edge.to.path, curr);
          queue.push(edge.to.path);
        }
      }
    }
  }
  return null;
}

export function findCycles(graph: Graph): FileId[][] {
  const nodes = Array.from(graph.nodes);
  const indexMap = new Map<string, number>();
  nodes.forEach((n, i) => indexMap.set(n, i));

  const adj = nodes.map(() => [] as number[]);
  for (const e of graph.edges) {
    if (e.to.type === "file") {
      const u = indexMap.get(e.from);
      const v = indexMap.get(e.to.path);
      if (u !== undefined && v !== undefined) adj[u]!.push(v);
    }
  }

  const n = nodes.length;
  const indices = new Array(n).fill(-1);
  const lowlink = new Array(n).fill(-1);
  const onStack = new Array(n).fill(false);
  const stack: number[] = [];
  let index = 0;
  const sccs: number[][] = [];

  function strongconnect(v: number) {
    indices[v] = index;
    lowlink[v] = index;
    index++;
    stack.push(v);
    onStack[v] = true;

    for (const w of adj[v]!) {
      if (indices[w] === -1) {
        strongconnect(w);
        lowlink[v] = Math.min(lowlink[v], lowlink[w]);
      } else if (onStack[w]) {
        lowlink[v] = Math.min(lowlink[v], indices[w]);
      }
    }

    if (lowlink[v] === indices[v]) {
      const scc: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack[w] = false;
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1 || adj[v]!.includes(v)) {
        sccs.push(scc);
      }
    }
  }

  for (let i = 0; i < n; i++) {
    if (indices[i] === -1) strongconnect(i);
  }

  return sccs.map((scc) => scc.map((idx) => nodes[idx]!));
}

export function getUnresolvedImports(graph: Graph): Array<{
  name: string;
  importers: Array<{ file: FileId; raw: string }>;
}> {
  const unresolved = new Map<string, Array<{ file: FileId; raw: string }>>();
  for (const edge of graph.edges) {
    if (edge.to.type === "external") {
      const name = edge.to.name;
      const list = unresolved.get(name) || [];
      list.push({ file: edge.from, raw: edge.raw });
      unresolved.set(name, list);
    }
  }
  return Array.from(unresolved.entries())
    .map(([name, importers]) => ({ name, importers }))
    .sort((a, b) => b.importers.length - a.importers.length);
}

export function getHotspots(graph: Graph): Array<{
  file: FileId;
  fanIn: number;
  fanOut: number;
  score: number;
}> {
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();

  for (const node of graph.nodes) {
    fanIn.set(node, 0);
    fanOut.set(node, 0);
  }

  for (const edge of graph.edges) {
    fanOut.set(edge.from, (fanOut.get(edge.from) || 0) + 1);
    if (edge.to.type === "file") {
      fanIn.set(edge.to.path, (fanIn.get(edge.to.path) || 0) + 1);
    }
  }

  return Array.from(graph.nodes)
    .map((file) => {
      const fi = fanIn.get(file) || 0;
      const fo = fanOut.get(file) || 0;
      return {
        file,
        fanIn: fi,
        fanOut: fo,
        score: fi * 2 + fo, // Heuristic: fan-in is more important
      };
    })
    .sort((a, b) => b.score - a.score);
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
  docstring?: string;
  lineSpan?: number;
  complexity?: number;
};
export type SymbolEdge = { from: string; to: string; label?: string };
export type SymbolGraph = {
  nodes: Map<string, SymbolNode>;
  edges: SymbolEdge[];
};

function defNodeId(def: {
  file: string;
  localName: string;
  range?: { start: { index?: number } };
}) {
  const idx = def.range?.start?.index ?? 0;
  const f =
    typeof def.file === "string" ? def.file.replace(/\\/g, "/") : def.file;
  return `${f}::${def.localName}::${idx}`;
}

function nodeForDef(def: {
  file: string;
  localName: string;
  kind: string;
  range?: { start: { index?: number } };
  docstring?: string;
  lineSpan?: number;
  complexity?: number;
}): SymbolNode {
  return {
    id: defNodeId(def),
    file: def.file,
    name: def.localName,
    kind: (def.kind as SymbolNodeKind) ?? "variable",
    ...(def.docstring ? { docstring: def.docstring } : {}),
    ...(def.lineSpan ? { lineSpan: def.lineSpan } : {}),
    ...(typeof def.complexity === "number"
      ? { complexity: def.complexity }
      : {}),
  };
}

export async function buildSymbolGraph(
  index: ProjectIndex,
): Promise<SymbolGraph> {
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
            (e) => e.type === "local" && e.exportedAs === imp.imported,
          );
          if (!exp) {
            // fallback: match local by name
            const loc = targetMod.locals.find(
              (l) => l.localName === imp.imported,
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
            (e) => e.type === "local" && e.exportedAs === "default",
          );
          if (!exp) exp = targetMod.exports.find((e) => e.type === "local");
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
            (e) => e.type === "local",
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
  },
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
      label ? { from: fromId, to: toId, label } : { from: fromId, to: toId },
    );
    edgeCount++;
    return true;
  };
  const recordEdge = (fromId: string, toId: string, label?: string) => {
    const key = `${fromId}->${toId}::${label ?? ""}`;
    if (added.has(key)) return true;
    added.add(key);
    return maybePushEdge(fromId, toId, label);
  };

  const isIdentifierType = (sup: LanguageSupport, t: string) =>
    Array.isArray(sup.nodeTypes?.identifier) &&
    sup.nodeTypes.identifier.includes(t);

  // Resolve an exported symbol definition from a module file, following re-exports recursively
  const resolveExportFrom = (
    file: string,
    exportedName: string,
    cache: Map<string, SymbolDef | null> = new Map(),
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
      if (e.type === "local" && e.exportedAs === exportedName) {
        const res = e.target;
        cache.set(key, res);
        return res;
      }
    // Namespace re-export
    for (const e of mod.exports)
      if (e.type === "namespaceReexport" && e.exportedAs === exportedName) {
        // This is tricky: we return a placeholder def for the module itself?
        // Or we should let the caller handle it.
        // For now, let's return a dummy def pointing to the module start.
        const res: SymbolDef = {
          file: e.fromModule.replace(/\\/g, "/"),
          localName: exportedName,
          kind: SymbolKind.Variable,
          range: {
            start: { line: 1, column: 1, index: 0 },
            end: { line: 1, column: 1, index: 0 },
          },
        };
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
            cache,
          ) || resolveExportFrom(e.fromModule, exportedName, cache);
        if (down) {
          cache.set(key, down);
          return down;
        }
      }
    // export * from '...'
    for (const e of mod.exports)
      if (e.type === "exportStar" && typeof e.fromModule === "string") {
        const down = resolveExportFrom(e.fromModule, exportedName, cache);
        if (down) {
          cache.set(key, down);
          return down;
        }
      }
    // Fallback: treat local with same name as exported (Python or missing export metadata)
    const local = mod.locals.find((l) => l.localName === exportedName);
    if (local) {
      cache.set(key, local);
      return local;
    }
    cache.set(key, null);
    return null;
  };

  for (const [file, mod] of index.byFile) {
    if (scopeMode === "imported") {
      const hasFuncOrClass = mod.locals.some(
        (l) => l.kind === "function" || l.kind === "class",
      );
      const isImportedOrImports =
        importedByOthers.has(normalizePath(file)) || mod.imports.length > 0;
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
            tmod.exports.find((e) => e.type === "local")?.target;
          if (def) aliasToTargetDef.set(imp.local, def);
          // Also treat default imports as potential namespace holders for member usage (u.helper())
          aliasToTargetModule.set(imp.local, targetFile);
        } else if (imp.kind === "namespace") {
          aliasToTargetModule.set(imp.localNS, targetFile);
        }
      }

      // Collect function-like declarations (JS/TS: function_declaration, arrow/function expressions bound to vars; Python: function_definition)
      const functionNodes: Array<{
        name: string;
        node: Parser.SyntaxNode;
        def: SymbolDef;
      }> = [];
      const classNodes: Array<{
        name: string;
        node: Parser.SyntaxNode;
        def: SymbolDef;
      }> = [];
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
          n.type === "function_definition" ||
          n.type === "method_declaration" ||
          n.type === "constructor_declaration" ||
          n.type === "function_item" ||
          n.type === "method" ||
          n.type === "singleton_method"
        ) {
          const nameNode =
            n.childForFieldName("name") ??
            n.childForFieldName("type");
          const name = nameNode ? sliceText(nameNode, src) : undefined;
          if (name) {
            const def = mod.locals.find((d) => d.localName === name);
            if (def) functionNodes.push({ name, node: n, def });
          }
        } else if (
          n.type === "class_declaration" ||
          n.type === "class_definition" ||
          n.type === "class"
        ) {
          const nameNode = n.childForFieldName("name");
          const name = nameNode ? sliceText(nameNode, src) : undefined;
          if (name) {
            const def = mod.locals.find((d) => d.localName === name);
            if (def) classNodes.push({ name, node: n, def });
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
        cb: (name: string, atNode: Parser.SyntaxNode) => void,
      ) => {
        if (isIdentifierType(sup, node.type)) {
          const name = sliceText(node, src);
          cb(name, node);
        }
        for (const ch of node.namedChildren) scanForAliasUse(ch, cb);
      };

      const resolveIdentifier = (name: string): SymbolDef | null => {
        const fromAlias = aliasToTargetDef.get(name);
        if (fromAlias) return fromAlias;
        return mod.locals.find((d) => d.localName === name) ?? null;
      };

      const tryResolveNode = (
        node: Parser.SyntaxNode,
        fromId: string,
        label: string,
      ) => {
        if (isIdentifierType(sup, node.type) || node.type === "type_identifier") {
          const name = sliceText(node, src);
          const target = resolveIdentifier(name);
          if (target) {
            const toId = defNodeId(target);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
            recordEdge(fromId, toId, label);
            return;
          }
        }
        if (optionalMemberTypes.has(node.type)) {
          tryResolveChain(node, fromId, label);
        }
      };

      const callNodeTypes = new Set<string>([
        "call_expression",
        "call",
        "method_invocation",
        "invocation_expression",
      ]);
      const newNodeTypes = new Set<string>([
        "new_expression",
        "object_creation_expression",
        "struct_expression",
        "composite_literal",
      ]);

      const getCallTarget = (n: Parser.SyntaxNode): Parser.SyntaxNode | null => {
        const explicitTarget =
          n.childForFieldName("function") ??
          n.childForFieldName("callee") ??
          n.childForFieldName("name") ??
          n.childForFieldName("method") ??
          n.childForFieldName("member") ??
          n.childForFieldName("expression");
        if (explicitTarget) return explicitTarget;
        const nonArgumentChildren = n.namedChildren.filter(
          (ch) => ch.type !== "argument_list",
        );
        return nonArgumentChildren.length === 1
          ? nonArgumentChildren[0] ?? null
          : null;
      };

      const getNewTarget = (n: Parser.SyntaxNode) =>
        n.childForFieldName("constructor") ??
        n.childForFieldName("type") ??
        n.childForFieldName("name") ??
        n.namedChildren.find((ch) => ch.type === "type_identifier") ??
        n.child(0);

      const tryResolveChain = (
        node: Parser.SyntaxNode,
        fromId?: string,
        label = "uses",
      ) => {
        const names: string[] = [];
        let cur: Parser.SyntaxNode | null = node;
        let base: Parser.SyntaxNode | null = null;
        const pushProp = (p: Parser.SyntaxNode | null) => {
          if (!p) return;
          if (propertyIdentifierTypes.includes(p.type))
            names.push(sliceText(p, src));
          else if (p.type === "string") names.push(unquote(sliceText(p, src)));
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
              (e.type === "namespaceReexport" ||
                (e.type === "reexport" && e.sourceSpecifier === "")) &&
              e.exportedAs === seg,
          );
          if (
            nsReexport &&
            (nsReexport.type === "reexport" ||
              nsReexport.type === "namespaceReexport") &&
            typeof nsReexport.fromModule === "string"
          ) {
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
          if (!recordEdge(fromId, toId, label)) return true;
          return true;
        }
        return !!targetDef;
      };

      // Collect Python decorators on functions and add uses edges
      if (sup.id === "python") {
        const addDecoratorUses = (n: Parser.SyntaxNode) => {
          if (n.type === "decorated_definition") {
            const fn = n.namedChildren.find(
              (child) => child.type === "function_definition",
            );
            if (fn) addDecoratorUses(fn);
            for (const d of n.namedChildren) {
              if (d.type !== "decorator") continue;
              const nameNode = fn?.childForFieldName("name");
              if (!nameNode) continue;
              const name = sliceText(nameNode, src);
              const def = mod.locals.find((l) => l.localName === name);
              if (!def) continue;
              const fromId = defNodeId(def);
              if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(def));
              const expr =
                d.childForFieldName?.("name") ??
                d.namedChildren?.[0] ??
                d.child(1);
              if (expr) tryResolveNode(expr, fromId, "decorates");
            }
          } else if (n.type === "function_definition") {
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
                          d.namedChildren?.[0] ??
                          d.child(1);
                        if (expr) tryResolveNode(expr, fromId, "decorates");
                      } else if (d.type === "attribute") {
                        tryResolveNode(d, fromId, "decorates");
                      }
                    }
                  } else if (prev.type === "decorator") {
                    const expr =
                      prev.childForFieldName?.("name") ??
                      prev.namedChildren?.[0] ??
                      prev.child(1);
                    if (expr) tryResolveNode(expr, fromId, "decorates");
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
          scanForAliasUse(
            fn.node,
            (name: string, atNode: Parser.SyntaxNode) => {
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
                      target =
                        (m?.locals ?? []).find(
                          (l: SymbolDef) => l.localName === exportedName,
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
              if (!recordEdge(fromId, toId, "uses")) return;
            },
          );

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
                  e.sourceSpecifier === "",
              );
              if (
                nsReexport &&
                nsReexport.type === "reexport" &&
                typeof nsReexport.fromModule === "string"
              ) {
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
                  (m.locals as SymbolDef[]).find((l) => l.localName === last) ??
                  null;
            }
            if (targetDef) {
              const toId = defNodeId(targetDef);
              if (!nodes.has(toId)) nodes.set(toId, nodeForDef(targetDef));
              if (!recordEdge(fromId, toId, "uses")) return;
            }
          };

          if (optionalMemberTypes.has(n.type)) tryResolveChainLocal(n);
          for (const ch of n.namedChildren ?? []) walkForMembers(ch);
        };
        walkForMembers(fn.node);

        const walkForCalls = (n: Parser.SyntaxNode) => {
          if (callNodeTypes.has(n.type)) {
            if (sup.id === "go") {
              const callTarget = getCallTarget(n);
              const calleeName =
                callTarget && isIdentifierType(sup, callTarget.type)
                  ? sliceText(callTarget, src)
                  : null;
              if (calleeName === "new" || calleeName === "make") {
                const argList =
                  n.childForFieldName("arguments") ??
                  n.childForFieldName("argument_list");
                const typeNode =
                  argList?.namedChildren?.find(
                    (child) => child.type === "type_identifier",
                  ) ?? null;
                if (typeNode) {
                  tryResolveNode(typeNode, fromId, "instantiates");
                }
                return;
              }
            }
            if (sup.id === "ruby" && n.type === "call") {
              const methodNode = n.childForFieldName("method");
              const receiverNode = n.childForFieldName("receiver");
              const methodName = methodNode ? sliceText(methodNode, src) : null;
              if (methodName === "new" && receiverNode) {
                tryResolveNode(receiverNode, fromId, "instantiates");
                return;
              }
              if (methodNode) {
                tryResolveNode(methodNode, fromId, "calls");
                return;
              }
            }
            const callee = getCallTarget(n);
            if (callee) tryResolveNode(callee, fromId, "calls");
          }
          if (newNodeTypes.has(n.type)) {
            const target = getNewTarget(n);
            if (target) tryResolveNode(target, fromId, "instantiates");
          }
          for (const ch of n.namedChildren ?? []) walkForCalls(ch);
        };
        walkForCalls(fn.node);
      }

      const collectIdentifiers = (n: Parser.SyntaxNode, out: string[]) => {
        if (isIdentifierType(sup, n.type) || n.type === "type_identifier") {
          out.push(sliceText(n, src));
        }
        for (const ch of n.namedChildren ?? []) collectIdentifiers(ch, out);
      };

      const findFirstNodeByType = (
        node: Parser.SyntaxNode,
        type: string,
      ): Parser.SyntaxNode | null => {
        for (const ch of node.namedChildren ?? []) {
          if (ch.type === type) return ch;
          const found = findFirstNodeByType(ch, type);
          if (found) return found;
        }
        return null;
      };

      const collectNodesByType = (
        node: Parser.SyntaxNode,
        type: string,
        out: Parser.SyntaxNode[],
      ) => {
        for (const ch of node.namedChildren ?? []) {
          if (ch.type === type) out.push(ch);
          collectNodesByType(ch, type, out);
        }
      };

      for (const cls of classNodes) {
        const fromId = defNodeId(cls.def);
        if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(cls.def));
        if (sup.id === "java") {
          const superClass = findFirstNodeByType(cls.node, "superclass");
          const superNode =
            superClass?.childForFieldName("name") ??
            superClass?.namedChildren?.[0] ??
            null;
          if (superNode) tryResolveNode(superNode, fromId, "extends");

          const interfaces = findFirstNodeByType(cls.node, "super_interfaces");
          if (interfaces) {
            const names: string[] = [];
            collectIdentifiers(interfaces, names);
            for (const name of names) {
              const target = resolveIdentifier(name);
              if (!target) continue;
              const toId = defNodeId(target);
              if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
              recordEdge(fromId, toId, "implements");
            }
          }
          continue;
        }

        if (sup.id === "csharp") {
          const baseList = findFirstNodeByType(cls.node, "base_list");
          if (baseList) {
            const names: string[] = [];
            collectIdentifiers(baseList, names);
            names.forEach((name, idx) => {
              const target = resolveIdentifier(name);
              if (!target) return;
              const toId = defNodeId(target);
              if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
              recordEdge(fromId, toId, idx === 0 ? "extends" : "implements");
            });
          }
          continue;
        }

        const superClause = findFirstNodeByType(cls.node, "extends_clause");
        const superNode =
          superClause?.namedChildren?.[0] ?? superClause?.child(1);
        if (superNode) tryResolveNode(superNode, fromId, "extends");

        const implementsClauses: Parser.SyntaxNode[] = [];
        collectNodesByType(cls.node, "implements_clause", implementsClauses);
        for (const clause of implementsClauses) {
          const names: string[] = [];
          collectIdentifiers(clause, names);
          for (const name of names) {
            const target = resolveIdentifier(name);
            if (!target) continue;
            const toId = defNodeId(target);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
            recordEdge(fromId, toId, "implements");
          }
        }
      }

      if (sup.id === "rust") {
        const walkImpls = (node: Parser.SyntaxNode) => {
          if (node.type === "impl_item") {
            const typeIdentifiers =
              node.namedChildren?.filter((child) => child.type === "type_identifier") ??
              [];
            if (typeIdentifiers.length >= 2) {
              const traitName = sliceText(typeIdentifiers[0], src);
              const typeName = sliceText(typeIdentifiers[1], src);
              const typeDef = resolveIdentifier(typeName);
              const traitDef = resolveIdentifier(traitName);
              if (typeDef && traitDef) {
                const fromId = defNodeId(typeDef);
                const toId = defNodeId(traitDef);
                if (!nodes.has(fromId))
                  nodes.set(fromId, nodeForDef(typeDef));
                if (!nodes.has(toId))
                  nodes.set(toId, nodeForDef(traitDef));
                recordEdge(fromId, toId, "implements");
              }
            }
          }
          for (const ch of node.namedChildren ?? []) walkImpls(ch);
        };
        walkImpls(tree.rootNode);
      }
    } catch (error) {
      console.warn(
        `Warning: Failed to build detailed symbol edges for ${file}:`,
        error,
      );
    }
  }

  return { nodes, edges };
}

export function graphToMermaidSymbols(
  sg: SymbolGraph,
  projectRoot?: string,
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
  projectRoot?: string,
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
      };`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}

export function graphToMermaidSymbolsWithFiles(
  sg: SymbolGraph,
  fg: Graph,
  projectRoot?: string,
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
  projectRoot?: string,
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
      }];`,
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
      };`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}
