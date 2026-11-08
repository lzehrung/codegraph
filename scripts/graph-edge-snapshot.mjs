#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SAMPLES_DIR = "tests/samples";
const EDGE_CORPUS_DIR = "tests/edge-corpus";
const DEFAULT_SNAPSHOT_DIR = "tests/snapshots/graph-edges";
const SNAPSHOT_EXTENSION = ".txt";
const REGENERATE_COMMAND = "npm run graph:snapshot";
const MAX_DIFF_LINES = 20;

// One build configuration for every project:
// - `cache: "off"` keeps the run read-only and independent of any cache a developer or CI machine holds.
// - One file at a time with no native worker pool keeps scheduling and pool size out of the result.
//   Worker pools start on their own for projects of 32 files or more. The recorded edges were identical
//   for the default concurrency, other thread counts, and forced pools of 1, 2, and 4 workers, so this
//   pin keeps the run cheap and rules out scheduling effects. It does not repair a difference.
const BUILD_OPTIONS = { cache: "off", threads: 1, useNativeWorkers: false };

function usage() {
  return [
    "Usage: node scripts/graph-edge-snapshot.mjs [options]",
    "",
    `Records every resolved graph edge of each language corpus under ${SAMPLES_DIR} and`,
    `${EDGE_CORPUS_DIR}, so a change in resolved edges is a reviewable diff.`,
    "Each tests/samples directory is one project. Each tests/edge-corpus scenario directory is one",
    "project, as in tests/edge-corpus.test.ts, and one file holds all scenarios of a language.",
    "Per project it records the file-level import graph (`index.graph.edges`) and the detailed",
    "symbol graph (`buildSymbolGraphDetailed`). No edge kind is dropped: the graphs have no separate",
    "`contains` edges, so `member_of` is the one structure edge, and it is recorded like the rest.",
    "Characters outside printable ASCII are written as \\u{hex}, so each file is plain ASCII.",
    "",
    "Options:",
    `  --dir <path>  Snapshot directory (default: ${DEFAULT_SNAPSHOT_DIR})`,
    "  --check       Verify the committed snapshot is current; do not write",
    "  --help, -h    Show this help",
  ].join("\n");
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value after ${flag}.`);
  return value;
}

function parseArgs(argv) {
  const options = { snapshotDir: DEFAULT_SNAPSHOT_DIR, check: false, help: false };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      index += 1;
    } else if (arg === "--dir") {
      options.snapshotDir = readValue(argv, index, arg);
      index += 2;
    } else if (arg === "--check") {
      options.check = true;
      index += 1;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return options;
}

async function loadCodegraph() {
  const distEntry = path.join(rootDir, "dist", "index.js");
  const symbolGraphEntry = path.join(rootDir, "dist", "graphs", "symbol-graph.js");
  if (!fs.existsSync(distEntry) || !fs.existsSync(symbolGraphEntry)) {
    throw new Error("dist/index.js not found. Run `npm run build` first.");
  }
  const codegraph = await import(pathToFileURL(distEntry).href);
  const { defNodeId } = await import(pathToFileURL(symbolGraphEntry).href);
  return { ...codegraph, defNodeId };
}

// Directory names sort by UTF-16 code unit, the default string order, never by locale. Loose files are not
// corpus projects. Directory listing order is never used.
function listDirectories(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * The snapshot roots: one per `tests/samples` directory, and one per `tests/edge-corpus` language directory.
 * A root records one or more projects, each indexed alone. `prefix` keeps files of an edge-corpus scenario
 * apart in its language's snapshot file, and `label` names the project in a failure.
 */
function discoverRoots() {
  const roots = [];
  for (const name of listDirectories(path.join(rootDir, SAMPLES_DIR))) {
    const label = `${SAMPLES_DIR}/${name}`;
    roots.push({
      name,
      description: label,
      projects: [{ directory: path.join(rootDir, SAMPLES_DIR, name), prefix: "", label }],
    });
  }
  for (const language of listDirectories(path.join(rootDir, EDGE_CORPUS_DIR))) {
    const languageDirectory = path.join(rootDir, EDGE_CORPUS_DIR, language);
    roots.push({
      name: `edge-corpus-${language}`,
      description: `${EDGE_CORPUS_DIR}/${language} (one index per scenario directory)`,
      projects: listDirectories(languageDirectory).map((scenario) => ({
        directory: path.join(languageDirectory, scenario),
        prefix: `${scenario}/`,
        label: `${EDGE_CORPUS_DIR}/${language}/${scenario}`,
      })),
    });
  }
  const names = new Set();
  for (const root of roots) {
    if (names.has(root.name)) throw new Error(`Two snapshot roots are named ${root.name}.`);
    names.add(root.name);
  }
  return roots;
}

// Source text can hold characters a reviewer cannot tell apart in a diff, such as a zero-width joiner or a
// precomposed accent against a combining one. Every character outside printable ASCII is written as `\u{hex}`.
// That also keeps a line break out of a record, so each snapshot file is plain ASCII with one record per line.
const OUTSIDE_PRINTABLE_ASCII = /[^\x20-\x7e]/gu;

function asciiText(text) {
  return text.replace(OUTSIDE_PRINTABLE_ASCII, (character) => `\\u{${character.codePointAt(0).toString(16)}}`);
}

function projectRelativePath(bases, filePath) {
  for (const base of bases) {
    const relative = path.relative(base, filePath);
    const outsideBase = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (relative && !outsideBase) return relative.split(path.sep).join("/");
  }
  throw new Error(`${filePath} is outside the project root ${bases[0]}.`);
}

function symbolPositions(index, defNodeId) {
  const positions = new Map();
  for (const moduleEntry of index.byFile.values()) {
    for (const def of moduleEntry.locals)
      positions.set(defNodeId(def), `${def.range.start.line}:${def.range.start.column}`);
  }
  return positions;
}

function fileEdgeLine(edge, place) {
  const target = edge.to.type === "file" ? place(edge.to.path) : `external:${asciiText(edge.to.name)}`;
  const attributes = [];
  if (edge.typeOnly) attributes.push("type-only");
  if (edge.resolved) attributes.push(`resolved=${edge.resolved}`);
  if (typeof edge.confidence === "number") attributes.push(`confidence=${edge.confidence}`);
  if (edge.includeForm) attributes.push(`include=${edge.includeForm}`);
  // The specifier goes last: it may hold spaces, and nothing follows it.
  attributes.push(`raw=${asciiText(edge.raw)}`);
  return `file ${place(edge.from)} -> ${target} ${attributes.join(" ")}`;
}

/**
 * `file::name@line:column` for a declaration. An import alias node has no position of its own, so it keeps the
 * graph's own `import` (or `import:<role>`) identity: `file::name@import`.
 */
function describeSymbolNode(id, graph, positions, place) {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`The detailed symbol graph has an edge to ${id}, which is not one of its nodes.`);
  const idHead = `${node.file.replaceAll("\\", "/")}::${node.name}::`;
  if (!id.startsWith(idHead)) throw new Error(`Symbol node id ${id} does not read as <file>::<name>::<suffix>.`);
  const suffix = id.slice(idHead.length);
  const location = `${place(node.file)}::${asciiText(node.name)}`;
  const isImportAlias = suffix === "import" || suffix.startsWith("import:");
  if (isImportAlias) return `${location}@${suffix}`;
  const position = positions.get(id);
  if (!position) throw new Error(`Symbol node ${id} is not a declaration of its file, so it has no line and column.`);
  return `${location}@${position}`;
}

function symbolEdgeLine(edge, graph, positions, place) {
  const from = describeSymbolNode(edge.from, graph, positions, place);
  const to = describeSymbolNode(edge.to, graph, positions, place);
  const arrow = edge.label ? `-[${asciiText(edge.label)}]->` : "->";
  let line = `symbol ${from} ${arrow} ${to}`;
  if (edge.site) {
    const { line: siteLine, column } = edge.site.range.start;
    const siteFile = place(edge.site.file);
    // A call site usually sits in its caller's file. A C++ member declared in a header and
    // defined in a source file does not, so the site names its file only then.
    const siteFilePrefix = siteFile === place(graph.nodes.get(edge.from).file) ? "" : `${siteFile}:`;
    line += ` site=${siteFilePrefix}${siteLine}:${column}`;
  }
  return line;
}

async function indexProjectRecords(codegraph, project, seenLanguages) {
  const index = await codegraph.buildProjectIndex(project.directory, BUILD_OPTIONS);
  for (const file of index.byFile.keys()) {
    const support = codegraph.supportForFile(file, index.languageExtensions);
    if (support) seenLanguages.add(support.id);
  }
  const bases = [...new Set([project.directory, fs.realpathSync(project.directory)])];
  const place = (filePath) => asciiText(`${project.prefix}${projectRelativePath(bases, filePath)}`);
  const records = index.graph.edges.map((edge) => fileEdgeLine(edge, place));

  const graph = await codegraph.buildSymbolGraphDetailed(index);
  const positions = symbolPositions(index, codegraph.defNodeId);
  for (const edge of graph.edges) records.push(symbolEdgeLine(edge, graph, positions, place));
  return records;
}

// Neither the checkout location nor the machine may reach the snapshot, whichever separators or casing a path used.
// The needles are escaped like the records, so a checkout path with non-ASCII characters is still found.
function checkoutPathNeedles() {
  const directories = new Set([rootDir, fs.realpathSync(rootDir)]);
  const forms = [...directories].flatMap((directory) => [directory, directory.replaceAll("\\", "/")]);
  return new Set(forms.map((form) => asciiText(form).toLowerCase()));
}

function assertNoCheckoutPaths(root, records, needles) {
  for (const record of records) {
    const lowered = record.toLowerCase();
    for (const needle of needles) {
      if (lowered.includes(needle)) throw new Error(`${root.name}: an edge record holds the checkout path: ${record}`);
    }
  }
}

function snapshotText(root, records) {
  // The header is part of the sorted file: "# Generated" sorts before "# Graph".
  const header = [
    `# Generated by \`${REGENERATE_COMMAND}\`; review the diff and do not edit by hand.`,
    `# Graph edges resolved for ${root.description}.`,
  ];
  // Plain `sort()` orders by UTF-16 code unit, so no locale or platform changes the order.
  const text = `${[...header, ...[...records].sort()].join("\n")}\n`;
  const unescaped = /[^\x20-\x7e\n]/u.exec(text);
  if (unescaped)
    throw new Error(
      `${root.name}: a record holds the unescaped character U+${unescaped[0].codePointAt(0).toString(16)}.`,
    );
  return text;
}

