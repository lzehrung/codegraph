#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
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
import { installStandaloneBundle, verifyStandaloneBundle } from "./standalone-install-lib.mjs";
import { validateArchiveEntries } from "../standalone/standalone-lib.mjs";
import {
  readReleaseCandidateManifest,
  selectReleaseCandidatePackages,
} from "../certification/package-contract-lib.mjs";
import { currentNativeTargetSuffix } from "../certification/package-smoke-lib.mjs";

export const DEFAULT_FUNNEL_TIMEOUT_MS = 120_000;
export const FUNNEL_DOCTOR_INSTALL_BUDGET_MS = 120_000;
export const FUNNEL_FIRST_QUERY_BUDGET_MS = 300_000;
export const FUNNEL_PACKAGE_SETUP_TIMEOUT_MS = 300_000;
export const FUNNEL_INSTALL_TARGET = "cursor";
export const FUNNEL_EXPLORE_QUERY = "where does authentication reach storage?";
export const MAX_FUNNEL_FOLLOW_UPS = 12;

const NATIVE_META_PACKAGE_NAME = "@lzehrung/codegraph-native";
const FUNNEL_COMMAND_BUDGETS_MS = Object.freeze({
  doctor: FUNNEL_DOCTOR_INSTALL_BUDGET_MS,
  "first-query": FUNNEL_FIRST_QUERY_BUDGET_MS,
  "install-apply": FUNNEL_DOCTOR_INSTALL_BUDGET_MS,
  "install-preview": FUNNEL_DOCTOR_INSTALL_BUDGET_MS,
});

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
    "  --artifact <path>  Release-candidate manifest for package, root .tgz only as non-release fallback, or standalone archive.",
    "  --target <id>      win32-x64, win32-arm64, darwin-x64, darwin-arm64, linux-x64, or linux-arm64.",
    "  --output <path>    Write the FunnelResultV1 JSON document to this path.",
  ].join("\n");
}

