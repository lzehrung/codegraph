import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../src/index.js";
import { clearMemoryCache } from "../src/indexer/build-cache.js";
import { defNodeId } from "../src/graphs/symbol-graph.js";
import { columnOf, writeFixtureFiles } from "./languages/callable-consumer-fixtures.js";
import * as sharedOwnerIdentity from "../src/indexer/shared-owner-identity.js";
import { __setQuerySyntaxCacheLimitsForTests } from "../src/indexer/parsed-cache.js";

const models = [
  "protocol Relay {}",
  'extension Relay { func announce() -> String { "default" } }',
  "struct DefaultRelay: Relay {}",
  'struct OverrideRelay: Relay { func announce() -> String { "own" } }',
  "struct Labelled {",
  '  func send(to value: String) -> String { "to" }',
  '  func send(_ value: String) -> String { "unlabeled" }',
  '  func send(from value: String) -> String { "from" }',
  "}",
  'struct Other { func send(to value: String) -> String { "other" } }',
  "struct Outer { struct Inner { let nestedValue = 42 } }",
  "struct OtherOuter { struct Inner { let nestedValue = -1 } }",
  "struct LabelledLower { struct nested { let nestedValue = 5 } }",
  "struct DecoyLower { struct nested { let nestedValue = -1 } }",
];
const uses = [
  'func to(_ value: Labelled) -> String { value.send(to: "x") }',
  'func unlabeled(_ value: Labelled) -> String { value.send("x") }',
  'func from(_ value: Labelled) -> String { value.send(from: "x") }',
  "func viaDefault(_ value: DefaultRelay) -> String { value.announce() }",
  "func viaOwn(_ value: OverrideRelay) -> String { value.announce() }",
  "let defaultMethod = DefaultRelay.announce",
  "func nested() -> Int { let child = Outer.Inner(); return child.nestedValue }",
  "let typeValue = Outer.Inner.self",
  'func other(_ value: Other) -> String { value.send(to: "x") }',
  "func useLower() -> Int { let child = LabelledLower.nested(); return child.nestedValue }",
  "let lowerType = LabelledLower.nested.self",
];
const privacy = [
  'class GrandHit { func hit() -> String { "grand" } }',
  'class PrivateHit: GrandHit { private func hit(_ value: Int) -> String { "private" } }',
  "class PublicHit: PrivateHit { func run() -> String { hit() } }",
  "class Visibility {",
  '  private func secret() -> String { "private" }',
  '  fileprivate func local() -> String { "fileprivate" }',
  "  func inside() -> String { secret() }",
  "}",
  "extension Visibility { func sameFileExtension() -> String { secret() } }",
  "func sameFile(_ value: Visibility) -> String { value.local() }",
];

