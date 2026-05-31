import { analyzeArchitectureDrift, ARCHITECTURE_DRIFT_FINDING_KINDS, renderArchitectureDriftReport } from "../drift/index.js";
import type { ArchitectureDriftFindingKind } from "../drift/types.js";
import type { GraphBuildOptions } from "../graphs/types.js";
import type { BuildOptions } from "../indexer/types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import { parseNonNegativeIntegerOption, parseOptionalNonNegativeIntegerOption } from "./options.js";

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

function parseFailOn(rawValue: string | undefined): ArchitectureDriftFindingKind[] {
  if (!rawValue) return [];
  const values = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.filter((value) => !findingKindSet.has(value));
  if (invalid.length) {
    throw new Error(`Invalid --fail-on value(s): ${invalid.join(", ")}. Valid kinds: ${ARCHITECTURE_DRIFT_FINDING_KINDS.join(", ")}.`);
  }
  return Array.from(new Set(values)) as ArchitectureDriftFindingKind[];
}

export async function handleDriftCommand(context: DriftCommandContext): Promise<void> {
  let failOn: ArchitectureDriftFindingKind[];
  let hotspotJump: number | undefined;
  let maxFindings: number;
  try {
    failOn = parseFailOn(context.getOpt("--fail-on"));
    hotspotJump = parseOptionalNonNegativeIntegerOption(context.getOpt("--hotspot-jump-threshold"), "--hotspot-jump-threshold");
    maxFindings = parseNonNegativeIntegerOption(context.getOpt("--limit"), "--limit", 100);
  } catch (error) {
    context.writeStderrLine(error instanceof Error ? error.message : String(error));
    context.exit(2);
  }

  const base = context.getOpt("--base");
  const baseArtifact = context.getOpt("--base-artifact");
  if (!base && !baseArtifact) {
    context.writeStderrLine("Usage: codegraph drift [roots...] --base <ref> [--head <ref>] [--json | --pretty]");
    context.writeStderrLine("Provide either --base or --base-artifact.");
    context.exit(2);
  }

  const head = context.getOpt("--head");
  const report = await analyzeArchitectureDrift(context.projectRootFs, {
    ...(base ? { provider: "git" as const, base } : {}),
    ...(head ? { head } : {}),
    ...(baseArtifact ? { baseArtifact } : {}),
    includeRoots: context.positionals,
    failOn,
    thresholds: {
      ...(hotspotJump !== undefined ? { hotspotJump } : {}),
      maxFindings,
    },
    ...(context.graphOptions ? { graph: context.graphOptions } : {}),
    ...(context.indexOptions ? { index: context.indexOptions } : {}),
    ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
  });

  if (context.hasFlag("--json") && !context.hasFlag("--pretty")) {
    context.writeJSONLine(report);
  } else {
    for (const line of renderArchitectureDriftReport(report, { limit: maxFindings }).trimEnd().split("\n")) {
      context.writeStdoutLine(line);
    }
  }

  if (report.policy.failed) {
    context.exit(1);
  }
}
