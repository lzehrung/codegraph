import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCodegraphPacket, orientCodegraph } from "../src/agent.js";
import { DEFAULT_REVIEW_TRANSPORT_LIMITS } from "../src/review/types.js";
import { formatAgentFollowUpAsCli } from "../src/agent/follow-ups.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";
import {
  SWIFT_EXTENSION_OWNER_FILES,
  SWIFT_EXTENSION_OWNER_HANDLE,
  SWIFT_NOMINAL_HANDLE,
} from "./helpers/swift-extension-owner-fixture.js";
import { writeFixtureFiles } from "./languages/callable-consumer-fixtures.js";

const tempRoots = createTempRootRegistry();
async function mkTmpDir(prefix: string): Promise<string> {
  return await tempRoots.create(prefix);
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("agent packet", () => {
  afterEach(async () => {
    await tempRoots.cleanup();
  });
  it("retrieves a file packet from an orientation file target", async () => {
    const root = await mkTmpDir("cg-agent-packet-");
    await writeFile(root, "src/run.ts", "export function run() { return 1; }\n");

    const orient = await orientCodegraph({ root, includeRoots: ["src"], budget: "small" });
    const target = orient.focus.find((focus) => focus.file);
    if (!target?.file) {
      throw new Error("expected file focus target");
    }

    const packet = await getCodegraphPacket({ root, target: target.file });

    expect(packet.schemaVersion).toBe(2);
    expect(packet.kind).toBe("file");
    expect(packet.followUps.length).toBeGreaterThan(0);
  });

  it("reports bare symbol packet targets as symbols", async () => {
    const root = await mkTmpDir("cg-agent-packet-symbol-");
    await writeFile(root, "src/auth.ts", "export function validateUser() { return true; }\n");

    const packet = await getCodegraphPacket({ root, target: "validateUser" });

    expect(packet.schemaVersion).toBe(2);
    expect(packet.kind).toBe("symbol");
    const payload = packet.packet;
    if (!("target" in payload)) {
      throw new Error("expected explanation packet");
    }
    expect(payload.target.kind).toBe("symbol");
  });

  it("retrieves duplicate context in file packets", async () => {
    const root = await mkTmpDir("cg-agent-packet-dups-");
    const source = `
export function normalizeInvoiceRows(rows: Array<{ amount: number; tax: number }>) {
  const totals: number[] = [];
  const labels: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    labels.push(label);
    totals.push(rounded);
  }
  const encoded = totals.map((value, index) => labels[index] + ":" + value.toFixed(2));
  return encoded.filter((value) => value.includes(":")).join(",");
}
`;
    await writeFile(root, "src/a.ts", source);
    await writeFile(root, "src/b.ts", source);

    const packet = await getCodegraphPacket({ root, target: "src/a.ts", maxDuplicates: 1 });

    if (packet.packet.schemaVersion !== 1 || !("duplicates" in packet.packet)) {
      throw new Error("expected explanation packet");
    }
    expect(packet.packet.duplicates).toHaveLength(1);
    expect(packet.omittedCounts.duplicates).toBe(0);
  });

  it("retrieves review packets from review targets", async () => {
    const root = await mkTmpDir("cg-agent-packet-review-");
    runGit(root, ["init"]);
    runGit(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await writeFile(root, "src/run.ts", "export function run() { return 1; }\n");
    await writeFile(root, "tests/run.test.ts", "import { run } from '../src/run';\nrun();\n");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);

    await writeFile(root, "src/run.ts", "export function run() { return 2; }\n");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "change run"]);

    const orient = await orientCodegraph({
      root,
      includeRoots: ["src"],
      budget: "small",
      review: { base: "HEAD~1", head: "HEAD" },
    });
    expect(orient.focus[0]?.kind).toBe("review");
    expect(formatAgentFollowUpAsCli(orient.focus[0]!.followUps[0]!)).toBe(
      "codegraph review --base 'HEAD~1' --head HEAD",
    );

    const packet = await getCodegraphPacket({ root, target: "review:base=HEAD~1;head=HEAD" });

    expect(packet.schemaVersion).toBe(2);
    expect(packet.kind).toBe("review");
    expect(packet.followUps.some((followUp) => followUp.tool === "review")).toBeTruthy();
    if (packet.packet.schemaVersion !== 2) {
      throw new Error("expected review report");
    }
    expect(packet.packet.summary.symbolsChanged).toBeGreaterThan(0);
    expect(Array.isArray(packet.packet.candidateTests)).toBeTruthy();
  });

  it("bounds an oversized review packet with transport limits and exact omissions", async () => {
    const root = await mkTmpDir("cg-agent-packet-review-bounds-");
    runGit(root, ["init"]);
    runGit(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const files = Array.from({ length: DEFAULT_REVIEW_TRANSPORT_LIMITS.changedFiles + 1 }, (_, index) => {
      return `src/change-${index}.ts`;
    });
    for (const file of files) {
      await writeFile(root, file, "export const revision = 1;\n");
    }
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    for (const file of files) {
      await writeFile(root, file, "export const revision = 2;\n");
    }
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "change all files"]);

    const packet = await getCodegraphPacket({ root, target: "review:base=HEAD~1;head=HEAD" });

    expect(packet.kind).toBe("review");
    expect(packet.limits).toEqual(DEFAULT_REVIEW_TRANSPORT_LIMITS);
    expect(packet.omittedCounts).toMatchObject({
      changedFiles: 1,
      projectFiles: 0,
      symbols: 1,
      graphDelta: 0,
      candidateTests: 0,
    });
    if (packet.packet.schemaVersion !== 2) {
      throw new Error("expected review report");
    }
    expect(packet.packet.changedFiles).toHaveLength(DEFAULT_REVIEW_TRANSPORT_LIMITS.changedFiles);
    expect(
      packet.packet.changedFiles.every((file) => file.symbols.length <= DEFAULT_REVIEW_TRANSPORT_LIMITS.symbolsPerFile),
    ).toBe(true);
  });

  it("rejects malformed percent encoding in review handles cleanly", async () => {
    const root = await mkTmpDir("cg-agent-packet-malformed-review-");
    await writeFile(root, "src/run.ts", "export function run() { return 1; }\n");

    await expect(getCodegraphPacket({ root, target: "review:base=%;head=HEAD" })).rejects.toThrow(
      "Invalid review packet target",
    );
  });

  it("packets the Swift type an extension header extends and rejects a handle to the header", async () => {
    const root = await mkTmpDir("cg-agent-packet-swift-extension-");
    await writeFixtureFiles(root, SWIFT_EXTENSION_OWNER_FILES);
    const buildOptions = { cache: "off" } as const;

    // The header's file sorts first, so only the declared-symbol rule makes the name resolve to the type.
    const byName = await getCodegraphPacket({ root, target: "Widget", buildOptions, maxDuplicates: 0 });
    expect(byName.kind).toBe("symbol");
    if (!("target" in byName.packet)) throw new Error("expected explanation packet");
    expect(byName.packet.target).toMatchObject({ kind: "symbol", file: "Models.swift", handle: SWIFT_NOMINAL_HANDLE });
    expect(byName.packet.symbols.map((symbol) => symbol.name)).toEqual(["Widget"]);
    expect(byName.packet.references.map((reference) => reference.file).sort()).toEqual([
      "Extensions.swift",
      "Models.swift",
    ]);

    const byHandle = await getCodegraphPacket({ root, target: SWIFT_NOMINAL_HANDLE, buildOptions, maxDuplicates: 0 });
    expect(byHandle.kind).toBe("symbol");

    await expect(
      getCodegraphPacket({ root, target: SWIFT_EXTENSION_OWNER_HANDLE, buildOptions, maxDuplicates: 0 }),
    ).rejects.toThrow("Packet target did not resolve");
  });
});
