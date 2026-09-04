import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const defaultRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function getBundlePaths(rootDir = defaultRootDir) {
  return {
    rootDir,
    entryPoint: path.join(rootDir, "dist", "cliBootstrap.js"),
    workerEntryPoint: path.join(rootDir, "dist", "agent", "query-index", "queryIndexWorker.js"),
    rawQueryWorkerEntryPoint: path.join(rootDir, "dist", "sqlite", "rawQueryWorker.js"),
    unbundledCli: path.join(rootDir, "dist", "cli.js"),
    outdir: path.join(rootDir, "dist", "bin"),
    bundledEntry: path.join(rootDir, "dist", "bin", "cli.js"),
    bundledWorker: path.join(rootDir, "dist", "bin", "queryIndexWorker.js"),
    bundledRawQueryWorker: path.join(rootDir, "dist", "bin", "rawQueryWorker.js"),
  };
}

function createRequireBanner() {
  // Some transitive CJS deps still emit bare require("os")-style calls. Provide a
  // real CommonJS require via createRequire so those survive an ESM bundle.
  return [
    "import { createRequire as __codegraphCreateRequire } from 'node:module';",
    "const require = __codegraphCreateRequire(import.meta.url);",
    "",
  ].join("\n");
}

export async function bundleCli({ rootDir = defaultRootDir, logLevel = "warning" } = {}) {
  const paths = getBundlePaths(rootDir);
  if (!fs.existsSync(paths.entryPoint)) {
    throw new Error(`Missing CLI build input: ${paths.entryPoint}. Run tsc before bundling.`);
  }
  if (!fs.existsSync(paths.workerEntryPoint)) {
    throw new Error(`Missing query worker build input: ${paths.workerEntryPoint}. Run tsc before bundling.`);
  }
  if (!fs.existsSync(paths.rawQueryWorkerEntryPoint)) {
    throw new Error(
      `Missing raw SQLite worker build input: ${paths.rawQueryWorkerEntryPoint}. Run tsc before bundling.`,
    );
  }

  fs.rmSync(paths.outdir, { recursive: true, force: true });
  fs.mkdirSync(paths.outdir, { recursive: true });

  const result = await esbuild.build({
    entryPoints: {
      cli: paths.entryPoint,
      queryIndexWorker: paths.workerEntryPoint,
      rawQueryWorker: paths.rawQueryWorkerEntryPoint,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    splitting: false,
    outdir: paths.outdir,
    entryNames: "[name]",
    // Keep piscina external: its constructor does resolve(__dirname, "worker.js"), and an
    // import.meta.url banner __dirname would point at dist/bin where that sibling file is not
    // shipped. Leaving the package on disk (as with jsonc-parser) preserves real CJS __dirname.
    external: ["node:*", "@lzehrung/codegraph-native", "jsonc-parser", "piscina"],
    banner: {
      js: createRequireBanner(),
    },
    logLevel,
    write: true,
    metafile: true,
  });

  const outputFiles = Object.keys(result.metafile.outputs).sort();
  const selfContainedEntries = new Set([paths.bundledEntry, paths.bundledWorker, paths.bundledRawQueryWorker]);
  const unexpectedOutputs = outputFiles.filter((file) => !selfContainedEntries.has(path.resolve(file)));
  if (unexpectedOutputs.length) {
    throw new Error(
      `CLI bundle emitted non-entry chunks that can break long-lived MCP processes during upgrades: ${unexpectedOutputs.join(", ")}`,
    );
  }

  if (!fs.existsSync(paths.bundledEntry)) {
    throw new Error(`Bundled CLI entry was not written to ${paths.bundledEntry}`);
  }
  if (!fs.existsSync(paths.bundledWorker)) {
    throw new Error(`Bundled query worker was not written to ${paths.bundledWorker}`);
  }
  if (!fs.existsSync(paths.bundledRawQueryWorker)) {
    throw new Error(`Bundled raw SQLite worker was not written to ${paths.bundledRawQueryWorker}`);
  }

  return {
    ...paths,
    outputFiles,
    metafile: result.metafile,
  };
}

function runNode(entry, args, { cwd = defaultRootDir, env = process.env } = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

export async function verifyBundledCli({ rootDir = defaultRootDir } = {}) {
  const { bundledEntry, unbundledCli } = getBundlePaths(rootDir);
  if (!fs.existsSync(bundledEntry)) {
    throw new Error(`Bundled CLI entry missing: ${bundledEntry}`);
  }

  const version = runNode(bundledEntry, ["--version"], { cwd: rootDir });
  if (version.status !== 0) {
    throw new Error(`Bundled --version failed:\n${version.stderr || version.stdout}`);
  }

  const unbundledVersion = runNode(unbundledCli, ["--version"], { cwd: rootDir });
  if (unbundledVersion.status !== 0) {
    throw new Error(`Unbundled --version failed:\n${unbundledVersion.stderr || unbundledVersion.stdout}`);
  }
  if (version.stdout !== unbundledVersion.stdout) {
    throw new Error(
      `Bundled --version output differed from unbundled.\nBundled: ${JSON.stringify(version.stdout)}\nUnbundled: ${JSON.stringify(unbundledVersion.stdout)}`,
    );
  }

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-bundle-smoke-"));
  try {
    fs.writeFileSync(path.join(fixtureRoot, "package.json"), JSON.stringify({ name: "bundle-smoke", type: "module" }));
    fs.mkdirSync(path.join(fixtureRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, "src", "index.ts"), "export const value = 1;\n");

    const bundledOrient = runNode(bundledEntry, ["orient", "--root", fixtureRoot, "--budget", "small", "--json"], {
      cwd: rootDir,
    });
    if (bundledOrient.status !== 0) {
      throw new Error(`Bundled orient smoke failed:\n${bundledOrient.stderr || bundledOrient.stdout}`);
    }

    const unbundledOrient = runNode(unbundledCli, ["orient", "--root", fixtureRoot, "--budget", "small", "--json"], {
      cwd: rootDir,
    });
    if (unbundledOrient.status !== 0) {
      throw new Error(`Unbundled orient smoke failed:\n${unbundledOrient.stderr || unbundledOrient.stdout}`);
    }
    if (bundledOrient.stdout !== unbundledOrient.stdout) {
      throw new Error("Bundled orient --json output differed from unbundled for the smoke fixture.");
    }

    const installEnv = {
      ...process.env,
      HOME: fixtureRoot,
      USERPROFILE: fixtureRoot,
      XDG_CONFIG_HOME: path.join(fixtureRoot, ".config"),
    };
    const bundledInstall = runNode(bundledEntry, ["install", "--target", "cursor", "--dry-run", "--json"], {
      cwd: rootDir,
      env: installEnv,
    });
    if (bundledInstall.status !== 0) {
      throw new Error(`Bundled install smoke failed:\n${bundledInstall.stderr || bundledInstall.stdout}`);
    }
    const installResult = JSON.parse(bundledInstall.stdout);
    if (!installResult.dryRun || !installResult.targets?.includes("cursor")) {
      throw new Error("Bundled install smoke returned an invalid dry-run result.");
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  return {
    version: version.stdout.trim(),
    bundledEntry: pathToFileURL(bundledEntry).href,
  };
}
