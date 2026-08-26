import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { withInstallerLeaseLock } from "../installer/locks.js";
import { isPlainRecord } from "../util/guards.js";
import { isFilePathWithinRoot, normalizePath } from "../util/paths.js";
import { exitWithError, type CliOptionContext, type CliPositionalsContext, type CliRootContext } from "./context.js";
import { parseOptionalBoundedIntegerOption } from "./options.js";
import { writeCliOutput } from "./pretty.js";

type ServerCommand = "start" | "status" | "stop";

const SERVER_REGISTRY_SCHEMA_VERSION = 2;
const SERVER_HEALTH_SCHEMA_VERSION = 1;
const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_SERVER_PORT = 7331;
const DEFAULT_SERVER_START_TIMEOUT_MS = 15_000;
const MAX_SERVER_START_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SERVER_STOP_TIMEOUT_MS = 5_000;
const SERVER_RETRY_DELAY_MS = 50;
const SERVER_HEALTH_GRACE_TIMEOUT_MS = 3_000;
const SERVER_HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const SERVER_HEALTH_RETRY_DELAY_MS = 250;
const MAX_SERVER_START_DIAGNOSTICS_BYTES = 8 * 1024;
const SERVER_LOG_FILE = "server.log";
const SERVER_COMMAND_VALUE_OPTIONS: Record<ServerCommand, readonly string[]> = {
  start: [
    "--root",
    "--cache",
    "--cache-dir",
    "--host",
    "--ignore-glob",
    "--include-glob",
    "--native",
    "--port",
    "--resolution-hint",
    "--startup-timeout-ms",
    "--threads",
  ],
  status: ["--root"],
  stop: ["--root"],
};
const SERVER_COMMAND_FLAGS: Record<ServerCommand, readonly string[]> = {
  start: [
    "--cache-strict",
    "--cache-verify",
    "--no-gitignore",
    "--replace",
    "--warmup",
    "--warmup-symbols",
    "--workers",
    "--json",
  ],
  status: ["--json", "--pretty"],
  stop: [],
};
const FORWARDED_VALUE_OPTIONS = [
  "--cache",
  "--cache-dir",
  "--include-glob",
  "--ignore-glob",
  "--native",
  "--resolution-hint",
  "--threads",
] as const;
const FORWARDED_FLAGS = ["--cache-strict", "--cache-verify", "--no-gitignore", "--workers"] as const;

class ServerUsageError extends Error {}
type ServerHealth = {
  service: "codegraph";
  schemaVersion: number;
  pid: number;
  root: string;
  version: string;
  startedAt: string;
  update: {
    restartRequired: boolean;
    runningVersion: string;
    installedVersion?: string;
    reason?: string;
  };
  lifecycleProof?: string;
};

type ServerStatus = {
  status: "live" | "stale" | "unreachable" | "not_started";
  registry?: CodegraphServerRegistry;
  health?: ServerHealth;
  reason?: string;
};
type RegistryReadResult =
  | { status: "found"; registry: CodegraphServerRegistry }
  | { status: "missing" }
  | { status: "invalid" };
type SpawnedServerProcess = {
  child: ChildProcess;
  startupDiagnostics: ServerStartupDiagnostics;
};
type ServerStartupDiagnostics = {
  read: () => Promise<string>;
  dispose: () => Promise<void>;
};

type LegacyCodegraphServerRegistry = {
  schemaVersion: 1;
  pid: number;
  url: string;
  root: string;
  startedAt: string;
  version: string;
  credentialId?: undefined;
};

export type CodegraphServerRegistry =
  | LegacyCodegraphServerRegistry
  | {
      schemaVersion: 2;
      pid: number;
      url: string;
      root: string;
      startedAt: string;
      version: string;
      credentialId: string;
    };

type ServerLifecycleCredential = {
  id: string;
  token: string;
};

