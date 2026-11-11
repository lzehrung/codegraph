#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  aggregateReports,
  renderReport,
  scoreDefinition,
  scoreEdges,
  scoreReferences,
  summarizeResults,
  validateManifest,
} from "./accuracy-lib.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "../..");
const usage = `Usage: npm run accuracy -- [options]
  --language <ts|csharp|all>  Languages to measure (default: all)
  --repo <id>                One pinned corpus repository
  --seed <uint32>            Sampling seed (default: 1)
  --max-sites <number>       Identifier uses per repository (default: 400)
  --max-declarations <n>     Reference queries per repository (default: 80)
  --corpus-dir <dir>         Clone directory (default: <os.tmpdir()>/codegraph-accuracy/corpus)
  --output <dir>             Report directory (default: .accuracy/)
  --json                    Emit machine-readable summary to stdout
  --help                    Show this help
`;

function parseArguments(argv) {
  const options = {
    language: "all",
    repo: null,
    seed: 1,
    maxSites: 400,
    maxDeclarations: 80,
    corpusDir: path.join(os.tmpdir(), "codegraph-accuracy", "corpus"),
    output: path.resolve(".accuracy"),
    json: false,
    help: false,
  };
  const names = {
    "--language": "language",
    "--repo": "repo",
    "--seed": "seed",
    "--max-sites": "maxSites",
    "--max-declarations": "maxDeclarations",
    "--corpus-dir": "corpusDir",
    "--output": "output",
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seen.add(arg);
    if (arg === "--json") options.json = true;
    else if (arg === "--help") options.help = true;
    else {
      const name = names[arg];
      const value = argv[index + 1];
      if (!name) throw new Error(`Unknown option: ${arg}`);
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      index += 1;
      if (["seed", "maxSites", "maxDeclarations"].includes(name)) {
        const number = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 0) {
          throw new Error(`${arg} must be a nonnegative integer.`);
        }
        if (name === "seed" && number > 0xffffffff) throw new Error("--seed must fit an unsigned 32-bit integer.");
        options[name] = number;
      } else options[name] = value;
    }
  }
  if (!["ts", "csharp", "all"].includes(options.language)) throw new Error("--language must be ts, csharp, or all.");
  options.corpusDir = path.resolve(options.corpusDir);
  options.output = path.resolve(options.output);
  return options;
}

