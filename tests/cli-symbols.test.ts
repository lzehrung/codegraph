import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureCli } from "./helpers/cli.js";
import { isPlainRecord } from "../src/util/guards.js";

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-symbols-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "service.ts"),
    "export class Service {}\nexport function buildService() { return new Service(); }\n",
  );
  await fs.writeFile(
    path.join(root, "src", "consumer.ts"),
    "import { Service as LocalService } from './service.js';\nexport function consume() { return LocalService; }\n",
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("symbols CLI", () => {
  it("emits the public response as JSON", async () => {
    const result = await captureCli(["symbols", "Service", "--root", root, "--cache", "off", "--json"]);
    const parsed: unknown = JSON.parse(result.stdout);

    expect(result).toMatchObject({ stderr: "", exitCode: undefined });
    expect(isPlainRecord(parsed)).toBe(true);
    if (!isPlainRecord(parsed)) throw new Error("symbols JSON response was not an object");
    expect(parsed).toMatchObject({ schemaVersion: 1, query: "Service", limits: { symbols: 50 } });
    expect(Array.isArray(parsed.symbols)).toBe(true);
    if (!Array.isArray(parsed.symbols)) throw new Error("symbols JSON response omitted symbols");
    expect(parsed.symbols[0]).toMatchObject({
      name: "Service",
      kind: "class",
      exported: true,
      location: { file: "src/service.ts" },
    });
  });

  it("reuses the workspace formatter for concise pretty output", async () => {
    const result = await captureCli(["symbols", "Service", "--root", root, "--cache", "off", "--pretty"]);

    expect(result).toMatchObject({ stderr: "", exitCode: undefined });
    expect(result.stdout).toContain("Analysis: ");
    expect(result.stdout).toContain("Symbols: ");
    expect(result.stdout).toContain("Service [class] src/service.ts:1:");
    expect(result.stdout).not.toContain('"schemaVersion"');
  });

  it("composes kind, exported, file-glob, import, and limit options", async () => {
    const filtered = await captureCli([
      "symbols",
      "",
      "--root",
      root,
      "--kind",
      "class",
      "--exported",
      "--file-glob",
      "src/service.ts",
      "--limit",
      "1",
      "--cache",
      "off",
      "--json",
    ]);
    const filteredJson: unknown = JSON.parse(filtered.stdout);
    expect(isPlainRecord(filteredJson)).toBe(true);
    if (!isPlainRecord(filteredJson)) throw new Error("filtered symbols response was not an object");
    expect(filteredJson).toMatchObject({ limits: { symbols: 1 }, omittedCounts: { symbols: 0 } });
    expect(filteredJson.symbols).toEqual([
      expect.objectContaining({
        name: "Service",
        kind: "class",
        location: { file: "src/service.ts", range: expect.any(Object) },
      }),
    ]);

    const imports = await captureCli([
      "symbols",
      "LocalService",
      "--root",
      root,
      "--include-imports",
      "--cache",
      "off",
      "--json",
    ]);
    const importsJson: unknown = JSON.parse(imports.stdout);
    expect(isPlainRecord(importsJson)).toBe(true);
    if (!isPlainRecord(importsJson)) throw new Error("import symbols response was not an object");
    expect(importsJson.symbols).toEqual([
      expect.objectContaining({
        name: "LocalService",
        kind: "import",
        location: { file: "src/consumer.ts", range: expect.any(Object) },
      }),
    ]);
  });

  it("rejects limits above the public maximum before indexing", async () => {
    const result = await captureCli(["symbols", "Service", "--root", root, "--limit", "501"]);

    expect(result).toEqual({
      stdout: "",
      stderr: 'Invalid --limit value "501". Expected an integer from 0 to 500.\n',
      exitCode: 1,
    });
  });
});
