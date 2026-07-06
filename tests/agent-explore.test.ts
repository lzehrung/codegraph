import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exploreCodegraph } from "../src/index.js";
import { createCodegraphMcpHandlers, listCodegraphMcpTools } from "../src/mcp/server.js";
import { captureCli } from "./helpers/cli.js";
import { mkTmpDir } from "./helpers/filesystem.js";

type JsonRecord = Record<string, unknown>;

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function mkExploreRepo(): Promise<string> {
  const root = await mkTmpDir("cg-agent-explore-");
  await writeFile(
    root,
    "src/db.ts",
    [
      "export type UserRecord = { id: string; active: boolean };",
      "",
      "export function readUser(userId: string): UserRecord {",
      "  return { id: userId, active: userId.length > 0 };",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    root,
    "src/auth.ts",
    [
      "import { readUser } from './db';",
      "",
      "export function validateUser(userId: string) {",
      "  const user = readUser(userId);",
      "  return user.active;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    root,
    "src/routes.ts",
    [
      "import { validateUser } from './auth';",
      "",
      "export function handleRequest(userId: string) {",
      "  return validateUser(userId) ? 'ok' : 'denied';",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    root,
    "tests/routes.test.ts",
    ["import { handleRequest } from '../src/routes';", "", "handleRequest('alice');", ""].join("\n"),
  );
  return root;
}

function readRecord(value: unknown, label: string): JsonRecord {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  return value as JsonRecord;
}

function readArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), label).toBeTruthy();
  return value as unknown[];
}
function readNumber(value: unknown, label: string): number {
  expect(value, label).toBeTypeOf("number");
  return value as number;
}

function textOf(value: unknown): string {
  return JSON.stringify(value);
}

function expectExploreEnvelope(response: unknown, query: string): JsonRecord {
  const record = readRecord(response, "explore response");
  expect(record.schemaVersion).toBe(1);
  expect(record.query).toBe(query);
  expect(record.analysis).toBeTypeOf("object");
  expect(Array.isArray(record.summary)).toBeTruthy();
  expect(Array.isArray(record.anchors)).toBeTruthy();
  expect(Array.isArray(record.packets)).toBeTruthy();
  expect(Array.isArray(record.paths)).toBeTruthy();
  expect(Array.isArray(record.blastRadius)).toBeTruthy();
  expect(Array.isArray(record.candidateTests)).toBeTruthy();
  expect(Array.isArray(record.followUps)).toBeTruthy();
  const limits = readRecord(record.limits, "limits");
  expect(limits.anchors).toBeTypeOf("number");
  expect(limits.packets).toBeTypeOf("number");
  expect(limits.paths).toBeTypeOf("number");
  expect(limits.blastRadiusEntries).toBeTypeOf("number");
  expect(limits.reverseDependencies).toBeTypeOf("number");
  expect(limits.candidateTests).toBeTypeOf("number");
  const omittedCounts = readRecord(record.omittedCounts, "omittedCounts");
  expect(omittedCounts.blastRadius).toBeTypeOf("number");
  expect(omittedCounts.blastRadiusEntries).toBeTypeOf("number");
  return record;
}

