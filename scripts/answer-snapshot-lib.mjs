import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCorpusPins } from "./benchmarks/paired-benchmark-lib.mjs";
import { absoluteSnapshotPathPatterns } from "./snapshot-paths-lib.mjs";

/**
 * @typedef {object} AnswerProject
 * @property {string} directory
 * @property {string} prefix
 * @property {string} label
 * @property {import("../src/indexer/types.js").BuildOptions} [buildOptions]
 */
/**
 * @typedef {typeof import("../src/index.js") & {
 *   ensureParsedContextForIndex: typeof import("../src/indexer/parsed-cache.js").ensureParsedContextForIndex,
 *   isUnsupportedParserInputError: typeof import("../src/languages/file-prep.js").isUnsupportedParserInputError,
 *   isSyntaxProjectionLimitError: typeof import("../src/indexer/parse-context.js").isSyntaxProjectionLimitError
 * }} AnswerApi
 */
/**
 * @typedef {object} PinnedAnswerCorpus
 * @property {string} id
 * @property {string} family
 * @property {string} commit
 * @property {string} [directory]
 * @property {string[]} [include]
 * @property {string[]} [exclude]
 */

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_DIR = "tests/snapshots/answers";
const REGENERATE = "npm run answers:snapshot";
// Match graph-edge-snapshot.mjs. Query views/scopes are shared by all answers in one index.
const BUILD_OPTIONS = { cache: "off", threads: 1, useNativeWorkers: false };
const asciiText = (text) =>
  text.replace(/[^\x20-\x7e]/gu, (character) => `\\u{${character.codePointAt(0).toString(16)}}`);
const quoted = (text) => asciiText(JSON.stringify(text));
const pos = (position) => `${position.line}:${position.column}`;
const span = (range) => `${pos(range.start)}-${pos(range.end)}`;

