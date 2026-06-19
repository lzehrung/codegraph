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
  "--provider",
  "--base",
  "--head",
  "--base-artifact",
  "--pr",
  "--repo",
  "--max-refs",
  "--depth",
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
  "--artifact",
  "--host",
  "--port",
]);

type CliPositionalPolicy =
  | { kind: "any" }
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
  "--include-glob",
  "--ignore-glob",
  "--resolution-hint",
];
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
      "--compact-json",
      "--dot",
      "--full",
      "--mermaid",
      "--sql-artifacts",
      "--stable",
      "--stdout",
      "--symbols",
      "--symbols-detailed",
      "--symbols-detailed-members-only",
      "--symbols-only",
      "--verbose",
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
    "apisurface",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], SHARED_BUILD_OPTIONS, {
      kind: "none",
      usage: "Usage: codegraph apisurface [--root <path>] [--json]",
    }),
  ],
  [
    "artifact",
    commandSchema(
      [...SHARED_BUILD_FLAGS, "--force", "--graph-json", "--json", "--questions", "--report", "--sqlite"],
      [...SHARED_BUILD_OPTIONS, "--out", "--output"],
      {
        kind: "max",
        max: 1,
        usage: "Usage: codegraph artifact build [--root <path>] [--out <dir>] [--json]",
      },
    ),
  ],
  [
    "chunk",
    commandSchema(["--json", "--text"], ["--language", "--max-tokens", "--min-tokens"], {
      kind: "max",
      max: 1,
      usage: "Usage: codegraph chunk <file-path> [options]",
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
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], [...SHARED_BUILD_OPTIONS, "--depth"], {
      kind: "max",
      max: 1,
      usage: "Usage: codegraph deps <file> [--root <path>] [--depth <n>] [--json]",
    }),
  ],
  [
    "doctor",
    commandSchema(["--json"], [], {
      kind: "max",
      max: 1,
      usage: "Usage: codegraph doctor [artifact-path]",
    }),
  ],
  [
    "drift",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--compact-json"],
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
      usage: "Usage: codegraph dumpmod <file> [--root <path>] [--json]",
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
    "goto",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], SHARED_BUILD_OPTIONS, {
      kind: "max",
      max: 3,
      usage: "Usage: codegraph goto <file> [line] [column] [--root <path>] [--json]",
    }),
  ],
  ["graph", graphCommandSchema({ kind: "any" })],
  [
    "graph-delta",
    commandSchema(
      [...SHARED_BUILD_FLAGS, "--incremental-strict"],
      [...SHARED_BUILD_OPTIONS, "--changed-since", "--git-base", "--git-head", "--output"],
      {
        kind: "none",
        usage: "Usage: codegraph graph-delta [--root <path>] [--git-base <ref> | --changed-since <ref>]",
      },
    ),
  ],
  [
    "grep",
    commandSchema(
      ["--ignore-case", "--json", "-i", "--no-gitignore"],
      ["--glob", "--ignore-glob", "--include-glob", "--max-hits", "--pattern", "--query", "--regex", "--root"],
      {
        kind: "none",
        usage: "Usage: codegraph grep [--root <dir>] (--query <query> | --pattern <regex>)",
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
        "--compact-json",
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
        usage: "Usage: codegraph impact [project-root] [--provider git|github|raw] [options]",
      },
    ),
  ],
  ["index", graphCommandSchema({ kind: "any" })],
  [
    "inspect",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], [...SHARED_BUILD_OPTIONS, "--limit"], { kind: "any" }),
  ],
  [
    "mcp",
    commandSchema(
      [...SHARED_BUILD_FLAGS, "--allow-build", "--stdio", "--warmup", "--warmup-symbols"],
      [...SHARED_BUILD_OPTIONS, "--artifact", "--host", "--port"],
      {
        kind: "max",
        max: 1,
        usage: "Usage: codegraph mcp serve [--root <path>] [--stdio | --port <number>]",
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
        usage: "Usage: codegraph packet get <target> [--root <path>] [--json | --pretty]",
      },
    ),
  ],
  [
    "path",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], SHARED_BUILD_OPTIONS, {
      kind: "max",
      max: 2,
      usage: "Usage: codegraph path <from-file> <to-file> [--root <path>] [--json]",
    }),
  ],
  [
    "rdeps",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS], [...SHARED_BUILD_OPTIONS, "--depth"], {
      kind: "max",
      max: 1,
      usage: "Usage: codegraph rdeps <file> [--root <path>] [--depth <n>] [--json]",
    }),
  ],
  [
    "refs",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS],
      [...SHARED_BUILD_OPTIONS, "--col", "--column", "--file", "--line"],
      {
        kind: "none",
        usage: "Usage: codegraph refs --file <file> --line <line> --col <column> [--root <path>]",
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
        "--summary",
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
        kind: "none",
        usage: "Usage: codegraph review [--root <path>] [--base <ref> --head <ref>] [--json | --summary]",
      },
    ),
  ],
  [
    "search",
    commandSchema(
      [...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--no-snippets"],
      [...SHARED_BUILD_OPTIONS, "--depth", "--from", "--limit", "--mode"],
      { kind: "any" },
    ),
  ],
  [
    "skill",
    commandSchema(["--force", "--json"], ["--agent", "--target"], {
      kind: "max",
      max: 2,
      usage: "Usage: codegraph skill <install|print-path|doctor> [--agent <name> | --target <dir>] [--force]",
    }),
  ],
  [
    "sql",
    commandSchema(["--json"], ["--db", "--query", "--sqlite"], {
      kind: "none",
      usage: 'Usage: codegraph sql --db <sqlite path> --query "SELECT ..."',
    }),
  ],
  [
    "unresolved",
    commandSchema([...SHARED_BUILD_FLAGS, ...JSON_OUTPUT_FLAGS, "--verbose"], SHARED_BUILD_OPTIONS, {
      kind: "none",
      usage: "Usage: codegraph unresolved [--root <path>] [--json]",
    }),
  ],
  [
    "version",
    commandSchema(["--json"], [], {
      kind: "none",
      usage: "Usage: codegraph version [--json]",
    }),
  ],
]);

function allowedFlagsForSchema(schema: CliCommandSchema): Set<string> {
  return new Set(["--help", "-h", "--version", "-v", ...(schema.flags ?? [])]);
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

export function isCliValueOption(command: string, key: string, positionals: readonly string[]): boolean {
  if (command === "artifact" && key === "--sqlite" && positionals[0] === "build") return false;
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

function parseIntegerOptionValue(
  rawValue: string,
  optionName: string,
  expectedDescription: string,
  minValue: number,
  maxValue?: number,
): number {
  const parsedValue = Number(rawValue);
  const isAboveMinimum = parsedValue >= minValue;
  const isBelowMaximum = maxValue === undefined || parsedValue <= maxValue;
  if (!Number.isInteger(parsedValue) || !isAboveMinimum || !isBelowMaximum) {
    throw new Error(`Invalid ${optionName} value "${rawValue}". Expected ${expectedDescription}.`);
  }
  return parsedValue;
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