async function projectRecords(codegraph, project, seenLanguages) {
  try {
    return await indexProjectRecords(codegraph, project, seenLanguages);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${project.label}: ${detail}`, { cause: error });
  }
}

async function generateSnapshots(codegraph, roots) {
  const snapshots = new Map();
  const seenLanguages = new Set();
  const checkoutNeedles = checkoutPathNeedles();
  for (const root of roots) {
    let records = [];
    for (const project of root.projects) {
      records = records.concat(await projectRecords(codegraph, project, seenLanguages));
    }
    assertNoCheckoutPaths(root, records, checkoutNeedles);
    snapshots.set(`${root.name}${SNAPSHOT_EXTENSION}`, snapshotText(root, records));
  }
  const missing = codegraph.LANGUAGE_SUPPORTS.map((support) => support.id).filter((id) => !seenLanguages.has(id));
  if (missing.length) {
    throw new Error(
      `The snapshot roots index no file of the registered language(s): ${missing.join(", ")}. ` +
        `Add a corpus for each under ${SAMPLES_DIR}/ or ${EDGE_CORPUS_DIR}/.`,
    );
  }
  return snapshots;
}

function readSnapshotFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function listSnapshotFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(SNAPSHOT_EXTENSION))
    .map((entry) => entry.name)
    .sort();
}

function snapshotLines(text) {
  if (text === undefined || text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** Lines in `actual` but not in `committed` (added), and the reverse (removed), counting repeats. */
function diffLines(committed, actual) {
  const balance = new Map();
  for (const line of committed) balance.set(line, (balance.get(line) ?? 0) - 1);
  for (const line of actual) balance.set(line, (balance.get(line) ?? 0) + 1);
  const changes = [];
  for (const [line, count] of balance) {
    for (let repeat = 0; repeat < Math.abs(count); repeat += 1) changes.push({ line, sign: count > 0 ? "+" : "-" });
  }
  return changes.sort((left, right) => {
    if (left.line < right.line) return -1;
    if (left.line > right.line) return 1;
    return 0;
  });
}

function describeStaleFile(displayPath, committed, actual) {
  // A CR is reported once below, not as a difference on every line.
  const changes = diffLines(snapshotLines(committed?.replaceAll("\r\n", "\n")), snapshotLines(actual));
  const added = changes.filter((change) => change.sign === "+").length;
  const removed = changes.length - added;
  const lines = [];
  if (committed === undefined) {
    lines.push(`${displayPath}: missing (${added} lines to add)`);
  } else if (!changes.length) {
    lines.push(`${displayPath}: same lines, different layout (order, line endings, or the final newline)`);
  } else {
    lines.push(`${displayPath}: ${added} added, ${removed} removed`);
  }
  for (const change of changes.slice(0, MAX_DIFF_LINES)) lines.push(`  ${change.sign} ${change.line}`);
  if (changes.length > MAX_DIFF_LINES) lines.push(`  ... and ${changes.length - MAX_DIFF_LINES} more differing lines`);
  if (committed?.includes("\r"))
    lines.push("  The committed file has CR characters; snapshot files use LF line endings.");
  return lines;
}

function checkSnapshots(snapshots, snapshotDir, displayDir) {
  const report = [];
  let staleFiles = 0;
  for (const [fileName, actual] of snapshots) {
    const committed = readSnapshotFile(path.join(snapshotDir, fileName));
    if (committed === actual) continue;
    staleFiles += 1;
    report.push(...describeStaleFile(`${displayDir}/${fileName}`, committed, actual));
  }
  for (const fileName of listSnapshotFiles(snapshotDir)) {
    if (snapshots.has(fileName)) continue;
    staleFiles += 1;
    report.push(`${displayDir}/${fileName}: obsolete, no corpus root has this name`);
  }
  if (staleFiles) {
    console.error(report.join("\n"));
    throw new Error(
      `Graph edge snapshot is stale: ${staleFiles} file(s) differ. ` +
        `Run \`${REGENERATE_COMMAND}\`, review the diff, and commit the result.`,
    );
  }
  console.log(`Graph edge snapshot is up to date (${snapshots.size} files).`);
}

