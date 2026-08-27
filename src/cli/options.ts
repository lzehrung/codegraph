export type CacheModeOption = "off" | "memory" | "disk";

export type ParsedCliArgs = {
  positionals: string[];
  flags: Set<string>;
  options: Map<string, string[]>;
};

const CLI_VALUE_OPTIONS = new Set<string>([
  "--root",
  "--output",
  "--out",
  "--stderr-file",
  "--threads",
  "--native",
  "--cache",
  "--cache-dir",
  "--changed-since",
  "--git-base",
  "--git-head",
  "--symbols-detailed-scope",
  "--symbols-detailed-max-edges",
  "--sqlite",
  "--db",
  "--file",
  "--line",
  "--col",
  "--column",
  "--query",
  "--pattern",
  "--regex",
  "--glob",
  "--file-glob",
  "--kind",
  "--provider",
  "--base",
  "--head",
  "--base-artifact",
  "--pr",
  "--repo",
  "--max-refs",
  "--max-changed-symbols",
  "--max-reference-lookups",
  "--max-total-references",
  "--time-budget-ms",
  "--depth",
  "--filter",
  "--sort",
  "--scope",
  "--ref-context",
  "--ref-context-lines",
  "--ref-block-max-lines",
  "--max-tests",
  "--max-callsites",
  "--language",
  "--min-tokens",
  "--max-tokens",
  "--max-bucket-size",
  "--min-confidence",
  "--max-hits",
  "--resolution-hint",
  "--review-depth",
  "--ignore-glob",
  "--include-glob",
  "--ignore-root-glob",
  "--include-root-glob",
  "--report-file",
  "--lcov",
  "--coverage-report",
  "--test-command-template",
  "--duplicates",
  "--agent",
  "--target",
  "--print-config",
  "--limit",
  "--fail-on",
  "--hotspot-jump-threshold",
  "--graph-edges",
  "--public-api",
  "--profile",
  "--budget",
  "--health",
  "--mode",
  "--from",
  "--max-dependencies",
  "--max-snippets",
  "--max-symbols",
  "--max-duplicates",
  "--max-packets",
  "--max-paths",
  "--artifact",
  "--host",
  "--graph",
  "--port",
  "--idle-timeout-ms",
  "--startup-timeout-ms",
  "--offset",
  "--max-bytes",
  "--max-edits",
  "--rename",
  "--max-references",
  "--max-callers",
  "--max-hierarchy",
]);

type CliPositionalPolicy =
  | { kind: "any"; usage?: string }
  | { kind: "max"; max: number; usage: string }
  | { kind: "none"; usage: string };

type CliCommandSchema = {
  flags?: readonly string[];
  options?: readonly string[];
  positionals: CliPositionalPolicy;
};

const SHARED_BUILD_FLAGS = [
  "--cache-strict",
  "--cache-verify",
  "--progress",
  "--no-progress",
  "--workers",
  "--no-gitignore",
  "--fast-graph",
  "--resolve-node-modules",
  "--dynamic-import-heuristics",
];
const SHARED_BUILD_OPTIONS = [
  "--root",
  "--threads",
  "--native",
  "--cache",
  "--cache-dir",
  "--include-glob",
  "--ignore-glob",
  "--resolution-hint",
];
// Lifecycle commands (init/status/sync) always warm/read the disk cache and never honor an
// explicit --cache override, so --cache is intentionally excluded here to keep the CLI
// contract truthful.
const LIFECYCLE_BUILD_OPTIONS = SHARED_BUILD_OPTIONS.filter((option) => option !== "--cache");
// `status` never calls createAgentSession/loadProject (it only hashes config, hashes build
// options, and lists project files for signature hashing), so progress, cache verification,
// and workers have no observable effect there, unlike for init/sync which do a full build.
const STATUS_BUILD_FLAGS = SHARED_BUILD_FLAGS.filter(
  (flag) => flag !== "--cache-verify" && flag !== "--progress" && flag !== "--no-progress" && flag !== "--workers",
);
// --threads only matters for the concurrency of an actual build (init/sync); status never builds.
const STATUS_BUILD_OPTIONS = LIFECYCLE_BUILD_OPTIONS.filter((option) => option !== "--threads");
const JSON_OUTPUT_FLAGS = ["--json", "--pretty"];
const REPORT_FLAGS = ["--report"];
const REPORT_OPTIONS = ["--report-file"];
const GIT_RANGE_OPTIONS = ["--base", "--head", "--changed-since"];
function commandSchema(flags: readonly string[], options: readonly string[], positionals: CliPositionalPolicy) {
  return { flags, options, positionals } satisfies CliCommandSchema;
}

