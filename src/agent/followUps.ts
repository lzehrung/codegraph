import { quoteShellArg } from "./shell.js";

export type AgentFollowUp = {
  tool: string;
  arguments: Record<string, unknown>;
  label?: string;
};

export function toolFollowUp(tool: string, arguments_: Record<string, unknown> = {}, label?: string): AgentFollowUp {
  return {
    tool,
    arguments: { ...arguments_ },
    ...(label !== undefined ? { label } : {}),
  };
}

export function formatAgentFollowUpAsCli(followUp: AgentFollowUp): string {
  const args = followUp.arguments;
  switch (followUp.tool) {
    case "file_deps": {
      const file = stringArgument(args, "file");
      const direction = args.direction === "rdeps" ? "rdeps" : "deps";
      return appendJson(`codegraph ${direction}${file === undefined ? "" : ` ${formatPathArgument(file)}`}`, args);
    }
    case "calls": {
      const handle = stringArgument(args, "handle");
      const direction = args.direction === "callees" ? "callees" : "callers";
      return appendJson(`codegraph ${direction}${handle === undefined ? "" : ` ${quoteShellArg(handle)}`}`, args);
    }
    case "type_hierarchy": {
      const handle = stringArgument(args, "handle");
      const direction = args.direction === "subtypes" ? "subtypes" : "supertypes";
      return appendJson(`codegraph ${direction}${handle === undefined ? "" : ` ${quoteShellArg(handle)}`}`, args);
    }
    case "get_file": {
      const file = stringArgument(args, "file");
      return `codegraph file${file === undefined ? "" : ` ${formatPathArgument(file)}`}`;
    }
    case "packet_get": {
      const target = stringArgument(args, "target");
      return `codegraph packet get${target === undefined ? "" : ` ${formatPathArgument(target)}`}`;
    }
    case "chunk": {
      const file = stringArgument(args, "file");
      return `codegraph chunk${file === undefined ? "" : ` ${formatPathArgument(file)}`}`;
    }
    case "get_symbol": {
      const handle = stringArgument(args, "handle");
      return `codegraph explain${handle === undefined ? "" : ` ${quoteShellArg(handle)}`}`;
    }
    case "goto": {
      const location = locationArgument(args);
      return `codegraph goto ${quoteShellArg(location)}`;
    }
    case "refs": {
      const target = stringArgument(args, "handle") ?? locationArgument(args);
      return `codegraph refs ${quoteShellArg(target)}`;
    }
    case "search": {
      const query = stringArgument(args, "query");
      let command = `codegraph search${query === undefined ? "" : ` ${quoteShellArg(query)}`}`;
      if (typeof args.mode === "string") command += ` --mode ${quoteShellArg(args.mode)}`;
      if (typeof args.from === "string") command += ` --from ${quoteShellArg(args.from)}`;
      return `${command} --json`;
    }
    case "explore": {
      const query = stringArgument(args, "query");
      return `codegraph explore${query === undefined ? "" : ` ${quoteShellArg(query)}`}`;
    }
    case "orient": {
      let command = "codegraph orient";
      if (typeof args.root === "string") command += ` --root ${quoteShellArg(args.root)}`;
      if (typeof args.budget === "string") command += ` --budget ${quoteShellArg(args.budget)}`;
      return command;
    }
    case "implementations": {
      const handle = stringArgument(args, "handle");
      return appendJson(`codegraph implementations${handle === undefined ? "" : ` ${quoteShellArg(handle)}`}`, args);
    }
    case "rename_preview": {
      const handle = stringArgument(args, "handle");
      const newName = stringArgument(args, "newName") ?? "<new-name>";
      return `codegraph rename-preview${handle === undefined ? "" : ` ${quoteShellArg(handle)}`} ${quoteShellArg(newName)} --json`;
    }
    case "review":
    case "impact": {
      let command = `codegraph ${followUp.tool}`;
      if (typeof args.provider === "string") command += ` --provider ${quoteShellArg(args.provider)}`;
      if (typeof args.base === "string") command += ` --base ${quoteShellArg(args.base)}`;
      if (typeof args.head === "string") command += ` --head ${quoteShellArg(args.head)}`;
      return command;
    }
    case "duplicates": {
      const root = stringArgument(args, "root") ?? ".";
      const files = Array.isArray(args.files)
        ? args.files.filter((file): file is string => typeof file === "string")
        : [];
      let command = `codegraph duplicates --root ${quoteShellArg(root)} ${files.map(quoteShellArg).join(" ")}`;
      if (args.json === true) command += " --json";
      if (typeof args.minConfidence === "string") command += ` --min-confidence ${quoteShellArg(args.minConfidence)}`;
      if (args.includeSameFile === true) command += " --include-same-file";
      return command;
    }
    case "hotspots": {
      const root = stringArgument(args, "root") ?? ".";
      const limit = typeof args.limit === "number" ? ` --limit ${args.limit}` : "";
      return `codegraph hotspots ${quoteShellArg(root)}${limit}`;
    }
    default:
      return formatUnknownFollowUp(followUp);
  }
}

export function formatAgentFollowUpsAsCli(followUps: readonly AgentFollowUp[]): string[] {
  return followUps.map(formatAgentFollowUpAsCli);
}

function stringArgument(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === "string" ? args[key] : undefined;
}

function locationArgument(args: Record<string, unknown>): string {
  const file = stringArgument(args, "file") ?? "<file>";
  const line = typeof args.line === "number" ? args.line : 1;
  const column = typeof args.column === "number" ? args.column : 0;
  return `${file}:${line}:${column}`;
}

function formatPathArgument(value: string): string {
  const target =
    value.startsWith("-") ||
    value.startsWith("file:") ||
    value.startsWith("symbol:") ||
    value.startsWith("chunk:") ||
    value.startsWith("sql:") ||
    value.startsWith("graph:") ||
    value.startsWith("review:")
      ? `./${value}`
      : value;
  return quoteShellArg(target);
}

function appendJson(command: string, args: Record<string, unknown>): string {
  let output = command;
  if (typeof args.depth === "number") output += ` --depth ${args.depth}`;
  if (typeof args.limit === "number") output += ` --limit ${args.limit}`;
  if (args.includeHeuristic === true) output += " --include-heuristic";
  return `${output} --json`;
}

function formatUnknownFollowUp(followUp: AgentFollowUp): string {
  let command = `codegraph ${followUp.tool}`;
  for (const [key, value] of Object.entries(followUp.arguments)) {
    if (value === undefined || value === false) continue;
    if (value === true) {
      command += ` --${key}`;
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      command += ` --${key} ${quoteShellArg(String(value))}`;
    }
  }
  return command;
}
