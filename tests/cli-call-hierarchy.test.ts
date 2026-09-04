import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPlainRecord } from "../src/util/guards.js";
import { captureCli, stripCliProgressLines } from "./helpers/cli.js";

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-calls-"));
  await fs.writeFile(
    path.join(root, "calls.ts"),
    [
      "export function leaf(): number { return 1; }",
      "export function middle(): number { leaf(); leaf(); return 2; }",
      "export function outer(): number { return middle(); }",
      "export function recursive(): number { return recursive(); }",
      "export class NotCallable {}",
    ].join("\n"),
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function symbolHandle(name: string): Promise<string> {
  const result = await captureCli(["symbols", name, "--root", root, "--cache", "off", "--json"]);
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.symbols)) throw new Error("symbols response was invalid");
  const match = parsed.symbols.find((candidate) => isPlainRecord(candidate) && candidate.localName === name);
  if (!isPlainRecord(match) || typeof match.handle !== "string") throw new Error(`No handle for ${name}`);
  return match.handle;
}

describe("call hierarchy CLI", () => {
  it("emits deterministic grouped JSON with exact project-relative callsites and omissions", async () => {
    const handle = await symbolHandle("leaf");
    const result = await captureCli([
      "callers",
      handle,
      "--root",
      root,
      "--cache",
      "off",
      "--depth",
      "2",
      "--limit",
      "1",
      "--include-heuristic",
      "--json",
    ]);
    const parsed: unknown = JSON.parse(result.stdout);

    expect(result.exitCode).toBeUndefined();
    expect(stripCliProgressLines(result.stderr)).toBe("");
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      direction: "incoming",
      limits: { symbols: 1, callsitesPerSymbol: 50 },
      omittedCounts: { symbols: 1, callsites: 0, unresolvedSites: 0 },
      target: { name: "leaf", location: { file: "calls.ts" } },
      entries: [
        {
          symbol: { name: "middle", location: { file: "calls.ts" } },
          depth: 1,
          callsites: [
            { file: "calls.ts", range: { start: { line: 2 }, end: { line: 2 } } },
            { file: "calls.ts", range: { start: { line: 2 }, end: { line: 2 } } },
          ],
          provenance: { confidence: expect.any(String) },
        },
      ],
    });
  });

  it("renders concise pretty transitive callees and recursive calls", async () => {
    const outer = await symbolHandle("outer");
    const callees = await captureCli(["callees", outer, "--root", root, "--cache", "off", "--depth", "2"]);
    expect(callees.exitCode).toBeUndefined();
    expect(stripCliProgressLines(callees.stderr)).toBe("");
    expect(callees.stdout).toContain("Target: outer [function] calls.ts:3:");
    expect(callees.stdout).toContain("Callees: 2");
    expect(callees.stdout).toContain("1. middle [function] calls.ts:2:");
    expect(callees.stdout).toContain("2. leaf [function] calls.ts:1:");
    expect(callees.stdout).toMatch(/calls\.ts:3:\d+-3:\d+/);
    expect(callees.stdout).not.toContain('"schemaVersion"');

    const recursive = await symbolHandle("recursive");
    const recursion = await captureCli(["callees", recursive, "--root", root, "--cache", "off", "--json"]);
    const parsed: unknown = JSON.parse(recursion.stdout);
    expect(parsed).toMatchObject({ entries: [{ symbol: { name: "recursive" }, depth: 1 }] });
  });

  it("registers command help, validates public bounds, and rejects non-callable targets", async () => {
    const help = await captureCli(["callers", "--json", "--help"]);
    expect(help).toMatchObject({ stderr: "", exitCode: undefined });
    expect(help.stdout).toContain(
      "Usage: codegraph callers <symbol-target> [--root <path>] [--depth <1-5>] [--limit <0-500>]",
    );

    const missing = await captureCli(["callees", "--json"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("Usage: codegraph callees <symbol-target>");
    const highDepth = await captureCli(["callers", "--json", "cg:symbol:unused", "--depth", "6"]);

    expect(highDepth).toEqual({
      stdout: "",
      stderr: 'Invalid --depth value "6". Expected an integer from 1 to 5.\n',
      exitCode: 2,
    });

    const highLimit = await captureCli(["callees", "--json", "cg:symbol:unused", "--limit", "501"]);
    expect(highLimit).toEqual({
      stdout: "",
      stderr: 'Invalid --limit value "501". Expected an integer from 0 to 500.\n',
      exitCode: 2,
    });

    const invalidHandle = await symbolHandle("NotCallable");
    const invalid = await captureCli(["callers", "--json", invalidHandle, "--root", root, "--cache", "off"]);
    expect(invalid).toMatchObject({ stdout: "", exitCode: 1 });
    expect(invalid.stderr).toContain("Call hierarchy requires a function or callable member symbol.");
  });

  it("leaves refs as the complete reference surface", async () => {
    const refs = await captureCli([
      "refs",
      "--json",
      "--file",
      "calls.ts",
      "--line",
      "1",
      "--col",
      "17",
      "--root",
      root,
      "--native",
      "auto",
    ]);
    const parsed: unknown = JSON.parse(refs.stdout);
    expect(refs.exitCode).toBeUndefined();
    expect(stripCliProgressLines(refs.stderr)).toBe("");
    expect(parsed).toMatchObject({ status: "ok", references: expect.any(Array) });
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.references)) throw new Error("refs response was invalid");
    expect(parsed.references).toHaveLength(3);
  });
});

describe("call hierarchy CLI receiver method calls", () => {
  let methodRoot = "";

  beforeAll(async () => {
    methodRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-receiver-calls-"));
    await fs.writeFile(path.join(methodRoot, "lib.ts"), "export class Lib { target(): number { return 1; } }\n");
    await fs.writeFile(
      path.join(methodRoot, "caller.ts"),
      [
        'import { Lib } from "./lib";',
        "export class Caller {",
        "  plain(): number { const l = new Lib(); return l.target(); }",
        "}",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await fs.rm(methodRoot, { recursive: true, force: true });
  });

  it("reports the calling method for an instance method invoked on a constructed receiver", async () => {
    const result = await captureCli(["callers", "lib.ts::target", "--root", methodRoot, "--cache", "off", "--json"]);
    const parsed: unknown = JSON.parse(result.stdout);

    expect(result.exitCode).toBeUndefined();
    expect(stripCliProgressLines(result.stderr)).toBe("");
    expect(parsed).toMatchObject({
      direction: "incoming",
      target: { name: "target", location: { file: "lib.ts" } },
      entries: [
        {
          symbol: { name: "plain", location: { file: "caller.ts" } },
          depth: 1,
          callsites: [{ file: "caller.ts", range: { start: { line: 3 } } }],
        },
      ],
    });
  });
});
