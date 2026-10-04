/**
 * Cross-consumer agreement harness for `goToDefinition`, `findReferences`, and
 * `buildSymbolGraphDetailed`: F1 of the 2026-09-25 accuracy audit checklist.
 *
 * For one use site, asserts that all three public consumers describe the same fact about the
 * same source position:
 *  - `goToDefinition` resolves the site to the expected declaration (or, for a site that must
 *    stay unresolved, returns `not_found`).
 *  - When resolved, `findReferences` from that declaration includes the site. Callers that set
 *    `requireCompleteCoverage` also require `referenceCoverage.state: "complete"`.
 *    `keywordReceiver` is the exception: `self`, `static`, `this`, and `$this` are not name
 *    references to the class. Goto and edges stay, the class's references omit the keyword,
 *    and coverage is `complete`.
 *  - When the site is itself a call, `extends`, mixin (`include`/`extend`), or construction, the
 *    matching `buildSymbolGraphDetailed` edge exists from the named enclosing declaration to the
 *    resolved declaration's node (or is proven absent, for a same-named decoy).
 *  - When the site must stay unresolved, the named definition's references omit the site. Coverage
 *    must not be `complete` unless `provablyNotAReference` says the site cannot be a reference of
 *    that definition (a classified receiver, a visibility rejection, a different binding).
 *  - `mustNotMatch` is that same exclusion for a same-named decoy the site must not select.
 *
 * A fixture is a flat map of project-relative paths to source text. Every site is addressed by
 * `file`/`line`/`token` rather than a raw column, so fixtures stay readable and edits to earlier
 * lines never silently invalidate a later site.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { buildProjectIndex, findReferences, goToDefinition, type ProjectIndex } from "../../src/index.js";
import { defNodeId } from "../../src/graphs/symbol-graph.js";
import { buildSymbolGraphDetailed, type DetailedSymbolGraph } from "../../src/graphs/symbol-graph-detailed.js";
import { normalizePath } from "../../src/util/paths.js";
import { mkTmpDir } from "./filesystem.js";

export type ConsumerAgreementFixture = {
  root: string;
  index: ProjectIndex;
  graph: DetailedSymbolGraph;
  /** Project-relative path -> normalized absolute path, for addressing sites and nodes. */
  paths: Record<string, string>;
  /** Project-relative path -> source text, as written to disk. */
  sources: Record<string, string>;
};

/** Writes `files` under a fresh temp root and builds the index and detailed graph once. */
export async function buildConsumerAgreementFixture(
  prefix: string,
  files: Readonly<Record<string, string>>,
): Promise<ConsumerAgreementFixture> {
  const root = await mkTmpDir(prefix);
  const paths: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, source, "utf8");
    paths[relative] = normalizePath(target);
    sources[relative] = source;
  }
  const index = await buildProjectIndex(root, { cache: "off" });
  const graph = await buildSymbolGraphDetailed(index);
  return { root, index, graph, paths, sources };
}

export async function disposeConsumerAgreementFixture(fixture: ConsumerAgreementFixture): Promise<void> {
  await fsp.rm(fixture.root, { recursive: true, force: true });
}

/** 1-based column of the `occurrence`-th (default first) match of `token` on a 1-based line. */
function columnOfOccurrence(source: string, line: number, token: string, occurrence: number): number {
  const text = source.split("\n")[line - 1];
  if (text === undefined) throw new Error(`line ${line} does not exist (file has ${source.split("\n").length} lines)`);
  let index = -1;
  for (let seen = 0; seen < occurrence; seen += 1) {
    index = text.indexOf(token, index + 1);
    if (index < 0) {
      throw new Error(`occurrence ${occurrence} of "${token}" not found on line ${line}: ${JSON.stringify(text)}`);
    }
  }
  return index + 1;
}

function requirePath(fixture: ConsumerAgreementFixture, relative: string): string {
  const resolved = fixture.paths[relative];
  if (!resolved) throw new Error(`fixture has no file "${relative}"`);
  return resolved;
}

