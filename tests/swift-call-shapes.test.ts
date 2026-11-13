import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
} from "../src/index.js";
import type { ProjectIndex } from "../src/index.js";
import { clearMemoryCache } from "../src/indexer/build-cache.js";
import { defNodeId, type SymbolGraph } from "../src/graphs/symbol-graph.js";
import { writeFixtureFiles } from "./languages/callable-consumer-fixtures.js";
import { previewRenameWithSession } from "../src/agent/rename-preview.js";
import { createAgentSession } from "../src/agent/session.js";

type Fixture = { paths: Record<string, string>; rows: Record<string, readonly string[]> };
type Site = { file: string; line: number; column: number };

/** The 1-based site of the `occurrence`-th `token` on a 1-based `line` of `file`. */
function siteOf(fixture: Fixture, file: string, line: number, token: string, occurrence = 0): Site {
  const row = fixture.rows[file]?.[line - 1];
  if (row === undefined) throw new Error(`Missing ${file}:${line}`);
  let at = -1;
  for (let count = 0; count <= occurrence; count += 1) at = row.indexOf(token, at + 1);
  if (at < 0) throw new Error(`Missing ${token} #${occurrence} on ${file}:${line}: ${row}`);
  return { file: fixture.paths[file]!, line, column: at + 1 };
}

