import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs, runWithCliRuntime, writeError } from "../src/cli/context.js";
import {
  getCliCommandUsageSchemas,
  parseImpactScopeOption,
  parseNonNegativeIntegerOption,
  parseRefContextOption,
  parseSymbolGraphScopeOption,
  validateCliArgs,
} from "../src/cli/options.js";

describe("parseIntegerOptionValue strictness", () => {
  it("rejects hex, scientific, and empty integer strings", () => {
    expect(() => parseNonNegativeIntegerOption("0x5", "--depth", 0)).toThrow(/Invalid --depth value "0x5"/);
    expect(() => parseNonNegativeIntegerOption("1e2", "--depth", 0)).toThrow(/Invalid --depth value "1e2"/);
    expect(() => parseNonNegativeIntegerOption("", "--depth", 0)).toThrow(/Invalid --depth value ""/);
  });

  it("accepts plain decimal integers", () => {
    expect(parseNonNegativeIntegerOption("5", "--depth", 0)).toBe(5);
    expect(parseNonNegativeIntegerOption("0", "--depth", 0)).toBe(0);
  });
});

describe("CLI enum option parsers", () => {
  it("validates symbol graph scope values", () => {
    expect(parseSymbolGraphScopeOption("all", "--symbols-detailed-scope")).toBe("all");
    expect(parseSymbolGraphScopeOption(undefined, "--symbols-detailed-scope")).toBeUndefined();
    expect(() => parseSymbolGraphScopeOption("bogus", "--symbols-detailed-scope")).toThrow(
      /Invalid --symbols-detailed-scope value "bogus"/,
    );
  });

  it("validates ref context values", () => {
    expect(parseRefContextOption("block", "--ref-context")).toBe("block");
    expect(() => parseRefContextOption("raw", "--ref-context")).toThrow(/Invalid --ref-context value "raw"/);
    expect(parseImpactScopeOption("imported", "--scope")).toBe("imported");
  });
});

describe("parseCliArgs value-option guard", () => {
  it("parses --changed-since and --git-base as valued Git range options", () => {
    const review = parseCliArgs("review", ["--changed-since", "HEAD~1"]);
    const graphDelta = parseCliArgs("graph-delta", ["--git-base", "HEAD~1", "--git-head", "HEAD"]);

    expect(review.options.get("--changed-since")).toEqual(["HEAD~1"]);
    expect(graphDelta.options.get("--git-base")).toEqual(["HEAD~1"]);
    expect(graphDelta.options.get("--git-head")).toEqual(["HEAD"]);
  });

  it("does not consume a following flag as a value", () => {
    expect(() => parseCliArgs("graph", ["--threads", "--json"])).toThrow(/Missing value for --threads option/);
  });

  it("allows dash-prefixed option values that are not supported short flags", () => {
    const parsed = parseCliArgs("graph", ["--ignore-glob", "-generated/**", "--pattern", "-bar"]);
    expect(parsed.options.get("--ignore-glob")).toEqual(["-generated/**"]);
    expect(parsed.options.get("--pattern")).toEqual(["-bar"]);
  });

  it("still rejects supported short flags as missing long-option values", () => {
    expect(() => parseCliArgs("graph", ["--threads", "-v"])).toThrow(/Missing value for --threads option/);
    expect(() => parseCliArgs("graph", ["--output", "-o"])).toThrow(/Missing value for --output option/);
  });

  it("allows negative decimal values for integer options", () => {
    const parsed = parseCliArgs("hotspots", ["--limit", "-1"]);
    expect(parsed.options.get("--limit")).toEqual(["-1"]);
  });
});