export type ServerCommandContext = CliPositionalsContext &
  CliRootContext &
  CliOptionContext & {
    parsedOptions: ReadonlyMap<string, string[]>;
    writeJSONLine: (value: unknown) => void;
    writeStdoutLine: (message: string) => void;
    writeStderrLine: (message: string) => void;
    exit: (code: number) => never;
  };

export async function handleServerCommand(context: ServerCommandContext): Promise<void> {
  const command = context.positionals[0];
  if (!isServerCommand(command)) {
    context.writeStderrLine("Usage: codegraph server <start|status|stop> [--root <path>]");
    context.exit(2);
  }

  try {
    assertServerCommandOptions(command, context);
    if (command === "start") {
      await startServer(context);
      return;
    }
    if (command === "status") {
      await showServerStatus(context);
      return;
    }
    await stopServer(context);
  } catch (error) {
    exitWithError(context, error, error instanceof ServerUsageError ? 2 : 1);
  }
}

function isServerCommand(command: string | undefined): command is ServerCommand {
  return command === "start" || command === "status" || command === "stop";
}

function assertServerCommandOptions(command: ServerCommand, context: ServerCommandContext): void {
  const allowedOptions = SERVER_COMMAND_VALUE_OPTIONS[command];
  for (const option of context.parsedOptions.keys()) {
    if (!allowedOptions.includes(option)) {
      throw new ServerUsageError(`${option} is not valid for codegraph server ${command}.`);
    }
  }
  const allowedFlags = SERVER_COMMAND_FLAGS[command];
  for (const flags of Object.values(SERVER_COMMAND_FLAGS)) {
    for (const flag of flags) {
      if (context.hasFlag(flag) && !allowedFlags.includes(flag)) {
        throw new ServerUsageError(`${flag} is not valid for codegraph server ${command}.`);
      }
    }
  }
}

type ServerStartOptions = {
  host: string;
  port: number;
  startupTimeoutMs: number;
};

async function startServer(context: ServerCommandContext): Promise<void> {
  const root = await resolveServerRoot(context.root);
  const options = parseServerStartOptions(context);
  await withServerLifecycleLock(root, async () => {
    await startServerForRoot(context, root, options);
  });
}

function parseServerStartOptions(context: ServerCommandContext): ServerStartOptions {
  const host = context.getOpt("--host") ?? DEFAULT_SERVER_HOST;
  if (!host.trim()) throw new ServerUsageError("Invalid --host value. Expected a non-empty host name or address.");
  try {
    const port = parseOptionalBoundedIntegerOption(context.getOpt("--port"), "--port", 1, 65535) ?? DEFAULT_SERVER_PORT;
    const startupTimeoutMs =
      parseOptionalBoundedIntegerOption(
        context.getOpt("--startup-timeout-ms"),
        "--startup-timeout-ms",
        1,
        MAX_SERVER_START_TIMEOUT_MS,
      ) ?? DEFAULT_SERVER_START_TIMEOUT_MS;
    return { host, port, startupTimeoutMs };
  } catch (error) {
    throw new ServerUsageError(error instanceof Error ? error.message : String(error));
  }
}

