#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import {
  listProjectFiles,
  listChangedFiles,
  collectGraph,
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildReviewReport,
  goToDefinition,
  findReferences,
  graphToMermaid,
  graphToDOT,
  astGrep,
  buildSymbolGraph,
  buildSymbolGraphDetailed,
  graphToMermaidSymbols,
  graphToDOTSymbols,
  graphToMermaidSymbolsWithFiles,
  graphToDOTSymbolsWithFiles,
  analyzeImpactFromDiff,
  chunkFile,
  chunkTextFile,
  chunkSFCFile,
  LANG_CONFIGS,
} from "./index.js";
import type {
  Graph,
  SymbolGraph,
  SymbolNodeKind,
  ImpactReport,
  CompactImpactReport,
  ChangedSymbol,
  ImpactItem,
} from "./index.js";

function toJSON(obj: any) {
  return JSON.stringify(obj, null, 2);
}
let stderrFilePath: string | undefined;
function writeStdoutLine(message: string) {
  process.stdout.write(`${message}\n`);
}
function writeJSONLine(value: unknown) {
  writeStdoutLine(toJSON(value));
}
function writeStderrLine(message: string) {
  process.stderr.write(`${message}\n`);
  try {
    if (stderrFilePath) fs.appendFileSync(stderrFilePath, `${message}\n`, {
      encoding: "utf8",
    });
  } catch {
    // Swallow file logging errors to avoid masking primary error output
  }
}
function writeError(error: unknown) {
  if (error instanceof Error) {
    writeStderrLine(error.stack ?? error.message);
    return;
  }
  writeStderrLine(String(error));
}

// Compact JSON helpers to reduce repeated strings in graph output
function compactGraphWithSymbols(
  fgraph: { nodes: Set<string>; edges: Array<any> },
  sgraph: { nodes: Map<string, any>; edges: Array<any> }
) {
  const files = [...fgraph.nodes];
  const fileIndex = new Map<string, number>();
  for (let i = 0; i < files.length; i++) fileIndex.set(files[i]!, i);

  const fileEdges = fgraph.edges.map((e: any) => ({
    from: fileIndex.get(e.from)!,
    to:
      e.to?.type === "file"
        ? { type: "file", path: fileIndex.get(e.to.path)! }
        : e.to,
    raw: e.raw,
    ...(e.typeOnly !== undefined ? { typeOnly: e.typeOnly } : {}),
  }));

  const symbolIds = [...sgraph.nodes.keys()];
  const symbolIndex = new Map<string, number>();
  for (let i = 0; i < symbolIds.length; i++) symbolIndex.set(symbolIds[i]!, i);

  const symbols = symbolIds.map((id) => {
    const n = sgraph.nodes.get(id)!;
    return {
      id: symbolIndex.get(id)!,
      file: fileIndex.get(n.file)!,
      name: n.name,
      kind: n.kind,
    } as any;
  });

  const symbolEdges = sgraph.edges.map((e: any) => ({
    from: symbolIndex.get(e.from)!,
    to: symbolIndex.get(e.to)!,
    ...(e.label ? { label: e.label } : {}),
  }));

  return {
    files,
    fileEdges,
    symbols,
    symbolEdges,
    symbolIdIndex: symbolIds,
  };
}

function compactSymbolsOnly(
  allFiles: string[],
  sgraph: { nodes: Map<string, any>; edges: Array<any> }
) {
  const fileIndex = new Map<string, number>();
  for (let i = 0; i < allFiles.length; i++) fileIndex.set(allFiles[i]!, i);

  const symbolIds = [...sgraph.nodes.keys()];
  const symbolIndex = new Map<string, number>();
  for (let i = 0; i < symbolIds.length; i++) symbolIndex.set(symbolIds[i]!, i);

  const symbols = symbolIds.map((id) => {
    const n = sgraph.nodes.get(id)!;
    return {
      id: symbolIndex.get(id)!,
      file: fileIndex.get(n.file)!,
      name: n.name,
      kind: n.kind,
    } as any;
  });

  const symbolEdges = sgraph.edges.map((e: any) => ({
    from: symbolIndex.get(e.from)!,
    to: symbolIndex.get(e.to)!,
    ...(e.label ? { label: e.label } : {}),
  }));

  return {
    files: allFiles,
    symbols,
    symbolEdges,
    symbolIdIndex: symbolIds,
  };
}

