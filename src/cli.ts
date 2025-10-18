#!/usr/bin/env node
import path from "node:path";
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
  graphToMermaidSymbols,
  graphToDOTSymbols,
  graphToMermaidSymbolsWithFiles,
  graphToDOTSymbolsWithFiles,
} from "./index.js";

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
    writeStderrLine(error.stack ?? error.message);
    return;
  }
  writeStderrLine(String(error));
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "graph";
  
  // Extract flags and root directory
  const flags = args.filter(a => a.startsWith("--"));
  const nonFlags = args.filter(a => !a.startsWith("--"));
  const root = nonFlags[1] ?? process.cwd();
  const roots = cmd === "graph" || cmd === "index" ? nonFlags.slice(1) : [];

  const resolveFilesFromRoots = async (): Promise<string[]> => {
    if (roots.length === 0) return await listProjectFiles(root);
    const all: string[][] = await Promise.all(roots.map(async (r) => await listProjectFiles(r)));
    return Array.from(new Set(all.flat()));
  };

  if (cmd === "graph") {
    const files = await resolveFilesFromRoots();
    const wantSymbols = flags.includes("--symbols") || flags.includes("--symbols-only");
    const format = flags.includes("--mermaid")
      ? "mermaid"
      : flags.includes("--dot")
      ? "dot"
      : "json";
    if (wantSymbols) {
      const index = await buildProjectIndexFromFiles(root, files);
      const sgraph = await buildSymbolGraph(index);
      if (flags.includes("--symbols-only")) {
        if (format === "mermaid") writeStdoutLine(graphToMermaidSymbols(sgraph, root));
        else if (format === "dot") writeStdoutLine(graphToDOTSymbols(sgraph, root));
        else writeJSONLine({ nodes: [...sgraph.nodes.values()], edges: sgraph.edges });
        return;
      }
      const fgraph = await collectGraph(root, files);
      if (format === "mermaid") writeStdoutLine(graphToMermaidSymbolsWithFiles(sgraph, fgraph, root));
      else if (format === "dot") writeStdoutLine(graphToDOTSymbolsWithFiles(sgraph, fgraph, root));
      else writeJSONLine({ files: [...fgraph.nodes], fileEdges: fgraph.edges, symbols: [...sgraph.nodes.values()], symbolEdges: sgraph.edges });
      return;
    }
    const graph = await collectGraph(root, files);
    if (format === "mermaid") writeStdoutLine(graphToMermaid(graph));
    else if (format === "dot") writeStdoutLine(graphToDOT(graph));
    else writeJSONLine({ nodes: [...graph.nodes], edges: graph.edges });
    return;
  }

  if (cmd === "index") {
    const files = await resolveFilesFromRoots();
    const index = await buildProjectIndexFromFiles(root, files);
    const full = flags.includes("--json") || flags.includes("--full");
    if (full) {
      const modules = [...index.byFile.values()].map((m) => ({
        file: m.file,
        locals: m.locals.map((l) => ({ name: l.localName, kind: l.kind, start: l.range.start })),
        exports: m.exports,
        imports: m.imports,
      }));
      writeJSONLine({ files: modules.length, edges: index.graph.edges.length, modules });
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