async function startServerForRoot(
  context: ServerCommandContext,
  root: string,
  options: ServerStartOptions,
): Promise<void> {
  if (context.hasFlag("--warmup") && context.hasFlag("--warmup-symbols")) {
    throw new ServerUsageError("Choose either --warmup or --warmup-symbols for server start.");
  }

  const existingStatus = await readServerStatus(root);
  if (existingStatus.status === "live") {
    if (!context.hasFlag("--replace")) {
      throw new Error(
        `Codegraph server is already live at ${existingStatus.registry!.url}. Use --replace to restart it.`,
      );
    }
    await stopLiveServer(existingStatus.registry!, existingStatus.health!, root);
    await removeRegistry(root, existingStatus.registry!.credentialId);
  } else if (existingStatus.status === "stale") {
    if (!canSafelyRemoveStaleRegistry(existingStatus)) {
      throw new Error("Refusing to replace a Codegraph server whose identity does not match the requested root.");
    }
    await removeRegistry(root, existingStatus.registry?.credentialId);
  } else if (existingStatus.status === "unreachable") {
    throw new Error("Refusing to replace a Codegraph server whose health endpoint is temporarily unavailable.");
  }

  const startupSignals = ["SIGINT", "SIGTERM"] as const;
  const { promise: interrupted, reject: interruptStart } = Promise.withResolvers<never>();
  void interrupted.catch(() => undefined);
  const onStartupSignal = (signal: NodeJS.Signals): void => {
    interruptStart(new Error(`Codegraph server start was interrupted by ${signal}.`));
  };
  for (const signal of startupSignals) {
    process.once(signal, onStartupSignal);
  }

  let child: ChildProcess | undefined;
  let startupDiagnostics: ServerStartupDiagnostics | undefined;
  let lifecycleCredential: ServerLifecycleCredential | undefined;
  let registryWrite: Promise<void> | undefined;
  try {
    const startedAfterMs = Date.now();
    lifecycleCredential = await createServerLifecycleCredential(root);
    const spawned = await spawnServerProcess(root, options.host, options.port, lifecycleCredential.token, context);
    child = spawned.child;
    startupDiagnostics = spawned.startupDiagnostics;
    const childPid = child.pid;
    if (!childPid) throw new Error("Codegraph server process did not provide a pid.");

    const url = serverUrl(options.host, options.port);
    const health = await Promise.race([
      waitForLiveServer(
        url,
        root,
        options.startupTimeoutMs,
        child,
        childPid,
        startedAfterMs,
        lifecycleCredential.token,
      ),
      interrupted,
    ]);
    const registry: CodegraphServerRegistry = {
      schemaVersion: SERVER_REGISTRY_SCHEMA_VERSION,
      pid: childPid,
      url,
      root,
      startedAt: health.startedAt,
      version: health.version,
      credentialId: lifecycleCredential.id,
    };
    registryWrite = writeRegistry(root, registry);
    await Promise.race([registryWrite, interrupted]);
    child.unref();

    if (context.hasFlag("--json")) {
      context.writeJSONLine({ status: "started", ...registry, update: health.update });
      return;
    }
    context.writeStdoutLine(`Codegraph server started at ${registry.url}`);
  } catch (error) {
    if (registryWrite) {
      await registryWrite.catch(() => undefined);
      await removeRegistry(root, lifecycleCredential?.id).catch(() => undefined);
    }
    if (child) await terminateServerProcess(child);
    if (lifecycleCredential) await removeServerLifecycleCredential(root, lifecycleCredential.id).catch(() => undefined);
    throw await withServerStartupDiagnostics(error, startupDiagnostics);
  } finally {
    await startupDiagnostics?.dispose();
    for (const signal of startupSignals) {
      process.removeListener(signal, onStartupSignal);
    }
  }
}

async function showServerStatus(context: ServerCommandContext): Promise<void> {
  const root = await resolveServerRoot(context.root);
  const status = await readServerStatus(root);
  writeCliOutput(
    {
      hasFlag: context.hasFlag,
      writeJSONLine: context.writeJSONLine,
      writeStdoutLine: context.writeStdoutLine,
    },
    status,
    formatServerStatus,
  );
}

async function stopServer(context: ServerCommandContext): Promise<void> {
  const root = await resolveServerRoot(context.root);
  await withServerLifecycleLock(root, async () => {
    const status = await readServerStatus(root);
    if (status.status === "not_started") {
      context.writeStdoutLine("No Codegraph server registry exists for this root.");
      return;
    }
    if (status.status === "unreachable") {
      throw new Error("Refusing to stop a Codegraph server whose health endpoint is temporarily unavailable.");
    }
    if (status.status === "stale") {
      if (!canSafelyRemoveStaleRegistry(status)) {
        throw new Error("Refusing to stop a Codegraph server whose identity does not match the requested root.");
      }
      await removeRegistry(root, status.registry?.credentialId);
      context.writeStdoutLine("Removed stale Codegraph server registry.");
      return;
    }

    await stopLiveServer(status.registry!, status.health!, root);
    await removeRegistry(root, status.registry!.credentialId);
    context.writeStdoutLine(`Stopped Codegraph server at ${status.registry!.url}`);
  });
}

