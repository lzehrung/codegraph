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
    entryPoint: path.join(rootDir, "dist", "cli.js"),
    outdir: path.join(rootDir, "dist", "bin"),
    bundledEntry: path.join(rootDir, "dist", "bin", "cli.js"),
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

  fs.rmSync(paths.outdir, { recursive: true, force: true });
  fs.mkdirSync(paths.outdir, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [paths.entryPoint],
    bundle: true,
    platform: "node",
    format: "esm",
    splitting: true,
    outdir: paths.outdir,
    external: ["node:*", "@lzehrung/codegraph-native"],
    banner: {
      js: createRequireBanner(),
    },
    logLevel,
    write: true,
    metafile: true,
  });

  if (!fs.existsSync(paths.bundledEntry)) {
    throw new Error(`Bundled CLI entry was not written to ${paths.bundledEntry}`);
  }

  return {
    ...paths,
    outputFiles: Object.keys(result.metafile.outputs).sort(),
    metafile: result.metafile,
  };
}

function runNode(entry, args, { cwd = defaultRootDir } = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

export async function verifyBundledCli({ rootDir = defaultRootDir } = {}) {
  const { bundledEntry, entryPoint } = getBundlePaths(rootDir);
  if (!fs.existsSync(bundledEntry)) {
    throw new Error(`Bundled CLI entry missing: ${bundledEntry}`);
  }

  const version = runNode(bundledEntry, ["--version"], { cwd: rootDir });
  if (version.status !== 0) {
    throw new Error(`Bundled --version failed:\n${version.stderr || version.stdout}`);
  }

  const unbundledVersion = runNode(entryPoint, ["--version"], { cwd: rootDir });
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

    const bundledOrient = runNode(
      bundledEntry,
      ["orient", "--root", fixtureRoot, "--budget", "small", "--json"],
      { cwd: rootDir },
    );
    if (bundledOrient.status !== 0) {
      throw new Error(`Bundled orient smoke failed:\n${bundledOrient.stderr || bundledOrient.stdout}`);
    }

    const unbundledOrient = runNode(
      entryPoint,
      ["orient", "--root", fixtureRoot, "--budget", "small", "--json"],
      { cwd: rootDir },
    );
    if (unbundledOrient.status !== 0) {
      throw new Error(`Unbundled orient smoke failed:\n${unbundledOrient.stderr || unbundledOrient.stdout}`);
    }
    if (bundledOrient.stdout !== unbundledOrient.stdout) {
      throw new Error("Bundled orient --json output differed from unbundled for the smoke fixture.");
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  return {
    version: version.stdout.trim(),
    bundledEntry: pathToFileURL(bundledEntry).href,
  };
}
