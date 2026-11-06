import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectIndex, findReferences, goToDefinition } from "../src/index.js";
import { resolveExport, setExportCacheLimitForTests } from "../src/indexer/navigation-resolve.js";
import type { ProjectIndex, ResolvedExport } from "../src/indexer/types.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  setExportCacheLimitForTests();
  await roots.cleanup();
});

const MODULE_COUNT = 12;
const MODULES = Array.from({ length: MODULE_COUNT }, (_, index) => `m${index}.ts`);
const FILES = [...MODULES, "left.ts", "right.ts", "barrel.ts", "named.ts", "ns.ts", "cycleA.ts", "cycleB.ts"];
const NAMES = [
  ...Array.from({ length: MODULE_COUNT }, (_, index) => `v${index}`),
  "shared",
  "renamed",
  "missing",
  "inner",
  "a",
  "b",
  "absent",
  "hidden3",
];

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, contents] of Object.entries(files)) await fsp.writeFile(path.join(root, name), contents, "utf8");
}

/** Plain exports, a local that is not exported, competing star exports, renames, a namespace, and a re-export cycle. */
async function createProject(): Promise<string> {
  const root = await roots.create("cg-export-cache-");
  const files: Record<string, string> = {};
  MODULES.forEach((name, index) => {
    files[name] = `export const v${index} = ${index};\nconst hidden${index} = ${index};\n`;
  });
  files["left.ts"] = "export const shared = 'left';\n";
  files["right.ts"] = "export const shared = 'right';\n";
  files["barrel.ts"] =
    `${[...MODULES, "left.ts", "right.ts"].map((name) => `export * from './${name.replace(".ts", "")}';`).join("\n")}\n`;
  files["named.ts"] = "export { v3 as renamed, missing } from './m3';\n";
  files["ns.ts"] = "export * as inner from './m4';\n";
  files["cycleA.ts"] = "export { b as a } from './cycleB';\n";
  files["cycleB.ts"] = "export { a as b } from './cycleA';\n";
  await writeFiles(root, files);
  return root;
}

function show(hit: ResolvedExport | null): string {
  if (!hit) return "null";
  if (hit.kind === "namespace") return `namespace ${path.basename(hit.file)}`;
  return `${path.basename(hit.def.file)}:${hit.def.localName}`;
}

type Lookup = { file: string; name: string; fallback: boolean };

const LOOKUPS: Lookup[] = FILES.flatMap((file) =>
  NAMES.flatMap((name) => [true, false].map((fallback) => ({ file, name, fallback }))),
);

function lookupAll(
  index: ProjectIndex,
  root: string,
  lookups: readonly Lookup[],
  afterLookup?: (cacheSize: number) => void,
): string[] {
  return lookups.map(({ file, name, fallback }) => {
    const target = path.join(root, file).replace(/\\/g, "/");
    const hit = resolveExport(index, target, name, fallback ? undefined : { allowLocalFallback: false });
    afterLookup?.(index.exportCache.size);
    return `${file}#${name}#${fallback ? "fallback" : "exports"}=${show(hit)}`;
  });
}

