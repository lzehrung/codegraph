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