function graphCommandSchema(positionals: CliPositionalPolicy): CliCommandSchema {
  return commandSchema(
    [
      ...SHARED_BUILD_FLAGS,
      ...JSON_OUTPUT_FLAGS,
      ...REPORT_FLAGS,
      "--dot",
      "--mermaid",
      "--sql-artifacts",
      "--stable",
      "--stdout",
      "--symbols",
      "--symbols-detailed",
      "--symbols-detailed-members-only",
      "--symbols-only",
    ],
    [
      ...SHARED_BUILD_OPTIONS,
      ...REPORT_OPTIONS,
      "--changed-since",
      "--git-base",
      "--git-head",
      "--db",
      "--ignore-root-glob",
      "--include-root-glob",
      "--output",
      "--out",
      "--sqlite",
      "--stderr-file",
      "--symbols-detailed-max-edges",
      "--symbols-detailed-scope",
    ],
    positionals,
  );
}

const CLI_COMMAND_SCHEMAS = new Map<string, CliCommandSchema>([
  [
    "affected",
    commandSchema(
      [...SHARED_BUILD_FLAGS, "--json", "--quiet", "--stdin"],
      [...SHARED_BUILD_OPTIONS, "--base", "--depth", "--filter", "--head"],
      {
        kind: "any",
        usage:
          "Usage: codegraph affected <file...> [--stdin] [--base <ref> --head <ref>] [--root <path>] [--depth <n>] [--filter <glob>] [--json | --quiet]",
      },
    ),
  ],
  [
    "apisurface",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], SHARED_BUILD_OPTIONS, {
      kind: "max",
      max: 1,
      usage: "Usage: codegraph apisurface [project-root] [--root <path>] [--json | --pretty]",
    }),
  ],
  [
    "artifact",
    commandSchema(
      [...SHARED_BUILD_FLAGS, "--force", "--graph-json", ...JSON_OUTPUT_FLAGS, "--questions", "--report", "--sqlite"],
      [...SHARED_BUILD_OPTIONS, "--out", "--output"],
      {
        kind: "max",
        max: 1,
        usage: "Usage: codegraph artifact [build] [--root <path>] [--out <dir>] [--json | --pretty]",
      },
    ),
  ],
  [
    "chunk",
    commandSchema([...JSON_OUTPUT_FLAGS, "--text"], ["--language", "--max-tokens", "--min-tokens"], {
      kind: "max",
      max: 1,
      usage:
        "Usage: codegraph chunk <file-path> [--language <language>] [--min-tokens <n>] [--max-tokens <n>] [--text] [--json | --pretty]",
    }),
  ],
  [
    "cycles",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], [...SHARED_BUILD_OPTIONS, "--sort"], {
      kind: "any",
    }),
  ],
  [
    "deps",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--all"], [...SHARED_BUILD_OPTIONS, "--depth"], {
      kind: "max",
      max: 1,
      usage:
        "Usage: codegraph deps <file|file::symbol|symbol:...> [--root <path>] [--depth <n> | --all] [--json | --pretty]",
    }),
  ],
  [
    "doctor",
    commandSchema(["--json", "--pretty"], [], {
      kind: "max",
      max: 1,
      usage: "Usage: codegraph doctor [artifact-path] [--json | --pretty]",
    }),
  ],
  [
    "drift",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS],
      [
        ...SHARED_BUILD_OPTIONS,
        "--base",
        "--base-artifact",
        "--fail-on",
        "--graph-edges",
        "--head",
        "--hotspot-jump-threshold",
        "--limit",
        "--public-api",
      ],
      { kind: "any" },
    ),
  ],
  [
    "dumpmod",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], SHARED_BUILD_OPTIONS, {
      kind: "max",
      max: 1,
      usage: "Usage: codegraph dumpmod <file> [--root <path>] [--json | --pretty]",
    }),
  ],
  [
    "duplicates",
    commandSchema(
      [
        ...SHARED_BUILD_FLAGS,
        ...JSON_OUTPUT_FLAGS,
        "--include-same-file",
        "--include-small",
        "--no-summary",
        "--raw-pairs",
      ],
      [
        ...SHARED_BUILD_OPTIONS,
        "--ignore-root-glob",
        "--include-root-glob",
        "--limit",
        "--max-bucket-size",
        "--max-tokens",
        "--min-confidence",
        "--min-tokens",
        "--profile",
        "--sort",
      ],
      { kind: "any" },
    ),
  ],
  [
    "explain",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--changed-context"],
      [
        ...SHARED_BUILD_OPTIONS,
        ...GIT_RANGE_OPTIONS,
        "--max-dependencies",
        "--max-duplicates",
        "--max-snippets",
        "--max-symbols",
      ],
      { kind: "any" },
    ),
  ],
  [
    "explore",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--no-source", "--include-graph-context", "--allow-sensitive"],
      [...SHARED_BUILD_OPTIONS, "--limit", "--max-packets", "--max-paths"],
      { kind: "any" },
    ),
  ],
  [
    "file",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--include-graph-context", "--allow-sensitive"],
      [...SHARED_BUILD_OPTIONS, "--offset", "--limit", "--max-bytes"],
      {
        kind: "max",
        max: 1,
        usage:
          "Usage: codegraph file <path> [--root <path>] [--offset <line>] [--limit <lines>] [--max-bytes <bytes>] [--include-graph-context] [--allow-sensitive] [--json | --pretty]",
      },
    ),
  ],
  [
    "goto",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], SHARED_BUILD_OPTIONS, {
      kind: "max",
      max: 3,
      usage:
        "Usage: codegraph goto <file|file::symbol|symbol:...> [--root <path>] [--json | --pretty]\n       codegraph goto <file>[:line[:column]] [line] [column] [--root <path>] [--json | --pretty]",
    }),
  ],
  ["graph", graphCommandSchema({ kind: "any" })],
  [
    "index",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, ...REPORT_FLAGS, "--full", "--verbose"],
      [...SHARED_BUILD_OPTIONS, ...REPORT_OPTIONS],
      { kind: "any" },
    ),
  ],
  [
    "graph-delta",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--incremental-strict"],
      [...SHARED_BUILD_OPTIONS, "--changed-since", "--git-base", "--git-head", "--output"],
      {
        kind: "max",
        max: 1,
        usage:
          "Usage: codegraph graph-delta [project-root] [--root <path>] [--git-base <ref> | --changed-since <ref>] [--json | --pretty]",
      },
    ),
  ],
  [
    "grep",
    commandSchema(
      ["--ignore-case", "--json", "--pretty", "-i", "--no-gitignore"],
      ["--glob", "--ignore-glob", "--include-glob", "--max-hits", "--pattern", "--query", "--regex", "--root"],
      {
        kind: "max",
        max: 1,
        usage:
          "Usage: codegraph grep <regex> [--root <dir>] [--pattern|--regex <expr>] [--query <tree-sitter-query>] [--glob|--include-glob|--ignore-glob <glob>] [--ignore-case|-i] [--no-gitignore] [--max-hits <n>] [--json | --pretty]",
      },
    ),
  ],
  [
    "hotspots",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], [...SHARED_BUILD_OPTIONS, "--limit"], { kind: "any" }),
  ],
  [
    "impact",
    commandSchema(
      [
        ...SHARED_BUILD_FLAGS,
        ...JSON_OUTPUT_FLAGS,
        "--compact",
        "--include-tests",
        "--members-only",
        "--mermaid",
        "--verify-refs",
      ],
      [
        ...SHARED_BUILD_OPTIONS,
        ...GIT_RANGE_OPTIONS,
        "--coverage-report",
        "--depth",
        "--duplicates",
        "--lcov",
        "--max-refs",
        "--max-changed-symbols",
        "--max-reference-lookups",
        "--max-total-references",
        "--time-budget-ms",
        "--pr",
        "--provider",
        "--ref-block-max-lines",
        "--ref-context",
        "--ref-context-lines",
        "--repo",
        "--scope",
        "--test-command-template",
      ],
      {
        kind: "max",
        max: 1,
        usage:
          "Usage: codegraph impact [project-root] [--provider git|github|raw] [--depth <n>] [options] [--json | --pretty]",
      },
    ),
  ],
  [
    "implementations",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], [...SHARED_BUILD_OPTIONS, "--limit"], {
      kind: "max",
      max: 1,
      usage: "Usage: codegraph implementations <symbol-target> [--root <path>] [--limit <0-500>] [--json | --pretty]",
    }),
  ],
  [
    "init",
    commandSchema(
      [...SHARED_BUILD_FLAGS, "--json", "--pretty", "--force", "--no-update-gitignore"],
      LIFECYCLE_BUILD_OPTIONS,
      {
        kind: "max",
        max: 1,
        usage:
          "Usage: codegraph init [path] [--force] [--no-update-gitignore] [--json | --pretty] OR codegraph init --root <path> [--force] [--no-update-gitignore] [--json | --pretty]",
      },
    ),
  ],
  [
    "install",
    commandSchema(
      ["--all", "--detect", "--dry-run", "--force", "--json", "--pretty", "--yes"],
      ["--print-config", "--target"],
      {
        kind: "max",
        max: 1,
        usage:
          "Usage: codegraph install [target] [--target <ids> | --all] [--detect] [--yes | --dry-run] [--force] [--json | --pretty] [--print-config <target>]",
      },
    ),
  ],
  [
    "uninstall",
    commandSchema(["--detect", "--dry-run", "--json", "--pretty", "--yes"], ["--target"], {
      kind: "max",
      max: 1,
      usage: "Usage: codegraph uninstall [target] [--target <ids>] [--detect] [--yes | --dry-run] [--json | --pretty]",
    }),
  ],
  [
    "inspect",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, ...REPORT_FLAGS, "--duplicates"],
      [...SHARED_BUILD_OPTIONS, ...REPORT_OPTIONS, "--limit"],
      {
        kind: "any",
      },
    ),
  ],
  [
    "mcp",
    commandSchema(
      [...SHARED_BUILD_FLAGS, "--allow-build", "--stdio", "--warmup", "--warmup-symbols"],
      [...SHARED_BUILD_OPTIONS, "--artifact", "--host", "--port", "--idle-timeout-ms"],
      {
        kind: "max",
        max: 1,
        usage: "Usage: codegraph mcp [serve] [--root <path>] [--stdio | --port <number>]",
      },
    ),
  ],
  [
    "server",
    commandSchema(
      [
        "--cache-strict",
        "--cache-verify",
        "--no-gitignore",
        "--replace",
        "--warmup",
        "--warmup-symbols",
        "--workers",
        ...JSON_OUTPUT_FLAGS,
      ],
      [
        "--cache",
        "--cache-dir",
        "--host",
        "--ignore-glob",
        "--include-glob",
        "--native",
        "--port",
        "--resolution-hint",
        "--root",
        "--startup-timeout-ms",
        "--threads",
      ],
      {
        kind: "max",
        max: 1,
        usage: "Usage: codegraph server <start|status|stop> [--root <path>] [--json | --pretty]",
      },
    ),
  ],
  [
    "orient",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], [...SHARED_BUILD_OPTIONS, "--budget", "--health"], {
      kind: "any",
    }),
  ],
  [
    "packet",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS],
      [...SHARED_BUILD_OPTIONS, "--max-duplicates", "--max-snippets", "--max-symbols"],
      {
        kind: "max",
        max: 2,
        usage: "Usage: codegraph packet [get] <target> [--root <path>] [--json | --pretty]",
      },
    ),
  ],
  [
    "path",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], SHARED_BUILD_OPTIONS, {
      kind: "max",
      max: 2,
      usage: "Usage: codegraph path <from-file> <to-file> [--root <path>] [--json | --pretty]",
    }),
  ],
  [
    "rdeps",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--all"], [...SHARED_BUILD_OPTIONS, "--depth"], {
      kind: "max",
      max: 1,
      usage:
        "Usage: codegraph rdeps <file|file::symbol|symbol:...> [--root <path>] [--depth <n> | --all] [--json | --pretty]",
    }),
  ],
  [
    "refs",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS],
      [...SHARED_BUILD_OPTIONS, "--col", "--column", "--file", "--line"],
      {
        kind: "max",
        max: 3,
        usage:
          "Usage: codegraph refs <file|file::symbol|symbol:...> [--root <path>] [--json | --pretty]\n       codegraph refs <file>[:line[:column]] [line] [column] [--root <path>] [--json | --pretty]\n       codegraph refs --file <file> [--line <line> --col <column>] [--root <path>] [--json | --pretty]",
      },
    ),
  ],
  [
    "review",
    commandSchema(
      [
        ...SHARED_BUILD_FLAGS,
        ...JSON_OUTPUT_FLAGS,
        ...REPORT_FLAGS,
        "--include-symbol-details",
        "--incremental-strict",
      ],
      [
        ...SHARED_BUILD_OPTIONS,
        ...REPORT_OPTIONS,
        ...GIT_RANGE_OPTIONS,
        "--duplicates",
        "--max-callsites",
        "--max-tests",
        "--review-depth",
      ],
      {
        kind: "max",
        max: 1,
        usage:
          "Usage: codegraph review [project-root] [--root <path>] [--base <ref>] [--head <ref>] [--changed-since <ref>] [--json | --pretty]",
      },
    ),
  ],
  [
    "rename-preview",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--include-comments", "--include-strings", "--include-filenames"],
      [...SHARED_BUILD_OPTIONS, "--max-edits"],
      {
        kind: "max",
        max: 2,
        usage:
          "Usage: codegraph rename-preview <symbol-target> <new-name> [--include-comments] [--include-strings] [--include-filenames] [--max-edits N] [--json | --pretty]",
      },
    ),
  ],
  [
    "refactor-plan",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--include-source"],
      [...SHARED_BUILD_OPTIONS, "--rename", "--max-references", "--max-callers", "--max-hierarchy"],
      {
        kind: "max",
        max: 1,
        usage:
          "Usage: codegraph refactor-plan <symbol-target> [--rename <new-name>] [--max-references <0-500>] [--max-callers <0-500>] [--max-hierarchy <0-500>] [--include-source] [--json | --pretty]",
      },
    ),
  ],

  [
    "search",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, ...REPORT_FLAGS, "--no-snippets"],
      [...SHARED_BUILD_OPTIONS, ...REPORT_OPTIONS, "--depth", "--from", "--limit", "--mode"],
      { kind: "any" },
    ),
  ],
  [
    "symbols",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--exported", "--include-imports"],
      [...SHARED_BUILD_OPTIONS, "--file-glob", "--kind", "--limit"],
      { kind: "any" },
    ),
  ],
  [
    "callees",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--include-heuristic"],
      [...SHARED_BUILD_OPTIONS, "--depth", "--limit"],
      {
        kind: "max",
        max: 1,
        usage:
          "Usage: codegraph callees <symbol-target> [--root <path>] [--depth <1-5>] [--limit <0-500>] [--include-heuristic] [--json | --pretty]",
      },
    ),
  ],
  [
    "callers",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--include-heuristic"],
      [...SHARED_BUILD_OPTIONS, "--depth", "--limit"],
      {
        kind: "max",
        max: 1,
        usage:
          "Usage: codegraph callers <symbol-target> [--root <path>] [--depth <1-5>] [--limit <0-500>] [--include-heuristic] [--json | --pretty]",
      },
    ),
  ],
  [
    "subtypes",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], [...SHARED_BUILD_OPTIONS, "--depth", "--limit"], {
      kind: "max",
      max: 1,
      usage:
        "Usage: codegraph subtypes <symbol-target> [--root <path>] [--depth <1-10>] [--limit <0-500>] [--json | --pretty]",
    }),
  ],
  [
    "supertypes",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], [...SHARED_BUILD_OPTIONS, "--depth", "--limit"], {
      kind: "max",
      max: 1,
      usage:
        "Usage: codegraph supertypes <symbol-target> [--root <path>] [--depth <1-10>] [--limit <0-500>] [--json | --pretty]",
    }),
  ],
  [
    "skill",
    commandSchema(["--force", "--json", "--pretty"], ["--agent", "--target"], {
      kind: "max",
      max: 2,
      usage:
        "Usage: codegraph skill <install|print-path|doctor> [--agent <name> | --target <dir>] [--force] [--json | --pretty]",
    }),
  ],
  [
    "status",
    commandSchema([...STATUS_BUILD_FLAGS, "--json", "--pretty"], STATUS_BUILD_OPTIONS, {
      kind: "max",
      max: 1,
      usage: "Usage: codegraph status [path] [--json | --pretty] OR codegraph status --root <path> [--json | --pretty]",
    }),
  ],
  [
    "sync",
    commandSchema(
      [...SHARED_BUILD_FLAGS, "--json", "--pretty", "--init", "--no-update-gitignore"],
      LIFECYCLE_BUILD_OPTIONS,
      {
        kind: "max",
        max: 1,
        usage:
          "Usage: codegraph sync [path] [--init] [--no-update-gitignore] [--json | --pretty] OR codegraph sync --root <path> [--init] [--no-update-gitignore] [--json | --pretty]",
      },
    ),
  ],
  [
    "sql",
    commandSchema(["--json", "--pretty"], ["--db", "--query", "--sqlite"], {
      kind: "max",
      max: 2,
      usage:
        'Usage: codegraph sql <sqlite-path> "SELECT ..." [--json | --pretty] OR codegraph sql --db <sqlite path> --query "SELECT ..." [--json | --pretty]',
    }),
  ],
  [
    "uninit",
    commandSchema(["--force", "--json", "--pretty"], ["--root"], {
      kind: "max",
      max: 1,
      usage:
        "Usage: codegraph uninit [path] [--force] [--json | --pretty] OR codegraph uninit --root <path> [--force] [--json | --pretty]",
    }),
  ],
  [
    "viewer",
    commandSchema(["--open", "--print-url"], ["--root", "--graph", "--host", "--port"], {
      kind: "none",
      usage:
        "Usage: codegraph viewer [--root <path>] [--graph <root-confined-json>] [--host <host>] [--port <0-65535>] [--open] [--print-url]",
    }),
  ],
  [
    "links",
    commandSchema(
      ["--verbose", "--no-gitignore", ...JSON_OUTPUT_FLAGS],
      ["--root", "--include-glob", "--ignore-glob"],
      {
        kind: "max",
        max: 1,
        usage:
          "Usage: codegraph links [project-root] [--root <path>] [--include-glob <glob>] [--ignore-glob <glob>] [--no-gitignore] [--json | --pretty] [--verbose]",
      },
    ),
  ],
  [
    "unresolved",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--verbose"], SHARED_BUILD_OPTIONS, {
      kind: "max",
      max: 1,
      usage: "Usage: codegraph unresolved [project-root] [--root <path>] [--json | --pretty]",
    }),
  ],
  [
    "version",
    commandSchema(["--json", "--pretty"], [], {
      kind: "none",
      usage: "Usage: codegraph version [--json | --pretty]",
    }),
  ],
]);