export function formatServerStatus(status: ServerStatus): string {
  const lines = ["Codegraph server status", "=======================", `Status: ${status.status}`];
  if (status.registry) {
    const registry = status.registry;
    lines.push(
      `URL: ${registry.url}`,
      `PID: ${registry.pid}`,
      `Root: ${registry.root}`,
      `Started: ${registry.startedAt}`,
      `Version: ${registry.version}`,
    );
  }
  if (status.reason) lines.push(`Reason: ${status.reason}`);
  if (status.health) {
    lines.push(`Running version: ${status.health.update.runningVersion}`);
    if (status.health.update.installedVersion) {
      lines.push(`Installed version: ${status.health.update.installedVersion}`);
    }
    if (status.health.update.restartRequired) {
      let restartMessage = "Restart required: yes";
      if (status.health.update.reason) restartMessage += ` (${status.health.update.reason})`;
      lines.push(restartMessage);
    } else {
      lines.push("Restart required: no");
    }
  }
  const remedy = serverStatusRemedy(status);
  if (remedy) lines.push(`Remedy: ${remedy}`);
  return lines.join("\n");
}

function serverStatusRemedy(status: ServerStatus): string | undefined {
  if (status.status === "unreachable") {
    return "verify the server process and /health endpoint before retrying.";
  }
  if (status.status !== "stale") return undefined;
  if (requiresIdentityVerification(status)) {
    return "verify the registry and live server identity before retrying.";
  }
  return "run codegraph server stop --root . or codegraph server start --replace --root .";
}

function requiresIdentityVerification(status: ServerStatus): boolean {
  return status.health !== undefined || Boolean(status.reason?.includes("does not match"));
}

function canSafelyRemoveStaleRegistry(status: ServerStatus): boolean {
  return status.status === "stale" && !requiresIdentityVerification(status);
}

async function readServerStatus(root: string): Promise<ServerStatus> {
  const registryPath = await resolveRegistryPath(root, false);
  if (!registryPath) return { status: "not_started" };
  const readResult = await readRegistry(registryPath);
  if (readResult.status === "missing") return { status: "not_started" };
  if (readResult.status === "invalid") return { status: "stale", reason: "Server registry is invalid." };

  const registry = readResult.registry;
  if (!sameRoot(registry.root, root)) {
    return { status: "stale", registry, reason: "Registry root does not match the requested root." };
  }

  if (registry.schemaVersion === 1) {
    if (getServerProcessState(registry.pid) === "missing") {
      return { status: "stale", registry, reason: "Server process is not running." };
    }
    return {
      status: "unreachable",
      registry,
      reason: "Server registry predates lifecycle credentials. Stop the server manually, then start it again.",
    };
  }

  const lifecycleCredential = await readServerLifecycleCredential(root, registry.credentialId);
  if (!lifecycleCredential) {
    if (getServerProcessState(registry.pid) === "missing") {
      return { status: "stale", registry, reason: "Server process is not running." };
    }
    return {
      status: "unreachable",
      registry,
      reason: "Server lifecycle credential is unavailable.",
    };
  }

  const health = await waitForServerHealth(registry.url, SERVER_HEALTH_GRACE_TIMEOUT_MS, lifecycleCredential.token);
  if (!health) {
    if (getServerProcessState(registry.pid) === "missing") {
      return { status: "stale", registry, reason: "Server process is not running." };
    }
    return {
      status: "unreachable",
      registry,
      reason: `Server health endpoint did not prove its lifecycle identity within ${SERVER_HEALTH_GRACE_TIMEOUT_MS}ms.`,
    };
  }
  if (!sameRoot(health.root, root)) {
    return { status: "stale", registry, health, reason: "Server health root does not match the requested root." };
  }
  if (health.pid !== registry.pid) {
    return { status: "stale", registry, health, reason: "Server process identifier does not match the registry." };
  }
  if (health.startedAt !== registry.startedAt) {
    return { status: "stale", registry, health, reason: "Server startup time does not match the registry." };
  }
  return { status: "live", registry, health };
}

