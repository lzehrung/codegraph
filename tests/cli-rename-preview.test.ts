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
let consumerFile = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-rename-"));
  sourceFile = path.join(root, "Service.ts");
  consumerFile = path.join(root, "consumer.ts");
  await fs.writeFile(sourceFile, "export class Service {}\n");
  await fs.writeFile(
    consumerFile,
    [
      'import { Service } from "./Service.js";',
      "export const value = new Service();",
      "// Service documentation",
      'export const label = "Service";',
    ].join("\n"),
  );
  const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
  const symbols = await workspaceSymbolsWithSession(session, { root, query: "Service", exportedOnly: true });
  handle = symbols.symbols.find((symbol) => symbol.name === "Service")?.handle ?? "";
  if (!handle) throw new Error("Rename CLI fixture handle was not indexed");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("rename preview CLI", () => {
  it("emits portable read-only JSON with opt-in boolean candidates and filename suggestions", async () => {
    const beforeSource = await fs.readFile(sourceFile, "utf8");
    const beforeConsumer = await fs.readFile(consumerFile, "utf8");
    const result = await captureCli([
      "rename-preview",
      handle,
      "RenamedService",
      "--root",
      root,
      "--cache",
      "off",
      "--include-comments",
      "--include-strings",
      "--include-filenames",
      "--max-edits",
      "10",
      "--json",
    ]);
    const parsed: unknown = JSON.parse(result.stdout);

    expect(result).toMatchObject({ stderr: "", exitCode: undefined });
    expect(parsed).toMatchObject({
      safe: true,
      newName: "RenamedService",
      target: { name: "Service", location: { file: "Service.ts" } },
      filenameSuggestions: [{ from: "Service.ts", to: "RenamedService.ts", caseOnlyRisk: false }],
    });
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.edits)) throw new Error("Rename CLI response was invalid");
    expect(parsed.edits.map((edit) => (isPlainRecord(edit) ? edit.kind : undefined))).toEqual([
      "import",
      "reference",
      "comment",
      "string",
      "definition",
    ]);
    expect(
      parsed.edits.every((edit) => isPlainRecord(edit) && typeof edit.file === "string" && !path.isAbsolute(edit.file)),
    ).toBe(true);
    expect(await fs.readFile(sourceFile, "utf8")).toBe(beforeSource);
    expect(await fs.readFile(consumerFile, "utf8")).toBe(beforeConsumer);
  });

  it("preserves unsafe omission and invalid-identifier responses", async () => {
    const limited = await captureCli([
      "rename-preview",
      handle,
      "RenamedService",
      "--root",
      root,
      "--cache",
      "off",
      "--max-edits",
      "1",
      "--json",
    ]);
    const limitedResponse: unknown = JSON.parse(limited.stdout);
    expect(limited).toMatchObject({ stderr: "", exitCode: undefined });
    expect(limitedResponse).toMatchObject({
      safe: false,
      omittedCounts: { edits: 2 },
      unsafeSites: [expect.objectContaining({ reason: "limit_exceeded" })],
    });

    const invalid = await captureCli([
      "rename-preview",
      handle,
      "not/a/name",
      "--root",
      root,
      "--cache",
      "off",
      "--json",
    ]);
    const invalidResponse: unknown = JSON.parse(invalid.stdout);
    expect(invalid).toMatchObject({ stderr: "", exitCode: undefined });
    expect(invalidResponse).toMatchObject({
      safe: false,
      conflicts: [expect.objectContaining({ reason: "invalid_identifier" })],
    });
  });

  it("validates boolean flags, the public max-edits bound, and positional arity before indexing", async () => {
    const valuedBoolean = await captureCli([
      "rename-preview",
      "--json",
      handle,
      "RenamedService",
      "--include-comments=false",
    ]);
    expect(valuedBoolean).toMatchObject({ stdout: "", exitCode: 2 });
    expect(valuedBoolean.stderr).toContain("Unknown option for rename-preview: --include-comments");

    const aboveMaximum = await captureCli([
      "rename-preview",
      "--json",
      handle,
      "RenamedService",
      "--max-edits",
      "10001",
    ]);
    expect(aboveMaximum).toEqual({
      stdout: "",
      stderr: 'Invalid --max-edits value "10001". Expected an integer from 1 to 10000.\n',
      exitCode: 2,
    });

    const extra = await captureCli(["rename-preview", "--json", handle, "RenamedService", "extra"]);
    expect(extra).toMatchObject({ stdout: "", exitCode: 2 });
    expect(extra.stderr).toContain("Usage: codegraph rename-preview <symbol-target> <new-name>");
  });

  it("registers command help and renders explicit read-only pretty output", async () => {
    const help = await captureCli(["rename-preview", "--json", "--help"]);
    expect(help).toMatchObject({ stderr: "", exitCode: undefined });
    expect(help.stdout).toContain("--max-edits N");
    expect(help.stdout).toContain("no apply command exists");

    const pretty = await captureCli([
      "rename-preview",
      handle,
      "RenamedService",
      "--root",
      root,
      "--cache",
      "off",
      "--include-filenames",
    ]);
    expect(pretty).toMatchObject({ stderr: "", exitCode: undefined });
    expect(pretty.stdout).toContain("Safe: yes");
    expect(pretty.stdout).toContain("Filename suggestions: 1 (suggestions only; no apply command)");
    expect(pretty.stdout).not.toContain('"schemaVersion"');
  });
});
