import { buildCodegraphArtifact } from "../agent/artifact.js";
import type { CliAgentCommandContext } from "./context.js";
import { ARTIFACT_HELP_TEXT } from "./help.js";

export type ArtifactCommandContext = CliAgentCommandContext;

export async function handleArtifactCommand(context: ArtifactCommandContext): Promise<void> {
  const artifactCommand = context.positionals[0];
  if (artifactCommand !== "build") {
    context.writeStderrLine(ARTIFACT_HELP_TEXT.trimEnd());
    context.exit(2);
  }

  const outDir = context.getOpt("--out") ?? context.getOpt("--output");
  const hasArtifactSelection =
    context.hasFlag("--sqlite") ||
    context.hasFlag("--graph-json") ||
    context.hasFlag("--report") ||
    context.hasFlag("--questions");
  const result = await buildCodegraphArtifact({
    root: context.root,
    ...(outDir !== undefined ? { outDir } : {}),
    force: context.hasFlag("--force"),
    ...(hasArtifactSelection
      ? {
          sqlite: context.hasFlag("--sqlite"),
          graphJson: context.hasFlag("--graph-json"),
          report: context.hasFlag("--report"),
          questions: context.hasFlag("--questions"),
        }
      : {}),
  });

  if (context.hasFlag("--json")) {
    context.writeJSONLine(result);
  } else {
    context.writeStdoutLine(result.manifestPath);
  }
}
