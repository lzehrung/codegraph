import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  NATIVE_META_PACKAGE_NAME,
  PACKAGE_SMOKE_REPORT_SCHEMA_VERSION,
  PackageCertificationError,
  CORE_PACKAGE_NAME,
  ROOT_PACKAGE_NAME,
  computeFileSha256,
  readReleaseCandidateManifest,
  selectReducedReleaseCandidatePackage,
  selectReleaseCandidatePackages,
} from "./package-contract-lib.mjs";
import { getNativeTargetMetadata } from "../native-targets-lib.mjs";

const MAX_CAPTURE_LENGTH = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MCP_TIMEOUT_MS = 60_000;
const SMOKE_SYMBOL = "CertifiedPackageSymbol";

function npmExecutable() {
  return "npm";
}

function resolveCommandInvocation(command, args) {
  if (process.platform !== "win32" || command !== "npm") return { command, args };
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && path.basename(candidate) === "npm-cli.js");
  const npmCliPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!npmCliPath) {
    throw new PackageCertificationError(
      "subprocess-unavailable",
      "Could not locate npm-cli.js for package certification.",
    );
  }
  return { command: process.execPath, args: [npmCliPath, ...args] };
}

function redactOutput(value) {
  return String(value ?? "")
    .replace(/(npm_[A-Za-z0-9]{20,})/g, "[REDACTED]")
    .replace(/(gh[pousr]_[A-Za-z0-9_]{20,})/g, "[REDACTED]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(_authToken\s*=\s*)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/g, "$1[REDACTED]@");
}

function boundOutput(value) {
  const redacted = redactOutput(value);
  if (redacted.length <= MAX_CAPTURE_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_CAPTURE_LENGTH)}\n[output truncated]`;
}

function commandDisplay(command, args) {
  return [command, ...args].join(" ");
}

export function runPackageCommand(command, args, options = {}) {
  const startedAt = performance.now();
  const invocation = resolveCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    shell: false,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    command: commandDisplay(command, args),
    exitCode: result.status,
    signal: result.signal,
    stdout: boundOutput(result.stdout),
    stderr: boundOutput(result.stderr),
    rawStdout: String(result.stdout ?? ""),
    rawStderr: String(result.stderr ?? ""),
    durationMs: Math.round(performance.now() - startedAt),
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function commandCheck(name, result) {
  return {
    name,
    status: result.exitCode === 0 ? "pass" : "fail",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function manualCheck(name, details = {}) {
  return { name, status: "pass", durationMs: 0, ...details };
}

function requireSuccessfulCommand(result, code, message, context = {}) {
  if (result.exitCode !== 0 || result.error) {
    throw new PackageCertificationError(code, message, {
      ...context,
      command: result.command,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
    });
  }
}

function parseJsonOutput(result, code, description) {
  requireSuccessfulCommand(result, code, `${description} failed.`);
  try {
    return JSON.parse(result.rawStdout ?? result.stdout);
  } catch (error) {
    throw new PackageCertificationError(code, `${description} returned malformed JSON.`, {
      stdout: result.stdout,
      stderr: result.stderr,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function expectedVersionForEntry(manifest, entry) {
  if (entry.package === ROOT_PACKAGE_NAME || entry.package === CORE_PACKAGE_NAME) {
    return manifest.rootVersion;
  }
  return manifest.nativeVersion;
}

function requiredArchiveFile(entry) {
  if (entry.target) return `index.${entry.target}.node`;
  if (entry.package === NATIVE_META_PACKAGE_NAME) return "index.js";
  if (entry.package === CORE_PACKAGE_NAME) return "dist/index.js";
  return "dist/bin/cli.js";
}

export async function inspectPackageTarball({ manifest, entry, manifestDirectory, commandRunner = runPackageCommand }) {
  const extractionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-package-inspection-"));
  try {
    const tarballPath = entry.file.replaceAll("\\", "/");
    const result = await commandRunner("tar", ["-xzf", tarballPath, "-C", extractionDirectory], {
      cwd: manifestDirectory,
    });
    requireSuccessfulCommand(result, "archive-invalid", `Extracting archive ${entry.file} failed.`);
    const packageDirectory = path.join(extractionDirectory, "package");
    let packageManifest;
    try {
      packageManifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
    } catch (error) {
      throw new PackageCertificationError("archive-invalid", `Archive ${entry.file} has no valid package.json.`, {
        file: entry.file,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (packageManifest.name !== entry.package) {
      const code = entry.target ? "target-mismatch" : "package-identity-mismatch";
      throw new PackageCertificationError(code, "Archive package name does not match the candidate manifest.", {
        file: entry.file,
        target: entry.target,
        expected: entry.package,
        actual: packageManifest.name,
      });
    }
    const expectedVersion = expectedVersionForEntry(manifest, entry);
    if (packageManifest.version !== expectedVersion) {
      throw new PackageCertificationError(
        "package-identity-mismatch",
        "Archive package version does not match the candidate manifest.",
        {
          file: entry.file,
          package: entry.package,
          expected: expectedVersion,
          actual: packageManifest.version,
        },
      );
    }
    const files = await collectPackageFileRecords(packageDirectory);
    const archivePaths = files.map((file) => file.path);
    const requiredFile = requiredArchiveFile(entry);
    if (!archivePaths.includes("package.json") || !archivePaths.includes(requiredFile)) {
      throw new PackageCertificationError(
        "archive-invalid",
        `Archive ${entry.file} is missing required package files.`,
        {
          file: entry.file,
          requiredFiles: ["package.json", requiredFile],
          archivePaths,
        },
      );
    }
    return {
      identity: {
        package: packageManifest.name,
        version: packageManifest.version,
        file: entry.file,
        sha256: entry.sha256,
      },
      files,
      result,
    };
  } finally {
    fs.rmSync(extractionDirectory, { recursive: true, force: true });
  }
}

function packageInstallPath(installDirectory, packageName) {
  return path.join(installDirectory, "node_modules", ...packageName.split("/"));
}

function assertInstallOutsideCheckout(installDirectory, checkoutDirectory) {
  const relative = path.relative(path.resolve(checkoutDirectory), path.resolve(installDirectory));
  const isInsideCheckout = !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (isInsideCheckout) {
    throw new PackageCertificationError(
      "install-location-invalid",
      `Package smoke install directory must be outside the checkout: ${installDirectory}`,
      { installDirectory, checkoutDirectory },
    );
  }
}

function createInstallDirectory(options) {
  if (options.installDirectory) {
    const installDirectory = path.resolve(options.installDirectory);
    assertInstallOutsideCheckout(installDirectory, options.checkoutDirectory);
    fs.mkdirSync(installDirectory, { recursive: true });
    if (fs.readdirSync(installDirectory).length) {
      throw new PackageCertificationError(
        "install-location-invalid",
        `Package smoke install directory must be empty.`,
        {
          installDirectory,
        },
      );
    }
    return { installDirectory, removeAfter: false };
  }
  const installDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-package-smoke-"));
  assertInstallOutsideCheckout(installDirectory, options.checkoutDirectory);
  return { installDirectory, removeAfter: true };
}

function writeInstallManifest(installDirectory) {
  fs.writeFileSync(
    path.join(installDirectory, "package.json"),
    `${JSON.stringify({ name: "codegraph-package-smoke", version: "0.0.0", private: true }, null, 2)}\n`,
    "utf8",
  );
}

async function installPackages({ entries, manifestDirectory, installDirectory, reduced, commandRunner }) {
  writeInstallManifest(installDirectory);
  const tarballs = entries.map((entry) => path.resolve(manifestDirectory, entry.file));
  const args = [
    "install",
    "--ignore-scripts",
    "--package-lock=false",
    "--no-audit",
    "--prefer-offline",
    "--no-fund",
    "--no-save",
    ...(reduced ? ["--omit=optional"] : []),
    ...tarballs,
  ];
  const result = await commandRunner(npmExecutable(), args, { cwd: installDirectory, timeoutMs: 300_000 });
  requireSuccessfulCommand(result, "install-failed", "Installing local release candidate tarballs failed.");
  return result;
}

function readInstalledIdentity(installDirectory, entry, expectedVersion) {
  const packageDirectory = packageInstallPath(installDirectory, entry.package);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  } catch (error) {
    throw new PackageCertificationError(
      "installed-package-missing",
      `Installed package is missing: ${entry.package}.`,
      {
        package: entry.package,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  if (manifest.name !== entry.package || manifest.version !== expectedVersion) {
    throw new PackageCertificationError(
      "package-identity-mismatch",
      `Installed package identity does not match candidate.`,
      {
        package: entry.package,
        expectedVersion,
        actualName: manifest.name,
        actualVersion: manifest.version,
      },
    );
  }
  return { package: manifest.name, version: manifest.version, packageDirectory };
}

async function verifyInstalledPackageBytes({ installDirectory, entry, expected }) {
  const startedAt = performance.now();
  const packageDirectory = packageInstallPath(installDirectory, entry.package);
  const actual = await collectPackageFileRecords(packageDirectory);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const mismatchedPath = [...new Set([...expected.map((file) => file.path), ...actual.map((file) => file.path)])]
      .sort()
      .find((filePath) => {
        const expectedFile = expected.find((file) => file.path === filePath);
        const actualFile = actual.find((file) => file.path === filePath);
        return JSON.stringify(actualFile) !== JSON.stringify(expectedFile);
      });
    throw new PackageCertificationError(
      "installed-bytes-mismatch",
      `Installed package files differ from certified tarball ${entry.file}.`,
      {
        package: entry.package,
        path: mismatchedPath,
        expected: expected.find((file) => file.path === mismatchedPath),
        actual: actual.find((file) => file.path === mismatchedPath),
      },
    );
  }
  return { durationMs: Math.round(performance.now() - startedAt) };
}

async function collectPackageFileRecords(rootDirectory) {
  const records = [];
  const pending = [rootDirectory];
  while (pending.length) {
    const directory = pending.pop();
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(filePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new PackageCertificationError(
          "installed-bytes-mismatch",
          `Package contents include unsupported entry type: ${filePath}.`,
        );
      }
      const stats = fs.statSync(filePath);
      records.push({
        path: path.relative(rootDirectory, filePath).replaceAll("\\", "/"),
        size: stats.size,
        sha256: await computeFileSha256(filePath),
      });
    }
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

function packedCliPath(installDirectory) {
  return path.join(packageInstallPath(installDirectory, ROOT_PACKAGE_NAME), "dist", "bin", "cli.js");
}

async function runNodeJson(args, options, commandRunner, code, description) {
  const result = await commandRunner(process.execPath, args, options);
  const value = parseJsonOutput(result, code, description);
  return { result, value };
}

function ensurePlainRecord(value, code, message) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageCertificationError(code, message);
  }
  return value;
}

function runtimeImportSource(targetPackage) {
  return [
    'import { createRequire } from "node:module";',
    "const require = createRequire(import.meta.url);",
    `const resolved = require.resolve(${JSON.stringify(targetPackage)});`,
    `const direct = require(${JSON.stringify(targetPackage)});`,
    `const meta = await import(${JSON.stringify(NATIVE_META_PACKAGE_NAME)});`,
    "console.log(JSON.stringify({ resolved, directExports: Object.keys(direct), metaExports: Object.keys(meta) }));",
  ].join("\n");
}

function rootImportSource() {
  return [
    `const root = await import(${JSON.stringify(ROOT_PACKAGE_NAME)});`,
    "console.log(JSON.stringify({ exports: Object.keys(root) }));",
  ].join("\n");
}

function detectLinuxAbi() {
  const report = process.report?.getReport();
  if (report?.header && "glibcVersionRuntime" in report.header) return "gnu";
  return "musl";
}

export function currentNativeTargetSuffix() {
  if (process.platform === "win32") {
    if (process.arch === "x64") return "win32-x64-msvc";
    if (process.arch === "arm64") return "win32-arm64-msvc";
  }
  if (process.platform === "darwin") {
    if (process.arch === "x64") return "darwin-x64";
    if (process.arch === "arm64") return "darwin-arm64";
  }
  if (process.platform === "linux") {
    const abi = detectLinuxAbi();
    if (process.arch === "x64") return `linux-x64-${abi}`;
    if (process.arch === "arm64") return `linux-arm64-${abi}`;
  }
  return null;
}

function createFixture(installDirectory) {
  const fixtureDirectory = path.join(installDirectory, "fixture");
  fs.mkdirSync(fixtureDirectory);
  fs.writeFileSync(
    path.join(fixtureDirectory, "certified.ts"),
    `export function ${SMOKE_SYMBOL}(): string { return "certified"; }\n`,
    "utf8",
  );
  return fixtureDirectory;
}

function parseToolNames(toolsResponse) {
  const result = ensurePlainRecord(toolsResponse.result, "mcp-smoke-failed", "MCP tools/list omitted result.");
  if (!Array.isArray(result.tools)) {
    throw new PackageCertificationError("mcp-smoke-failed", "MCP tools/list omitted tools.");
  }
  return result.tools
    .map((tool) => (tool && typeof tool === "object" && typeof tool.name === "string" ? tool.name : ""))
    .filter(Boolean);
}

function createMcpLineClient(child, timeoutMs) {
  const pending = new Map();
  let stdout = "";
  let stderr = "";
  let buffer = "";
  let exited = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = boundOutput(`${stdout}${chunk}`);
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
      if (message && (typeof message.id === "number" || typeof message.id === "string")) {
        const waiter = pending.get(String(message.id));
        if (waiter) {
          pending.delete(String(message.id));
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = boundOutput(`${stderr}${chunk}`);
  });
  child.on("exit", (code, signal) => {
    exited = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new PackageCertificationError("mcp-smoke-failed", "Packed MCP server exited before responding.", {
          exitCode: code,
          signal,
          stdout,
          stderr,
        }),
      );
    }
    pending.clear();
  });
  child.on("error", (error) => {
    exited = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new PackageCertificationError("mcp-smoke-failed", "Could not start packed MCP server.", {
          cause: error.message,
          stdout,
          stderr,
        }),
      );
    }
    pending.clear();
  });

  function send(message) {
    if (exited || !child.stdin.writable) {
      throw new PackageCertificationError("mcp-smoke-failed", "Packed MCP server stdin is unavailable.", {
        stdout,
        stderr,
      });
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(id, method, params) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(
          new PackageCertificationError("mcp-smoke-failed", `Packed MCP server timed out during ${method}.`, {
            method,
            stdout,
            stderr,
          }),
        );
      }, timeoutMs);
      pending.set(String(id), { resolve, reject, timer });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(String(id));
        reject(error);
      }
    });
  }

  return { request, send, output: () => ({ stdout, stderr }) };
}

async function stopPackedMcpProcess(child) {
  child.stdin.end();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.kill();
  try {
    await exited;
    return;
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return;
  }
  const forcedExit = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.kill("SIGKILL");
  try {
    await forcedExit;
  } catch {
    throw new PackageCertificationError("mcp-smoke-failed", "Packed MCP server did not terminate.");
  }
}

export async function runPackedMcpExchange({
  cliPath,
  fixtureDirectory,
  rootVersion,
  nodePath = process.execPath,
  env = process.env,
}) {
  const startedAt = performance.now();
  const child = spawn(
    nodePath,
    [cliPath, "mcp", "serve", "--root", fixtureDirectory, "--stdio", "--native", "on", "--cache", "off"],
    { cwd: fixtureDirectory, env, stdio: ["pipe", "pipe", "pipe"], shell: false },
  );
  const client = createMcpLineClient(child, MCP_TIMEOUT_MS);
  try {
    const initialize = await client.request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "codegraph-package-smoke", version: "1.0.0" },
    });
    if (initialize.error) {
      throw new PackageCertificationError("mcp-smoke-failed", "Packed MCP initialize returned an error.", {
        error: initialize.error,
      });
    }
    const initializeResult = ensurePlainRecord(
      initialize.result,
      "mcp-smoke-failed",
      "Packed MCP initialize omitted result.",
    );
    const serverInfo = ensurePlainRecord(
      initializeResult.serverInfo,
      "mcp-smoke-failed",
      "Packed MCP initialize omitted serverInfo.",
    );
    if (serverInfo.version !== rootVersion) {
      throw new PackageCertificationError("package-identity-mismatch", "Packed MCP server version is incorrect.", {
        expected: rootVersion,
        actual: serverInfo.version,
      });
    }
    client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const tools = await client.request(2, "tools/list", {});
    const toolNames = parseToolNames(tools);
    if (!toolNames.includes("search")) {
      throw new PackageCertificationError("mcp-smoke-failed", "Packed MCP server did not expose the search tool.");
    }
    const search = await client.request(3, "tools/call", {
      name: "search",
      arguments: { query: SMOKE_SYMBOL, mode: "symbol", limit: 5 },
    });
    if (search.error || !JSON.stringify(search.result).includes(SMOKE_SYMBOL)) {
      throw new PackageCertificationError("mcp-smoke-failed", "Packed MCP search did not return the known symbol.", {
        error: search.error,
      });
    }
    const output = client.output();
    return {
      exitCode: 0,
      durationMs: Math.round(performance.now() - startedAt),
      stdout: output.stdout,
      stderr: output.stderr,
      serverVersion: serverInfo.version,
      tools: toolNames,
    };
  } finally {
    await stopPackedMcpProcess(child);
  }
}

async function runRuntimeChecks({ installDirectory, target, manifest, commandRunner, mcpRunner, checks }) {
  const rootImport = await runNodeJson(
    ["--input-type=module", "--eval", rootImportSource()],
    { cwd: installDirectory },
    commandRunner,
    "runtime-import-failed",
    "Packed root package import",
  );
  checks.push(commandCheck("root-import", rootImport.result));

  const targetPackage = `@lzehrung/codegraph-native-${target}`;
  const nativeImport = await runNodeJson(
    ["--input-type=module", "--eval", runtimeImportSource(targetPackage)],
    { cwd: installDirectory },
    commandRunner,
    "native-import-failed",
    "Packed native package import",
  );
  checks.push(commandCheck("native-import", nativeImport.result));
  const nativeImportValue = ensurePlainRecord(
    nativeImport.value,
    "native-import-failed",
    "Packed native import output must be an object.",
  );
  const normalizedResolved =
    typeof nativeImportValue.resolved === "string" ? nativeImportValue.resolved.replaceAll("\\", "/") : "";
  if (!normalizedResolved.includes(targetPackage)) {
    throw new PackageCertificationError(
      "target-mismatch",
      "Packed native meta package did not resolve the expected target.",
      {
        target,
        resolved: nativeImportValue.resolved,
      },
    );
  }

  const cliPath = packedCliPath(installDirectory);
  const version = await runNodeJson(
    [cliPath, "version", "--json"],
    { cwd: installDirectory },
    commandRunner,
    "version-smoke-failed",
    "Packed codegraph version",
  );
  checks.push(commandCheck("version", version.result));
  const versionValue = ensurePlainRecord(version.value, "version-smoke-failed", "Version output must be an object.");
  if (versionValue.name !== ROOT_PACKAGE_NAME || versionValue.version !== manifest.rootVersion) {
    throw new PackageCertificationError("package-identity-mismatch", "Packed codegraph version output is incorrect.", {
      expectedName: ROOT_PACKAGE_NAME,
      expectedVersion: manifest.rootVersion,
      actualName: versionValue.name,
      actualVersion: versionValue.version,
    });
  }

  const doctor = await runNodeJson(
    [cliPath, "doctor", "--json"],
    { cwd: installDirectory },
    commandRunner,
    "doctor-smoke-failed",
    "Packed codegraph doctor",
  );
  checks.push(commandCheck("doctor", doctor.result));
  const doctorValue = ensurePlainRecord(doctor.value, "doctor-smoke-failed", "Doctor output must be an object.");
  const native = ensurePlainRecord(doctorValue.native, "doctor-smoke-failed", "Doctor output omitted native state.");
  const origin = ensurePlainRecord(native.origin, "doctor-smoke-failed", "Doctor output omitted native origin.");
  if (!native.available || origin.target !== target || origin.packageName !== targetPackage) {
    throw new PackageCertificationError(
      "target-mismatch",
      "Doctor did not report the expected native package target.",
      {
        target,
        available: native.available,
        origin,
      },
    );
  }

  const fixtureDirectory = createFixture(installDirectory);
  const search = await runNodeJson(
    [
      cliPath,
      "search",
      SMOKE_SYMBOL,
      "--root",
      fixtureDirectory,
      "--mode",
      "symbol",
      "--native",
      "on",
      "--cache",
      "off",
      "--json",
    ],
    { cwd: installDirectory, timeoutMs: 180_000 },
    commandRunner,
    "native-parse-failed",
    "Packed native symbol search",
  );
  checks.push(commandCheck("native-parse", search.result));
  if (!JSON.stringify(search.value).includes(SMOKE_SYMBOL)) {
    throw new PackageCertificationError("native-parse-failed", "Packed native search did not return the known symbol.");
  }

  const mcp = await mcpRunner({ cliPath, fixtureDirectory, rootVersion: manifest.rootVersion });
  checks.push({
    name: "mcp-stdio",
    status: "pass",
    exitCode: mcp.exitCode,
    durationMs: mcp.durationMs,
    stdout: boundOutput(mcp.stdout),
    stderr: boundOutput(mcp.stderr),
  });
  return nativeImportValue.resolved;
}

async function runReducedChecks({ installDirectory, manifest, commandRunner, checks }) {
  const rootImport = await runNodeJson(
    ["--input-type=module", "--eval", rootImportSource()],
    { cwd: installDirectory, env: { ...process.env, CODEGRAPH_DISABLE_NATIVE: "1" } },
    commandRunner,
    "runtime-import-failed",
    "Reduced root package import",
  );
  checks.push(commandCheck("root-import", rootImport.result));

  const cliPath = packedCliPath(installDirectory);
  const version = await runNodeJson(
    [cliPath, "version", "--json"],
    { cwd: installDirectory, env: { ...process.env, CODEGRAPH_DISABLE_NATIVE: "1" } },
    commandRunner,
    "version-smoke-failed",
    "Reduced codegraph version",
  );
  checks.push(commandCheck("version", version.result));
  const versionValue = ensurePlainRecord(version.value, "version-smoke-failed", "Version output must be an object.");
  if (versionValue.version !== manifest.rootVersion) {
    throw new PackageCertificationError("package-identity-mismatch", "Reduced package version output is incorrect.");
  }

  const doctor = await runNodeJson(
    [cliPath, "doctor", "--json"],
    { cwd: installDirectory, env: { ...process.env, CODEGRAPH_DISABLE_NATIVE: "1" } },
    commandRunner,
    "doctor-smoke-failed",
    "Reduced codegraph doctor",
  );
  checks.push(commandCheck("doctor", doctor.result));
  const doctorValue = ensurePlainRecord(doctor.value, "doctor-smoke-failed", "Doctor output must be an object.");
  const native = ensurePlainRecord(doctorValue.native, "doctor-smoke-failed", "Doctor output omitted native state.");
  if (native.available) {
    throw new PackageCertificationError(
      "reduced-mode-failed",
      "Reduced package smoke unexpectedly loaded native code.",
    );
  }

  const fixtureDirectory = createFixture(installDirectory);
  const search = await runNodeJson(
    [
      cliPath,
      "search",
      SMOKE_SYMBOL,
      "--root",
      fixtureDirectory,
      "--mode",
      "text",
      "--native",
      "off",
      "--cache",
      "off",
      "--json",
    ],
    { cwd: installDirectory, env: { ...process.env, CODEGRAPH_DISABLE_NATIVE: "1" } },
    commandRunner,
    "reduced-mode-failed",
    "Reduced package search",
  );
  checks.push(commandCheck("reduced-search", search.result));
  if (!JSON.stringify(search.value).includes(SMOKE_SYMBOL)) {
    throw new PackageCertificationError("reduced-mode-failed", "Reduced package search did not return the known text.");
  }
}

function reportBase({ manifest, manifestSha256, mode, target }) {
  return {
    schemaVersion: PACKAGE_SMOKE_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    manifestSha256,
    sourceRevision: manifest.sourceRevision,
    rootVersion: manifest.rootVersion,
    nativeVersion: manifest.nativeVersion,
    target: target ?? null,
    mode,
    certificationClass: mode,
  };
}

export async function runPackageSmoke(options) {
  const manifestPath = path.resolve(options.manifestPath);
  const manifestDirectory = path.dirname(manifestPath);
  const expectedTargets = options.expectedTargets;
  const manifest = await readReleaseCandidateManifest(manifestPath, { verifyFiles: true, expectedTargets });
  const manifestSha256 = await computeFileSha256(manifestPath);
  const mode = options.mode;
  const target = options.target ?? null;
  const commandRunner = options.commandRunner ?? runPackageCommand;
  const mcpRunner = options.mcpRunner ?? runPackedMcpExchange;
  const checks = [manualCheck("candidate-checksums")];

  if (!["runtime", "structural", "reduced"].includes(mode)) {
    throw new PackageCertificationError("mode-invalid", `Unsupported package smoke mode ${String(mode)}.`);
  }
  if (mode === "reduced" && target !== null) {
    throw new PackageCertificationError("target-mismatch", "Reduced package smoke must not declare a native target.");
  }
  if (mode !== "reduced" && target === null) {
    throw new PackageCertificationError("target-mismatch", `${mode} package smoke requires a native target.`);
  }

  let selection;
  let entries;
  if (mode === "reduced") {
    selection = selectReducedReleaseCandidatePackage(manifest);
    entries = [selection.core, selection.root];
  } else {
    const metadata = getNativeTargetMetadata(target);
    if (metadata.certificationClass !== mode) {
      throw new PackageCertificationError(
        "certification-class-mismatch",
        `Target ${target} is ${metadata.certificationClass}, not ${mode}.`,
        { target, expected: metadata.certificationClass, actual: mode },
      );
    }
    if (mode === "structural" && !options.structuralException) {
      throw new PackageCertificationError(
        "exception-incomplete",
        `Structural target ${target} requires an active reviewed exception.`,
        { target },
      );
    }
    if (mode === "runtime") {
      const runtimeTarget = options.runtimeTarget ?? currentNativeTargetSuffix();
      if (runtimeTarget !== target) {
        throw new PackageCertificationError("target-mismatch", `Runtime host does not match target ${target}.`, {
          target,
          runtimeTarget,
        });
      }
    }
    selection = selectReleaseCandidatePackages(manifest, target);
    entries = [selection.nativeTarget, selection.native, selection.core, selection.root];
  }

  const packageIdentities = [];
  const archiveFiles = new Map();
  for (const entry of entries) {
    const inspected = await inspectPackageTarball({ manifest, entry, manifestDirectory, commandRunner });
    checks.push(commandCheck(`archive:${entry.package}`, inspected.result));
    packageIdentities.push(inspected.identity);
    archiveFiles.set(entry.package, inspected.files);
  }

  if (mode === "structural") {
    return {
      ...reportBase({ manifest, manifestSha256, mode, target }),
      status: "pass",
      checks,
      packageIdentities,
      structuralException: options.structuralException,
    };
  }

  const install = createInstallDirectory({
    installDirectory: options.installDirectory,
    checkoutDirectory: options.checkoutDirectory ?? process.cwd(),
  });
  let selectedNativePath;
  try {
    const installResult = await installPackages({
      entries,
      manifestDirectory,
      installDirectory: install.installDirectory,
      reduced: mode === "reduced",
      commandRunner,
    });
    checks.push(commandCheck("install", installResult));

    for (const entry of entries) {
      const identity = readInstalledIdentity(install.installDirectory, entry, expectedVersionForEntry(manifest, entry));
      const expected = archiveFiles.get(entry.package);
      if (!expected) {
        throw new PackageCertificationError("archive-invalid", `Missing inspected files for ${entry.package}.`);
      }
      const verification = await verifyInstalledPackageBytes({
        installDirectory: install.installDirectory,
        entry,
        expected,
      });
      checks.push(manualCheck(`installed-bytes:${entry.package}`, verification));
      const packageIdentity = packageIdentities.find((candidate) => candidate.package === entry.package);
      if (packageIdentity) packageIdentity.installedPath = identity.packageDirectory;
    }

    if (mode === "runtime") {
      selectedNativePath = await runRuntimeChecks({
        installDirectory: install.installDirectory,
        target,
        manifest,
        commandRunner,
        mcpRunner,
        checks,
      });
    } else {
      await runReducedChecks({ installDirectory: install.installDirectory, manifest, commandRunner, checks });
    }

    return {
      ...reportBase({ manifest, manifestSha256, mode, target }),
      status: "pass",
      checks,
      packageIdentities,
      installDirectory: install.installDirectory,
      ...(selectedNativePath ? { selectedNativePath } : {}),
    };
  } finally {
    if (install.removeAfter) fs.rmSync(install.installDirectory, { recursive: true, force: true });
  }
}

export function packageSmokeFailureReport({ error, manifest, manifestSha256, mode, target, checks = [] }) {
  const failure = {
    code: error instanceof PackageCertificationError ? error.code : "package-smoke-failed",
    message: error instanceof Error ? error.message : String(error),
    context: error instanceof PackageCertificationError ? error.context : {},
  };
  return {
    schemaVersion: PACKAGE_SMOKE_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    manifestSha256: manifestSha256 ?? "unavailable",
    sourceRevision: manifest?.sourceRevision ?? "unavailable",
    rootVersion: manifest?.rootVersion ?? "0.0.0",
    nativeVersion: manifest?.nativeVersion ?? "0.0.0",
    target: target ?? null,
    mode,
    certificationClass: mode,
    status: "fail",
    checks,
    packageIdentities: [],
    failure,
  };
}
