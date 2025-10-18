#!/usr/bin/env node
import path from "node:path";
import {
  listProjectFiles,
  collectGraph,
  buildProjectIndex,
  goToDefinition,
  findReferences,
  graphToMermaid,
  graphToDOT,
  astGrep,
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
  const [cmd = "graph", root = process.cwd(), ...rest] = process.argv.slice(2);

  if (cmd === "graph") {
    const files = await listProjectFiles(root);
    const graph = await collectGraph(root, files);
    const format = rest.includes("--mermaid")
      ? "mermaid"
      : rest.includes("--dot")
      ? "dot"
      : "json";
    if (format === "mermaid") writeStdoutLine(graphToMermaid(graph));
    else if (format === "dot") writeStdoutLine(graphToDOT(graph));
    else writeJSONLine({ nodes: [...graph.nodes], edges: graph.edges });
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
    const hits = await astGrep(root, querySource!);
    writeJSONLine(hits);
    return;
  }

  writeStderrLine(`Unknown command: ${cmd}`);
  process.exit(1);
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith("cli.ts")
) {
  main().catch((e) => {
    writeError(e);
    process.exit(1);
  });
}