describe("resolveExport cache", () => {
  it("keeps nothing for a module that has no entry under the name, and still resolves the names it has", async () => {
    const root = await createProject();
    const index = await buildProjectIndex(root);
    const at = (file: string): string => path.join(root, file).replace(/\\/g, "/");

    for (const file of MODULES) expect(resolveExport(index, at(file), "absent")).toBeNull();

    // One entry per module and absent name is what grew without bound on a large project.
    expect(index.exportCache.size).toBe(0);
    expect(show(resolveExport(index, at("m5.ts"), "v5"))).toBe("m5.ts:v5");
    // A local that is not exported is found through the fallback and only through it.
    expect(show(resolveExport(index, at("m5.ts"), "hidden5"))).toBe("m5.ts:hidden5");
    expect(resolveExport(index, at("m5.ts"), "hidden5", { allowLocalFallback: false })).toBeNull();
    expect(resolveExport(index, at("barrel.ts"), "shared")).toBeNull();
    expect(show(resolveExport(index, at("barrel.ts"), "v7"))).toBe("m7.ts:v7");
    expect(show(resolveExport(index, at("ns.ts"), "inner"))).toBe("namespace m4.ts");
  });

  it("answers the same with the cache held to a few entries, in either order", async () => {
    const root = await createProject();
    const unlimited = await buildProjectIndex(root);
    const expected = lookupAll(unlimited, root, LOOKUPS);
    const unlimitedSize = unlimited.exportCache.size;

    // A limit of one starts every lookup cold, which shows the most entries a single lookup adds.
    setExportCacheLimitForTests(1);
    let mostAddedByOneLookup = 0;
    expect(
      lookupAll(await buildProjectIndex(root), root, LOOKUPS, (size) => {
        mostAddedByOneLookup = Math.max(mostAddedByOneLookup, size);
      }),
    ).toEqual(expected);

    const limit = 3;
    setExportCacheLimitForTests(limit);
    let largest = 0;
    const forward = lookupAll(await buildProjectIndex(root), root, LOOKUPS, (size) => {
      largest = Math.max(largest, size);
    });
    const backward = lookupAll(await buildProjectIndex(root), root, [...LOOKUPS].reverse());

    expect(forward).toEqual(expected);
    expect(backward.sort()).toEqual([...expected].sort());
    expect(largest).toBeLessThanOrEqual(limit + mostAddedByOneLookup);
    // The workload really outgrows that bound, so the limit is what held it down.
    expect(unlimitedSize).toBeGreaterThan(limit + mostAddedByOneLookup);
  });

  it("reuses uncut positive and negative answers inside a cycle without changing consumer results", async () => {
    const root = await roots.create("cg-export-cache-cycle-interior-");
    await writeFiles(root, {
      "source.ts": "export function target() { return 1; }\n",
      "empty.ts": "export const other = 1;\n",
      "hit.ts": "export * from './source';\n",
      "miss.ts": "export * from './empty';\n",
      "a.ts": "export * from './b';\nexport * from './miss';\n",
      "b.ts": "export * from './a';\nexport * from './hit';\n",
      "consumer.ts": "import { target } from './a';\nexport function use() { return target(); }\n",
    });
    const index = await buildProjectIndex(root, { cache: "off" });
    const at = (file: string): string => path.join(root, file).replace(/\\/g, "/");
    for (const warmOrder of [
      ["hit.ts", "miss.ts"],
      ["miss.ts", "hit.ts"],
    ]) {
      index.exportCache.clear();
      for (const file of warmOrder) {
        expect(show(resolveExport(index, at(file), "target"))).toBe(file === "hit.ts" ? "source.ts:target" : "null");
      }
      expect([...index.exportCache.values()]).toContain(null);
      for (const file of ["a.ts", "b.ts"]) {
        expect(show(resolveExport(index, at(file), "target"))).toBe("source.ts:target");
      }
      const goto = await goToDefinition(index, { file: at("consumer.ts"), line: 2, column: 32 });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.file).toBe(at("source.ts"));
      const references = await findReferences(index, { file: at("source.ts"), line: 1, column: 17 });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected cycle target references");
      expect(
        references.references
          .filter((reference) => reference.file === at("consumer.ts"))
          .map((reference) => reference.range.start.line)
          .sort(),
      ).toEqual([1, 2]);
      expect(references.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    }
  });

  it("never serves one module the entry of another when an index copy shares the cache", async () => {
    const root = await roots.create("cg-export-cache-copy-");
    const files: Record<string, string> = {};
    for (let index = 0; index < 6; index += 1) files[`p${index}.ts`] = `export const common = ${index};\n`;
    await writeFiles(root, files);
    const index = await buildProjectIndex(root);
    const lookups = Array.from({ length: 6 }, (_, number) => ({
      file: `p${number}.ts`,
      name: "common",
      fallback: true,
    }));
    // Without its first module every other module sits one place earlier, so a position-based id would collide.
    const copy: ProjectIndex = { ...index, byFile: new Map([...index.byFile].slice(1)) };

    const original = lookupAll(index, root, lookups);
    const viaCopy = lookupAll(copy, root, lookups.slice(1));

    expect(copy.exportCache).toBe(index.exportCache);
    expect(viaCopy).toEqual(original.slice(1));
    expect(new Set(viaCopy).size).toBe(viaCopy.length);
  });
});