export async function runFunnelSmoke(options = {}) {
  const channel = options.channel ?? "source";
  const target = options.target ?? currentFunnelTarget();
  const root = path.resolve(options.root ?? process.cwd());
  const now = options.now ?? (() => performance.now());
  const result = createFunnelResultV1({ channel, target });
  const startedAt = now();
  const ownsWorkspace = options.workspace === undefined;
  const workspace = path.resolve(options.workspace ?? (await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-funnel-"))));
  const context = {
    artifact: options.artifact ? path.resolve(options.artifact) : undefined,
    channel,
    mcpRunner: options.mcpRunner ?? runConfiguredMcpExchange,
    commandRunner: options.commandRunner ?? runFunnelCommand,
    firstQueryTimeoutMs: options.timeoutMs ?? FUNNEL_FIRST_QUERY_BUDGET_MS,
    now,
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
      const cleanupStartedAt = now();
      try {
        await fsp.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        addFunnelCheck(result, {
          name: "workspace-cleanup",
          status: "pass",
          durationMs: elapsed(cleanupStartedAt, now),
        });
      } catch (error) {
        addFunnelCheck(result, {
          name: "workspace-cleanup",
          status: "fail",
          durationMs: elapsed(cleanupStartedAt, now),
        });
        addFunnelDiagnostic(result, {
          code: "workspace-cleanup-failed",
          message: errorMessage(error),
          step: "workspace-cleanup",
        });
      }
      addFunnelTiming(result, "workspace-cleanup", elapsed(cleanupStartedAt, now));
    }
  }

  return finalizeFunnelResultV1(result, elapsed(startedAt, now));
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
  const cursorConfig = `${JSON.stringify(
    {
      cursorSettings: { theme: "retain" },
      mcpServers: {
        unrelated: { args: ["--stdio"], command: "unrelated-mcp" },
      },
    },
    null,
    2,
  )}\n`;
  await fsp.writeFile(npmUserConfig, "audit=false\nfund=false\nupdate-notifier=false\n", "utf8");
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
      "// Authentication reaches storage through the authenticated session write.",
      "export function authenticationReachesStorage(token: string) {",
      "  return storeAuthenticatedSession(token);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fsp.writeFile(
    path.join(root, "src", "storage.ts"),
    [
      "// Storage receives the authenticated session from the authentication flow.",
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
  let runtime;
  if (context.channel === "source") {
    runtime = await prepareSourceRuntime(context);
  } else if (context.channel === "package") {
    runtime = await preparePackageRuntime(context);
  } else {
    runtime = await prepareStandaloneRuntime(context);
  }
  await runManualCheck(context, "configured-command", "configured-command-unavailable", async () => {
    await configureRuntimeCommand(context.isolation, runtime);
  });
  return runtime;
}

async function prepareSourceRuntime(context) {
  const cliPath = path.join(context.root, "dist", "cli.js");
  const nativeTarget = nativeTargetForFunnelTarget(context.target);
  await runManualCheck(context, "source-cli-layout", "source-cli-not-found", async () => {
    await requireFile(cliPath, "Source CLI");
  });
  return {
    cliPath,
    expectedNative: {
      mode: "workspace",
      packageName: NATIVE_META_PACKAGE_NAME,
      target: nativeTarget,
    },
    nodePath: process.execPath,
    packageRoot: context.root,
  };
}

async function preparePackageRuntime(context) {
  const artifact = await requireArtifact(context, "package");
  const packageArtifacts = await resolvePackageArtifacts(context, artifact);
  await runCommandCheck(
    context,
    "package-install",
    "npm",
    [
      "install",
      "--prefix",
      context.isolation.paths.npmPrefix,
      "--no-save",
      "--audit=false",
      "--fund=false",
      "--loglevel=verbose",
      ...packageArtifacts.paths,
    ],
    { timeoutMs: FUNNEL_PACKAGE_SETUP_TIMEOUT_MS },
  );
  const packageRoot = path.join(context.isolation.paths.npmPrefix, "node_modules", "@lzehrung", "codegraph");
  const cliPath = path.join(packageRoot, "dist", "bin", "cli.js");
  const launcherDirectory = path.join(context.isolation.paths.npmPrefix, "node_modules", ".bin");
  const launcherPath = path.join(launcherDirectory, launcherFileName(context.target));
  await runManualCheck(context, "package-isolation", "package-not-isolated", async () => {
    await requireFile(cliPath, "Installed package CLI");
    await requireFile(launcherPath, "Installed package launcher");
    const realPackageRoot = await fsp.realpath(packageRoot);
    const realPrefix = await fsp.realpath(context.isolation.paths.npmPrefix);
    if (!isPathWithin(realPrefix, realPackageRoot)) {
      throw new Error("Installed package resolved outside the isolated npm prefix.");
    }
  });
  return {
    cliPath,
    expectedNative: packageArtifacts.nativeIdentity,
    launcher: { directory: launcherDirectory, path: launcherPath },
    nodePath: process.execPath,
    packageRoot,
  };
}

async function resolvePackageArtifacts(context, artifact) {
  return await runManualCheck(context, "package-candidate", "package-candidate-invalid", async () => {
    const isNonReleaseRootTarball = artifact.toLowerCase().endsWith(".tgz");
    if (isNonReleaseRootTarball) return { paths: [artifact] };
    const manifest = await readReleaseCandidateManifest(artifact, { verifyFiles: true });
    const nativeTarget = nativeTargetForFunnelTarget(context.target);
    const selection = selectReleaseCandidatePackages(manifest, nativeTarget);
    const manifestDirectory = path.dirname(artifact);
    return {
      nativeIdentity: {
        packageName: selection.nativeTarget.package,
        packageVersion: manifest.nativeVersion,
        target: selection.nativeTarget.target,
      },
      paths: [selection.core, selection.root, selection.native, selection.nativeTarget].map((entry) => {
        return path.resolve(manifestDirectory, entry.file);
      }),
    };
  });
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
  const bundle = await runManualCheck(context, "standalone-bundle-layout", "standalone-bundle-not-found", async () => {
    const root = await findStandaloneBundleRoot(extractRoot);
    const manifest = await verifyStandaloneBundle(root);
    if (manifest.target !== context.target) {
      throw new Error(`Standalone bundle target ${String(manifest.target)} does not match ${context.target}.`);
    }
    const nativeTarget = nativeTargetForFunnelTarget(context.target);
    if (manifest.nativeSuffix !== nativeTarget) {
      throw new Error(`Standalone native suffix ${String(manifest.nativeSuffix)} does not match ${nativeTarget}.`);
    }
    return { manifest, root };
  });
  const binDir = path.join(context.workspace, "standalone-bin");
  const installManifest = await runManualCheck(context, "standalone-install", "standalone-install-failed", async () => {
    return await installStandaloneBundle({
      binDir,
      bundleRoot: bundle.root,
      installBase: path.join(context.workspace, "standalone-install"),
    });
  });
  const installedRoot = installManifest.versionRoot;
  const nodeName = context.target.startsWith("win32-") ? "node.exe" : "node";
  const nodePath = path.join(installedRoot, nodeName);
  const cliPath = path.join(installedRoot, "dist", "cli.js");
  const expectedNative = await runManualCheck(
    context,
    "standalone-native-identity",
    "standalone-native-identity-invalid",
    async () => await readStandaloneNativeIdentity(installedRoot, bundle.manifest.nativeSuffix),
  );
  const launcher = await runManualCheck(
    context,
    "standalone-launcher",
    "standalone-launcher-invalid",
    async () => await resolveStandaloneLauncher(installManifest, binDir, context.target),
  );
  await runManualCheck(context, "standalone-runtime-layout", "standalone-runtime-not-found", async () => {
    await requireFile(nodePath, "Standalone Node runtime");
    await requireFile(cliPath, "Standalone CLI");
  });
  return { cliPath, expectedNative, launcher, nodePath, packageRoot: installedRoot };
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
    const declaredPackageRoot = await fsp.realpath(identity.packageRoot);
    const selectedPackageRoot = await fsp.realpath(runtime.packageRoot);
    if (!isPathWithin(selectedPackageRoot, declaredPackageRoot)) {
      throw new Error("Running CLI resolved its package root outside the selected channel.");
    }
    context.result.version = identity.version;
  });

  const doctorResult = await runCommandCheck(context, "doctor", runtime.nodePath, [
    runtime.cliPath,
    "doctor",
    "--json",
  ]);
  const doctor = await parseJsonCheck(context, "doctor-json", "doctor-invalid-json", doctorResult, "Doctor command");
  await runManualCheck(context, "doctor-native", "doctor-native-origin-invalid", async () => {
    if (!isRecord(doctor) || !isRecord(doctor.native) || !doctor.native.available) {
      throw new Error("Doctor did not confirm the target-matching native runtime.");
    }
    assertExpectedNativeOrigin(doctor.native.origin, runtime.expectedNative);
  });

  const previewBefore = await fsp.readFile(context.isolation.cursorConfigPath, "utf8");
  const originalCursorConfig = parseCursorConfig(previewBefore, context.isolation.cursorConfigPath);
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
    assertCursorInstallerResult(preview, "installed", true, context.isolation);
    const previewAfter = await fsp.readFile(context.isolation.cursorConfigPath, "utf8");
    if (previewAfter !== previewBefore || previewAfter !== context.isolation.cursorConfig) {
      throw new Error("Install preview changed isolated client configuration.");
    }
  });

  const installResult = await runCommandCheck(context, "install-apply", runtime.nodePath, [
    runtime.cliPath,
    "install",
    "--target",
    FUNNEL_INSTALL_TARGET,
    "--yes",
    "--json",
  ]);
  const install = await parseJsonCheck(
    context,
    "install-apply-json",
    "install-apply-invalid-json",
    installResult,
    "Install apply",
  );
  await runManualCheck(context, "install-apply-contract", "install-apply-invalid", async () => {
    assertCursorInstallerResult(install, "installed", false, context.isolation);
  });
  const configuredMcp = await runManualCheck(
    context,
    "cursor-config-apply",
    "cursor-config-apply-invalid",
    async () => {
      const appliedCursorConfig = await readCursorConfig(context.isolation.cursorConfigPath);
      assertCursorConfigPreservesUnrelated(originalCursorConfig, appliedCursorConfig);
      return parseConfiguredCursorMcpEntry(appliedCursorConfig);
    },
  );

  const fixtureRoot = await runManualCheck(context, "first-query-fixture", "first-query-fixture-failed", async () => {
    return await createFunnelRepository(context.workspace);
  });
  const exploreArgs = [runtime.cliPath, "explore", FUNNEL_EXPLORE_QUERY, "--root", fixtureRoot, "--json"];
  const exploreResult = await runCommandCheck(context, "first-query", runtime.nodePath, exploreArgs, {
    timeoutMs: context.firstQueryTimeoutMs,
  });
  const explore = await parseJsonCheck(
    context,
    "first-query-json",
    "first-query-invalid-json",
    exploreResult,
    "First explore query",
  );
  await runManualCheck(context, "first-query-contract", "first-query-invalid-response", async () => {
    assertFirstFunnelQueryResponse(explore);
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
    if (
      !isRecord(warmExplore) ||
      warmExplore.schemaVersion !== 1 ||
      warmExplore.query !== FUNNEL_EXPLORE_QUERY ||
      !Array.isArray(warmExplore.anchors) ||
      !warmExplore.anchors.length
    ) {
      throw new Error("Warm explore query did not return a matching source anchor.");
    }
  });
  await runManualCheck(context, "mcp-handshake", "mcp-handshake-failed", async () => {
    if (!context.result.version) throw new Error("MCP handshake requires a verified package version.");
    await context.mcpRunner({
      args: configuredMcp.args,
      command: configuredMcp.command,
      env: context.isolation.env,
      fixtureDirectory: fixtureRoot,
      rootVersion: context.result.version,
      timeoutMs: context.timeoutMs,
    });
  });

  const uninstallResult = await runCommandCheck(context, "uninstall", runtime.nodePath, [
    runtime.cliPath,
    "uninstall",
    "--target",
    FUNNEL_INSTALL_TARGET,
    "--yes",
    "--json",
  ]);
  const uninstall = await parseJsonCheck(
    context,
    "uninstall-json",
    "uninstall-invalid-json",
    uninstallResult,
    "Uninstall",
  );
  await runManualCheck(context, "uninstall-contract", "uninstall-invalid", async () => {
    assertCursorInstallerResult(uninstall, "uninstalled", false, context.isolation);
  });
  await runManualCheck(context, "cursor-config-uninstall", "cursor-config-uninstall-invalid", async () => {
    const uninstalledCursorConfig = await readCursorConfig(context.isolation.cursorConfigPath);
    assertCursorConfigRestored(originalCursorConfig, uninstalledCursorConfig);
  });
}
function assertExpectedNativeOrigin(origin, expectedNative) {
  if (!expectedNative) return;
  if (!isRecord(origin)) throw new Error("Doctor did not report native runtime origin.");
  if (expectedNative.mode && origin.mode !== expectedNative.mode) {
    throw new Error(`Doctor native origin mode ${String(origin.mode)} does not match expected ${expectedNative.mode}.`);
  }
  if (origin.target !== expectedNative.target) {
    throw new Error(
      `Doctor native origin target ${String(origin.target)} does not match expected ${expectedNative.target}.`,
    );
  }
  if (origin.packageName !== expectedNative.packageName) {
    const actualPackageName = String(origin.packageName);
    throw new Error(
      `Doctor native origin package ${actualPackageName} does not match expected ${expectedNative.packageName}.`,
    );
  }
  if (expectedNative.packageVersion && origin.packageVersion !== expectedNative.packageVersion) {
    const actualPackageVersion = String(origin.packageVersion);
    throw new Error(
      `Doctor native origin version ${actualPackageVersion} does not match expected ${expectedNative.packageVersion}.`,
    );
  }
}