describe("CLI command option validation", () => {
  it.each(["graph", "drift", "impact"])("rejects the removed --compact-json flag for %s", (command) => {
    const parsed = parseCliArgs(command, ["--compact-json"]);

    expect(() => validateCliArgs(command, parsed)).toThrow(`Unknown option for ${command}: --compact-json`);
  });

  it("rejects the removed --summary flag because review is compact by default", () => {
    const parsed = parseCliArgs("review", ["--summary"]);

    expect(() => validateCliArgs("review", parsed)).toThrow("Unknown option for review: --summary");
  });

  it("advertises both supported review output modes in validation usage", () => {
    const parsed = parseCliArgs("review", ["first", "second"]);

    expect(() => validateCliArgs("review", parsed)).toThrow("[--json | --pretty]");
  });

  it("accepts explicit JSON output for installer commands", () => {
    for (const command of ["install", "uninstall"]) {
      const parsed = parseCliArgs(command, ["--json"]);

      expect(() => validateCliArgs(command, parsed)).not.toThrow();
    }
  });

  it("rejects --cache for lifecycle commands (init/status/sync) since buildLifecycleManifest always forces disk cache", () => {
    for (const command of ["init", "status", "sync"]) {
      const parsed = parseCliArgs(command, ["--cache", "off"]);

      expect(() => validateCliArgs(command, parsed)).toThrow(`Unknown option for ${command}: --cache`);
    }
  });

  it("still rejects --cache for uninit, which never accepted it", () => {
    const parsed = parseCliArgs("uninit", ["--cache", "off"]);

    expect(() => validateCliArgs("uninit", parsed)).toThrow("Unknown option for uninit: --cache");
  });

  it("still accepts --cache for commands that legitimately support an explicit cache override", () => {
    for (const command of ["orient", "search"]) {
      const parsed = parseCliArgs(command, ["--cache", "off"]);

      expect(() => validateCliArgs(command, parsed)).not.toThrow();
    }
  });

  it("accepts explicit pretty output for every lifecycle command", () => {
    for (const command of ["init", "status", "sync", "uninit"]) {
      const parsed = parseCliArgs(command, ["--pretty"]);

      expect(() => validateCliArgs(command, parsed)).not.toThrow();
    }
  });

  it("accepts JSON and pretty together so JSON can take precedence", () => {
    for (const command of ["doctor", "orient", "install"]) {
      const parsed = parseCliArgs(command, ["--json", "--pretty"]);

      expect(() => validateCliArgs(command, parsed)).not.toThrow();
    }
  });

  it("lists both refs output modes in usage errors", () => {
    const parsed = parseCliArgs("refs", ["main.ts", "1", "2", "extra"]);

    expect(() => validateCliArgs("refs", parsed)).toThrow("[--json | --pretty]");
  });

  it("rejects build-only flags for status, which never calls createAgentSession/loadProject", () => {
    for (const flag of ["--cache-verify", "--progress", "--no-progress", "--workers"]) {
      const parsed = parseCliArgs("status", [flag]);

      expect(() => validateCliArgs("status", parsed)).toThrow(`Unknown option for status: ${flag}`);
    }
  });

  it("rejects --threads for status, which never builds and so has no use for a concurrency option", () => {
    const parsed = parseCliArgs("status", ["--threads", "4"]);

    expect(() => validateCliArgs("status", parsed)).toThrow("Unknown option for status: --threads");
  });

  it("accepts build flags for init and sync, which do call session.loadProject", () => {
    for (const command of ["init", "sync"]) {
      for (const flag of ["--cache-verify", "--progress", "--no-progress", "--workers"]) {
        const parsed = parseCliArgs(command, [flag]);

        expect(() => validateCliArgs(command, parsed)).not.toThrow();
      }

      const parsedThreads = parseCliArgs(command, ["--threads", "4"]);
      expect(() => validateCliArgs(command, parsedThreads)).not.toThrow();
    }
  });
  it("rejects conflicting progress flags", () => {
    const parsed = parseCliArgs("orient", ["--progress", "--no-progress"]);

    expect(() => validateCliArgs("orient", parsed)).toThrow("--progress and --no-progress cannot be used together.");
  });
  it("accepts --no-update-gitignore only for init and initializing sync", () => {
    expect(() => validateCliArgs("init", parseCliArgs("init", ["--no-update-gitignore"]))).not.toThrow();
    expect(() => validateCliArgs("sync", parseCliArgs("sync", ["--init", "--no-update-gitignore"]))).not.toThrow();
    expect(() => validateCliArgs("sync", parseCliArgs("sync", ["--no-update-gitignore"]))).toThrow(
      "--no-update-gitignore for sync requires --init",
    );

    for (const command of ["status", "uninit"]) {
      const parsed = parseCliArgs(command, ["--no-update-gitignore"]);
      expect(() => validateCliArgs(command, parsed)).toThrow(`Unknown option for ${command}: --no-update-gitignore`);
    }
  });
});

describe("validation usage schema alignment", () => {
  it("mentions every schema-accepted output-format and traversal flag", () => {
    const trackedFlags = ["--json", "--pretty", "--depth", "--all"];

    for (const schema of getCliCommandUsageSchemas()) {
      const acceptedFlags = [...schema.flags, ...schema.options];
      for (const flag of trackedFlags) {
        if (acceptedFlags.includes(flag)) {
          expect(schema.usage, `${schema.command} usage should mention ${flag}`).toContain(flag);
        }
      }
    }
  });
});

