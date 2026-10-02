/**
 * Runs one call-form matrix cell (`./types.ts`) through the same checks every cell needs:
 *
 *  - the primary check: `goToDefinition`, `findReferences`, and `buildSymbolGraphDetailed` agree
 *    on the use site, and the same-named decoy is excluded (`../helpers/consumer-agreement.ts`
 *    already proves these facts together; this module adapts a `MatrixCell` to its site shape);
 *  - an unrelated same-named decoy file added in another directory must not change the answer;
 *  - a warm disk-cache build must match a cold build after EACH of a sequence of file mutations
 *    (add a decoy, rewrite the declaring file, delete the decoy, and -- for languages that
 *    resolve by declaration, not path -- rename the declaring file), matching the pattern in
 *    `../warm-cache-import-resolution.test.ts`. The comparison runs after every mutation, not
 *    only once at the end, so a warm/cold divergence is caught at the step that introduced it
 *    instead of being masked by a later step;
 *  - when a cell gives a `moved` variant, the answer follows the moved declaration.
 *
 * Both metamorphic checks above compare a richer snapshot than a bare goto label: the goto
 * target, the sorted `file:line` reference sites of the tracked declaration, whether the cell's
 * own decoy wrongly shows up among them, and the sorted set of `calls`/`instantiates` edges from
 * the enclosing caller. A mutation that leaves goto unchanged but adds a stray edge to the decoy,
 * or drops/gains a reference site, still fails the comparison.
 *
 * A cell marked `knownGap` runs through `it.fails`, so every assertion for it is expected to
 * fail today and the suite still flags the day it starts passing.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  findReferences,
  goToDefinition,
  type ProjectIndex,
} from "../../src/index.js";
import { DECLARATION_RESOLVED_IMPORT_LANGUAGES } from "../../src/indexer/import-resolution-tables.js";
import { buildSymbolGraphDetailed, type DetailedSymbolGraph } from "../../src/graphs/symbol-graph-detailed.js";
import { normalizePath } from "../../src/util/paths.js";
import {
  assertConsumerAgreement,
  buildConsumerAgreementFixture,
  disposeConsumerAgreementFixture,
  type ConsumerAgreementFixture,
  type ConsumerAgreementSite,
} from "../helpers/consumer-agreement.js";
import { mkTmpDir } from "../helpers/filesystem.js";
import { elsewhereDecoyFiles } from "./decoys.js";
import type { Language, MatrixCell, MovedVariant, TokenAddress } from "./types.js";

const LINE_COMMENT: Readonly<Record<Language, string>> = {
  ts: "//",
  tsx: "//",
  js: "//",
  python: "#",
  php: "//",
  go: "//",
  java: "//",
  c: "//",
  cpp: "//",
  csharp: "//",
  kotlin: "//",
  ruby: "#",
  rust: "//",
  swift: "//",
  zig: "//",
};

const DISK_BUILD = { cache: "disk" as const, native: "on" as const };
const COLD_BUILD = { cache: "off" as const, native: "on" as const };

/** A fixture-directory prefix for one phase of one cell's checks, e.g. "cgcf-cpp-bare-call-cell-". Scenario ids
 * contain characters such as "/", which Windows rejects in directory names, so this slugifies first. */
function fixturePrefix(cell: MatrixCell, phase: string): string {
  const slug = cell.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `cgcf-${slug}-${phase}-`;
}

/** 1-based column of the `occurrence`-th (default first) match of `token` on a 1-based line. Also validates the
 * address: a cell author's wrong line or token number fails here with a clear message, not a confusing goto diff. */
function columnAt(source: string, line: number, token: string, occurrence: number, label: string): number {
  const text = source.split("\n")[line - 1];
  if (text === undefined) {
    throw new Error(`${label}: line ${line} does not exist (file has ${source.split("\n").length} lines)`);
  }
  let index = -1;
  for (let seen = 0; seen < occurrence; seen += 1) {
    index = text.indexOf(token, index + 1);
    if (index < 0) {
      throw new Error(
        `${label}: occurrence ${occurrence} of "${token}" not found on line ${line}: ${JSON.stringify(text)}`,
      );
    }
  }
  return index + 1;
}

function requireFile(files: Readonly<Record<string, string>>, name: string, label: string): string {
  const source = files[name];
  if (source === undefined) throw new Error(`${label}: no file "${name}" in this cell's fixture`);
  return source;
}

