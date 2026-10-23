import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findReferences, goToDefinition } from "../src/index.js";
import { buildProjectIndex, parseFile } from "../src/indexer.js";
import type { SyntaxNodeLike } from "../src/languages/types.js";
import { getLanguageById } from "../src/languages/registry.js";
import { fileIdentityKey } from "../src/util/paths.js";

type MarkerKind = "def" | "ref" | "not-ref" | "goto" | "coverage" | "known-gap";
type CoverageState = "complete" | "partial";
type Marker = {
  kind: MarkerKind;
  id: string;
  file: string;
  line: number;
  state?: CoverageState;
  observed?: string;
};
type ParsedSource = Awaited<ReturnType<typeof parseFile>>;
type DefinitionSite = { file: string; line: number; column: number; name: string };
type Scenario = { language: string; root: string };

const commentPrefixes: Record<string, string> = { typescript: "//", python: "#" };
const assertionKinds = new Set<MarkerKind>(["ref", "not-ref", "goto", "coverage"]);
const markerPattern = /@(def|ref|not-ref|goto|coverage|known-gap)\s+([\w.-]+)/g;

function walkNodes(root: SyntaxNodeLike, visit: (node: SyntaxNodeLike) => void): void {
  visit(root);
  for (const child of root.namedChildren) walkNodes(child, visit);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function discoverScenarios(samplesRoot: string): Promise<Scenario[]> {
  const languages = await fs.readdir(samplesRoot, { withFileTypes: true });
  const scenarios: Scenario[] = [];
  for (const language of languages.filter((entry) => entry.isDirectory())) {
    const edgeRoot = path.join(samplesRoot, language.name);
    let entries;
    try {
      entries = await fs.readdir(edgeRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    const childScenarios = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(edgeRoot, entry.name));
    scenarios.push(...childScenarios.map((root) => ({ language: language.name, root })));
    if (entries.some((entry) => entry.isFile())) scenarios.push({ language: language.name, root: edgeRoot });
  }
  return scenarios.sort((left, right) => left.root.localeCompare(right.root));
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function extractMarkers(parsed: ParsedSource, file: string, commentPrefix: string): Marker[] {
  const language = getLanguageById(parsed.sup.id);
  if (!language) throw new Error(`Missing language definition for ${parsed.sup.id}`);
  const commentTypes = new Set(language.structure.comments);
  const markers: Marker[] = [];
  walkNodes(parsed.tree.rootNode, (node) => {
    if (!commentTypes.has(node.type)) return;
    const comment = node.text.trimStart();
    if (!comment.startsWith(commentPrefix)) return;
    const line = parsed.source.split(/\r?\n/)[node.startPosition.row] ?? "";
    const beforeComment = line.slice(0, node.startPosition.column);
    const siteRow = beforeComment.trim() ? node.startPosition.row : node.endPosition.row + 1;
    const body = comment.slice(commentPrefix.length);
    for (const match of body.matchAll(markerPattern)) {
      const kind = match[1] as MarkerKind;
      const id = match[2] ?? "";
      const followingText = body.slice((match.index ?? 0) + match[0].length).trimStart();
      const stateMatch = kind === "coverage" ? /^(complete|partial)\b/.exec(followingText) : null;
      const observedMatch = kind === "known-gap" ? /(?:^|\s)observed=([\w.-]+)/.exec(followingText) : null;
      markers.push({
        kind,
        id,
        file,
        line: siteRow + 1,
        ...(stateMatch ? { state: stateMatch[1] as CoverageState } : {}),
        ...(observedMatch ? { observed: observedMatch[1] } : {}),
      });
    }
  });
  return markers;
}

function identifierNodesOnLine(parsed: ParsedSource, line: number): SyntaxNodeLike[] {
  const nodeTypes = new Set([
    ...parsed.sup.nodeTypes.identifier,
    ...(parsed.sup.nodeTypes.propertyIdentifier ?? []),
    ...(parsed.sup.nodeTypes.shorthandPropertyIdentifier ?? []),
  ]);
  const nodes: SyntaxNodeLike[] = [];
  walkNodes(parsed.tree.rootNode, (node) => {
    if (nodeTypes.has(node.type) && node.startPosition.row + 1 === line) nodes.push(node);
  });
  return nodes;
}

function relativeFile(file: string): string {
  return path.relative(process.cwd(), file).replaceAll("\\", "/");
}

function sameFile(left: string, right: string): boolean {
  return fileIdentityKey(left) === fileIdentityKey(right);
}

describe("Tree-sitter edge corpus", () => {
  it("checks marker expectations across each per-language scenario", async () => {
    const samplesRoot = path.resolve(process.cwd(), "tests", "edge-corpus");
    const scenarios = await discoverScenarios(samplesRoot);
    const failures: string[] = [];
    const assertionCounts = new Map<string, number>();
    const knownGaps: string[] = [];

    for (const scenario of scenarios) {
      const commentPrefix = commentPrefixes[scenario.language];
      if (!commentPrefix) {
        failures.push(`${relativeFile(scenario.root)}: unsupported edge-corpus comment prefix`);
        continue;
      }
      const files = await sourceFiles(scenario.root);
      const index = await buildProjectIndex(scenario.root, { cache: "off" });
      const parsedByFile = new Map<string, ParsedSource>();
      const sourceByFile = new Map<string, string>();
      const markers: Marker[] = [];

      for (const file of files) {
        const parsed = await parseFile(file);
        parsedByFile.set(file, parsed);
        sourceByFile.set(file, parsed.source);
        markers.push(...extractMarkers(parsed, file, commentPrefix));
      }

      const definitions = new Map<string, DefinitionSite>();
      for (const marker of markers.filter((entry) => entry.kind === "def")) {
        const parsed = parsedByFile.get(marker.file);
        if (!parsed) {
          failures.push(`${relativeFile(marker.file)}:${marker.line} @def ${marker.id}: file was not parsed`);
          continue;
        }
        const nodes = identifierNodesOnLine(parsed, marker.line);
        const matching = nodes.filter((node) => node.text === marker.id);
        let selected: SyntaxNodeLike | undefined;
        if (matching.length === 1) selected = matching[0];
        else if (!matching.length && nodes.length) selected = nodes[nodes.length - 1];
        if (!selected) {
          failures.push(
            `${relativeFile(marker.file)}:${marker.line} @def ${marker.id}: expected one matching identifier, found ${nodes.map((node) => node.text).join(", ") || "none"}`,
          );
          continue;
        }
        if (definitions.has(marker.id)) {
          failures.push(
            `${relativeFile(marker.file)}:${marker.line} @def ${marker.id}: duplicate definition id in scenario`,
          );
          continue;
        }
        definitions.set(marker.id, {
          file: marker.file,
          line: marker.line,
          column: selected.startPosition.column + 1,
          name: selected.text,
        });
      }

      const referencesById = new Map<string, Awaited<ReturnType<typeof findReferences>>>();
      for (const [id, definition] of definitions) {
        referencesById.set(id, await findReferences(index, definition));
      }
      const knownGapsBySite = new Map<string, Marker>();
      for (const marker of markers.filter((entry) => entry.kind === "known-gap")) {
        knownGapsBySite.set(`${marker.file}:${marker.line}`, marker);
        if (!marker.observed) {
          failures.push(
            `${relativeFile(marker.file)}:${marker.line} @known-gap ${marker.id}: expected observed=<value>`,
          );
        }
      }

      for (const marker of markers) {
        if (!assertionKinds.has(marker.kind)) continue;
        assertionCounts.set(scenario.language, (assertionCounts.get(scenario.language) ?? 0) + 1);
        const location = `${relativeFile(marker.file)}:${marker.line}`;
        const sourceLine = (sourceByFile.get(marker.file)?.split(/\r?\n/)[marker.line - 1] ?? "").trim();
        const knownGap = knownGapsBySite.get(`${marker.file}:${marker.line}`);
        const gapReason = knownGap?.id;
        const references = referencesById.get(marker.id);

        if (marker.kind === "goto") {
          const target = definitions.get(marker.id);
          if (!target) {
            failures.push(`${location} @goto ${marker.id}: definition marker was not found`);
            continue;
          }
          const reference =
            references?.status === "ok"
              ? references.references.find(
                  (entry) => sameFile(entry.file, marker.file) && entry.range.start.line === marker.line,
                )
              : undefined;
          const parsed = parsedByFile.get(marker.file);
          const candidates = parsed ? identifierNodesOnLine(parsed, marker.line) : [];
          const selected = candidates.find((node) => node.text === target.name) ?? candidates[candidates.length - 1];
          const column = reference?.range.start.column ?? (selected ? selected.startPosition.column + 1 : undefined);
          if (column === undefined) {
            failures.push(
              `${location} @goto ${marker.id}: no identifier site to navigate from; input=${JSON.stringify(sourceLine)}`,
            );
            continue;
          }
          const result = await goToDefinition(index, { file: marker.file, line: marker.line, column });
          if (gapReason) {
            let observed: string = result.status;
            if (result.status === "ok") {
              observed =
                [...definitions].find(
                  ([, definition]) =>
                    sameFile(result.definition.file, definition.file) &&
                    result.definition.range.start.line === definition.line,
                )?.[0] ?? `${relativeFile(result.definition.file)}:${result.definition.range.start.line}`;
            }
            if (observed !== knownGap?.observed)
              failures.push(
                `${location} @goto ${marker.id} @known-gap ${gapReason}: expected observed=${knownGap?.observed}, got ${observed}`,
              );
            if (
              result.status === "ok" &&
              sameFile(result.definition.file, target.file) &&
              result.definition.range.start.line === target.line
            )
              failures.push(`${location} @goto ${marker.id} @known-gap ${gapReason}: gap disappeared`);
            knownGaps.push(
              `${scenario.language}: ${location} input=${JSON.stringify(sourceLine)}; expected goto to ${relativeFile(target.file)}:${target.line}; observed ${observed}; reason=${gapReason}`,
            );
          } else {
            let gotoSucceeded = false;
            if (result.status === "ok") {
              if (sameFile(result.definition.file, target.file)) {
                gotoSucceeded = result.definition.range.start.line === target.line;
              }
            }
            if (!gotoSucceeded) {
              let observed: string = result.status;
              if (result.status === "ok")
                observed = `${relativeFile(result.definition.file)}:${result.definition.range.start.line}`;
              failures.push(
                `${location} @goto ${marker.id}: expected ${relativeFile(target.file)}:${target.line}, observed ${observed}; input=${JSON.stringify(sourceLine)}`,
              );
            }
          }
          continue;
        }

        if (!references) {
          failures.push(`${location} @${marker.kind} ${marker.id}: missing @def marker`);
          continue;
        }
        if (references.status !== "ok") {
          if (gapReason && marker.kind === "coverage" && knownGap?.observed !== references.status) {
            failures.push(
              `${location} @coverage ${marker.id} @known-gap ${gapReason}: expected observed=${knownGap?.observed}, got ${references.status}`,
            );
          }
          if (gapReason && marker.kind === "ref" && knownGap?.observed !== "none") {
            failures.push(
              `${location} @ref ${marker.id} @known-gap ${gapReason}: expected observed=${knownGap?.observed}, got none`,
            );
          }
          if (gapReason && references.status === "not_found" && marker.kind === "coverage") {
            knownGaps.push(
              `${scenario.language}: ${location} input=${JSON.stringify(sourceLine)}; expected ${marker.state ?? "coverage"}; observed not_found; reason=${gapReason}`,
            );
          } else if (gapReason && references.status === "not_found" && marker.kind === "ref") {
            knownGaps.push(
              `${scenario.language}: ${location} input=${JSON.stringify(sourceLine)}; expected reference to ${marker.id}; observed not_found; reason=${gapReason}`,
            );
          } else if (gapReason && references.status === "not_found" && marker.kind === "not-ref") {
            knownGaps.push(
              `${scenario.language}: ${location} input=${JSON.stringify(sourceLine)}; expected no reference to ${marker.id}; observed not_found; reason=${gapReason}`,
            );
          } else {
            failures.push(
              `${location} @${marker.kind} ${marker.id}: definition has no usable findReferences result (${references.status})`,
            );
          }
          continue;
        }
        const matchingReferences = references.references.filter(
          (reference) => sameFile(reference.file, marker.file) && reference.range.start.line === marker.line,
        );

        if (marker.kind === "coverage") {
          if (!marker.state) {
            failures.push(`${location} @coverage ${marker.id}: expected complete or partial`);
          } else if (gapReason) {
            const observed = references.referenceCoverage?.state ?? "unknown";
            if (observed === marker.state)
              failures.push(`${location} @coverage ${marker.id} @known-gap ${gapReason}: gap disappeared`);
            if (observed !== knownGap?.observed)
              failures.push(
                `${location} @coverage ${marker.id} @known-gap ${gapReason}: expected observed=${knownGap?.observed}, got ${observed}`,
              );
          } else if (references.referenceCoverage?.state !== marker.state) {
            failures.push(
              `${location} @coverage ${marker.id}: expected ${marker.state}, observed ${references.referenceCoverage?.state ?? "unknown"}`,
            );
          }
        } else if (marker.kind === "ref") {
          if (gapReason) {
            const observed = matchingReferences.length ? marker.id : "none";
            if (observed !== knownGap?.observed)
              failures.push(
                `${location} @ref ${marker.id} @known-gap ${gapReason}: expected observed=${knownGap?.observed}, got ${observed}`,
              );
            if (matchingReferences.length)
              failures.push(`${location} @ref ${marker.id} @known-gap ${gapReason}: gap disappeared`);
            knownGaps.push(
              `${scenario.language}: ${location} input=${JSON.stringify(sourceLine)}; expected reference to ${marker.id}; observed ${observed}; reason=${gapReason}`,
            );
          } else if (!matchingReferences.length) {
            failures.push(
              `${location} @ref ${marker.id}: expected a reference, observed none; input=${JSON.stringify(sourceLine)}`,
            );
          }
        } else if (marker.kind === "not-ref") {
          if (matchingReferences.length) {
            failures.push(
              `${location} @not-ref ${marker.id}: expected no reference, observed ${matchingReferences.length}; input=${JSON.stringify(sourceLine)}`,
            );
          }
        }
      }

      for (const marker of markers.filter((entry) => entry.kind === "known-gap")) {
        const hasAssertion = markers.some(
          (entry) => assertionKinds.has(entry.kind) && entry.file === marker.file && entry.line === marker.line,
        );
        if (!hasAssertion)
          failures.push(
            `${relativeFile(marker.file)}:${marker.line} @known-gap ${marker.id}: missing paired assertion marker`,
          );
      }
    }

    for (const language of Object.keys(commentPrefixes)) {
      const count = assertionCounts.get(language) ?? 0;
      if (count < 25 || count > 45) failures.push(`${language}: expected 25-45 edge assertions, observed ${count}`);
    }
    if (knownGaps.length) {
      process.stdout.write(`Known edge-corpus gaps:\n${knownGaps.join("\n")}\n`);
    }
    expect(failures, [...failures, ...knownGaps].join("\n")).toEqual([]);
  });
});
