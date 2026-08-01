import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/context.js";
import {
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
  it("rejects the removed --compact-json flag for graph: JSON output is always compact now", () => {
    const parsed = parseCliArgs("graph", ["--json", "--compact-json"]);

    expect(() => validateCliArgs("graph", parsed)).toThrow("Unknown option for graph: --compact-json");
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
