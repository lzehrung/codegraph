import type {
  ArchitectureCycle,
  ArchitectureDriftCompareOptions,
  ArchitectureDriftFinding,
  ArchitectureDriftFindingKind,
  ArchitectureDriftGraphEdgesMode,
  ArchitectureDriftPublicApiMode,
  ArchitectureDriftReport,
  ArchitectureDriftSummary,
  ArchitectureDriftThresholds,
  ArchitectureGraphEdge,
  ArchitectureHotspot,
  ArchitecturePublicApiSymbol,
  ArchitectureSnapshot,
  ArchitectureSnapshotSummary,
  ArchitectureUnresolvedImport,
} from "./types.js";

export const DEFAULT_DRIFT_THRESHOLDS: ArchitectureDriftThresholds = {
  hotspotJump: 20,
  maxFindings: 100,
} as const;

export const ARCHITECTURE_DRIFT_FINDING_KINDS: readonly ArchitectureDriftFindingKind[] = [
  "new-cycle",
  "resolved-cycle",
  "hotspot-jump",
  "hotspot-drop",
  "unresolved-import",
  "resolved-unresolved-import",
  "public-api-addition",
  "public-api-removal",
  "duplicate-increase",
  "duplicate-decrease",
  "graph-edge-added",
  "graph-edge-removed",
] as const;

function summarize(snapshot: ArchitectureSnapshot): ArchitectureSnapshotSummary {
  return {
    root: snapshot.root,
    files: snapshot.files,
    hotspots: snapshot.hotspots,
    cycles: snapshot.cycles,
    unresolved: snapshot.unresolved,
    publicApi: snapshot.publicApi,
    duplicates: snapshot.duplicates,
  };
}

function byKey<T extends { key: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.key, item]));
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function pushNewCycle(findings: ArchitectureDriftFinding[], cycle: ArchitectureCycle): void {
  findings.push({
    kind: "new-cycle",
    severity: "error",
    key: cycle.key,
    title: `New dependency cycle: ${cycle.files.join(" -> ")}`,
    files: cycle.files,
    after: cycle.priorityScore,
  });
}

function pushResolvedCycle(findings: ArchitectureDriftFinding[], cycle: ArchitectureCycle): void {
  findings.push({
    kind: "resolved-cycle",
    severity: "info",
    key: cycle.key,
    title: `Resolved dependency cycle: ${cycle.files.join(" -> ")}`,
    files: cycle.files,
    before: cycle.priorityScore,
  });
}

function compareCycles(findings: ArchitectureDriftFinding[], base: readonly ArchitectureCycle[], head: readonly ArchitectureCycle[]): void {
  const baseByKey = byKey(base);
  const headByKey = byKey(head);
  for (const cycle of headByKey.values()) {
    if (!baseByKey.has(cycle.key)) pushNewCycle(findings, cycle);
  }
  for (const cycle of baseByKey.values()) {
    if (!headByKey.has(cycle.key)) pushResolvedCycle(findings, cycle);
  }
}

function compareHotspots(
  findings: ArchitectureDriftFinding[],
  base: readonly ArchitectureHotspot[],
  head: readonly ArchitectureHotspot[],
  threshold: number,
): void {
  const baseByFile = new Map(base.map((entry) => [entry.file, entry]));
  const headByFile = new Map(head.map((entry) => [entry.file, entry]));
  const files = Array.from(new Set([...baseByFile.keys(), ...headByFile.keys()])).sort();
  for (const file of files) {
    const before = baseByFile.get(file)?.score ?? 0;
    const after = headByFile.get(file)?.score ?? 0;
    const delta = after - before;
    if (!delta || Math.abs(delta) < threshold) continue;
    const kind: ArchitectureDriftFindingKind = delta > 0 ? "hotspot-jump" : "hotspot-drop";
    findings.push({
      kind,
      severity: delta > 0 ? "warning" : "info",
      key: file,
      title: `${kind === "hotspot-jump" ? "Hotspot increased" : "Hotspot decreased"}: ${file} score ${before} -> ${after}`,
      file,
      before,
      after,
    });
  }
}

function pushUnresolved(
  findings: ArchitectureDriftFinding[],
  kind: "unresolved-import" | "resolved-unresolved-import",
  item: ArchitectureUnresolvedImport,
): void {
  findings.push({
    kind,
    severity: kind === "unresolved-import" ? "error" : "info",
    key: item.key,
    title: `${kind === "unresolved-import" ? "New unresolved import" : "Resolved unresolved import"}: ${item.file} imports ${item.specifier}`,
    file: item.file,
    specifier: item.specifier,
  });
}