export type CliCommandUsageSchema = {
  command: string;
  flags: readonly string[];
  options: readonly string[];
  usage: string;
};

export function getCliCommandUsageSchemas(): readonly CliCommandUsageSchema[] {
  return [...CLI_COMMAND_SCHEMAS].flatMap(([command, schema]) => {
    const usage = schema.positionals.usage;
    return usage
      ? [
          {
            command,
            flags: schema.flags ?? [],
            options: schema.options ?? [],
            usage,
          },
        ]
      : [];
  });
}

export function getCliCommandUsage(command: string): string {
  const usage = CLI_COMMAND_SCHEMAS.get(command)?.positionals.usage;
  if (!usage) {
    throw new Error(`No validation usage is defined for ${command}.`);
  }
  return usage;
}

function allowedFlagsForSchema(schema: CliCommandSchema): Set<string> {
  return new Set(["--help", "-h", "--version", "-v", "--debug", ...(schema.flags ?? [])]);
}

function allowedOptionsForSchema(schema: CliCommandSchema): Set<string> {
  return new Set(schema.options ?? []);
}

export function validateCliArgs(command: string, parsed: ParsedCliArgs): void {
  const schema = CLI_COMMAND_SCHEMAS.get(command);
  if (!schema) return;

  const allowedFlags = allowedFlagsForSchema(schema);
  for (const flag of parsed.flags) {
    if (!allowedFlags.has(flag)) {
      throw new Error(`Unknown option for ${command}: ${flag}`);
    }
  }

  const allowedOptions = allowedOptionsForSchema(schema);
  for (const option of parsed.options.keys()) {
    if (!allowedOptions.has(option)) {
      throw new Error(`Unknown option for ${command}: ${option}`);
    }
  }
  if (parsed.flags.has("--progress") && parsed.flags.has("--no-progress")) {
    throw new Error("--progress and --no-progress cannot be used together.");
  }

  if (command === "graph") {
    // --pretty is the documented explicit synonym for the default (non-JSON) output and never
    // conflicts with --json (docs/cli.md: "If --json and --pretty are both present, --json
    // wins"), so it is intentionally excluded from this exclusivity count.
    const outputSelectors = [
      parsed.flags.has("--json"),
      parsed.flags.has("--dot"),
      parsed.flags.has("--mermaid"),
      parsed.options.has("--sqlite") || parsed.options.has("--db"),
    ].filter(Boolean).length;
    if (outputSelectors > 1) {
      throw new Error(
        "graph output selectors are mutually exclusive: choose one of --json, --dot, --mermaid, or --sqlite (alias: --db).",
      );
    }
  }

  if (command === "impact" && parsed.flags.has("--json") && parsed.flags.has("--mermaid")) {
    throw new Error("impact output selectors are mutually exclusive: choose one of --json or --mermaid.");
  }

  if (command === "sync" && parsed.flags.has("--no-update-gitignore") && !parsed.flags.has("--init")) {
    throw new Error("--no-update-gitignore for sync requires --init.");
  }

  if (schema.positionals.kind === "none" && parsed.positionals.length) {
    throw new Error(
      `Unexpected positional argument for ${command}: ${parsed.positionals[0]!}\n${schema.positionals.usage}`,
    );
  }
  if (schema.positionals.kind === "max" && parsed.positionals.length > schema.positionals.max) {
    const unexpected = parsed.positionals[schema.positionals.max]!;
    throw new Error(`Unexpected positional argument for ${command}: ${unexpected}\n${schema.positionals.usage}`);
  }
}