function addressSite(address: TokenAddress): { file: string; line: number; token: string; occurrence?: number } {
  return {
    file: address.file,
    line: address.line,
    token: address.token,
    ...(address.occurrence !== undefined ? { occurrence: address.occurrence } : {}),
  };
}

/**
 * The primary cross-consumer check: goto/references/graph edge agree on the expected answer (or
 * `not_found`), and the same-named decoy is excluded. Delegates to
 * `../helpers/consumer-agreement.ts`, which already carries this logic.
 */
export async function runCellCore(cell: MatrixCell): Promise<void> {
  columnAt(
    requireFile(cell.files, cell.use.file, `${cell.id} use`),
    cell.use.line,
    cell.use.token,
    cell.use.occurrence ?? 1,
    `${cell.id} use`,
  );
  if (cell.expected !== "not_found") {
    columnAt(
      requireFile(cell.files, cell.expected.file, `${cell.id} expected`),
      cell.expected.line,
      cell.expected.token,
      cell.expected.occurrence ?? 1,
      `${cell.id} expected`,
    );
  }
  columnAt(
    requireFile(cell.files, cell.decoy.file, `${cell.id} decoy`),
    cell.decoy.line,
    cell.decoy.token,
    cell.decoy.occurrence ?? 1,
    `${cell.id} decoy`,
  );

  const fixture = await buildConsumerAgreementFixture(fixturePrefix(cell, "cell"), cell.files);
  try {
    const site = addressSite(cell.use);
    if (cell.expected === "not_found") {
      const unresolved: ConsumerAgreementSite = {
        ...site,
        expected: "not_found",
        sameNameDeclaration: cell.decoy,
        ...(cell.decoyAmbiguous ? {} : { provablyNotAReference: true }),
        ...(cell.edge
          ? {
              edges: [
                { label: cell.edge.label, from: { file: cell.edge.fromFile, name: cell.edge.fromName }, absent: true },
              ],
            }
          : {}),
      };
      await assertConsumerAgreement(fixture, unresolved);
      return;
    }
    const resolved: ConsumerAgreementSite = {
      ...site,
      expected: { file: cell.expected.file, line: cell.expected.line },
      requireCompleteCoverage: true,
      ...(cell.keywordUse ? { keywordReceiver: true } : {}),
      ...(cell.edge
        ? { edges: [{ label: cell.edge.label, from: { file: cell.edge.fromFile, name: cell.edge.fromName } }] }
        : {}),
    };
    await assertConsumerAgreement(fixture, resolved);
    const decoyExcluded: ConsumerAgreementSite = {
      ...site,
      mustNotMatch: cell.decoy,
      ...(cell.decoyAmbiguous ? {} : { provablyNotAReference: true }),
      ...(cell.edge
        ? { absentEdge: { label: cell.edge.label, from: { file: cell.edge.fromFile, name: cell.edge.fromName } } }
        : {}),
    };
    await assertConsumerAgreement(fixture, decoyExcluded);
  } finally {
    await disposeConsumerAgreementFixture(fixture);
  }
}

/**
 * A comparable answer for one use site, richer than a bare goto label so a metamorphic check
 * catches a regression goto alone would miss:
 *  - `goto`: the resolved declaration, relative to the project root, or "not_found";
 *  - `referenceSites`: sorted `file:line` sites `findReferences` reports for the tracked
 *    declaration (the cell's `expected`, or its `decoy` when `expected` is `not_found`);
 *  - `decoyInReferences`: whether the cell's own decoy declaration wrongly shows up among those
 *    sites -- a sign the decoy and the real declaration were conflated;
 *  - `callerEdges`: sorted `label->file#name` strings for every `calls`/`instantiates` edge from
 *    the enclosing caller the cell names, or `null` when the cell has no `edge`. Capturing the
 *    whole set (not just whether one specific edge is present) catches a stray extra edge, such
 *    as a new edge to the decoy, that a presence check alone would not.
 */
type AnswerSnapshot = {
  goto: string;
  referenceSites: readonly string[];
  decoyInReferences: boolean;
  callerEdges: readonly string[] | null;
};

