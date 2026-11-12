import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import { defNodeId } from "../../src/graphs/symbol-graph.js";
import { buildProjectIndex } from "../../src/indexer/build-index.js";
import { closeDiskCacheDatabase } from "../../src/indexer/build-cache.js";
import { findReferences, goToDefinition } from "../../src/indexer/navigation.js";
import type { ProjectIndex } from "../../src/indexer/types.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { writeFixtureFiles } from "../languages/callable-consumer-fixtures.js";
import { mkTmpDir } from "./filesystem.js";
import { positionOf, type Site } from "./qualified-base-fixture.js";

export const PHP_TRAIT_COMPOSITION_FILES = {
  "a.php": [
    "<?php",
    "trait A {",
    "  public function shared() { return 'A'; }",
    "  public function only() { return 'onlyA'; }",
    "  protected function hidden() { return 'hiddenA'; }",
    "}",
  ].join("\n"),
  "b.php": "<?php\ntrait B { public function other() { return 'B'; } }\n",
  "conflict.php":
    "<?php\ntrait Conflict { public function shared() { return 'B'; } public function survivor() { return 'B'; } }\n",
  "all.php": [
    "<?php",
    "trait AllA {",
    "  public function shared() { return 'A'; }",
    "  public function other() { return 'A'; }",
    "  public function only() { return 'A'; }",
    "}",
  ].join("\n"),
  "requirement.php": [
    "<?php",
    "trait Requirement {",
    "  abstract public function request();",
    "  abstract public static function make();",
    "  public function fetch() { return $this->REQUEST(); }",
    "  public function fetchStatic() {",
    "    static::make();",
    "    return self::MAKE();",
    "  }",
    "}",
  ].join("\n"),
  "base.php": [
    "<?php",
    "class Base {",
    "  public function shared() { return 'base'; }",
    "  public function only() { return 'base'; }",
    "  public function other() { return 'base'; }",
    "  public function alt() { return 'base'; }",
    "  protected function otherAlias() { return 'base'; }",
    "  protected function hidden() { return 'base'; }",
    "  public function request() { return 'base'; }",
    "  public static function make() { return 'base'; }",
    "  public function survivor() { return 'base'; }",
    "}",
  ].join("\n"),
  "records.php": [
    "<?php",
    "class MixedRecord extends Base {",
    "  use A, B { B::other as protected otherAlias; }",
    "  public function mixed() {",
    "    $this->shared(); // mixed",
    "    $this->only(); // mixed",
    "    $this->other(); // mixed",
    "    $this->otherAlias(); // mixed",
    "  }",
    "}",
    "class VisibilityRecord extends Base {",
    "  use A { hidden as public; }",
    "  public function visibility() {",
    "    $this->shared(); // visibility",
    "    $this->hidden(); // visibility",
    "  }",
    "}",
    "class Record extends Base {",
    "  use A, Conflict { A::shared insteadof Conflict; Conflict::shared as alt; }",
    "}",
    "class Child extends Record {",
    "  public function child() {",
    "    $this->shared(); // child",
    "    $this->alt(); // child",
    "    parent::shared(); // child",
    "    $this->only(); // child",
    "    parent::only(); // child",
    "    $this->survivor(); // child",
    "    parent::survivor(); // child",
    "  }",
    "}",
    "class Own extends Record {",
    "  public function shared() { return 'own'; }",
    "  public function only() { return 'own'; }",
    "  public function own() {",
    "    $this->shared(); // own",
    "    $this->only(); // own",
    "  }",
    "}",
    "class OwnAdapted extends Base {",
    "  use A, Conflict { A::shared insteadof Conflict; Conflict::shared as alt; }",
    "  public function shared() { return 'own-adapted'; }",
    "  public function ownAdapted() { return $this->shared(); }",
    "}",
    "class Unrelated extends Base {",
    "  use AllA { AllA::shared as alt; }",
    "  public function unrelated() {",
    "    $this->other(); // unrelated",
    "    $this->only(); // unrelated",
    "    $this->alt(); // unrelated",
    "    $this->shared(); // unrelated",
    "  }",
    "}",
    "class Inherited extends Base {",
    "  use Requirement;",
    "  public function inherited() {",
    "    $this->REQUEST(); // inherited",
    "    self::MAKE(); // inherited",
    "  }",
    "}",
  ].join("\n"),
};