async function stopLiveServer(registry: CodegraphServerRegistry, health: ServerHealth, root: string): Promise<void> {
  if (
    !sameRoot(registry.root, root) ||
    !sameRoot(health.root, root) ||
    health.pid !== registry.pid ||
    health.startedAt !== registry.startedAt
  ) {
    throw new Error("Refusing to stop a Codegraph server whose identity does not match the requested root.");
  }
  try {
    process.kill(registry.pid, "SIGTERM");
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
  await waitForServerStop(registry.url, registry.pid, SERVER_STOP_TIMEOUT_MS);
}

async function spawnServerProcess(
  root: string,
  host: string,
  port: number,
  lifecycleCredential: string,
  context: ServerCommandContext,
): Promise<SpawnedServerProcess> {
  const entryPath = process.argv[1];
  if (!entryPath) throw new Error("Unable to locate the Codegraph CLI entrypoint.");
  const args = [entryPath, "mcp", "serve", "--root", root, "--host", host, "--port", String(port)];
  if (context.hasFlag("--warmup")) args.push("--warmup");
  if (context.hasFlag("--warmup-symbols")) args.push("--warmup-symbols");
  for (const flag of FORWARDED_FLAGS) {
    if (context.hasFlag(flag)) args.push(flag);
  }
  for (const option of FORWARDED_VALUE_OPTIONS) {
    for (const value of context.parsedOptions.get(option) ?? []) {
      args.push(option, value);
    }
  }

  const lifecycleHealth = await import("../mcp/lifecycleHealth.js");
  const startupDiagnostics = await createServerStartupDiagnostics(root);
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      env: { ...process.env, [lifecycleHealth.MCP_LIFECYCLE_HEALTH_TOKEN_ENV]: lifecycleCredential },
      stdio: ["ignore", "ignore", startupDiagnostics.fileDescriptor],
      windowsHide: true,
    });
    await waitForServerProcessSpawn(child);
    return { child, startupDiagnostics };
  } catch (error) {
    await startupDiagnostics.dispose();
    throw error;
  }
}

function waitForServerProcessSpawn(child: ChildProcess): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onSpawn = (): void => {
    cleanup();
    resolve();
  };
  const onError = (error: Error): void => {
    cleanup();
    reject(error);
  };
  const cleanup = (): void => {
    child.removeListener("spawn", onSpawn);
    child.removeListener("error", onError);
  };
  child.once("spawn", onSpawn);
  child.once("error", onError);
  return promise;
}

async function createServerStartupDiagnostics(
  root: string,
): Promise<ServerStartupDiagnostics & { fileDescriptor: number }> {
  const logPath = await resolveServerStatePath(root, SERVER_LOG_FILE, true);
  if (!logPath) throw new Error("Codegraph server log path is unavailable.");
  await assertRegularServerStateFile(logPath);
  const logFile = await fs.open(logPath, "w", 0o600);
  try {
    const startOffset = (await logFile.stat()).size;
    await logFile.chmod(0o600);
    return {
      fileDescriptor: logFile.fd,
      read: () => readServerLogTail(logPath, startOffset),
      dispose: () => logFile.close(),
    };
  } catch (error) {
    await logFile.close();
    throw error;
  }
}

async function readServerLogTail(logPath: string, startOffset: number): Promise<string> {
  try {
    const contents = await fs.readFile(logPath);
    const offset = Math.max(startOffset, contents.length - MAX_SERVER_START_DIAGNOSTICS_BYTES);
    return contents.subarray(offset).toString("utf8").trim();
  } catch {
    return "";
  }
}

