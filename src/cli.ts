#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { isCliBootstrapActive } from "./cli/bootstrap.js";
import { CLI_COMMAND_TABLE } from "./cli/commandTable.js";
import {
  exitCli,
  getCwd,
  parseCliArgs,
  runWithCliRuntime,
  writeError,
  writeJSONLine,
  writeStderrLine,
  writeStdoutLine,
  type CliRuntime,
} from "./cli/context.js";
import { CLI_HELP_TEXT, CLI_TASK_HELP_TEXT, helpTextForCommand, isKnownCliCommand } from "./cli/help.js";
import { routeForCliIntent, suggestCliCommands } from "./cli/commandCatalog.js";
import { createCliBaseContext, createCliOptionAccessors, loadCliProjectContext } from "./cli/invocationContext.js";
import { validateCliArgs, type ParsedCliArgs } from "./cli/options.js";
import { getCodegraphPackageIdentity, getCodegraphVersion } from "./cli/packageInfo.js";
import { errorMessage } from "./util/errors.js";

export { isRelativePathInside as isCliDiscoveryRelativePathInside } from "./util/discoveryPath.js";
export const CLI_DISPATCHABLE_COMMANDS = [
  "apisurface",
  "affected",
  "artifact",
  "callees",
  "callers",
  "chunk",
  "cycles",
  "deps",
  "doctor",
  "drift",
  "dumpmod",
  "duplicates",
  "explain",
  "explore",
  "file",
  "goto",
  "graph",
  "graph-delta",
  "grep",
  "hotspots",
  "impact",
  "implementations",
  "index",
  "init",
  "inspect",
  "install",
  "mcp",
  "orient",
  "packet",
  "path",
  "rdeps",
  "refactor-plan",
  "refs",
  "rename-preview",
  "review",
  "search",
  "skill",
  "sql",
  "status",
  "subtypes",
  "supertypes",
  "symbols",
  "sync",
  "uninit",
  "uninstall",
  "unresolved",
  "viewer",
  "version",
] as const;

function normalizeEntrypointPath(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function isDirectCliExecution(importMetaUrl: string, argv: string[] = process.argv): boolean {
  const argv1 = argv[1];
  if (!argv1) return false;

  const modulePath = normalizeEntrypointPath(fileURLToPath(importMetaUrl));
  const invokedPath = normalizeEntrypointPath(argv1);

  if (process.platform === "win32") {
    return modulePath.toLowerCase() === invokedPath.toLowerCase();
  }
  return modulePath === invokedPath;
}

async function runCliWithActiveRuntime(rawArgs: string[]) {
  if (!rawArgs.length) {
    writeStdoutLine(CLI_TASK_HELP_TEXT);
    return;
  }

  if (rawArgs[0] === "help") {
    const command = rawArgs[1];
    writeStdoutLine(
      (command ? helpTextForCommand(command, rawArgs.slice(2)) : CLI_HELP_TEXT)?.trimEnd() ?? CLI_HELP_TEXT,
    );
    return;
  }

  const commandWasExplicit = Boolean(rawArgs[0] && !rawArgs[0].startsWith("-"));
  const cmd = commandWasExplicit ? rawArgs[0]! : "graph";
  const argTokens = commandWasExplicit ? rawArgs.slice(1) : rawArgs;

  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(cmd, argTokens);
  } catch (error) {
    writeStderrLine(errorMessage(error));
    exitCli(2);
  }
  const { getOpt, hasFlag } = createCliOptionAccessors(parsed);

  if (hasFlag("--help") || hasFlag("-h")) {
    const commandHelp = commandWasExplicit ? helpTextForCommand(cmd, parsed.positionals) : undefined;
    writeStdoutLine((commandHelp ?? CLI_HELP_TEXT).trimEnd());
    return;
  }

  if (hasFlag("--version") || hasFlag("-v")) {
    if (hasFlag("--json")) {
      writeJSONLine(getCodegraphPackageIdentity());
    } else {
      writeStdoutLine(getCodegraphVersion());
    }
    return;
  }

  if (!isKnownCliCommand(cmd)) {
    writeStderrLine(`Unknown command "${cmd}".`);
    const suggestions = suggestCliCommands(cmd);
    if (suggestions.length) writeStderrLine(`Did you mean: ${suggestions.join(", ")}?`);
    const route = routeForCliIntent(cmd);
    if (route) writeStderrLine(`Try: ${route}`);
    exitCli(1);
    return;
  }
  try {
    validateCliArgs(cmd, parsed);
  } catch (error) {
    writeStderrLine(errorMessage(error));
    exitCli(2);
  }
  if (cmd === "viewer") {
    // Keep the human-only browser server out of normal agent command startup.
    const { handleViewerCommand } = await import("./cli/viewer.js");
    await handleViewerCommand({
      getOpt,
      hasFlag,
      cwd: getCwd,
      writeStderrLine,
      writeStdoutLine,
      exit: exitCli,
    });
    return;
  }

  const entry = CLI_COMMAND_TABLE[cmd];
  if (!entry) {
    writeStderrLine(`Unknown command: ${cmd}`);
    exitCli(1);
  }
  const base = createCliBaseContext(cmd, parsed);
  if (entry.stage === "base") {
    await entry.run(base);
    return;
  }
  const project = await loadCliProjectContext(base);
  await entry.run(project);
}

export async function runCli(
  rawArgs: string[] = process.argv.slice(2),
  runtime: Partial<CliRuntime> = {},
): Promise<void> {
  await runWithCliRuntime(runtime, async () => await runCliWithActiveRuntime(rawArgs));
}

export async function main(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
  // Keep the failure path inside the ALS CLI context so --stderr-file (and other
  // context-local state) remains visible to writeError/writeStderrLine.
  await runWithCliRuntime({}, async () => {
    try {
      await runCliWithActiveRuntime(rawArgs);
    } catch (error) {
      writeError(error);
      exitCli(1);
    }
  });
}

if (!isCliBootstrapActive() && isDirectCliExecution(import.meta.url)) {
  void main();
}
