import path from "node:path";
import { expect } from "vitest";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import { defNodeId } from "../../src/graphs/symbol-graph.js";
import { findReferences, goToDefinition } from "../../src/indexer/navigation.js";
import { UNINDEXED_PHP_TRAIT_REASON } from "../../src/indexer/ambiguous-resolution.js";
import type { ProjectIndex, ReferenceCoverageReason } from "../../src/indexer/types.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { withPhpFiles } from "./php-project-fixture.js";
import { positionOf, type Site } from "./qualified-base-fixture.js";

/** A project, the call sites it holds with the declaration each must reach, and the inherited decoys. */
export type PhpNestedTraitProject = {
  files: Readonly<Record<string, string>>;
  /** A `null` target is unresolved; `reason` is the one go-to-definition must give for it. */
  calls: readonly { site: Site; target: Site | null; reason?: string }[];
  /** Declarations a trait member shadows or an unproven trait may shadow, with their coverage state. */
  decoys: readonly { site: Site; coverage: "complete" | "partial"; reasons?: readonly ReferenceCoverageReason[] }[];
  /** The coverage every reached declaration reports; unset where unproven sites may leave it either way. */
  targetCoverage?: "complete";
};

const declaration = (file: string, name: string, occurrence = 0): Site => ({
  file,
  marker: `function ${name}`,
  occurrence,
  offset: 9,
});
const call = (marker: string, offset = 7): Site => ({ file: "records.php", marker, offset });

/**
 * Methods reached through nested traits beside inherited methods of the same name. The PHP 8.3 interpreter selects the
 * trait member at every site below (`Inner::foo`, `DeepC::deep`, `Own::foo`, `Common::dia`, `PInner::gm`, ...): a
 * class's own method, then the methods of its traits and of the traits those use, then inherited methods.
 */
