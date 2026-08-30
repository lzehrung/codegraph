import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPackageCommand, runPackageSmoke } from "../scripts/certification/package-smoke-lib.mjs";

const temporaryDirectories: string[] = [];

type PackFile = { path: string; size: number; mode: number };
type PackInfo = {
  name: string;
  version: string;
  filename: string;
  files: PackFile[];
};
type TinyPackage = {
  name: string;
  version: string;
  sourceDirectory: string;
  tarballPath: string;
  pack: PackInfo;
};
type CommandResult = {
  command: string;
  exitCode: number | null;
  signal: null;
  stdout: string;
  stderr: string;
  rawStdout: string;
  rawStderr: string;
  durationMs: number;
  error?: string;
};
type CommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-certification-smoke-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function packTinyPackage(
  root: string,
  outputDirectory: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): TinyPackage {
  const safeName = String(manifest.name).replaceAll("@", "").replaceAll("/", "-");
  const sourceDirectory = path.join(root, "sources", safeName);
  fs.mkdirSync(sourceDirectory, { recursive: true });
  writeJson(path.join(sourceDirectory, "package.json"), manifest);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(sourceDirectory, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
  const result = runPackageCommand(
    "npm",
    ["pack", ".", "--json", "--ignore-scripts", "--pack-destination", outputDirectory],
    { cwd: sourceDirectory },
  );
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  const pack = (JSON.parse(result.rawStdout) as PackInfo[])[0];
  if (!pack) throw new Error("npm pack omitted its result");
  return {
    name: String(manifest.name),
    version: String(manifest.version),
    sourceDirectory,
    tarballPath: path.join(outputDirectory, pack.filename),
    pack,
  };
}

function success(stdout: unknown = ""): CommandResult {
  const rawStdout = typeof stdout === "string" ? stdout : JSON.stringify(stdout);
  return {
    command: "mocked",
    exitCode: 0,
    signal: null,
    stdout: rawStdout,
    stderr: "",
    rawStdout,
    rawStderr: "",
    durationMs: 1,
  };
}

const TAR_OPERATIONS = ["-tzf", "-tvzf", "-xzf"];

function tarOperation(args: string[]): string | undefined {
  return args.find((argument) => TAR_OPERATIONS.includes(argument));
}

function tarballArgument(args: string[]): string | undefined {
  const operationIndex = args.findIndex((argument) => TAR_OPERATIONS.includes(argument));
  return operationIndex < 0 ? undefined : args[operationIndex + 1];
}

async function createCandidateSet(target: string): Promise<{
  root: string;
  manifestPath: string;
  packages: TinyPackage[];
}> {
  const root = temporaryDirectory();
  const candidateDirectory = path.join(root, "release-candidates");
  const packagesDirectory = path.join(candidateDirectory, "packages");
  fs.mkdirSync(packagesDirectory, { recursive: true });
  const targetName = `@lzehrung/codegraph-native-${target}`;
  const packages = [
    packTinyPackage(
      root,
      packagesDirectory,
      {
        name: targetName,
        version: "3.0.0",
        main: `index.${target}.node`,
        files: [`index.${target}.node`],
      },
      { [`index.${target}.node`]: "tiny native addon bytes" },
    ),
    packTinyPackage(
      root,
      packagesDirectory,
      {
        name: "@lzehrung/codegraph-native",
        version: "3.0.0",
        type: "module",
        main: "index.js",
        files: ["index.js"],
      },
      { "index.js": "export const native = true;\n" },
    ),
    packTinyPackage(
      root,
      packagesDirectory,
      {
        name: "@lzehrung/codegraph-core",
        version: "2.0.0",
        type: "module",
        main: "dist/index.js",
        files: ["dist"],
      },
      {
        "dist/index.js": "export const codegraphCore = true;\n",
      },
    ),
    packTinyPackage(
      root,
      packagesDirectory,
      {
        name: "@lzehrung/codegraph",
        version: "2.0.0",
        type: "module",
        main: "dist/index.js",
        bin: { codegraph: "dist/bin/cli.js" },
        files: ["dist"],
        dependencies: { "@lzehrung/codegraph-core": "2.0.0" },
      },
      {
        "dist/index.js": "export const codegraph = true;\n",
        "dist/bin/cli.js": "#!/usr/bin/env node\n",
      },
    ),
  ];
  const files = packages.map((pkg) => ({
    package: pkg.name,
    ...(pkg.name === targetName ? { target } : {}),
    file: path.relative(candidateDirectory, pkg.tarballPath).replaceAll(path.sep, "/"),
    sha256: sha256(pkg.tarballPath),
    size: fs.statSync(pkg.tarballPath).size,
  }));
  const manifestPath = path.join(candidateDirectory, "release-candidate-manifest.json");
  writeJson(manifestPath, {
    schemaVersion: 1,
    sourceRevision: "a".repeat(40),
    rootVersion: "2.0.0",
    nativeVersion: "3.0.0",
    files,
  });
  return { root, manifestPath, packages };
}

function createMockCommandRunner(
  packages: TinyPackage[],
  options: {
    wrongTargetPackage?: string;
    archiveEntries?: string[];
    unsupportedArchiveEntry?: boolean;
    tarUnavailable?: boolean;
  } = {},
): {
  calls: string[][];
  run: (command: string, args: string[], commandOptions?: CommandOptions) => Promise<CommandResult>;
} {
  const calls: string[][] = [];
  const byTarball = new Map(packages.map((pkg) => [path.resolve(pkg.tarballPath), pkg]));

  async function run(command: string, args: string[], commandOptions: CommandOptions = {}): Promise<CommandResult> {
    calls.push([command, ...args]);
    const operation = command === "tar" ? tarOperation(args) : undefined;
    if (command === "tar" && options.tarUnavailable) {
      return { ...success(), exitCode: null, error: "spawnSync tar ENOENT" };
    }
    if (args[0] === "install") {
      const installDirectory = commandOptions.cwd;
      if (!installDirectory) throw new Error("Mocked install omitted cwd");
      for (const pkg of packages) {
        const packageDirectory = path.join(installDirectory, "node_modules", ...pkg.name.split("/"));
        fs.cpSync(pkg.sourceDirectory, packageDirectory, { recursive: true });
      }
      return success("installed local tarballs");
    }
    if (command === "tar" && (operation === "-tzf" || operation === "-tvzf")) {
      const archivePath = tarballArgument(args);
      const pkg = byTarball.get(path.resolve(commandOptions.cwd ?? "", archivePath ?? ""));
      if (!pkg) throw new Error(`Unexpected archive listing ${String(archivePath)}`);
      const entries = options.archiveEntries ?? pkg.pack.files.map((file) => `package/${file.path}`);
      if (operation === "-tzf") return success(entries.join("\n"));
      return success(
        entries
          .map((entry, index) => {
            let entryType = entry.endsWith("/") ? "d" : "-";
            if (options.unsupportedArchiveEntry && index === 0) entryType = "l";
            return `${entryType}rw-r--r-- package package 0 2026-01-01 00:00 ${entry}`;
          })
          .join("\n"),
      );
    }
    if (command === "tar" && operation === "-xzf") {
      const archivePath = tarballArgument(args);
      const pkg = byTarball.get(path.resolve(commandOptions.cwd ?? "", archivePath ?? ""));
      if (!pkg) throw new Error(`Unexpected archive extraction ${String(archivePath)}`);
      const destination = args[args.indexOf("-C") + 1];
      if (!destination) throw new Error("Mocked archive extraction omitted destination");
      fs.cpSync(pkg.sourceDirectory, path.join(destination, "package"), { recursive: true });
      if (options.wrongTargetPackage && pkg.name.includes("native-win32")) {
        const manifestPath = path.join(destination, "package", "package.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        manifest.name = options.wrongTargetPackage;
        writeJson(manifestPath, manifest);
      }
      return success("extracted certified package");
    }
    if (args.includes("--eval")) {
      const source = args[args.indexOf("--eval") + 1] ?? "";
      if (source.includes("codegraph-native-")) {
        const targetPackage = packages.find((pkg) => pkg.name.includes("codegraph-native-win32"));
        return success({
          resolved: `/install/node_modules/${targetPackage?.name}/index.node`,
          directExports: ["parseSyntaxTree"],
          metaExports: ["parseSyntaxTree"],
        });
      }
      return success({ exports: ["buildProjectIndex"] });
    }
    if (args[1] === "version") {
      return success({ name: "@lzehrung/codegraph", version: "2.0.0", packageRoot: "/install/root" });
    }
    if (args[1] === "doctor") {
      const targetPackage = packages.find((pkg) => pkg.name.includes("codegraph-native-win32"));
      const target = targetPackage?.name.replace("@lzehrung/codegraph-native-", "");
      return success({
        package: { name: "@lzehrung/codegraph", version: "2.0.0", packageRoot: "/install/root" },
        native: {
          available: true,
          supportedLanguageIds: ["ts"],
          origin: { mode: "package", packageName: targetPackage?.name, target },
        },
      });
    }
    if (args[1] === "search") {
      return success({ schemaVersion: 1, results: [{ label: "CertifiedPackageSymbol", kind: "symbol" }] });
    }
    throw new Error(`Unexpected mocked command: ${[command, ...args].join(" ")}`);
  }

  return { calls, run };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("package smoke modes", () => {
  it("validates structural archives without installation or native loading", async () => {
    const target = "win32-arm64-msvc";
    const candidates = await createCandidateSet(target);
    const commandRunner = createMockCommandRunner(candidates.packages);

    const report = await runPackageSmoke({
      manifestPath: candidates.manifestPath,
      target,
      mode: "structural",
      expectedTargets: [target],
      structuralException: {
        target,
        certificationClass: "structural",
        owner: "@release-owner",
        expires: "2027-01-31",
        reason: "No matching runtime host is available.",
      },
      commandRunner: commandRunner.run,
    });

    expect(report.status).toBe("pass");
    expect(report.mode).toBe("structural");
    expect(
      commandRunner.calls.every((call) => call[0] === "tar" && TAR_OPERATIONS.includes(tarOperation(call) ?? "")),
    ).toBe(true);
    expect(commandRunner.calls.every((call) => path.isAbsolute(tarballArgument(call) ?? ""))).toBe(true);
    expect(
      commandRunner.calls.every((call) =>
        process.platform === "win32" ? call[1] === "--force-local" : call[1] !== "--force-local",
      ),
    ).toBe(true);
  });

  it("accepts package directory entries while inspecting archives", async () => {
    const target = "win32-arm64-msvc";
    const candidates = await createCandidateSet(target);
    const commandRunner = createMockCommandRunner(candidates.packages, {
      archiveEntries: ["package/", "package/dist/", "package/package.json"],
    });

    const report = await runPackageSmoke({
      manifestPath: candidates.manifestPath,
      target,
      mode: "structural",
      expectedTargets: [target],
      structuralException: {
        target,
        certificationClass: "structural",
        owner: "@release-owner",
        expires: "2027-01-31",
        reason: "No matching runtime host is available.",
      },
      commandRunner: commandRunner.run,
    });

    expect(report.status).toBe("pass");
    expect(commandRunner.calls.filter((call) => tarOperation(call) === "-tzf")).toHaveLength(4);
    expect(commandRunner.calls.filter((call) => tarOperation(call) === "-tvzf")).toHaveLength(4);
  });

  it("runs install, identity, native parse, and MCP checks for runtime targets", async () => {
    const target = "win32-x64-msvc";
    const candidates = await createCandidateSet(target);
    const commandRunner = createMockCommandRunner(candidates.packages);
    const mcpCalls: string[] = [];

    const report = await runPackageSmoke({
      manifestPath: candidates.manifestPath,
      target,
      mode: "runtime",
      runtimeTarget: target,
      expectedTargets: [target],
      commandRunner: commandRunner.run,
      mcpRunner: async () => {
        mcpCalls.push("initialize", "tools/list", "tools/call:search");
        return { exitCode: 0, durationMs: 1, stdout: "mcp pass", stderr: "" };
      },
    });

    expect(report.status).toBe("pass");
    if (!("selectedNativePath" in report)) throw new Error("expected a report naming the selected native path");
    expect(report.selectedNativePath).toContain("codegraph-native-win32-x64-msvc");
    expect(report.checks.map((check: { name: string }) => check.name)).toEqual(
      expect.arrayContaining(["install", "native-import", "version", "doctor", "native-parse", "mcp-stdio"]),
    );
    expect(mcpCalls).toEqual(["initialize", "tools/list", "tools/call:search"]);
    expect(commandRunner.calls.some((call) => call[1] === "install")).toBe(true);
    expect(commandRunner.calls.find((call) => call[1] === "install")).toContain("--prefer-offline");
    expect(commandRunner.calls.filter((call) => call[0] === "tar")).toHaveLength(12);
    expect(commandRunner.calls.some((call) => call.includes("--pack-destination"))).toBe(false);
  });

  it("fails with target-mismatch when archive identity names another target", async () => {
    const target = "win32-arm64-msvc";
    const candidates = await createCandidateSet(target);
    const commandRunner = createMockCommandRunner(candidates.packages, {
      wrongTargetPackage: "@lzehrung/codegraph-native-linux-x64-gnu",
    });

    await expect(
      runPackageSmoke({
        manifestPath: candidates.manifestPath,
        target,
        mode: "structural",
        expectedTargets: [target],
        structuralException: {
          target,
          certificationClass: "structural",
          owner: "@release-owner",
          expires: "2027-01-31",
          reason: "No matching runtime host is available.",
        },
        commandRunner: commandRunner.run,
      }),
    ).rejects.toMatchObject({ code: "target-mismatch" });
  });

  it("rejects unsafe archive paths before extraction", async () => {
    const target = "win32-arm64-msvc";
    for (const archiveEntries of [
      ["package/package.json", "../outside.txt"],
      ["package/package.json", "package/C:/outside.txt"],
    ]) {
      const candidates = await createCandidateSet(target);
      const commandRunner = createMockCommandRunner(candidates.packages, { archiveEntries });

      await expect(
        runPackageSmoke({
          manifestPath: candidates.manifestPath,
          target,
          mode: "structural",
          expectedTargets: [target],
          structuralException: {
            target,
            certificationClass: "structural",
            owner: "@release-owner",
            expires: "2027-01-31",
            reason: "No matching runtime host is available.",
          },
          commandRunner: commandRunner.run,
        }),
      ).rejects.toMatchObject({ code: "archive-invalid" });
      expect(tarOperation(commandRunner.calls[0] ?? [])).toBe("-tzf");
    }
  });

  it("reports unsupported archive entries as archive-invalid", async () => {
    const target = "win32-arm64-msvc";
    const candidates = await createCandidateSet(target);
    const commandRunner = createMockCommandRunner(candidates.packages, { unsupportedArchiveEntry: true });

    await expect(
      runPackageSmoke({
        manifestPath: candidates.manifestPath,
        target,
        mode: "structural",
        expectedTargets: [target],
        structuralException: {
          target,
          certificationClass: "structural",
          owner: "@release-owner",
          expires: "2027-01-31",
          reason: "No matching runtime host is available.",
        },
        commandRunner: commandRunner.run,
      }),
    ).rejects.toMatchObject({ code: "archive-invalid" });
    expect(commandRunner.calls.some((call) => tarOperation(call) === "-xzf")).toBe(false);
  });

  it("reports an unavailable tar executable separately from an invalid archive", async () => {
    const target = "win32-arm64-msvc";
    const candidates = await createCandidateSet(target);
    const commandRunner = createMockCommandRunner(candidates.packages, { tarUnavailable: true });

    await expect(
      runPackageSmoke({
        manifestPath: candidates.manifestPath,
        target,
        mode: "structural",
        expectedTargets: [target],
        structuralException: {
          target,
          certificationClass: "structural",
          owner: "@release-owner",
          expires: "2027-01-31",
          reason: "No matching runtime host is available.",
        },
        commandRunner: commandRunner.run,
      }),
    ).rejects.toMatchObject({ code: "subprocess-unavailable", context: { file: expect.any(String) } });
    expect(tarOperation(commandRunner.calls[0] ?? [])).toBe("-tzf");
  });
});