const SYMBOL_NODE_KINDS: SymbolNodeKind[] = [
  "function",
  "class",
  "variable",
  "interface",
  "type",
  "default",
  "import",
  "namespaceImport",
];

function symbolNodeKindFromString(kind?: string): SymbolNodeKind {
  return kind && SYMBOL_NODE_KINDS.includes(kind as SymbolNodeKind)
    ? (kind as SymbolNodeKind)
    : "variable";
}

function ensureImpactReport(
  report: ImpactReport | CompactImpactReport
): ImpactReport {
  if (!("files" in report)) return report;
  const files = report.files;
  const resolveFilePath = (index: number): string => {
    const file = files[index];
    if (!file) {
      throw new Error(`Missing file path for index ${index} in compact impact report`);
    }
    return file;
  };
  const changedFiles = report.changedFiles.map((cf) => ({
    file: resolveFilePath(cf.file),
    hunks: cf.hunks,
  }));
  const changedSymbols = report.changedSymbols.map((cs) => {
    const symbol: ChangedSymbol = {
      id: cs.id,
      file: resolveFilePath(cs.file),
      name: cs.name,
      kind: cs.kind,
      exported: cs.exported,
      range: cs.range,
      ...(cs.typeOnly !== undefined ? { typeOnly: cs.typeOnly } : {}),
    };
    return symbol;
  });
  const impacted: ImpactItem[] = report.impacted.map((item) => {
    const impact: ImpactItem = {
      file: resolveFilePath(item.file),
      symbols: item.symbols,
      reasons: item.reasons,
      severity: item.severity,
    };
    if (item.depth !== undefined) impact.depth = item.depth;
    if (item.typeOnly !== undefined) impact.typeOnly = item.typeOnly;
    if (item.explain !== undefined) impact.explain = item.explain;
    const maybeRefs = (item as any).refs;
    if (maybeRefs !== undefined) impact.refs = maybeRefs;
    return impact;
  });
  const fileEdges = report.graph.fileEdges.map((edge) => ({
    from: resolveFilePath(edge.from),
    to: resolveFilePath(edge.to),
    ...(edge.typeOnly !== undefined ? { typeOnly: edge.typeOnly } : {}),
  }));
  const symbolEdges = report.graph.symbolEdges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    label: edge.label,
  }));
  return {
    changedFiles,
    changedSymbols,
    impacted,
    graph: {
      fileEdges,
      symbolEdges,
    },
  };
}

