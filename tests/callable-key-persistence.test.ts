import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex, buildProjectIndexIncremental, goToDefinition, type BuildReport } from "../src/index.js";
import { writeProjectIndexSnapshot } from "../src/indexer/build-cache/project-snapshot.js";
import { closeDiskCacheDatabase } from "../src/indexer/build-cache/module-cache.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { fileIdentityKey } from "../src/util/paths.js";

const files = {
  "a.ts": "export function run() { return 1; }\n",
  "b.ts": "export function run() { return 2; }\n",
  "caller.ts": 'import { run } from "./a";\nexport function call() { return run(); }\n',
};

async function writeFixture(root: string): Promise<void> {
  for (const [filename, source] of Object.entries(files)) {
    await fs.writeFile(path.join(root, filename), source);
  }
}

function cachedCallables(root: string): Array<{ file: string; key: string }> {
  const db = new DatabaseSync(path.join(root, ".codegraph", "cache", "index-v1", "index-cache.sqlite"));
  try {
    const rows = db.prepare("SELECT payload FROM module_cache").all() as Array<{ payload: Uint8Array }>;
    return rows.flatMap((row) => {
      const module = JSON.parse(brotliDecompressSync(row.payload).toString("utf8")) as {
        locals: Array<{ file: string; callable?: { key: string } }>;
      };
      return module.locals.flatMap((local) => (local.callable ? [{ file: local.file, key: local.callable.key }] : []));
    });
  } finally {
    db.close();
  }
}

describe("portable callable identities", () => {
  it("stores file-relative, file-distinct callable keys in disk rows and embedded snapshots", async () => {
    const root = await mkTmpDir("cg-callable-persist-");
    try {
      await writeFixture(root);
      const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
      closeDiskCacheDatabase(root, { cache: "disk" });
      const rows = cachedCallables(root);
      expect(rows.filter((row) => row.file === "a.ts" || row.file === "b.ts")).toHaveLength(2);
      expect(new Set(rows.filter((row) => row.file !== "caller.ts").map((row) => row.key)).size).toBe(2);
      expect(rows.some((row) => row.key.includes(root.replace(/\\/g, "/")))).toBe(false);

      await writeProjectIndexSnapshot(root, { cache: "memory" }, index, "fixture");
      const snapshotFile = path.join(root, ".codegraph", "cache", "index-v1", "project-index-snapshot.json");
      const snapshot = JSON.parse(brotliDecompressSync(await fs.readFile(snapshotFile)).toString("utf8")) as {
        modules: Array<{ locals: Array<{ file: string; callable?: { key: string } }> }>;
      };
      const keys = snapshot.modules.flatMap((module) =>
        module.locals.flatMap((local) => (local.callable ? [{ file: local.file, key: local.callable.key }] : [])),
      );
      expect(keys.filter((row) => row.file === "a.ts" || row.file === "b.ts")).toHaveLength(2);
      expect(new Set(keys.filter((row) => row.file !== "caller.ts").map((row) => row.key)).size).toBe(2);
      expect(keys.some((row) => row.key.includes(root.replace(/\\/g, "/")))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps callable identity and navigation after moving a disk-cached project", async () => {
    const root = await mkTmpDir("cg-callable-move-");
    const movedRoot = `${root}-moved`;
    try {
      await writeFixture(root);
      await buildProjectIndex(root, { cache: "disk", threads: 1 });
      closeDiskCacheDatabase(root, { cache: "disk" });
      await fs.cp(root, movedRoot, { recursive: true });
      const report: BuildReport = { timings: {} };
      const index = await buildProjectIndexIncremental(movedRoot, { cache: "disk", threads: 1, report });
      const target = path.join(movedRoot, "a.ts").replace(/\\/g, "/");
      const decoy = path.join(movedRoot, "b.ts").replace(/\\/g, "/");
      const caller = path.join(movedRoot, "caller.ts");
      const goto = await goToDefinition(index, {
        file: caller,
        line: 2,
        column: files["caller.ts"].split("\n")[1]!.lastIndexOf("run") + 1,
      });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.file).toBe(target);
      const graph = await buildSymbolGraphDetailed(index);
      const callerNode = [...graph.nodes.values()].find(
        (node) => node.name === "call" && node.file === caller.replace(/\\/g, "/"),
      );
      const calls = graph.edges
        .filter((edge) => edge.label === "calls" && edge.from === callerNode?.id)
        .map((edge) => graph.nodes.get(edge.to)?.file);
      expect(calls).toContain(target);
      expect(calls).not.toContain(decoy);
      expect(report.cache?.misses ?? 0).toBe(0);
      const aKey = index.byFile.get(fileIdentityKey(target))?.locals.find((local) => local.localName === "run")
        ?.callable?.key;
      const bKey = index.byFile.get(fileIdentityKey(decoy))?.locals.find((local) => local.localName === "run")
        ?.callable?.key;
      expect(aKey).toBeDefined();
      expect(bKey).toBeDefined();
      expect(aKey).not.toBe(bKey);
      expect(aKey?.startsWith(target)).toBe(true);
      expect(aKey?.includes(root.split(path.sep).join("/") + "/")).toBe(false);
    } finally {
      closeDiskCacheDatabase(root, { cache: "disk" });
      closeDiskCacheDatabase(movedRoot, { cache: "disk" });
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(movedRoot, { recursive: true, force: true });
    }
  });
});
