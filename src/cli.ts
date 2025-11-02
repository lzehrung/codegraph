#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import {
  listProjectFiles,
  collectGraph,
  buildProjectIndex,
  buildProjectIndexFromFiles,
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

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "graph";

  // Extract flags and root directory
  const flags = args.filter((a) => a.startsWith("--"));
  const nonFlags = args.filter((a) => !a.startsWith("--"));
  const root = nonFlags[1] ?? process.cwd();
  const roots = cmd === "graph" || cmd === "index" ? nonFlags.slice(1) : [];

  const resolveFilesFromRoots = async (): Promise<string[]> => {
    if (roots.length === 0) return await listProjectFiles(root);
    const all: string[][] = await Promise.all(
      roots.map(async (r) => await listProjectFiles(r))
    );
    return Array.from(new Set(all.flat()));
  };

  if (cmd === "graph") {
    const files = await resolveFilesFromRoots();
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

    const wantSymbols = defaultGraphMode
      ? true
      : hasExplicitSymbolFlag;
    const detailedSymbols = defaultGraphMode
      ? true
      : flags.includes("--symbols-detailed");
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
    const files = await resolveFilesFromRoots();
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
    if (threadsIdx !== -1 && args[threadsIdx + 1]) options.threads = Number(args[threadsIdx + 1]);

    const cacheIdx = args.indexOf("--cache");
    if (cacheIdx !== -1 && args[cacheIdx + 1]) options.cache = args[cacheIdx + 1];

    const maxRefsIdx = args.indexOf("--max-refs");
    if (maxRefsIdx !== -1 && args[maxRefsIdx + 1]) options.maxRefs = Number(args[maxRefsIdx + 1]);

    const depthIdx = args.indexOf("--depth");
    if (depthIdx !== -1 && args[depthIdx + 1]) options.depth = Number(args[depthIdx + 1]);

    const includeTests = flags.includes("--include-tests");
    const membersOnly = flags.includes("--members-only");

    options.includeTests = includeTests;
    options.membersOnly = membersOnly;

    const pretty = flags.includes("--pretty");
    const mermaid = flags.includes("--mermaid");

    try {
      const report = await analyzeImpactFromDiff(root, await buildProjectIndex(root), options);

      if (mermaid) {
        // TODO: Implement mermaid output for impact reports
        writeStdoutLine("Mermaid output for impact reports not yet implemented");
      } else if (pretty) {
        writeStdoutLine(`Impact Analysis Report`);
        writeStdoutLine(`======================`);
        writeStdoutLine(`Changed files: ${report.changedFiles.length}`);
        writeStdoutLine(`Changed symbols: ${report.changedSymbols.length}`);
        writeStdoutLine(`Impacted items: ${report.impacted.length}`);
        writeStdoutLine(``);
        for (const item of report.impacted.slice(0, 10)) {
          writeStdoutLine(`${item.file}: ${item.symbols.join(", ")} (severity: ${(item.severity * 100).toFixed(1)}%)`);
        }
        if (report.impacted.length > 10) {
          writeStdoutLine(`... and ${report.impacted.length - 10} more`);
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