async function withServerStartupDiagnostics(
  error: unknown,
  diagnostics: ServerStartupDiagnostics | undefined,
): Promise<Error> {
  const output = await diagnostics?.read();
  if (!output) {
    if (error instanceof Error) return error;
    return new Error(String(error));
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error([message, "Server startup diagnostics:", output].join("\n"), { cause: error });
}

async function waitForLiveServer(
  url: string,
  root: string,
  timeoutMs: number,
  child: ChildProcess,
  childPid: number,
  startedAfterMs: number,
  lifecycleCredential: string,
): Promise<ServerHealth> {
  const { promise: childClosed, resolve: resolveChildClose } = Promise.withResolvers<void>();
  const onChildClose = () => resolveChildClose();
  child.once("close", onChildClose);
  if (child.exitCode !== null || child.signalCode !== null) resolveChildClose();
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const result = await Promise.race([
        requestServerHealth(url, Math.min(SERVER_HEALTH_REQUEST_TIMEOUT_MS, remainingMs), lifecycleCredential).then(
          (health) => ({
            kind: "health" as const,
            health,
          }),
        ),
        childClosed.then(() => ({ kind: "child-exited" as const })),
      ]);
      if (result.kind === "child-exited") {
        throw new Error(`Codegraph server process exited before accepting requests at ${url}.`);
      }
      if (
        result.health &&
        result.health.pid === childPid &&
        sameRoot(result.health.root, root) &&
        serverStartedAfter(result.health, startedAfterMs)
      ) {
        return result.health;
      }
      await wait(SERVER_RETRY_DELAY_MS);
    }
  } finally {
    child.removeListener("close", onChildClose);
  }
  throw new Error(`Codegraph server did not become reachable at ${url} within ${timeoutMs}ms.`);
}

function serverStartedAfter(health: ServerHealth, startedAfterMs: number): boolean {
  const startedAtMs = Date.parse(health.startedAt);
  return Number.isFinite(startedAtMs) && startedAtMs >= startedAfterMs;
}

async function terminateServerProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
    return;
  }
  if (!(await waitForChildExit(child, SERVER_STOP_TIMEOUT_MS))) {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if (!isMissingProcessError(error)) throw error;
    }
    await waitForChildExit(child, SERVER_STOP_TIMEOUT_MS);
  }
  child.unref();
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const { promise, resolve } = Promise.withResolvers<void>();
  const onClose = () => resolve();
  child.once("close", onClose);
  try {
    await Promise.race([promise, wait(timeoutMs)]);
    return child.exitCode !== null || child.signalCode !== null;
  } finally {
    child.removeListener("close", onClose);
  }
}

async function waitForServerStop(url: string, pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await requestServerHealth(url);
    if (!health && getServerProcessState(pid) === "missing") return;
    await wait(SERVER_RETRY_DELAY_MS);
  }
  throw new Error(`Codegraph server at ${url} did not stop within ${timeoutMs}ms.`);
}

async function waitForServerHealth(
  serverUrl: string,
  timeoutMs: number,
  lifecycleCredential: string,
): Promise<ServerHealth | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return undefined;
    const health = await requestServerHealth(
      serverUrl,
      Math.min(SERVER_HEALTH_REQUEST_TIMEOUT_MS, remainingMs),
      lifecycleCredential,
    );
    if (health) return health;
    const retryDelayMs = Math.min(SERVER_HEALTH_RETRY_DELAY_MS, deadline - Date.now());
    if (retryDelayMs <= 0) return undefined;
    await wait(retryDelayMs);
  }
}

function wait(delayMs: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, delayMs);
  return promise;
}

