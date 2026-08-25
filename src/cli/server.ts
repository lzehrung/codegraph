import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { isPlainRecord } from "../util/guards.js";
import { normalizePath } from "../util/paths.js";
import { exitWithError, type CliOptionContext, type CliPositionalsContext, type CliRootContext } from "./context.js";
import { parseOptionalBoundedIntegerOption } from "./options.js";
import { writeCliOutput } from "./pretty.js";

const SERVER_REGISTRY_SCHEMA_VERSION = 1;
const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_SERVER_PORT = 7331;
const SERVER_START_TIMEOUT_MS = 15_000;
const SERVER_STOP_TIMEOUT_MS = 5_000;
const SERVER_RETRY_DELAY_MS = 50;
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

type ServerCommand = "start" | "status" | "stop";
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
};

type ServerStatus = {
  status: "live" | "stale" | "not_started";
  registry?: CodegraphServerRegistry;
  health?: ServerHealth;
  reason?: string;
};
type RegistryReadResult =
  | { status: "found"; registry: CodegraphServerRegistry }
  | { status: "missing" }
  | { status: "invalid" };

export type CodegraphServerRegistry = {
  schemaVersion: 1;
  pid: number;
  url: string;
  root: string;
  startedAt: string;
  version: string;
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

async function startServer(context: ServerCommandContext): Promise<void> {
  const root = await resolveServerRoot(context.root);
  const registryPath = registryPathForRoot(root);
  const host = context.getOpt("--host") ?? DEFAULT_SERVER_HOST;
  if (!host.trim()) throw new ServerUsageError("Invalid --host value. Expected a non-empty host name or address.");
  let parsedPort: number | undefined;
  try {
    parsedPort = parseOptionalBoundedIntegerOption(context.getOpt("--port"), "--port", 1, 65535);
  } catch (error) {
    throw new ServerUsageError(error instanceof Error ? error.message : String(error));
  }
  const port = parsedPort ?? DEFAULT_SERVER_PORT;
  if (context.hasFlag("--warmup") && context.hasFlag("--warmup-symbols")) {
    throw new ServerUsageError("Choose either --warmup or --warmup-symbols for server start.");
  }

  const existingStatus = await readServerStatus(registryPath, root);
  if (existingStatus.status === "live") {
    if (!context.hasFlag("--replace")) {
      throw new Error(
        `Codegraph server is already live at ${existingStatus.registry!.url}. Use --replace to restart it.`,
      );
    }
    await stopLiveServer(existingStatus.registry!, existingStatus.health!, root);
    await removeRegistry(registryPath);
  } else if (existingStatus.status === "stale") {
    if (existingStatus.health) {
      throw new Error("Refusing to replace a Codegraph server whose root does not match the requested root.");
    }
    await removeRegistry(registryPath);
  }

  const startedAfterMs = Date.now();
  const child = spawnServerProcess(root, host, port, context);
  if (!child.pid) {
    child.kill();
    throw new Error("Codegraph server process did not provide a pid.");
  }

  const url = serverUrl(host, port);
  let health: ServerHealth;
  try {
    health = await waitForLiveServer(url, root, SERVER_START_TIMEOUT_MS, child, child.pid, startedAfterMs);
  } catch (error) {
    child.kill();
    throw error;
  }

  const registry: CodegraphServerRegistry = {
    schemaVersion: SERVER_REGISTRY_SCHEMA_VERSION,
    pid: child.pid,
    url,
    root,
    startedAt: health.startedAt,
    version: health.version,
  };
  await writeRegistry(registryPath, registry);
  child.unref();

  if (context.hasFlag("--json")) {
    context.writeJSONLine({ status: "started", ...registry, update: health.update });
    return;
  }
  context.writeStdoutLine(`Codegraph server started at ${registry.url}`);
}

async function showServerStatus(context: ServerCommandContext): Promise<void> {
  const root = await resolveServerRoot(context.root);
  const status = await readServerStatus(registryPathForRoot(root), root);
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
  const registryPath = registryPathForRoot(root);
  const status = await readServerStatus(registryPath, root);
  if (status.status === "not_started") {
    context.writeStdoutLine("No Codegraph server registry exists for this root.");
    return;
  }
  if (status.status === "stale") {
    if (status.health || (status.registry && !sameRoot(status.registry.root, root))) {
      throw new Error("Refusing to stop a Codegraph server whose root does not match the requested root.");
    }
    await removeRegistry(registryPath);
    context.writeStdoutLine("Removed stale Codegraph server registry.");
    return;
  }

  await stopLiveServer(status.registry!, status.health!, root);
  await removeRegistry(registryPath);
  context.writeStdoutLine(`Stopped Codegraph server at ${status.registry!.url}`);
}

export function formatServerStatus(status: ServerStatus): string {
  if (!status.registry) {
    const lines = ["Codegraph server status", "=======================", `Status: ${status.status}`];
    if (status.reason) lines.push(`Reason: ${status.reason}`);
    if (status.status === "stale") {
      lines.push("Remedy: run codegraph server stop --root . or codegraph server start --replace --root .");
    }
    return lines.join("\n");
  }

  const registry = status.registry;
  const lines = [
    "Codegraph server status",
    "=======================",
    `Status: ${status.status}`,
    `URL: ${registry.url}`,
    `PID: ${registry.pid}`,
    `Root: ${registry.root}`,
    `Started: ${registry.startedAt}`,
    `Version: ${registry.version}`,
  ];
  if (status.reason) lines.push(`Reason: ${status.reason}`);
  if (status.health) {
    lines.push(`Running version: ${status.health.update.runningVersion}`);
    if (status.health.update.installedVersion)
      lines.push(`Installed version: ${status.health.update.installedVersion}`);
    if (status.health.update.restartRequired) {
      lines.push(`Restart required: yes${status.health.update.reason ? ` (${status.health.update.reason})` : ""}`);
    } else {
      lines.push("Restart required: no");
    }
  }
  if (status.status === "stale") {
    lines.push("Remedy: run codegraph server stop --root . or codegraph server start --replace --root .");
  }
  return lines.join("\n");
}

async function readServerStatus(registryPath: string, root: string): Promise<ServerStatus> {
  const readResult = await readRegistry(registryPath);
  if (readResult.status === "missing") return { status: "not_started" };
  if (readResult.status === "invalid") return { status: "stale", reason: "Server registry is invalid." };

  const registry = readResult.registry;
  if (!sameRoot(registry.root, root)) {
    return { status: "stale", registry, reason: "Registry root does not match the requested root." };
  }

  const health = await requestServerHealth(registry.url);
  if (!health) return { status: "stale", registry, reason: "Server health endpoint did not respond." };
  if (!sameRoot(health.root, root)) {
    return { status: "stale", registry, health, reason: "Server health root does not match the requested root." };
  }
  if (health.pid !== registry.pid) {
    return { status: "stale", registry, health, reason: "Server process identifier does not match the registry." };
  }
  return { status: "live", registry, health };
}

async function stopLiveServer(registry: CodegraphServerRegistry, health: ServerHealth, root: string): Promise<void> {
  if (!sameRoot(registry.root, root) || !sameRoot(health.root, root) || health.pid !== registry.pid) {
    throw new Error("Refusing to stop a Codegraph server whose root does not match the requested root.");
  }
  try {
    process.kill(registry.pid, "SIGTERM");
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
  await waitForServerStop(registry.url, SERVER_STOP_TIMEOUT_MS);
}

function spawnServerProcess(root: string, host: string, port: number, context: ServerCommandContext) {
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
  return spawn(process.execPath, args, { cwd: root, detached: true, stdio: "ignore", windowsHide: true });
}

async function waitForLiveServer(
  url: string,
  root: string,
  timeoutMs: number,
  child: ChildProcess,
  childPid: number,
  startedAfterMs: number,
): Promise<ServerHealth> {
  const { promise: childExited, resolve: resolveChildExit } = Promise.withResolvers<void>();
  const onChildExit = () => resolveChildExit();
  child.once("exit", onChildExit);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await Promise.race([
        requestServerHealth(url).then((health) => ({ kind: "health" as const, health })),
        childExited.then(() => ({ kind: "child-exited" as const })),
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
    child.removeListener("exit", onChildExit);
  }
  throw new Error(`Codegraph server did not become reachable at ${url} within ${timeoutMs}ms.`);
}

function serverStartedAfter(health: ServerHealth, startedAfterMs: number): boolean {
  const startedAtMs = Date.parse(health.startedAt);
  return Number.isFinite(startedAtMs) && startedAtMs >= startedAfterMs;
}

async function waitForServerStop(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await requestServerHealth(url))) return;
    await wait(SERVER_RETRY_DELAY_MS);
  }
  throw new Error(`Codegraph server at ${url} did not stop within ${timeoutMs}ms.`);
}