export const PHP_NESTED_TRAIT_PROJECT: PhpNestedTraitProject = {
  files: {
    "traits.php": [
      "<?php",
      "trait Inner {",
      "  public function foo() { return 'inner'; }",
      "  public function only() { return 'inner'; }",
      "  public static function make() { return 'inner'; }",
      "}",
      "trait Outer { use Inner; }",
      "trait Own {",
      "  use Inner;",
      "  public function foo() { return 'own'; }",
      "}",
      "trait DeepC {",
      "  public function deep() { return 'deepc'; }",
      "}",
      "trait DeepB { use DeepC; }",
      "trait DeepA { use DeepB; }",
      "trait Common {",
      "  public function dia() { return 'common'; }",
      "}",
      "trait DiaA { use Common; }",
      "trait DiaB { use Common; }",
      "trait PInner {",
      "  public function gm() { return 'pinner'; }",
      "}",
      "trait POuter { use PInner; }",
      "trait Req { abstract public function req(); }",
      "trait OuterReq { use Req; }",
    ].join("\n"),
    "base.php": [
      "<?php",
      "class Base {",
      "  public function foo() { return 'base'; }",
      "  public function only() { return 'base'; }",
      "  public function baseOnly() { return 'base'; }",
      "  public static function make() { return 'base'; }",
      "  public function deep() { return 'base'; }",
      "  public function dia() { return 'base'; }",
      "}",
      "class Grand {",
      "  public function gm() { return 'grand'; }",
      "}",
      "class Parent1 extends Grand { use POuter; }",
      "class BaseReq {",
      "  public function req() { return 'base'; }",
      "}",
    ].join("\n"),
    "records.php": [
      "<?php",
      "class Direct extends Base {",
      "  use Outer;",
      "  public function run() {",
      "    $this->foo(); // direct foo",
      "    $this->only(); // direct only",
      "    $this->baseOnly(); // direct baseOnly",
      "    self::make(); // direct self",
      "    static::make(); // direct static",
      "    Direct::make(); // direct named",
      "  }",
      "}",
      "class Deep extends Base {",
      "  use DeepA;",
      "  public function run() {",
      "    $this->deep(); // deep",
      "  }",
      "}",
      "class OwnFirst extends Base {",
      "  use Own;",
      "  public function run() {",
      "    $this->foo(); // own foo",
      "    $this->only(); // own only",
      "  }",
      "}",
      "class ClassWins extends Base {",
      "  use Outer;",
      "  public function foo() { return 'class'; }",
      "  public function run() {",
      "    $this->foo(); // class foo",
      "  }",
      "}",
      "class Inherits extends Parent1 {",
      "  public function run() {",
      "    $this->gm(); // inherits",
      "  }",
      "}",
      "class Overrides extends Parent1 {",
      "  public function gm() { return 'overrides'; }",
      "  public function run() {",
      "    parent::gm(); // overrides parent",
      "    $this->gm(); // overrides this",
      "  }",
      "}",
      "class Diamond extends Base {",
      "  use DiaA, DiaB;",
      "  public function run() {",
      "    $this->dia(); // diamond",
      "  }",
      "}",
      "class AbstractUser extends BaseReq {",
      "  use OuterReq;",
      "  public function run() {",
      "    $this->req(); // abstract nested",
      "  }",
      "}",
      "class UsesAndParent extends Base {",
      "  use Outer;",
      "  public function run() {",
      "    parent::foo(); // parent of trait user",
      "  }",
      "}",
      "class SubOfUser extends UsesAndParent {",
      "  public function run() {",
      "    parent::foo(); // parent composes nested",
      "  }",
      "}",
      "trait Caller {",
      "  use Inner;",
      "  public function go() {",
      "    $this->foo(); // trait body",
      "  }",
      "}",
      "enum Tag {",
      "  use Outer;",
      "  case One;",
      "  public function run() {",
      "    $this->foo(); // enum",
      "  }",
      "}",
      "$anonymous = new class extends Base {",
      "  use Outer;",
      "  public function go() {",
      "    $this->foo(); // anonymous",
      "  }",
      "};",
      "function viaParameter(UsesAndParent $user) {",
      "  $user->foo(); // typed parameter",
      "}",
      "function viaLocal() {",
      "  $record = new Direct();",
      "  $record->foo(); // local foo",
      "}",
    ].join("\n"),
  },
  calls: [
    { site: call("$this->foo(); // direct foo"), target: declaration("traits.php", "foo") },
    { site: call("$this->only(); // direct only"), target: declaration("traits.php", "only") },
    { site: call("$this->baseOnly(); // direct baseOnly"), target: declaration("base.php", "baseOnly") },
    { site: call("self::make(); // direct self", 6), target: declaration("traits.php", "make") },
    { site: call("static::make(); // direct static", 8), target: declaration("traits.php", "make") },
    { site: call("Direct::make(); // direct named", 8), target: declaration("traits.php", "make") },
    { site: call("$this->deep(); // deep"), target: declaration("traits.php", "deep") },
    { site: call("$this->foo(); // own foo"), target: declaration("traits.php", "foo", 1) },
    { site: call("$this->only(); // own only"), target: declaration("traits.php", "only") },
    { site: call("$this->foo(); // class foo"), target: declaration("records.php", "foo") },
    { site: call("$this->gm(); // inherits"), target: declaration("traits.php", "gm") },
    { site: call("parent::gm(); // overrides parent", 8), target: declaration("traits.php", "gm") },
    { site: call("$this->gm(); // overrides this"), target: declaration("records.php", "gm") },
    { site: call("$this->dia(); // diamond"), target: declaration("traits.php", "dia") },
    { site: call("$record->foo(); // local foo", 9), target: declaration("traits.php", "foo") },
    { site: call("$this->req(); // abstract nested"), target: declaration("base.php", "req") },
    // `parent::` starts above the class: its own traits do not answer, those of its parent do.
    { site: call("parent::foo(); // parent of trait user", 8), target: declaration("base.php", "foo") },
    { site: call("parent::foo(); // parent composes nested", 8), target: declaration("traits.php", "foo") },
    { site: call("$this->foo(); // trait body"), target: declaration("traits.php", "foo") },
    { site: call("$this->foo(); // enum"), target: declaration("traits.php", "foo") },
    { site: call("$this->foo(); // anonymous"), target: declaration("traits.php", "foo") },
    { site: call("$user->foo(); // typed parameter", 7), target: declaration("traits.php", "foo") },
  ],
  decoys: [
    { site: declaration("base.php", "foo"), coverage: "complete" },
    { site: declaration("base.php", "only"), coverage: "complete" },
    { site: declaration("base.php", "make"), coverage: "complete" },
    { site: declaration("base.php", "deep"), coverage: "complete" },
    { site: declaration("base.php", "dia"), coverage: "complete" },
    { site: declaration("base.php", "gm"), coverage: "complete" },
  ],
  targetCoverage: "complete",
};