export function isCliValueOption(command: string, key: string, _positionals: readonly string[]): boolean {
  if (command === "artifact" && key === "--sqlite") return false;
  if (command === "inspect" && key === "--duplicates") return false;
  return CLI_VALUE_OPTIONS.has(key);
}

export function parseCacheModeOption(rawValue: string | undefined): CacheModeOption | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (rawValue === "off" || rawValue === "memory" || rawValue === "disk") {
    return rawValue;
  }
  throw new Error(`Invalid --cache value "${rawValue}". Expected one of: off, memory, disk.`);
}

const STRICT_INTEGER_PATTERN = /^-?\d+$/;

function parseIntegerOptionValue(
  rawValue: string,
  optionName: string,
  expectedDescription: string,
  minValue: number,
  maxValue?: number,
): number {
  const trimmed = rawValue.trim();
  if (!STRICT_INTEGER_PATTERN.test(trimmed)) {
    throw new Error(`Invalid ${optionName} value "${rawValue}". Expected ${expectedDescription}.`);
  }
  const parsedValue = Number(trimmed);
  const isAboveMinimum = parsedValue >= minValue;
  const isBelowMaximum = maxValue === undefined || parsedValue <= maxValue;
  if (!Number.isInteger(parsedValue) || !isAboveMinimum || !isBelowMaximum) {
    throw new Error(`Invalid ${optionName} value "${rawValue}". Expected ${expectedDescription}.`);
  }
  return parsedValue;
}

