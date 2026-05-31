import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCodegraphPacket, orientCodegraph } from "../src/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("agent packet", () => {
  it("retrieves a file packet from an orientation handle", async () => {
    const root = await mkTmpDir("cg-agent-packet-");
    await writeFile(root, "src/run.ts", "export function run() { return 1; }\n");

    const orient = await orientCodegraph({ root, includeRoots: ["src"], budget: "small" });
    const fileHandle = orient.handles.find((handle) => handle.kind === "file");
    if (!fileHandle) {
      throw new Error("expected file handle");
    }

    const packet = await getCodegraphPacket({ root, handle: fileHandle.handle });

    expect(packet.schemaVersion).toBe(1);
    expect(packet.kind).toBe("file");
    expect(packet.followUps.length).toBeGreaterThan(0);
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

    const packet = await getCodegraphPacket({ root, handle: "file:src%2Fa.ts", maxDuplicates: 1 });

    if (packet.packet.schemaVersion !== 1 || !("duplicates" in packet.packet)) {
      throw new Error("expected explanation packet");
    }
    expect(packet.packet.duplicates).toHaveLength(1);
    expect(packet.omittedCounts.duplicates).toBe(0);
  });

  it("retrieves review packets from orientation handles", async () => {
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
    const reviewHandle = orient.handles.find((handle) => handle.kind === "review");
    if (!reviewHandle) {
      throw new Error("expected review handle");
    }

    const packet = await getCodegraphPacket({ root, handle: reviewHandle.handle });

    expect(packet.schemaVersion).toBe(1);
    expect(packet.kind).toBe("review");
    expect(packet.followUps.some((command) => command.includes("codegraph review"))).toBeTruthy();
    if (packet.packet.schemaVersion !== 2) {
      throw new Error("expected review report");
    }
    expect(packet.packet.summary.symbolsChanged).toBeGreaterThan(0);
    expect(Array.isArray(packet.packet.candidateTests)).toBeTruthy();
  });

  it("rejects malformed percent encoding in review handles cleanly", async () => {
    const root = await mkTmpDir("cg-agent-packet-malformed-review-");
    await writeFile(root, "src/run.ts", "export function run() { return 1; }\n");

    await expect(getCodegraphPacket({ root, handle: "review:base=%;head=HEAD" })).rejects.toThrow(
      "Invalid review packet handle",
    );
  });
});