function writeSnapshots(snapshots, snapshotDir, displayDir) {
  fs.mkdirSync(snapshotDir, { recursive: true });
  let written = 0;
  for (const [fileName, text] of snapshots) {
    const filePath = path.join(snapshotDir, fileName);
    if (readSnapshotFile(filePath) === text) continue;
    fs.writeFileSync(filePath, text, "utf8");
    written += 1;
    console.log(`Wrote ${displayDir}/${fileName}`);
  }
  let removed = 0;
  for (const fileName of listSnapshotFiles(snapshotDir)) {
    if (snapshots.has(fileName)) continue;
    fs.rmSync(path.join(snapshotDir, fileName));
    removed += 1;
    console.log(`Removed ${displayDir}/${fileName}`);
  }
  console.log(`Graph edge snapshot: ${snapshots.size} files, ${written} written, ${removed} removed.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const codegraph = await loadCodegraph();
  const roots = discoverRoots();
  const projectCount = roots.reduce((count, root) => count + root.projects.length, 0);
  console.log(`Indexing ${projectCount} corpus projects in ${roots.length} snapshot files...`);
  const snapshots = await generateSnapshots(codegraph, roots);

  const snapshotDir = path.resolve(rootDir, options.snapshotDir);
  const displayDir = path.relative(rootDir, snapshotDir).split(path.sep).join("/") || ".";
  if (options.check) checkSnapshots(snapshots, snapshotDir, displayDir);
  else writeSnapshots(snapshots, snapshotDir, displayDir);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