/**
 * `MissingTrait` stands for a trait outside the index (a vendor trait), which the interpreter would load and which may
 * declare any of these names. A lookup that finds nothing in the traits the index does hold cannot prove the inherited
 * method is the one reached, so it stays unresolved with partial coverage. A member found in an indexed trait or in the
 * class itself is unaffected: PHP rejects a collision between two composed traits, and a class's own method wins.
 */
export const PHP_UNPROVEN_TRAIT_PROJECT: PhpNestedTraitProject = {
  files: {
    "traits.php": [
      "<?php",
      "trait Inner {",
      "  public function foo() { return 'inner'; }",
      "}",
      "trait Outer { use Inner; }",
      "trait Half { use MissingTrait; }",
    ].join("\n"),
    "base.php": [
      "<?php",
      "class Base {",
      "  public function foo() { return 'base'; }",
      "  public function baseOnly() { return 'base'; }",
      "}",
      "class ParentWithMissing extends Base { use MissingTrait; }",
    ].join("\n"),
    "records.php": [
      "<?php",
      "class Direct extends Base {",
      "  use MissingTrait;",
      "  public function run() {",
      "    $this->foo(); // direct foo",
      "    $this->baseOnly(); // direct baseOnly",
      "  }",
      "}",
      "class Nested extends Base {",
      "  use Half;",
      "  public function run() {",
      "    $this->foo(); // nested foo",
      "  }",
      "}",
      "class KnownBeatsMissing extends Base {",
      "  use Outer, MissingTrait;",
      "  public function run() {",
      "    $this->foo(); // known foo",
      "  }",
      "}",
      "class OwnBeatsMissing extends Base {",
      "  use MissingTrait;",
      "  public function foo() { return 'own'; }",
      "  public function run() {",
      "    $this->foo(); // own foo",
      "  }",
      "}",
      "class ParentCallWithMissing extends Base {",
      "  use MissingTrait;",
      "  public function run() {",
      "    parent::foo(); // parent of unproven user",
      "  }",
      "}",
      "class ParentCallBoth extends Base {",
      "  use Outer, MissingTrait;",
      "  public function run() {",
      "    parent::foo(); // parent of known and unproven user",
      "  }",
      "}",
      "class ChildOfMissing extends ParentWithMissing {",
      "  public function run() {",
      "    $this->foo(); // child foo",
      "    parent::foo(); // child parent",
      "  }",
      "}",
    ].join("\n"),
  },
  calls: [
    { site: call("$this->foo(); // direct foo"), target: null, reason: UNINDEXED_PHP_TRAIT_REASON },
    { site: call("$this->baseOnly(); // direct baseOnly"), target: null, reason: UNINDEXED_PHP_TRAIT_REASON },
    { site: call("$this->foo(); // nested foo"), target: null, reason: UNINDEXED_PHP_TRAIT_REASON },
    { site: call("$this->foo(); // known foo"), target: declaration("traits.php", "foo") },
    { site: call("$this->foo(); // own foo"), target: declaration("records.php", "foo") },
    // The parent's own traits are not consulted, so its unindexed trait is no reason to doubt the base method.
    { site: call("parent::foo(); // parent of unproven user", 8), target: declaration("base.php", "foo") },
    { site: call("parent::foo(); // parent of known and unproven user", 8), target: declaration("base.php", "foo") },
    { site: call("$this->foo(); // child foo"), target: null, reason: UNINDEXED_PHP_TRAIT_REASON },
    { site: call("parent::foo(); // child parent", 8), target: null, reason: UNINDEXED_PHP_TRAIT_REASON },
  ],
  decoys: [
    { site: declaration("base.php", "foo"), coverage: "partial", reasons: ["unindexed_trait"] },
    { site: declaration("base.php", "baseOnly"), coverage: "partial", reasons: ["unindexed_trait"] },
  ],
};