export type SymbolGraphScopeOption = "all" | "imported";
export type RefContextOption = "line" | "block";

export function parseSymbolGraphScopeOption(
  rawValue: string | undefined,
  optionName: string,
): SymbolGraphScopeOption | undefined {
  if (rawValue === undefined) return undefined;
  if (rawValue === "all" || rawValue === "imported") return rawValue;
  throw new Error(`Invalid ${optionName} value "${rawValue}". Expected one of: all, imported.`);
}

export function parseRefContextOption(rawValue: string | undefined, optionName: string): RefContextOption | undefined {
  if (rawValue === undefined) return undefined;
  if (rawValue === "line" || rawValue === "block") return rawValue;
  throw new Error(`Invalid ${optionName} value "${rawValue}". Expected one of: line, block.`);
}

export function parseImpactScopeOption(
  rawValue: string | undefined,
  optionName: string,
): SymbolGraphScopeOption | undefined {
  return parseSymbolGraphScopeOption(rawValue, optionName);
}

function parseDefaultedIntegerOption(
  rawValue: string | undefined,
  optionName: string,
  defaultValue: number,
  expectedDescription: string,
  minValue: number,
  maxValue?: number,
): number {
  if (rawValue === undefined) {
    return defaultValue;
  }
  return parseIntegerOptionValue(rawValue, optionName, expectedDescription, minValue, maxValue);
}

