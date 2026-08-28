import path from "node:path";
import type { BuildOptions } from "../indexer/types.js";
import {
  getCodegraphLifecycleStatus,
  initCodegraphLifecycle,
  syncCodegraphLifecycle,
  uninitCodegraphLifecycle,
  type CodegraphLifecycleStatus,
  type CodegraphLifecycleSyncResult,
  type CodegraphLifecycleUninitResult,
} from "../lifecycle/manifest.js";

export type LifecycleCommandContext = {
  command: "init" | "status" | "sync" | "uninit";
  root: string;
  buildOptions?: BuildOptions;
  hasFlag: (name: string) => boolean;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
};

export async function handleLifecycleCommand(context: LifecycleCommandContext): Promise<void> {
  if (context.command === "init") {
    const result = await initCodegraphLifecycle(context.root, {
      ...(context.buildOptions ? { buildOptions: context.buildOptions } : {}),
      force: context.hasFlag("--force"),
      updateGitignore: !context.hasFlag("--no-update-gitignore"),
    });
    writeLifecycleResult(context, result, formatSyncResult("Initialized", result));
    return;
  }

  if (context.command === "sync") {
    const result = await syncCodegraphLifecycle(context.root, {
      ...(context.buildOptions ? { buildOptions: context.buildOptions } : {}),
      init: context.hasFlag("--init"),
      updateGitignore: !context.hasFlag("--no-update-gitignore"),
    });
    writeLifecycleResult(context, result, formatSyncResult("Synced", result));
    return;
  }

  if (context.command === "uninit") {
    const result = await uninitCodegraphLifecycle(context.root, { force: context.hasFlag("--force") });
    writeLifecycleResult(context, result, formatUninitResult(result));
    return;
  }

  const result = await getCodegraphLifecycleStatus(context.root, {
    ...(context.buildOptions ? { buildOptions: context.buildOptions } : {}),
  });
  writeLifecycleResult(context, result, formatStatus(result));
}

function writeLifecycleResult(
  context: LifecycleCommandContext,
  value: CodegraphLifecycleStatus | CodegraphLifecycleSyncResult | CodegraphLifecycleUninitResult,
  pretty: string,
): void {
  if (context.hasFlag("--json")) {
    context.writeJSONLine(value);
  } else {
    context.writeStdoutLine(pretty);
  }
}

function formatSyncResult(label: string, result: CodegraphLifecycleSyncResult): string {
  const { added, removed } = result.changedFiles;
  // Report added/removed explicitly rather than the net delta alone: equal adds and removes
  // cancel out to a delta of 0, which would otherwise hide real file churn.
  const changeLabel = added || removed ? `, +${added}/-${removed}` : "";
  const summary = `${label} Codegraph at ${result.root}: ${result.manifest.fileCount} files${changeLabel}. Manifest: ${result.manifestPath}`;
  if (result.gitignore?.status === "added") {
    const gitignorePath = path.join(result.root, result.gitignore.path);
    const rules = result.gitignore.rules?.length ? result.gitignore.rules.join(", ") : ".codegraph/";
    return `${summary}\nUpdated Git ignore policy at ${gitignorePath}: added ${rules}.`;
  }
  if (result.gitignore?.status === "tracked") {
    return `${summary}\nWarning: .codegraph/manifest.json is tracked by Git; the ignore policy was not changed.`;
  }
  return summary;
}

function formatUninitResult(result: CodegraphLifecycleUninitResult): string {
  if (!result.removed) return `Codegraph is not initialized at ${result.root}.`;
  return `Removed Codegraph lifecycle state at ${result.root}.`;
}

function formatStatus(status: CodegraphLifecycleStatus): string {
  if (!status.initialized) {
    return `Codegraph is not initialized at ${status.root}. Next: ${status.suggestedNextCommand}`;
  }
  const fileCount = status.fileCount ? `${status.fileCount.then} then, ${status.fileCount.current} current` : "unknown";
  const filesChanged = status.filesChanged ? "yes" : "no";
  const configChanged = status.configChanged ? "yes" : "no";
  const buildOptionsChanged = status.buildOptionsChanged ? "yes" : "no";
  const analysis = status.analysis?.label ?? "unknown";
  return [
    `Codegraph initialized at ${status.root}.`,
    `Last sync: ${status.lastSyncAt ?? "unknown"}`,
    `Files: ${fileCount}`,
    `Files changed: ${filesChanged}`,
    `Config changed: ${configChanged}`,
    `Build options changed: ${buildOptionsChanged}`,
    `Analysis: ${analysis}`,
    `Next: ${status.suggestedNextCommand}`,
  ].join("\n");
}