function compareUnresolved(
  findings: ArchitectureDriftFinding[],
  base: readonly ArchitectureUnresolvedImport[],
  head: readonly ArchitectureUnresolvedImport[],
): void {
  const baseByKey = byKey(base);
  const headByKey = byKey(head);
  for (const item of headByKey.values()) {
    if (!baseByKey.has(item.key)) pushUnresolved(findings, "unresolved-import", item);
  }
  for (const item of baseByKey.values()) {
    if (!headByKey.has(item.key)) pushUnresolved(findings, "resolved-unresolved-import", item);
  }
}

function pushPublicApi(
  findings: ArchitectureDriftFinding[],
  kind: "public-api-addition" | "public-api-removal",
  symbol: ArchitecturePublicApiSymbol,
): void {
  findings.push({
    kind,
    severity: kind === "public-api-removal" ? "error" : "info",
    key: symbol.id,
    title: `${kind === "public-api-removal" ? "Public API removed" : "Public API added"}: ${symbol.file}#${symbol.name}`,
    file: symbol.file,
    symbol,
  });
}

function comparePublicApi(
  findings: ArchitectureDriftFinding[],
  base: readonly ArchitecturePublicApiSymbol[],
  head: readonly ArchitecturePublicApiSymbol[],
  mode: ArchitectureDriftPublicApiMode,
): void {
  if (mode === "off") return;
  const baseById = byId(base);
  const headById = byId(head);
  if (mode === "all") {
    for (const symbol of headById.values()) {
      if (!baseById.has(symbol.id)) pushPublicApi(findings, "public-api-addition", symbol);
    }
  }
  for (const symbol of baseById.values()) {
    if (!headById.has(symbol.id)) pushPublicApi(findings, "public-api-removal", symbol);
  }
}

function signalEnabled(
  snapshot: ArchitectureSnapshot,
  signal: "unresolved" | "publicApi" | "duplicates",
): boolean {
  return snapshot.signalAvailability?.[signal] !== false;
}

function compareDuplicates(findings: ArchitectureDriftFinding[], base: ArchitectureSnapshot, head: ArchitectureSnapshot): void {
  const before = base.duplicates.groups.total;
  const after = head.duplicates.groups.total;
  if (before === after) return;
  const kind: ArchitectureDriftFindingKind = after > before ? "duplicate-increase" : "duplicate-decrease";
  const baseTopGroupKeys = base.duplicates.topGroupKeys;
  const headTopGroupKeys = head.duplicates.topGroupKeys;
  const baseSet = new Set(baseTopGroupKeys);
  const headSet = new Set(headTopGroupKeys);
  const newTopGroupKeys = headTopGroupKeys.filter((key) => !baseSet.has(key));
  const resolvedTopGroupKeys = baseTopGroupKeys.filter((key) => !headSet.has(key));
  findings.push({
    kind,
    severity: after > before ? "warning" : "info",
    key: "duplicates:groups",
    title: `Duplicate groups ${after > before ? "increased" : "decreased"}: ${before} -> ${after}`,
    before,
    after,
    details: {
      baseTopGroupKeys,
      headTopGroupKeys,
      newTopGroupKeys,
      resolvedTopGroupKeys,
    },
  });
}

function pushGraphEdge(
  findings: ArchitectureDriftFinding[],
  kind: "graph-edge-added" | "graph-edge-removed",
  edge: ArchitectureGraphEdge,
): void {
  findings.push({
    kind,
    severity: "info",
    key: edge.key,
    title: `${kind === "graph-edge-added" ? "Graph edge added" : "Graph edge removed"}: ${edge.from} -> ${edge.to}`,
    file: edge.from,
    edge,
  });
}

function pushGraphEdgeSummary(
  findings: ArchitectureDriftFinding[],
  kind: "graph-edge-added" | "graph-edge-removed",
  file: string,
  count: number,
): void {
  findings.push({
    kind,
    severity: "info",
    key: `${kind}:${file}`,
    title: `${kind === "graph-edge-added" ? "Graph edges added" : "Graph edges removed"}: ${file} (${count})`,
    file,
    details: { count },
  });
}

