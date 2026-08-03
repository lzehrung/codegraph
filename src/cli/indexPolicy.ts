import { CLI_COMMAND_CATALOG, resolveCliCommand } from "./commandCatalog.js";

/**
 * How a CLI command obtains a project index.
 *
 * This is an architectural inventory, not runtime dispatch: it exists so a new command
 * cannot ship without an explicit freshness decision, and so intentional non-automatic
 * paths stay enumerated instead of inferred from a command family label.
 */
export type CliIndexBehavior =
  /** Loads no index. */
  | "none"
  /** Loads current repository state through `loadCurrentProjectIndex`. */
  | "current-query"
  /** Uses `createAgentSession`, including its in-memory freshness contract. */
  | "agent-session"
  /** Intentionally creates, refreshes, or materializes an index or artifact. */
  | "explicit-build"
  /** Reconstructs or compares a requested revision or range. */
  | "historical";

/** Wiring family of a `current-query` command; each family owns a behavioral CLI test. */
export type CliCurrentQueryFamily =
  | "navigation"
  | "graph-query"
  | "structural-summary"
  | "duplicate-analysis"
  | "diff-aware"
  | "affected-tests";

export type CliIndexPolicyEntry = {
  command: string;
  behaviors: readonly CliIndexBehavior[];
  /** Required when `behaviors` includes `current-query`. */
  family?: CliCurrentQueryFamily;
  /** Why this command loads (or does not load) an index the way it does. */
  reason: string;
};

