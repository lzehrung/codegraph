import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregateReports,
  firstWrongAnswers,
  mulberry32,
  renderReport,
  sampleCandidates,
  scoreDefinition,
  scoreEdges,
  scoreReferences,
  summarizeResults,
  validateManifest,
} from "../scripts/accuracy/accuracy-lib.mjs";

type Location = { file: string; line: number; column: number };
type Site = Location & { name: string; form: string; definitions: Location[]; external: boolean };
type OracleResponse = {
  schemaVersion: number;
  language: string;
  oracle: { name: string; version: string };
  sites: Site[];
  declarations: Array<
    Location & { name: string; kind: string; references: Location[]; relatedDeclarations?: Location[] }
  >;
  diagnostics: { files: number; unresolvedSites: number; errors: string[] };
};
const target: Location = { file: "lib.ts", line: 3, column: 17 };
const use: Location = { file: "main.ts", line: 10, column: 5 };
const site: Site = { ...use, name: "run", form: "bare-call", definitions: [target], external: false };
const declaration = { ...target, name: "run", kind: "function", references: [use] };
const manifest = [
  { id: "example", language: "typescript", url: "https://github.com/example/library.git", commit: "a".repeat(40) },
];

describe("real-code accuracy benchmark pure logic", () => {
  it("matches the specified mulberry32 seed-1 sequence", () => {
    const random = mulberry32(1);
    expect(Array.from({ length: 5 }, random)).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849,
    ]);
  });

  it("sorts before seeded Fisher-Yates sampling without mutating candidates", () => {
    const candidates = ["e", "c", "a", "d", "b"].map((file) => ({ file, line: 1, column: 1 }));
    expect(sampleCandidates(candidates, 1, 5).map((candidate) => candidate.file)).toEqual(["e", "c", "b", "a", "d"]);
    expect(sampleCandidates([...candidates].reverse(), 1, 3)).toEqual(sampleCandidates(candidates, 1, 3));
    expect(candidates.map((candidate) => candidate.file)).toEqual(["e", "c", "a", "d", "b"]);
    expect(sampleCandidates(candidates, 1, 0)).toEqual([]);
    const positions = [
      { file: "a", line: 2, column: 1 },
      { file: "a", line: 1, column: 2 },
      { file: "a", line: 1, column: 1 },
    ];
    expect(sampleCandidates(positions, 1, 3)).toEqual(sampleCandidates([...positions].reverse(), 1, 3));
  });

  it("separates correct, wrong, missed, external-ok, and unresolved sites", () => {
    expect(scoreDefinition(site, { status: "ok", definition: target })).toBe("correct");
    expect(scoreDefinition(site, { status: "ok", definition: { ...target, column: 1 } })).toBe("correct");
    expect(scoreDefinition(site, { status: "ok", definition: { ...target, file: "decoy.ts" } })).toBe("wrong");
    expect(scoreDefinition(site, { status: "not_found" })).toBe("missed");
    expect(scoreDefinition(site, { status: "ambiguous" })).toBe("missed");
    const external = { ...site, definitions: [], external: true };
    expect(scoreDefinition(external, { status: "not_found" })).toBe("external-ok");
    expect(scoreDefinition(external, { status: "ok", definition: target })).toBe("wrong");
    expect(scoreDefinition({ ...site, definitions: [] }, { status: "ok", definition: target })).toBe("excluded");
  });

  it("accepts a match to any oracle overload or merged declaration", () => {
    const overloaded = { ...site, definitions: [{ ...target, line: 2 }, target] };
    expect(scoreDefinition(overloaded, { status: "ok", definition: target })).toBe("correct");
    expect(scoreDefinition(overloaded, { status: "ok", definition: { ...target, line: 4 } })).toBe("wrong");
  });

  it("scores exact reference precision, recall, and complete-coverage overclaims", () => {
    const secondUse = { ...use, line: 11 };
    const extra = { ...use, line: 12 };
    const result = scoreReferences(
      { ...declaration, references: [use, secondUse] },
      {
        status: "ok",
        references: [use, use, target, extra],
        coverage: "complete",
      },
    );
    expect(result).toMatchObject({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 1,
      expected: 2,
      reported: 2,
      precision: 0.5,
      recall: 0.5,
      overclaim: true,
    });
    expect(scoreReferences(declaration, { status: "ok", references: [], coverage: "partial" }).overclaim).toBe(false);
    expect(scoreReferences(declaration, { status: "not_found" })).toMatchObject({
      precision: 1,
      recall: 0,
      overclaim: false,
    });
    expect(scoreReferences({ ...declaration, references: [] }, { status: "ok", references: [] })).toMatchObject({
      precision: 1,
      recall: 1,
    });
    expect(scoreReferences(declaration, { status: "ok", references: [{ ...use, column: 6 }] }).truePositives).toBe(0);
  });

  it("excludes related declaration tokens from both reference sets without hiding real uses", () => {
    const related = { ...target, line: 4 };
    const unrelated = { ...use, line: 12 };
    const family = { ...declaration, references: [target, related, use], relatedDeclarations: [related] };
    expect(
      scoreReferences(family, {
        status: "ok",
        references: [target, related, use, unrelated],
        coverage: "complete",
      }),
    ).toMatchObject({
      expected: 1,
      reported: 2,
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 0,
      precision: 0.5,
      recall: 1,
      overclaim: false,
    });
    expect(
      scoreReferences(family, {
        status: "ok",
        references: [related],
        coverage: "complete",
      }),
    ).toMatchObject({
      expected: 1,
      reported: 0,
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 1,
      precision: 1,
      recall: 0,
      overclaim: true,
    });
  });

  it("scores call targets and enclosing owners without hiding wrong extra edges", () => {
    const edge = { from: "caller", to: target, label: "calls", site: use };
    expect(scoreEdges(site, [edge], "caller")).toBe("edge-correct");
    expect(scoreEdges({ ...site, definitions: [{ ...target, line: 2 }, target] }, [edge], "caller")).toBe(
      "edge-correct",
    );
    expect(scoreEdges(site, [], "caller")).toBe("edge-missed");
    expect(scoreEdges(site, [{ ...edge, to: { ...target, file: "decoy.ts" } }], "caller")).toBe("edge-wrong");
    expect(scoreEdges(site, [edge, { ...edge, from: "wrong-caller" }], "caller")).toBe("edge-wrong");
    expect(scoreEdges({ ...site, form: "constructor" }, [{ ...edge, label: "instantiates" }], "caller")).toBe(
      "edge-correct",
    );
    expect(scoreEdges({ ...site, definitions: [], external: true }, [], "caller")).toBe("edge-external-ok");
    expect(scoreEdges({ ...site, definitions: [], external: true }, [edge], "caller")).toBe("edge-wrong");
    expect(scoreEdges({ ...site, form: "type-reference" }, [], "caller")).toBe("excluded-form");
    expect(scoreEdges({ ...site, definitions: [] }, [], "caller")).toBe("excluded-unresolved");
    expect(scoreEdges(site, [], null)).toBe("excluded-enclosing");
  });

  it("rejects incomplete pins, unknown languages, duplicate ids and malformed globs", () => {
    expect(validateManifest(manifest)).toEqual(manifest);
    expect(() => validateManifest([{ ...manifest[0], commit: undefined }])).toThrow("40-character commit");
    expect(() => validateManifest([{ ...manifest[0], commit: "main" }])).toThrow("40-character commit");
    expect(() => validateManifest([{ ...manifest[0], language: "python" }])).toThrow("Unknown corpus language");
    expect(() => validateManifest([...manifest, ...manifest])).toThrow("Duplicate corpus id");
    expect(() => validateManifest([{ ...manifest[0], include: [""] }])).toThrow("nonempty globs");
  });

  it("renders language/repository/form rates and the first 20 wrong answers", () => {
    const sites = Array.from({ length: 23 }, (_, index) => ({
      site: { ...site, line: 40 - index },
      answer: { status: "ok", definition: { ...target, file: "decoy.ts" } },
      definition: "wrong",
      edge: "edge-missed",
    }));
    const declarations = [
      { declaration, score: scoreReferences(declaration, { status: "ok", references: [], coverage: "complete" }) },
    ];
    const report = {
      repository: manifest[0],
      request: { seed: 1, maxSites: 400, maxDeclarations: 80 },
      sites,
      declarations,
      oracle: {
        oracle: { name: "test-oracle", version: "1" },
        diagnostics: { files: 3, unresolvedSites: 0, errors: [] },
      },
      summary: summarizeResults(sites, declarations),
      runtimeMs: 1200,
      timings: { queries: 1000 },
    };
    expect(report.summary.totals).toMatchObject({ scored: 23, wrong: 23, wrongRate: 1, missedRate: 0, overclaims: 1 });
    expect(aggregateReports([report]).byLanguage.typescript.totals.wrong).toBe(23);
    expect(firstWrongAnswers(report)).toHaveLength(20);
    expect(firstWrongAnswers(report)[0].site.line).toBe(18);
    const rendered = renderReport([report]);
    expect(rendered).toContain("| typescript | 23 |");
    expect(rendered).toContain("| bare-call | 23 |");
    expect(rendered).toContain("main.ts:18:5");
    expect(rendered).not.toContain("main.ts:40:5");
    expect(rendered).toContain("Runtime: 1.20s");
  });

  it("renders unavailable reference metrics only in syntax-form rows", () => {
    const sites = [{ site, answer: { status: "not_found" }, definition: "missed", edge: "edge-missed" }];
    const declarations = [
      { declaration, score: scoreReferences(declaration, { status: "ok", references: [], coverage: "complete" }) },
    ];
    const report = {
      repository: manifest[0],
      request: { seed: 1, maxSites: 400, maxDeclarations: 80 },
      sites,
      declarations,
      oracle: {
        oracle: { name: "test-oracle", version: "1" },
        diagnostics: { files: 3, unresolvedSites: 0, errors: [] },
      },
      summary: summarizeResults(sites, declarations),
      runtimeMs: 1200,
      timings: { queries: 1000 },
    };
    const rendered = renderReport([report]);
    const rows = rendered.split("\n").filter((line) => line.startsWith("| "));
    const formRows = rows.filter((line) => line.includes("| n/a | n/a |"));
    expect(formRows).toHaveLength(21);
    expect(formRows.filter((line) => line.startsWith("| bare-call |"))).toHaveLength(3);
    for (const formRow of formRows) {
      const columns = formRow.split("|").map((column) => column.trim());
      expect(columns.slice(11, 13)).toEqual(["n/a", "n/a"]);
    }
    for (const scope of ["all", "typescript", "example"]) {
      const row = rows.find((line) => line.startsWith(`| ${scope} |`));
      expect(
        row
          ?.split("|")
          .map((column) => column.trim())
          .slice(11, 13),
      ).toEqual(["100.0% / 0.0%", "1"]);
    }
    expect(rendered).not.toContain("parser-degraded indexed files");
  });
});