function execute(command, args, cwd = packageRoot) {
  const result = spawnSync(command, args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function checkPrerequisites(repositories) {
  execute("git", ["--version"]);
  if (!repositories.some((repository) => repository.language === "csharp")) return;
  let sdks;
  try {
    sdks = execute("dotnet", ["--list-sdks"]);
  } catch (error) {
    throw new Error(`C# oracle requires the .NET 10 SDK (dotnet on PATH). ${error.message}`);
  }
  if (!/^10\./m.test(sdks))
    throw new Error("C# oracle requires the .NET 10 SDK; install it before --language csharp/all.");
}

function obtainRepository(repository, corpusDirectory) {
  const root = path.join(corpusDirectory, repository.id);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(corpusDirectory, { recursive: true });
    execute("git", ["clone", "--filter=blob:none", "--no-checkout", repository.url, root]);
    execute("git", ["-C", root, "checkout", "--detach", repository.commit]);
  }
  const head = execute("git", ["-C", root, "rev-parse", "HEAD"]);
  if (head !== repository.commit) {
    throw new Error(
      `${repository.id}: existing clone HEAD ${head} differs from pinned ${repository.commit}; use a fresh --corpus-dir.`,
    );
  }
  return root;
}

function relativeFile(root, file) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Result escaped corpus root: ${file}`);
  }
  return relative;
}

function definitionAnswer(root, answer) {
  if (answer.status !== "ok") return { status: answer.status, reason: answer.reason };
  return {
    status: answer.status,
    definition: {
      file: relativeFile(root, answer.definition.file),
      line: answer.definition.range.start.line,
      column: answer.definition.range.start.column,
    },
  };
}

function runOracle(repository, root, requestPath, outputPath) {
  const args = ["--root", root, "--request", requestPath, "--output", outputPath];
  if (repository.language === "typescript") {
    execute(process.execPath, [path.join(scriptDirectory, "oracles/typescript/oracle.mjs"), ...args]);
  } else {
    execute("dotnet", [
      "run",
      "--project",
      path.join(scriptDirectory, "oracles/csharp"),
      "-c",
      "Release",
      "--",
      ...args,
    ]);
  }
  const response = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  if (response.schemaVersion !== 1 || response.language !== repository.language)
    throw new Error("Oracle protocol version/language mismatch.");
  if (!Array.isArray(response.sites) || !Array.isArray(response.declarations) || !response.diagnostics) {
    throw new Error("Oracle response is missing sites, declarations, or diagnostics.");
  }
  return response;
}

function containsPosition(range, location) {
  const afterStart =
    location.line > range.start.line || (location.line === range.start.line && location.column >= range.start.column);
  if (!afterStart) return false;
  return location.line < range.end.line || (location.line === range.end.line && location.column < range.end.column);
}

async function graphEvidence(index, graph, root, sites, internals) {
  const nodeLocations = new Map();
  const callersByFile = new Map();
  for (const module of index.modules.values()) {
    for (const definition of module.locals) {
      nodeLocations.set(internals.defNodeId(definition), {
        file: relativeFile(root, definition.file),
        line: definition.range.start.line,
        column: definition.range.start.column,
      });
    }
  }
  const callFiles = new Set(
    sites.filter((site) => ["bare-call", "member-call", "constructor"].includes(site.form)).map((site) => site.file),
  );
  for (const file of callFiles) {
    const absolute = path.resolve(root, file).replaceAll("\\", "/");
    const parsed = await internals.ensureParsedContextForIndex(index, absolute);
    const module = [...index.modules.values()].find((entry) => relativeFile(root, entry.file) === file);
    if (!module) throw new Error(`Sampled file is absent from index: ${file}`);
    const declarations = internals.collectDetailedDeclarations(
      parsed.tree.rootNode,
      parsed.sup,
      parsed.source,
      module.locals,
    );
    callersByFile.set(
      file,
      declarations.functionNodes
        .map((entry) => ({
          id: internals.defNodeId(entry.def),
          start: { line: entry.node.startPosition.row + 1, column: entry.node.startPosition.column + 1 },
          end: { line: entry.node.endPosition.row + 1, column: entry.node.endPosition.column + 1 },
          width: entry.node.endIndex - entry.node.startIndex,
        }))
        .sort((left, right) => left.width - right.width),
    );
  }
  const edgesByFile = new Map();
  for (const edge of graph.edges) {
    if (!edge.site || !["calls", "instantiates"].includes(edge.label)) continue;
    const target = nodeLocations.get(edge.to);
    if (!target) throw new Error(`Detailed graph call target has no indexed declaration: ${edge.to}`);
    const file = relativeFile(root, edge.site.file);
    const candidates = edgesByFile.get(file) ?? [];
    candidates.push({ from: edge.from, to: target, label: edge.label, range: edge.site.range });
    edgesByFile.set(file, candidates);
  }
  return sites.map((site) => {
    const caller = callersByFile.get(site.file)?.find((candidate) => containsPosition(candidate, site))?.id ?? null;
    const edges = (edgesByFile.get(site.file) ?? [])
      .filter((edge) => containsPosition(edge.range, site))
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: edge.label,
        site: { file: site.file, line: edge.range.start.line, column: edge.range.start.column },
      }));
    return { caller, edges };
  });
}

async function benchmark(repository, options, api, internals) {
  const started = performance.now();
  const timings = {};
  let phase = performance.now();
  const root = obtainRepository(repository, options.corpusDir);
  timings.checkout = performance.now() - phase;
  process.stderr.write(`[accuracy] ${repository.id}: indexing ${repository.commit}\n`);
  phase = performance.now();
  const index = await api.buildProjectIndex(root, {
    cache: "off",
    discovery: { includeGlobs: repository.include ?? [], ignoreGlobs: repository.exclude ?? [] },
  });
  timings.index = performance.now() - phase;
  const extensions = repository.language === "typescript" ? /\.(?:[cm]?ts|tsx)$/i : /\.cs$/i;
  const files = [...index.modules.values()]
    .map((module) => relativeFile(root, module.file))
    .filter((file) => extensions.test(file))
    .sort();
  if (!files.length) throw new Error(`${repository.id}: Codegraph indexed no ${repository.language} files.`);
  const request = {
    schemaVersion: 1,
    language: repository.language,
    files,
    seed: options.seed,
    maxSites: options.maxSites,
    maxDeclarations: options.maxDeclarations,
  };
  const requestPath = path.join(options.output, `${repository.id}.request.json`);
  const oraclePath = path.join(options.output, `${repository.id}.oracle.json`);
  fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  phase = performance.now();
  process.stderr.write(`[accuracy] ${repository.id}: querying ${repository.language} oracle (${files.length} files)\n`);
  const oracle = runOracle(repository, root, requestPath, oraclePath);
  timings.oracle = performance.now() - phase;
  phase = performance.now();
  process.stderr.write(`[accuracy] ${repository.id}: building detailed call graph\n`);
  const graph = await api.buildSymbolGraphDetailed(index);
  if (graph.truncated) throw new Error(`${repository.id}: detailed graph is truncated; cannot score missing edges.`);
  const evidence = await graphEvidence(index, graph, root, oracle.sites, internals);
  timings.graph = performance.now() - phase;
  phase = performance.now();
  process.stderr.write(
    `[accuracy] ${repository.id}: scoring ${oracle.sites.length} sites and ${oracle.declarations.length} declarations\n`,
  );
  const sites = [];
  for (let position = 0; position < oracle.sites.length; position += 1) {
    const site = oracle.sites[position];
    const answer = definitionAnswer(
      root,
      await api.goToDefinition(index, {
        file: path.resolve(root, site.file).replaceAll("\\", "/"),
        line: site.line,
        column: site.column,
      }),
    );
    const { caller, edges } = evidence[position];
    sites.push({
      site,
      answer,
      definition: scoreDefinition(site, answer),
      caller,
      edges,
      edge: scoreEdges(site, edges, caller),
    });
  }
  const declarations = [];
  for (const declaration of oracle.declarations) {
    const result = await api.findReferences(index, {
      file: path.resolve(root, declaration.file).replaceAll("\\", "/"),
      line: declaration.line,
      column: declaration.column,
    });
    const answer = { status: result.status, references: [], coverage: "unavailable" };
    if (result.status === "ok") {
      answer.references = result.references.map((reference) => ({
        file: relativeFile(root, reference.file),
        line: reference.range.start.line,
        column: reference.range.start.column,
      }));
      answer.coverage = result.referenceCoverage.state;
    }
    declarations.push({ declaration, answer, score: scoreReferences(declaration, answer) });
  }
  timings.queries = performance.now() - phase;
  const report = {
    schemaVersion: 1,
    repository,
    request,
    oracle,
    analysis: index.analysis,
    sites,
    declarations,
    summary: summarizeResults(sites, declarations),
    timings,
    runtimeMs: performance.now() - started,
  };
  fs.writeFileSync(path.join(options.output, `${repository.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) process.stdout.write(usage);
  else {
    const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(scriptDirectory, "corpus.json"), "utf8")));
    const selectedLanguage = options.language === "ts" ? "typescript" : options.language;
    const repositories = manifest.filter((entry) => {
      if (selectedLanguage !== "all" && entry.language !== selectedLanguage) return false;
      return !options.repo || entry.id === options.repo;
    });
    if (!repositories.length) throw new Error("No corpus repositories match --language/--repo.");
    checkPrerequisites(repositories);
    const indexer = await import("../../dist/indexer.js");
    const graphs = await import("../../dist/graphs.js");
    const parsedCache = await import("../../dist/indexer/parsed-cache.js");
    const detailedAst = await import("../../dist/graphs/symbol-graph-detailed/ast.js");
    const symbolGraph = await import("../../dist/graphs/symbol-graph.js");
    const api = { ...indexer, ...graphs };
    const internals = { ...parsedCache, ...detailedAst, ...symbolGraph };
    fs.mkdirSync(options.output, { recursive: true });
    const reports = [];
    for (const repository of repositories) {
      reports.push(await benchmark(repository, options, api, internals));
      fs.writeFileSync(path.join(options.output, "summary.md"), renderReport(reports));
    }
    const summary = aggregateReports(reports);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            summary,
            repositories: reports.map((report) => ({
              id: report.repository.id,
              runtimeMs: report.runtimeMs,
              summary: report.summary,
            })),
          },
          null,
          2,
        )}\n`,
      );
    } else process.stdout.write(`${renderReport(reports)}\nReports: ${options.output}\n`);
  }
} catch (error) {
  process.stderr.write(`Accuracy benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