export const CLI_INDEX_POLICY: readonly CliIndexPolicyEntry[] = [
  { command: "orient", behaviors: ["agent-session"], reason: "Agent snapshot with manual freshness." },
  { command: "explore", behaviors: ["agent-session"], reason: "Agent snapshot shared by search and packets." },
  {
    command: "file",
    behaviors: ["none", "agent-session"],
    reason: "Reads a file directly; only --graph-context opens an agent session.",
  },
  {
    command: "review",
    behaviors: ["current-query"],
    family: "diff-aware",
    reason: "Diff range selects what to review; the index is current repository state.",
  },
  { command: "packet", behaviors: ["agent-session"], reason: "Evidence packets read an agent snapshot." },
  { command: "search", behaviors: ["agent-session"], reason: "Ranked search reads an agent snapshot." },
  { command: "symbols", behaviors: ["agent-session"], reason: "Symbol identity lookup reads an agent snapshot." },
  { command: "callers", behaviors: ["agent-session"], reason: "Call hierarchy needs the session symbol graph." },
  { command: "callees", behaviors: ["agent-session"], reason: "Call hierarchy needs the session symbol graph." },
  { command: "supertypes", behaviors: ["agent-session"], reason: "Type hierarchy needs the session symbol graph." },
  { command: "subtypes", behaviors: ["agent-session"], reason: "Type hierarchy needs the session symbol graph." },
  { command: "implementations", behaviors: ["agent-session"], reason: "Needs the session symbol graph." },
  { command: "rename-preview", behaviors: ["agent-session"], reason: "Rename evidence needs the session snapshot." },
  { command: "refactor-plan", behaviors: ["agent-session"], reason: "Refactor evidence needs the session snapshot." },
  { command: "explain", behaviors: ["agent-session"], reason: "Explanations need the session snapshot." },
  {
    command: "impact",
    behaviors: ["current-query"],
    family: "diff-aware",
    reason: "Diff range selects changed symbols; the index is current repository state.",
  },
  {
    command: "inspect",
    behaviors: ["current-query"],
    family: "structural-summary",
    reason: "Structural summary over resolved include-root scope.",
  },
  {
    command: "affected",
    behaviors: ["current-query"],
    family: "affected-tests",
    reason: "Reverse dependency walk over current repository state.",
  },
  {
    command: "graph",
    behaviors: ["explicit-build"],
    reason: "Materializes graph output; changed-range mode keeps its own range semantics.",
  },
  {
    command: "artifact",
    behaviors: ["agent-session", "explicit-build"],
    reason: "Loads an agent snapshot, then writes an artifact bundle.",
  },
  { command: "drift", behaviors: ["historical"], reason: "Builds revision-isolated snapshots for comparison." },
  { command: "mcp", behaviors: ["agent-session"], reason: "Serves MCP tools over a long-lived agent session." },
  { command: "viewer", behaviors: ["none"], reason: "Serves prebuilt viewer assets." },
  { command: "index", behaviors: ["explicit-build"], reason: "Explicit index build, prewarm, or materialization." },
  { command: "init", behaviors: ["explicit-build"], reason: "Lifecycle metadata build for project onboarding." },
  { command: "status", behaviors: ["none"], reason: "Hashes config and lists files; never loads an index." },
  { command: "sync", behaviors: ["explicit-build"], reason: "Lifecycle metadata refresh and repair." },
  { command: "uninit", behaviors: ["none"], reason: "Removes lifecycle metadata." },
  {
    command: "goto",
    behaviors: ["current-query"],
    family: "navigation",
    reason: "Definition lookup over current repository state.",
  },
  {
    command: "refs",
    behaviors: ["current-query"],
    family: "navigation",
    reason: "Reference lookup over current repository state.",
  },
  {
    command: "deps",
    behaviors: ["current-query"],
    family: "graph-query",
    reason: "File dependency query over current repository state.",
  },
  {
    command: "rdeps",
    behaviors: ["current-query"],
    family: "graph-query",
    reason: "Reverse dependency query over current repository state.",
  },
  {
    command: "path",
    behaviors: ["current-query"],
    family: "graph-query",
    reason: "Shortest dependency path over current repository state.",
  },
  {
    command: "cycles",
    behaviors: ["current-query", "none"],
    family: "graph-query",
    reason: "Whole-project mode queries the index; include-root mode uses a scoped graph collector.",
  },
  {
    command: "hotspots",
    behaviors: ["current-query"],
    family: "structural-summary",
    reason: "Fan-in/fan-out summary over resolved include-root scope.",
  },
  {
    command: "duplicates",
    behaviors: ["current-query"],
    family: "duplicate-analysis",
    reason: "Duplicate detection over resolved scope, reusing the duplicate unit cache.",
  },
  {
    command: "unresolved",
    behaviors: ["current-query"],
    family: "graph-query",
    reason: "Unresolved import query over current repository state.",
  },
  {
    command: "apisurface",
    behaviors: ["current-query"],
    family: "graph-query",
    reason: "Exported API summary over current repository state.",
  },
  { command: "grep", behaviors: ["none"], reason: "Text and Tree-sitter query search without an index." },
  {
    command: "graph-delta",
    behaviors: ["historical"],
    reason: "Compares a requested changed range, not current-state freshness.",
  },
  { command: "sql", behaviors: ["none"], reason: "Reads an existing SQLite export." },
  { command: "chunk", behaviors: ["none"], reason: "Chunks a single file for embeddings." },
  { command: "doctor", behaviors: ["none"], reason: "Inspects runtime and artifact state only." },
  { command: "install", behaviors: ["none"], reason: "Writes client configuration only." },
  { command: "uninstall", behaviors: ["none"], reason: "Removes client configuration only." },
  { command: "skill", behaviors: ["none"], reason: "Installs or inspects the bundled skill." },
  { command: "version", behaviors: ["none"], reason: "Prints version identity." },
  {
    command: "dumpmod",
    behaviors: ["current-query"],
    family: "navigation",
    reason: "Dumps one indexed module from current repository state.",
  },
];

const policyByCommand = new Map(CLI_INDEX_POLICY.map((entry) => [entry.command, entry]));

/** Resolve the index policy for a command name or alias. */
export function indexPolicyForCommand(command: string): CliIndexPolicyEntry | undefined {
  const canonical = resolveCliCommand(command);
  if (!canonical) return undefined;
  return policyByCommand.get(canonical);
}

/** Canonical command names that load current repository state, grouped by wiring family. */
export function currentQueryCommandsByFamily(): Map<CliCurrentQueryFamily, string[]> {
  const byFamily = new Map<CliCurrentQueryFamily, string[]>();
  for (const entry of CLI_INDEX_POLICY) {
    if (!entry.behaviors.includes("current-query") || !entry.family) continue;
    const commands = byFamily.get(entry.family) ?? [];
    commands.push(entry.command);
    byFamily.set(entry.family, commands);
  }
  return byFamily;
}

/** Canonical command names known to the catalog, for parity checks. */
export function catalogCommandNames(): string[] {
  return CLI_COMMAND_CATALOG.map((command) => command.name);
}