/** The unique detailed-graph node declared by name in one file, or throws with the candidate count. */
export function findDetailedNode(
  fixture: ConsumerAgreementFixture,
  file: string,
  name: string,
): DetailedSymbolGraph["nodes"] extends Map<string, infer Node> ? Node : never {
  const targetFile = requirePath(fixture, file);
  const matches = [...fixture.graph.nodes.values()].filter(
    (node) => node.name === name && normalizePath(node.file) === targetFile,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one detailed-graph node named "${name}" in ${file}, found ${matches.length}` +
        (matches.length ? ` (kinds: ${matches.map((node) => node.kind).join(", ")})` : ""),
    );
  }
  return matches[0]!;
}

/** Whether `buildSymbolGraphDetailed` has an edge with `label` from `fromId` to `toId`. */
export function hasDetailedEdge(
  fixture: ConsumerAgreementFixture,
  fromId: string,
  toId: string,
  label: string,
): boolean {
  return fixture.graph.edges.some((edge) => edge.from === fromId && edge.to === toId && edge.label === label);
}

export type ConsumerAgreementEdge = {
  /** Detailed-graph edge label the site's resolution must (or, with `absent`, must not) produce. */
  label: string;
  /** Declaration the edge must originate from: the caller function, or the extending/including class. */
  from: { file: string; name: string };
  /**
   * Declaration the edge must reach. Defaults to the site's own resolved definition; set
   * explicitly only to prove a same-named decoy elsewhere is NOT the edge's target.
   */
  to?: { file: string; name: string };
  /** Asserts the edge is absent instead of present, for a decoy exclusion. */
  absent?: boolean;
};

type DeclarationAddress = { file: string; line: number; token: string; occurrence?: number };

export type ConsumerAgreementSite = {
  /** Project-relative file holding the use site. */
  file: string;
  /** 1-based line of the token. */
  line: number;
  /** Token whose occurrence on `line` is the use site. */
  token: string;
  /** Which occurrence of `token` on the line, 1-based. Defaults to the first. */
  occurrence?: number;
} & (
  | {
      /** The declaration this site must resolve to. */
      expected: { file: string; line: number };
      /** Asserts `findReferences` from the resolved declaration includes this site. Default true. */
      checkReferences?: boolean;
      /**
       * The site is a keyword receiver (`self`, `static`, `this`, `$this`), not a name
       * reference to the class. Goto and edges are unchanged. The class's references must
       * omit this site, and coverage must be `complete`.
       */
      keywordReceiver?: boolean;
      /**
       * Also require `referenceCoverage.state: "complete"`. Off by default so existing callers
       * keep the reference-list check without a new coverage assertion.
       */
      requireCompleteCoverage?: boolean;
      /** Detailed-graph edges this site's resolution must (or must not) produce. */
      edges?: readonly ConsumerAgreementEdge[];
    }
  | {
      /** This site must stay unresolved (no declaration proves it). */
      expected: "not_found";
      /**
       * A same-named declaration. Its references must not list this site. Coverage must not be
       * `complete` unless `provablyNotAReference` is set.
       */
      sameNameDeclaration?: DeclarationAddress;
      /**
       * The unresolved site cannot be a reference of `sameNameDeclaration` (the receiver was
       * classified, visibility rejects it, or another binding was proven). Coverage must be
       * `complete`. The comment at the call site says why.
       */
      provablyNotAReference?: boolean;
      /** Usually an absent edge: a call that stays unresolved must not be recorded. */
      edges?: readonly ConsumerAgreementEdge[];
    }
  | {
      /** Same-named declaration this site must not resolve to. */
      mustNotMatch: DeclarationAddress;
      /**
       * The site cannot be a reference of `mustNotMatch`. Coverage of that declaration must be
       * `complete`. When omitted, coverage must not be `complete`.
       */
      provablyNotAReference?: boolean;
      /** When set, this edge from the enclosing node to `mustNotMatch` must be absent. */
      absentEdge?: { label: string; from: { file: string; name: string } };
    }
);

type ResolvedDefinition = {
  file: string;
  localName: string;
  range: { start: { index?: number; line: number } };
};

function referenceListsSite(
  references: readonly { file: string; range: { start: { line: number } } }[],
  file: string,
  line: number,
): boolean {
  const siteKey = `${file}:${line}`;
  return references.some((reference) => `${normalizePath(reference.file)}:${reference.range.start.line}` === siteKey);
}

/** The detailed-graph node for a definition. Overloads share a name, so the definition id wins. */
function nodeForDefinition(
  fixture: ConsumerAgreementFixture,
  definition: ResolvedDefinition,
): DetailedSymbolGraph["nodes"] extends Map<string, infer Node> ? Node : never {
  const id = defNodeId(definition);
  const direct = fixture.graph.nodes.get(id);
  if (direct) return direct;
  const file = normalizePath(definition.file);
  const matches = [...fixture.graph.nodes.values()].filter(
    (node) => node.name === definition.localName && normalizePath(node.file) === file,
  );
  if (matches.length === 1) return matches[0]!;
  throw new Error(
    `no unique detailed-graph node for ${definition.localName} in ${definition.file} ` +
      `(id ${id}, name matches ${matches.length})`,
  );
}

function assertEdges(
  fixture: ConsumerAgreementFixture,
  siteLabel: string,
  edges: readonly ConsumerAgreementEdge[],
  defaultTarget: { nodeId: string; name: string; file: string } | undefined,
): void {
  for (const edgeSpec of edges) {
    const fromNode = findDetailedNode(fixture, edgeSpec.from.file, edgeSpec.from.name);
    const explicit = edgeSpec.to;
    const toNode = explicit ? findDetailedNode(fixture, explicit.file, explicit.name) : undefined;
    const toId = toNode?.id ?? defaultTarget?.nodeId;
    const toName = explicit?.name ?? defaultTarget?.name;
    const toFile = explicit?.file ?? defaultTarget?.file;
    if (!toId || !toName || !toFile) {
      throw new Error(`edge "${edgeSpec.label}" from ${siteLabel} has no target`);
    }
    const present = hasDetailedEdge(fixture, fromNode.id, toId, edgeSpec.label);
    const fromEdges = fixture.graph.edges
      .filter((edge) => edge.from === fromNode.id)
      .map((edge) => `${edge.label ?? "(none)"}->${fixture.graph.nodes.get(edge.to)?.name ?? edge.to}`)
      .join(", ");
    const description =
      `detailed-graph "${edgeSpec.label}" edge ${edgeSpec.from.name} (${edgeSpec.from.file}) -> ` +
      `${toName} (${toFile}), from site ${siteLabel}; edges from ${edgeSpec.from.name}: [${fromEdges}]`;
    expect(present, edgeSpec.absent ? `expected NO ${description}` : `expected ${description}`).toBe(!edgeSpec.absent);
  }
}

async function referencesFromDeclaration(
  fixture: ConsumerAgreementFixture,
  declaration: DeclarationAddress,
): Promise<Awaited<ReturnType<typeof findReferences>>> {
  const declFile = requirePath(fixture, declaration.file);
  const declSource = fixture.sources[declaration.file];
  if (declSource === undefined) throw new Error(`fixture has no file "${declaration.file}"`);
  const declColumn = columnOfOccurrence(declSource, declaration.line, declaration.token, declaration.occurrence ?? 1);
  return findReferences(fixture.index, {
    file: declFile,
    line: declaration.line,
    column: declColumn,
  });
}

function expectDeclarationExcludesSite(
  refs: Awaited<ReturnType<typeof findReferences>>,
  declaration: DeclarationAddress,
  siteFile: string,
  siteLine: number,
  siteLabel: string,
  provablyNotAReference: boolean | undefined,
): void {
  const declLabel = `${declaration.file}:${declaration.line}`;
  expect(refs.status, `findReferences(${declLabel})`).toBe("ok");
  if (refs.status !== "ok") return;
  expect(
    referenceListsSite(refs.references, siteFile, siteLine),
    `findReferences(${declLabel}) must not include ${siteLabel}`,
  ).toBe(false);
  const complete = refs.referenceCoverage.state === "complete";
  if (provablyNotAReference) {
    expect(
      complete,
      `findReferences(${declLabel}) must report coverage "complete": ${siteLabel} is provably not a reference`,
    ).toBe(true);
  } else {
    expect(
      complete,
      `findReferences(${declLabel}) reports coverage "complete" while ${siteLabel} is an unresolved ` +
        `same-name candidate use`,
    ).toBe(false);
  }
}

/** Asserts one use site's agreement across goToDefinition, findReferences, and the detailed graph. */
export async function assertConsumerAgreement(
  fixture: ConsumerAgreementFixture,
  site: ConsumerAgreementSite,
): Promise<void> {
  const file = requirePath(fixture, site.file);
  const source = fixture.sources[site.file];
  if (source === undefined) throw new Error(`fixture has no file "${site.file}"`);
  const column = columnOfOccurrence(source, site.line, site.token, site.occurrence ?? 1);
  const label = `${site.file}:${site.line} "${site.token}"`;
  const goto = await goToDefinition(fixture.index, { file, line: site.line, column });

  if ("mustNotMatch" in site) {
    const declaration = site.mustNotMatch;
    const declFile = requirePath(fixture, declaration.file);
    if (goto.status === "ok") {
      const matchedDecoy =
        normalizePath(goto.definition.file) === declFile && goto.definition.range.start.line === declaration.line;
      expect(matchedDecoy, `goToDefinition(${label}) must not resolve to ${declaration.file}:${declaration.line}`).toBe(
        false,
      );
    }
    const refs = await referencesFromDeclaration(fixture, declaration);
    expectDeclarationExcludesSite(refs, declaration, file, site.line, label, site.provablyNotAReference);
    if (site.absentEdge && refs.status === "ok") {
      const toNode = nodeForDefinition(fixture, refs.definition);
      assertEdges(fixture, label, [{ label: site.absentEdge.label, from: site.absentEdge.from, absent: true }], {
        nodeId: toNode.id,
        name: refs.definition.localName,
        file: declaration.file,
      });
    }
    return;
  }

  if (site.expected === "not_found") {
    expect(goto.status, `goToDefinition(${label})`).toBe("not_found");
    if (site.sameNameDeclaration) {
      const refs = await referencesFromDeclaration(fixture, site.sameNameDeclaration);
      expectDeclarationExcludesSite(refs, site.sameNameDeclaration, file, site.line, label, site.provablyNotAReference);
      if (site.edges && refs.status === "ok") {
        const toNode = nodeForDefinition(fixture, refs.definition);
        assertEdges(fixture, label, site.edges, {
          nodeId: toNode.id,
          name: refs.definition.localName,
          file: site.sameNameDeclaration.file,
        });
      }
    }
    return;
  }

  expect(goto.status, `goToDefinition(${label})`).toBe("ok");
  if (goto.status !== "ok") return;
  const expectedFile = requirePath(fixture, site.expected.file);
  expect(normalizePath(goto.definition.file), `goToDefinition(${label}) target file`).toBe(expectedFile);
  expect(goto.definition.range.start.line, `goToDefinition(${label}) target line`).toBe(site.expected.line);

  if (site.checkReferences !== false) {
    const refs = await findReferences(fixture.index, {
      file: expectedFile,
      line: site.expected.line,
      column: goto.definition.range.start.column,
    });
    expect(refs.status, `findReferences(${site.expected.file}:${site.expected.line})`).toBe("ok");
    if (refs.status === "ok") {
      const listed = referenceListsSite(refs.references, file, site.line);
      if (site.keywordReceiver) {
        expect(
          listed,
          `findReferences(${site.expected.file}:${site.expected.line}) must not include keyword receiver ${label}`,
        ).toBe(false);
        expect(
          refs.referenceCoverage.state,
          `findReferences(${site.expected.file}:${site.expected.line}) coverage ${JSON.stringify(refs.referenceCoverage)}`,
        ).toBe("complete");
      } else {
        expect(listed, `findReferences(${site.expected.file}:${site.expected.line}) must include ${label}`).toBe(true);
      }
      if (!site.keywordReceiver && site.requireCompleteCoverage) {
        expect(
          refs.referenceCoverage.state,
          `findReferences(${site.expected.file}:${site.expected.line}) coverage ${JSON.stringify(refs.referenceCoverage)}`,
        ).toBe("complete");
      }
    }
  }

  if (site.edges?.length) {
    const toNode = nodeForDefinition(fixture, goto.definition);
    assertEdges(fixture, label, site.edges, {
      nodeId: toNode.id,
      name: goto.definition.localName,
      file: site.expected.file,
    });
  }
}

/** Asserts every site in order against one fixture. */
export async function assertConsumerAgreementSites(
  fixture: ConsumerAgreementFixture,
  sites: readonly ConsumerAgreementSite[],
): Promise<void> {
  for (const site of sites) await assertConsumerAgreement(fixture, site);
}