function compareGraphEdges(
  findings: ArchitectureDriftFinding[],
  base: readonly ArchitectureGraphEdge[],
  head: readonly ArchitectureGraphEdge[],
  mode: ArchitectureDriftGraphEdgesMode,
): void {
  if (mode === "off") return;
  const baseByKey = byKey(base);
  const headByKey = byKey(head);
  if (mode === "full") {
    for (const edge of headByKey.values()) {
      if (!baseByKey.has(edge.key)) pushGraphEdge(findings, "graph-edge-added", edge);
    }
    for (const edge of baseByKey.values()) {
      if (!headByKey.has(edge.key)) pushGraphEdge(findings, "graph-edge-removed", edge);
    }
    return;
  }

  const addedByFile = new Map<string, number>();
  const removedByFile = new Map<string, number>();
  for (const edge of headByKey.values()) {
    if (baseByKey.has(edge.key)) continue;
    addedByFile.set(edge.from, (addedByFile.get(edge.from) ?? 0) + 1);
  }
  for (const edge of baseByKey.values()) {
    if (headByKey.has(edge.key)) continue;
    removedByFile.set(edge.from, (removedByFile.get(edge.from) ?? 0) + 1);
  }
  for (const file of Array.from(addedByFile.keys()).sort()) {
    pushGraphEdgeSummary(findings, "graph-edge-added", file, addedByFile.get(file) ?? 0);
  }
  for (const file of Array.from(removedByFile.keys()).sort()) {
    pushGraphEdgeSummary(findings, "graph-edge-removed", file, removedByFile.get(file) ?? 0);
  }
}

function compareFindings(left: ArchitectureDriftFinding, right: ArchitectureDriftFinding): number {
  const severityRank = { error: 0, warning: 1, info: 2 } as const;
  const severityDelta = severityRank[left.severity] - severityRank[right.severity];
  if (severityDelta) return severityDelta;
  const kindDelta = left.kind.localeCompare(right.kind);
  if (kindDelta) return kindDelta;
  return left.key.localeCompare(right.key);
}

function summarizeFindings(findings: readonly ArchitectureDriftFinding[]): ArchitectureDriftSummary {
  const byKind: Partial<Record<ArchitectureDriftFindingKind, number>> = {};
  const bySeverity: Partial<Record<"error" | "warning" | "info", number>> = {};
  for (const finding of findings) {
    byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
  }
  return { byKind, bySeverity };
}

function effectivePublicApiMode(options: ArchitectureDriftCompareOptions): ArchitectureDriftPublicApiMode {
  if (options.publicApi) return options.publicApi;
  if (options.format === "compact") return "removals";
  return "all";
}

function effectiveGraphEdgesMode(options: ArchitectureDriftCompareOptions): ArchitectureDriftGraphEdgesMode {
  if (options.graphEdges) return options.graphEdges;
  if (options.format === "compact") return "summary";
  return "full";
}

function effectiveFormat(options: ArchitectureDriftCompareOptions): "full" | "compact" {
  return options.format ?? "full";
}

export function compareArchitectureSnapshots(
  base: ArchitectureSnapshot,
  head: ArchitectureSnapshot,
  options: ArchitectureDriftCompareOptions = {},
): ArchitectureDriftReport {
  const thresholds = { ...DEFAULT_DRIFT_THRESHOLDS, ...options.thresholds };
  const findings: ArchitectureDriftFinding[] = [];
  compareCycles(findings, base.cycles, head.cycles);
  compareHotspots(findings, base.hotspots, head.hotspots, thresholds.hotspotJump);
  if (signalEnabled(base, "unresolved") && signalEnabled(head, "unresolved")) {
    compareUnresolved(findings, base.unresolved.imports, head.unresolved.imports);
  }
  if (signalEnabled(base, "publicApi") && signalEnabled(head, "publicApi")) {
    comparePublicApi(findings, base.publicApi, head.publicApi, effectivePublicApiMode(options));
  }
  if (signalEnabled(base, "duplicates") && signalEnabled(head, "duplicates")) {
    compareDuplicates(findings, base, head);
  }
  compareGraphEdges(findings, base.graphEdges, head.graphEdges, effectiveGraphEdgesMode(options));
  findings.sort(compareFindings);

  const limitedFindings = findings.slice(0, thresholds.maxFindings);
  const failOn = [...(options.failOn ?? [])].sort();
  const failOnSet = new Set(failOn);
  const matchedFailKinds = findings.filter((finding) => failOnSet.has(finding.kind)).map((finding) => finding.kind);
  const failedKinds = Array.from(new Set(matchedFailKinds)).sort();

  return {
    schemaVersion: 1,
    format: effectiveFormat(options),
    root: head.root,
    base: summarize(base),
    head: summarize(head),
    findings: limitedFindings,
    summary: summarizeFindings(findings),
    policy: {
      failed: !!failedKinds.length,
      failOn,
      failedKinds,
    },
    omittedCounts: {
      findings: Math.max(0, findings.length - limitedFindings.length),
    },
  };
}
