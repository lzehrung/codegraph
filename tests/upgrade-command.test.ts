import { describe, expect, test, vi } from "vitest";
import { createUpgradeReport, handleUpgradeCommand } from "../src/cli/upgrade.js";

const executeCommand = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  exec: executeCommand,
  execFile: executeCommand,
  execFileSync: executeCommand,
  execSync: executeCommand,
  spawn: executeCommand,
  spawnSync: executeCommand,
}));

function createDependencies(
  packageRoot: string,
  pathExists: (filePath: string) => boolean,
  version = "1.2.3",
  fetchImplementation: typeof fetch = () => Promise.reject(new Error("unexpected fetch")),
) {
  return {
    getPackageIdentity: () => ({
      name: "@lzehrung/codegraph",
      version,
      packageRoot,
    }),
    pathExists,
    fetch: vi.fn(fetchImplementation),
  };
}

describe("upgrade reports", () => {
  test.each([
    ["directory", "/work/codegraph"],
    ["git worktree file", "/work/codegraph-worktree"],
  ])("detects a source checkout from a .git %s", async (_kind, packageRoot) => {
    const dependencies = createDependencies(packageRoot, (filePath) => filePath === `${packageRoot}/.git`);

    const report = await createUpgradeReport({ targetVersion: "1.3.0" }, dependencies);

    expect(report).toEqual({
      schemaVersion: 1,
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      updateAvailable: true,
      channel: "source",
      command: "git pull\nnpm install\nnpm run build",
    });
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });

  test.each([
    "/usr/local/lib/node_modules/@lzehrung/codegraph",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@lzehrung\\codegraph",
    "/repo/node_modules/.pnpm/@lzehrung+codegraph/node_modules/@lzehrung/codegraph",
  ])("detects an npm installation across package path layouts", async (packageRoot) => {
    const dependencies = createDependencies(packageRoot, () => false);

    const report = await createUpgradeReport({ targetVersion: "2.0.0" }, dependencies);

    expect(report.channel).toBe("npm");
    expect(report.command).toBe(
      'npm config set "@lzehrung:registry" "https://npm.pkg.github.com"\n' + "npm install -g @lzehrung/codegraph@2.0.0",
    );
  });

  test("falls back safely when the install channel is unknown", async () => {
    const dependencies = createDependencies("/opt/codegraph", () => false);

    const report = await createUpgradeReport({ targetVersion: "1.3.0" }, dependencies);

    expect(report.channel).toBe("unknown");
    expect(report.command).toBeUndefined();
  });

  test.each(["1.2", "1", "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3-beta.1", "1.2.3+build", " 1.2.3"])(
    "rejects non-stable explicit target version %s",
    async (targetVersion) => {
      const dependencies = createDependencies("/opt/codegraph", () => false);

      await expect(createUpgradeReport({ targetVersion }, dependencies)).rejects.toThrow(
        `Invalid target version \"${targetVersion}\": expected stable X.Y.Z.`,
      );
      expect(dependencies.fetch).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["1.10.0", "1.9.99", true],
    ["2.0.0", "10.0.0", false],
    ["1.2.3", "1.2.3", false],
    ["1000000000000000000000000000000.0.0", "999999999999999999999999999999.0.0", true],
  ])("compares target %s to current %s numerically", async (targetVersion, currentVersion, updateAvailable) => {
    const dependencies = createDependencies("/opt/codegraph", () => false, currentVersion);

    const report = await createUpgradeReport({ targetVersion }, dependencies);

    expect(report.updateAvailable).toBe(updateAvailable);
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ["1.2.3-beta.1", "1.2.3", true],
    ["1.2.3-alpha.0+build.7", "1.2.3", true],
    ["1.2.3+build.7", "1.2.3", false],
    ["1.2.4-rc.1+build.7", "1.2.3", false],
  ])("compares current SemVer %s against stable target %s", async (currentVersion, targetVersion, updateAvailable) => {
    const dependencies = createDependencies("/opt/codegraph", () => false, currentVersion);

    const report = await createUpgradeReport({ targetVersion }, dependencies);

    expect(report.updateAvailable).toBe(updateAvailable);
    expect(report.error).toBeUndefined();
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });

  test.each(["1.2", "01.2.3", "1.2.3-01", "1.2.3+"])(
    "returns a soft error for malformed current package version %s",
    async (currentVersion) => {
      const dependencies = createDependencies("/opt/codegraph", () => false, currentVersion);

      const report = await createUpgradeReport({ targetVersion: "2.0.0" }, dependencies);

      expect(report).toEqual({
        schemaVersion: 1,
        currentVersion,
        updateAvailable: false,
        channel: "unknown",
        error: `Invalid current package version "${currentVersion}": expected SemVer.`,
      });
      expect(dependencies.fetch).not.toHaveBeenCalled();
    },
  );

  test("checks the latest GitHub release with API headers and no upgrade command", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Accept")).toBe("application/vnd.github+json");
      expect(headers.get("User-Agent")).toBe("@lzehrung/codegraph");
      expect(headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ tag_name: "v1.10.0" }), { status: 200 });
    });
    const dependencies = createDependencies(
      "/work/codegraph",
      (filePath) => filePath.endsWith("/.git"),
      "1.9.0",
      fetchImplementation,
    );

    const report = await createUpgradeReport({ checkOnly: true }, dependencies);

    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.github.com/repos/lzehrung/codegraph/releases/latest",
      expect.objectContaining({ method: "GET" }),
    );
    expect(report).toEqual({
      schemaVersion: 1,
      currentVersion: "1.9.0",
      latestVersion: "1.10.0",
      updateAvailable: true,
      channel: "source",
    });
  });

  test.each([
    [
      "non-200 response",
      async () => new Response(null, { status: 503 }),
      "GitHub release lookup failed with HTTP 503.",
    ],
    [
      "fetch rejection",
      async () => {
        throw new Error("offline");
      },
      "GitHub release lookup failed: offline.",
    ],
  ])("returns a soft error for a %s", async (_kind, fetchImplementation, error) => {
    const dependencies = createDependencies("/opt/codegraph", () => false, "1.2.3", fetchImplementation);

    const report = await createUpgradeReport({}, dependencies);

    expect(report).toEqual({
      schemaVersion: 1,
      currentVersion: "1.2.3",
      updateAvailable: false,
      channel: "unknown",
      error,
    });
  });

  test.each([
    ["malformed JSON", async () => new Response("{", { status: 200 }), "GitHub release response was not valid JSON."],
    [
      "missing release tag",
      async () => new Response(JSON.stringify({}), { status: 200 }),
      "GitHub release response did not include a valid tag_name.",
    ],
    [
      "non-string release tag",
      async () => new Response(JSON.stringify({ tag_name: 123 }), { status: 200 }),
      "GitHub release response did not include a valid tag_name.",
    ],
    [
      "invalid stable release tag",
      async () => new Response(JSON.stringify({ tag_name: "v1.2" }), { status: 200 }),
      "Latest release tag is not a stable X.Y.Z version: v1.2.",
    ],
    [
      "double-v release tag",
      async () => new Response(JSON.stringify({ tag_name: "vv1.2.3" }), { status: 200 }),
      "Latest release tag is not a stable X.Y.Z version: vv1.2.3.",
    ],
  ])("returns a soft error for %s", async (_kind, fetchImplementation, error) => {
    const dependencies = createDependencies("/opt/codegraph", () => false, "1.2.3", fetchImplementation);

    const report = await createUpgradeReport({}, dependencies);

    expect(report.error).toBe(error);
    expect(report.latestVersion).toBeUndefined();
    expect(report.command).toBeUndefined();
  });

  test("aborts the latest release lookup after three seconds", async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | null = null;
      const fetchImplementation = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            if (!init?.signal) throw new Error("missing abort signal");
            capturedSignal = init.signal;
            init.signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      );
      const dependencies = createDependencies("/opt/codegraph", () => false, "1.2.3", fetchImplementation);

      const reportPromise = createUpgradeReport({}, dependencies);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(capturedSignal).not.toBeNull();
      expect(capturedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(reportPromise).resolves.toMatchObject({
        error: "GitHub release lookup timed out after 3 seconds.",
      });
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  test("reports a timeout when the release response body stalls", async () => {
    vi.useFakeTimers();
    try {
      const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
        if (!init?.signal) throw new Error("missing abort signal");
        const signal = init.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener("abort", () => {
              controller.error(new DOMException("The operation was aborted.", "AbortError"));
            });
          },
        });
        return new Response(body, { status: 200 });
      });
      const dependencies = createDependencies("/opt/codegraph", () => false, "1.2.3", fetchImplementation);

      const reportPromise = createUpgradeReport({}, dependencies);
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(reportPromise).resolves.toMatchObject({
        error: "GitHub release lookup timed out after 3 seconds.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("writes an explicit upgrade report as JSON", async () => {
    const dependencies = createDependencies("/work/codegraph", (filePath) => filePath.endsWith("/.git"));
    const writeJSONLine = vi.fn();
    const writeStdoutLine = vi.fn();
    const writeStderrLine = vi.fn();

    await handleUpgradeCommand(
      {
        positionals: ["2.0.0"],
        checkOnly: false,
        json: true,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: (code): never => {
          throw new Error(`unexpected exit ${code}`);
        },
      },
      dependencies,
    );

    expect(writeJSONLine).toHaveBeenCalledOnce();
    expect(writeJSONLine).toHaveBeenCalledWith({
      schemaVersion: 1,
      currentVersion: "1.2.3",
      latestVersion: "2.0.0",
      updateAvailable: true,
      channel: "source",
      command: "git pull\nnpm install\nnpm run build",
    });
    expect(writeStdoutLine).not.toHaveBeenCalled();
    expect(writeStderrLine).not.toHaveBeenCalled();
  });

  test("writes lookup failures as machine-readable JSON without crashing", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      throw new Error("offline");
    });
    const dependencies = createDependencies("/opt/codegraph", () => false, "1.2.3", fetchImplementation);
    const writeJSONLine = vi.fn();
    const writeStdoutLine = vi.fn();
    const writeStderrLine = vi.fn();

    await handleUpgradeCommand(
      {
        positionals: [],
        checkOnly: true,
        json: true,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: (code): never => {
          throw new Error(`unexpected exit ${code}`);
        },
      },
      dependencies,
    );

    expect(writeJSONLine).toHaveBeenCalledWith({
      schemaVersion: 1,
      currentVersion: "1.2.3",
      updateAvailable: false,
      channel: "unknown",
      error: "GitHub release lookup failed: offline.",
    });
    expect(writeStdoutLine).not.toHaveBeenCalled();
    expect(writeStderrLine).not.toHaveBeenCalled();
  });

  test("writes lookup failures as text without claiming no update is available", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      throw new Error("offline");
    });
    const dependencies = createDependencies("/opt/codegraph", () => false, "1.2.3", fetchImplementation);
    const writeStdoutLine = vi.fn();

    await handleUpgradeCommand(
      {
        positionals: [],
        checkOnly: true,
        json: false,
        writeJSONLine: vi.fn(),
        writeStdoutLine,
        writeStderrLine: vi.fn(),
        exit: (code): never => {
          throw new Error(`unexpected exit ${code}`);
        },
      },
      dependencies,
    );

    expect(writeStdoutLine.mock.calls).toEqual([
      ["Current version: 1.2.3"],
      ["Install channel: unknown"],
      ["GitHub release lookup failed: offline."],
    ]);
  });

  test("writes safe source instructions as text without executing them", async () => {
    const dependencies = createDependencies("/work/codegraph", (filePath) => filePath.endsWith("/.git"));
    const writeStdoutLine = vi.fn();
    const writeJSONLine = vi.fn();
    const writeStderrLine = vi.fn();

    await handleUpgradeCommand(
      {
        positionals: ["2.0.0"],
        checkOnly: false,
        json: false,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: (code): never => {
          throw new Error(`unexpected exit ${code}`);
        },
      },
      dependencies,
    );

    expect(writeStdoutLine.mock.calls).toEqual([
      ["Current version: 1.2.3"],
      ["Latest version: 2.0.0"],
      ["Update available: yes"],
      ["Install channel: source"],
      ["Upgrade instructions:"],
      ["git pull\nnpm install\nnpm run build"],
    ]);
    expect(writeJSONLine).not.toHaveBeenCalled();
    expect(writeStderrLine).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test("prints check status without upgrade instructions", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ tag_name: "v2.0.0" }), { status: 200 });
    });
    const dependencies = createDependencies(
      "/work/codegraph",
      (filePath) => filePath.endsWith("/.git"),
      "1.2.3",
      fetchImplementation,
    );
    const writeStdoutLine = vi.fn();

    await handleUpgradeCommand(
      {
        positionals: [],
        checkOnly: true,
        json: false,
        writeJSONLine: vi.fn(),
        writeStdoutLine,
        writeStderrLine: vi.fn(),
        exit: (code): never => {
          throw new Error(`unexpected exit ${code}`);
        },
      },
      dependencies,
    );

    expect(writeStdoutLine).toHaveBeenLastCalledWith("Install channel: source");
    expect(writeStdoutLine).not.toHaveBeenCalledWith("Upgrade instructions:");
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test("fetches a release for bare upgrade and returns source instructions", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ tag_name: "2.0.0" }), { status: 200 });
    });
    const dependencies = createDependencies(
      "/work/codegraph",
      (filePath) => filePath.endsWith("/.git"),
      "1.2.3",
      fetchImplementation,
    );

    const report = await createUpgradeReport({}, dependencies);

    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(report.latestVersion).toBe("2.0.0");
    expect(report.command).toBe("git pull\nnpm install\nnpm run build");
  });

  test("prints a safe fallback instead of a command for unknown installs", async () => {
    const dependencies = createDependencies("/opt/codegraph", () => false);
    const writeStdoutLine = vi.fn();

    await handleUpgradeCommand(
      {
        positionals: ["2.0.0"],
        checkOnly: false,
        json: false,
        writeJSONLine: vi.fn(),
        writeStdoutLine,
        writeStderrLine: vi.fn(),
        exit: (code): never => {
          throw new Error(`unexpected exit ${code}`);
        },
      },
      dependencies,
    );

    expect(writeStdoutLine).toHaveBeenLastCalledWith(
      "Upgrade instructions unavailable: install channel could not be determined.",
    );
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test.each([
    [["v2.0.0"], false, 'Invalid target version "v2.0.0": expected stable X.Y.Z.'],
    [["2.0.0"], true, "--check cannot be combined with a target version."],
    [["2.0.0", "2.1.0"], false, "Expected at most one target version."],
  ])("exits with usage status for invalid arguments %#", async (positionals, checkOnly, message) => {
    const dependencies = createDependencies("/opt/codegraph", () => false);
    const writeStdoutLine = vi.fn();
    const writeJSONLine = vi.fn();
    const writeStderrLine = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });

    await expect(
      handleUpgradeCommand(
        {
          positionals,
          checkOnly,
          json: false,
          writeJSONLine,
          writeStdoutLine,
          writeStderrLine,
          exit,
        },
        dependencies,
      ),
    ).rejects.toThrow("exit 2");

    expect(writeStderrLine).toHaveBeenCalledOnce();
    expect(writeStderrLine).toHaveBeenCalledWith(message);
    expect(exit).toHaveBeenCalledWith(2);
    expect(writeStdoutLine).not.toHaveBeenCalled();
    expect(writeJSONLine).not.toHaveBeenCalled();
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });
});