function wait(delayMs: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, delayMs);
  return promise;
}

async function requestServerHealth(serverUrl: string): Promise<ServerHealth | undefined> {
  let healthUrl: URL;
  try {
    healthUrl = new URL(serverUrl);
    healthUrl.pathname = "/health";
    healthUrl.search = "";
  } catch {
    return undefined;
  }

  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return isServerHealth(body) ? body : undefined;
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
    typeof value.schemaVersion === "number" &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.root === "string" &&
    typeof value.version === "string" &&
    typeof value.startedAt === "string" &&
    typeof update.restartRequired === "boolean" &&
    typeof update.runningVersion === "string" &&
    (update.installedVersion === undefined || typeof update.installedVersion === "string") &&
    (update.reason === undefined || typeof update.reason === "string")
  );
}

async function readRegistry(registryPath: string): Promise<RegistryReadResult> {
  let raw: string;
  try {
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
  return (
    isPlainRecord(value) &&
    value.schemaVersion === SERVER_REGISTRY_SCHEMA_VERSION &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.url === "string" &&
    typeof value.root === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.version === "string"
  );
}

async function writeRegistry(registryPath: string, registry: CodegraphServerRegistry): Promise<void> {
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, registryPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function removeRegistry(registryPath: string): Promise<void> {
  await fs.rm(registryPath, { force: true });
}

function registryPathForRoot(root: string): string {
  return path.join(root, ".codegraph", "server.json");
}

async function resolveServerRoot(root: string): Promise<string> {
  return normalizePath(await fs.realpath(path.resolve(root)));
}

function sameRoot(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = normalizePath(path.resolve(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function serverUrl(host: string, port: number): string {
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}/mcp`;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