const declaration = (file: string, name: string): Site => ({ file, marker: `function ${name}`, offset: 9 });
const recordCall = (marker: string, offset = 7): Site => ({ file: "records.php", marker, offset });
type TraitCall = { site: Site; target: Site | null };

export const PHP_TRAIT_COMPOSITION_CALLS: readonly TraitCall[] = [
  { site: recordCall("$this->shared(); // mixed"), target: declaration("a.php", "shared") },
  { site: recordCall("$this->only(); // mixed"), target: declaration("a.php", "only") },
  { site: recordCall("$this->other(); // mixed"), target: declaration("b.php", "other") },
  { site: recordCall("$this->otherAlias(); // mixed"), target: null },
  { site: recordCall("$this->shared(); // visibility"), target: declaration("a.php", "shared") },
  { site: recordCall("$this->hidden(); // visibility"), target: declaration("a.php", "hidden") },
  { site: recordCall("$this->shared(); // child"), target: null },
  { site: recordCall("$this->alt(); // child"), target: null },
  { site: recordCall("parent::shared(); // child", 8), target: null },
  { site: recordCall("$this->only(); // child"), target: declaration("a.php", "only") },
  { site: recordCall("parent::only(); // child", 8), target: declaration("a.php", "only") },
  { site: recordCall("$this->survivor(); // child"), target: declaration("conflict.php", "survivor") },
  { site: recordCall("parent::survivor(); // child", 8), target: declaration("conflict.php", "survivor") },
  { site: recordCall("$this->shared(); // own"), target: declaration("records.php", "shared") },
  { site: recordCall("$this->only(); // own"), target: declaration("records.php", "only") },
  {
    site: recordCall("$this->shared(); }"),
    target: { ...declaration("records.php", "shared"), occurrence: 1 },
  },
  { site: recordCall("$this->other(); // unrelated"), target: declaration("all.php", "other") },
  { site: recordCall("$this->only(); // unrelated"), target: declaration("all.php", "only") },
  { site: recordCall("$this->alt(); // unrelated"), target: null },
  { site: recordCall("$this->shared(); // unrelated"), target: declaration("all.php", "shared") },
  {
    site: { file: "requirement.php", marker: "$this->REQUEST()", offset: 7 },
    target: declaration("requirement.php", "request"),
  },
  {
    site: { file: "requirement.php", marker: "static::make()", offset: 8 },
    target: declaration("requirement.php", "make"),
  },
  {
    site: { file: "requirement.php", marker: "self::MAKE()", offset: 6 },
    target: declaration("requirement.php", "make"),
  },
  { site: recordCall("$this->REQUEST(); // inherited"), target: declaration("base.php", "request") },
  { site: recordCall("self::MAKE(); // inherited", 6), target: declaration("base.php", "make") },
];

function siteKey(site: Site): string {
  const position = positionOf(PHP_TRAIT_COMPOSITION_FILES, site);
  return `${site.file}:${position.line}:${position.column}`;
}