async function snapshotAnswer(args: {
  index: ProjectIndex;
  graph: DetailedSymbolGraph;
  root: string;
  useFile: string;
  useLine: number;
  useColumn: number;
  /** The declaration whose `findReferences` call anchors `referenceSites`, resolved to this
   * build's current file path (a declaring file may have been renamed by the mutation sequence). */
  declaration: { file: string; line: number; column: number };
  /** The cell's own same-named decoy, resolved to this build's current file path. */
  decoySite: { file: string; line: number };
  /** The enclosing caller a `calls`/`instantiates` edge must originate from, when the cell names one. */
  caller?: { fromFile: string; fromName: string } | undefined;
}): Promise<AnswerSnapshot> {
  const rootNorm = normalizePath(args.root).replace(/\/$/, "");
  const relative = (file: string) => {
    const normalized = normalizePath(file);
    return normalized.startsWith(rootNorm + "/") ? normalized.slice(rootNorm.length + 1) : normalized;
  };

  const goto = await goToDefinition(args.index, { file: args.useFile, line: args.useLine, column: args.useColumn });
  const gotoLabel =
    goto.status === "ok" ? `${relative(goto.definition.file)}:${goto.definition.range.start.line}` : "not_found";

  const refs = await findReferences(args.index, {
    file: args.declaration.file,
    line: args.declaration.line,
    column: args.declaration.column,
  });
  // Every reference keeps its column and its duplicates, so two uses on one line stay two entries.
  const referenceSites =
    refs.status === "ok"
      ? refs.references
          .map(
            (reference) => `${relative(reference.file)}:${reference.range.start.line}:${reference.range.start.column}`,
          )
          .sort()
      : [];
  const decoyLine = `${relative(args.decoySite.file)}:${args.decoySite.line}:`;
  const decoyInReferences = referenceSites.some((site) => site.startsWith(decoyLine));

  let callerEdges: readonly string[] | null = null;
  const caller = args.caller;
  if (caller) {
    const fromMatches = [...args.graph.nodes.values()].filter(
      (node) => node.name === caller.fromName && normalizePath(node.file) === normalizePath(caller.fromFile),
    );
    if (fromMatches.length !== 1) {
      throw new Error(
        `expected exactly one caller node named "${caller.fromName}" in ${caller.fromFile}, found ${fromMatches.length}`,
      );
    }
    const fromNode = fromMatches[0]!;
    callerEdges = args.graph.edges
      .filter((edge) => edge.from === fromNode.id && (edge.label === "calls" || edge.label === "instantiates"))
      .map((edge) => {
        const toNode = args.graph.nodes.get(edge.to);
        // The node id ends with the declaration's start index, which separates a target from a
        // same-named decoy in the same file.
        const start = edge.to.slice(edge.to.lastIndexOf("::") + 2);
        return `${edge.label}->${toNode ? `${relative(toNode.file)}#${toNode.name}@${start}` : edge.to}`;
      })
      .sort();
  }

  return { goto: gotoLabel, referenceSites, decoyInReferences, callerEdges };
}

async function cellSnapshot(fixture: ConsumerAgreementFixture, cell: MatrixCell): Promise<AnswerSnapshot> {
  const useFile = fixture.paths[cell.use.file]!;
  const useSource = fixture.sources[cell.use.file]!;
  const useColumn = columnAt(useSource, cell.use.line, cell.use.token, cell.use.occurrence ?? 1, `${cell.id} use`);

  const trackedAddress = cell.expected === "not_found" ? cell.decoy : cell.expected;
  const trackedSource = fixture.sources[trackedAddress.file]!;
  const trackedColumn = columnAt(
    trackedSource,
    trackedAddress.line,
    trackedAddress.token,
    trackedAddress.occurrence ?? 1,
    `${cell.id} tracked declaration`,
  );

  const caller = cell.edge ? { fromFile: fixture.paths[cell.edge.fromFile]!, fromName: cell.edge.fromName } : undefined;

  return snapshotAnswer({
    index: fixture.index,
    graph: fixture.graph,
    root: fixture.root,
    useFile,
    useLine: cell.use.line,
    useColumn,
    declaration: { file: fixture.paths[trackedAddress.file]!, line: trackedAddress.line, column: trackedColumn },
    decoySite: { file: fixture.paths[cell.decoy.file]!, line: cell.decoy.line },
    caller,
  });
}

/** Metamorphic check (a): an unrelated same-named decoy file, added in a directory nothing else in the
 * project reaches, must not change the use site's answer. */
