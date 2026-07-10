import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exploreCodegraph, formatAgentExploreResponse } from "../src/index.js";
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

const spacedExplorePath = "src/live reports/audit-report.ts";
const spacedExploreText = [
  "export function renderAuditReport(total: number) {",
  "  return `audited:${total}`;",
  "}",
  "",
].join("\n");

async function writeSpacedExploreFixture(root: string): Promise<void> {
  await writeFile(root, spacedExplorePath, spacedExploreText);
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

function readString(value: unknown, label: string): string {
  expect(value, label).toBeTypeOf("string");
  return value as string;
}

function textOf(value: unknown): string {
  return JSON.stringify(value);
}

function readComparableLiveFileFields(value: unknown, label: string): JsonRecord {
  const view = readRecord(value, label);
  return {
    file: view.file,
    totalLines: view.totalLines,
    content: view.content,
    lineFormat: view.lineFormat,
    text: view.text,
    truncated: view.truncated,
    ...(view.graphContext !== undefined ? { graphContext: view.graphContext } : {}),
    ...(view.sensitive !== undefined ? { sensitive: view.sensitive } : {}),
    ...(view.page !== undefined ? { page: view.page } : {}),
  };
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
    const fileView = readRecord(response.fileView, "fileView");

    expect(packets.some((packet) => textOf(packet).includes("src/auth.ts"))).toBeTruthy();
    expect(blastRadius.some((entry) => textOf(entry).includes("src/routes.ts"))).toBeTruthy();
    expect(readArray(response.followUps, "followUps").length).toBeGreaterThan(0);
    expect(fileView).toMatchObject({
      file: "src/auth.ts",
      totalLines: 7,
      content: [
        "1\timport { readUser } from './db';",
        "2\t",
        "3\texport function validateUser(userId: string) {",
        "4\t  const user = readUser(userId);",
        "5\t  return user.active;",
        "6\t}",
        "7\t",
      ].join("\n"),
      lineFormat: "number-tab-line",
    });
    expect(fileView.graphContext).toBeUndefined();
  });

  it("attaches the live file view for exact indexed project paths containing spaces in library and CLI explore", async () => {
    const root = await mkExploreRepo();
    await writeSpacedExploreFixture(root);

    const libraryResponse = expectExploreEnvelope(
      await exploreCodegraph({ root, query: spacedExplorePath }),
      spacedExplorePath,
    );
    const libraryView = readRecord(libraryResponse.fileView, "library explore fileView");
    expect(libraryView).toMatchObject({
      file: spacedExplorePath,
      totalLines: 4,
      text: spacedExploreText,
      content: [
        "1\texport function renderAuditReport(total: number) {",
        "2\t  return `audited:${total}`;",
        "3\t}",
        "4\t",
      ].join("\n"),
      lineFormat: "number-tab-line",
    });

    const exploreResult = await captureCli(["explore", spacedExplorePath, "--root", root, "--json"]);
    const fileResult = await captureCli(["file", spacedExplorePath, "--root", root, "--json"]);

    expect(exploreResult).toMatchObject({ stderr: "", exitCode: undefined });
    expect(fileResult).toMatchObject({ stderr: "", exitCode: undefined });
    const cliExploreResponse = readRecord(JSON.parse(exploreResult.stdout) as unknown, "CLI explore response");
    const cliExploreView = readRecord(cliExploreResponse.fileView, "CLI explore fileView");
    const cliFileView = readRecord(JSON.parse(fileResult.stdout) as unknown, "CLI file response");
    const expectedLiveFields = readComparableLiveFileFields(libraryView, "library explore fileView");
    expect(readComparableLiveFileFields(cliExploreView, "CLI explore fileView")).toEqual(expectedLiveFields);
    expect(readComparableLiveFileFields(cliFileView, "CLI file response")).toEqual(expectedLiveFields);
  });

  it("does not attach a file view to a natural-language whitespace query containing a unique basename", async () => {
    const root = await mkExploreRepo();
    await writeSpacedExploreFixture(root);
    const query = "please inspect audit-report.ts for recent failures";

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query }), query);

    expect(textOf(response.blastRadius)).toContain(spacedExplorePath);
    expect(response).not.toHaveProperty("fileView");
  });

  it("orders anchor-file derived outputs by project path for multi-file mentions", async () => {
    const root = await mkExploreRepo();
    const query = "src/routes.ts src/db.ts src/auth.ts";

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query }), query);
    const blastRadiusFiles = readArray(response.blastRadius, "blastRadius").map((entry) =>
      readString(readRecord(entry, "blastRadius entry").file, "blast radius file"),
    );
    const followUps = readArray(response.followUps, "followUps");

    expect(blastRadiusFiles.slice(0, 3)).toEqual(["src/auth.ts", "src/db.ts", "src/routes.ts"]);
    expect(followUps.slice(0, 3)).toEqual([
      "codegraph file src/auth.ts --pretty",
      "codegraph file src/db.ts --pretty",
      "codegraph file src/routes.ts --pretty",
    ]);
    expect(response.fileView).toBeUndefined();
  });

  it("matches basename-only file mentions case-insensitively", async () => {
    const root = await mkExploreRepo();
    const query = "Auth.ts";

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query }), query);
    const packets = readArray(response.packets, "packets");
    const blastRadius = readArray(response.blastRadius, "blastRadius");

    expect(textOf(packets)).toContain("src/auth.ts");
    expect(textOf(blastRadius)).toContain("src/routes.ts");
  });

  it("matches basename-only file mentions with trailing question or exclamation punctuation", async () => {
    const root = await mkExploreRepo();
    const queries = ["auth.ts?", "auth.ts!"];

    for (const query of queries) {
      const response = expectExploreEnvelope(await exploreCodegraph({ root, query }), query);
      const blastRadius = readArray(response.blastRadius, "blastRadius");
      const followUps = readArray(response.followUps, "followUps");

      expect(textOf(blastRadius), query).toContain("src/routes.ts");
      expect(followUps, query).toContain("codegraph packet get src/auth.ts --pretty");
    }
  });

  it("does not treat a full-path mention as a match for another path that is only a string prefix", async () => {
    const root = await mkExploreRepo();
    await writeFile(
      root,
      "src/auth.tsx",
      ["export function AuthPanel() {", "  return <section>authenticated</section>;", "}", ""].join("\n"),
    );
    const query = "src/auth.tsx";

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query, limit: 1, maxPackets: 1 }), query);
    const packetTargets = readArray(response.packets, "packets").map((packet) =>
      readString(readRecord(packet, "packet").target, "packet target"),
    );
    const blastRadiusFiles = readArray(response.blastRadius, "blastRadius").map((entry) =>
      readString(readRecord(entry, "blastRadius entry").file, "blast radius file"),
    );
    const followUps = readArray(response.followUps, "followUps");

    expect(packetTargets).toContain("src/auth.tsx");
    expect(packetTargets).not.toContain("src/auth.ts");
    expect(blastRadiusFiles).toContain("src/auth.tsx");
    expect(blastRadiusFiles).not.toContain("src/auth.ts");
    expect(followUps).toContain("codegraph packet get src/auth.tsx --pretty");
    expect(followUps).not.toContain("codegraph packet get src/auth.ts --pretty");
    expect(followUps).not.toContain("codegraph refs --file src/auth.ts --line 1 --col 0 --pretty");
  });

  it("matches explicit full-path file mentions with trailing question punctuation", async () => {
    const root = await mkExploreRepo();
    const query = "src/auth.ts?";

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query }), query);
    const packetTargets = readArray(response.packets, "packets").map((packet) =>
      readString(readRecord(packet, "packet").target, "packet target"),
    );
    const blastRadiusFiles = readArray(response.blastRadius, "blastRadius").map((entry) =>
      readString(readRecord(entry, "blastRadius entry").file, "blast radius file"),
    );
    const followUps = readArray(response.followUps, "followUps");

    expect(packetTargets).toContain("src/auth.ts");
    expect(blastRadiusFiles).toContain("src/auth.ts");
    expect(textOf(response.blastRadius)).toContain("src/routes.ts");
    expect(followUps).toContain("codegraph packet get src/auth.ts --pretty");
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
    expect(response.fileView).toBeUndefined();
  });

  it("disables packet limits and packet omissions when source packets are excluded", async () => {
    const root = await mkExploreRepo();
    const query = "src/auth.ts";

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query, includeSource: false }), query);
    const limits = readRecord(response.limits, "limits");
    const omittedCounts = readRecord(response.omittedCounts, "omittedCounts");

    expect(readArray(response.packets, "packets")).toHaveLength(0);
    expect(limits.packets).toBe(0);
    expect(omittedCounts.packets).toBe(0);
    expect(response.fileView).toBeUndefined();
  });

  it("pretty output distinguishes empty relevant source reasons", async () => {
    const root = await mkExploreRepo();
    const noAnchorQuery = "definitelyMissingPaymentWebhook";
    const cases = [
      {
        name: "source disabled",
        query: "validateUser",
        response: await exploreCodegraph({ root, query: "validateUser", includeSource: false }),
        expected: "- Source packets disabled by limit or option.",
      },
      {
        name: "no anchors",
        query: noAnchorQuery,
        response: await exploreCodegraph({ root, query: noAnchorQuery }),
        expected: "- No anchors found for source packets.",
      },
    ];

    for (const { name, query, response, expected } of cases) {
      expectExploreEnvelope(response, query);
      const pretty = formatAgentExploreResponse(response);

      expect(pretty, name).toContain(expected);
      expect(pretty, name).not.toContain("- Not included.");
    }
  });

  it("includes pretty refs commands in explore follow-ups", async () => {
    const root = await mkExploreRepo();
    const query = "src/auth.ts";

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query }), query);
    const refsFollowUps = readArray(response.followUps, "followUps").filter(
      (followUp): followUp is string => typeof followUp === "string" && followUp.startsWith("codegraph refs "),
    );

    expect(refsFollowUps.length).toBeGreaterThan(0);
    expect(refsFollowUps.every((followUp) => followUp.includes(" --pretty"))).toBeTruthy();
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

  it("does not collect dependency paths for standalone to in instructional queries", async () => {
    const root = await mkExploreRepo();
    const instructionalQuery = "how to connect src/routes.ts src/db.ts";

    const response = expectExploreEnvelope(
      await exploreCodegraph({ root, query: instructionalQuery }),
      instructionalQuery,
    );
    const anchors = readArray(response.anchors, "anchors");

    expect(textOf(anchors)).toContain("src/routes.ts");
    expect(textOf(anchors)).toContain("src/db.ts");
    expect(readArray(response.paths, "paths")).toHaveLength(0);

    const triggeredQuery = "path src/routes.ts src/db.ts";
    const triggeredResponse = expectExploreEnvelope(
      await exploreCodegraph({ root, query: triggeredQuery }),
      triggeredQuery,
    );
    const triggeredPathText = textOf(readArray(triggeredResponse.paths, "triggered paths"));

    expect(triggeredPathText).toContain("src/routes.ts");
    expect(triggeredPathText).toContain("src/auth.ts");
    expect(triggeredPathText).toContain("src/db.ts");
  });

  it("reports path omissions as a lower bound after the first over-limit path", async () => {
    const root = await mkExploreRepo();
    const query = "flow src/routes.ts src/auth.ts src/db.ts";

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query, maxPaths: 1 }), query);
    const paths = readArray(response.paths, "paths");
    const omittedCounts = readRecord(response.omittedCounts, "omittedCounts");

    expect(paths).toHaveLength(1);
    expect(omittedCounts.paths).toBe(1);
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

  it("omits absolute root paths from internally generated explore follow-ups", async () => {
    const root = await mkExploreRepo();
    const query = "definitelyMissingPaymentWebhook";

    const response = expectExploreEnvelope(await exploreCodegraph({ root, query, includeSource: false }), query);
    const followUps = readArray(response.followUps, "followUps");
    const followUpText = followUps.join("\n");

    expect(followUps).toContain(`codegraph explore ${query} --pretty`);
    expect(followUps).toContain(`codegraph search ${query} --json`);
    expect(followUps).toContain("codegraph orient --budget small --pretty");
    expect(followUpText).not.toContain(root);
    expect(followUpText).not.toContain(" --root ");
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

  it("keeps exact-file CLI explore content in parity with CLI file, including graph context", async () => {
    const root = await mkExploreRepo();
    const query = "src/auth.ts";

    const exploreResult = await captureCli(["explore", query, "--root", root, "--json"]);
    const fileResult = await captureCli(["file", query, "--root", root, "--json"]);

    expect(exploreResult).toMatchObject({ stderr: "", exitCode: undefined });
    expect(fileResult).toMatchObject({ stderr: "", exitCode: undefined });
    const exploreResponse = readRecord(JSON.parse(exploreResult.stdout) as unknown, "explore response");
    const exploreView = readRecord(exploreResponse.fileView, "explore fileView");
    const fileView = readRecord(JSON.parse(fileResult.stdout) as unknown, "file response");
    expect(readComparableLiveFileFields(exploreView, "explore fileView")).toEqual(
      readComparableLiveFileFields(fileView, "file response"),
    );
    expect(exploreView).toMatchObject({
      file: query,
      totalLines: 7,
      text: [
        "import { readUser } from './db';",
        "",
        "export function validateUser(userId: string) {",
        "  const user = readUser(userId);",
        "  return user.active;",
        "}",
        "",
      ].join("\n"),
    });

    const contextualExploreResult = await captureCli([
      "explore",
      query,
      "--root",
      root,
      "--include-graph-context",
      "--json",
    ]);
    const contextualFileResult = await captureCli([
      "file",
      query,
      "--root",
      root,
      "--include-graph-context",
      "--json",
    ]);

    expect(contextualExploreResult).toMatchObject({ stderr: "", exitCode: undefined });
    expect(contextualFileResult).toMatchObject({ stderr: "", exitCode: undefined });
    const contextualExploreResponse = readRecord(
      JSON.parse(contextualExploreResult.stdout) as unknown,
      "contextual explore response",
    );
    const contextualExploreView = readRecord(contextualExploreResponse.fileView, "contextual explore fileView");
    const contextualFileView = readRecord(
      JSON.parse(contextualFileResult.stdout) as unknown,
      "contextual file response",
    );
    expect(readComparableLiveFileFields(contextualExploreView, "contextual explore fileView")).toEqual(
      readComparableLiveFileFields(contextualFileView, "contextual file response"),
    );
    const graphContext = readRecord(contextualExploreView.graphContext, "explore graphContext");
    expect(graphContext.usedBy).toEqual(["src/routes.ts"]);
    expect(graphContext.imports).toEqual(["src/db.ts"]);
    expect(readArray(graphContext.symbols, "explore graphContext symbols")).toContainEqual({
      name: "validateUser",
      kind: "function",
      line: 3,
    });
  });

  it("passes explicit sensitive access from exact-file CLI explore to its live file view", async () => {
    const root = await mkExploreRepo();
    const query = "src/credentials.json";
    const sensitiveText = [
      "{",
      '  "apiToken": "explore-dispatcher-secret",',
      '  "username": "alice"',
      "}",
      "",
    ].join("\n");
    await writeFile(root, query, sensitiveText);
    await writeFile(
      root,
      "src/credentials-reader.ts",
      [
        "import credentials from './credentials.json';",
        "",
        "export const deploymentUser = credentials.username;",
        "",
      ].join("\n"),
    );

    const exploreResult = await captureCli([
      "explore",
      query,
      "--root",
      root,
      "--allow-sensitive",
      "--max-packets",
      "0",
      "--limit",
      "0",
      "--json",
    ]);
    const fileResult = await captureCli(["file", query, "--root", root, "--allow-sensitive", "--json"]);

    expect(exploreResult).toMatchObject({ stderr: "", exitCode: undefined });
    expect(fileResult).toMatchObject({ stderr: "", exitCode: undefined });
    const exploreResponse = readRecord(JSON.parse(exploreResult.stdout) as unknown, "sensitive explore response");
    const exploreView = readRecord(exploreResponse.fileView, "sensitive explore fileView");
    const fileView = readRecord(JSON.parse(fileResult.stdout) as unknown, "sensitive file response");
    expect(readComparableLiveFileFields(exploreView, "sensitive explore fileView")).toEqual(
      readComparableLiveFileFields(fileView, "sensitive file response"),
    );
    expect(exploreView).toMatchObject({
      file: query,
      text: sensitiveText,
      content: [
        "1\t{",
        '2\t  "apiToken": "explore-dispatcher-secret",',
        '3\t  "username": "alice"',
        "4\t}",
        "5\t",
      ].join("\n"),
      sensitive: { kind: "credential-config", redacted: false, allowSensitiveRequired: true },
    });
  });

  it("suppresses the exact-file CLI explore file view when source is disabled", async () => {
    const root = await mkExploreRepo();
    const query = "src/auth.ts";

    const result = await captureCli(["explore", query, "--root", root, "--no-source", "--json"]);

    expect(result).toMatchObject({ stderr: "", exitCode: undefined });
    const response = readRecord(JSON.parse(result.stdout) as unknown, "no-source explore response");
    expect(response).not.toHaveProperty("fileView");
    expect(response.packets).toEqual([]);
    expect(result.stdout).not.toContain("const user = readUser(userId)");
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