function listDirectories(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function discoverAnswerRoots() {
  const roots = listDirectories(path.join(rootDir, "tests/samples")).map((name) => ({
    name,
    description: `tests/samples/${name}`,
    projects: [{ directory: path.join(rootDir, "tests/samples", name), prefix: "", label: `tests/samples/${name}` }],
  }));
  for (const language of listDirectories(path.join(rootDir, "tests/edge-corpus"))) {
    const directory = path.join(rootDir, "tests/edge-corpus", language);
    roots.push({
      name: `edge-corpus-${language}`,
      description: `tests/edge-corpus/${language} (one index per scenario directory)`,
      projects: listDirectories(directory).map((scenario) => ({
        directory: path.join(directory, scenario),
        prefix: `${scenario}/`,
        label: `tests/edge-corpus/${language}/${scenario}`,
      })),
    });
  }
  return roots;
}

/** @returns {Promise<AnswerApi>} */
export async function loadAnswerApi(distDirectory = path.join(rootDir, "dist")) {
  const load = (relative) => import(pathToFileURL(path.join(distDirectory, relative)).href);
  if (!fs.existsSync(path.join(distDirectory, "index.js")))
    throw new Error("dist/index.js not found. Run `npm run build` first.");
  const [api, parsed, preparation, context] = await Promise.all([
    load("index.js"),
    load("indexer/parsed-cache.js"),
    load("languages/file-prep.js"),
    load("indexer/parse-context.js"),
  ]);
  if (!api.isNativeTreeSitterAvailable()) throw new Error("The native runtime is required for answer snapshots.");
  return {
    ...api,
    ensureParsedContextForIndex: parsed.ensureParsedContextForIndex,
    isUnsupportedParserInputError: preparation.isUnsupportedParserInputError,
    isSyntaxProjectionLimitError: context.isSyntaxProjectionLimitError,
  };
}

function contained(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function projectPath(bases, file) {
  for (const base of bases) {
    if (contained(base, file) && file !== base)
      return path.relative(base, file).split(path.sep).join("/").normalize("NFC");
  }
  throw new Error(`Answer path is outside the indexed project: ${file}`);
}

function unavailableAnswer(api, error, place) {
  if (api.isUnsupportedParserInputError(error)) {
    return `unsupported ${error.name} ${quoted(`Unsupported file extension: ${place(error.file)}`)}`;
  }
  if (api.isSyntaxProjectionLimitError(error)) return `unavailable ${quoted(error.projectionLimit)}`;
  throw error;
}

// Public metadata has stable key order; only path-bearing fields become project-relative.
function snapshotMetadata(value, place, key = "") {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map((entry) => snapshotMetadata(entry, place, key));
  if (typeof value === "string") {
    const isFilePath = key === "resolved" || key === "importedFrom" || key === "jvmPackageFiles";
    return isFilePath && path.isAbsolute(value) ? place(value) : value;
  }
  if (typeof value !== "object") return value;
  const isBindingRange = key === "localRange" || key === "importedRange";
  if (isBindingRange) return `${span(value)}@${value.start.index}:${value.end.index}`;
  const result = {};
  for (const field of Object.keys(value).sort()) result[field] = snapshotMetadata(value[field], place, field);
  return result;
}

function metadataToken(name, value, place) {
  return value === undefined ? "" : ` ${name}=${asciiText(JSON.stringify(snapshotMetadata(value, place)))}`;
}

// Every distinct start position in the language's identifier/property/shorthand vocabulary, plus the
// constant/type/field forms used by reference candidate collection. No sampling or result limits.
// Nested identifier nodes sharing a start position are the same goto request, so query them once.
function identifierSites(parsed) {
  const types = new Set([
    ...parsed.sup.nodeTypes.identifier,
    ...(parsed.sup.nodeTypes.propertyIdentifier ?? []),
    ...(parsed.sup.nodeTypes.shorthandPropertyIdentifier ?? []),
    "constant",
    "type_identifier",
    "field_identifier",
  ]);
  if (parsed.sup.id === "php") types.add("object_creation_expression");
  const sites = [];
  const seen = new Set();
  const pending = [parsed.tree.rootNode];
  while (pending.length) {
    const node = pending.pop();
    if (types.has(node.type) && !seen.has(node.startIndex)) {
      seen.add(node.startIndex);
      sites.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        text: node.type === "object_creation_expression" ? "new" : parsed.source.slice(node.startIndex, node.endIndex),
      });
    }
    const children = node.namedChildren;
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
  return sites;
}

/**
 * @param {AnswerApi} api
 * @param {AnswerProject} project
 * @returns {Promise<string[]>}
 */
export async function answerProjectRecords(api, project, seenLanguages = new Set()) {
  const index = await api.buildProjectIndex(project.directory, { ...BUILD_OPTIONS, ...project.buildOptions });
  const bases = [...new Set([project.directory, fs.realpathSync(project.directory)])];
  const place = (file) => asciiText(`${project.prefix}${projectPath(bases, file)}`);
  const definition = (def) => `${place(def.file)}:${span(def.range)} ${def.kind} ${quoted(def.localName)}`;
  const records = [];
  const modules = [...index.byFile.values()].sort((left, right) => {
    const a = place(left.file);
    const b = place(right.file);
    return a < b ? -1 : Number(a > b);
  });
  const targets = new Map();
  let gotoCount = 0;
  let declarationCount = 0;
  for (const module of modules) {
    for (const def of module.locals) targets.set(definition(def), def);
    declarationCount += module.locals.length;
  }
  for (const module of modules) {
    const support = api.supportForFile(module.file, index.languageExtensions);
    if (support) seenLanguages.add(support.id);
    let parsed;
    let parseOutcome;
    try {
      parsed = await api.ensureParsedContextForIndex(index, module.file);
    } catch (error) {
      parseOutcome = unavailableAnswer(api, error, place);
    }
    const sites = parsed ? identifierSites(parsed) : [];
    const language = support?.id ?? "unsupported";
    const syntax = parseOutcome ?? "available";
    records.push(
      `file ${place(module.file)} language=${language} identifiers=${sites.length} declarations=${module.locals.length} syntax=${syntax}`,
    );
    for (const site of sites) {
      const result = await api.goToDefinition(
        index,
        { file: module.file, line: site.line, column: site.column },
        parsed,
      );
      let answer;
      if (result.status === "ok") {
        const label = definition(result.definition);
        if (!targets.has(label)) targets.set(label, result.definition);
        answer = `ok ${label}${metadataToken("via", result.via, place)}${metadataToken("prov", result.provenance, place)}`;
      } else answer = `not_found ${quoted(result.reason)}`;
      records.push(`goto ${place(module.file)}:${site.line}:${site.column} ${quoted(site.text)} -> ${answer}`);
    }
    gotoCount += sites.length;
  }
  const orderedTargets = [...targets].sort(([a], [b]) => (a < b ? -1 : Number(a > b)));
  for (const [label, def] of orderedTargets) {
    let result;
    try {
      result = await api.findReferences(index, { def });
    } catch (error) {
      records.push(`refs ${label} -> ${unavailableAnswer(api, error, place)}`);
      continue;
    }
    if (result.status !== "ok") {
      records.push(`refs ${label} -> not_found ${quoted(result.reason)}`);
      continue;
    }
    const coverage = result.referenceCoverage;
    const reasons = [...(coverage.reasons ?? [])].sort();
    const affected = (coverage.affectedFiles ?? []).map(place);
    records.push(
      `refs ${label} -> ok ${definition(result.definition)} coverage=${coverage.state} scope=${coverage.scope} reasons=${JSON.stringify(reasons)} affected=${JSON.stringify(affected)} count=${result.references.length}${metadataToken("prov", result.provenance, place)}`,
    );
    for (const [order, ref] of result.references.entries()) {
      records.push(
        `ref ${label} -> ${place(ref.file)}:${span(ref.range)} order=${order}${metadataToken("via", ref.via, place)}${metadataToken("prov", ref.provenance, place)}`,
      );
    }
  }
  records.push(
    `project ${project.label} files=${modules.length} goto=${gotoCount} declarations=${declarationCount} referenceTargets=${targets.size}`,
  );
  const pathPatterns = absoluteSnapshotPathPatterns([rootDir, ...bases]);
  for (const record of records) {
    if (pathPatterns.some((pattern) => pattern.test(record)))
      throw new Error("An answer contains an absolute checkout path.");
  }
  return records;
}

/** @returns {Promise<Map<string, string>>} */
export async function generateAnswerSnapshots(api, roots, requireAllLanguages = false, command = REGENERATE) {
  const snapshots = new Map();
  const seenLanguages = new Set();
  for (const root of roots) {
    const records = [];
    for (const project of root.projects) {
      try {
        const projectRecords = await answerProjectRecords(api, project, seenLanguages);
        for (const record of projectRecords) records.push(record);
      } catch (error) {
        throw new Error(`${project.label}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    }
    const text =
      [
        `# Generated by \`${command}\`; classify every changed answer before accepting it.`,
        `# Goto and reference answers for ${root.description}.`,
        "# Unique identifier and PHP new positions; references for declarations and deduplicated goto targets. 1-based, end-exclusive.",
        ...records.sort(),
      ].join("\n") + "\n";
    if (/[^\x20-\x7e\n]/u.test(text)) throw new Error(`${root.name}: snapshot contains non-ASCII text.`);
    const name = `${root.name}.txt`;
    if (snapshots.has(name)) throw new Error(`Two snapshot roots are named ${root.name}.`);
    snapshots.set(name, text);
  }
  if (requireAllLanguages) {
    const missing = api.LANGUAGE_SUPPORTS.map((support) => support.id).filter((id) => !seenLanguages.has(id));
    if (missing.length)
      throw new Error(`No answer snapshot project indexes registered language(s): ${missing.join(", ")}.`);
  }
  return snapshots;
}

function snapshotFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".txt"))
    .map((entry) => entry.name)
    .sort();
}

