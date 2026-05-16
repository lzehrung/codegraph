import { buildCodegraphArtifact } from "../agent/artifact.js";

export type ArtifactCommandContext = {
  positionals: string[];
  root: string;
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

export async function handleArtifactCommand(context: ArtifactCommandContext): Promise<void> {
  const artifactCommand = context.positionals[0];
  if (artifactCommand !== "build") {
    context.writeStderrLine(
      "Usage: artifact build [--root <path>] [--out <dir>] [--sqlite] [--graph-json] [--report] [--questions] [--force] [--json]",
    );
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