function parseOptionalIntegerOption(
  rawValue: string | undefined,
  optionName: string,
  expectedDescription: string,
  minValue: number,
  maxValue?: number,
): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  return parseIntegerOptionValue(rawValue, optionName, expectedDescription, minValue, maxValue);
}

export function parsePositiveIntegerOption(
  rawValue: string | undefined,
  optionName: string,
  defaultValue: number,
): number {
  return parseDefaultedIntegerOption(rawValue, optionName, defaultValue, "a positive integer", 1);
}

export function parseOptionalPositiveIntegerOption(
  rawValue: string | undefined,
  optionName: string,
): number | undefined {
  return parseOptionalIntegerOption(rawValue, optionName, "a positive integer", 1);
}

export function parseNonNegativeIntegerOption(
  rawValue: string | undefined,
  optionName: string,
  defaultValue: number,
): number {
  return parseDefaultedIntegerOption(rawValue, optionName, defaultValue, "a non-negative integer", 0);
}

export function parseOptionalNonNegativeIntegerOption(
  rawValue: string | undefined,
  optionName: string,
): number | undefined {
  return parseOptionalIntegerOption(rawValue, optionName, "a non-negative integer", 0);
}

export function parseBoundedIntegerOption(
  rawValue: string | undefined,
  optionName: string,
  defaultValue: number,
  minValue: number,
  maxValue: number,
): number {
  return parseDefaultedIntegerOption(
    rawValue,
    optionName,
    defaultValue,
    `an integer from ${minValue} to ${maxValue}`,
    minValue,
    maxValue,
  );
}

export function parseOptionalBoundedIntegerOption(
  rawValue: string | undefined,
  optionName: string,
  minValue: number,
  maxValue: number,
): number | undefined {
  return parseOptionalIntegerOption(
    rawValue,
    optionName,
    `an integer from ${minValue} to ${maxValue}`,
    minValue,
    maxValue,
  );
}