function readSnapshot(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function snapshotLines(text) {
  if (!text) return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

function describeDifferences(name, before, after) {
  const balance = new Map();
  for (const line of snapshotLines(before?.replaceAll("\r\n", "\n"))) balance.set(line, (balance.get(line) ?? 0) - 1);
  for (const line of snapshotLines(after)) balance.set(line, (balance.get(line) ?? 0) + 1);
  const removed = [];
  const added = [];
  for (const line of [...balance.keys()].sort()) {
    const count = balance.get(line);
    const changes = count < 0 ? removed : added;
    for (let index = 0; index < Math.abs(count); index += 1) changes.push(line);
  }
  const state = before === undefined ? "missing" : "answers differ";
  const report = [`${name}: ${state} (${added.length} added, ${removed.length} removed)`];
  for (const line of removed.slice(0, 10)) report.push(`  - ${line}`);
  for (const line of added.slice(0, 10)) report.push(`  + ${line}`);
  const omitted = Math.max(0, removed.length - 10) + Math.max(0, added.length - 10);
  if (omitted) report.push(`  ... and ${omitted} more differing lines`);
  if (!removed.length && !added.length) report.push("  Same lines, different order, line endings, or final newline.");
  if (before?.includes("\r")) report.push("  CR characters/CRLF line endings; snapshots require LF.");
  if (before && !before.endsWith("\n")) report.push("  Missing final newline; snapshots end with LF.");
  return report.join("\n");
}

function assertSnapshotWriteDirectory(directory) {
  for (const name of snapshotFiles(directory)) {
    const file = path.join(directory, name);
    const regularFile = fs.lstatSync(file).isFile();
    const owned = regularFile && /^# Generated by `npm run answers:snapshot(?::corpora)?`;/.test(readSnapshot(file));
    if (!owned)
      throw new Error(
        `Refusing to overwrite or remove unrelated .txt file ${name}; choose a dedicated snapshot scratch directory.`,
      );
  }
}

export function updateAnswerSnapshots(snapshots, directory, check = false, regenerate = REGENERATE) {
  const obsolete = snapshotFiles(directory).filter((file) => !snapshots.has(file));
  let changed = 0;
  const reports = [];
  if (!check) {
    assertSnapshotWriteDirectory(directory);
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const [name, actual] of snapshots) {
    const file = path.join(directory, name);
    const before = readSnapshot(file);
    if (before === actual) continue;
    changed += 1;
    if (check) {
      if (reports.length < 5) reports.push(describeDifferences(name, before, actual));
    } else fs.writeFileSync(file, actual, "utf8");
  }
  if (check) {
    if (changed || obsolete.length) {
      if (reports.length) console.error(reports.join("\n"));
      for (const name of obsolete.slice(0, 5)) console.error(`${name}: obsolete snapshot`);
      throw new Error(
        `Answer snapshot is stale: ${changed + obsolete.length} file(s) differ. Run \`${regenerate}\` and classify every changed answer before accepting the result.`,
      );
    }
    console.log(`Answer snapshot is up to date (${snapshots.size} files).`);
  } else {
    for (const name of obsolete) fs.rmSync(path.join(directory, name));
    console.log(`Answer snapshot: ${snapshots.size} files, ${changed} written, ${obsolete.length} removed.`);
  }
  const bytes = [...snapshots.values()].reduce((total, text) => total + Buffer.byteLength(text), 0);
  console.log(`Answer snapshot size: ${bytes} bytes.`);
}

function parseArgs(argv, pinned) {
  const options = {
    directory: pinned ? "" : DEFAULT_DIR,
    dist: path.join(rootDir, "dist"),
    explicitDirectory: false,
    corpusDir: "",
    families: "",
    check: false,
    help: false,
  };
  const values = { "--dir": "directory", "--dist": "dist" };
  if (pinned) Object.assign(values, { "--corpus-dir": "corpusDir", "--families": "families" });
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else {
      const key = values[arg];
      if (!key) throw new Error(`Unrecognized argument: ${arg}`);
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value after ${arg}.`);
      options[key] = value;
      if (arg === "--dir") options.explicitDirectory = true;
    }
  }
  return options;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function pinnedAnswerManifest() {
  const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(rootDir, relative), "utf8"));
  return resolveCorpusPins(readJson("scripts/benchmarks/corpus.json"), readJson("scripts/accuracy/corpus.json"));
}

/** @param {PinnedAnswerCorpus[]} [manifest] */
export function discoverPinnedAnswerRoots(corpusDir, families = "", manifest = pinnedAnswerManifest()) {
  const selected = families ? families.split(",") : manifest.map((corpus) => corpus.family);
  for (const family of selected) {
    if (!manifest.some((corpus) => corpus.family === family)) throw new Error(`Unknown family ${family}.`);
  }
  return manifest
    .filter((corpus) => selected.includes(corpus.family))
    .map((corpus) => {
      const directory = path.resolve(corpusDir, corpus.directory ?? corpus.id);
      const revision = git(directory, ["rev-parse", "HEAD"]);
      if (revision !== corpus.commit)
        throw new Error(`${corpus.id}: expected pinned commit ${corpus.commit}, found ${revision}.`);
      try {
        git(directory, ["diff", "--quiet", "HEAD", "--"]);
      } catch (error) {
        if (error.status === 1)
          throw new Error(`${corpus.id}: tracked inputs differ from pinned commit ${corpus.commit}.`, { cause: error });
        throw error;
      }
      if (git(directory, ["ls-files", "--others", "--exclude-standard"]))
        throw new Error(`${corpus.id}: untracked inputs would change the pinned corpus.`);
      return {
        name: corpus.id,
        description: `${corpus.id}@${corpus.commit}`,
        projects: [
          {
            directory,
            prefix: "",
            label: `${corpus.id}@${corpus.commit}`,
            buildOptions: { discovery: { includeGlobs: corpus.include ?? [], ignoreGlobs: corpus.exclude ?? [] } },
          },
        ],
      };
    });
}

// Resolve the existing ancestor too, so an output path through a directory alias cannot enter a corpus.
function realOutputPath(directory) {
  const suffix = [];
  let ancestor = path.resolve(directory);
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

export function assertAnswerScratchDirectory(directory, projectDirectories, distDirectory) {
  const output = realOutputPath(directory);
  const protectedDirectories = [rootDir, path.resolve(distDirectory, ".."), ...projectDirectories];
  for (const protectedDirectory of protectedDirectories) {
    const base = fs.realpathSync(protectedDirectory);
    if (contained(base, output) || contained(output, base))
      throw new Error("Pinned answer snapshots require a scratch --dir outside Codegraph and every indexed corpus.");
  }
}

/**
 * @param {string[]} argv
 * @param {boolean} [pinned]
 * @param {PinnedAnswerCorpus[]} [manifest]
 */
export async function runAnswerSnapshots(argv, pinned = false, manifest = undefined) {
  const options = parseArgs(argv, pinned);
  if (options.help) {
    console.log(
      [
        pinned
          ? "Usage: npm run answers:snapshot:corpora -- --corpus-dir <pinned-checkouts> --dir <external-scratch> [options]"
          : "Usage: npm run answers:snapshot -- [options]",
        pinned
          ? "One sorted ASCII file per selected pinned corpus; one shared index per corpus."
          : "One sorted ASCII file per samples project or edge-corpus language; one shared index per project.",
        "Goto at unique identifier/property/shorthand, constant/type/field and PHP new positions.",
        "References for every indexed declaration and deduplicated goto target; coverage, metadata and API order are recorded.",
        "Unsupported parsers are explicit outcomes, not empty answers. Graph-only files have zero syntax identifiers.",
        "Rename previews are excluded: they repeat reference collection plus per-file conflict and source verification.",
        "  --check          Compare without writing; report the first answer differences",
        `  --dir <path>     ${pinned ? "Required external scratch output; never committed" : `Snapshot output (default: ${DEFAULT_DIR}); explicit paths resolve against cwd`}`,
        "  --dist <path>    Read an already-built dist directory (for base/head comparisons); never rebuilds it",
        ...(pinned
          ? [
              "  --families <csv> Select benchmark families; output directory holds exactly this selection",
              "  --corpus-dir <path> Clean checkouts at scripts/benchmarks/corpus.json pins; never clones or modifies them",
            ]
          : []),
      ].join("\n"),
    );
    return;
  }
  if (pinned && (!options.directory || !options.corpusDir))
    throw new Error("Pinned mode requires --corpus-dir and an external scratch --dir.");
  const directory = options.explicitDirectory ? path.resolve(options.directory) : path.join(rootDir, DEFAULT_DIR);
  const distDirectory = path.resolve(options.dist);
  if (!options.check) assertSnapshotWriteDirectory(directory);
  const roots = pinned
    ? discoverPinnedAnswerRoots(options.corpusDir, options.families, manifest)
    : discoverAnswerRoots();
  if (pinned)
    assertAnswerScratchDirectory(
      directory,
      roots.flatMap((root) => root.projects.map((project) => project.directory)),
      distDirectory,
    );
  const api = await loadAnswerApi(distDirectory);
  const count = roots.reduce((total, root) => total + root.projects.length, 0);
  console.log(`Indexing ${count} answer projects in ${roots.length} snapshot files...`);
  const command = pinned ? "npm run answers:snapshot:corpora" : REGENERATE;
  const started = performance.now();
  const snapshots = await generateAnswerSnapshots(api, roots, !pinned, command);
  const regenerateArguments = [];
  if (pinned) regenerateArguments.push("--corpus-dir", path.resolve(options.corpusDir));
  if (options.explicitDirectory) regenerateArguments.push("--dir", directory);
  if (pinned || distDirectory !== path.join(rootDir, "dist")) regenerateArguments.push("--dist", distDirectory);
  if (options.families) regenerateArguments.push("--families", options.families);
  let regenerate = command;
  if (regenerateArguments.length) {
    regenerate += ` -- ${regenerateArguments.map((argument) => quoted(argument.split(path.sep).join("/"))).join(" ")}`;
  }
  updateAnswerSnapshots(snapshots, directory, options.check, regenerate);
  console.log(
    `Answer snapshot elapsed: ${((performance.now() - started) / 1000).toFixed(2)}s (index, answers, compare/write).`,
  );
}
