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

  it("uses the same default project file patterns when include roots cover the whole repo", async () => {
    const root = await mkTmpDir("cg-drift-snapshot-roots-");
    await writeFile(root, "src/a.ts", "export function a() { return 1; }\n");
    await writeFile(root, "notes.yaml", "ignored: true\n");

    const wholeRepo = await buildArchitectureSnapshot(root);
    const explicitWholeRepo = await buildArchitectureSnapshot(root, { includeRoots: ["."] });

    expect(explicitWholeRepo.files).toEqual(wholeRepo.files);
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

  it("does not report hotspot drift when scores are unchanged at threshold zero", () => {
    const base = makeSnapshot({ hotspots: [{ file: "src/core.ts", fanIn: 2, fanOut: 3, score: 7 }] });
    const head = makeSnapshot({ hotspots: [{ file: "src/core.ts", fanIn: 2, fanOut: 3, score: 7 }] });

    const report = compareArchitectureSnapshots(base, head, {
      failOn: [],
      thresholds: { hotspotJump: 0, maxFindings: 100 },
    });

    expect(report.findings.some((finding) => finding.kind === "hotspot-jump")).toBe(false);
    expect(report.findings.some((finding) => finding.kind === "hotspot-drop")).toBe(false);
  });

  it("applies fail-on policy even when matching findings are omitted from the report", () => {
    const base = makeSnapshot();
    const head = makeSnapshot({
      cycles: [{ key: "src/a.ts->src/b.ts", files: ["src/a.ts", "src/b.ts"], priorityScore: 20, size: 2 }],
    });

    const report = compareArchitectureSnapshots(base, head, {
      failOn: ["new-cycle"],
      thresholds: { hotspotJump: 20, maxFindings: 0 },
    });

    expect(report.findings).toEqual([]);
    expect(report.policy.failed).toBe(true);
    expect(report.policy.failedKinds).toEqual(["new-cycle"]);
  });

  it("does not say there are no findings when all findings are omitted", () => {
    const report = compareArchitectureSnapshots(
      makeSnapshot(),
      makeSnapshot({
        cycles: [{ key: "src/a.ts->src/b.ts", files: ["src/a.ts", "src/b.ts"], priorityScore: 20, size: 2 }],
      }),
      { failOn: [], thresholds: { hotspotJump: 20, maxFindings: 0 } },
    );

    const text = renderArchitectureDriftReport(report);

    expect(text).not.toContain("No architecture drift findings.");
    expect(text).toContain("All architecture drift findings were omitted by the current limit.");
    expect(text).toContain("Omitted 1 finding(s).");
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