describe("agent explore", () => {
  it("returns a file packet and reverse dependency blast radius for a file-path query", async () => {
    const root = await mkExploreRepo();
    const query = "src/auth.ts";

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query }), query);
    const packets = readArray(response.packets, "packets");
    const blastRadius = readArray(response.blastRadius, "blastRadius");

    expect(packets.some((packet) => textOf(packet).includes("src/auth.ts"))).toBeTruthy();
    expect(blastRadius.some((entry) => textOf(entry).includes("src/routes.ts"))).toBeTruthy();
    expect(readArray(response.followUps, "followUps").length).toBeGreaterThan(0);
  });

  it("returns symbol anchors and evidence packets for a symbol query", async () => {
    const root = await mkExploreRepo();
    const query = "validateUser";

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query }), query);
    const anchors = readArray(response.anchors, "anchors");
    const packets = readArray(response.packets, "packets");

    expect(anchors.some((anchor) => textOf(anchor).includes("validateUser"))).toBeTruthy();
    expect(anchors.some((anchor) => textOf(anchor).includes("src/auth.ts"))).toBeTruthy();
    expect(packets.some((packet) => textOf(packet).includes("validateUser"))).toBeTruthy();
  });

  it("includes the dependency path for a flow-style query between connected files", async () => {
    const root = await mkExploreRepo();
    const query = "flow src/routes.ts to src/db.ts";

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query }), query);
    const paths = readArray(response.paths, "paths");
    const pathText = textOf(paths);

    expect(pathText).toContain("src/routes.ts");
    expect(pathText).toContain("src/auth.ts");
    expect(pathText).toContain("src/db.ts");
  });

  it("returns follow-ups and no candidate tests when a query has no graph matches", async () => {
    const root = await mkExploreRepo();
    const query = "definitelyMissingPaymentWebhook";

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query }), query);
    const anchors = readArray(response.anchors, "anchors");
    const packets = readArray(response.packets, "packets");
    const candidateTests = readArray(response.candidateTests, "candidateTests");
    const followUps = readArray(response.followUps, "followUps");
    const omittedCounts = readRecord(response.omittedCounts, "omittedCounts");

    expect(anchors).toHaveLength(0);
    expect(packets).toHaveLength(0);
    expect(candidateTests).toHaveLength(0);
    expect(omittedCounts.candidateTests).toBe(0);
    expect(followUps.length).toBeGreaterThan(0);
    expect(textOf(followUps)).toContain("definitelyMissingPaymentWebhook");
  });

  it("applies per-section limits and reports omitted counts", async () => {
    const root = await mkExploreRepo();
    await writeFile(
      root,
      "src/admin.ts",
      "import { validateUser } from './auth';\nexport const admin = validateUser('admin');\n",
    );
    await writeFile(
      root,
      "src/audit.ts",
      "import { validateUser } from './auth';\nexport const audit = validateUser('auditor');\n",
    );
    const query = "validateUser";

    const response = expectExploreEnvelope(
      await exploreCodegraph({
        root,
        query,
        limit: 1,
        maxPackets: 1,
        maxPaths: 1,
      }),
      query,
    );
    const omittedCounts = readRecord(response.omittedCounts, "omittedCounts");
    const limits = readRecord(response.limits, "limits");

    expect(readArray(response.anchors, "anchors")).toHaveLength(1);
    expect(readArray(response.packets, "packets")).toHaveLength(1);
    expect(readArray(response.blastRadius, "blastRadius")).toHaveLength(1);
    expect(readArray(response.followUps, "followUps").length).toBeGreaterThan(0);
    expect(limits.anchors).toBe(1);
    expect(limits.packets).toBe(1);
    expect(limits.paths).toBe(1);
    expect(omittedCounts.anchors).toBeGreaterThan(0);
  });

  it("reports blast-radius entry and reverse dependency omissions as lower bounds", async () => {
    const root = await mkExploreRepo();
    for (let index = 0; index < 22; index += 1) {
      await writeFile(
        root,
        `src/consumer-${String(index).padStart(2, "0")}.ts`,
        "import { validateUser } from './auth';\nexport const allowed = validateUser('user');\n",
      );
    }
    for (const name of ["feature-a", "feature-b", "feature-c", "feature-d"]) {
      await writeFile(root, `src/${name}.ts`, `export const ${name.replace("-", "")} = true;\n`);
    }
    const query = [
      "src/auth.ts",
      "src/db.ts",
      "src/routes.ts",
      "src/feature-a.ts",
      "src/feature-b.ts",
      "src/feature-c.ts",
      "src/feature-d.ts",
    ].join(" ");

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query }), query);
    const limits = readRecord(response.limits, "limits");
    const omittedCounts = readRecord(response.omittedCounts, "omittedCounts");
    const blastRadius = readArray(response.blastRadius, "blastRadius").map((entry) =>
      readRecord(entry, "blast radius entry"),
    );
    const entryLimit = readNumber(limits.blastRadiusEntries, "limits.blastRadiusEntries");
    const topLevelReverseOmissions = readNumber(omittedCounts.blastRadius, "omittedCounts.blastRadius");

    expect(blastRadius).toHaveLength(entryLimit);
    expect(readNumber(omittedCounts.blastRadiusEntries, "omittedCounts.blastRadiusEntries")).toBeGreaterThan(0);
    const authEntry = blastRadius.find((entry) => entry.file === "src/auth.ts");
    expect(authEntry).toBeDefined();
    expect(authEntry?.omittedCount).toBeUndefined();
    expect(readNumber(authEntry?.omittedLowerBound, "auth omittedLowerBound")).toBeGreaterThan(0);
    expect(
      blastRadius.reduce((sum, entry) => sum + readNumber(entry.omittedLowerBound, "entry omittedLowerBound"), 0),
    ).toBe(topLevelReverseOmissions);
  });

  it("accepts zero CLI limits and returns empty bounded sections", async () => {
    const root = await mkExploreRepo();
    const query = "validateUser";

    const result = await captureCli([
      "explore",
      query,
      "--root",
      root,
      "--limit",
      "0",
      "--max-packets",
      "0",
      "--max-paths",
      "0",
      "--json",
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    const response = expectExploreEnvelope(JSON.parse(result.stdout) as unknown, query);
    const limits = readRecord(response.limits, "limits");
    expect(readArray(response.anchors, "anchors")).toHaveLength(0);
    expect(readArray(response.packets, "packets")).toHaveLength(0);
    expect(readArray(response.paths, "paths")).toHaveLength(0);
    expect(readArray(response.blastRadius, "blastRadius")).toHaveLength(0);
    expect(readArray(response.candidateTests, "candidateTests")).toHaveLength(0);
    expect(limits.anchors).toBe(0);
    expect(limits.packets).toBe(0);
    expect(limits.paths).toBe(0);
  });

  it("prints explore-specific help for codegraph explore --help", async () => {
    const result = await captureCli(["explore", "--help"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("codegraph explore -");
    expect(result.stdout).toContain('Usage: codegraph explore "<query>"');
    expect(result.stdout).toContain("--max-packets");
    expect(result.stdout).not.toContain("Commands:");
  });

  it("prints the same bounded JSON envelope from the CLI explore command", async () => {
    const root = await mkExploreRepo();
    const query = "validateUser";

    const result = await captureCli(["explore", query, "--root", root, "--json"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expectExploreEnvelope(JSON.parse(result.stdout) as unknown, query);
  });

  it("advertises a flat MCP explore schema and invokes the facade", async () => {
    const root = await mkExploreRepo();
    const exploreTool = listCodegraphMcpTools().find((tool) => tool.name === "explore");
    expect(exploreTool).toBeTruthy();
    const schema = readRecord(exploreTool!.inputSchema, "explore input schema");
    const properties = readRecord(schema.properties, "explore schema properties");

    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["query"]);
    expect(schema.oneOf).toBeUndefined();
    expect(schema.anyOf).toBeUndefined();
    expect(schema.allOf).toBeUndefined();
    expect(properties.query).toEqual(expect.objectContaining({ type: "string" }));
    expect(properties.root).toBeUndefined();
    expect(properties.limits).toBeUndefined();
    expect(properties.limit).toEqual(expect.objectContaining({ type: "integer", minimum: 0 }));
    expect(properties.maxPackets).toEqual(expect.objectContaining({ type: "integer", minimum: 0 }));
    expect(properties.maxPaths).toEqual(expect.objectContaining({ type: "integer", minimum: 0 }));
    expect(properties.includeSource).toEqual(expect.objectContaining({ type: "boolean" }));

    const handlers = createCodegraphMcpHandlers({ root });
    const query = "validateUser";
    const response = expectExploreEnvelope(
      await handlers.explore({ query, limit: 1, maxPackets: 1, maxPaths: 1 }),
      query,
    );

    expect(readArray(response.anchors, "anchors")).toHaveLength(1);
    expect(readArray(response.packets, "packets")).toHaveLength(1);
    expect(readArray(response.blastRadius, "blastRadius")).toHaveLength(1);
    expect(response.freshness).toBeTypeOf("object");
  });
});