async function requestServerHealth(
  serverUrl: string,
  timeoutMs = SERVER_HEALTH_REQUEST_TIMEOUT_MS,
  lifecycleCredential?: string,
): Promise<ServerHealth | undefined> {
  let healthUrl: URL;
  try {
    healthUrl = new URL(serverUrl);
    healthUrl.pathname = "/health";
    healthUrl.search = "";
  } catch {
    return undefined;
  }

  let lifecycleHealth: typeof import("../mcp/lifecycleHealth.js") | undefined;
  let challenge: string | undefined;
  if (lifecycleCredential) {
    lifecycleHealth = await import("../mcp/lifecycleHealth.js");
    challenge = lifecycleHealth.createMcpLifecycleHealthChallenge();
  }
  const requestOptions: RequestInit = { signal: AbortSignal.timeout(timeoutMs) };
  if (challenge) requestOptions.headers = { "x-codegraph-health-challenge": challenge };

  try {
    const response = await fetch(healthUrl, requestOptions);
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (!isServerHealth(body)) return undefined;
    if (
      lifecycleCredential &&
      challenge &&
      lifecycleHealth &&
      !lifecycleHealth.matchesMcpLifecycleHealthProof(body.lifecycleProof, lifecycleCredential, challenge, body)
    ) {
      return undefined;
    }
    return body;
  } catch {
    return undefined;
  }
}

function isServerHealth(value: unknown): value is ServerHealth {
  if (!isPlainRecord(value)) return false;
  const update = value.update;
  if (!isPlainRecord(update)) return false;
  return (
    value.service === "codegraph" &&
    value.schemaVersion === SERVER_HEALTH_SCHEMA_VERSION &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.root === "string" &&
    typeof value.version === "string" &&
    typeof value.startedAt === "string" &&
    typeof update.restartRequired === "boolean" &&
    typeof update.runningVersion === "string" &&
    (update.installedVersion === undefined || typeof update.installedVersion === "string") &&
    (update.reason === undefined || typeof update.reason === "string") &&
    (value.lifecycleProof === undefined || typeof value.lifecycleProof === "string")
  );
}