describe("TypeScript oracle protocol", () => {
  it("accepts constructed classes and explicit constructors but rejects same-shaped decoys", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-accuracy-constructors-"));
    try {
      const sources = {
        "lib.ts": [
          "export class C {",
          "  constructor() {}",
          "}",
          "export namespace C { export const marker = 1; }",
          "export class Implicit {}",
          "export class Box<T> {",
          "  constructor(value?: T) {}",
          "}",
          "export namespace NS {",
          "  export class C {",
          "    constructor() {}",
          "  }",
          "  export class D {}",
          "}",
          "export class Impl {}",
        ].join("\n"),
        "decoy.ts": ["export class C {", "  constructor() {}", "}", "export class Implicit {}"].join("\n"),
        "main.ts": [
          'import { C, Implicit, Box, NS, Impl } from "./lib";',
          'import * as classes from "./lib";',
          "new C();",
          "new Implicit();",
          "new classes.C();",
          "new Map();",
          "new Box<number>();",
          "new classes.Box<string>(1);",
          "new NS.C();",
          "new classes.NS.D();",
          "const K = class { constructor() {} };",
          "const K2 = class Named {};",
          "new K();",
          "new K2();",
          "function mk(Ctor: new () => Impl) { return new Ctor(); }",
          "const o = { C: Box };",
          "new o.C();",
          "new (Box as any)();",
          "new (classes.Box)();",
          "declare const dyn: any;",
          "new dyn();",
          "new dyn.X();",
        ].join("\n"),
      };
      for (const [file, source] of Object.entries(sources)) fs.writeFileSync(path.join(root, file), source);
      const requestPath = path.join(root, "request.json");
      const outputPath = path.join(root, "response.json");
      fs.writeFileSync(
        requestPath,
        JSON.stringify({
          schemaVersion: 1,
          language: "typescript",
          files: Object.keys(sources),
          seed: 1,
          maxSites: 100,
          maxDeclarations: 0,
        }),
      );
      const oraclePath = fileURLToPath(new URL("../scripts/accuracy/oracles/typescript/oracle.mjs", import.meta.url));
      const child = spawnSync(
        process.execPath,
        [oraclePath, "--root", root, "--request", requestPath, "--output", outputPath],
        { windowsHide: true, encoding: "utf8", timeout: 30_000 },
      );
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const response = JSON.parse(fs.readFileSync(outputPath, "utf8")) as OracleResponse;
      expect(response.diagnostics.errors).toEqual([]);
      const constructors = response.sites.filter((entry) => entry.form === "constructor");
      expect(constructors).toHaveLength(14);
      for (const entry of constructors.filter((candidate) => candidate.name === "C" && candidate.line <= 5)) {
        const accepted = [
          { file: "lib.ts", line: 1, column: 14 },
          { file: "lib.ts", line: 2, column: 3 },
          { file: "lib.ts", line: 4, column: 18 },
        ];
        expect(entry.definitions).toEqual(accepted);
        expect(entry.external).toBe(false);
        for (const definition of accepted) {
          expect(scoreDefinition(entry, { status: "ok", definition })).toBe("correct");
          expect(
            scoreEdges(entry, [{ from: "caller", to: definition, label: "instantiates", site: entry }], "caller"),
          ).toBe("edge-correct");
        }
        for (const line of [1, 2]) {
          const decoy = { file: "decoy.ts", line, column: 1 };
          expect(scoreDefinition(entry, { status: "ok", definition: decoy })).toBe("wrong");
          expect(scoreEdges(entry, [{ from: "caller", to: decoy, label: "instantiates", site: entry }], "caller")).toBe(
            "edge-wrong",
          );
        }
      }
      const implicit = constructors.find((entry) => entry.name === "Implicit")!;
      const definition = { file: "lib.ts", line: 5, column: 14 };
      expect(implicit.definitions).toEqual([definition]);
      expect(scoreDefinition(implicit, { status: "ok", definition })).toBe("correct");
      expect(scoreDefinition(implicit, { status: "ok", definition: { ...definition, file: "decoy.ts" } })).toBe(
        "wrong",
      );
      expect(constructors.find((entry) => entry.name === "Map")).toMatchObject({
        definitions: [],
        external: true,
      });
      const at = (line: number, name: string): Site => {
        const entry = response.sites.find(
          (candidate) => candidate.file === "main.ts" && candidate.line === line && candidate.name === name,
        );
        expect(entry, `missing main.ts:${line} ${name}`).toBeDefined();
        return entry!;
      };
      for (const line of [7, 8]) {
        expect(at(line, "Box")).toMatchObject({
          form: "constructor",
          definitions: [
            { file: "lib.ts", line: 6, column: 14 },
            { file: "lib.ts", line: 7, column: 3 },
          ],
          external: false,
        });
      }
      expect(at(9, "C")).toMatchObject({
        form: "constructor",
        definitions: [
          { file: "lib.ts", line: 10, column: 16 },
          { file: "lib.ts", line: 11, column: 5 },
        ],
      });
      expect(at(10, "D")).toMatchObject({
        form: "constructor",
        definitions: [{ file: "lib.ts", line: 13, column: 16 }],
      });
      for (const [line, name] of [
        [8, "classes"],
        [9, "NS"],
        [10, "classes"],
        [10, "NS"],
      ] as const) {
        expect(at(line, name).form).not.toBe("constructor");
      }
      expect(at(13, "K")).toMatchObject({
        form: "constructor",
        definitions: [
          { file: "main.ts", line: 11, column: 7 },
          { file: "main.ts", line: 11, column: 19 },
        ],
      });
      expect(at(14, "K2")).toMatchObject({
        form: "constructor",
        definitions: [{ file: "main.ts", line: 12, column: 7 }],
      });
      const parameter = at(15, "Ctor");
      // The language service points at the parameter's construct signature, not Impl.
      expect(parameter).toMatchObject({
        form: "constructor",
        definitions: [{ file: "main.ts", line: 15, column: 19 }],
      });
      const property = at(17, "C");
      // Preserve both normal language-service answers, without adding Box's class name.
      expect(property).toMatchObject({
        form: "constructor",
        definitions: [
          { file: "lib.ts", line: 7, column: 3 },
          { file: "main.ts", line: 16, column: 13 },
        ],
      });
      for (const [entry, definition] of [
        [parameter, { file: "lib.ts", line: 15, column: 14 }],
        [property, { file: "lib.ts", line: 6, column: 14 }],
      ] as const) {
        expect(scoreDefinition(entry, { status: "ok", definition })).toBe("wrong");
      }
      expect(at(18, "Box").form).not.toBe("constructor");
      expect(at(19, "Box").form).not.toBe("constructor");
      expect(at(19, "classes").form).not.toBe("constructor");
      expect(at(21, "dyn")).toMatchObject({
        form: "constructor",
        definitions: [{ file: "main.ts", line: 20, column: 15 }],
        external: false,
      });
      expect(at(22, "X")).toMatchObject({ form: "constructor", definitions: [], external: false });
      expect(response.diagnostics.unresolvedSites).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses the real language service for definitions, aliases, references, external and unresolved sites", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-accuracy-oracle-"));
    try {
      const sources = {
        "lib.ts": [
          "export function twice(value: number) { return value * 2; }",
          "export class Box {",
          "  value = 2;",
          "  read() { return twice(this.value); }",
          "}",
          "export interface Shape { value: number; }",
          "export type Alias = Shape;",
        ].join("\n"),
        "main.ts": [
          'import { twice, Box, type Shape } from "./lib";',
          'import { twice as renamed } from "./lib";',
          "export function use(shape: Shape) {",
          "  const box = new Box();",
          '  const text = "\u{1f680}"; twice(box.read());',
          "  renamed(box.value);",
          "  Math.abs(shape.value);",
          "  missingPackage();",
          "  return text;",
          "}",
        ].join("\n"),
        "other.ts": [
          'import { twice } from "./lib";',
          "export const result = twice(3);",
          "export function overloaded(value: string): string;",
          "export function overloaded(value: number): number;",
          "export function overloaded(value: string | number) { return value; }",
          "export const overloadedResult = overloaded(1);",
          "export interface Merged { first: number; }",
          "export interface Merged { second: number; }",
          "export namespace Merged { export const marker = 1; }",
          "export class Combined {}",
          "export namespace Combined { export const marker = 1; }",
        ].join("\n"),
      };
      for (const [file, source] of Object.entries(sources)) fs.writeFileSync(path.join(root, file), source);
      fs.writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } }),
      );
      const request = {
        schemaVersion: 1,
        language: "typescript",
        files: Object.keys(sources).sort(),
        seed: 1,
        maxSites: 400,
        maxDeclarations: 80,
      };
      const requestPath = path.join(root, "request.json");
      const outputPath = path.join(root, "response.json");
      fs.writeFileSync(requestPath, JSON.stringify(request));
      const oraclePath = fileURLToPath(new URL("../scripts/accuracy/oracles/typescript/oracle.mjs", import.meta.url));
      const run = () => {
        const child = spawnSync(
          process.execPath,
          [oraclePath, "--root", root, "--request", requestPath, "--output", outputPath],
          {
            windowsHide: true,
            encoding: "utf8",
            timeout: 30_000,
          },
        );
        expect(child.error, child.stderr).toBeUndefined();
        expect(child.status, child.stderr).toBe(0);
        return JSON.parse(fs.readFileSync(outputPath, "utf8")) as OracleResponse;
      };
      const response = run();
      expect(response).toMatchObject({
        schemaVersion: 1,
        language: "typescript",
        oracle: { name: "typescript-language-service" },
      });
      expect(response.diagnostics.files).toBe(3);
      expect(response.diagnostics.errors).toEqual([]);
      expect(response.diagnostics.unresolvedSites).toBe(
        response.sites.filter((entry) => !entry.external && !entry.definitions.length).length,
      );
      expect(
        response.sites.find((entry) => entry.file === "main.ts" && entry.line === 5 && entry.name === "twice"),
      ).toMatchObject({
        column: sources["main.ts"].split("\n")[4].indexOf("twice") + 1,
        form: "bare-call",
        definitions: [{ file: "lib.ts", line: 1, column: 17 }],
        external: false,
      });
      expect(
        response.sites.find((entry) => entry.file === "main.ts" && entry.line === 4 && entry.name === "Box"),
      ).toMatchObject({
        form: "constructor",
        definitions: [{ file: "lib.ts", line: 2, column: 14 }],
      });
      expect(response.sites.find((entry) => entry.file === "main.ts" && entry.name === "read")).toMatchObject({
        form: "member-call",
        definitions: [{ file: "lib.ts", line: 4, column: 3 }],
      });
      expect(
        response.sites.find((entry) => entry.file === "main.ts" && entry.line === 6 && entry.name === "value")?.form,
      ).toBe("member-access");
      expect(
        response.sites.find((entry) => entry.file === "main.ts" && entry.line === 3 && entry.name === "Shape")?.form,
      ).toBe("type-reference");
      expect(
        response.sites.find((entry) => entry.file === "main.ts" && entry.line === 2 && entry.name === "twice"),
      ).toMatchObject({
        form: "import",
        definitions: [{ file: "lib.ts", line: 1, column: 17 }],
      });
      expect(response.sites.find((entry) => entry.name === "renamed")).toMatchObject({
        line: 6,
        definitions: [{ file: "lib.ts", line: 1, column: 17 }],
      });
      expect(response.sites.find((entry) => entry.name === "abs")).toMatchObject({ external: true, definitions: [] });
      expect(response.sites.find((entry) => entry.name === "missingPackage")).toMatchObject({
        external: false,
        definitions: [],
      });
      expect(
        response.sites.find((entry) => entry.file === "other.ts" && entry.line === 6 && entry.name === "overloaded"),
      ).toMatchObject({
        form: "bare-call",
        definitions: [
          { file: "other.ts", line: 3, column: 17 },
          { file: "other.ts", line: 4, column: 17 },
          { file: "other.ts", line: 5, column: 17 },
        ],
      });
      expect(response.declarations.find((entry) => entry.file === "other.ts" && entry.line === 3)).toMatchObject({
        name: "overloaded",
        relatedDeclarations: [
          { file: "other.ts", line: 4, column: 17 },
          { file: "other.ts", line: 5, column: 17 },
        ],
      });
      expect(response.declarations.find((entry) => entry.file === "other.ts" && entry.line === 7)).toMatchObject({
        name: "Merged",
        relatedDeclarations: [
          { file: "other.ts", line: 8, column: 18 },
          { file: "other.ts", line: 9, column: 18 },
        ],
      });
      expect(response.declarations.find((entry) => entry.file === "other.ts" && entry.line === 10)).toMatchObject({
        name: "Combined",
        relatedDeclarations: [{ file: "other.ts", line: 11, column: 18 }],
      });
      expect(response.sites.some((entry) => entry.file === "lib.ts" && entry.line === 1 && entry.column === 17)).toBe(
        false,
      );
      const twice = response.declarations.find((entry) => entry.name === "twice");
      expect(twice).toMatchObject({ file: "lib.ts", line: 1, column: 17, kind: "function" });
      expect(twice?.references).toContainEqual({ file: "other.ts", line: 2, column: 23 });
      expect(twice?.references.some((reference) => reference.file === "main.ts" && reference.line === 6)).toBe(true);
      expect(twice?.references).not.toContainEqual({ file: "lib.ts", line: 1, column: 17 });
      expect(run()).toEqual(response);
      const onlyMain = { ...request, files: ["main.ts"] };
      fs.writeFileSync(requestPath, JSON.stringify(onlyMain));
      const narrowed = run();
      expect(narrowed.diagnostics.files).toBe(1);
      expect(narrowed.sites.filter((entry) => entry.name === "twice").every((entry) => !entry.definitions.length)).toBe(
        true,
      );
      expect(narrowed.declarations.every((entry) => entry.file === "main.ts")).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
