import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPlainRecord } from "../src/util/guards.js";
import { captureCli } from "./helpers/cli.js";

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-hierarchy-"));
  await fs.writeFile(
    path.join(root, "types.ts"),
    [
      "export interface Service { run(): void }",
      "export class Base {}",
      "export class Worker extends Base implements Service { run(): void {} }",
      "export class Specialized extends Worker {}",
      "export class Unrelated { run(): void {} }",
      "export function helper(): void {}",
    ].join("\n"),
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function symbolHandle(name: string, line?: number): Promise<string> {
  const result = await captureCli(["symbols", name, "--root", root, "--cache", "off", "--json"]);
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.symbols)) throw new Error("symbols response was invalid");
  const match = parsed.symbols.find((candidate) => {
    if (!isPlainRecord(candidate) || candidate.localName !== name) return false;
    if (line === undefined) return true;
    if (!isPlainRecord(candidate.location) || !isPlainRecord(candidate.location.range)) return false;
    return isPlainRecord(candidate.location.range.start) && candidate.location.range.start.line === line;
  });
  if (!isPlainRecord(match) || typeof match.handle !== "string") {
    throw new Error(`No handle for ${name}${line === undefined ? "" : ` at line ${line}`}`);
  }
  return match.handle;
}

describe("type hierarchy CLI", () => {
  it("emits bounded JSON with relations, exact locations, provenance, and omissions", async () => {
    const handle = await symbolHandle("Base");
    const result = await captureCli([
      "subtypes",
      handle,
      "--root",
      root,
      "--cache",
      "off",
      "--depth",
      "3",
      "--limit",
      "1",
      "--json",
    ]);
    const parsed: unknown = JSON.parse(result.stdout);

    expect(result).toMatchObject({ stderr: "", exitCode: undefined });
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      direction: "sub",
      limits: { relations: 1 },
      omittedCounts: { relations: 1 },
      target: { name: "Base", location: { file: "types.ts" } },
      relations: [
        {
          type: { name: "Worker", location: { file: "types.ts", range: expect.any(Object) } },
          relation: "extends",
          depth: 1,
          provenance: { confidence: expect.any(String) },
        },
      ],
    });
  });

  it("renders concise pretty hierarchy and implementation output", async () => {
    const specialized = await symbolHandle("Specialized");
    const supertypes = await captureCli([
      "supertypes",
      specialized,
      "--root",
      root,
      "--cache",
      "off",
      "--depth",
      "3",
      "--pretty",
    ]);
    expect(supertypes).toMatchObject({ stderr: "", exitCode: undefined });
    expect(supertypes.stdout).toContain("Target: Specialized [class] types.ts:4:");
    expect(supertypes.stdout).toContain("Supertypes: 3");
    expect(supertypes.stdout).toContain("1. Worker [class] types.ts:3:");
    expect(supertypes.stdout).not.toContain('"schemaVersion"');

    const service = await symbolHandle("Service");
    const implementations = await captureCli([
      "implementations",
      service,
      "--root",
      root,
      "--cache",
      "off",
      "--pretty",
    ]);
    expect(implementations).toMatchObject({ stderr: "", exitCode: undefined });
    expect(implementations.stdout).toContain("Implementations: 2");
    expect(implementations.stdout).toContain("Worker [class] types.ts:3:");
    expect(implementations.stdout).toContain("Specialized [class] types.ts:4:");
  });

  it("registers command-specific help and option schemas", async () => {
    const help = await captureCli(["subtypes", "--help"]);
    expect(help).toMatchObject({ stderr: "", exitCode: undefined });
    expect(help.stdout).toContain(
      "Usage: codegraph subtypes <symbol-handle> [--root <path>] [--depth <1-10>] [--limit <0-500>]",
    );

    const unsupportedDepth = await captureCli(["implementations", "symbol:types.ts:Service:1:18", "--depth", "2"]);
    expect(unsupportedDepth.stdout).toBe("");
    expect(unsupportedDepth.exitCode).toBe(2);
    expect(unsupportedDepth.stderr).toContain("Unknown option for implementations: --depth");

    const extraHandle = await captureCli(["supertypes", "first", "second"]);
    expect(extraHandle.stdout).toBe("");
    expect(extraHandle.exitCode).toBe(2);
    expect(extraHandle.stderr).toContain("Usage: codegraph supertypes <symbol-handle>");
  });

  it("validates required handles and public numeric bounds before indexing", async () => {
    const missing = await captureCli(["supertypes"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("Usage: codegraph supertypes <symbol-handle>");

    const highDepth = await captureCli(["supertypes", "cg:symbol:unused", "--depth", "11"]);
    expect(highDepth).toEqual({
      stdout: "",
      stderr: 'Invalid --depth value "11". Expected an integer from 1 to 10.\n',
      exitCode: 1,
    });

    const highLimit = await captureCli(["implementations", "cg:symbol:unused", "--limit", "501"]);
    expect(highLimit).toEqual({
      stdout: "",
      stderr: 'Invalid --limit value "501". Expected an integer from 0 to 500.\n',
      exitCode: 1,
    });
  });

  it("returns actionable errors for invalid type and unsupported member targets", async () => {
    const helper = await symbolHandle("helper");
    const invalidType = await captureCli(["supertypes", helper, "--root", root, "--cache", "off"]);
    expect(invalidType).toMatchObject({ stdout: "", exitCode: 1 });
    expect(invalidType.stderr).toContain("Type hierarchy requires a class, interface, or type symbol.");

    const unrelatedRun = await symbolHandle("run", 5);
    const unsupportedMember = await captureCli(["implementations", unrelatedRun, "--root", root, "--cache", "off"]);
    expect(unsupportedMember).toMatchObject({ stdout: "", exitCode: 1 });
    expect(unsupportedMember.stderr).toContain(
      "Member implementation lookup requires a proven interface or trait relationship.",
    );
  });
});
