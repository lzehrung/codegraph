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
    schemaVersion: 2,
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

  it("uses collision-safe cycle keys", () => {
    const ambiguousA = ["a->b", "c"];
    const ambiguousB = ["a", "b->c"];

    expect(ambiguousA.join("->")).toBe(ambiguousB.join("->"));
    expect(ambiguousA.join("\u0000")).not.toBe(ambiguousB.join("\u0000"));
  });

  it("reports new cycles without reporting pre-existing cycles", () => {
    const base = makeSnapshot({
      cycles: [
        { key: "src/old-a.ts\u0000src/old-b.ts", files: ["src/old-a.ts", "src/old-b.ts"], priorityScore: 10, size: 2 },
      ],
    });
    const head = makeSnapshot({
      cycles: [
        { key: "src/old-a.ts\u0000src/old-b.ts", files: ["src/old-a.ts", "src/old-b.ts"], priorityScore: 10, size: 2 },
        { key: "src/a.ts\u0000src/b.ts", files: ["src/a.ts", "src/b.ts"], priorityScore: 20, size: 2 },
      ],
    });

    const report = compareArchitectureSnapshots(base, head, { failOn: [] });

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: "new-cycle", severity: "error" }));
    expect(report.findings).not.toContainEqual(
      expect.objectContaining({ kind: "new-cycle", key: "src/old-a.ts\u0000src/old-b.ts" }),
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
    const head = makeSnapshot({
      duplicates: { groups: { total: 3 }, topGroupKeys: ["a.ts:1-b.ts:1", "c.ts:1-d.ts:1"] },
    });

    const report = compareArchitectureSnapshots(base, head, { failOn: [] });

    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: "duplicate-increase", severity: "warning", before: 1, after: 3 }),
    );
  });

  it("summarizes graph edge drift by source file when requested", () => {
    const base = makeSnapshot({
      graphEdges: [{ key: "src/a.ts\u0000./b\u0000src/b.ts", from: "src/a.ts", to: "src/b.ts", raw: "./b" }],
    });
    const head = makeSnapshot({
      graphEdges: [
        { key: "src/a.ts\u0000./b\u0000src/b.ts", from: "src/a.ts", to: "src/b.ts", raw: "./b" },
        { key: "src/a.ts\u0000./c\u0000src/c.ts", from: "src/a.ts", to: "src/c.ts", raw: "./c" },
        { key: "src/a.ts\u0000./d\u0000src/d.ts", from: "src/a.ts", to: "src/d.ts", raw: "./d" },
      ],
    });

    const report = compareArchitectureSnapshots(base, head, { graphEdges: "summary" });

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "graph-edge-added",
        file: "src/a.ts",
        details: expect.objectContaining({ count: 2 }),
      }),
    );
    expect(report.findings.some((finding) => finding.edge?.to === "src/c.ts")).toBe(false);
  });

  it("suppresses graph edge drift when graph edges are disabled", () => {
    const base = makeSnapshot();
    const head = makeSnapshot({
      graphEdges: [{ key: "src/a.ts\0./b\0src/b.ts", from: "src/a.ts", to: "src/b.ts", raw: "./b" }],
    });

    const report = compareArchitectureSnapshots(base, head, { graphEdges: "off" });

    expect(report.findings.some((finding) => finding.kind === "graph-edge-added")).toBe(false);
  });

  it("reports a type-only to runtime edge change instead of add/remove churn", () => {
    const base = makeSnapshot({
      graphEdges: [
        {
          key: "src/a.ts\0./b\0src/b.ts\0type-only",
          from: "src/a.ts",
          to: "src/b.ts",
          raw: "./b",
          typeOnly: true,
        },
      ],
    });
    const head = makeSnapshot({
      graphEdges: [
        {
          key: "src/a.ts\0./b\0src/b.ts\0runtime",
          from: "src/a.ts",
          to: "src/b.ts",
          raw: "./b",
          typeOnly: false,
        },
      ],
    });

    const report = compareArchitectureSnapshots(base, head, { failOn: [] });

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "graph-edge-type-changed",
        severity: "warning",
        file: "src/a.ts",
        details: { beforeTypeOnly: true, afterTypeOnly: false },
      }),
    );
    expect(report.findings.some((finding) => finding.kind === "graph-edge-added")).toBe(false);
    expect(report.findings.some((finding) => finding.kind === "graph-edge-removed")).toBe(false);
  });

  it("reports a runtime to type-only edge change as info in summary mode", () => {
    const base = makeSnapshot({
      graphEdges: [
        { key: "src/a.ts\0./b\0src/b.ts\0runtime", from: "src/a.ts", to: "src/b.ts", raw: "./b", typeOnly: false },
      ],
    });
    const head = makeSnapshot({
      graphEdges: [
        { key: "src/a.ts\0./b\0src/b.ts\0type-only", from: "src/a.ts", to: "src/b.ts", raw: "./b", typeOnly: true },
      ],
    });

    const report = compareArchitectureSnapshots(base, head, { failOn: [], graphEdges: "summary" });

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "graph-edge-type-changed",
        severity: "info",
        details: { beforeTypeOnly: false, afterTypeOnly: true },
      }),
    );
    expect(report.findings.some((finding) => finding.kind === "graph-edge-added")).toBe(false);
    expect(report.findings.some((finding) => finding.kind === "graph-edge-removed")).toBe(false);
  });

  it("detects a type-only import becoming a runtime dependency", async () => {
    const root = await mkTmpDir("cg-drift-type-only-");
    await writeFile(root, "src/b.ts", "export function b() { return 1; }\nexport type B = number;\n");
    await writeFile(root, "src/a.ts", "import type { B } from './b';\nexport function a(value: B) { return value; }\n");
    const base = await buildArchitectureSnapshot(root, { includeRoots: ["src"] });
    expect(base.graphEdges.some((edge) => edge.typeOnly)).toBe(true);

    await writeFile(root, "src/a.ts", "import { b } from './b';\nexport function a() { return b(); }\n");
    const head = await buildArchitectureSnapshot(root, { includeRoots: ["src"] });

    const report = compareArchitectureSnapshots(base, head, { failOn: [] });

    const finding = report.findings.find((entry) => entry.kind === "graph-edge-type-changed");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(finding?.edge?.to).toBe("src/b.ts");
    expect(report.findings.some((entry) => entry.kind === "graph-edge-added")).toBe(false);
    expect(report.findings.some((entry) => entry.kind === "graph-edge-removed")).toBe(false);
  });

  it("keeps duplicate group keys stable when lines shift above unchanged clones", async () => {
    const root = await mkTmpDir("cg-drift-duplicates-");
    const cloneA = `
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
    const cloneB = `
export function summarizeLedgerEntries(entries: Array<{ credit: number; debit: number; note: string }>) {
  let balance = 0;
  const notes: string[] = [];
  entries.forEach((entry, position) => {
    balance += entry.credit - entry.debit;
    if (entry.note.length) {
      notes.push(position + ":" + entry.note.trim());
    }
  });
  const average = entries.length ? balance / entries.length : 0;
  return { balance: Math.round(balance * 100) / 100, average, notes: notes.join(";") };
}
`;
    await writeFile(root, "src/dupA1.ts", cloneA);
    await writeFile(root, "src/dupA2.ts", cloneA);
    await writeFile(root, "src/dupB1.ts", cloneB);
    await writeFile(root, "src/dupB2.ts", cloneB);
    const base = await buildArchitectureSnapshot(root);
    expect(base.duplicates.groups.total).toBe(2);
    expect(base.duplicates.topGroupKeys).toHaveLength(2);

    const shiftedA = `// leading comment shifts every line below\n${cloneA}`;
    await writeFile(root, "src/dupA1.ts", shiftedA);
    await writeFile(root, "src/dupA2.ts", shiftedA);
    await writeFile(root, "src/dupB2.ts", "export function replacement() { return 42; }\n");
    const head = await buildArchitectureSnapshot(root);
    expect(head.duplicates.groups.total).toBe(1);

    const report = compareArchitectureSnapshots(base, head, { failOn: [] });

    const finding = report.findings.find((entry) => entry.kind === "duplicate-decrease");
    expect(finding).toBeDefined();
    expect(finding?.details?.newTopGroupKeys).toEqual([]);
    expect(finding?.details?.resolvedTopGroupKeys).toHaveLength(1);
    const unchangedKey = base.duplicates.topGroupKeys.find((key) => head.duplicates.topGroupKeys.includes(key));
    expect(unchangedKey).toBeDefined();
    expect(finding?.details?.resolvedTopGroupKeys).not.toContain(unchangedKey);
  });

  it("reports duplicate top group additions and removals", () => {
    const base = makeSnapshot({ duplicates: { groups: { total: 2 }, topGroupKeys: ["a<->b", "c<->d"] } });
    const head = makeSnapshot({ duplicates: { groups: { total: 3 }, topGroupKeys: ["a<->b", "e<->f", "g<->h"] } });

    const report = compareArchitectureSnapshots(base, head, { failOn: [] });
    const finding = report.findings.find((entry) => entry.kind === "duplicate-increase");

    expect(finding?.details).toEqual(
      expect.objectContaining({
        newTopGroupKeys: ["e<->f", "g<->h"],
        resolvedTopGroupKeys: ["c<->d"],
      }),
    );
  });

  it("applies fail-on policy only to selected finding kinds", () => {
    const base = makeSnapshot({
      publicApi: [{ id: "src/api.ts#old:function", file: "src/api.ts", name: "old", kind: "function" }],
    });
    const head = makeSnapshot({ publicApi: [] });

    const ignored = compareArchitectureSnapshots(base, head, { failOn: ["new-cycle"] });
    const selected = compareArchitectureSnapshots(base, head, { failOn: ["public-api-removal"] });

    expect(ignored.policy.failed).toBe(false);
    expect(selected.policy.failed).toBe(true);
    expect(selected.policy.failedKinds).toEqual(["public-api-removal"]);
  });

  it("suppresses public API additions by default in compact mode", () => {
    const base = makeSnapshot();
    const head = makeSnapshot({
      publicApi: [{ id: "src/api.ts#new:function", file: "src/api.ts", name: "new", kind: "function" }],
    });

    const report = compareArchitectureSnapshots(base, head, { format: "compact" });

    expect(report.findings.some((finding) => finding.kind === "public-api-addition")).toBe(false);
  });

  it("supports explicit public API filtering", () => {
    const base = makeSnapshot({
      publicApi: [{ id: "src/api.ts#old:function", file: "src/api.ts", name: "old", kind: "function" }],
    });
    const head = makeSnapshot({
      publicApi: [{ id: "src/api.ts#new:function", file: "src/api.ts", name: "new", kind: "function" }],
    });

    const removalsOnly = compareArchitectureSnapshots(base, head, { publicApi: "removals" });
    const disabled = compareArchitectureSnapshots(base, head, { publicApi: "off" });

    expect(removalsOnly.findings.some((finding) => finding.kind === "public-api-addition")).toBe(false);
    expect(removalsOnly.findings.some((finding) => finding.kind === "public-api-removal")).toBe(true);
    expect(disabled.findings.some((finding) => finding.kind.startsWith("public-api"))).toBe(false);
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
      cycles: [{ key: "src/a.ts\u0000src/b.ts", files: ["src/a.ts", "src/b.ts"], priorityScore: 20, size: 2 }],
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
        cycles: [{ key: "src/a.ts\u0000src/b.ts", files: ["src/a.ts", "src/b.ts"], priorityScore: 20, size: 2 }],
      }),
      { failOn: [], thresholds: { hotspotJump: 20, maxFindings: 0 } },
    );

    const text = renderArchitectureDriftReport(report);

    expect(text).not.toContain("No architecture drift findings.");
    expect(text).toContain("All architecture drift findings were omitted by the current limit.");
    expect(text).toContain("Omitted 1 finding(s).");
  });

  it("emits compact drift reports with summary counts", () => {
    const report = compareArchitectureSnapshots(
      makeSnapshot(),
      makeSnapshot({
        cycles: [{ key: "src/a.ts\u0000src/b.ts", files: ["src/a.ts", "src/b.ts"], priorityScore: 20, size: 2 }],
        graphEdges: [{ key: "src/a.ts\u0000./b\u0000src/b.ts", from: "src/a.ts", to: "src/b.ts", raw: "./b" }],
      }),
      { format: "compact", graphEdges: "summary" },
    );

    expect(report.format).toBe("compact");
    expect(report.summary).toEqual(
      expect.objectContaining({
        byKind: expect.objectContaining({ "new-cycle": 1, "graph-edge-added": 1 }),
        bySeverity: expect.objectContaining({ error: 1, info: 1 }),
      }),
    );
  });

  it("renders a short grouped pretty report", () => {
    const report = compareArchitectureSnapshots(
      makeSnapshot({
        publicApi: [{ id: "src/api.ts#oldName:function", file: "src/api.ts", name: "oldName", kind: "function" }],
      }),
      makeSnapshot({
        cycles: [{ key: "src/a.ts\u0000src/b.ts", files: ["src/a.ts", "src/b.ts"], priorityScore: 20, size: 2 }],
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
