import {
  analyzeArchitectureDrift,
  ARCHITECTURE_DRIFT_FINDING_KINDS,
  renderArchitectureDriftReport,
} from "../drift/index.js";
import type {
  ArchitectureDriftFindingKind,
  ArchitectureDriftGraphEdgesMode,
  ArchitectureDriftPublicApiMode,
} from "../drift/types.js";
import type { GraphBuildOptions } from "../graphs/types.js";
import type { BuildOptions } from "../indexer/types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import { parseNonNegativeIntegerOption, parseOptionalNonNegativeIntegerOption } from "./options.js";
import { exitWithError } from "./context.js";

export interface DriftCommandContext {
  projectRootFs: string;
  positionals: string[];
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  nativeMode: NativeRuntimeMode;
  graphOptions?: GraphBuildOptions;
  indexOptions?: BuildOptions;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
}

const findingKindSet = new Set<string>(ARCHITECTURE_DRIFT_FINDING_KINDS);
const graphEdgesModes = new Set<ArchitectureDriftGraphEdgesMode>(["full", "summary", "off"]);
const publicApiModes = new Set<ArchitectureDriftPublicApiMode>(["all", "removals", "off"]);

function parseFailOn(rawValue: string | undefined): ArchitectureDriftFindingKind[] {
  if (!rawValue) return [];
  const values = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.filter((value) => !findingKindSet.has(value));
  if (invalid.length) {
    throw new Error(
      `Invalid --fail-on value(s): ${invalid.join(", ")}. Valid kinds: ${ARCHITECTURE_DRIFT_FINDING_KINDS.join(", ")}.`,
    );
  }
  return Array.from(new Set(values)) as ArchitectureDriftFindingKind[];
}

function parseGraphEdgesMode(rawValue: string | undefined): ArchitectureDriftGraphEdgesMode | undefined {
  if (rawValue === undefined) return undefined;
  if (graphEdgesModes.has(rawValue as ArchitectureDriftGraphEdgesMode)) {
    return rawValue as ArchitectureDriftGraphEdgesMode;
  }
  throw new Error(`Invalid --graph-edges value "${rawValue}". Valid values: full, summary, off.`);
}

function parsePublicApiMode(rawValue: string | undefined): ArchitectureDriftPublicApiMode | undefined {
  if (rawValue === undefined) return undefined;
  if (publicApiModes.has(rawValue as ArchitectureDriftPublicApiMode)) {
    return rawValue as ArchitectureDriftPublicApiMode;
  }
  throw new Error(`Invalid --public-api value "${rawValue}". Valid values: all, removals, off.`);
}

export async function handleDriftCommand(context: DriftCommandContext): Promise<void> {
  let failOn: ArchitectureDriftFindingKind[];
  let hotspotJump: number | undefined;
  let maxFindings: number;
  let graphEdges: ArchitectureDriftGraphEdgesMode | undefined;
  let publicApi: ArchitectureDriftPublicApiMode | undefined;
  try {
    failOn = parseFailOn(context.getOpt("--fail-on"));
    hotspotJump = parseOptionalNonNegativeIntegerOption(
      context.getOpt("--hotspot-jump-threshold"),
      "--hotspot-jump-threshold",
    );
    maxFindings = parseNonNegativeIntegerOption(context.getOpt("--limit"), "--limit", 100);
    graphEdges = parseGraphEdgesMode(context.getOpt("--graph-edges"));
    publicApi = parsePublicApiMode(context.getOpt("--public-api"));
  } catch (error) {
    exitWithError(context, error, 2);
  }

  let base = context.getOpt("--base");
  const baseArtifact = context.getOpt("--base-artifact");
  if (!base && !baseArtifact) base = "HEAD";
  if (base && baseArtifact) {
    context.writeStderrLine("Provide either --base or --base-artifact, but not both.");
    context.exit(2);
  }
  const json = context.hasFlag("--json");
  const prettyOutput = !json;
  const effectiveGraphEdges = graphEdges ?? (prettyOutput ? "summary" : undefined);
  const effectivePublicApi = publicApi ?? (prettyOutput ? "removals" : undefined);

  let head = context.getOpt("--head");
  if (!head && !baseArtifact) head = "WORKTREE";
  let report: Awaited<ReturnType<typeof analyzeArchitectureDrift>>;
  try {
    report = await analyzeArchitectureDrift(context.projectRootFs, {
      ...(base ? { provider: "git" as const, base } : {}),
      ...(head ? { head } : {}),
      ...(baseArtifact ? { baseArtifact } : {}),
      includeRoots: context.positionals,
      failOn,
      thresholds: {
        ...(hotspotJump !== undefined ? { hotspotJump } : {}),
        maxFindings,
      },
      ...(effectiveGraphEdges !== undefined ? { graphEdges: effectiveGraphEdges } : {}),
      ...(effectivePublicApi !== undefined ? { publicApi: effectivePublicApi } : {}),
      ...(context.graphOptions ? { graph: context.graphOptions } : {}),
      ...(context.indexOptions ? { index: context.indexOptions } : {}),
      ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
    });
  } catch (error) {
    exitWithError(context, error, 1);
  }
  if (prettyOutput) {
    for (const line of renderArchitectureDriftReport(report, { limit: maxFindings }).trimEnd().split("\n")) {
      context.writeStdoutLine(line);
    }
  } else {
    context.writeJSONLine(report);
  }

  if (report.policy.failed) {
    context.exit(1);
  }
}
