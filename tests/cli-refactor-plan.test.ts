import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/agent/session.js";
import { workspaceSymbolsWithSession } from "../src/agent/workspaceSymbols.js";
import { isPlainRecord } from "../src/util/guards.js";
import { captureCli } from "./helpers/cli.js";

let root = "";
let handle = "";
let sourceFile = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-refactor-plan-"));
  sourceFile = path.join(root, "service.ts");
  await fs.writeFile(
    sourceFile,
    [
      "export function helper(): number { return 1; }",
      "export function service(): number { return helper(); }",
      "export function caller(): number { return service(); }",
    ].join("\n"),
  );
  const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
  const symbols = await workspaceSymbolsWithSession(session, { root, query: "service", exportedOnly: true });
  handle = symbols.symbols.find((symbol) => symbol.name === "service")?.handle ?? "";
  if (!handle) throw new Error("Refactor CLI fixture handle was not indexed");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("refactor plan CLI", () => {
  it("emits JSON when requested, keeps limits independent, opts into source, and never writes", async () => {
    const before = await fs.readFile(sourceFile, "utf8");
    const result = await captureCli([
      "refactor-plan",
      "--json",
      handle,
      "--root",
      root,
      "--cache",
      "off",
      "--rename",
      "not/a/name",
      "--max-references",
      "0",
      "--max-callers",
      "0",
      "--max-hierarchy",
      "0",
      "--include-source",
    ]);
    const parsed: unknown = JSON.parse(result.stdout);

    expect(result).toMatchObject({ stderr: "", exitCode: undefined });
    expect(parsed).toMatchObject({
      target: { name: "service", handle, location: { file: "service.ts" } },
      references: [],
      callers: [],
      callees: [],
      limits: { references: 0, callers: 0, callees: 0, hierarchy: 0 },
      rename: {
        safe: false,
        conflicts: [expect.objectContaining({ reason: "invalid_identifier" })],
      },
      sectionIssues: [
        expect.objectContaining({
          section: "implementations",
          status: "unsupported_target",
        }),
      ],
    });
    if (!isPlainRecord(parsed) || !isPlainRecord(parsed.omittedCounts)) {
      throw new Error("Refactor CLI response was invalid");
    }
    expect(parsed.omittedCounts.references).toEqual(expect.any(Number));
    expect(parsed.omittedCounts.callers).toEqual(expect.any(Number));
    expect(parsed.omittedCounts.callees).toEqual(expect.any(Number));
    expect(await fs.readFile(sourceFile, "utf8")).toBe(before);
  });

  it("renders a concise pretty summary with omissions and copyable follow-ups", async () => {
    const result = await captureCli([
      "refactor-plan",
      handle,
      "--root",
      root,
      "--cache",
      "off",
      "--rename",
      "renamedService",
      "--max-references",
      "0",
    ]);

    expect(result).toMatchObject({ stderr: "", exitCode: undefined });
    expect(result.stdout).toContain("Target: service [function] service.ts:2:17");
    expect(result.stdout).toContain("Counts: references 0, callers 1, callees 1");
    expect(result.stdout).toContain("Rename safe: yes");
    expect(result.stdout).toContain("Rename conflicts: 0");
    expect(result.stdout).toContain("Omissions: references");
    expect(result.stdout).toContain("Section issues:\n  implementations [unsupported_target]:");
    expect(result.stdout).toContain("Follow-ups:\n  codegraph refs service.ts:2:17 --pretty");
    expect(result.stdout).not.toContain('"schemaVersion"');
  });

  it("registers help and validates every public limit before indexing", async () => {
    const help = await captureCli(["refactor-plan", "--json", "--help"]);
    expect(help).toMatchObject({ stderr: "", exitCode: undefined });
    expect(help.stdout).toContain("--max-hierarchy <0-500>");
    expect(help.stdout).toContain("Nested rename.safe is the safety decision");

    for (const option of ["--max-references", "--max-callers", "--max-hierarchy"]) {
      const invalid = await captureCli(["refactor-plan", "--json", handle, option, "501"]);
      expect(invalid).toEqual({
        stdout: "",
        stderr: `Invalid ${option} value "501". Expected an integer from 0 to 500.\n`,
        exitCode: 1,
      });
    }
  });
});