export async function runUnrelatedDecoyMetamorphic(cell: MatrixCell): Promise<void> {
  const baseline = await buildConsumerAgreementFixture(fixturePrefix(cell, "base"), cell.files);
  try {
    const before = await cellSnapshot(baseline, cell);
    const name = cell.expected === "not_found" ? cell.decoy.token : cell.expected.token;
    const decoyFiles = elsewhereDecoyFiles(cell.language, name, cell.decoyKind);
    const noisy = await buildConsumerAgreementFixture(fixturePrefix(cell, "noise"), { ...cell.files, ...decoyFiles });
    try {
      const after = await cellSnapshot(noisy, cell);
      expect(after, `${cell.id}: an unrelated same-named decoy elsewhere must not change the answer`).toEqual(before);
    } finally {
      await disposeConsumerAgreementFixture(noisy);
    }
  } finally {
    await disposeConsumerAgreementFixture(baseline);
  }
}

/**
 * Metamorphic check (b): a warm disk-cache build must match a cold build after EACH of a
 * sequence of mutations applied to one project (add a decoy, rewrite the declaring file, delete
 * the decoy, and, for declaration-resolved languages, rename the declaring file). Warm and cold
 * share one on-disk project (`root`): the cold build just re-reads it with `cache: "off"`, so
 * comparing after every step costs one extra from-scratch build per step, not a second project.
 */
