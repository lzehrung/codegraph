/**
 * Cross-consumer agreement harness for `goToDefinition`, `findReferences`, and
 * `buildSymbolGraphDetailed`: F1 of the 2026-09-25 accuracy audit checklist.
 *
 * For one use site, asserts that all three public consumers describe the same fact about the
 * same source position:
 *  - `goToDefinition` resolves the site to the expected declaration (or, for a site that must
 *    stay unresolved, returns `not_found`).
 *  - When resolved, `findReferences` from that declaration includes the site.
 *  - When the site is itself a call, `extends`, mixin (`include`/`extend`), or construction, the
 *    matching `buildSymbolGraphDetailed` edge exists from the named enclosing declaration to the
 *    resolved declaration's node (or is proven absent, for a same-named decoy).
 *  - When the site must stay unresolved, a same-named declaration elsewhere must not report
 *    `referenceCoverage.state: "complete"` while the site's own file holds an unresolved
 *    candidate use of the same name (the F3 "no complete coverage over an unchecked candidate"
 *    rule).
 *
 * A fixture is a flat map of project-relative paths to source text. Every site is addressed by
 * `file`/`line`/`token` rather than a raw column, so fixtures stay readable and edits to earlier
 * lines never silently invalidate a later site.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import {
  buildProjectIndex,
  findReferences,
  goToDefinition,
  type ProjectIndex,
} from "../../src/index.js";
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
  const index = await buildProjectIndex(root, { cache: "off", native: "on" });
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
export function hasDetailedEdge(fixture: ConsumerAgreementFixture, fromId: string, toId: string, label: string): boolean {
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
      /** Detailed-graph edges this site's resolution must (or must not) produce. */
      edges?: readonly ConsumerAgreementEdge[];
    }
  | {
      /** This site must stay unresolved (no declaration proves it). */
      expected: "not_found";
      /**
       * A same-named declaration elsewhere in the fixture. Its own `findReferences` coverage
       * must not report `state: "complete"` while this site's file holds an unresolved
       * candidate use of the same name (F3).
       */
      sameNameDeclaration?: { file: string; line: number; token: string };
    }
);

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

  if (site.expected === "not_found") {
    expect(goto.status, `goToDefinition(${label})`).toBe("not_found");
    if (site.sameNameDeclaration) {
      const declFile = requirePath(fixture, site.sameNameDeclaration.file);
      const declSource = fixture.sources[site.sameNameDeclaration.file];
      if (declSource === undefined) throw new Error(`fixture has no file "${site.sameNameDeclaration.file}"`);
      const declColumn = columnOfOccurrence(
        declSource,
        site.sameNameDeclaration.line,
        site.sameNameDeclaration.token,
        1,
      );
      const refs = await findReferences(fixture.index, {
        file: declFile,
        line: site.sameNameDeclaration.line,
        column: declColumn,
      });
      const declLabel = `${site.sameNameDeclaration.file}:${site.sameNameDeclaration.line}`;
      const claimsComplete = refs.status === "ok" && refs.referenceCoverage.state === "complete";
      expect(
        claimsComplete,
        `findReferences(${declLabel}) reports coverage "complete" while ${label} is an unresolved ` +
          `same-name candidate use`,
      ).toBe(false);
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
      const siteKey = `${file}:${site.line}`;
      const included = refs.references.some(
        (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}` === siteKey,
      );
      expect(
        included,
        `findReferences(${site.expected.file}:${site.expected.line}) must include ${label}`,
      ).toBe(true);
    }
  }

  for (const edgeSpec of site.edges ?? []) {
    const fromNode = findDetailedNode(fixture, edgeSpec.from.file, edgeSpec.from.name);
    const to = edgeSpec.to ?? { file: site.expected.file, name: goto.definition.localName };
    const toNode = findDetailedNode(fixture, to.file, to.name);
    const present = hasDetailedEdge(fixture, fromNode.id, toNode.id, edgeSpec.label);
    const description =
      `detailed-graph "${edgeSpec.label}" edge ${edgeSpec.from.name} (${edgeSpec.from.file}) -> ` +
      `${to.name} (${to.file}), from site ${label}`;
    expect(present, edgeSpec.absent ? `expected NO ${description}` : `expected ${description}`).toBe(
      !edgeSpec.absent,
    );
  }
}

/** Asserts every site in order against one fixture. */
export async function assertConsumerAgreementSites(
  fixture: ConsumerAgreementFixture,
  sites: readonly ConsumerAgreementSite[],
): Promise<void> {
  for (const site of sites) await assertConsumerAgreement(fixture, site);
}
