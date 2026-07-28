#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FUNNEL_CHANNELS,
  FUNNEL_TARGETS,
  addFunnelCheck,
  addFunnelDiagnostic,
  addFunnelTiming,
  createFunnelResultV1,
  currentFunnelTarget,
  finalizeFunnelResultV1,
} from "./funnel-contract-lib.mjs";
import { verifyStandaloneBundle } from "./standalone-install-lib.mjs";
import { validateArchiveEntries } from "../standalone/standalone-lib.mjs";
import { runPackedMcpExchange } from "../certification/package-smoke-lib.mjs";

export const DEFAULT_FUNNEL_TIMEOUT_MS = 120_000;
export const FUNNEL_INSTALL_TARGET = "cursor";
export const FUNNEL_EXPLORE_QUERY = "src/auth.ts";

class FunnelStepError extends Error {
  constructor(message) {
    super(message);
    this.name = "FunnelStepError";
  }
}

export function parseFunnelSmokeArgs(argv) {
  const options = {
    channel: "source",
    root: process.cwd(),
    target: currentFunnelTarget(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    const inline = parseInlineOption(token);
    const name = inline?.name ?? token;
    if (!isValueOption(name)) throw new Error(`Unexpected argument: ${token}`);
    let value = inline?.value;
    if (value === undefined) {
      value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
      index += 1;
    }
    if (name === "--channel") options.channel = value;
    if (name === "--root") options.root = path.resolve(value);
    if (name === "--artifact") options.artifact = path.resolve(value);
    if (name === "--target") options.target = value;
    if (name === "--output") options.output = path.resolve(value);
  }
  if (!FUNNEL_CHANNELS.includes(options.channel)) {
    throw new Error(`Unsupported channel: ${options.channel}. Expected ${FUNNEL_CHANNELS.join(", ")}.`);
  }
  if (!FUNNEL_TARGETS.includes(options.target)) {
    throw new Error(`Unsupported target: ${options.target}. Expected ${FUNNEL_TARGETS.join(", ")}.`);
  }
  return options;
}

export function funnelSmokeUsage() {
  return [
    "Usage: node scripts/onboarding/run-funnel-smoke.mjs --channel <source|package|standalone> [options]",
    "",
    "Options:",
    "  --root <path>      Source checkout used by the source channel and isolation checks.",
    "  --artifact <path>  Exact package tarball or standalone archive for its channel.",
    "  --target <id>      win32-x64, win32-arm64, darwin-x64, darwin-arm64, linux-x64, or linux-arm64.",
    "  --output <path>    Write the FunnelResultV1 JSON document to this path.",
  ].join("\n");
}

export async function runFunnelSmoke(options = {}) {
  const channel = options.channel ?? "source";
  const target = options.target ?? currentFunnelTarget();
  const root = path.resolve(options.root ?? process.cwd());
  const result = createFunnelResultV1({ channel, target });
  const startedAt = performance.now();
  const ownsWorkspace = options.workspace === undefined;
  const workspace = path.resolve(options.workspace ?? (await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-funnel-"))));
  const context = {
    artifact: options.artifact ? path.resolve(options.artifact) : undefined,
    channel,
    mcpRunner: options.mcpRunner ?? runPackedMcpExchange,
    commandRunner: options.commandRunner ?? runFunnelCommand,
    result,
    root,
    target,
    timeoutMs: options.timeoutMs ?? DEFAULT_FUNNEL_TIMEOUT_MS,
    workspace,
  };

  try {
    const isolation = await runManualCheck(context, "environment-setup", "environment-setup-failed", async () => {
      return await createFunnelIsolation(workspace, options.baseEnv ?? process.env);
    });
    context.isolation = isolation;
    await runManualCheck(context, "environment-isolation", "environment-not-isolated", async () => {
      assertFunnelIsolation(isolation, workspace);
    });
    await runManualCheck(context, "target-host-compatibility", "target-host-incompatible", async () => {
      const hostTarget = currentFunnelTarget();
      if (target !== hostTarget) {
        throw new Error(`Target ${target} cannot run on host ${hostTarget}.`);
      }
    });
    const runtime = await prepareRuntime(context);
    await runProductChecks(context, runtime);
  } catch (error) {
    if (!(error instanceof FunnelStepError)) {
      addFunnelCheck(result, { name: "runner", status: "fail", durationMs: 0 });
      addFunnelTiming(result, "runner", 0);
      addFunnelDiagnostic(result, {
        code: "runner-unexpected-error",
        message: errorMessage(error),
        step: "runner",
      });
    }
  } finally {
    if (ownsWorkspace && !options.keepWorkspace) {
      const cleanupStartedAt = performance.now();
      try {
        await fsp.rm(workspace, { recursive: true, force: true });
        addFunnelCheck(result, {
          name: "workspace-cleanup",
          status: "pass",
          durationMs: elapsed(cleanupStartedAt),
        });
      } catch (error) {
        addFunnelCheck(result, {
          name: "workspace-cleanup",
          status: "fail",
          durationMs: elapsed(cleanupStartedAt),
        });
        addFunnelDiagnostic(result, {
          code: "workspace-cleanup-failed",
          message: errorMessage(error),
          step: "workspace-cleanup",
        });
      }
      addFunnelTiming(result, "workspace-cleanup", elapsed(cleanupStartedAt));
    }
  }

  return finalizeFunnelResultV1(result, elapsed(startedAt));
}

export function runFunnelCommand(command, args, options = {}) {
  const invocation = resolveCommandInvocation(command, args);
  const spawned = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: options.timeoutMs ?? DEFAULT_FUNNEL_TIMEOUT_MS,
  });
  return {
    exitCode: spawned.status,
    signal: spawned.signal,
    stdout: String(spawned.stdout ?? ""),
    stderr: String(spawned.stderr ?? ""),
    ...(spawned.error ? { error: spawned.error.message } : {}),
  };
}

export async function createFunnelIsolation(workspace, baseEnv = process.env) {
  const root = path.resolve(workspace);
  const paths = {
    appData: path.join(root, "app-data"),
    cache: path.join(root, "cache"),
    config: path.join(root, "config"),
    data: path.join(root, "data"),
    home: path.join(root, "home"),
    localAppData: path.join(root, "local-app-data"),
    nodeCompileCache: path.join(root, "node-compile-cache"),
    npmCache: path.join(root, "npm-cache"),
    npmPrefix: path.join(root, "npm-prefix"),
    runner: path.join(root, "runner"),
    temp: path.join(root, "temp"),
  };
  await Promise.all(Object.values(paths).map(async (directory) => await fsp.mkdir(directory, { recursive: true })));
  const npmUserConfig = path.join(paths.config, "npmrc");
  const npmGlobalConfig = path.join(paths.config, "npm-globalrc");
  const cursorConfigPath = path.join(paths.home, ".cursor", "mcp.json");
  const cursorConfig = '{"mcpServers":{}}\n';
  await fsp.writeFile(
    npmUserConfig,
    "audit=false\nfund=false\nupdate-notifier=false\n@lzehrung:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n",
    "utf8",
  );
  await fsp.mkdir(path.dirname(cursorConfigPath), { recursive: true });
  await fsp.writeFile(cursorConfigPath, cursorConfig, "utf8");
  const homeParts = path.parse(paths.home);
  const homePath = path.relative(homeParts.root, paths.home) || path.sep;
  const env = {
    ...baseEnv,
    APPDATA: paths.appData,
    CODEX_HOME: path.join(paths.home, ".codex"),
    HOME: paths.home,
    HOMEDRIVE: homeParts.root,
    HOMEPATH: homePath,
    LOCALAPPDATA: paths.localAppData,
    NODE_COMPILE_CACHE: paths.nodeCompileCache,
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NPM_CONFIG_CACHE: paths.npmCache,
    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
    NPM_CONFIG_PREFIX: paths.npmPrefix,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    TEMP: paths.temp,
    TMP: paths.temp,
    TMPDIR: paths.temp,
    USERPROFILE: paths.home,
    XDG_CACHE_HOME: paths.cache,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    npm_config_cache: paths.npmCache,
    npm_config_globalconfig: npmGlobalConfig,
    npm_config_prefix: paths.npmPrefix,
    npm_config_userconfig: npmUserConfig,
  };
  return { cursorConfig, cursorConfigPath, env, npmUserConfig, paths };
}

export async function createFunnelRepository(workspace) {
  const root = path.join(workspace, "tiny-repository");
  await fsp.mkdir(path.join(root, "src"), { recursive: true });
  await fsp.writeFile(
    path.join(root, "src", "auth.ts"),
    [
      'import { storeAuthenticatedSession } from "./storage.js";',
      "",
      "export function authenticateUser(token: string) {",
      "  return storeAuthenticatedSession(token);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fsp.writeFile(
    path.join(root, "src", "storage.ts"),
    [
      "export function storeAuthenticatedSession(token: string) {",
      '  return { storage: "session-store", token };',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fsp.writeFile(
    path.join(root, "src", "certified.ts"),
    'export function CertifiedPackageSymbol(): string { return "certified"; }\n',
    "utf8",
  );
  return root;
}

async function prepareRuntime(context) {
  if (context.channel === "source") return await prepareSourceRuntime(context);
  if (context.channel === "package") return await preparePackageRuntime(context);
  return await prepareStandaloneRuntime(context);
}

async function prepareSourceRuntime(context) {
  const cliPath = path.join(context.root, "dist", "cli.js");
  await runManualCheck(context, "source-cli-layout", "source-cli-not-found", async () => {
    await requireFile(cliPath, "Source CLI");
  });
  return { cliPath, nodePath: process.execPath, packageRoot: context.root };
}

async function preparePackageRuntime(context) {
  const artifact = await requireArtifact(context, "package");
  await runCommandCheck(context, "package-install", "npm", [
    "install",
    "--prefix",
    context.isolation.paths.npmPrefix,
    "--no-save",
    "--audit=false",
    "--fund=false",
    artifact,
  ]);
  const packageRoot = path.join(context.isolation.paths.npmPrefix, "node_modules", "@lzehrung", "codegraph");
  const cliPath = path.join(packageRoot, "dist", "bin", "cli.js");
  await runManualCheck(context, "package-isolation", "package-not-isolated", async () => {
    await requireFile(cliPath, "Installed package CLI");
    const realPackageRoot = await fsp.realpath(packageRoot);
    const realPrefix = await fsp.realpath(context.isolation.paths.npmPrefix);
    if (!isPathWithin(realPrefix, realPackageRoot)) {
      throw new Error("Installed package resolved outside the isolated npm prefix.");
    }
  });
  return { cliPath, nodePath: process.execPath, packageRoot };
}

async function prepareStandaloneRuntime(context) {
  const artifact = await requireArtifact(context, "standalone");
  const archiveCommand = resolveArchiveCommand(artifact);
  const listResult = await runCommandCheck(
    context,
    "standalone-archive-list",
    archiveCommand,
    archiveListArgs(artifact),
  );
  await runManualCheck(context, "standalone-archive-safety", "standalone-archive-unsafe", async () => {
    const entries = listResult.stdout
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!entries.length) throw new Error("Standalone archive is empty.");
    validateArchiveEntries(entries);
  });
  const extractRoot = path.join(context.workspace, "standalone");
  await fsp.mkdir(extractRoot, { recursive: true });
  await runCommandCheck(context, "standalone-extract", archiveCommand, archiveExtractArgs(artifact, extractRoot));
  const bundleRoot = await runManualCheck(
    context,
    "standalone-bundle-layout",
    "standalone-bundle-not-found",
    async () => {
      const root = await findStandaloneBundleRoot(extractRoot);
      const manifest = await verifyStandaloneBundle(root);
      if (manifest.target !== context.target) {
        throw new Error(`Standalone bundle target ${String(manifest.target)} does not match ${context.target}.`);
      }
      return root;
    },
  );
  const nodeName = context.target.startsWith("win32-") ? "node.exe" : "node";
  const nodePath = path.join(bundleRoot, nodeName);
  const cliPath = path.join(bundleRoot, "dist", "cli.js");
  await runManualCheck(context, "standalone-runtime-layout", "standalone-runtime-not-found", async () => {
    await requireFile(nodePath, "Standalone Node runtime");
    await requireFile(cliPath, "Standalone CLI");
  });
  return { cliPath, nodePath, packageRoot: bundleRoot };
}

async function runProductChecks(context, runtime) {
  const versionResult = await runCommandCheck(context, "version", runtime.nodePath, [
    runtime.cliPath,
    "version",
    "--json",
  ]);
  const identity = await parseJsonCheck(
    context,
    "version-json",
    "version-invalid-json",
    versionResult,
    "Version command",
  );
  await runManualCheck(context, "version-identity", "version-invalid-identity", async () => {
    if (
      !isRecord(identity) ||
      identity.name !== "@lzehrung/codegraph" ||
      typeof identity.version !== "string" ||
      !identity.version
    ) {
      throw new Error("Version command did not report the Codegraph package identity.");
    }
    if (typeof identity.packageRoot !== "string" || !identity.packageRoot) {
      throw new Error("Version command did not report its package root.");
    }
    const declaredPackageRoot = path.resolve(identity.packageRoot);
    if (!isPathWithin(runtime.packageRoot, declaredPackageRoot)) {
      throw new Error("Running CLI resolved its package root outside the selected channel.");
    }
    context.result.version = identity.version;
  });

  const doctorResult = await runCommandCheck(context, "doctor", runtime.nodePath, [
    runtime.cliPath,
    "doctor",
    "--json",
  ]);
  await parseJsonCheck(context, "doctor-json", "doctor-invalid-json", doctorResult, "Doctor command");

  const previewBefore = await fsp.readFile(context.isolation.cursorConfigPath, "utf8");
  const previewResult = await runCommandCheck(context, "install-preview", runtime.nodePath, [
    runtime.cliPath,
    "install",
    "--target",
    FUNNEL_INSTALL_TARGET,
    "--dry-run",
    "--json",
  ]);
  const preview = await parseJsonCheck(
    context,
    "install-preview-json",
    "install-preview-invalid-json",
    previewResult,
    "Install preview",
  );
  await runManualCheck(context, "install-preview-contract", "install-preview-invalid", async () => {
    const changesArePreviews =
      Array.isArray(preview?.changes) &&
      preview.changes.length &&
      preview.changes.every((change) => isRecord(change) && change.dryRun);
    if (!isRecord(preview) || !preview.dryRun || !changesArePreviews) {
      throw new Error("Install preview did not report dry-run-only changes.");
    }
    const previewAfter = await fsp.readFile(context.isolation.cursorConfigPath, "utf8");
    if (previewAfter !== previewBefore || previewAfter !== context.isolation.cursorConfig) {
      throw new Error("Install preview changed isolated client configuration.");
    }
  });

  const fixtureRoot = await runManualCheck(context, "first-query-fixture", "first-query-fixture-failed", async () => {
    return await createFunnelRepository(context.workspace);
  });
  const exploreArgs = [runtime.cliPath, "explore", FUNNEL_EXPLORE_QUERY, "--root", fixtureRoot, "--json"];
  const exploreResult = await runCommandCheck(context, "first-query", runtime.nodePath, exploreArgs);
  const explore = await parseJsonCheck(
    context,
    "first-query-json",
    "first-query-invalid-json",
    exploreResult,
    "First explore query",
  );
  await runManualCheck(context, "first-query-contract", "first-query-invalid-response", async () => {
    if (!isRecord(explore) || explore.schemaVersion !== 1 || explore.query !== FUNNEL_EXPLORE_QUERY) {
      throw new Error("First explore query did not return its schema version and query.");
    }
    if (!Array.isArray(explore.anchors) || !explore.anchors.length) {
      throw new Error("First explore query returned no source anchors.");
    }
  });
  const warmExploreResult = await runCommandCheck(context, "warm-query", runtime.nodePath, exploreArgs);
  const warmExplore = await parseJsonCheck(
    context,
    "warm-query-json",
    "warm-query-invalid-json",
    warmExploreResult,
    "Warm explore query",
  );
  await runManualCheck(context, "warm-query-contract", "warm-query-invalid-response", async () => {
    if (!isRecord(warmExplore) || !Array.isArray(warmExplore.anchors) || !warmExplore.anchors.length) {
      throw new Error("Warm explore query returned no source anchors.");
    }
  });
  await runManualCheck(context, "mcp-handshake", "mcp-handshake-failed", async () => {
    if (!context.result.version) throw new Error("MCP handshake requires a verified package version.");
    await context.mcpRunner({
      cliPath: runtime.cliPath,
      fixtureDirectory: fixtureRoot,
      rootVersion: context.result.version,
      nodePath: runtime.nodePath,
      env: context.isolation.env,
    });
  });
}

async function requireArtifact(context, channel) {
  return await runManualCheck(context, `${channel}-artifact`, `${channel}-artifact-invalid`, async () => {
    if (!context.artifact) throw new Error(`The ${channel} channel requires --artifact.`);
    const artifact = await fsp.stat(context.artifact);
    if (!artifact.isFile()) throw new Error(`Artifact is not a file: ${context.artifact}`);
    return context.artifact;
  });
}

async function runCommandCheck(context, name, command, args, options = {}) {
  const startedAt = performance.now();
  let output;
  try {
    output = normalizeCommandResult(
      await context.commandRunner(command, args, {
        cwd: context.isolation.paths.runner,
        env: context.isolation.env,
        timeoutMs: context.timeoutMs,
        ...options,
      }),
    );
  } catch (error) {
    const durationMs = elapsed(startedAt);
    recordFailure(context, name, `${name}-command-failed`, errorMessage(error), durationMs, {
      command: commandDisplay(command, args),
    });
    throw new FunnelStepError(`${name} command threw.`);
  }
  const durationMs = elapsed(startedAt);
  if (output.exitCode !== 0 || output.error) {
    recordFailure(context, name, `${name}-command-failed`, `${name} command exited unsuccessfully.`, durationMs, {
      command: commandDisplay(command, args),
      exitCode: output.exitCode,
      stderr: boundedDiagnosticOutput(output.stderr),
      stdout: boundedDiagnosticOutput(output.stdout),
    });
    throw new FunnelStepError(`${name} command failed.`);
  }
  addFunnelCheck(context.result, { name, status: "pass", durationMs, exitCode: output.exitCode });
  addFunnelTiming(context.result, name, durationMs);
  return output;
}

async function runManualCheck(context, name, code, operation) {
  const startedAt = performance.now();
  try {
    const value = await operation();
    const durationMs = elapsed(startedAt);
    addFunnelCheck(context.result, { name, status: "pass", durationMs });
    addFunnelTiming(context.result, name, durationMs);
    return value;
  } catch (error) {
    const durationMs = elapsed(startedAt);
    recordFailure(context, name, code, errorMessage(error), durationMs);
    throw new FunnelStepError(`${name} check failed.`);
  }
}

async function parseJsonCheck(context, name, code, commandResult, label) {
  return await runManualCheck(context, name, code, async () => {
    try {
      return JSON.parse(commandResult.stdout);
    } catch {
      throw new Error(`${label} returned malformed JSON.`);
    }
  });
}

function recordFailure(context, name, code, message, durationMs, details = {}) {
  const check = { name, status: "fail", durationMs };
  if (details.exitCode !== undefined) check.exitCode = details.exitCode;
  addFunnelCheck(context.result, check);
  addFunnelTiming(context.result, name, durationMs);
  addFunnelDiagnostic(context.result, { code, message, step: name, ...details });
}

function resolveArchiveCommand(artifact) {
  if (process.platform !== "win32" || isGzipArchive(artifact)) return "tar";
  const windowsDirectory = process.env.WINDIR ?? "C:\\Windows";
  return path.join(windowsDirectory, "System32", "tar.exe");
}

function archiveListArgs(artifact) {
  if (isGzipArchive(artifact)) return ["-tzf", artifact];
  return ["-tf", artifact];
}

function archiveExtractArgs(artifact, extractRoot) {
  if (isGzipArchive(artifact)) return ["-xzf", artifact, "-C", extractRoot];
  return ["-xf", artifact, "-C", extractRoot];
}

function isGzipArchive(artifact) {
  const lowerCase = artifact.toLowerCase();
  return lowerCase.endsWith(".tar.gz") || lowerCase.endsWith(".tgz");
}

async function findStandaloneBundleRoot(extractRoot) {
  const entries = await fsp.readdir(extractRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractRoot, entry.name);
    try {
      await requireFile(path.join(candidate, "manifest.json"), "Standalone manifest");
      candidates.push(candidate);
    } catch {
      continue;
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`Expected one standalone bundle after extraction, found ${candidates.length}.`);
  }
  return candidates[0];
}

async function requireFile(filePath, label) {
  const file = await fsp.stat(filePath);
  if (!file.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
}

function assertFunnelIsolation(isolation, workspace) {
  const root = path.resolve(workspace);
  const requiredPaths = [
    isolation.env.HOME,
    isolation.env.USERPROFILE,
    isolation.env.XDG_CONFIG_HOME,
    isolation.env.XDG_CACHE_HOME,
    isolation.env.XDG_DATA_HOME,
    isolation.env.APPDATA,
    isolation.env.LOCALAPPDATA,
    isolation.env.NPM_CONFIG_CACHE,
    isolation.env.npm_config_cache,
    isolation.env.NODE_COMPILE_CACHE,
    isolation.env.TEMP,
    isolation.env.TMP,
    isolation.env.TMPDIR,
  ];
  for (const candidate of requiredPaths) {
    if (typeof candidate !== "string" || !isPathWithin(root, candidate)) {
      throw new Error("Funnel environment contains a home, config, or cache path outside its workspace.");
    }
  }
}

function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeCommandResult(value) {
  if (!isRecord(value)) {
    return { error: "Command runner returned no result.", exitCode: null, stderr: "", stdout: "" };
  }
  const exitCode = value.exitCode ?? value.status ?? null;
  const validExitCode = exitCode === null || Number.isInteger(exitCode);
  return {
    error: typeof value.error === "string" ? value.error : undefined,
    exitCode: validExitCode ? exitCode : null,
    stderr: String(value.stderr ?? ""),
    stdout: String(value.stdout ?? ""),
  };
}

function resolveCommandInvocation(command, args) {
  if (process.platform !== "win32" || command !== "npm") return { command, args };
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && path.basename(candidate) === "npm-cli.js");
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
  if (!npmCli) return { command, args };
  return { command: process.execPath, args: [npmCli, ...args] };
}

function commandDisplay(command, args) {
  return [command, ...args].join(" ");
}

function boundedDiagnosticOutput(value) {
  const redacted = redactDiagnosticOutput(value);
  if (redacted.length <= 4096) return redacted;
  return `${redacted.slice(0, 4096)}\n[output truncated]`;
}

function redactDiagnosticOutput(value) {
  return String(value)
    .replace(/(npm_[A-Za-z0-9]{20,})/g, "[REDACTED]")
    .replace(/(gh[pousr]_[A-Za-z0-9_]{20,})/g, "[REDACTED]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(_authToken\s*=\s*)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/g, "$1[REDACTED]@");
}

function elapsed(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isValueOption(token) {
  return (
    token === "--channel" ||
    token === "--root" ||
    token === "--artifact" ||
    token === "--target" ||
    token === "--output"
  );
}

function parseInlineOption(token) {
  const equals = token.indexOf("=");
  if (equals === -1) return undefined;
  const name = token.slice(0, equals);
  if (!isValueOption(name)) return undefined;
  return { name, value: token.slice(equals + 1) };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseFunnelSmokeArgs(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n${funnelSmokeUsage()}\n`);
    process.exitCode = 2;
    return undefined;
  }
  if (options.help) {
    process.stdout.write(`${funnelSmokeUsage()}\n`);
    return undefined;
  }
  const result = await runFunnelSmoke(options);
  if (options.output) {
    const outputStartedAt = performance.now();
    try {
      await fsp.mkdir(path.dirname(options.output), { recursive: true });
      await fsp.writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    } catch (error) {
      const durationMs = elapsed(outputStartedAt);
      addFunnelCheck(result, { name: "write-output", status: "fail", durationMs });
      addFunnelTiming(result, "write-output", durationMs);
      addFunnelDiagnostic(result, {
        code: "write-output-failed",
        message: errorMessage(error),
        step: "write-output",
      });
      finalizeFunnelResultV1(result, result.timings.totalMs + durationMs);
      process.stderr.write(`Could not write funnel output: ${errorMessage(error)}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "fail") process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