export async function runWarmColdMetamorphic(cell: MatrixCell): Promise<void> {
  const root = await mkTmpDir(fixturePrefix(cell, "wc"));
  try {
    const current = new Map<string, string>();
    for (const [relative, source] of Object.entries(cell.files)) {
      const absolute = path.join(root, relative);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, source, "utf8");
      current.set(relative, absolute);
    }

    const declarationName = cell.expected === "not_found" ? cell.decoy.token : cell.expected.token;
    const declaringRelative = cell.expected === "not_found" ? cell.decoy.file : cell.expected.file;
    const trackedAddress = cell.expected === "not_found" ? cell.decoy : cell.expected;
    const trackedSource = requireFile(cell.files, trackedAddress.file, `${cell.id} tracked declaration`);
    const trackedColumn = columnAt(
      trackedSource,
      trackedAddress.line,
      trackedAddress.token,
      trackedAddress.occurrence ?? 1,
      `${cell.id} tracked declaration`,
    );
    const useSource = requireFile(cell.files, cell.use.file, `${cell.id} use`);
    const useColumn = columnAt(useSource, cell.use.line, cell.use.token, cell.use.occurrence ?? 1, `${cell.id} use`);

    let warmIndex = await buildProjectIndex(root, DISK_BUILD);

    /** Snapshots the current on-disk state through both the just-rebuilt `warmIndex` and a fresh
     * cold build, then asserts they agree. Called after every mutation below, so a divergence is
     * caught at the step that introduced it instead of being masked by a later step. */
    const compareWarmToCold = async (step: string): Promise<void> => {
      const coldIndex = await buildProjectIndex(root, COLD_BUILD);
      const warmGraph = await buildSymbolGraphDetailed(warmIndex);
      const coldGraph = await buildSymbolGraphDetailed(coldIndex);
      const useFile = current.get(cell.use.file)!;
      const declaration = {
        file: current.get(trackedAddress.file)!,
        line: trackedAddress.line,
        column: trackedColumn,
      };
      const decoySite = { file: current.get(cell.decoy.file)!, line: cell.decoy.line };
      const caller = cell.edge
        ? { fromFile: current.get(cell.edge.fromFile)!, fromName: cell.edge.fromName }
        : undefined;
      const warmSnapshot = await snapshotAnswer({
        index: warmIndex,
        graph: warmGraph,
        root,
        useFile,
        useLine: cell.use.line,
        useColumn,
        declaration,
        decoySite,
        caller,
      });
      const coldSnapshot = await snapshotAnswer({
        index: coldIndex,
        graph: coldGraph,
        root,
        useFile,
        useLine: cell.use.line,
        useColumn,
        declaration,
        decoySite,
        caller,
      });
      expect(warmSnapshot, `${cell.id}: warm disk-cache build must match a cold build after ${step}`).toEqual(
        coldSnapshot,
      );
    };

    // Add an unrelated same-named decoy file.
    const decoyFiles = elsewhereDecoyFiles(cell.language, declarationName, cell.decoyKind);
    const decoyAbsolutePaths: string[] = [];
    for (const [relative, source] of Object.entries(decoyFiles)) {
      const absolute = path.join(root, relative);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, source, "utf8");
      decoyAbsolutePaths.push(absolute);
    }
    warmIndex = await buildProjectIndexIncremental(root, DISK_BUILD);
    await compareWarmToCold("adding an unrelated same-named decoy file");

    // Rewrite the declaring file: append a trailing comment, which never shifts an earlier line.
    const declaringAbsolute = current.get(declaringRelative)!;
    const originalSource = requireFile(cell.files, declaringRelative, `${cell.id} declaring file`);
    const comment = LINE_COMMENT[cell.language];
    await fsp.writeFile(declaringAbsolute, `${originalSource}\n${comment} metamorphic-rewrite\n`, "utf8");
    warmIndex = await buildProjectIndexIncremental(root, DISK_BUILD);
    await compareWarmToCold("rewriting the declaring file");

    // Delete the decoy.
    for (const absolute of decoyAbsolutePaths) await fsp.rm(absolute, { force: true });
    warmIndex = await buildProjectIndexIncremental(root, DISK_BUILD);
    await compareWarmToCold("deleting the unrelated decoy file");

    // Rename the declaring file, only where the language resolves by declaration, not path (see the top-of-file
    // comment): renaming a path-resolved import's target would break the import itself.
    if (DECLARATION_RESOLVED_IMPORT_LANGUAGES.has(cell.language)) {
      const renamed = declaringAbsolute.replace(/(\.[^./\\]+)$/, "-renamed$1");
      await fsp.rename(declaringAbsolute, renamed);
      current.set(declaringRelative, renamed);
      warmIndex = await buildProjectIndexIncremental(root, DISK_BUILD);
      await compareWarmToCold("renaming the declaring file");
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

/** Metamorphic check (c): when a cell gives a `moved` variant, the answer must follow the moved declaration. */
export async function runMovedVariant(cell: MatrixCell, moved: MovedVariant): Promise<void> {
  columnAt(
    requireFile(moved.files, moved.expected.file, `${cell.id} moved.expected`),
    moved.expected.line,
    moved.expected.token,
    moved.expected.occurrence ?? 1,
    `${cell.id} moved.expected`,
  );
  const fixture = await buildConsumerAgreementFixture(fixturePrefix(cell, "moved"), moved.files);
  try {
    const site: ConsumerAgreementSite = {
      ...addressSite(cell.use),
      expected: { file: moved.expected.file, line: moved.expected.line },
      requireCompleteCoverage: true,
      ...(cell.edge
        ? { edges: [{ label: cell.edge.label, from: { file: cell.edge.fromFile, name: cell.edge.fromName } }] }
        : {}),
    };
    await assertConsumerAgreement(fixture, site);
    const decoy = moved.decoy ?? cell.decoy;
    columnAt(
      requireFile(moved.files, decoy.file, `${cell.id} moved decoy`),
      decoy.line,
      decoy.token,
      decoy.occurrence ?? 1,
      `${cell.id} moved decoy`,
    );
    await assertConsumerAgreement(fixture, {
      ...addressSite(cell.use),
      mustNotMatch: decoy,
      ...(cell.decoyAmbiguous ? {} : { provablyNotAReference: true }),
      ...(cell.edge
        ? { absentEdge: { label: cell.edge.label, from: { file: cell.edge.fromFile, name: cell.edge.fromName } } }
        : {}),
    });
  } finally {
    await disposeConsumerAgreementFixture(fixture);
  }
}

/**
 * Registers every check for every cell under the enclosing `describe`.
 *
 * A `knownGap` cell runs only the primary check, through `it.fails`: the gap is already known to
 * break goto, references, or the graph edge, so a metamorphic check could pass or fail on its own
 * schedule (an unrelated-noise or warm/cold comparison of two equally wrong answers often still
 * agrees), which would make `it.fails` flag a confusing, unrelated "no longer failing" result.
 * Metamorphic checks only run once the primary answer is correct.
 */
export function registerMatrixSuite(cells: readonly MatrixCell[]): void {
  for (const cell of cells) {
    describe(cell.id, () => {
      const gap = cell.knownGap;
      if (gap) {
        it.fails(
          `${cell.id}: resolves and agrees across goto, references, and the detailed graph (${gap.reason})`,
          () => runCellCore(cell),
        );
        return;
      }
      it(`${cell.id}: resolves and agrees across goto, references, and the detailed graph`, () => runCellCore(cell));
      it(`${cell.id}: an unrelated same-named decoy elsewhere does not change the answer`, () =>
        runUnrelatedDecoyMetamorphic(cell));
      it(`${cell.id}: a warm disk-cache build matches a cold build across a mutation sequence`, () =>
        runWarmColdMetamorphic(cell));
      const moved = cell.moved;
      if (moved) {
        it(`${cell.id}: moving the declaration keeps the answer on the moved declaration`, () =>
          runMovedVariant(cell, moved));
      }
    });
  }
}