export async function withPhpTraitComposition(
  consume: (index: ProjectIndex, files: Record<string, string>, root: string) => Promise<void>,
): Promise<void> {
  const temporary = await mkTmpDir("cg-php-trait-composition-");
  const root = path.join(temporary, "project");
  const diskOptions = { cache: "disk", cacheDir: path.join(temporary, "cache") } as const;
  try {
    const files = await writeFixtureFiles(root, PHP_TRAIT_COMPOSITION_FILES);
    for (const cache of ["off", "disk", "disk"] as const) {
      if (cache === "disk") closeDiskCacheDatabase(root, diskOptions);
      const index = await buildProjectIndex(root, { ...diskOptions, cache, threads: 1 });
      for (const file of Object.values(files))
        expect(index.byFile.get(fileIdentityKey(file))?.nativeOutcome).toBe("used");
      await consume(index, files, root);
    }
  } finally {
    closeDiskCacheDatabase(root, diskOptions);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function expectPhpTraitCompositionGoto(index: ProjectIndex, files: Record<string, string>): Promise<void> {
  for (const { site, target } of PHP_TRAIT_COMPOSITION_CALLS) {
    const result = await goToDefinition(index, {
      file: files[site.file]!,
      ...positionOf(PHP_TRAIT_COMPOSITION_FILES, site),
    });
    expect(result.status, siteKey(site)).toBe(target ? "ok" : "not_found");
    if (!target || result.status !== "ok") continue;
    expect(fileIdentityKey(result.definition.file), siteKey(site)).toBe(fileIdentityKey(files[target.file]!));
    expect(result.definition.range.start, siteKey(site)).toMatchObject(positionOf(PHP_TRAIT_COMPOSITION_FILES, target));
  }
}

export async function expectPhpTraitCompositionReferences(
  index: ProjectIndex,
  files: Record<string, string>,
  root: string,
): Promise<void> {
  const declarations = new Map<string, Site>();
  for (const { target } of PHP_TRAIT_COMPOSITION_CALLS) if (target) declarations.set(siteKey(target), target);
  for (const name of ["shared", "only", "other", "alt", "otherAlias", "hidden", "survivor"]) {
    const target = declaration("base.php", name);
    declarations.set(siteKey(target), target);
  }
  const callSites = new Set(PHP_TRAIT_COMPOSITION_CALLS.map(({ site }) => siteKey(site)));
  const uncertainDecoys = new Set(
    ["shared", "alt", "otherAlias"].map((name) => siteKey(declaration("base.php", name))),
  );
  for (const [key, target] of declarations) {
    const references = await findReferences(index, {
      file: files[target.file]!,
      ...positionOf(PHP_TRAIT_COMPOSITION_FILES, target),
    });
    expect(references.status, key).toBe("ok");
    if (references.status !== "ok") throw new Error(`Expected PHP trait references for ${key}`);
    const calls = references.references
      .map((reference) => {
        const relative = path.relative(root, reference.file).replace(/\\/g, "/");
        const start = reference.range.start;
        return `${relative}:${start.line}:${start.column}`;
      })
      .filter((site) => callSites.has(site))
      .sort();
    const expected = PHP_TRAIT_COMPOSITION_CALLS.filter((call) => call.target && siteKey(call.target) === key)
      .map(({ site }) => siteKey(site))
      .sort();
    expect(calls, key).toEqual(expected);
    if (uncertainDecoys.has(key)) {
      expect(references.referenceCoverage.state, key).toBe("partial");
    }
    if (target.file === "requirement.php") expect(references.referenceCoverage.state, key).toBe("complete");
  }
}

export async function expectPhpTraitCompositionGraph(
  index: ProjectIndex,
  files: Record<string, string>,
): Promise<void> {
  const graph = await buildSymbolGraphDetailed(index);
  for (const { site, target } of PHP_TRAIT_COMPOSITION_CALLS) {
    const position = positionOf(PHP_TRAIT_COMPOSITION_FILES, site);
    const calls = graph.edges.filter((edge) => {
      if (edge.label !== "calls" || !edge.site) return false;
      if (fileIdentityKey(edge.site.file) !== fileIdentityKey(files[site.file]!)) return false;
      return edge.site.range.start.line === position.line && edge.site.range.start.column === position.column;
    });
    expect(calls.length, siteKey(site)).toBe(target ? 1 : 0);
    if (!target) continue;
    const expected = positionOf(PHP_TRAIT_COMPOSITION_FILES, target);
    const definition = index.byFile
      .get(fileIdentityKey(files[target.file]!))!
      .locals.find((local) => local.range.start.line === expected.line && local.range.start.column === expected.column);
    expect(definition, siteKey(target)).toBeDefined();
    expect(calls[0]!.to, siteKey(site)).toBe(defNodeId(definition!));
  }
  const traits = graph.edges
    .filter((edge) => edge.label === "trait")
    .map((edge) => `${graph.nodes.get(edge.from)?.name}->${graph.nodes.get(edge.to)?.name}`)
    .sort();
  expect(traits).toEqual([
    "Inherited->Requirement",
    "MixedRecord->A",
    "MixedRecord->B",
    "OwnAdapted->A",
    "OwnAdapted->Conflict",
    "Record->A",
    "Record->Conflict",
    "Unrelated->AllA",
    "VisibilityRecord->A",
  ]);
}
