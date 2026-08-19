import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCodegraphPacket, orientCodegraph } from "../src/agent.js";
import { DEFAULT_REVIEW_TRANSPORT_LIMITS } from "../src/review/types.js";
import { formatAgentFollowUpAsCli } from "../src/agent/followUps.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

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
    if (packet.packet.schemaVersion !== 1) {
      throw new Error("expected explanation packet");
    }
    expect(packet.packet.target.kind).toBe("symbol");
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
      symbols: 0,
      graphDelta: 0,
      candidateTests: 0,
    });
    if (packet.packet.schemaVersion !== 2) {
      throw new Error("expected review report");
    }
    expect(packet.packet.changedFiles).toHaveLength(DEFAULT_REVIEW_TRANSPORT_LIMITS.changedFiles);
    expect(packet.packet.changedFiles.every((file) => file.symbols.length <= DEFAULT_REVIEW_TRANSPORT_LIMITS.symbolsPerFile)).toBe(
      true,
    );
  });

  it("rejects malformed percent encoding in review handles cleanly", async () => {
    const root = await mkTmpDir("cg-agent-packet-malformed-review-");
    await writeFile(root, "src/run.ts", "export function run() { return 1; }\n");

    await expect(getCodegraphPacket({ root, target: "review:base=%;head=HEAD" })).rejects.toThrow(
      "Invalid review packet target",
    );
  });
});