describe("Swift accuracy consumers", () => {
  it("keeps labels, nested owners, protocol defaults, and lexical privacy consistent after reopening the cache", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-accuracy-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "Types.swift": `${models.join("\n")}\n`,
        "Use.swift": `${uses.join("\n")}\n`,
        "Privacy.swift": `${privacy.join("\n")}\n`,
      });
      const linesByFile = { "Types.swift": models, "Use.swift": uses, "Privacy.swift": privacy };
      const site = (file: "Types.swift" | "Use.swift" | "Privacy.swift", line: number, token: string) => ({
        file: paths[file]!,
        line,
        column: columnOf(linesByFile[file], line, token),
      });
      const cases = [
        [site("Use.swift", 1, "send"), site("Types.swift", 6, "send")],
        [site("Use.swift", 2, "send"), site("Types.swift", 7, "send")],
        [site("Use.swift", 3, "send"), site("Types.swift", 8, "send")],
        [site("Use.swift", 9, "send"), site("Types.swift", 10, "send")],
        [site("Use.swift", 4, "announce"), site("Types.swift", 2, "announce")],
        [site("Use.swift", 5, "announce"), site("Types.swift", 4, "announce")],
        [site("Use.swift", 6, "announce"), site("Types.swift", 2, "announce")],
        [site("Use.swift", 7, "Inner"), site("Types.swift", 11, "Inner")],
        [site("Use.swift", 8, "Inner"), site("Types.swift", 11, "Inner")],
        [site("Use.swift", 7, "nestedValue"), site("Types.swift", 11, "nestedValue")],
        [site("Privacy.swift", 3, "hit"), site("Privacy.swift", 1, "hit")],
        [site("Privacy.swift", 7, "secret"), site("Privacy.swift", 5, "secret")],
        [site("Privacy.swift", 9, "secret"), site("Privacy.swift", 5, "secret")],
        [site("Privacy.swift", 10, "local"), site("Privacy.swift", 6, "local")],
        [site("Use.swift", 10, "nested"), site("Types.swift", 13, "nested")],
        [site("Use.swift", 11, "nested"), site("Types.swift", 13, "nested")],
        [site("Use.swift", 10, "nestedValue"), site("Types.swift", 13, "nestedValue")],
      ] as const;
      for (let pass = 0; pass < 2; pass += 1) {
        clearMemoryCache();
        const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
        for (const module of index.byFile.values()) {
          expect(module.nativeOutcome).toBe("used");
          expect(module.parseErrorRanges).toEqual([]);
        }
        for (const [use, expected] of cases) {
          const result = await goToDefinition(index, use);
          expect(result.status, `${use.file}:${use.line}`).toBe("ok");
          if (result.status !== "ok") continue;
          expect([
            result.definition.file,
            result.definition.range.start.line,
            result.definition.range.start.column,
          ]).toEqual([expected.file, expected.line, expected.column]);
        }
        for (const [declaration, expected] of [
          [site("Types.swift", 6, "send"), [site("Types.swift", 6, "send"), site("Use.swift", 1, "send")]],
          [site("Types.swift", 7, "send"), [site("Types.swift", 7, "send"), site("Use.swift", 2, "send")]],
          [site("Types.swift", 8, "send"), [site("Types.swift", 8, "send"), site("Use.swift", 3, "send")]],
          [
            site("Types.swift", 11, "nestedValue"),
            [site("Types.swift", 11, "nestedValue"), site("Use.swift", 7, "nestedValue")],
          ],
          [
            site("Types.swift", 13, "nested"),
            [site("Types.swift", 13, "nested"), site("Use.swift", 10, "nested"), site("Use.swift", 11, "nested")],
          ],
          [
            site("Types.swift", 13, "nestedValue"),
            [site("Types.swift", 13, "nestedValue"), site("Use.swift", 10, "nestedValue")],
          ],
          [
            site("Privacy.swift", 5, "secret"),
            [
              site("Privacy.swift", 5, "secret"),
              site("Privacy.swift", 7, "secret"),
              site("Privacy.swift", 9, "secret"),
            ],
          ],
        ] as const) {
          const result = await findReferences(index, declaration);
          expect(result.status).toBe("ok");
          if (result.status !== "ok") continue;
          expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
          const keys = (sites: readonly { file: string; line: number; column: number }[]) =>
            sites.map((entry) => `${entry.file}:${entry.line}:${entry.column}`).sort();
          expect(
            keys(
              result.references.map((ref) => ({
                file: ref.file,
                line: ref.range.start.line,
                column: ref.range.start.column,
              })),
            ),
          ).toEqual(keys(expected));
        }
        const graph = await buildSymbolGraphDetailed(index);
        for (const [caller, use, label] of [
          ["to", cases[0]![0], "calls"],
          ["unlabeled", cases[1]![0], "calls"],
          ["from", cases[2]![0], "calls"],
          ["viaDefault", cases[4]![0], "calls"],
          ["viaOwn", cases[5]![0], "calls"],
          ["nested", cases[7]![0], "instantiates"],
          ["useLower", cases[14]![0], "instantiates"],
        ] as const) {
          const resolved = await goToDefinition(index, use);
          if (resolved.status !== "ok") throw new Error(`Missing target for ${caller}`);
          const callerNode = [...graph.nodes.values()].find((node) => node.file === use.file && node.name === caller);
          expect(callerNode, caller).toBeDefined();
          expect(
            graph.edges.filter((edge) => edge.from === callerNode!.id && edge.label === label).map((edge) => edge.to),
          ).toContain(defNodeId(resolved.definition));
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift contextual enum cases", () => {
  it("uses declared types for shorthand cases without binding same-named cases on another enum", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-enum-context-"));
    const types = [
      "enum ColorMode { case warm; case cool }",
      "enum OtherMode { case warm; case cool }",
      'func consume(_ mode: ColorMode) -> String { mode == .warm ? "warm" : "cool" }',
    ];
    const source = [
      "func enumUses(_ mode: ColorMode) -> String {",
      "  let selected: ColorMode = .warm",
      "  let result = consume(.cool)",
      "  let comparison = mode == .warm",
      "  switch mode {",
      '  case .warm: return "\\(selected == .warm),\\(result),\\(comparison),switch-warm"',
      '  case .cool: return "switch-cool"',
      "  }",
      "}",
      "func decoy() -> OtherMode { let value: OtherMode = .warm; return value }",
      "let warmConstructor = ColorMode.warm",
    ];
    try {
      const paths = await writeFixtureFiles(root, {
        "EnumTypes.swift": `${types.join("\n")}\n`,
        "EnumUses.swift": `${source.join("\n")}\n`,
      });
      const site = (file: "EnumTypes.swift" | "EnumUses.swift", line: number, token: string, occurrence = 0) => {
        const row = file === "EnumTypes.swift" ? types[line - 1]! : source[line - 1]!;
        let index = -1;
        for (let count = 0; count <= occurrence; count += 1) index = row.indexOf(token, index + 1);
        if (index < 0) throw new Error(`Missing ${token} on line ${line}`);
        return { file: paths[file]!, line, column: index + 1 };
      };
      const warm = site("EnumTypes.swift", 1, "warm");
      const cool = site("EnumTypes.swift", 1, "cool");
      const warmUses = [
        site("EnumTypes.swift", 3, "warm"),
        site("EnumUses.swift", 2, "warm"),
        site("EnumUses.swift", 4, "warm"),
        site("EnumUses.swift", 6, "warm"),
        site("EnumUses.swift", 6, "warm", 1),
        site("EnumUses.swift", 11, "warm", 1),
      ];
      const coolUses = [site("EnumUses.swift", 3, "cool"), site("EnumUses.swift", 7, "cool")];
      for (let pass = 0; pass < 2; pass += 1) {
        clearMemoryCache();
        const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
        for (const module of index.byFile.values()) {
          expect(module.nativeOutcome).toBe("used");
          expect(module.parseErrorRanges).toEqual([]);
        }
        for (const [declaration, locations] of [
          [warm, warmUses],
          [cool, coolUses],
        ] as const) {
          for (const use of locations) {
            const result = await goToDefinition(index, use);
            expect(result.status, `${use.file}:${use.line}:${use.column}`).toBe("ok");
            if (result.status !== "ok") continue;
            expect([
              result.definition.file,
              result.definition.range.start.line,
              result.definition.range.start.column,
            ]).toEqual([declaration.file, declaration.line, declaration.column]);
          }
          const refs = await findReferences(index, declaration);
          expect(refs.status).toBe("ok");
          if (refs.status !== "ok") continue;
          expect(refs.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
          const key = (entry: { file: string; line: number; column: number }) =>
            `${entry.file}:${entry.line}:${entry.column}`;
          expect(
            refs.references
              .map((ref) => key({ file: ref.file, line: ref.range.start.line, column: ref.range.start.column }))
              .sort(),
          ).toEqual([declaration, ...locations].map(key).sort());
        }
        const other = await goToDefinition(index, site("EnumUses.swift", 10, "warm"));
        expect(other.status).toBe("ok");
        if (other.status === "ok") expect(other.definition.range.start.line).toBe(2);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift protocol requirements with defaults", () => {
  it("chooses the default witness for a conformer and the concrete method when it supplies one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-protocol-witness-"));
    const rows = [
      "protocol RequiredRelay { func announce() -> String }",
      'extension RequiredRelay { func announce() -> String { "requirement-default" } }',
      "struct UsesRequirement: RequiredRelay {}",
      'struct OverridesRequirement: RequiredRelay { func announce() -> String { "requirement-own" } }',
      "func usesDefault(_ value: UsesRequirement) -> String { value.announce() }",
      "func usesOwn(_ value: OverridesRequirement) -> String { value.announce() }",
      "func usesProtocol(_ value: RequiredRelay) -> String { value.announce() }",
    ];
    try {
      const paths = await writeFixtureFiles(root, { "Requirement.swift": `${rows.join("\n")}\n` });
      const file = paths["Requirement.swift"]!;
      const site = (line: number) => ({ file, line, column: columnOf(rows, line, "announce") });
      for (let pass = 0; pass < 2; pass += 1) {
        clearMemoryCache();
        const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
        for (const [use, declaration, caller] of [
          [5, 2, "usesDefault"],
          [6, 4, "usesOwn"],
          [7, 1, "usesProtocol"],
        ] as const) {
          const result = await goToDefinition(index, site(use));
          expect(result.status).toBe("ok");
          if (result.status !== "ok") continue;
          expect(result.definition.range.start.line).toBe(declaration);
          const refs = await findReferences(index, site(declaration));
          expect(refs.status).toBe("ok");
          if (refs.status !== "ok") continue;
          expect(refs.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
          expect(refs.references.map((ref) => ref.range.start.line)).toEqual([declaration, use]);
          const graph = await buildSymbolGraphDetailed(index);
          const from = [...graph.nodes.values()].find((node) => node.file === file && node.name === caller);
          expect(from).toBeDefined();
          expect(
            graph.edges.filter((edge) => edge.from === from!.id && edge.label === "calls").map((edge) => edge.to),
          ).toEqual([defNodeId(result.definition)]);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift free function overloads", () => {
  it("selects labels across files and local overload scopes without ranking argument types", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-free-overloads-"));
    const types = [
      'func dispatch(to value: String) -> String { "to" }',
      'func dispatch(_ value: String) -> String { "unlabeled" }',
      'func dispatch(from value: String) -> String { "from" }',
      'func pick(_ value: Int) -> String { "int" }',
      'func pick(_ value: String) -> String { "string" }',
      'struct Decoy { func dispatch(to value: String) -> String { "member" } }',
    ];
    const calls = [
      'func callTo() -> String { dispatch(to: "x") }',
      'func callPlain() -> String { dispatch("x") }',
      'func callFrom() -> String { dispatch(from: "x") }',
      "func callPick(_ value: Int) -> String { pick(value) }",
      "func localCall() -> String {",
      '  func dispatch(to value: String) -> String { "local-to" }',
      '  func dispatch(_ value: String) -> String { "local-plain" }',
      '  let first = dispatch(to: "x")',
      '  let second = dispatch("x")',
      '  return first + "," + second',
      "}",
    ];
    try {
      const paths = await writeFixtureFiles(root, {
        "FreeTypes.swift": `${types.join("\n")}\n`,
        "FreeUse.swift": `${calls.join("\n")}\n`,
      });
      const site = (file: "FreeTypes.swift" | "FreeUse.swift", line: number, token: string, last = false) => {
        const row = (file === "FreeTypes.swift" ? types : calls)[line - 1]!;
        return { file: paths[file]!, line, column: (last ? row.lastIndexOf(token) : row.indexOf(token)) + 1 };
      };
      const cases = [
        [site("FreeUse.swift", 1, "dispatch"), site("FreeTypes.swift", 1, "dispatch")],
        [site("FreeUse.swift", 2, "dispatch"), site("FreeTypes.swift", 2, "dispatch")],
        [site("FreeUse.swift", 3, "dispatch"), site("FreeTypes.swift", 3, "dispatch")],
        [site("FreeUse.swift", 8, "dispatch"), site("FreeUse.swift", 6, "dispatch")],
        [site("FreeUse.swift", 9, "dispatch"), site("FreeUse.swift", 7, "dispatch")],
      ] as const;
      for (let pass = 0; pass < 2; pass += 1) {
        clearMemoryCache();
        const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
        const graph = await buildSymbolGraphDetailed(index);
        for (const [use, declaration] of cases) {
          const result = await goToDefinition(index, use);
          expect(result.status, `${use.line}:${use.column}`).toBe("ok");
          if (result.status !== "ok") continue;
          expect([
            result.definition.file,
            result.definition.range.start.line,
            result.definition.range.start.column,
          ]).toEqual([declaration.file, declaration.line, declaration.column]);
          const refs = await findReferences(index, declaration);
          expect(refs.status).toBe("ok");
          if (refs.status !== "ok") continue;
          expect(refs.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
          expect(
            refs.references.map((ref) => `${ref.file}:${ref.range.start.line}:${ref.range.start.column}`).sort(),
          ).toEqual([declaration, use].map((entry) => `${entry.file}:${entry.line}:${entry.column}`).sort());
          const caller = use.line >= 8 ? "localCall" : ["callTo", "callPlain", "callFrom"][use.line - 1];
          const from = [...graph.nodes.values()].find((node) => node.file === use.file && node.name === caller);
          expect(from).toBeDefined();
          expect(
            graph.edges.some(
              (edge) => edge.from === from!.id && edge.label === "calls" && edge.to === defNodeId(result.definition),
            ),
            `${use.line}:${use.column}`,
          ).toBe(true);
        }
        const ambiguous = await goToDefinition(index, site("FreeUse.swift", 4, "pick"));
        expect(ambiguous.status).toBe("not_found");
        const refs = await findReferences(index, site("FreeTypes.swift", 4, "pick"));
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          expect(refs.referenceCoverage.state).toBe("partial");
          expect(refs.referenceCoverage.reasons).toContain("strategy_unavailable");
          expect(refs.referenceCoverage.affectedFiles).toContain(paths["FreeUse.swift"]);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift uncertain enum contexts", () => {
  it("does not infer the right operand from an overloaded equality operator", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-enum-operator-"));
    const rows = [
      "enum Left { case warm }",
      "enum Right { case warm }",
      "func == (lhs: Left, rhs: Right) -> Bool { true }",
      "func compare(_ lhs: Left) -> Bool { lhs == .warm }",
    ];
    try {
      const paths = await writeFixtureFiles(root, { "Operator.swift": `${rows.join("\n")}\n` });
      const file = paths["Operator.swift"]!;
      const site = (line: number) => ({ file, line, column: columnOf(rows, line, "warm") });
      const index = await buildProjectIndex(root, { cache: "off" });
      expect((await goToDefinition(index, site(4))).status).toBe("not_found");
      for (const line of [1, 2]) {
        const refs = await findReferences(index, site(line));
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") continue;
        expect(refs.referenceCoverage.state).toBe("partial");
        expect(refs.referenceCoverage.reasons).toContain("strategy_unavailable");
        expect(refs.referenceCoverage.affectedFiles).toContain(file);
        expect(refs.references.map((ref) => ref.range.start.line)).toEqual([line]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift cross-file hidden methods", () => {
  it("excludes private and fileprivate members from another file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-private-files-"));
    const crossFile = [
      "func outsidePrivate(_ value: Visibility) -> String { value.secret() }",
      "func outsideFileprivate(_ value: Visibility) -> String { value.local() }",
    ];
    try {
      const paths = await writeFixtureFiles(root, {
        "Privacy.swift": `${privacy.join("\n")}\n`,
        "CrossFilePrivate.swift": `${crossFile.join("\n")}\n`,
      });
      for (let pass = 0; pass < 2; pass += 1) {
        clearMemoryCache();
        const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
        for (const [line, name, definitionLine, expectedLines] of [
          [1, "secret", 5, [5, 7, 9]],
          [2, "local", 6, [6, 10]],
        ] as const) {
          const use = { file: paths["CrossFilePrivate.swift"]!, line, column: columnOf(crossFile, line, name) };
          expect((await goToDefinition(index, use)).status).toBe("not_found");
          const refs = await findReferences(index, {
            file: paths["Privacy.swift"]!,
            line: definitionLine,
            column: columnOf(privacy, definitionLine, name),
          });
          expect(refs.status).toBe("ok");
          if (refs.status !== "ok") continue;
          expect(refs.references.map((ref) => ref.range.start.line).sort((a, b) => a - b)).toEqual(expectedLines);
          expect(refs.references.every((ref) => ref.file === paths["Privacy.swift"])).toBe(true);
          expect(refs.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift module-qualified construction", () => {
  it("preserves construction edges through a module alias without selecting a same-named type", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-module-construction-"));
    const lines = [
      "import Utils",
      "func make() -> Utils.UtilityStruct {",
      "  return Utils.UtilityStruct(value: 1)",
      "}",
    ];
    try {
      const paths = await writeFixtureFiles(root, {
        "Utils.swift":
          "public struct UtilityStruct { public let value: Int; public init(value: Int) { self.value = value } }\n",
        "Other.swift":
          "public struct UtilityStruct { public let value: Int; public init(value: Int) { self.value = -value } }\n",
        "Use.swift": `${lines.join("\n")}\n`,
      });
      for (let pass = 0; pass < 2; pass += 1) {
        clearMemoryCache();
        const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
        const use = { file: paths["Use.swift"]!, line: 3, column: columnOf(lines, 3, "UtilityStruct") };
        const target = await goToDefinition(index, use);
        expect(target.status).toBe("ok");
        if (target.status !== "ok") continue;
        expect(target.definition.file).toBe(paths["Utils.swift"]);
        const graph = await buildSymbolGraphDetailed(index);
        const caller = [...graph.nodes.values()].find((node) => node.file === use.file && node.name === "make");
        expect(caller).toBeDefined();
        expect(
          graph.edges
            .filter((edge) => edge.from === caller!.id && edge.label === "instantiates")
            .map((edge) => edge.to),
        ).toEqual([defNodeId(target.definition)]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift ambiguous extension overloads", () => {
  it("reports partial references when labels do not distinguish inherited choices", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-ambiguous-extension-"));
    const model = [
      "struct AmbiguousBox {",
      '  func choose(_ value: Int) -> String { "integer" }',
      '  func choose(_ value: String) -> String { "string" }',
      "}",
    ];
    const extension = ["extension AmbiguousBox {", "  func run(_ value: Int) -> String { choose(value) }", "}"];
    try {
      const paths = await writeFixtureFiles(root, {
        "AmbiguousModel.swift": `${model.join("\n")}\n`,
        "AmbiguousExtension.swift": `${extension.join("\n")}\n`,
      });
      for (let pass = 0; pass < 2; pass += 1) {
        clearMemoryCache();
        const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
        const use = { file: paths["AmbiguousExtension.swift"]!, line: 2, column: columnOf(extension, 2, "choose") };
        expect((await goToDefinition(index, use)).status).toBe("not_found");
        for (const line of [2, 3]) {
          const refs = await findReferences(index, {
            file: paths["AmbiguousModel.swift"]!,
            line,
            column: columnOf(model, line, "choose"),
          });
          expect(refs.status).toBe("ok");
          if (refs.status !== "ok") continue;
          expect(refs.referenceCoverage.state).toBe("partial");
          expect(refs.referenceCoverage.reasons).toContain("strategy_unavailable");
          expect(refs.referenceCoverage.affectedFiles).toContain(paths["AmbiguousExtension.swift"]);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift compilation-unit callable cache", () => {
  it("keeps peer overloads and decoys correct after rebuilding the same files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-unit-candidates-"));
    const definitions = (label: string): string[] => [
      `func dispatch(${label} value: Int) -> Int { value }`,
      `struct Decoy { func dispatch(${label} value: Int) -> Int { -value } }`,
    ];
    const usage = (label: string): string[] => [`func use() -> Int { dispatch(${label}: 1) }`];
    try {
      const paths = await writeFixtureFiles(root, {
        "Api.swift": `${definitions("to").join("\n")}\n`,
        "Use.swift": `${usage("to").join("\n")}\n`,
      });
      for (const label of ["to", "from"]) {
        if (label === "from") {
          await writeFile(paths["Api.swift"]!, `${definitions(label).join("\n")}\n`);
          await writeFile(paths["Use.swift"]!, `${usage(label).join("\n")}\n`);
        }
        for (let pass = 0; pass < 2; pass += 1) {
          clearMemoryCache();
          const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
          const declaration = {
            file: paths["Api.swift"]!,
            line: 1,
            column: columnOf(definitions(label), 1, "dispatch"),
          };
          const use = { file: paths["Use.swift"]!, line: 1, column: columnOf(usage(label), 1, "dispatch") };
          const target = await goToDefinition(index, use);
          expect(target.status).toBe("ok");
          if (target.status !== "ok") throw new Error(`Missing ${label} peer overload`);
          expect([target.definition.file, target.definition.range.start.line]).toEqual([declaration.file, 1]);
          const references = await findReferences(index, declaration);
          expect(references.status).toBe("ok");
          if (references.status !== "ok") throw new Error(`Missing ${label} peer references`);
          expect(references.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
          expect(references.references.map((reference) => [reference.file, reference.range.start.line])).toEqual([
            [declaration.file, 1],
            [use.file, 1],
          ]);
          const graph = await buildSymbolGraphDetailed(index);
          const caller = [...graph.nodes.values()].find((node) => node.file === use.file && node.name === "use");
          expect(caller).toBeDefined();
          expect(
            graph.edges.filter((edge) => edge.from === caller!.id && edge.label === "calls").map((edge) => edge.to),
          ).toEqual([defNodeId(target.definition)]);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift shared-owner fact cache", () => {
  it("reuses owner facts across calls and rebuilds them for evicted trees and changed indexes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-owner-facts-"));
    const useLines = ["func use(_ box: Box) { box.deliver() }"];
    const extensionLines = (owner: string): string[] => [`extension ${owner} { func deliver() {} }`];
    const identity = vi.spyOn(sharedOwnerIdentity, "getSharedOwnerIdentity");
    try {
      const paths = await writeFixtureFiles(root, {
        "Types.swift": "struct Box {}\nstruct Other {}\n",
        "Extension.swift": `${extensionLines("Box").join("\n")}\n`,
        "Use.swift": `${useLines.join("\n")}\n`,
      });
      for (const owner of ["Box", "Other"]) {
        if (owner === "Other") {
          await writeFile(paths["Extension.swift"]!, `${extensionLines(owner).join("\n")}\n`);
        }
        clearMemoryCache();
        const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
        const use = { file: paths["Use.swift"]!, line: 1, column: columnOf(useLines, 1, "deliver") };
        const declaration = {
          file: paths["Extension.swift"]!,
          line: 1,
          column: columnOf(extensionLines(owner), 1, "deliver"),
        };
        const expectedStatus = owner === "Box" ? "ok" : "not_found";
        const first = await goToDefinition(index, use);
        expect(first.status).toBe(expectedStatus);
        if (first.status === "ok") {
          expect([first.definition.file, first.definition.range.start.column]).toEqual([
            declaration.file,
            declaration.column,
          ]);
        }
        const ownerReads = identity.mock.calls.length;
        for (let repeat = 0; repeat < 3; repeat += 1) {
          expect(await goToDefinition(index, use)).toEqual(first);
        }
        expect(identity).toHaveBeenCalledTimes(ownerReads);

        const refs = await findReferences(index, declaration);
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") throw new Error("Missing extension references");
        expect(refs.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
        const expectedFiles = owner === "Box" ? [declaration.file, use.file] : [declaration.file];
        expect(refs.references.map((ref) => ref.file)).toEqual(expectedFiles);
        const graph = await buildSymbolGraphDetailed(index);
        const caller = [...graph.nodes.values()].find((node) => node.file === use.file && node.name === "use");
        expect(caller).toBeDefined();
        const targets = graph.edges
          .filter((edge) => edge.from === caller!.id && edge.label === "calls")
          .map((edge) => edge.to);
        expect(targets).toEqual(first.status === "ok" ? [defNodeId(first.definition)] : []);

        __setQuerySyntaxCacheLimitsForTests(index, { liveBytes: 0, compactBytes: 0 });
        expect(await goToDefinition(index, use)).toEqual(first);
        expect(await findReferences(index, declaration)).toEqual(refs);
        expect(await buildSymbolGraphDetailed(index)).toEqual(graph);
      }
    } finally {
      identity.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