async function readRegistry(registryPath: string): Promise<RegistryReadResult> {
  let raw: string;
  try {
    const stats = await fs.lstat(registryPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return { status: "invalid" };
    raw = await fs.readFile(registryPath, "utf8");
  } catch (error) {
    return isMissingFileError(error) ? { status: "missing" } : { status: "invalid" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isServerRegistry(parsed) ? { status: "found", registry: parsed } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

function isServerRegistry(value: unknown): value is CodegraphServerRegistry {
  if (!isPlainRecord(value)) return false;
  const isCommonRegistry =
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.url === "string" &&
    typeof value.root === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.version === "string";
  if (!isCommonRegistry) return false;
  if (value.schemaVersion === 1) return value.credentialId === undefined;
  return (
    value.schemaVersion === SERVER_REGISTRY_SCHEMA_VERSION &&
    typeof value.credentialId === "string" &&
    /^[a-f0-9-]{36}$/.test(value.credentialId)
  );
}

async function createServerLifecycleCredential(root: string): Promise<ServerLifecycleCredential> {
  const crypto = await import("node:crypto");
  const id = crypto.randomUUID();
  const credentialPath = await resolveServerLifecycleCredentialPath(root, id);
  await fs.mkdir(path.dirname(credentialPath), { recursive: true });
  await assertRegularServerStateFile(credentialPath);

  const lifecycleHealth = await import("../mcp/lifecycleHealth.js");
  const credential = lifecycleHealth.createMcpLifecycleHealthToken();
  const temporaryPath = credentialPath + "." + process.pid + "." + Date.now() + ".tmp";
  try {
    await fs.writeFile(temporaryPath, credential + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, credentialPath);
    return { id, token: credential };
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function readServerLifecycleCredential(
  root: string,
  credentialId: string,
): Promise<ServerLifecycleCredential | undefined> {
  const credentialPath = await resolveServerLifecycleCredentialPath(root, credentialId);
  let raw: string;
  try {
    const stats = await fs.lstat(credentialPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Codegraph server lifecycle credential is not a regular file: ${normalizePath(credentialPath)}`);
    }
    raw = await fs.readFile(credentialPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }

  const lifecycleHealth = await import("../mcp/lifecycleHealth.js");
  const env: NodeJS.ProcessEnv = {};
  env[lifecycleHealth.MCP_LIFECYCLE_HEALTH_TOKEN_ENV] = raw.trim();
  const token = lifecycleHealth.readMcpLifecycleHealthToken(env);
  if (!token) return undefined;
  return { id: credentialId, token };
}

async function removeServerLifecycleCredential(root: string, credentialId: string): Promise<void> {
  const credentialPath = await resolveServerLifecycleCredentialPath(root, credentialId);
  try {
    const stats = await fs.lstat(credentialPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Refusing to remove non-regular server lifecycle credential: ${normalizePath(credentialPath)}`);
    }
    await fs.rm(credentialPath);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

async function resolveServerLifecycleCredentialPath(_root: string, credentialId: string): Promise<string> {
  const compileCache = await import("./compileCache.js");
  return path.join(compileCache.resolveCodegraphUserCacheRoot(), "server-lifecycle-v1", credentialId + ".credential");
}

async function writeRegistry(root: string, registry: CodegraphServerRegistry): Promise<void> {
  const registryPath = await resolveRegistryPath(root, true);
  if (!registryPath) throw new Error("Codegraph server registry directory is unavailable.");
  const temporaryPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, registryPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function removeRegistry(root: string, credentialId: string | undefined): Promise<void> {
  const registryPath = await resolveRegistryPath(root, false);
  if (registryPath) await fs.rm(registryPath, { force: true });
  if (credentialId) await removeServerLifecycleCredential(root, credentialId);
}

async function resolveRegistryPath(root: string, createDirectory: boolean): Promise<string | undefined> {
  return resolveServerStatePath(root, "server.json", createDirectory);
}

async function resolveServerStatePath(
  root: string,
  fileName: string,
  createDirectory: boolean,
): Promise<string | undefined> {
  const directory = await resolveServerStateDirectory(root, createDirectory);
  if (!directory) return undefined;
  return path.join(directory, fileName);
}

async function resolveServerStateDirectory(root: string, createDirectory: boolean): Promise<string | undefined> {
  const registryDirectory = path.join(root, ".codegraph");
  let realDirectory: string;
  try {
    realDirectory = await fs.realpath(registryDirectory);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    if (!createDirectory) return undefined;
    await fs.mkdir(registryDirectory, { recursive: true });
    realDirectory = await fs.realpath(registryDirectory);
  }
  if (!isFilePathWithinRoot(root, realDirectory) || sameRoot(root, realDirectory)) {
    throw new Error(
      `Codegraph server registry directory resolves outside project root: ${normalizePath(realDirectory)}`,
    );
  }
  const stats = await fs.stat(realDirectory);
  if (!stats.isDirectory()) {
    throw new Error(`Codegraph server registry path is not a directory: ${normalizePath(realDirectory)}`);
  }
  return realDirectory;
}

async function assertRegularServerStateFile(filePath: string): Promise<void> {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Codegraph server state path is not a regular file: ${normalizePath(filePath)}`);
    }
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

async function withServerLifecycleLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = path.join(root, ".codegraph-server.lock");
  try {
    return await withInstallerLeaseLock(lockPath, `MCP server lifecycle for ${normalizePath(root)}`, operation);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Another Codegraph installer")) {
      throw new Error(`Another Codegraph server lifecycle command is in progress for ${normalizePath(root)}.`, {
        cause: error,
      });
    }
    if (error instanceof Error && error.message.startsWith("Codegraph installer found an existing lock")) {
      throw new Error(`Could not safely acquire the Codegraph server lifecycle lock for ${normalizePath(root)}.`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function resolveServerRoot(root: string): Promise<string> {
  return normalizePath(await fs.realpath(path.resolve(root)));
}

function sameRoot(left: string, right: string): boolean {
  return normalizeServerRoot(left) === normalizeServerRoot(right);
}

function normalizeServerRoot(root: string): string {
  const resolved = normalizePath(path.resolve(root));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function serverUrl(host: string, port: number): string {
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}/mcp`;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

type ServerProcessState = "running" | "missing" | "unknown";

function getServerProcessState(pid: number): ServerProcessState {
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    if (isMissingProcessError(error)) return "missing";
    if (isPermissionProcessError(error)) return "unknown";
    throw error;
  }
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isPermissionProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}