function siteKey(project: PhpNestedTraitProject, site: Site): string {
  const position = positionOf(project.files, site);
  return `${site.file}:${position.line}:${position.column}`;
}

/** Runs `consume` on a cold build, a first disk build, and a reopened disk build of the project. */
export async function withPhpNestedTraitProject(
  project: PhpNestedTraitProject,
  consume: (index: ProjectIndex, files: Record<string, string>, root: string) => Promise<void>,
): Promise<void> {
  await withPhpFiles(project.files, consume);
}

export async function expectPhpNestedTraitGoto(
  project: PhpNestedTraitProject,
  index: ProjectIndex,
  files: Record<string, string>,
): Promise<void> {
  for (const { site, target, reason } of project.calls) {
    const result = await goToDefinition(index, { file: files[site.file]!, ...positionOf(project.files, site) });
    const label = siteKey(project, site);
    expect(result.status, label).toBe(target ? "ok" : "not_found");
    if (reason !== undefined) expect(result.status === "not_found" ? result.reason : "", label).toBe(reason);
    if (!target || result.status !== "ok") continue;
    expect(fileIdentityKey(result.definition.file), label).toBe(fileIdentityKey(files[target.file]!));
    expect(result.definition.range.start, label).toMatchObject(positionOf(project.files, target));
  }
}

export async function expectPhpNestedTraitReferences(
  project: PhpNestedTraitProject,
  index: ProjectIndex,
  files: Record<string, string>,
  root: string,
): Promise<void> {
  const targets = new Map<
    string,
    { site: Site; coverage: "complete" | "partial" | undefined; reasons?: readonly ReferenceCoverageReason[] }
  >();
  for (const { target } of project.calls) {
    if (target) targets.set(siteKey(project, target), { site: target, coverage: project.targetCoverage });
  }
  for (const decoy of project.decoys) targets.set(siteKey(project, decoy.site), decoy);
  const callSites = new Set(project.calls.map(({ site }) => siteKey(project, site)));
  for (const [key, { site, coverage, reasons }] of targets) {
    const references = await findReferences(index, { file: files[site.file]!, ...positionOf(project.files, site) });
    expect(references.status, key).toBe("ok");
    if (references.status !== "ok") throw new Error(`Expected PHP nested trait references for ${key}`);
    const found = references.references
      .map((reference) => {
        const relative = path.relative(root, reference.file).replace(/\\/g, "/");
        return `${relative}:${reference.range.start.line}:${reference.range.start.column}`;
      })
      .filter((reference) => callSites.has(reference))
      .sort();
    const expected = project.calls
      .filter((entry) => entry.target && siteKey(project, entry.target) === key)
      .map(({ site: callSite }) => siteKey(project, callSite))
      .sort();
    expect(found, key).toEqual(expected);
    if (coverage) expect(references.referenceCoverage.state, key).toBe(coverage);
    // The specific cause is reported, not the generic `strategy_unavailable`.
    if (reasons) expect(references.referenceCoverage.reasons, key).toEqual(reasons);
  }
}

export async function expectPhpNestedTraitGraph(
  project: PhpNestedTraitProject,
  index: ProjectIndex,
  files: Record<string, string>,
): Promise<void> {
  const graph = await buildSymbolGraphDetailed(index);
  for (const { site, target } of project.calls) {
    const position = positionOf(project.files, site);
    const label = siteKey(project, site);
    const calls = graph.edges.filter(
      (edge) =>
        edge.label === "calls" &&
        edge.site !== undefined &&
        fileIdentityKey(edge.site.file) === fileIdentityKey(files[site.file]!) &&
        edge.site.range.start.line === position.line &&
        edge.site.range.start.column === position.column,
    );
    expect(calls.length, label).toBe(target ? 1 : 0);
    if (!target) continue;
    const expected = positionOf(project.files, target);
    const definition = index.byFile
      .get(fileIdentityKey(files[target.file]!))!
      .locals.find((local) => local.range.start.line === expected.line && local.range.start.column === expected.column);
    expect(definition, siteKey(project, target)).toBeDefined();
    expect(calls[0]!.to, label).toBe(defNodeId(definition!));
  }
}