function formatImpactMermaid(report: ImpactReport, root: string): string {
  const fileGraph: Graph = { nodes: new Set<string>(), edges: [] };
  const ensureFileNode = (file: string) => fileGraph.nodes.add(file);
  for (const cf of report.changedFiles) ensureFileNode(cf.file);
  for (const item of report.impacted) ensureFileNode(item.file);
  for (const symbol of report.changedSymbols) ensureFileNode(symbol.file);
  for (const edge of report.graph.fileEdges) {
    ensureFileNode(edge.from);
    ensureFileNode(edge.to);
    fileGraph.edges.push({
      from: edge.from,
      to: { type: "file", path: edge.to },
      raw: "",
      ...(edge.typeOnly ? { typeOnly: edge.typeOnly } : {}),
    });
  }

  const symbolGraph: SymbolGraph = { nodes: new Map(), edges: [] };
  for (const sym of report.changedSymbols) {
    symbolGraph.nodes.set(sym.id, {
      id: sym.id,
      file: sym.file,
      name: sym.name,
      kind: symbolNodeKindFromString(sym.kind),
    });
  }
  for (const edge of report.graph.symbolEdges) {
    const fromSym = report.changedSymbols[edge.from];
    const toSym = report.changedSymbols[edge.to];
    if (!fromSym || !toSym) continue;
    symbolGraph.edges.push({
      from: fromSym.id,
      to: toSym.id,
      ...(edge.label ? { label: edge.label } : {}),
    });
  }

  return graphToMermaidSymbolsWithFiles(symbolGraph, fileGraph, root);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "graph";

  // Extract flags and root directory
  const flags = args.filter((a) => a.startsWith("--"));
  const nonFlags = args.filter((a) => !a.startsWith("--"));
  const root = nonFlags[1] ?? process.cwd();
  const roots = cmd === "graph" || cmd === "index" ? nonFlags.slice(1) : [];
  const changedSinceIdx = args.indexOf("--changed-since");
  const changedSince =
    changedSinceIdx !== -1 && args[changedSinceIdx + 1]
      ? args[changedSinceIdx + 1]
      : undefined;
  const gitBaseIdx = args.indexOf("--git-base");
  const gitBase =
    gitBaseIdx !== -1 && args[gitBaseIdx + 1] ? args[gitBaseIdx + 1] : undefined;
  const gitHeadIdx = args.indexOf("--git-head");
  const gitHead =
    gitHeadIdx !== -1 && args[gitHeadIdx + 1] ? args[gitHeadIdx + 1] : undefined;
  const projectRootAbs = path.isAbsolute(root)
    ? root
    : path.resolve(process.cwd(), root);

  const resolveFilesFromRoots = async (): Promise<string[]> => {
    if (roots.length === 0) return await listProjectFiles(projectRootAbs);
    const normalizedRoots = roots.map((r) =>
      path.isAbsolute(r)
        ? r.replace(/\\/g, "/")
        : path.resolve(process.cwd(), r).replace(/\\/g, "/")
    );
    const all: string[][] = await Promise.all(
      normalizedRoots.map(async (r) => await listProjectFiles(r))
    );
    return Array.from(new Set(all.flat()));
  };

  const resolveChangedFiles = async (): Promise<string[] | null> => {
    if (gitBase) {
      const diffOpts: { base: string; head?: string } = { base: gitBase };
      if (gitHead) diffOpts.head = gitHead;
      return await listChangedFiles(projectRootAbs, diffOpts);
    }
    if (changedSince) {
      return await listChangedFiles(projectRootAbs, {
        changedSince,
      });
    }
    return null;
  };

  const resolveFiles = async (): Promise<string[]> => {
    const gitFiles = await resolveChangedFiles();
    if (gitFiles) {
      const existence = gitFiles.map((file) => ({
        file,
        exists: fs.existsSync(file),
      }));
      const existingFiles = existence
        .filter((entry) => entry.exists)
        .map((entry) => entry.file);
      const deletedFiles = existence
        .filter((entry) => !entry.exists)
        .map((entry) => entry.file);
      if (deletedFiles.length > 0) {
        writeStderrLine(
          `Skipping ${deletedFiles.length} deleted file(s) from git diff: ${deletedFiles
            .map((file) => path.relative(projectRootAbs, file) || file)
            .join(", ")}`
        );
      }
      if (existingFiles.length === 0) {
        writeStderrLine("No changed files detected via git diff.");
      }
      return existingFiles;
    }
    return await resolveFilesFromRoots();
  };

  if (cmd === "graph") {
    const files = await resolveFiles();
    const hasExplicitSymbolFlag =
      flags.includes("--symbols") ||
      flags.includes("--symbols-only") ||
      flags.includes("--symbols-detailed");
    const hasExplicitFormatFlag =
      flags.includes("--mermaid") || flags.includes("--dot") || flags.includes("--json");
    const outputIdx = args.findIndex((a) => a === "--output" || a === "-o");
    const outputArg = outputIdx !== -1 ? args[outputIdx + 1] : undefined;
    const stderrIdx = args.findIndex((a) => a === "--stderr-file");
    const stderrArg = stderrIdx !== -1 ? args[stderrIdx + 1] : undefined;
    const stdoutMode = flags.includes("--stdout");
    const defaultGraphMode = !hasExplicitSymbolFlag && !hasExplicitFormatFlag;

    const wantSymbols = hasExplicitSymbolFlag;
    const detailedSymbols = flags.includes("--symbols-detailed");
    const threadsFlagIdx = args.findIndex((a) => a === "--threads");
    const threads =
      threadsFlagIdx !== -1 ? Number(args[threadsFlagIdx + 1]) : 0;
    const cacheIdx = args.findIndex((a) => a === "--cache");
    const cache = cacheIdx !== -1 ? (args[cacheIdx + 1] as any) : undefined;
    const cacheStrict = flags.includes("--cache-strict");
    const format = flags.includes("--mermaid")
      ? "mermaid"
      : flags.includes("--dot")
      ? "dot"
      : "json";
    const fast = flags.includes("--fast-graph");
    const resolveNodeModules = flags.includes("--resolve-node-modules");
    const compact = defaultGraphMode ? true : flags.includes("--compact-json");
    const outputFile = outputArg
      ? (path.isAbsolute(outputArg)
          ? outputArg.replace(/\\/g, "/")
          : path.resolve(process.cwd(), outputArg).replace(/\\/g, "/"))
      : defaultGraphMode && !stdoutMode
      ? path.resolve(process.cwd(), "codegraph.json").replace(/\\/g, "/")
      : undefined;
    stderrFilePath = stderrArg
      ? (path.isAbsolute(stderrArg)
          ? stderrArg.replace(/\\/g, "/")
          : path.resolve(process.cwd(), stderrArg).replace(/\\/g, "/"))
      : defaultGraphMode
      ? path.resolve(process.cwd(), "codegraph.err").replace(/\\/g, "/")
      : undefined;

    const writeOut = async (text: string) => {
      if (outputFile) {
        await fsp.writeFile(outputFile, `${text}\n`, "utf8");
      } else {
        writeStdoutLine(text);
      }
    };
    if (wantSymbols) {
      const index = await buildProjectIndexFromFiles(root, files, {
        threads,
        cache,
        cacheStrict,
        graph: {
          fast,
          resolveNodeModules,
        },
      });
      let sgraph;
      if (detailedSymbols) {
        const scopeIdx = args.findIndex(
          (a) => a === "--symbols-detailed-scope"
        );
        const scope = scopeIdx !== -1 ? (args[scopeIdx + 1] as any) : undefined;
        const maxEdgesIdx = args.findIndex(
          (a) => a === "--symbols-detailed-max-edges"
        );
        const maxEdges =
          maxEdgesIdx !== -1 ? Number(args[maxEdgesIdx + 1]) : undefined;
        const membersOnly = flags.includes("--symbols-detailed-members-only");
        sgraph = await buildSymbolGraphDetailed(index, {
          scope: scope as any,
          maxEdges:
            typeof maxEdges === "number" ? maxEdges : (undefined as any),
          membersOnly,
        });
      } else {
        sgraph = await buildSymbolGraph(index);
      }
      if (flags.includes("--symbols-only")) {
        if (format === "mermaid") {
          await writeOut(graphToMermaidSymbols(sgraph, root));
        } else if (format === "dot") {
          await writeOut(graphToDOTSymbols(sgraph, root));
        } else {
          if (compact) {
            const allFiles = [...index.graph.nodes];
            await writeOut(toJSON(compactSymbolsOnly(allFiles, sgraph)));
          } else {
            await writeOut(
              toJSON({ nodes: [...sgraph.nodes.values()], edges: sgraph.edges })
            );
          }
        }
        return;
      }
      // Reuse the graph already built during indexing to avoid an extra pass
      const fgraph = index.graph;
      if (format === "mermaid") {
        await writeOut(graphToMermaidSymbolsWithFiles(sgraph, fgraph, root));
      } else if (format === "dot") {
        await writeOut(graphToDOTSymbolsWithFiles(sgraph, fgraph, root));
      } else {
        if (compact) {
          await writeOut(toJSON(compactGraphWithSymbols(fgraph, sgraph)));
        } else {
          await writeOut(
            toJSON({
              files: [...fgraph.nodes],
              fileEdges: fgraph.edges,
              symbols: [...sgraph.nodes.values()],
              symbolEdges: sgraph.edges,
            })
          );
        }
      }
      return;
    }
    const graph = await collectGraph(root, files, { fast, threads, resolveNodeModules });
    if (format === "mermaid") await writeOut(graphToMermaid(graph));
    else if (format === "dot") await writeOut(graphToDOT(graph));
    else await writeOut(toJSON({ nodes: [...graph.nodes], edges: graph.edges }));
    return;
  }

  if (cmd === "index") {
    const files = await resolveFiles();
    const threadsFlagIdx = args.findIndex((a) => a === "--threads");
    const threads =
      threadsFlagIdx !== -1 ? Number(args[threadsFlagIdx + 1]) : 0;
    const cacheIdx = args.findIndex((a) => a === "--cache");
    const cache = cacheIdx !== -1 ? (args[cacheIdx + 1] as any) : undefined;
    const cacheStrict = flags.includes("--cache-strict");
    const index = await buildProjectIndexFromFiles(root, files, {
      threads,
      cache,
      cacheStrict,
    });
    const full = flags.includes("--json") || flags.includes("--full");
    if (full) {
      const modules = [...index.byFile.values()].map((m) => ({
        file: m.file,
        locals: m.locals.map((l) => ({
          name: l.localName,
          kind: l.kind,
          start: l.range.start,
        })),
        exports: m.exports,
        imports: m.imports,
      }));
      writeJSONLine({
        files: modules.length,
        edges: index.graph.edges.length,
        modules,
      });
    } else {
      writeJSONLine({
        files: [...index.byFile.keys()].length,
        edges: index.graph.edges.length,
      });
    }
    return;
  }

  if (cmd === "dumpmod") {
    const [fileArg] = nonFlags.slice(1);
    const file = path.isAbsolute(fileArg!)
      ? fileArg!.replace(/\\/g, "/")
      : path.resolve(root, fileArg!).replace(/\\/g, "/");
    const index = await buildProjectIndex(root);
    const mod = index.byFile.get(file);
    if (!mod) {
      writeJSONLine({
        status: "not_found",
        reason: "Module not indexed",
        file,
      });
      return;
    }
    writeJSONLine({
      file,
      locals: mod.locals.map((l) => ({
        name: l.localName,
        kind: l.kind,
        start: l.range.start,
      })),
      exports: mod.exports.map((e) =>
        e.type === "local"
          ? {
              type: e.type,
              exportedAs: e.exportedAs,
              def: {
                name: e.target.localName,
                kind: e.target.kind,
                start: e.target.range.start,
              },
            }
          : e
      ),
      imports: mod.imports,
    });
    return;
  }

  if (cmd === "goto") {
    const [fileArg, lineArg, colArg] = nonFlags.slice(1);
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
    const refArgs = Object.fromEntries(
      args.slice(1).reduce<[string, string][]>((acc, cur, i, arr) => {
        if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]] as any);
        return acc;
      }, [])
    );
    const file = path.isAbsolute(refArgs.file!)
      ? refArgs.file!.replace(/\\/g, "/")
      : path.resolve(root, refArgs.file!).replace(/\\/g, "/");
    const line = Number(refArgs.line!);
    const column = Number(refArgs.col ?? refArgs.column!);
    const pretty = flags.includes("--pretty");
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
    const qIdx = args.indexOf("--query");
    if (qIdx === -1 || !args[qIdx + 1]) {
      writeStderrLine("Usage: grep [root] --query '<treesitter query>'");
      process.exit(2);
    }
    const querySource = args[qIdx + 1];
    const hits = await astGrep(root, querySource!);
  writeJSONLine(hits);
  return;
  }

  if (cmd === "impact") {
    const providerIdx = args.indexOf("--provider");
    const provider = providerIdx !== -1 ? args[providerIdx + 1] : "git";

    let options: any = { provider };

    if (provider === "git") {
      const baseIdx = args.indexOf("--base");
      const headIdx = args.indexOf("--head");
      if (baseIdx !== -1 && args[baseIdx + 1]) options.base = args[baseIdx + 1];
      if (headIdx !== -1 && args[headIdx + 1]) options.head = args[headIdx + 1];
    } else if (provider === "github") {
      const prIdx = args.indexOf("--pr");
      const repoIdx = args.indexOf("--repo");
      if (prIdx !== -1 && args[prIdx + 1]) options.pr = Number(args[prIdx + 1]);
      if (repoIdx !== -1 && args[repoIdx + 1]) options.repo = args[repoIdx + 1];
    } else if (provider === "raw") {
      // For raw provider, diff text would come from stdin or file
      // For now, assume stdin
      const diffText = await new Promise<string>((resolve) => {
        let data = "";
        process.stdin.on("data", chunk => data += chunk);
        process.stdin.on("end", () => resolve(data));
      });
      options.diffText = diffText;
    }

    // Parse other options
    const threadsIdx = args.indexOf("--threads");
    const threads =
      threadsIdx !== -1 && args[threadsIdx + 1]
        ? Number(args[threadsIdx + 1])
        : 0;
    if (threadsIdx !== -1 && args[threadsIdx + 1]) options.threads = threads;

    const cacheIdx = args.indexOf("--cache");
    const cache =
      cacheIdx !== -1 && args[cacheIdx + 1]
        ? (args[cacheIdx + 1] as any)
        : undefined;
    if (cacheIdx !== -1 && args[cacheIdx + 1]) options.cache = cache;

    const cacheStrict = flags.includes("--cache-strict");
    if (cacheStrict) options.cacheStrict = true;

    const maxRefsIdx = args.indexOf("--max-refs");
    if (maxRefsIdx !== -1 && args[maxRefsIdx + 1])
      options.maxRefs = Number(args[maxRefsIdx + 1]);

    const depthIdx = args.indexOf("--depth");
    if (depthIdx !== -1 && args[depthIdx + 1])
      options.depth = Number(args[depthIdx + 1]);

    const includeTests = flags.includes("--include-tests");
    const membersOnly = flags.includes("--members-only");

    const scopeIdx = args.indexOf("--scope");
    if (scopeIdx !== -1 && args[scopeIdx + 1]) options.scope = args[scopeIdx + 1];

    const refContextIdx = args.indexOf("--ref-context");
    if (refContextIdx !== -1 && args[refContextIdx + 1]) options.refContext = args[refContextIdx + 1] as "line" | "block";

    const refContextLinesIdx = args.indexOf("--ref-context-lines");
    if (refContextLinesIdx !== -1 && args[refContextLinesIdx + 1]) options.refContextLines = Number(args[refContextLinesIdx + 1]);

    const refBlockMaxLinesIdx = args.indexOf("--ref-block-max-lines");
    if (refBlockMaxLinesIdx !== -1 && args[refBlockMaxLinesIdx + 1]) options.refBlockMaxLines = Number(args[refBlockMaxLinesIdx + 1]);

    options.includeTests = includeTests;
    options.membersOnly = membersOnly;

    const fastGraph = flags.includes("--fast-graph");
    const resolveNodeModules = flags.includes("--resolve-node-modules");

    const pretty = flags.includes("--pretty");
    const mermaid = flags.includes("--mermaid");

    try {
      const indexOpts: any = {
        threads,
        cache,
        cacheStrict,
      };
      if (fastGraph || resolveNodeModules) {
        indexOpts.graph = {
          fast: fastGraph,
          resolveNodeModules,
        };
      }
      const index = await buildProjectIndex(root, indexOpts);
      const report = await analyzeImpactFromDiff(root, index, options);
      const impactReport = ensureImpactReport(report);

      if (mermaid) {
        writeStdoutLine(formatImpactMermaid(impactReport, root));
      } else if (pretty) {
        writeStdoutLine(`Impact Analysis Report`);
        writeStdoutLine(`======================`);
        writeStdoutLine(`Changed files: ${impactReport.changedFiles.length}`);
        writeStdoutLine(`Changed symbols: ${impactReport.changedSymbols.length}`);
        writeStdoutLine(`Impacted items: ${impactReport.impacted.length}`);
        writeStdoutLine(``);
        for (const item of impactReport.impacted.slice(0, 10)) {
          writeStdoutLine(`${item.file}: ${item.symbols.join(", ")} (severity: ${(item.severity * 100).toFixed(1)}%)`);
          if ('refs' in item && item.refs && item.refs.length > 0) {
            const contextsToShow = item.refs.slice(0, 2);
            for (const ref of contextsToShow) {
              writeStdoutLine(`  Reference at ${ref.range.start.line}:${ref.range.start.column}:`);
              const contextLines = ref.context!.split('\n').slice(0, 5);
              for (const line of contextLines) {
                writeStdoutLine(`    ${line}`);
              }
              if (ref.context!.split('\n').length > 5) {
                writeStdoutLine(`    ...`);
              }
            }
            if (item.refs.length > 2) {
              writeStdoutLine(`  ... and ${item.refs.length - 2} more references`);
            }
          }
        }
        if (impactReport.impacted.length > 10) {
          writeStdoutLine(`... and ${impactReport.impacted.length - 10} more`);
        }
      } else {
        writeJSONLine(report);
      }
    } catch (error) {
      writeStderrLine(`Impact analysis failed: ${error}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "review") {
    const baseIdx = args.indexOf("--base");
    const headIdx = args.indexOf("--head");
    const sinceIdx = args.indexOf("--changed-since");
    const threadsIdx = args.indexOf("--threads");
    const cacheIdx = args.indexOf("--cache");
    const maxTestsIdx = args.indexOf("--max-tests");
    const base = baseIdx !== -1 ? args[baseIdx + 1] : undefined;
    const head = headIdx !== -1 ? args[headIdx + 1] : undefined;
    const changedSince = sinceIdx !== -1 ? args[sinceIdx + 1] : undefined;
    const threads =
      threadsIdx !== -1 ? Number(args[threadsIdx + 1]) : undefined;
    const cache = cacheIdx !== -1 ? (args[cacheIdx + 1] as any) : undefined;
    const maxTests =
      maxTestsIdx !== -1 ? Number(args[maxTestsIdx + 1]) : undefined;
    const fastGraph = flags.includes("--fast-graph");

    const reviewOpts: Parameters<typeof buildReviewReport>[1] = {};
    if (base !== undefined) reviewOpts.gitBase = base;
    if (head !== undefined) reviewOpts.gitHead = head;
    if (changedSince !== undefined) reviewOpts.changedSince = changedSince;
    if (threads !== undefined) reviewOpts.threads = threads;
    if (cache !== undefined) reviewOpts.cache = cache;
    if (fastGraph) reviewOpts.graph = { fast: true };
    if (maxTests !== undefined) reviewOpts.maxCandidates = maxTests;
    const report = await buildReviewReport(projectRootAbs, reviewOpts);
    writeJSONLine(report);
    return;
  }

  if (cmd === "chunk") {
    const filePath = nonFlags[1];
    if (!filePath) {
      writeStderrLine("Usage: chunk <file-path> [options]");
      writeStderrLine("Options:");
      writeStderrLine("  --min-tokens N    Minimum tokens per chunk (default: 150)");
      writeStderrLine("  --max-tokens N    Maximum tokens per chunk (default: 400)");
      writeStderrLine("  --language LANG   Language override (javascript, typescript, tsx, python, vue, svelte, json, yaml, text)");
      writeStderrLine("  --text            Force text chunking mode");
      process.exit(2);
    }

    try {
      const source = await fsp.readFile(filePath, "utf8");
      const ext = path.extname(filePath).toLowerCase();

      // Detect language from extension if not specified
      let languageId = args.find((a, i) => a === "--language" && args[i + 1]) ? args[args.findIndex(a => a === "--language") + 1] : undefined;
      if (!languageId) {
        const extMap: Record<string, string> = {
          ".js": "javascript",
          ".jsx": "javascript",
          ".mjs": "javascript",
          ".cjs": "javascript",
          ".ts": "typescript",
          ".mts": "typescript",
          ".cts": "typescript",
          ".tsx": "tsx",
          ".py": "python",
          ".json": "json",
          ".yaml": "yaml",
          ".yml": "yaml",
          ".vue": "vue",
          ".svelte": "svelte",
        };
        languageId = extMap[ext] || "text";
      }

      const forceText = flags.includes("--text");
      const minTokensIdx = args.findIndex(a => a === "--min-tokens");
      const maxTokensIdx = args.findIndex(a => a === "--max-tokens");
      const minTokens = minTokensIdx !== -1 ? Number(args[minTokensIdx + 1]) : 150;
      const maxTokens = maxTokensIdx !== -1 ? Number(args[maxTokensIdx + 1]) : 400;

      let chunks;

      const isSFC = languageId === "vue" || languageId === "svelte";
      if (forceText || (!isSFC && !["javascript", "typescript", "tsx", "python"].includes(languageId))) {
        // Use text chunking for non-code files or when forced
        chunks = chunkTextFile({
          source,
          filePath,
          languageId,
          minTokens,
          maxTokens,
        });
      } else if (isSFC) {
        chunks = chunkSFCFile({
          source,
          filePath,
          framework: languageId as "vue" | "svelte",
          minTokens,
          maxTokens,
        });
      } else {
        // Use semantic chunking for code files
        const langConfig = LANG_CONFIGS[languageId as keyof typeof LANG_CONFIGS];
        if (!langConfig) {
          writeStderrLine(`Unsupported language: ${languageId}`);
          process.exit(1);
        }
        chunks = chunkFile({
          language: langConfig,
          source,
          filePath,
          minTokens,
          maxTokens,
        });
      }

      writeJSONLine(chunks);
    } catch (error) {
      writeStderrLine(`Chunking failed: ${error}`);
      process.exit(1);
    }
    return;
  }

  writeStderrLine(`Unknown command: ${cmd}`);
  process.exit(1);
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith("cli.ts") ||
  import.meta.url.endsWith("cli.js")
) {
  main().catch((e) => {
    writeError(e);
    process.exit(1);
  });
}