function assertFirstFunnelQueryResponse(explore) {
  if (!isRecord(explore) || explore.schemaVersion !== 1 || explore.query !== FUNNEL_EXPLORE_QUERY) {
    throw new Error("First explore query did not return its schema version and query.");
  }
  if (!Array.isArray(explore.anchors) || !explore.anchors.length) {
    throw new Error("First explore query returned no source anchors.");
  }
  const evidenceFiles = new Set();
  for (const anchor of explore.anchors) {
    if (isRecord(anchor) && typeof anchor.file === "string") {
      evidenceFiles.add(normalizeFunnelEvidencePath(anchor.file));
    }
  }
  if (Array.isArray(explore.paths)) {
    for (const dependencyPath of explore.paths) {
      if (!isRecord(dependencyPath)) continue;
      for (const field of ["from", "to"]) {
        if (typeof dependencyPath[field] === "string") {
          evidenceFiles.add(normalizeFunnelEvidencePath(dependencyPath[field]));
        }
      }
      if (Array.isArray(dependencyPath.path)) {
        for (const entry of dependencyPath.path) {
          if (typeof entry === "string") evidenceFiles.add(normalizeFunnelEvidencePath(entry));
        }
      }
    }
  }
  const expectedFiles = ["src/auth.ts", "src/storage.ts"];
  if (!expectedFiles.every((file) => evidenceFiles.has(file))) {
    throw new Error("First explore query did not return evidence spanning src/auth.ts and src/storage.ts.");
  }
  const spansAuthenticationToStorage = Array.isArray(explore.paths)
    ? explore.paths.some((dependencyPath) => {
        if (!isRecord(dependencyPath) || !Array.isArray(dependencyPath.path)) return false;
        const files = dependencyPath.path
          .filter((entry) => typeof entry === "string")
          .map((entry) => normalizeFunnelEvidencePath(entry));
        return expectedFiles.every((file) => files.includes(file));
      })
    : false;
  if (!spansAuthenticationToStorage) {
    throw new Error("First explore query did not return an authentication-to-storage dependency path.");
  }
  if (
    !Array.isArray(explore.followUps) ||
    !explore.followUps.length ||
    explore.followUps.length > MAX_FUNNEL_FOLLOW_UPS ||
    !explore.followUps.every(
      (followUp) =>
        isRecord(followUp) &&
        typeof followUp.tool === "string" &&
        followUp.tool.length > 0 &&
        isRecord(followUp.arguments),
    )
  ) {
    throw new Error("First explore query did not return a bounded, structured Codegraph follow-up.");
  }
}

function normalizeFunnelEvidencePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
}

function assertCursorInstallerResult(result, resultKey, dryRun, isolation) {
  if (!isRecord(result) || result[resultKey] !== true || result.dryRun !== dryRun) {
    throw new Error(`Cursor ${resultKey} result did not report the expected write state.`);
  }
  if (!Array.isArray(result.targets) || result.targets.length !== 1 || result.targets[0] !== FUNNEL_INSTALL_TARGET) {
    throw new Error("Cursor installer result targeted more than the isolated Cursor client.");
  }
  if (!Array.isArray(result.changes) || !result.changes.length) {
    throw new Error("Cursor installer result did not report owned changes.");
  }
  const allowedPaths = new Set(cursorOwnedPaths(isolation).map(pathKey));
  let configChanged = false;
  for (const change of result.changes) {
    if (!isRecord(change) || change.target !== FUNNEL_INSTALL_TARGET || change.dryRun !== dryRun) {
      throw new Error("Cursor installer result reported a non-Cursor change.");
    }
    if (typeof change.path !== "string" || !allowedPaths.has(pathKey(change.path))) {
      throw new Error("Cursor installer result changed a path outside isolated Cursor-owned state.");
    }
    if (pathKey(change.path) === pathKey(isolation.cursorConfigPath) && change.action !== "unchanged") {
      configChanged = true;
    }
  }
  if (!configChanged) {
    throw new Error("Cursor installer result did not change the isolated Cursor configuration.");
  }
}

