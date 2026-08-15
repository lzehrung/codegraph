import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import prepareQueryIndexWorkerTask from "../src/agent/query-index/queryIndexWorker.js";
import {
  MAX_QUERY_INDEX_TEXT_BYTES,
  prepareQueryIndexFile,
} from "../src/agent/query-index/content.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createRoot(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-query-prepare-"));
  roots.push(root);
  for (const [relative, source] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, source, "utf8");
  }
  return root;
}

describe("prepareQueryIndexWorkerTask", () => {
  it("prepares relative path, sourceIdentity, byteLength, and chunk ranges", async () => {
    const root = await createRoot({
      "src/hello.ts": "export function hello() {\n  return 1;\n}\n",
    });
    const prepared = await prepareQueryIndexWorkerTask({
      projectRoot: root,
      relativePath: "src/hello.ts",
      sourceIdentity: "identity-hello",
    });
    expect(prepared).not.toBeNull();
    expect(prepared).toMatchObject({
      path: "src/hello.ts",
      sourceIdentity: "identity-hello",
      sourceRead: true,
    });
    expect(prepared!.byteLength).toBeGreaterThan(0);
    expect(prepared!.chunks.length).toBeGreaterThan(0);
    for (const chunk of prepared!.chunks) {
      expect(chunk.startLine).toBeGreaterThan(0);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it("returns null when the relative file is missing", async () => {
    const root = await createRoot({ "src/present.ts": "export const present = true;\n" });
    const prepared = await prepareQueryIndexWorkerTask({
      projectRoot: root,
      relativePath: "src/missing.ts",
      sourceIdentity: "missing",
    });
    expect(prepared).toBeNull();
  });
});

describe("prepareQueryIndexFile branches", () => {
  it("skips source read for oversize files", async () => {
    const root = await createRoot({ "big.txt": "x" });
    const absolutePath = path.join(root, "big.txt");
    const handle = await fs.open(absolutePath, "w");
    try {
      await handle.truncate(MAX_QUERY_INDEX_TEXT_BYTES + 1);
    } finally {
      await handle.close();
    }
    const prepared = await prepareQueryIndexFile({
      absolutePath,
      path: "big.txt",
      sourceIdentity: "big",
    });
    expect(prepared).toMatchObject({
      path: "big.txt",
      sourceIdentity: "big",
      sourceRead: false,
      byteLength: MAX_QUERY_INDEX_TEXT_BYTES + 1,
      lineCount: 0,
      chunks: [],
    });
  });

  it("falls back to line chunks when semantic chunking throws", async () => {
    const root = await createRoot({
      "src/fallback.ts": "const a = 1;\nconst b = 2;\n",
    });
    const chunking = await import("../src/chunking/chunkFile.js");
    vi.spyOn(chunking, "chunkFile").mockImplementation(() => {
      throw new Error("semantic chunk boom");
    });
    const prepared = await prepareQueryIndexFile({
      absolutePath: path.join(root, "src/fallback.ts"),
      path: "src/fallback.ts",
      sourceIdentity: "fallback",
    });
    expect(prepared?.sourceRead).toBe(true);
    expect(prepared?.chunks.some((chunk) => chunk.kind === "line")).toBe(true);
  });

  it("returns null on read/stat errors", async () => {
    const prepared = await prepareQueryIndexFile({
      absolutePath: path.join(os.tmpdir(), "cg-query-prepare-missing", "nope.ts"),
      path: "nope.ts",
      sourceIdentity: "err",
    });
    expect(prepared).toBeNull();
  });
});
