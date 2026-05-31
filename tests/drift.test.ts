import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildArchitectureSnapshot,
  compareArchitectureSnapshots,
  renderArchitectureDriftReport,
  type ArchitectureSnapshot,
} from "../src/drift/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";

async function writeFile(root: string, file: string, content: string): Promise<void> {
  const fullPath = path.join(root, file);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content, "utf8");
}

function makeSnapshot(overrides: Partial<ArchitectureSnapshot> = {}): ArchitectureSnapshot {
  return {
    schemaVersion: 1,
    root: "/repo",
    files: { total: 0, byLanguage: {} },
    hotspots: [],
    cycles: [],
    unresolved: { total: 0, imports: [] },
    publicApi: [],
    duplicates: { groups: { total: 0 }, topGroupKeys: [] },
    graphEdges: [],
    ...overrides,
  };
}

describe("architecture drift", () => {
  it("builds a deterministic architecture snapshot", async () => {
    const root = await mkTmpDir("cg-drift-snapshot-");
    await writeFile(root, "src/a.ts", "import { b } from './b'; export function a() { return b(); }\n");
    await writeFile(root, "src/b.ts", "export function b() { return 1; }\n");

    const first = await buildArchitectureSnapshot(root, { includeRoots: ["src"] });
    const second = await buildArchitectureSnapshot(root, { includeRoots: ["src"] });

    expect(first).toEqual(second);
    expect(first.files.total).toBe(2);
    expect(first.files.byLanguage.typescript).toBe(2);
    expect(first.unresolved.total).toBe(0);
    expect(first.hotspots.length).toBeGreaterThan(0);
    expect(first.cycles).toEqual([]);
  });

  it("reports new cycles without reporting pre-existing cycles", () => {
    const base = makeSnapshot({
      cycles: [{ key: "src/old-a.ts->src/old-b.ts", files: ["src/old-a.ts", "src/old-b.ts"], priorityScore: 10, size: 2 }],
    });
    const head = makeSnapshot({
      cycles: [
        { key: "src/old-a.ts->src/old-b.ts", files: ["src/old-a.ts", "src/old-b.ts"], priorityScore: 10, size: 2 },
        { key: "src/a.ts->src/b.ts", files: ["src/a.ts", "src/b.ts"], priorityScore: 20, size: 2 },
      ],
    });

    const report = compareArchitectureSnapshots(base, head, { failOn: [] });

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: "new-cycle", severity: "error" }));
    expect(report.findings).not.toContainEqual(
      expect.objectContaining({ kind: "new-cycle", key: "src/old-a.ts->src/old-b.ts" }),
    );
  });

  it("reports public API removals", () => {
    const base = makeSnapshot({
      publicApi: [{ id: "src/api.ts#oldName:function", file: "src/api.ts", name: "oldName", kind: "function" }],
    });
    const head = makeSnapshot({ publicApi: [] });

    const report = compareArchitectureSnapshots(base, head, { failOn: [] });

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: "public-api-removal", severity: "error" }));
  });

  it("compares duplicate group counts and stable top group keys", () => {
    const base = makeSnapshot({ duplicates: { groups: { total: 1 }, topGroupKeys: ["a.ts:1-b.ts:1"] } });
    const head = makeSnapshot({ duplicates: { groups: { total: 3 }, topGroupKeys: ["a.ts:1-b.ts:1", "c.ts:1-d.ts:1"] } });

    const report = compareArchitectureSnapshots(base, head, { failOn: [] });

    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: "duplicate-increase", severity: "warning", before: 1, after: 3 }),
    );
  });

  it("applies fail-on policy only to selected finding kinds", () => {
    const base = makeSnapshot({ publicApi: [{ id: "src/api.ts#old:function", file: "src/api.ts", name: "old", kind: "function" }] });
    const head = makeSnapshot({ publicApi: [] });

    const ignored = compareArchitectureSnapshots(base, head, { failOn: ["new-cycle"] });
    const selected = compareArchitectureSnapshots(base, head, { failOn: ["public-api-removal"] });

    expect(ignored.policy.failed).toBe(false);
    expect(selected.policy.failed).toBe(true);
    expect(selected.policy.failedKinds).toEqual(["public-api-removal"]);
  });

  it("renders a short grouped pretty report", () => {
    const report = compareArchitectureSnapshots(
      makeSnapshot({ publicApi: [{ id: "src/api.ts#oldName:function", file: "src/api.ts", name: "oldName", kind: "function" }] }),
      makeSnapshot({
        cycles: [{ key: "src/a.ts->src/b.ts", files: ["src/a.ts", "src/b.ts"], priorityScore: 20, size: 2 }],
        hotspots: [{ file: "src/core.ts", fanIn: 20, fanOut: 32, score: 72 }],
      }),
      { failOn: [], thresholds: { hotspotJump: 20, maxFindings: 100 } },
    );

    const text = renderArchitectureDriftReport(report, { limit: 10 });

    expect(text).toContain("Architecture drift");
    expect(text).toContain("Errors");
    expect(text).toContain("- new-cycle: src/a.ts -> src/b.ts");
    expect(text).toContain("- public-api-removal: src/api.ts#oldName");
    expect(text).toContain("Warnings");
    expect(text).toContain("- hotspot-jump: src/core.ts score 0 -> 72");
  });
});