function cursorOwnedPaths(isolation) {
  const skillRoot = path.join(isolation.paths.home, ".cursor", "skills", "codegraph");
  return [isolation.cursorConfigPath, path.join(skillRoot, "CODEGRAPH_INSTALLED"), path.join(skillRoot, "SKILL.md")];
}

function parseCursorConfig(content, configPath) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Cursor configuration is not valid JSON: ${configPath}`);
  }
  if (!isRecord(parsed)) throw new Error(`Cursor configuration is not a JSON object: ${configPath}`);
  return parsed;
}

async function readCursorConfig(configPath) {
  return parseCursorConfig(await fsp.readFile(configPath, "utf8"), configPath);
}

function parseConfiguredCursorMcpEntry(config) {
  const servers = config.mcpServers;
  if (!isRecord(servers)) throw new Error("Cursor configuration omitted the mcpServers object.");
  const codegraph = servers.codegraph;
  if (!isRecord(codegraph)) throw new Error("Cursor configuration omitted mcpServers.codegraph.");
  if (typeof codegraph.command !== "string" || !codegraph.command.trim()) {
    throw new Error("Cursor mcpServers.codegraph omitted its command.");
  }
  if (codegraph.command !== "codegraph") {
    throw new Error("Cursor mcpServers.codegraph command did not use the installed launcher.");
  }
  const expectedArgs = ["mcp", "serve", "--root", ".", "--stdio"];
  if (
    !Array.isArray(codegraph.args) ||
    codegraph.args.length !== expectedArgs.length ||
    !codegraph.args.every((argument, index) => argument === expectedArgs[index])
  ) {
    throw new Error("Cursor mcpServers.codegraph args did not select configured MCP stdio mode.");
  }
  return { args: [...codegraph.args], command: codegraph.command };
}

function assertCursorConfigPreservesUnrelated(original, applied) {
  if (!jsonValuesEqual(cursorConfigWithoutCodegraph(original), cursorConfigWithoutCodegraph(applied))) {
    throw new Error("Cursor install changed unrelated isolated configuration.");
  }
}

function assertCursorConfigRestored(original, current) {
  const currentServers = current.mcpServers;
  if (isRecord(currentServers) && Object.hasOwn(currentServers, "codegraph")) {
    throw new Error("Cursor uninstall retained mcpServers.codegraph.");
  }
  if (!jsonValuesEqual(original, current)) {
    throw new Error("Cursor uninstall did not preserve unrelated isolated configuration.");
  }
}

function cursorConfigWithoutCodegraph(config) {
  const withoutCodegraph = { ...config };
  if (!isRecord(config.mcpServers)) return withoutCodegraph;
  const servers = { ...config.mcpServers };
  delete servers.codegraph;
  if (Object.keys(servers).length) {
    withoutCodegraph.mcpServers = servers;
  } else {
    delete withoutCodegraph.mcpServers;
  }
  return withoutCodegraph;
}

function jsonValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]));
  }
  return false;
}

async function configureRuntimeCommand(isolation, runtime) {
  if (!runtime.launcher) {
    await createConfiguredCommandLauncher(isolation, runtime);
    return;
  }
  await requireFile(runtime.launcher.path, "Configured channel launcher");
  prependEnvironmentPath(isolation.env, runtime.launcher.directory);
}

function launcherFileName(target) {
  return target.startsWith("win32-") ? "codegraph.cmd" : "codegraph";
}

async function readStandaloneNativeIdentity(installedRoot, nativeSuffix) {
  const packageName = `${NATIVE_META_PACKAGE_NAME}-${nativeSuffix}`;
  const packageJsonPath = path.join(
    installedRoot,
    "node_modules",
    "@lzehrung",
    `codegraph-native-${nativeSuffix}`,
    "package.json",
  );
  let metadata;
  try {
    metadata = JSON.parse(await fsp.readFile(packageJsonPath, "utf8"));
  } catch {
    throw new Error(`Installed standalone target package metadata is unreadable: ${packageJsonPath}`);
  }
  if (
    !isRecord(metadata) ||
    metadata.name !== packageName ||
    typeof metadata.version !== "string" ||
    !metadata.version
  ) {
    throw new Error(`Installed standalone target package metadata is invalid: ${packageJsonPath}`);
  }
  return { packageName, packageVersion: metadata.version, target: nativeSuffix };
}

async function resolveStandaloneLauncher(installManifest, binDir, target) {
  const launcherPath = path.join(binDir, launcherFileName(target));
  if (
    !isRecord(installManifest) ||
    !Array.isArray(installManifest.launchers) ||
    !installManifest.launchers.some(
      (launcher) => typeof launcher === "string" && pathKey(launcher) === pathKey(launcherPath),
    )
  ) {
    throw new Error(`Standalone installer did not publish its expected launcher: ${launcherPath}`);
  }
  await requireFile(launcherPath, "Standalone installed launcher");
  return { directory: binDir, path: launcherPath };
}

async function createConfiguredCommandLauncher(isolation, runtime) {
  const commandPath = path.join(isolation.paths.runner, "codegraph");
  if (process.platform === "win32") {
    await fsp.writeFile(`${commandPath}.cmd`, createWindowsCommandLauncher(runtime), "utf8");
  } else {
    await fsp.writeFile(commandPath, createPosixCommandLauncher(runtime), "utf8");
    await fsp.chmod(commandPath, 0o755);
  }
  prependEnvironmentPath(isolation.env, isolation.paths.runner);
}

function createPosixCommandLauncher(runtime) {
  const nodePath = quotePosixShellArgument(runtime.nodePath);
  const cliPath = quotePosixShellArgument(runtime.cliPath);
  return ["#!/bin/sh", `exec ${nodePath} ${cliPath} "$@"`, ""].join("\n");
}

function quotePosixShellArgument(value) {
  const escaped = String(value).replaceAll("'", "'\"'\"'");
  return `'${escaped}'`;
}

function createWindowsCommandLauncher(runtime) {
  return `@echo off\r\n${quoteWindowsCommandArgument(runtime.nodePath)} ${quoteWindowsCommandArgument(runtime.cliPath)} %*\r\n`;
}

function prependEnvironmentPath(env, entry) {
  let previous = "";
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== "PATH") continue;
    if (!previous && typeof env[key] === "string") previous = env[key];
    if (key !== "PATH") delete env[key];
  }
  env.PATH = previous ? `${entry}${path.delimiter}${previous}` : entry;
}

function nativeTargetForFunnelTarget(target) {
  const nativeTarget = currentNativeTargetSuffix();
  if (!nativeTarget) throw new Error(`No native package target is available for funnel target ${target}.`);
  const targetParts = nativeTarget.split("-");
  const platformTarget = `${targetParts[0]}-${targetParts[1]}`;
  if (platformTarget !== target) {
    throw new Error(`Native package target ${nativeTarget} does not match funnel target ${target}.`);
  }
  return nativeTarget;
}

async function runConfiguredMcpExchange({
  args,
  command,
  fixtureDirectory,
  rootVersion,
  env = process.env,
  timeoutMs = DEFAULT_FUNNEL_TIMEOUT_MS,
}) {
  const child = spawnConfiguredMcpProcess(command, args, { cwd: fixtureDirectory, env });
  const client = createMcpLineClient(child, timeoutMs);
  try {
    const initialize = await client.request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "codegraph-funnel-smoke", version: "1.0.0" },
    });
    if (initialize.error) throw new Error("Configured MCP initialize returned an error.");
    const initializeResult = requireMcpRecord(initialize.result, "Configured MCP initialize omitted a result.");
    const serverInfo = requireMcpRecord(initializeResult.serverInfo, "Configured MCP initialize omitted serverInfo.");
    if (serverInfo.version !== rootVersion) {
      throw new Error(`Configured MCP server version ${String(serverInfo.version)} does not match ${rootVersion}.`);
    }
    client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const tools = await client.request(2, "tools/list", {});
    const toolsResult = requireMcpRecord(tools.result, "Configured MCP tools/list omitted a result.");
    if (!Array.isArray(toolsResult.tools)) throw new Error("Configured MCP tools/list omitted tools.");
    const toolNames = toolsResult.tools
      .map((tool) => (isRecord(tool) && typeof tool.name === "string" ? tool.name : ""))
      .filter(Boolean);
    if (!toolNames.includes("search")) throw new Error("Configured MCP server did not expose search.");
    const search = await client.request(3, "tools/call", {
      name: "search",
      arguments: { query: "CertifiedPackageSymbol", mode: "symbol", limit: 5 },
    });
    if (search.error) throw new Error("Configured MCP search returned an error.");
    assertMcpSearchToolResult(search.result);
    return { exitCode: 0, tools: toolNames };
  } finally {
    await stopConfiguredMcpProcess(child);
  }
}

function spawnConfiguredMcpProcess(command, args, options) {
  const spawnOptions = { cwd: options.cwd, env: options.env, shell: false, stdio: ["pipe", "pipe", "pipe"] };
  if (process.platform !== "win32") return spawn(command, args, spawnOptions);
  const commandProcessor =
    options.env.ComSpec ?? options.env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
  const commandLine = [command, ...args].join(" ");
  return spawn(commandProcessor, ["/d", "/s", "/c", commandLine], spawnOptions);
}

function quoteWindowsCommandArgument(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function requireMcpRecord(value, message) {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

export function assertMcpSearchToolResult(value) {
  const toolResult = requireMcpRecord(value, "Configured MCP search omitted a tool result.");
  if (!Array.isArray(toolResult.content)) {
    throw new Error("Configured MCP search omitted text content.");
  }
  for (const content of toolResult.content) {
    if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") continue;
    let response;
    try {
      response = JSON.parse(content.text);
    } catch {
      continue;
    }
    if (
      isRecord(response) &&
      Array.isArray(response.results) &&
      response.results.length &&
      response.results.some((result) => isRecord(result) && result.label === "CertifiedPackageSymbol")
    ) {
      return;
    }
  }
  throw new Error("Configured MCP search did not return CertifiedPackageSymbol in a nonempty text JSON results entry.");
}

function createMcpLineClient(child, timeoutMs) {
  const pending = new Map();
  let stderr = "";
  let stdout = "";
  let buffer = "";
  let exited = false;

  function rejectPending(message) {
    const output = boundedDiagnosticOutput(`${stdout}\n${stderr}`.trim());
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(output ? `${message}\n${output}` : message));
    }
    pending.clear();
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = boundedDiagnosticOutput(`${stdout}${chunk}`);
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(message) || (typeof message.id !== "number" && typeof message.id !== "string")) continue;
      const waiter = pending.get(String(message.id));
      if (!waiter) continue;
      pending.delete(String(message.id));
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = boundedDiagnosticOutput(`${stderr}${chunk}`);
  });
  child.on("exit", () => {
    exited = true;
    rejectPending("Configured MCP server exited before responding.");
  });
  child.on("error", (error) => {
    exited = true;
    rejectPending(`Could not start configured MCP server: ${error.message}`);
  });

  function send(message) {
    if (exited || !child.stdin.writable) throw new Error("Configured MCP server stdin is unavailable.");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(id, method, params) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`Configured MCP server timed out during ${method}.`));
      }, timeoutMs);
      pending.set(String(id), { reject, resolve, timer });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(String(id));
        reject(error);
      }
    });
  }

  return { request, send };
}

async function stopConfiguredMcpProcess(child) {
  if (child.stdin.writable) child.stdin.end();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  if (process.platform === "win32" && child.pid !== undefined) {
    const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (killed.status === 0) {
      await exited;
      return;
    }
  }
  child.kill();
  try {
    await exited;
    return;
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return;
  }
  const forcedExit = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.kill("SIGKILL");
  await forcedExit;
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
  const startedAt = context.now();
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
    const durationMs = elapsed(startedAt, context.now);
    recordFailure(context, name, `${name}-command-failed`, errorMessage(error), durationMs, {
      command: commandDisplay(command, args),
    });
    throw new FunnelStepError(`${name} command threw.`);
  }
  const durationMs = elapsed(startedAt, context.now);
  if (output.exitCode !== 0 || output.error) {
    recordFailure(context, name, `${name}-command-failed`, `${name} command exited unsuccessfully.`, durationMs, {
      command: commandDisplay(command, args),
      exitCode: output.exitCode,
      stderr: boundedDiagnosticOutput(output.stderr),
      stdout: boundedDiagnosticOutput(output.stdout),
    });
    throw new FunnelStepError(`${name} command failed.`);
  }
  const budgetMs = FUNNEL_COMMAND_BUDGETS_MS[name];
  if (budgetMs !== undefined && durationMs > budgetMs) {
    recordFailure(
      context,
      name,
      `${name}-duration-budget-exceeded`,
      `${name} exceeded its ${budgetMs}ms funnel duration budget (${durationMs}ms).`,
      durationMs,
      { command: commandDisplay(command, args), exitCode: output.exitCode },
    );
    throw new FunnelStepError(`${name} command exceeded its duration budget.`);
  }
  addFunnelCheck(context.result, { name, status: "pass", durationMs, exitCode: output.exitCode });
  addFunnelTiming(context.result, name, durationMs);
  return output;
}

async function runManualCheck(context, name, code, operation) {
  const startedAt = context.now();
  try {
    const value = await operation();
    const durationMs = elapsed(startedAt, context.now);
    addFunnelCheck(context.result, { name, status: "pass", durationMs });
    addFunnelTiming(context.result, name, durationMs);
    return value;
  } catch (error) {
    const durationMs = elapsed(startedAt, context.now);
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

function pathKey(filePath) {
  const normalized = path.resolve(filePath).replaceAll("\\", "/");
  if (process.platform === "win32") return normalized.toLowerCase();
  return normalized;
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

function elapsed(startedAt, now = () => performance.now()) {
  return Math.max(0, Math.round(now() - startedAt));
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