describe("JSON output flag command allow-list", () => {
  it("accepts --json and --pretty for graph-delta, artifact, and chunk", () => {
    for (const command of ["graph-delta", "artifact", "chunk"]) {
      expect(() => validateCliArgs(command, parseCliArgs(command, ["--json"]))).not.toThrow();
      expect(() => validateCliArgs(command, parseCliArgs(command, ["--pretty"]))).not.toThrow();
    }
  });

  it("accepts install --force and documents the collision recovery flag in schema usage", () => {
    expect(() => validateCliArgs("install", parseCliArgs("install", ["--force", "--dry-run"]))).not.toThrow();
    expect(() => validateCliArgs("install", parseCliArgs("install", ["--json"]))).not.toThrow();
    expect(() => validateCliArgs("install", parseCliArgs("install", ["--pretty"]))).not.toThrow();
  });

  it("still rejects genuinely unsupported flags for graph-delta", () => {
    expect(() => validateCliArgs("graph-delta", parseCliArgs("graph-delta", ["--not-a-real-flag"]))).toThrow(
      "Unknown option for graph-delta: --not-a-real-flag",
    );
  });

  it("rejects --json on viewer and mcp while keeping version --json", () => {
    expect(() => validateCliArgs("viewer", parseCliArgs("viewer", ["--json"]))).toThrow(
      "Unknown option for viewer: --json",
    );
    expect(() => validateCliArgs("mcp", parseCliArgs("mcp", ["--json"]))).toThrow("Unknown option for mcp: --json");
    expect(() => validateCliArgs("viewer", parseCliArgs("viewer", ["--pretty"]))).toThrow(
      "Unknown option for viewer: --pretty",
    );
    expect(() => validateCliArgs("version", parseCliArgs("version", ["--json"]))).not.toThrow();
    expect(() => validateCliArgs("version", parseCliArgs("version", ["--pretty"]))).not.toThrow();
  });
});

describe("graph/index schema split (C3)", () => {
  // Every option the `graph` handler actually reads (src/cli/graph.ts). Index intentionally
  // rejects all of these: it has no dot/mermaid/symbols/sqlite/output rendering path.
  const graphOnlyFlags = [
    "--dot",
    "--mermaid",
    "--sql-artifacts",
    "--stable",
    "--stdout",
    "--symbols",
    "--symbols-detailed",
    "--symbols-detailed-members-only",
    "--symbols-only",
  ];
  const graphOnlyOptions = [
    "--out",
    "--output",
    "--sqlite",
    "--db",
    "--stderr-file",
    "--symbols-detailed-scope",
    "--symbols-detailed-max-edges",
  ];
  // Every option `index` actually reads (src/cli/index.ts) that `graph` does not implement.
  const indexOnlyFlags = ["--full", "--verbose"];

  it.each(graphOnlyFlags)("accepts %s for graph but rejects it for index", (flag) => {
    expect(() => validateCliArgs("graph", parseCliArgs("graph", [flag]))).not.toThrow();
    expect(() => validateCliArgs("index", parseCliArgs("index", [flag]))).toThrow(`Unknown option for index: ${flag}`);
  });

  it.each(graphOnlyOptions)("accepts %s <value> for graph but rejects it for index", (option) => {
    expect(() => validateCliArgs("graph", parseCliArgs("graph", [option, "x"]))).not.toThrow();
    expect(() => validateCliArgs("index", parseCliArgs("index", [option, "x"]))).toThrow(
      `Unknown option for index: ${option}`,
    );
  });

  it.each(indexOnlyFlags)("accepts %s for index but rejects it for graph", (flag) => {
    expect(() => validateCliArgs("index", parseCliArgs("index", [flag]))).not.toThrow();
    expect(() => validateCliArgs("graph", parseCliArgs("graph", [flag]))).toThrow(`Unknown option for graph: ${flag}`);
  });

  it("both graph and index still accept every shared build flag/option", () => {
    const shared = ["--cache-strict", "--cache-verify", "--no-gitignore", "--fast-graph"];
    for (const flag of shared) {
      expect(() => validateCliArgs("graph", parseCliArgs("graph", [flag]))).not.toThrow();
      expect(() => validateCliArgs("index", parseCliArgs("index", [flag]))).not.toThrow();
    }
    for (const option of ["--cache", "--threads", "--cache-dir"]) {
      expect(() => validateCliArgs("graph", parseCliArgs("graph", [option, "1"]))).not.toThrow();
      expect(() => validateCliArgs("index", parseCliArgs("index", [option, "1"]))).not.toThrow();
    }
  });
});

