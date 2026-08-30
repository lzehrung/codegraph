export type CliCommandFamily = "start" | "search" | "navigate" | "review" | "graph" | "manage";

export type CliCommandMetadata = {
  name: string;
  summary: string;
  family: CliCommandFamily;
  aliases?: readonly string[];
};

export const CLI_COMMAND_CATALOG: readonly CliCommandMetadata[] = [
  { name: "orient", summary: "Build a compact first-turn packet for agent repo context", family: "start" },
  { name: "explore", summary: "Derive context from one hybrid search", family: "search" },
  { name: "file", summary: "Read a live project file with bounded line pagination", family: "navigate" },
  { name: "review", summary: "Generate code review report", family: "review" },
  { name: "packet", summary: "Retrieve bounded evidence packets by file path or stable target", family: "navigate" },
  {
    name: "search",
    summary: "Ranked agent search across files, symbols, chunks, SQL, and graph context",
    family: "search",
  },
  { name: "symbols", summary: "Deterministic workspace-symbol lookup with exact locations", family: "search" },
  { name: "callers", summary: "Find proven semantic callers by symbol target", family: "navigate" },
  { name: "callees", summary: "Find proven semantic callees by symbol target", family: "navigate" },
  { name: "supertypes", summary: "Find proven direct or transitive supertypes by symbol target", family: "navigate" },
  { name: "subtypes", summary: "Find proven direct or transitive subtypes by symbol target", family: "navigate" },
  { name: "implementations", summary: "Find proven type or interface-member implementations", family: "navigate" },
  { name: "rename-preview", summary: "Read-only semantic rename planning by symbol target", family: "review" },
  { name: "refactor-plan", summary: "Build a read-only refactor evidence packet by symbol target", family: "review" },
  { name: "explain", summary: "Explain a file, symbol, SQL object, or search handle", family: "navigate" },
  { name: "impact", summary: "Analyze PR impact", family: "review" },
  { name: "inspect", summary: "Summarize repo structure and recommend next commands", family: "start" },
  { name: "affected", summary: "List tests likely affected by changed files", family: "review" },
  { name: "graph", summary: "Build dependency graph", family: "graph" },
  { name: "artifact", summary: "Build an agent-ready SQLite/graph/report/question bundle", family: "manage" },
  { name: "links", summary: "Check local Markdown links", family: "review" },
  { name: "drift", summary: "Compare architecture health between refs or artifacts", family: "review" },
  { name: "mcp", summary: "Serve MCP tools for agent graph navigation", family: "manage" },
  { name: "server", summary: "Manage a shared project-local MCP HTTP server", family: "manage" },
  { name: "viewer", summary: "Serve the bundled graph visualization viewer for people", family: "manage" },
  { name: "index", summary: "Build the project symbol index", family: "manage" },
  { name: "init", summary: "Initialize project-local Codegraph lifecycle metadata", family: "manage" },
  { name: "status", summary: "Inspect project-local Codegraph lifecycle metadata", family: "manage" },
  { name: "sync", summary: "Refresh project-local Codegraph lifecycle metadata", family: "manage" },
  { name: "uninit", summary: "Remove project-local Codegraph lifecycle metadata", family: "manage" },
  { name: "goto", summary: "Go to definition", family: "navigate" },
  { name: "refs", summary: "Find references", family: "navigate" },
  { name: "deps", summary: "List dependencies", family: "graph" },
  { name: "rdeps", summary: "List reverse dependencies", family: "graph" },
  { name: "path", summary: "Find the shortest dependency path between files", family: "graph" },
  { name: "cycles", summary: "Detect dependency cycles", family: "graph" },
  { name: "hotspots", summary: "Find high-complexity files", family: "graph" },
  { name: "duplicates", summary: "Detect duplicate and near-duplicate code units", family: "review" },
  { name: "unresolved", summary: "List unresolved project imports", family: "graph" },
  { name: "apisurface", summary: "Summarize exported API symbols", family: "graph" },
  { name: "grep", summary: "Run Tree-sitter query or text regex search", family: "search" },
  { name: "graph-delta", summary: "Report file-level graph changes", family: "graph" },
  { name: "sql", summary: "Query a SQLite graph export read-only", family: "search" },
  { name: "chunk", summary: "Chunk file for embeddings", family: "manage" },
  { name: "doctor", summary: "Inspect backend/runtime state and local graph artifacts", family: "start" },
  { name: "install", summary: "Configure Codegraph MCP and skill integration for agent clients", family: "manage" },
  { name: "uninstall", summary: "Remove Codegraph-owned installer configuration", family: "manage" },
  { name: "skill", summary: "Install or inspect the bundled agent skill", family: "manage" },
  { name: "version", summary: "Print the installed Codegraph version", family: "manage" },
  { name: "dumpmod", summary: "Dump one indexed module", family: "navigate" },
];

const commandByName = new Map(CLI_COMMAND_CATALOG.map((command) => [command.name, command]));
const aliasToCommand = new Map(
  CLI_COMMAND_CATALOG.flatMap((command) => (command.aliases ?? []).map((alias) => [alias, command.name] as const)),
);

export function resolveCliCommand(command: string): string | undefined {
  if (commandByName.has(command)) return command;
  return aliasToCommand.get(command);
}

export function isKnownCliCommand(command: string): boolean {
  return resolveCliCommand(command) !== undefined;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(previous[rightIndex]! + 1, current[rightIndex - 1]! + 1, substitution);
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index]!;
  }
  return previous[right.length]!;
}

export function suggestCliCommands(input: string, limit: number = 3): string[] {
  const normalized = input.toLowerCase();
  const maximumDistance = normalized.length <= 4 ? 1 : Math.min(3, Math.floor(normalized.length / 3));
  return CLI_COMMAND_CATALOG.map((command) => ({
    name: command.name,
    distance: editDistance(normalized, command.name),
  }))
    .filter((candidate) => candidate.distance <= maximumDistance)
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map((candidate) => candidate.name);
}

const INTENT_ROUTES = [
  { pattern: /^(understand|map|learn|where)$/i, command: 'codegraph explore "<question>" --root .' },
  { pattern: /^(find|locate|lookup)$/i, command: 'codegraph search "<query>" --json' },
  { pattern: /^(configure|setup|agent)$/i, command: "codegraph install" },
  { pattern: /^(health|diagnose|check)$/i, command: "codegraph doctor" },
] as const;

export function routeForCliIntent(input: string): string | undefined {
  return INTENT_ROUTES.find((route) => route.pattern.test(input))?.command;
}

const CORE_COMMAND_NAMES: Record<string, true> = {
  doctor: true,
  orient: true,
  explore: true,
  search: true,
  file: true,
  deps: true,
  review: true,
};

export function renderCliCommandList(advanced: boolean = false): string {
  const commands = advanced
    ? CLI_COMMAND_CATALOG
    : CLI_COMMAND_CATALOG.filter((command) => CORE_COMMAND_NAMES[command.name]);
  const width = Math.max(...commands.map((command) => command.name.length));
  return commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`).join("\n");
}