async function withFixture(
  prefix: string,
  rows: Record<string, readonly string[]>,
  run: (fixture: Fixture, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    const paths = await writeFixtureFiles(
      root,
      Object.fromEntries(Object.entries(rows).map(([file, lines]) => [file, `${lines.join("\n")}\n`])),
    );
    await run({ paths, rows }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Index the project twice, the second time from the reopened disk cache. */
async function eachIndexPass(root: string, run: (index: ProjectIndex) => Promise<void>): Promise<void> {
  for (let pass = 0; pass < 2; pass += 1) {
    clearMemoryCache();
    await run(await buildProjectIndex(root, { cache: "disk", threads: 1 }));
  }
}

async function expectGoto(index: ProjectIndex, use: Site, declaration: Site): Promise<void> {
  const result = await goToDefinition(index, use);
  expect(result.status, `${use.file}:${use.line}:${use.column}`).toBe("ok");
  if (result.status !== "ok") return;
  expect([result.definition.file, result.definition.range.start.line, result.definition.range.start.column]).toEqual([
    declaration.file,
    declaration.line,
    declaration.column,
  ]);
}

async function expectUnresolved(index: ProjectIndex, use: Site): Promise<void> {
  const result = await goToDefinition(index, use);
  expect(result.status, `${use.file}:${use.line}:${use.column}`).toBe("not_found");
}

type ReferenceAnswer = { sites: string[]; state: string; reasons: readonly string[] };

/** Every reference of the declaration at `declaration` as `file:line` strings, with the coverage the answer claims. */
async function referenceAnswer(index: ProjectIndex, declaration: Site): Promise<ReferenceAnswer> {
  const refs = await findReferences(index, declaration);
  expect(refs.status).toBe("ok");
  if (refs.status !== "ok") return { sites: [], state: refs.status, reasons: [] };
  const sites = refs.references
    .map((ref) => ({ name: path.basename(ref.file), line: ref.range.start.line }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.line - b.line)
    .map((ref) => `${ref.name}:${ref.line}`);
  return { sites, state: refs.referenceCoverage.state, reasons: refs.referenceCoverage.reasons ?? [] };
}

/** Every reference of the declaration at `declaration`, as `file:line` strings in file and line order. */
async function referenceSites(index: ProjectIndex, declaration: Site): Promise<string[]> {
  return (await referenceAnswer(index, declaration)).sites;
}

/** The `label` targets of `source` must be exactly the declarations at `declarations`. */
async function expectEdges(
  index: ProjectIndex,
  graph: SymbolGraph,
  file: string,
  source: string,
  label: string,
  declarations: readonly Site[],
): Promise<void> {
  const from = [...graph.nodes.values()].find((node) => node.file === file && node.name === source);
  expect(from, source).toBeDefined();
  const expected = new Set<string>();
  for (const declaration of declarations) {
    const result = await goToDefinition(index, declaration);
    expect(result.status, `${declaration.file}:${declaration.line}`).toBe("ok");
    if (result.status === "ok") expected.add(defNodeId(result.definition));
  }
  const actual = new Set(graph.edges.filter((edge) => edge.from === from!.id && edge.label === label).map((e) => e.to));
  expect([...actual].sort(), `${source} ${label}`).toEqual([...expected].sort());
}

/** The `calls` targets of `caller` must be exactly the declarations at `declarations`. */
async function expectCalls(
  index: ProjectIndex,
  graph: SymbolGraph,
  file: string,
  caller: string,
  declarations: readonly Site[],
): Promise<void> {
  await expectEdges(index, graph, file, caller, "calls", declarations);
}

const SHAPES = [
  "struct Renderer {",
  "  func draw(to size: Int, inverting: Bool, scale: Int? = nil, refImage: String? = nil, draw: (Int) -> Bool) -> Int { 0 }",
  '  func render() -> Int { return draw(to: 1, inverting: true, refImage: "x") { _ in true } }',
  "}",
  "struct DecoyRenderer { func draw(to size: Int) -> Int { 1 } }",
  "func measure(_ name: String, path: String, insensitive: Bool = false, captures: Bool = false, routes: [String]) {}",
  'func measureAll() { measure("a", path: "b", routes: []) }',
  'func log(_ items: Int..., separator: String = " ") {}',
  "func log(prefix: String) {}",
  'func logAll() { log(); log(1); log(1, 2, 3, separator: "-") }',
  "func nested(_ run: () -> Void) {}",
  "func nestedUse() { nested { print(max(1, 2, 3)) } }",
  "struct Runner {",
  "  func run(_ block: () -> Void) {}",
  "  func helper(_ a: Int, _ b: Int, _ c: Int) {}",
  "  func execute() { run { helper(1, 2, 3) } }",
  "}",
  "func viaReceiver(_ runner: Runner) { runner.run { runner.helper(1, 2, 3) } }",
];

describe("Swift call shapes use the shared argument-count rules", () => {
  it("accepts defaults before required parameters, variadics, and trailing closures without counting closure bodies", async () => {
    await withFixture("cg-swift-call-shapes-", { "Shapes.swift": SHAPES }, async (fixture, root) => {
      const at = (line: number, token: string, occurrence = 0) =>
        siteOf(fixture, "Shapes.swift", line, token, occurrence);
      const cases = [
        // Labels and a trailing closure skip the defaulted `scale` before the required `draw`.
        [at(3, "draw"), at(2, "draw")],
        [at(7, "measure("), at(6, "measure")],
        // `...` accepts none, one, or many arguments; the other overload needs `prefix:`.
        [at(10, "log("), at(8, "log")],
        [at(10, "log(", 1), at(8, "log")],
        [at(10, "log(", 2), at(8, "log")],
        // The three arguments of `max` and `helper` belong to the closure body, not to `nested` or `run`.
        [at(12, "nested {"), at(11, "nested")],
        [at(16, "run"), at(14, "run")],
        [at(16, "helper"), at(15, "helper")],
        [at(18, "run {"), at(14, "run")],
        [at(18, "helper"), at(15, "helper")],
      ] as const;
      await eachIndexPass(root, async (index) => {
        for (const [use, declaration] of cases) await expectGoto(index, use, declaration);
        const refs = (line: number, token: string) => referenceSites(index, at(line, token));
        expect(await refs(2, "draw")).toEqual(["Shapes.swift:2", "Shapes.swift:3"]);
        expect(await refs(5, "draw")).toEqual(["Shapes.swift:5"]);
        expect(await refs(6, "measure")).toEqual(["Shapes.swift:6", "Shapes.swift:7"]);
        expect(await refs(8, "log")).toEqual([
          "Shapes.swift:8",
          "Shapes.swift:10",
          "Shapes.swift:10",
          "Shapes.swift:10",
        ]);
        expect(await refs(9, "log")).toEqual(["Shapes.swift:9"]);
        expect(await refs(11, "nested")).toEqual(["Shapes.swift:11", "Shapes.swift:12"]);
        expect(await refs(14, "run")).toEqual(["Shapes.swift:14", "Shapes.swift:16", "Shapes.swift:18"]);
        expect(await refs(15, "helper")).toEqual(["Shapes.swift:15", "Shapes.swift:16", "Shapes.swift:18"]);
        const graph = await buildSymbolGraphDetailed(index);
        const file = fixture.paths["Shapes.swift"]!;
        await expectCalls(index, graph, file, "render", [at(2, "draw")]);
        await expectCalls(index, graph, file, "measureAll", [at(6, "measure")]);
        await expectCalls(index, graph, file, "logAll", [at(8, "log")]);
        await expectCalls(index, graph, file, "nestedUse", [at(11, "nested")]);
        await expectCalls(index, graph, file, "execute", [at(14, "run"), at(15, "helper")]);
        await expectCalls(index, graph, file, "viaReceiver", [at(14, "run"), at(15, "helper")]);
      });
    });
  });

  it("rejects a mislabeled call only when overloads compete for it", async () => {
    const rows = [
      "func place(_ name: String, at point: Int = 0, scale: Int = 1) {}",
      'func placeAll() { place("a", at: 1); place("a", scale: 2); place("a", 3); place() }',
      "func tally(_ items: Int...) {}",
      "func tallyAll() { tally(1, 2, 3); tally(label: 1) }",
      "func pick(_ item: Int, at point: Int = 0) {}",
      "func pick(_ item: Int, scale: Int) {}",
      "func pickAll() { pick(1, at: 2); pick(1, 3); pick(1, other: 2) }",
    ];
    await withFixture("cg-swift-call-reject-", { "Reject.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string, occurrence = 0) =>
        siteOf(fixture, "Reject.swift", line, token, occurrence);
      await eachIndexPass(root, async (index) => {
        await expectGoto(index, at(2, "place("), at(1, "place"));
        await expectGoto(index, at(2, "place(", 1), at(1, "place"));
        // A lone function stays the target of a call whose labels or argument count do not fit it.
        await expectGoto(index, at(2, "place(", 2), at(1, "place"));
        await expectGoto(index, at(2, "place(", 3), at(1, "place"));
        await expectGoto(index, at(4, "tally("), at(3, "tally"));
        await expectGoto(index, at(4, "tally(", 1), at(3, "tally"));
        // Two overloads compete: the labels pick the one `at:` call and reject the calls that neither accepts.
        await expectGoto(index, at(7, "pick("), at(5, "pick"));
        await expectUnresolved(index, at(7, "pick(", 1));
        await expectUnresolved(index, at(7, "pick(", 2));
      });
    });
  });
});

describe("Swift calls that miscount their only candidate", () => {
  it("keeps a lone same-name function as the target, whatever its labels, and rejects competing overloads", async () => {
    const rows = [
      "func helper(_ a: String, b: Int) {}",
      'func run() { helper("x") }',
      "func two(_ a: Int) {}",
      "func twoAll() { two(1, 2) }",
      "func pair(_ a: Int) {}",
      "func pair(_ a: Int, _ b: Int, _ c: Int) {}",
      "func pairAll() { pair(1, 2) }",
      "func named(to value: Int) {}",
      'func namedAll() { named("x") }',
      "func tag(to value: Int) {}",
      "func tag(from value: Int) {}",
      'func tagAll() { tag("x") }',
    ];
    await withFixture("cg-swift-lone-miscount-", { "Lone.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string) => siteOf(fixture, "Lone.swift", line, token);
      await eachIndexPass(root, async (index) => {
        // Too few and too many arguments: the one `helper` and the one `two` remain the targets.
        await expectGoto(index, at(2, "helper"), at(1, "helper"));
        await expectGoto(index, at(4, "two("), at(3, "two"));
        // Neither `pair` accepts two arguments and both fit, so the call picks none.
        await expectUnresolved(index, at(7, "pair("));
        // An unlabeled argument where `to:` is required is a wrong label, yet the one `named` stays the target.
        await expectGoto(index, at(9, "named("), at(8, "named"));
        // Two overloads compete and neither takes an unlabeled argument, so the call picks none.
        await expectUnresolved(index, at(12, "tag("));
        const graph = await buildSymbolGraphDetailed(index);
        const file = fixture.paths["Lone.swift"]!;
        await expectCalls(index, graph, file, "run", [at(1, "helper")]);
        await expectCalls(index, graph, file, "twoAll", [at(3, "two")]);
        await expectCalls(index, graph, file, "pairAll", []);
        await expectCalls(index, graph, file, "namedAll", [at(8, "named")]);
        await expectCalls(index, graph, file, "tagAll", []);
      });
    });
  });
});

describe("Swift parameter lists the grammar could not parse", () => {
  const rows = [
    "func expect(_ value: Int, _ message: String, location: SourceLocation = #_sourceLocation) {}",
    'func useExpect() { expect(1, "m"); expect(1, "m", location: nil) }',
    "func twin(_ value: Int, loc: SourceLocation = #_sourceLocation) {}",
    "func twin(_ value: Int, extra: Int, loc: SourceLocation = #_sourceLocation) {}",
    "func useTwin() { twin(1); twin(1, extra: 2) }",
  ];

  it("gives such a callable no arity, so it is never rejected, and leaves overloads of it open", async () => {
    await withFixture("cg-swift-recovered-params-", { "Recovered.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string, occurrence = 0) =>
        siteOf(fixture, "Recovered.swift", line, token, occurrence);
      await eachIndexPass(root, async (index) => {
        const declared = [...index.byFile.values()]
          .flatMap((module) => module.locals)
          .filter((local) => local.kind === "function" && ["expect", "twin"].includes(local.localName));
        expect(declared).toHaveLength(3);
        for (const local of declared) {
          expect(local.callable?.arity, local.localName).toBeNull();
          expect(local.callable?.swiftParameters, local.localName).toBeUndefined();
        }
        // The one `expect` accepts both calls although its arity is unknown.
        await expectGoto(index, at(2, "expect("), at(1, "expect"));
        await expectGoto(index, at(2, "expect(", 1), at(1, "expect"));
        // Neither `twin` can be proven for a call, so no call picks one and the graph records no edge.
        await expectUnresolved(index, at(5, "twin("));
        await expectUnresolved(index, at(5, "twin(", 1));
        const graph = await buildSymbolGraphDetailed(index);
        await expectCalls(index, graph, fixture.paths["Recovered.swift"]!, "useTwin", []);
        await expectCalls(index, graph, fixture.paths["Recovered.swift"]!, "useExpect", [at(1, "expect")]);
      });
    });
  });
});

const SUBSCRIPTS = [
  "struct Store {",
  "  var items: [Int] = []",
  "  func items(at index: Int) -> Int { index }",
  "  func read() -> Int {",
  "    let first = self.items[0]",
  "    let second = items(at: 1)",
  "    let third = items[2]",
  "    return first + second + third",
  "  }",
  "}",
  "func outside(_ store: Store) -> Int {",
  "  let first = store.items[0]",
  "  let second = store.items(at: 1)",
  "  return first + second",
  "}",
];

describe("Swift subscripts and properties are not calls", () => {
  it("reads a subscripted property as a value and calls only the same-named method", async () => {
    await withFixture("cg-swift-subscript-", { "Store.swift": SUBSCRIPTS }, async (fixture, root) => {
      const at = (line: number, token: string) => siteOf(fixture, "Store.swift", line, token);
      const property = at(2, "items");
      const method = at(3, "items");
      await eachIndexPass(root, async (index) => {
        await expectGoto(index, at(5, "items"), property);
        await expectGoto(index, at(6, "items"), method);
        await expectGoto(index, at(7, "items"), property);
        await expectGoto(index, at(12, "items"), property);
        await expectGoto(index, at(13, "items"), method);
        expect(await referenceSites(index, property)).toEqual([
          "Store.swift:2",
          "Store.swift:5",
          "Store.swift:7",
          "Store.swift:12",
        ]);
        expect(await referenceSites(index, method)).toEqual(["Store.swift:3", "Store.swift:6", "Store.swift:13"]);
        // A subscript reads `items`; it never calls it, so only the method has call edges.
        const graph = await buildSymbolGraphDetailed(index);
        const file = fixture.paths["Store.swift"]!;
        await expectCalls(index, graph, file, "read", [method]);
        await expectCalls(index, graph, file, "outside", [method]);
      });
    });
  });
});

const MODE = [
  "enum Mode {",
  "  case fast",
  "  case slow",
  '  var label: String { switch self { case .fast: return "f"; case .slow: return "s" } }',
  "  init(flag: Bool) { self = flag ? .fast : .slow }",
  "  static func make() -> Self { .fast }",
  "  func maybe() -> Mode? { return .slow }",
  "  func other() -> Other { return .fast }",
  "}",
  "enum Other { case fast }",
];
const MODE_EXTRA = [
  "extension Mode {",
  "  func isFast() -> Bool { switch self { case .fast: return true; default: return false } }",
  "  func both(_ a: Mode, _ b: Mode) -> Bool { switch (a, b) { case (.fast, .slow): return true; default: return false } }",
  "}",
  "enum Answer { case value(Int); case failure }",
  "func handle(_ answer: Answer) -> Int { switch answer { case let .value(number): return number; case .failure: return 0 } }",
];

describe("Swift contextual enum cases keep the answers that Self, returns, and patterns prove", () => {
  it("resolves self switches, assignments, returns, optional returns, and tuple and binding patterns", async () => {
    await withFixture(
      "cg-swift-enum-forms-",
      { "Mode.swift": MODE, "ModeExtra.swift": MODE_EXTRA },
      async (fixture, root) => {
        const mode = (line: number, token: string) => siteOf(fixture, "Mode.swift", line, token);
        const extra = (line: number, token: string) => siteOf(fixture, "ModeExtra.swift", line, token);
        const fast = mode(2, "fast");
        const slow = mode(3, "slow");
        const otherFast = mode(10, "fast");
        await eachIndexPass(root, async (index) => {
          for (const use of [
            mode(4, "fast"), // `switch self` in the enum
            mode(5, "fast"), // `self = flag ? .fast : .slow`
            mode(6, "fast"), // single-expression `-> Self`
            extra(2, "fast"), // `switch self` in an extension in another file
            extra(3, "fast"), // `switch (a, b)` over parameters of type Mode
          ]) {
            await expectGoto(index, use, fast);
          }
          for (const use of [mode(4, "slow"), mode(5, "slow"), mode(7, "slow"), extra(3, "slow")]) {
            await expectGoto(index, use, slow);
          }
          await expectGoto(index, extra(6, "value"), extra(5, "value"));
          // `-> Other` selects the same-named case of the other enum, not `Mode.fast`.
          await expectGoto(index, mode(8, "fast"), otherFast);
          expect(await referenceSites(index, fast)).toEqual([
            "Mode.swift:2",
            "Mode.swift:4",
            "Mode.swift:5",
            "Mode.swift:6",
            "ModeExtra.swift:2",
            "ModeExtra.swift:3",
          ]);
          expect(await referenceSites(index, slow)).toEqual([
            "Mode.swift:3",
            "Mode.swift:4",
            "Mode.swift:5",
            "Mode.swift:7",
            "ModeExtra.swift:3",
          ]);
          expect(await referenceSites(index, otherFast)).toEqual(["Mode.swift:8", "Mode.swift:10"]);
        });
      },
    );
  });

  it("leaves a case unresolved when its context is not a project type or is Optional's own", async () => {
    const rows = [
      "enum Mode { case fast; case slow }",
      "struct Holder {",
      "  var outside: External { return .fast }",
      "  func nothing() -> Mode? { return .none }",
      "  func some() -> Mode? { return .some(.slow) }",
      "}",
    ];
    await withFixture("cg-swift-enum-unproven-", { "Unproven.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string, occurrence = 0) =>
        siteOf(fixture, "Unproven.swift", line, token, occurrence);
      await eachIndexPass(root, async (index) => {
        // `External` is not declared in the project, so `.fast` is one of its members.
        await expectUnresolved(index, at(3, "fast"));
        // `.none` and `.some` in a `Mode?` context are Optional's cases.
        await expectUnresolved(index, at(4, "none"));
        await expectUnresolved(index, at(5, "some", 1));
        expect(await referenceSites(index, at(1, "fast"))).toEqual(["Unproven.swift:1"]);
      });
    });
  });
});

describe("Swift member forms that main resolved", () => {
  it("lets a typealias hide an associatedtype and a property or static member answer its own use", async () => {
    const rows = [
      "protocol Container { associatedtype Item; func first() -> Item? }",
      "struct Box<T>: Container {",
      "  typealias Item = T",
      "  func first() -> Item? { nil }",
      "}",
      "extension Box where Item: Equatable { func same(_ other: Item) -> Bool { true } }",
      "protocol RoutesLike {}",
      "extension RoutesLike { func all(_ path: String) -> [Int] { [] } }",
      "struct Routes: RoutesLike {",
      "  var all: [Int] { [] }",
      "  var count: Int { self.all.count }",
      '  func run(_ routes: Routes) -> [Int] { routes.all("x") }',
      "}",
      "struct FileMeta {",
      "  let date: Int",
      "  let lastAccess: Int",
      "  static func lastAccess(lhs: FileMeta, rhs: FileMeta) -> Bool { true }",
      "}",
      "func ordered(_ metas: [FileMeta]) -> [FileMeta] { metas.sorted(by: FileMeta.lastAccess) }",
    ];
    await withFixture("cg-swift-member-forms-", { "Forms.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string, occurrence = 0) =>
        siteOf(fixture, "Forms.swift", line, token, occurrence);
      await eachIndexPass(root, async (index) => {
        // The concrete typealias, not the protocol's associatedtype, is the `Item` of `Box`.
        await expectGoto(index, at(6, "Item"), at(3, "Item"));
        // A plain read names the property; a call names the protocol extension's method.
        await expectGoto(index, at(11, "all"), at(10, "all"));
        await expectGoto(index, at(12, "all"), at(8, "all"));
        // An unapplied `Type.member` is the static function, never the instance property of that name.
        await expectGoto(index, at(19, "lastAccess"), at(17, "lastAccess"));
      });
    });
  });

  it("shows private members to extensions of nested types in the same file only", async () => {
    const rows = [
      "final class Retrier {",
      "  private static let queue = 1",
      "  struct State { var count = 0 }",
      "}",
      "extension Retrier.State { func peek() -> Int { Retrier.queue } }",
      "struct Stranger { func peek() -> Int { Retrier.queue } }",
    ];
    await withFixture("cg-swift-private-nested-", { "Retrier.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string) => siteOf(fixture, "Retrier.swift", line, token);
      await eachIndexPass(root, async (index) => {
        await expectGoto(index, at(5, "queue"), at(2, "queue"));
        await expectUnresolved(index, at(6, "queue"));
      });
    });
  });
});

describe("Swift receivers spelled like their member", () => {
  it("adds no call edge to the receiver variable but keeps proven function-valued properties", async () => {
    const rows = [
      "import Foundation",
      "final class Cache {",
      "  private let lock = NSLock()",
      "  var handler: (Int) -> Int = { $0 }",
      "  func removeExpired() {",
      "    lock.lock()",
      "    lock.unlock()",
      "  }",
      "  func run() -> Int { self.handler(1) }",
      "}",
      "struct Holder { var handler: (Int) -> Int }",
      "func viaHolder(_ holder: Holder) -> Int { holder.handler(2) }",
      "final class Session {",
      "  var retry: Int = 0",
      "  var delegate: AnyObject?",
      "  func go() {",
      "    retry.retry(1)",
      "    delegate?.delegate(on: 1)",
      "  }",
      "}",
    ];
    await withFixture("cg-swift-receiver-member-", { "Cache.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string, occurrence = 0) =>
        siteOf(fixture, "Cache.swift", line, token, occurrence);
      await eachIndexPass(root, async (index) => {
        // After the dot, `lock` and `unlock` are members of NSLock, which the project does not declare.
        await expectUnresolved(index, at(6, "lock", 1));
        await expectUnresolved(index, at(7, "unlock"));
        await expectUnresolved(index, at(17, "retry", 1));
        await expectUnresolved(index, at(18, "delegate", 1));
        await expectGoto(index, at(6, "lock"), at(3, "lock"));
        // The variable's own uses are exact, but the unproven member after the dot keeps the claim partial.
        const partial = ["strategy_unavailable"];
        expect(await referenceAnswer(index, at(3, "lock"))).toEqual({
          sites: ["Cache.swift:3", "Cache.swift:6", "Cache.swift:7"],
          state: "partial",
          reasons: partial,
        });
        expect(await referenceAnswer(index, at(14, "retry"))).toEqual({
          sites: ["Cache.swift:14", "Cache.swift:17"],
          state: "partial",
          reasons: partial,
        });
        expect(await referenceAnswer(index, at(15, "delegate"))).toEqual({
          sites: ["Cache.swift:15", "Cache.swift:18"],
          state: "partial",
          reasons: partial,
        });
        // A function-valued property is called through its receiver, so every use of it is proven.
        expect(await referenceAnswer(index, at(4, "handler"))).toEqual({
          sites: ["Cache.swift:4", "Cache.swift:9"],
          state: "complete",
          reasons: [],
        });
        expect(await referenceAnswer(index, at(11, "handler"))).toEqual({
          sites: ["Cache.swift:11", "Cache.swift:12"],
          state: "complete",
          reasons: [],
        });
        const graph = await buildSymbolGraphDetailed(index);
        const file = fixture.paths["Cache.swift"]!;
        await expectCalls(index, graph, file, "removeExpired", []);
        await expectCalls(index, graph, file, "run", [at(4, "handler")]);
        await expectCalls(index, graph, file, "viaHolder", [at(11, "handler")]);
        await expectCalls(index, graph, file, "go", []);
      });
    });
  });
});

describe("Swift trailing closures nested in a declaration initializer", () => {
  it("counts and labels the whole call when `let x = f(a: 1) { }` nests the call", async () => {
    const rows = [
      "struct Monitor { func observe(a: Int, cb: () -> Void) -> Int { 0 } }",
      "func use(_ monitor: Monitor) -> Int {",
      "  let token = monitor.observe(a: 1) { }",
      "  return token",
      "}",
      "func render(a: Int, cb: () -> Void) -> Int { 0 }",
      "struct Runner {",
      "  func run(a: Int, cb: () -> Void) -> Int { 0 }",
      "  func go() -> Int {",
      "    let result = run(a: 1) { }",
      "    let drawn = render(a: 2) { }",
      "    return result + drawn",
      "  }",
      "}",
      "func fetch(a: Int, cb: () -> Void) async -> Int { 0 }",
      "func load(a: Int, cb: () -> Void) async throws -> Int { 0 }",
      "struct Loader {",
      "  func refresh(a: Int, cb: () -> Void) async -> Int { 0 }",
      "  func reload() async throws -> Int {",
      "    let awaited = await fetch(a: 1) { }",
      "    let tried = try await load(a: 2) { }",
      "    let member = await refresh(a: 3) { }",
      "    return awaited + tried + member",
      "  }",
      "}",
    ];
    await withFixture("cg-swift-nested-trailing-", { "Nested.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string) => siteOf(fixture, "Nested.swift", line, token);
      await eachIndexPass(root, async (index) => {
        await expectGoto(index, at(3, "observe"), at(1, "observe"));
        await expectGoto(index, at(10, "run"), at(8, "run"));
        await expectGoto(index, at(11, "render"), at(6, "render"));
        // `await` wraps the inner call in the call that holds the trailing closure; `try await` keeps one call.
        await expectGoto(index, at(20, "fetch"), at(15, "fetch"));
        await expectGoto(index, at(21, "load"), at(16, "load"));
        await expectGoto(index, at(22, "refresh"), at(18, "refresh"));
        // Each call is proven, so the references of its declaration are complete, not merely the sites found.
        const complete = (...sites: string[]): ReferenceAnswer => ({ sites, state: "complete", reasons: [] });
        expect(await referenceAnswer(index, at(15, "fetch"))).toEqual(complete("Nested.swift:15", "Nested.swift:20"));
        expect(await referenceAnswer(index, at(16, "load"))).toEqual(complete("Nested.swift:16", "Nested.swift:21"));
        expect(await referenceAnswer(index, at(18, "refresh"))).toEqual(complete("Nested.swift:18", "Nested.swift:22"));
        expect(await referenceAnswer(index, at(1, "observe"))).toEqual(complete("Nested.swift:1", "Nested.swift:3"));
        expect(await referenceAnswer(index, at(8, "run"))).toEqual(complete("Nested.swift:8", "Nested.swift:10"));
        expect(await referenceAnswer(index, at(6, "render"))).toEqual(complete("Nested.swift:6", "Nested.swift:11"));
        const graph = await buildSymbolGraphDetailed(index);
        const file = fixture.paths["Nested.swift"]!;
        await expectCalls(index, graph, file, "use", [at(1, "observe")]);
        await expectCalls(index, graph, file, "go", [at(8, "run"), at(6, "render")]);
        await expectCalls(index, graph, file, "reload", [at(15, "fetch"), at(16, "load"), at(18, "refresh")]);
      });
    });
  });
});

describe("Swift leading-dot static members", () => {
  it("resolves OptionSet constants and static functions from the context a literal, return, or argument proves", async () => {
    const rows = [
      "struct RectCorner: OptionSet {",
      "  let rawValue: Int",
      "  static let topLeft = RectCorner(rawValue: 1)",
      "  static let topRight = RectCorner(rawValue: 2)",
      "  static let all: RectCorner = [.topLeft, .topRight]",
      "  static let both = [RectCorner.topLeft, .topRight]",
      "  static func range(_ max: Int) -> RectCorner { RectCorner(rawValue: max) }",
      "  static func make() -> RectCorner { .range(3) }",
      "}",
      "enum Other { case topLeft }",
      "func render(corners: RectCorner) {}",
      "func build() { render(corners: [.topLeft]) }",
      "func foreign() -> Foreign { .topLeft }",
      "extension RectCorner { static func range(min: Int, max: Int) -> RectCorner { RectCorner(rawValue: max - min) } }",
      "func spans() -> RectCorner { .range(min: 1, max: 2) }",
      "struct Box<T> { static let empty = Box<T>(); static func filled(_ value: Int) -> Box<T> { Box<T>() } }",
      "func empty() {}",
      "func absent() {}",
      "func make() -> Box<Int> { .empty }",
      "func pour() -> Box<Int> { .filled(1) }",
      "func miss() -> Box<Int> { .absent }",
    ];
    await withFixture("cg-swift-static-members-", { "Corner.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string) => siteOf(fixture, "Corner.swift", line, token);
      await eachIndexPass(root, async (index) => {
        // A typed OptionSet literal, a return type, and a parameter type prove the contextual type.
        await expectGoto(index, at(5, "topLeft"), at(3, "topLeft"));
        await expectGoto(index, at(5, "topRight"), at(4, "topRight"));
        await expectGoto(index, at(8, "range"), at(7, "range"));
        await expectGoto(index, at(12, "topLeft"), at(3, "topLeft"));
        // Argument labels pick among same-named static functions, including one declared in an extension.
        await expectGoto(index, at(15, "range"), at(14, "range"));
        // A generic written type names its nominal type; a same-named function elsewhere is not its member.
        await expectGoto(index, at(19, "empty"), at(16, "empty"));
        await expectGoto(index, at(20, "filled"), at(16, "filled"));
        await expectUnresolved(index, at(21, "absent"));
        // No context is proven for an untyped literal, so the bare lookup inside the type keeps its static member.
        await expectGoto(index, at(6, "topRight"), at(4, "topRight"));
        // An external contextual type owns its members, and `Other.topLeft` is a different declaration.
        await expectUnresolved(index, at(13, "topLeft"));
        // `foreign() -> Foreign { .topLeft }` names a member of an external type, so no site is provably another
        // declaration's: both `topLeft` declarations list their proven sites and claim partial coverage.
        const partial = ["strategy_unavailable"];
        expect(await referenceAnswer(index, at(3, "topLeft"))).toEqual({
          sites: ["Corner.swift:3", "Corner.swift:5", "Corner.swift:6", "Corner.swift:12"],
          state: "partial",
          reasons: partial,
        });
        expect(await referenceAnswer(index, at(10, "topLeft"))).toEqual({
          sites: ["Corner.swift:10"],
          state: "partial",
          reasons: partial,
        });
        // Every use of the other members is proven.
        const complete = (...sites: string[]): ReferenceAnswer => ({ sites, state: "complete", reasons: [] });
        expect(await referenceAnswer(index, at(4, "topRight"))).toEqual(
          complete("Corner.swift:4", "Corner.swift:5", "Corner.swift:6"),
        );
        expect(await referenceAnswer(index, at(7, "range"))).toEqual(complete("Corner.swift:7", "Corner.swift:8"));
        expect(await referenceAnswer(index, at(14, "range"))).toEqual(complete("Corner.swift:14", "Corner.swift:15"));
        expect(await referenceAnswer(index, at(16, "empty"))).toEqual(complete("Corner.swift:16", "Corner.swift:19"));
        expect(await referenceAnswer(index, at(16, "filled"))).toEqual(complete("Corner.swift:16", "Corner.swift:20"));
      });
    });
  });
});

describe("Swift references and renames of a miscounted lone call", () => {
  it("lists the call as a reference and renames it with its declaration from a cold and a reopened cache", async () => {
    const rows = ["func helper(_ a: String, b: Int) {}", 'func run() { helper("x") }'];
    await withFixture("cg-swift-lone-rename-", { "Lone.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string) => siteOf(fixture, "Lone.swift", line, token);
      await eachIndexPass(root, async (index) => {
        expect(await referenceSites(index, at(1, "helper"))).toEqual(["Lone.swift:1", "Lone.swift:2"]);
      });
      for (let pass = 0; pass < 2; pass += 1) {
        clearMemoryCache();
        const session = createAgentSession({ root, buildOptions: { cache: "disk" } });
        try {
          const preview = await previewRenameWithSession(session, {
            root,
            handle: "Lone.swift::helper",
            newName: "assist",
          });
          expect(preview.safe).toBe(true);
          expect(preview.unsafeSites).toEqual([]);
          expect(preview.edits.map((edit) => [edit.file, edit.oldText, edit.kind]).sort()).toEqual([
            ["Lone.swift", "helper", "definition"],
            ["Lone.swift", "helper", "reference"],
          ]);
        } finally {
          session.invalidate();
        }
      }
    });
  });
});

describe("Swift member calls that miscount their only candidate", () => {
  it("keeps a lone same-name member as the target, whatever its labels, and rejects competing overloads", async () => {
    const rows = [
      "class Box {",
      "  func target(_ x: Int) -> Int { x }",
      "  static func make(_ x: Int) -> Int { x }",
      "  func selfMiss() -> Int { self.target(1, 2) }",
      "  func implicitMiss() -> Int { target(1, 2) }",
      "  func labelMiss() -> Int { self.target(a: 1) }",
      "  func staticMiss() -> Int { Box.make(1, 2) }",
      "}",
      "func typedMiss(_ box: Box) -> Int { box.target(1, 2) }",
      "func localMiss() -> Int { let box = Box(); return box.target(1, 2) }",
      "func labelledMiss(_ box: Box) -> Int { box.target(a: 1) }",
      "class Pair {",
      "  func pick(_ x: Int) -> Int { x }",
      "  func pick(_ x: Int, _ y: Int, _ z: Int) -> Int { x }",
      "  func pickMiss() -> Int { self.pick(1, 2) }",
      "}",
      "struct Decoy { func target(_ x: Int, _ y: Int) -> Int { x } }",
    ];
    await withFixture("cg-swift-lone-member-", { "Box.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string, occurrence = 0) => siteOf(fixture, "Box.swift", line, token, occurrence);
      await eachIndexPass(root, async (index) => {
        // A wrong count keeps the lone member through `self`, an implicit receiver, a type, a parameter, and a local.
        for (const line of [4, 5, 9, 10]) await expectGoto(index, at(line, "target"), at(2, "target"));
        // A label no parameter has does not reject the lone member either, as before label matching.
        for (const line of [6, 11]) await expectGoto(index, at(line, "target"), at(2, "target"));
        await expectGoto(index, at(7, "make"), at(3, "make"));
        // Two overloads that both miscount compete for the call, so it picks none.
        await expectUnresolved(index, at(15, "pick", 1));
        expect(await referenceAnswer(index, at(2, "target"))).toEqual({
          sites: [
            "Box.swift:2",
            "Box.swift:4",
            "Box.swift:5",
            "Box.swift:6",
            "Box.swift:9",
            "Box.swift:10",
            "Box.swift:11",
          ],
          state: "complete",
          reasons: [],
        });
        expect(await referenceAnswer(index, at(3, "make"))).toEqual({
          sites: ["Box.swift:3", "Box.swift:7"],
          state: "complete",
          reasons: [],
        });
        // The graph records no edge for a call its target cannot accept.
        const graph = await buildSymbolGraphDetailed(index);
        const file = fixture.paths["Box.swift"]!;
        for (const caller of ["selfMiss", "implicitMiss", "staticMiss", "typedMiss", "localMiss"]) {
          await expectCalls(index, graph, file, caller, []);
        }
        // A wrong label alone leaves the call acceptable to its target, so the edge stays.
        await expectCalls(index, graph, file, "labelMiss", [at(2, "target")]);
        await expectCalls(index, graph, file, "labelledMiss", [at(2, "target")]);
        await expectCalls(index, graph, file, "pickMiss", []);
      });
    });
  });
});

describe("Swift leading-dot calls and static variables", () => {
  it("resolves a call to a static function or a function-valued variable, never to a variable holding a value", async () => {
    const rows = [
      "struct Cfg {",
      "  enum Storage { case disabled(cap: Int) }",
      "  var s: Storage",
      "  static var disabled: Cfg { .disabled(cap: 1) }",
      "  static func disabled(cap: Int) -> Cfg { Cfg(s: .disabled(cap: cap)) }",
      "  static let handler: @Sendable (Int) -> Cfg = { _ in Cfg(s: .disabled(cap: 0)) }",
      "  static var viaHandler: Cfg { .handler(2) }",
      "  static let value = Cfg(s: .disabled(cap: 9))",
      "  static var viaValue: Cfg { .value(3) }",
      "}",
    ];
    await withFixture("cg-swift-leading-dot-call-", { "Cfg.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string, occurrence = 0) => siteOf(fixture, "Cfg.swift", line, token, occurrence);
      await eachIndexPass(root, async (index) => {
        // The return type proves `Cfg`, whose call names the function, not the variable of the same name.
        await expectGoto(index, at(4, "disabled", 1), at(5, "disabled"));
        await expectGoto(index, at(7, "handler"), at(6, "handler"));
        // A variable that holds a value is not a callee, and an argument's contextual type is unproven.
        await expectUnresolved(index, at(9, "value"));
        await expectUnresolved(index, at(5, "disabled", 1));
        expect((await referenceAnswer(index, at(4, "disabled"))).sites).toEqual(["Cfg.swift:4"]);
        expect((await referenceAnswer(index, at(5, "disabled"))).sites).toEqual(["Cfg.swift:4", "Cfg.swift:5"]);
        expect((await referenceAnswer(index, at(8, "value"))).sites).toEqual(["Cfg.swift:8"]);
      });
    });
  });
});

describe("Swift calls of a variable member", () => {
  it("records a call edge only to enum cases and variables whose declaration is a function", async () => {
    const rows = [
      "struct Failure: Error {",
      '  static let message = "text"',
      "  static let render: @Sendable (Int) -> String = { String($0) }",
      "  static var handler = { (x: Int) in x }",
      "}",
      "enum Outcome { case payload(Int) }",
      "func run() { _ = Failure.message(for: 1) }",
      "func invoke() { _ = Failure.render(1) }",
      "func close() { _ = Failure.handler(1) }",
      "func build() { _ = Outcome.payload(1) }",
    ];
    await withFixture("cg-swift-variable-call-", { "Failure.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string) => siteOf(fixture, "Failure.swift", line, token);
      await eachIndexPass(root, async (index) => {
        const graph = await buildSymbolGraphDetailed(index);
        const file = fixture.paths["Failure.swift"]!;
        // `Failure.message(for:)` is an inherited or extension function, not the string the property holds.
        await expectCalls(index, graph, file, "run", []);
        await expectCalls(index, graph, file, "invoke", [at(3, "render")]);
        await expectCalls(index, graph, file, "close", [at(4, "handler")]);
        await expectCalls(index, graph, file, "build", [at(6, "payload")]);
      });
    });
  });
});

describe("Swift pattern bindings that shadow members", () => {
  it("never reads a pattern-bound local as the property or the method that shares its name", async () => {
    const rows = [
      "enum Parsed { case dup(String, originalInput: [Int]) }",
      "struct Gen {",
      "  var arguments: [String]",
      "  func arguments(for key: Int) -> [String] { [] }",
      "  func use(previous: String, arguments: [Int]) -> Int { 0 }",
      "  func shadowed(_ e: Parsed) -> Int {",
      "    switch e {",
      "    case .dup(let previous, originalInput: let arguments):",
      "      return use(previous: previous, arguments: arguments)",
      "    }",
      "  }",
      "  func read() -> Int { arguments.count }",
      "  func viaSelf() -> Int { self.arguments.count }",
      '  func param(_ arguments: [Int]) -> Int { use(previous: "", arguments: arguments) }',
      '  func local() -> Int { let arguments = [1]; return use(previous: "", arguments: arguments) }',
      "}",
    ];
    await withFixture("cg-swift-pattern-shadow-", { "Gen.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string, occurrence = 0) => siteOf(fixture, "Gen.swift", line, token, occurrence);
      await eachIndexPass(root, async (index) => {
        // The pattern declares a local the scope model does not see: neither its binder nor its use is a member.
        await expectUnresolved(index, at(8, "arguments"));
        await expectUnresolved(index, at(9, "arguments", 1));
        // A read the pattern cannot bind prefers the property, a `self.` access names it, and declared locals win.
        await expectGoto(index, at(12, "arguments"), at(3, "arguments"));
        await expectGoto(index, at(13, "arguments"), at(3, "arguments"));
        await expectGoto(index, at(14, "arguments", 2), at(14, "arguments"));
        await expectGoto(index, at(15, "arguments", 2), at(15, "arguments"));
        const refs = await referenceAnswer(index, at(3, "arguments"));
        expect(refs.sites).toEqual(["Gen.swift:3", "Gen.swift:12", "Gen.swift:13"]);
      });
    });
  });
});

describe("Swift rename previews of receiver-spelled and leading-dot members", () => {
  const rows = [
    "import Foundation",
    "final class Cache {",
    "  private let lock = NSLock()",
    "  func removeExpired() {",
    "    lock.lock()",
    "  }",
    "}",
    "struct RectCorner {",
    "  static func range(_ max: Int) -> RectCorner { RectCorner() }",
    "  static func make() -> RectCorner { .range(3) }",
    "  static let topLeft = RectCorner()",
    "}",
    "func external(_ corner: Foreign) {}",
    "func use() { external(.topLeft) }",
  ];

  it("edits only proven sites, from a cold and a reopened cache", async () => {
    await withFixture("cg-swift-rename-members-", { "Cache.swift": rows }, async (_fixture, root) => {
      for (let pass = 0; pass < 2; pass += 1) {
        clearMemoryCache();
        const session = createAgentSession({ root, buildOptions: { cache: "disk" } });
        try {
          const sites = async (handle: string, newName: string) => {
            const preview = await previewRenameWithSession(session, { root, handle, newName });
            return {
              safe: preview.safe,
              edits: preview.edits.map((edit) => `${edit.range.start.line}:${edit.range.start.column}`).sort(),
            };
          };
          // The member after the dot belongs to NSLock, so it is never renamed with the variable.
          expect(await sites("Cache.swift::lock", "mutex")).toEqual({ safe: false, edits: ["3:15", "5:5"] });
          // The leading-dot call is a proven use of the static function in its return context.
          expect(await sites("Cache.swift::range", "span")).toEqual({ safe: true, edits: ["10:39", "9:15"].sort() });
          // `.topLeft` names a member of an external type here, so the use is unproven and the rename is unsafe.
          expect((await sites("Cache.swift::topLeft", "corner")).safe).toBe(false);
        } finally {
          session.invalidate();
        }
      }
    });
  });
});

describe("Swift callable facts after edits, deletes, renames, and restores", () => {
  it("answers from memory, reopened disk, and incremental builds as a cold build does", async () => {
    const send = [
      "extension Box {",
      '  func send(to value: String, retries: Int = 0) -> String { "to" }',
      '  func send(_ value: String) -> String { "plain" }',
      "}",
    ];
    const caller = [
      'func callTo(_ box: Box) -> String { box.send(to: "x") }',
      'func callPlain(_ box: Box) -> String { box.send("x") }',
      'func callRetries(_ box: Box) -> String { box.send(to: "x", retries: 2) }',
    ];
    const initial: Record<string, readonly string[]> = {
      "Lib/Box.swift": ["struct Box {}"],
      "Lib/Box+Send.swift": send,
      "Lib/Caller.swift": caller,
      "Lib/Miss.swift": ['func callMiss(_ box: Box) -> String { box.send("x", 1, 2) }'],
      // Another directory is another unit: its own `Box` neither sees nor shares the extension.
      "Elsewhere/Box.swift": [
        'struct Box { func send(_ value: String) -> String { "decoy" } }',
        'func elsewhere(_ box: Box) -> String { box.send("x") }',
      ],
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-warm-cold-"));
    try {
      const written = await writeFixtureFiles(
        root,
        Object.fromEntries(Object.entries(initial).map(([file, lines]) => [file, `${lines.join("\n")}\n`])),
      );
      const state = new Map<string, readonly string[]>(Object.entries(initial));
      const paths = new Map<string, string>(Object.entries(written));
      const rel = (file: string) => path.relative(root, file).replace(/\\/g, "/");
      /** Goto at every `send`, references of each declaration, and the call edges, in a stable order. */
      const answers = async (index: ProjectIndex): Promise<string[]> => {
        const out: string[] = [];
        for (const [file, lines] of [...state].sort(([a], [b]) => a.localeCompare(b))) {
          for (const [row, text] of lines.entries()) {
            for (let at = text.indexOf("send"); at >= 0; at = text.indexOf("send", at + 1)) {
              const site = { file: paths.get(file)!, line: row + 1, column: at + 1 };
              const target = await goToDefinition(index, site);
              const where =
                target.status === "ok"
                  ? `${rel(target.definition.file)}:${target.definition.range.start.line}`
                  : "none";
              out.push(`goto ${file}:${row + 1}:${at + 1} ${where}`);
              if (!text.slice(0, at).endsWith("func ")) continue;
              const refs = await findReferences(index, site);
              if (refs.status !== "ok") throw new Error(`${file}:${row + 1} ${refs.status}`);
              const found = refs.references.map((ref) => `${rel(ref.file)}:${ref.range.start.line}`).sort();
              out.push(`refs ${file}:${row + 1} ${found.join(",")} ${refs.referenceCoverage.state}`);
            }
          }
        }
        const graph = await buildSymbolGraphDetailed(index);
        for (const edge of graph.edges) {
          if (edge.label === "calls" && edge.site) {
            out.push(
              `edge ${rel(edge.site.file)}:${edge.site.range.start.line} ${edge.to.replace(/\\/g, "/").replace(root.replace(/\\/g, "/"), "")}`,
            );
          }
        }
        return out.sort();
      };
      const compare = async (step: string): Promise<string[]> => {
        const cold = await answers(await buildProjectIndex(root, { cache: "off", threads: 1 }));
        expect(
          await answers(await buildProjectIndex(root, { cache: "memory", threads: 1 })),
          `memory after ${step}`,
        ).toEqual(cold);
        clearMemoryCache();
        expect(
          await answers(await buildProjectIndex(root, { cache: "disk", threads: 1 })),
          `disk after ${step}`,
        ).toEqual(cold);
        expect(
          await answers(await buildProjectIndexIncremental(root, { cache: "disk", threads: 1 })),
          `incremental after ${step}`,
        ).toEqual(cold);
        return cold;
      };
      const write = async (file: string, lines: readonly string[]) => {
        state.set(file, lines);
        await writeFile(paths.get(file)!, `${lines.join("\n")}\n`);
      };
      const first = await compare("the initial build");

      // Edit an extension in another directory: `to:` becomes `into:`, so the calls spelling `to:` lose their callee.
      await write(
        "Lib/Box+Send.swift",
        send.map((line) => line.replace("send(to ", "send(into ")),
      );
      const edited = await compare("editing the extension");
      expect(edited).not.toEqual(first);

      // Delete a caller.
      await unlink(paths.get("Lib/Caller.swift")!);
      state.delete("Lib/Caller.swift");
      await compare("deleting the caller");

      // Rename the extension away and back.
      const away = paths.get("Lib/Box+Send.swift")!.replace("Box+Send.swift", "Box+Send2.swift");
      await rename(paths.get("Lib/Box+Send.swift")!, away);
      state.set("Lib/Box+Send2.swift", state.get("Lib/Box+Send.swift")!);
      state.delete("Lib/Box+Send.swift");
      paths.set("Lib/Box+Send2.swift", away);
      await compare("renaming the extension");
      await rename(away, paths.get("Lib/Box+Send.swift")!);
      state.set("Lib/Box+Send.swift", state.get("Lib/Box+Send2.swift")!);
      state.delete("Lib/Box+Send2.swift");
      await compare("renaming the extension back");

      // Restore the edited and the deleted files: the answers return to the first build's.
      await write("Lib/Box+Send.swift", send);
      await write("Lib/Caller.swift", caller);
      expect(await compare("restoring both files")).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift binders that shadow a property and a method", () => {
  const rows = [
    "enum Parsed { case dup(String, originalInput: [Int]) }",
    "struct Failure: Error { var code = 0 }",
    "enum Bad: Error { case bad([Int]) }",
    "struct Gen {",
    "  var arguments: [String] = []",
    "  func arguments(for key: Int) -> Int { key }",
    "  func take(_ value: Any) {}",
    "  func fail() throws {}",
    "  func tuple(_ o: ([Int], Int)) { let (arguments, _) = o; take(arguments.reduce(0, +)) }",
    "  func forTuple(_ o: [([Int], Int)]) { for (arguments, _) in o { take(arguments.reduce(0, +)) } }",
    "  func ifVar(_ o: [Int]?) { if var arguments = o { arguments.append(1) } }",
    "  func varTuple(_ o: ([Int], Int)) { var (arguments, _) = o; arguments.append(1) }",
    "  func whileVar(_ o: [Int]?) { while var arguments = o { arguments.append(1); break } }",
    "  func ifLet(_ o: [Int]?) { if let arguments = o { take(arguments.reduce(0, +)) } }",
    "  func guardLet(_ o: [Int]?) { guard let arguments = o else { return }; take(arguments.reduce(0, +)) }",
    "  func forIn(_ o: [[Int]]) { for arguments in o { take(arguments.reduce(0, +)) } }",
    "  func closure() { let g = { (arguments: [Int]) in take(arguments.reduce(0, +)) }; g([1]) }",
    "  func switchCase(_ p: Parsed) { switch p { case .dup(_, originalInput: let arguments): take(arguments.reduce(0, +)) } }",
    "  func ifCase(_ p: Parsed) { if case .dup(_, originalInput: let arguments) = p { take(arguments.reduce(0, +)) } }",
    "  func guardCase(_ p: Parsed) { guard case .dup(_, originalInput: let arguments) = p else { return }; take(arguments.reduce(0, +)) }",
    "  func whileCase(_ p: Parsed) { while case .dup(_, originalInput: let arguments) = p { take(arguments.reduce(0, +)); break } }",
    "  func catchLet() throws { do { try fail() } catch let arguments { throw arguments } }",
    "  func catchCast() { do { try fail() } catch let arguments as Failure { take(arguments.code) } catch {} }",
    "  func catchCase() { do { try fail() } catch Bad.bad(let arguments) { take(arguments.reduce(0, +)) } catch {} }",
    "  func property() -> Int { arguments.count }",
    "}",
    "struct Solo {",
    "  var arguments: [String] = []",
    "  func take(_ value: Any) {}",
    "  func read() { take(arguments) }",
    "  func viaSelf() { take(self.arguments) }",
    "}",
  ];
  // The 1-based line of the first row that declares `needle`, so rows can be added without renumbering the test.
  const lineOf = (needle: string): number => rows.findIndex((row) => row.includes(needle)) + 1;

  it("leaves every binder form and its reads unresolved while a plain read names the property", async () => {
    await withFixture("cg-swift-binder-forms-", { "Gen.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string, occurrence = 0) => siteOf(fixture, "Gen.swift", line, token, occurrence);
      const propertyLine = lineOf("var arguments: [String] = []");
      const methodLine = lineOf("func arguments(for");
      const takeLine = lineOf("func take");
      const failLine = lineOf("func fail");
      const readLine = lineOf("func property()");
      const soloLine = lineOf("struct Solo") + 1;
      const binderCallers = {
        value: ["tuple", "forTuple", "ifLet", "guardLet", "forIn", "switchCase", "ifCase", "guardCase", "whileCase"],
        thrown: ["catchCast", "catchCase"],
        mutated: ["ifVar", "varTuple", "whileVar"],
      };
      await eachIndexPass(root, async (index) => {
        // A tuple, for-tuple, `var` condition, `let` condition, `guard`, `for`, closure, `case`, and `catch` binding
        // is a local the scope model does not declare: neither its binder nor a read of it names a member.
        const binderLines = Object.values(binderCallers)
          .flat()
          .concat("closure", "catchLet")
          .map((caller) => lineOf(`func ${caller}(`));
        for (const line of binderLines) {
          await expectUnresolved(index, at(line, "arguments"));
          await expectUnresolved(index, at(line, "arguments", 1));
        }
        await expectGoto(index, at(readLine, "arguments"), at(propertyLine, "arguments"));
        // No binder form leaks into the property's or the method's references; the property stays partially covered.
        expect(await referenceAnswer(index, at(propertyLine, "arguments"))).toEqual({
          sites: [`Gen.swift:${propertyLine}`, `Gen.swift:${readLine}`],
          state: "partial",
          reasons: ["strategy_unavailable"],
        });
        expect((await referenceAnswer(index, at(methodLine, "arguments"))).sites).toEqual([`Gen.swift:${methodLine}`]);
        // Without the same-named method nothing is ambiguous, so a plain read keeps naming the property.
        await expectGoto(index, at(soloLine + 2, "arguments"), at(soloLine, "arguments"));
        await expectGoto(index, at(soloLine + 3, "arguments"), at(soloLine, "arguments"));
        const graph = await buildSymbolGraphDetailed(index);
        const file = fixture.paths["Gen.swift"]!;
        for (const caller of binderCallers.value) await expectCalls(index, graph, file, caller, [at(takeLine, "take")]);
        await expectCalls(index, graph, file, "catchLet", [at(failLine, "fail")]);
        for (const caller of binderCallers.thrown) {
          await expectCalls(index, graph, file, caller, [at(failLine, "fail"), at(takeLine, "take")]);
        }
        // The closure calls `take` and its own local `g`, never the property or the method named by its binder.
        const closureLine = lineOf("func closure(");
        await expectCalls(index, graph, file, "closure", [at(takeLine, "take"), at(closureLine, "g")]);
        for (const caller of [...binderCallers.mutated, "property"]) await expectCalls(index, graph, file, caller, []);
      });
    });
  });
});

describe("Swift inherited members that miscount or mislabel their only candidate", () => {
  const rows = [
    "class Base {",
    "  func solo(x: Int) -> Int { x }",
    "  func twice(_ a: Int) -> Int { a }",
    "  static func make(x: Int) -> Int { x }",
    "  func pick(_ a: Int) -> Int { a }",
    "  func pick(_ a: Int, _ b: Int, _ c: Int) -> Int { a }",
    "}",
    "class Derived: Base {",
    "  func viaImplicit() -> Int { solo(a: 1) }",
    "  func viaSelf() -> Int { self.solo(a: 1) }",
    "  func viaSuper() -> Int { super.solo(a: 1) }",
    "  func countImplicit() -> Int { twice(1, 2) }",
    "  func countSelf() -> Int { self.twice(1, 2) }",
    "  func countSuper() -> Int { super.twice(1, 2) }",
    "  func viaStatic() -> Int { Derived.make(a: 1) }",
    "  func competing() -> Int { pick(1, 2) }",
    "}",
    "class Leaf: Derived {}",
    "func viaTyped(_ derived: Derived) -> Int { derived.solo(a: 1) }",
    "func viaSubclass() -> Int { let leaf = Leaf(); return leaf.solo(a: 1) }",
    "func countTyped(_ derived: Derived) -> Int { derived.twice(1, 2) }",
    "func viaBase(_ base: Base) -> Int { base.solo(a: 1) }",
    "class Top { func level(x: Int) -> Int { x } }",
    "class Mid: Top { func level(y: Int) -> Int { y } }",
    "class Low: Mid { func lowCall() -> Int { level(w: 1) } }",
    "class Twin { func both(x: Int) -> Int { x }; func both(y: Int) -> Int { y } }",
    "class TwinUser: Twin { func twinCall() -> Int { both(a: 1) } }",
  ];
  // The 1-based line of the first row that contains `needle`, so rows can be added without renumbering the test.
  const lineOf = (needle: string): number => rows.findIndex((row) => row.includes(needle)) + 1;
  const labelCallers = ["viaImplicit", "viaSelf", "viaSuper", "viaTyped", "viaSubclass", "viaBase"];
  const countCallers = ["countImplicit", "countSelf", "countTyped"];
  const sitesOf = (declaration: number, callers: readonly string[]): string[] =>
    [declaration, ...callers.map((caller) => lineOf(`func ${caller}(`))]
      .sort((a, b) => a - b)
      .map((line) => `Inherit.swift:${line}`);

  it("keeps the only same-name member of a base class as the target of a mislabeled or miscounted call", async () => {
    await withFixture("cg-swift-inherited-lone-", { "Inherit.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string) => siteOf(fixture, "Inherit.swift", line, token);
      const solo = lineOf("func solo(");
      const twice = lineOf("func twice(");
      const make = lineOf("static func make(");
      const mid = lineOf("class Mid");
      await eachIndexPass(root, async (index) => {
        // A wrong label keeps the inherited member through every receiver, `super` included.
        for (const caller of labelCallers) {
          await expectGoto(index, at(lineOf(`func ${caller}(`), "solo"), at(solo, "solo"));
        }
        // So does a wrong argument count, except through `super`, which never stands in for a miscounted call.
        for (const caller of countCallers) {
          await expectGoto(index, at(lineOf(`func ${caller}(`), "twice"), at(twice, "twice"));
        }
        await expectUnresolved(index, at(lineOf("func countSuper("), "twice"));
        await expectGoto(index, at(lineOf("func viaStatic("), "make"), at(make, "make"));
        // Two overloads of the base class compete for a call that neither accepts.
        await expectUnresolved(index, at(lineOf("func competing("), "pick"));
        // The nearest declaring level decides: a declaration further up does not compete with a lone one.
        await expectGoto(index, at(lineOf("func lowCall("), "level"), at(mid, "level"));
        // Two declarations at one level compete, so a label that fits neither picks none.
        await expectUnresolved(index, at(lineOf("func twinCall("), "both"));
        expect(await referenceAnswer(index, at(solo, "solo"))).toEqual({
          sites: sitesOf(solo, labelCallers),
          state: "complete",
          reasons: [],
        });
        // The miscounted `super` call names the member without proof, so coverage stays partial.
        expect(await referenceAnswer(index, at(twice, "twice"))).toEqual({
          sites: sitesOf(twice, countCallers),
          state: "partial",
          reasons: ["strategy_unavailable"],
        });
        expect(await referenceAnswer(index, at(make, "make"))).toEqual({
          sites: sitesOf(make, ["viaStatic"]),
          state: "complete",
          reasons: [],
        });
        const graph = await buildSymbolGraphDetailed(index);
        const file = fixture.paths["Inherit.swift"]!;
        for (const caller of labelCallers) await expectCalls(index, graph, file, caller, [at(solo, "solo")]);
        await expectCalls(index, graph, file, "viaStatic", [at(make, "make")]);
        await expectCalls(index, graph, file, "lowCall", [at(mid, "level")]);
        // The graph records no edge for a call its target cannot accept, or for one that overloads contest.
        for (const caller of [...countCallers, "countSuper", "competing", "twinCall"]) {
          await expectCalls(index, graph, file, caller, []);
        }
      });
    });
  });
});

describe("Swift calls whose labels fit none of the overloads", () => {
  const rows = [
    "func one(x: Int) -> Int { x }",
    "func one(y: Int, z: Int) -> Int { y }",
    "func twin(x: Int) -> Int { x }",
    "func twin(y: Int) -> Int { y }",
    "func draw(at: Int, scale: Int) -> Int { at }",
    "func draw(at: Int, opacity: Int) -> Int { at }",
    "func draw(_ raw: Int) -> Int { raw }",
    "func log(_ msg: String, tag: String) {}",
    "func log(_ msg: String, tag: String, level: Int) {}",
    "func log(count: Int) {}",
    "func freeOne() -> Int { one(a: 1) }",
    "func freeTwo() -> Int { one(a: 1, 2) }",
    "func freeTwin() -> Int { twin(a: 1) }",
    "func freeDraw() -> Int { draw(at: 1) }",
    'func freeLog() { log("hi") }',
    "func place(_ name: String, at point: Int = 0, cb: () -> Void) {}",
    "func place(_ name: String, scale: Int, cb: () -> Void) {}",
    'func freePlace() { place("a", at: 1) {} }',
    'func boundPlace() { let x = place("a", at: 1) {}; _ = x }',
    "class Base {",
    "  func solo(x: Int) -> Int { x }",
    "  func solo(y: Int, z: Int) -> Int { y }",
    "  func pair(x: Int) -> Int { x }",
    "  func pair(y: Int) -> Int { y }",
    "  func draw(at: Int, scale: Int) -> Int { at }",
    "  func draw(at: Int, opacity: Int) -> Int { at }",
    "  func draw(_ raw: Int) -> Int { raw }",
    "  func viaImplicit() -> Int { solo(a: 1) }",
    "  func viaSelf() -> Int { self.solo(a: 1) }",
    "  func viaPair() -> Int { self.pair(a: 1) }",
    "  func implicitDraw() -> Int { draw(at: 1) }",
    "  func selfDraw() -> Int { self.draw(at: 1) }",
    "  func place(_ name: String, at point: Int = 0, cb: () -> Void) {}",
    "  func place(_ name: String, scale: Int, cb: () -> Void) {}",
    '  func memberPlace() { self.place("a", at: 1) {} }',
    "}",
    "class Derived: Base {",
    "  func inheritedImplicit() -> Int { solo(a: 1) }",
    "  func inheritedSelf() -> Int { self.solo(a: 1) }",
    "  func inheritedSuper() -> Int { super.solo(a: 1) }",
    "  func inheritedPair() -> Int { pair(a: 1) }",
    "}",
    "class Leaf: Derived {}",
    "func viaTyped(_ derived: Derived) -> Int { derived.solo(a: 1) }",
    "func viaSubclass() -> Int { let leaf = Leaf(); return leaf.solo(a: 1) }",
    "func typedPair(_ derived: Derived) -> Int { derived.pair(a: 1) }",
    "func viaDraw(_ base: Base) -> Int { base.draw(at: 1) }",
  ];
  // The 1-based line of the first row that contains `needle`, so rows can be added without renumbering the test.
  const lineOf = (needle: string): number => rows.findIndex((row) => row.includes(needle)) + 1;
  const soloCallers = [
    "viaImplicit",
    "viaSelf",
    "inheritedImplicit",
    "inheritedSelf",
    "inheritedSuper",
    "viaTyped",
    "viaSubclass",
  ];
  const sitesOf = (declaration: number, callers: readonly string[]): string[] =>
    [declaration, ...callers.map((caller) => lineOf(`func ${caller}(`))]
      .sort((a, b) => a - b)
      .map((line) => `Overloads.swift:${line}`);

  it("chooses the one overload whose argument count fits and leaves the call open otherwise", async () => {
    await withFixture("cg-swift-label-overloads-", { "Overloads.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string) => siteOf(fixture, "Overloads.swift", line, token);
      const oneX = lineOf("func one(x:");
      const oneYZ = lineOf("func one(y:");
      const solo = lineOf("func solo(x:");
      const freePlaceAt = at(lineOf("func place(_ name: String, at"), "place");
      const memberPlaceAt = at(lineOf("  func place(_ name: String, at"), "place");
      await eachIndexPass(root, async (index) => {
        await expectGoto(index, at(lineOf("func freePlace("), "place"), freePlaceAt);
        await expectGoto(index, at(lineOf("func boundPlace("), "place"), freePlaceAt);
        await expectGoto(index, at(lineOf("func memberPlace("), "place"), memberPlaceAt);
        // The labels fit neither \`one\`, so the argument count picks the overload it fits.
        await expectGoto(index, at(lineOf("func freeOne("), "one"), at(oneX, "one"));
        await expectGoto(index, at(lineOf("func freeTwo("), "one"), at(oneYZ, "one"));
        // Two overloads take one argument, so the count does not pick either.
        await expectUnresolved(index, at(lineOf("func freeTwin("), "twin"));
        // The same holds for members, whether declared on the receiver's type or inherited.
        for (const caller of soloCallers)
          await expectGoto(index, at(lineOf(`func ${caller}(`), "solo"), at(solo, "solo"));
        for (const caller of [
          "viaPair",
          "inheritedPair",
          "typedPair",
          "freeDraw",
          "freeLog",
          "implicitDraw",
          "selfDraw",
          "viaDraw",
        ]) {
          let token = "pair";
          if (caller.endsWith("Log")) token = "log";
          else if (caller.endsWith("Draw")) token = "draw";
          await expectUnresolved(index, at(lineOf(`func ${caller}(`), token));
        }
        const freeDrawRaw = at(lineOf("func draw(_ raw: Int)"), "draw");
        const memberDrawRaw = at(lineOf("  func draw(_ raw: Int)"), "draw");
        const freeLogCount = at(lineOf("func log(count: Int)"), "log");
        expect((await referenceAnswer(index, freeDrawRaw)).sites).toEqual(sitesOf(lineOf("func draw(_ raw: Int)"), []));
        expect((await referenceAnswer(index, memberDrawRaw)).sites).toEqual(
          sitesOf(lineOf("  func draw(_ raw: Int)"), []),
        );
        expect((await referenceAnswer(index, freeLogCount)).sites).toEqual(sitesOf(lineOf("func log(count: Int)"), []));
        expect(await referenceAnswer(index, at(oneX, "one"))).toEqual({
          sites: sitesOf(oneX, ["freeOne"]),
          state: "complete",
          reasons: [],
        });
        expect(await referenceAnswer(index, at(oneYZ, "one"))).toEqual({
          sites: sitesOf(oneYZ, ["freeTwo"]),
          state: "complete",
          reasons: [],
        });
        expect(await referenceAnswer(index, at(solo, "solo"))).toEqual({
          sites: sitesOf(solo, soloCallers),
          state: "complete",
          reasons: [],
        });
        const graph = await buildSymbolGraphDetailed(index);
        const file = fixture.paths["Overloads.swift"]!;
        await expectCalls(index, graph, file, "freeOne", [at(oneX, "one")]);
        await expectCalls(index, graph, file, "freeTwo", [at(oneYZ, "one")]);
        for (const caller of soloCallers) await expectCalls(index, graph, file, caller, [at(solo, "solo")]);
        for (const caller of [
          "freeTwin",
          "viaPair",
          "inheritedPair",
          "typedPair",
          "freeDraw",
          "freeLog",
          "implicitDraw",
          "selfDraw",
          "viaDraw",
        ]) {
          await expectCalls(index, graph, file, caller, []);
        }
        await expectCalls(index, graph, file, "freePlace", [freePlaceAt]);
        await expectCalls(index, graph, file, "boundPlace", [freePlaceAt]);
        await expectCalls(index, graph, file, "memberPlace", [memberPlaceAt]);
      });
    });
  });
});

describe("Swift private and fileprivate types with extensions", () => {
  const types = [
    "private protocol Hidden { func hide() }",
    "extension Hidden { func hide() {} }",
    "fileprivate protocol Shown { func show() }",
    "extension Shown { func show() {} }",
    "private class Base { func work() {} }",
    "extension Base { func more() {} }",
    "fileprivate class Core { func run() {} }",
    "extension Core { func extra() {} }",
    "fileprivate struct Item { var value = 1 }",
    "extension Item { func twice() -> Int { value * 2 } }",
    "private struct Cache { var count = 0 }",
    "extension Cache { func total() -> Int { count } }",
    "protocol Open { func open() }",
    "extension Open { func open() {} }",
    "private struct Conformer: Hidden, Shown, Open {}",
    "private final class Derived: Base {}",
    "fileprivate final class Leaf: Core {}",
    "private struct Holder { var hidden: Hidden?; var shown: Shown?; var cache = Cache() }",
    "fileprivate func annotate(_ hidden: Hidden, _ item: Item) -> Item { item }",
    "fileprivate func tally(_ cache: Cache) -> Cache { cache }",
    "func construct() { _ = Item(); _ = Derived(); _ = Leaf(); _ = Cache() }",
    "fileprivate func generic<T: Shown>(_ value: T) {}",
    "fileprivate func measure(_ cache: Cache) -> Int { cache.total() }",
    "fileprivate func scale(_ item: Item) -> Int { item.twice() }",
  ];
  // Another file of the module sees only what is not private or fileprivate.
  const other = [
    "struct OutsiderOne: Hidden {}",
    "struct OutsiderTwo: Shown {}",
    "class OutsiderThree: Base {}",
    "func outsiderFour(_ item: Item) {}",
    "struct OutsiderFive: Open {}",
    "func outsiderSix(_ open: Open) {}",
    "class OutsiderSeven: Core {}",
    "func outsiderEight(_ cache: Cache) {}",
  ];
  const lineOf = (needle: string): number => types.findIndex((row) => row.includes(needle)) + 1;
  const sitesAt = (...lines: number[]): string[] => lines.map((line) => `Types.swift:${line}`);

  it("resolves a file-private type, never its extension header, and leaves other files without it", async () => {
    await withFixture(
      "cg-swift-private-ext-",
      { "Types.swift": types, "Other.swift": other },
      async (fixture, root) => {
        const here = (line: number, token: string, occurrence = 0) =>
          siteOf(fixture, "Types.swift", line, token, occurrence);
        const there = (line: number, token: string, occurrence = 0) =>
          siteOf(fixture, "Other.swift", line, token, occurrence);
        const hidden = here(lineOf("private protocol Hidden"), "Hidden");
        const shown = here(lineOf("fileprivate protocol Shown"), "Shown");
        const base = here(lineOf("private class Base"), "Base");
        const core = here(lineOf("fileprivate class Core"), "Core");
        const item = here(lineOf("fileprivate struct Item"), "Item");
        const cache = here(lineOf("private struct Cache"), "Cache");
        const open = here(lineOf("protocol Open"), "Open");
        const derived = here(lineOf("private final class Derived"), "Derived");
        const leaf = here(lineOf("fileprivate final class Leaf"), "Leaf");
        await eachIndexPass(root, async (index) => {
          // An extension header names the type it extends.
          await expectGoto(index, here(lineOf("extension Hidden"), "Hidden"), hidden);
          await expectGoto(index, here(lineOf("extension Shown"), "Shown"), shown);
          await expectGoto(index, here(lineOf("extension Base"), "Base"), base);
          await expectGoto(index, here(lineOf("extension Core"), "Core"), core);
          await expectGoto(index, here(lineOf("extension Item"), "Item"), item);
          await expectGoto(index, here(lineOf("extension Cache"), "Cache"), cache);
          // A conformance, an inheritance clause, an annotation, a constraint, and a construction name the type itself.
          const conformance = lineOf("private struct Conformer");
          await expectGoto(index, here(conformance, "Hidden"), hidden);
          await expectGoto(index, here(conformance, "Shown"), shown);
          await expectGoto(index, here(conformance, "Open"), open);
          await expectGoto(index, here(lineOf("private final class Derived"), "Base"), base);
          await expectGoto(index, here(lineOf("fileprivate final class Leaf"), "Core"), core);
          const holder = lineOf("private struct Holder");
          await expectGoto(index, here(holder, "Hidden"), hidden);
          await expectGoto(index, here(holder, "Shown"), shown);
          await expectGoto(index, here(holder, "Cache"), cache);
          const annotate = lineOf("fileprivate func annotate");
          await expectGoto(index, here(annotate, "Hidden"), hidden);
          await expectGoto(index, here(annotate, "Item"), item);
          await expectGoto(index, here(annotate, "Item", 1), item);
          const tally = lineOf("fileprivate func tally");
          await expectGoto(index, here(tally, "Cache"), cache);
          await expectGoto(index, here(tally, "Cache", 1), cache);
          const construct = lineOf("func construct");
          await expectGoto(index, here(construct, "Item"), item);
          await expectGoto(index, here(construct, "Derived"), derived);
          await expectGoto(index, here(construct, "Leaf"), leaf);
          await expectGoto(index, here(construct, "Cache"), cache);
          await expectGoto(index, here(lineOf("fileprivate func generic"), "Shown"), shown);
          // A call through a value of such a type reaches the method its extension declares.
          const measureRow = lineOf("fileprivate func measure");
          const scaleRow = lineOf("fileprivate func scale");
          await expectGoto(index, here(measureRow, "Cache"), cache);
          await expectGoto(index, here(scaleRow, "Item"), item);
          await expectGoto(index, here(measureRow, "total"), here(lineOf("func total"), "total"));
          await expectGoto(index, here(scaleRow, "twice"), here(lineOf("func twice"), "twice"));
          // Another file cannot name a private or fileprivate type, nor the extension header that spells it.
          await expectUnresolved(index, there(1, "Hidden"));
          await expectUnresolved(index, there(2, "Shown"));
          await expectUnresolved(index, there(3, "Base"));
          await expectUnresolved(index, there(4, "Item"));
          await expectUnresolved(index, there(7, "Core"));
          await expectUnresolved(index, there(8, "Cache"));
          await expectGoto(index, there(5, "Open"), open);
          await expectGoto(index, there(6, "Open"), open);
          expect(await referenceAnswer(index, hidden)).toEqual({
            sites: sitesAt(1, 2, 15, 18, 19),
            state: "complete",
            reasons: [],
          });
          expect(await referenceAnswer(index, shown)).toEqual({
            sites: sitesAt(3, 4, 15, 18, 22),
            state: "complete",
            reasons: [],
          });
          expect(await referenceAnswer(index, base)).toEqual({
            sites: sitesAt(5, 6, 16),
            state: "complete",
            reasons: [],
          });
          expect(await referenceAnswer(index, core)).toEqual({
            sites: sitesAt(7, 8, 17),
            state: "complete",
            reasons: [],
          });
          expect(await referenceAnswer(index, item)).toEqual({
            sites: sitesAt(9, 10, 19, 19, 21, 24),
            state: "complete",
            reasons: [],
          });
          expect(await referenceAnswer(index, cache)).toEqual({
            sites: sitesAt(11, 12, 18, 20, 20, 21, 23),
            state: "complete",
            reasons: [],
          });
          expect(await referenceAnswer(index, open)).toEqual({
            sites: ["Other.swift:5", "Other.swift:6", ...sitesAt(13, 14, 15)],
            state: "complete",
            reasons: [],
          });
          // The graph names the same declarations: a conformance, an inheritance clause, and a construction.
          const graph = await buildSymbolGraphDetailed(index);
          const file = fixture.paths["Types.swift"]!;
          await expectEdges(index, graph, file, "Conformer", "implements", [hidden, shown, open]);
          await expectEdges(index, graph, file, "Derived", "extends", [base]);
          await expectEdges(index, graph, file, "Leaf", "extends", [core]);
          await expectEdges(index, graph, file, "construct", "instantiates", [item, derived, leaf, cache]);
          await expectEdges(index, graph, file, "measure", "calls", [here(lineOf("func total"), "total")]);
          await expectEdges(index, graph, file, "scale", "calls", [here(lineOf("func twice"), "twice")]);
          const otherFile = fixture.paths["Other.swift"]!;
          await expectEdges(index, graph, otherFile, "OutsiderOne", "implements", []);
          await expectEdges(index, graph, otherFile, "OutsiderThree", "extends", []);
          await expectEdges(index, graph, otherFile, "OutsiderSeven", "extends", []);
          await expectEdges(index, graph, otherFile, "OutsiderFive", "implements", [open]);
        });
      },
    );
  });

  it("names the type an extension spells only when the project declares it", async () => {
    const rows = [
      "extension String { func escape() -> String { String(self) } }",
      "struct Mine { var value = 1 }",
      "extension Mine { func again() -> Mine { Mine() } }",
    ];
    await withFixture("cg-swift-extension-names-", { "Names.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string, occurrence = 0) =>
        siteOf(fixture, "Names.swift", line, token, occurrence);
      await eachIndexPass(root, async (index) => {
        // A type outside the project stays unresolved at the header and inside the extension, never the header.
        for (const occurrence of [0, 1, 2]) await expectUnresolved(index, at(1, "String", occurrence));
        // A declared type resolves to its declaration at the header and inside the extension.
        const mine = at(2, "Mine");
        for (const occurrence of [0, 1, 2]) await expectGoto(index, at(3, "Mine", occurrence), mine);
        const graph = await buildSymbolGraphDetailed(index);
        const file = fixture.paths["Names.swift"]!;
        await expectEdges(index, graph, file, "escape", "instantiates", []);
        await expectEdges(index, graph, file, "again", "instantiates", [mine]);
      });
    });
  });
});

describe("Swift unapplied member references", () => {
  const rows = [
    "struct Shape {",
    "  var side = 1",
    "  static var unit = 2",
    "  func area() -> Int { side }",
    "  static func square() -> Shape { Shape() }",
    "  var same = 1",
    "  func same(_ factor: Int) {}",
    "  static func twin() {}",
    "  var twin = 5",
    "}",
    "class Parent { var inherited = 1; func work() {}; class func build() {}; static var shared = 2 }",
    "class Child: Parent { var own = 1 }",
    "func references() {",
    "  _ = Shape.side",
    "  _ = Shape.unit",
    "  _ = Shape.area",
    "  _ = Shape.square",
    "  _ = Shape.same",
    "  _ = Shape.twin",
    "  _ = Parent.inherited",
    "  _ = Parent.work",
    "  _ = Parent.build",
    "  _ = Parent.shared",
    "  _ = Child.inherited",
    "  _ = Child.work",
    "  _ = Child.own",
    "}",
  ];
  // The 1-based line of the first row that contains `needle`, so rows can be added without renumbering the test.
  const lineOf = (needle: string): number => rows.findIndex((row) => row.includes(needle)) + 1;

  it("names a method or static member through its type, never an instance property", async () => {
    await withFixture("cg-swift-unapplied-", { "Unapplied.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string, occurrence = 0) =>
        siteOf(fixture, "Unapplied.swift", line, token, occurrence);
      const use = (member: string, type: string) => at(lineOf(`_ = ${type}.${member}`), member);
      await eachIndexPass(root, async (index) => {
        // A static member, a method, and an inherited method are nameable through the type.
        await expectGoto(index, use("unit", "Shape"), at(lineOf("static var unit"), "unit"));
        await expectGoto(index, use("area", "Shape"), at(lineOf("func area"), "area"));
        await expectGoto(index, use("square", "Shape"), at(lineOf("static func square"), "square"));
        await expectGoto(index, use("work", "Parent"), at(lineOf("func work"), "work"));
        await expectGoto(index, use("build", "Parent"), at(lineOf("class func build"), "build"));
        await expectGoto(index, use("shared", "Parent"), at(lineOf("static var shared"), "shared"));
        await expectGoto(index, use("work", "Child"), at(lineOf("func work"), "work"));
        // A method or static function wins over an instance property of the same spelling.
        await expectGoto(index, use("same", "Shape"), at(lineOf("func same"), "same"));
        await expectGoto(index, use("twin", "Shape"), at(lineOf("static func twin"), "twin"));
        // An instance property, declared or inherited, is not nameable through its type.
        await expectUnresolved(index, use("side", "Shape"));
        await expectUnresolved(index, use("inherited", "Parent"));
        await expectUnresolved(index, use("inherited", "Child"));
        await expectUnresolved(index, use("own", "Child"));
        expect((await referenceAnswer(index, at(lineOf("var side"), "side"))).sites).toEqual([
          `Unapplied.swift:${lineOf("var side")}`,
          `Unapplied.swift:${lineOf("func area")}`,
        ]);
      });
    });
  });
});

describe("Swift witnesses spelled differently from their requirements", () => {
  const rows = [
    "protocol Store {",
    "  associatedtype Item",
    "  func put(_ i: Item)",
    "}",
    "extension Store { func put(_ i: Item) {} }",
    "struct Mem: Store {",
    "  typealias Item = Int",
    "  func put(_ i: Int) {}",
    "  func put(name: String) {}",
    "}",
    "extension Mem {",
    "  func again() { self.put(1) }",
    "  func bare() { put(1) }",
    "}",
    "protocol Same { func same(as other: Self) }",
    "struct V: Same { func same(as other: V) {} }",
    "class Base<T> { func add(_ x: T) {} }",
    "class IntBase: Base<Int> { override func add(_ x: Int) {} }",
    "class More: IntBase { override func add(_ x: Int) {} }",
    "class Plain { func run(_ x: Int) {} }",
    "class Child: Plain { override func run(_ x: Int) {} }",
    "class MixBase<T> {",
    "  func mix(_ x: T) {}",
    "  func mix(_ x: String) {}",
    "}",
    "class IntMix: MixBase<Int> { override func mix(_ x: Int) {} }",
    "struct Box<T> {}",
    "protocol TupleStore {",
    "  associatedtype Item",
    "  func pack(_ value: (Item, Int))",
    "  func wrap(_ value: Box<(Item, Int)>)",
    "}",
    "struct GoodTupleMem: TupleStore {",
    "  typealias Item = String",
    "  func pack(_ value: (String, Int)) {}",
    "  func wrap(_ value: Box<(String, Int)>) {}",
    "}",
    "struct BadTupleMem: TupleStore {",
    "  typealias Item = String",
    "  func pack(_ value: (Int, Bool, Int)) {}",
    "  func wrap(_ value: Box<(Int, Bool, Int)>) {}",
    "}",
    "class Counter {",
    "  var count = 0",
    "  func count(of x: Int) -> Int { x }",
    "  func other() -> Int { 0 }",
    "  func read() -> Int { count(of: 1) + count + other() }",
    "}",
    'func useStore(_ m: Mem) { m.put(1); m.put(name: "a") }',
    "func useProtocol(_ s: Store) { s.put(1) }",
    "func useSame(_ v: V) { v.same(as: v) }",
    "func useAdd(_ i: IntBase) { i.add(1) }",
    "func useMore(_ m: More) { m.add(1) }",
    "func useChild(_ c: Child) { c.run(1) }",
    "func compete(_ m: IntMix) { m.mix(1) }",
    'func useGoodTuple(_ g: GoodTupleMem) { g.pack(("a", 2)); g.wrap(Box()) }',
    "func useBadTuple(_ b: BadTupleMem) { b.pack((1, 2)); b.wrap(Box()) }",
  ];
  const lineOf = (needle: string): number => {
    const line = rows.findIndex((row) => row.includes(needle));
    if (line < 0) throw new Error(`Missing row ${needle}`);
    return line + 1;
  };

  it("resolves the concrete member and keeps a different concrete overload unresolved", async () => {
    await withFixture("cg-swift-witness-", { "Witness.swift": rows }, async (fixture, root) => {
      const at = (line: number, token: string, occurrence = 0) =>
        siteOf(fixture, "Witness.swift", line, token, occurrence);
      const sites = (lines: readonly number[]): string[] =>
        [...lines].sort((left, right) => left - right).map((line) => `Witness.swift:${line}`);
      await eachIndexPass(root, async (index) => {
        const put = at(lineOf("func put(_ i: Int)"), "put");
        const named = at(lineOf("func put(name:"), "put");
        const requirement = at(lineOf("func put(_ i: Item)"), "put");
        const same = at(lineOf("func same(as other: V)"), "same");
        const intAdd = at(lineOf("class IntBase"), "add");
        const moreAdd = at(lineOf("class More"), "add");
        const childRun = at(lineOf("class Child"), "run");
        const countLine = lineOf("func count(of");
        const otherLine = lineOf("func other()");
        const readLine = lineOf("func read()");

        await expectGoto(index, at(lineOf("m.put(1)"), "put"), put);
        await expectGoto(index, at(lineOf("m.put(1)"), "put", 1), named);
        await expectGoto(index, at(lineOf("s.put(1)"), "put"), requirement);
        await expectGoto(index, at(lineOf("self.put(1)"), "put"), put);
        await expectGoto(index, at(lineOf("func bare()"), "put"), put);
        await expectGoto(index, at(lineOf("v.same"), "same"), same);
        await expectGoto(index, at(lineOf("i.add(1)"), "add"), intAdd);
        await expectGoto(index, at(lineOf("m.add(1)"), "add"), moreAdd);
        await expectGoto(index, at(lineOf("c.run(1)"), "run"), childRun);
        // `mix(_: T)` and `mix(_: String)` both accept the call by count and labels.
        await expectUnresolved(index, at(lineOf("m.mix(1)"), "mix"));
        await expectGoto(index, at(lineOf("g.pack("), "pack"), at(lineOf("func pack(_ value: (String, Int))"), "pack"));
        await expectGoto(
          index,
          at(lineOf("g.wrap("), "wrap"),
          at(lineOf("func wrap(_ value: Box<(String, Int)>)"), "wrap"),
        );
        await expectUnresolved(index, at(lineOf("b.pack("), "pack"));
        await expectUnresolved(index, at(lineOf("b.wrap("), "wrap"));
        // The `func` keyword is the method's header, not a use of the same-named property.
        await expectGoto(index, at(countLine, "func"), at(countLine, "count"));
        await expectGoto(index, at(otherLine, "func"), at(otherLine, "other"));
        await expectGoto(index, at(readLine, "count"), at(countLine, "count"));
        await expectGoto(index, at(readLine, "count", 1), at(lineOf("var count"), "count"));
        await expectGoto(index, at(readLine, "other"), at(otherLine, "other"));

        expect(await referenceAnswer(index, put)).toEqual({
          sites: sites([
            lineOf("func put(_ i: Int)"),
            lineOf("self.put(1)"),
            lineOf("func bare()"),
            lineOf("m.put(1)"),
          ]),
          state: "complete",
          reasons: [],
        });
        expect(await referenceAnswer(index, named)).toEqual({
          sites: sites([lineOf("func put(name:"), lineOf("m.put(1)")]),
          state: "complete",
          reasons: [],
        });
        const competeLine = `Witness.swift:${lineOf("m.mix(1)")}`;
        expect((await referenceAnswer(index, at(lineOf("override func mix"), "mix"))).sites).not.toContain(competeLine);
        expect((await referenceAnswer(index, at(lineOf("func mix(_ x: String)"), "mix"))).sites).not.toContain(
          competeLine,
        );

        const graph = await buildSymbolGraphDetailed(index);
        const file = fixture.paths["Witness.swift"]!;
        await expectCalls(index, graph, file, "useStore", [put, named]);
        await expectCalls(index, graph, file, "useProtocol", [requirement]);
        await expectCalls(index, graph, file, "useSame", [same]);
        await expectCalls(index, graph, file, "useAdd", [intAdd]);
        await expectCalls(index, graph, file, "useMore", [moreAdd]);
        await expectCalls(index, graph, file, "useChild", [childRun]);
        await expectCalls(index, graph, file, "again", [put]);
        await expectCalls(index, graph, file, "bare", [put]);
        await expectCalls(index, graph, file, "compete", []);
        await expectCalls(index, graph, file, "useGoodTuple", [
          at(lineOf("func pack(_ value: (String, Int))"), "pack"),
          at(lineOf("func wrap(_ value: Box<(String, Int)>)"), "wrap"),
        ]);
        await expectCalls(index, graph, file, "useBadTuple", []);
      });
    });
  });
});
