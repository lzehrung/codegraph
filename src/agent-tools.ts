import {
  buildProjectIndex,
  analyzeImpactFromDiff,
  type ImpactOptions,
  type ImpactReport,
  type CompactImpactReport,
} from "./index.js";

/**
 * Agent-friendly tool wrapper for PR impact analysis.
 * Returns JSON-serializable impact report for LLM consumption.
 */
export async function tool_impactJSON(
  root: string,
  options: ImpactOptions,
): Promise<{
  status: "ok" | "error";
  report?: ImpactReport | CompactImpactReport;
  error?: string;
}> {
  try {
    // Build the project index if not already available
    // In a real agent scenario, you might want to cache this
    const index = await buildProjectIndex(root);

    // Analyze the impact
    const report = await analyzeImpactFromDiff(root, index, options);

    return {
      status: "ok",
      report,
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Simplified wrapper for raw diff text analysis.
 * Useful for testing or when you already have diff content.
 */
export async function tool_impactFromDiffText(
  root: string,
  diffText: string,
  options: Omit<ImpactOptions, "provider" | "diffText"> = {},
): Promise<{
  status: "ok" | "error";
  report?: ImpactReport | CompactImpactReport;
  error?: string;
}> {
  return tool_impactJSON(root, {
    provider: "raw",
    diffText,
    ...options,
  });
}