describe("graph/impact output-selector exclusivity (C9)", () => {
  it("accepts graph --json and --pretty together so JSON keeps precedence, matching every other command", () => {
    expect(() => validateCliArgs("graph", parseCliArgs("graph", ["--json", "--pretty"]))).not.toThrow();
  });

  it.each([
    { label: "--dot + --mermaid", args: ["--dot", "--mermaid"] },
    { label: "--json + --dot", args: ["--json", "--dot"] },
    { label: "--json + --mermaid", args: ["--json", "--mermaid"] },
    { label: "--json + --sqlite", args: ["--json", "--sqlite", "out.db"] },
    { label: "--dot + --sqlite", args: ["--dot", "--sqlite", "out.db"] },
    { label: "--mermaid + --sqlite", args: ["--mermaid", "--sqlite", "out.db"] },
  ])("rejects combining graph $label", ({ args }) => {
    expect(() => validateCliArgs("graph", parseCliArgs("graph", args))).toThrow(
      "graph output selectors are mutually exclusive",
    );
  });

  it("identifies --db as the SQLite output alias when it conflicts with another selector", () => {
    expect(() => validateCliArgs("graph", parseCliArgs("graph", ["--db", "out.db", "--dot"]))).toThrow(
      "graph output selectors are mutually exclusive: choose one of --json, --dot, --mermaid, or --sqlite (alias: --db).",
    );
  });

  it("accepts exactly one graph output selector at a time", () => {
    for (const args of [["--json"], ["--dot"], ["--mermaid"], ["--sqlite", "out.db"], []]) {
      expect(() => validateCliArgs("graph", parseCliArgs("graph", args))).not.toThrow();
    }
  });

  it("rejects combining impact --mermaid with --json but allows either alone", () => {
    expect(() => validateCliArgs("impact", parseCliArgs("impact", ["--mermaid", "--json"]))).toThrow(
      "impact output selectors are mutually exclusive: choose one of --json or --mermaid.",
    );
    expect(() => validateCliArgs("impact", parseCliArgs("impact", ["--mermaid"]))).not.toThrow();
    expect(() => validateCliArgs("impact", parseCliArgs("impact", ["--json"]))).not.toThrow();
  });
});

describe("mcp --idle-timeout-ms option classification (C2)", () => {
  it("classifies --idle-timeout-ms as a value option, not a boolean flag", () => {
    const parsed = parseCliArgs("mcp", ["--stdio", "--idle-timeout-ms", "1000"]);
    expect(parsed.options.get("--idle-timeout-ms")).toEqual(["1000"]);
    expect(parsed.flags.has("--idle-timeout-ms")).toBe(false);
    expect(() => validateCliArgs("mcp", parsed)).not.toThrow();
  });
});

describe("bare artifact --sqlite (C1)", () => {
  it("treats --sqlite as a boolean artifact selector whether or not 'build' is spelled out", () => {
    const bare = parseCliArgs("artifact", ["--root", ".", "--sqlite", "--json"]);
    expect(bare.flags.has("--sqlite")).toBe(true);
    expect(bare.options.has("--sqlite")).toBe(false);
    expect(() => validateCliArgs("artifact", bare)).not.toThrow();

    const explicit = parseCliArgs("artifact", ["build", "--root", ".", "--sqlite", "--json"]);
    expect(explicit.flags.has("--sqlite")).toBe(true);
    expect(explicit.options.has("--sqlite")).toBe(false);
  });
});

describe("writeError stack policy", () => {
  const previousDebug = process.env.CODEGRAPH_DEBUG;

  afterEach(() => {
    if (previousDebug === undefined) delete process.env.CODEGRAPH_DEBUG;
    else process.env.CODEGRAPH_DEBUG = previousDebug;
  });

  it("prints a concise message by default and a stack when CODEGRAPH_DEBUG is set", async () => {
    const error = new Error("boom-failure");
    error.stack = "Error: boom-failure\n    at fakeFrame (src/example.ts:1:1)";

    delete process.env.CODEGRAPH_DEBUG;
    const defaultStderr: string[] = [];
    await runWithCliRuntime(
      {
        stderr: (chunk) => {
          defaultStderr.push(chunk);
        },
        exit: ((code: number): never => {
          throw new Error(`unexpected exit ${code}`);
        }) as (code: number) => never,
      },
      async () => {
        writeError(error);
      },
    );
    expect(defaultStderr.join("")).toContain("boom-failure");
    expect(defaultStderr.join("")).not.toContain("fakeFrame");

    process.env.CODEGRAPH_DEBUG = "1";
    const debugStderr: string[] = [];
    await runWithCliRuntime(
      {
        stderr: (chunk) => {
          debugStderr.push(chunk);
        },
        exit: ((code: number): never => {
          throw new Error(`unexpected exit ${code}`);
        }) as (code: number) => never,
      },
      async () => {
        writeError(error);
      },
    );
    expect(debugStderr.join("")).toContain("fakeFrame");
  });
});
