import {
  PackageCertificationError,
  assertReleaseCandidateIdentity,
  readNativeTargetExceptions,
  readReleaseCandidateManifest,
  releaseCandidatePublicationOrder,
} from "./package-contract-lib.mjs";
import { expectedVersionForEntry, runPackageCommand } from "./package-smoke-lib.mjs";
import { getSupportedNativeTargetSuffixes, readJsonFile } from "../native-targets-lib.mjs";
import path from "node:path";

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";

/**
 * Checks whether a package is already published on the registry at an exact version. This is
 * the resumability primitive: the immutable release candidate manifest (built once and reused
 * across every publish attempt) plus this per-package registry check make re-running the publish
 * step after a partial failure safe, because npm rejects overwriting an already-published exact
 * version anyway.
 */
/**
 * Injection seams for tests. Each is the minimal shape this module uses, so a test
 * double does not have to reproduce the full runPackageCommand result. The log
 * defaults are no-ops, which would otherwise infer a zero-argument signature.
 * `error` is present only when the spawn itself failed; runPackageCommand carries the
 * message through, and publishReleaseCandidateEntry both branches on it and reports it.
 * @typedef {{ exitCode: number | null, rawStdout: string, stdout: string, stderr: string,
 *   error?: string }} PackageCommandResult
 * @typedef {(command: string, args: string[], options?: unknown) => PackageCommandResult} CommandRunner
 * @typedef {(line: string) => void} LineLogger
 */

/** @param {{ packageName: string, version: string, registry: string, commandRunner?: CommandRunner }} options */
export function isPackageVersionPublished({ packageName, version, registry, commandRunner = runPackageCommand }) {
  const result = commandRunner("npm", ["view", `${packageName}@${version}`, "version", `--registry=${registry}`], {
    timeoutMs: 60_000,
  });
  return result.exitCode === 0 && result.rawStdout.trim() === version;
}

/** @param {{ entry: unknown, registry: string, rootDirectory: string, commandRunner?: CommandRunner }} options */
export function publishReleaseCandidateEntry({ entry, registry, rootDirectory, commandRunner = runPackageCommand }) {
  const result = commandRunner(
    "npm",
    ["publish", entry.absolutePath, "--ignore-scripts", "--access=public", `--registry=${registry}`],
    { cwd: rootDirectory, timeoutMs: 300_000 },
  );
  if (result.exitCode !== 0 || result.error) {
    throw new PackageCertificationError("publish-failed", `Publishing certified tarball failed for ${entry.package}.`, {
      package: entry.package,
      file: entry.file,
      exitCode: result.exitCode,
      error: result.error,
    });
  }
  return result;
}

/**
 * Publishes every package in `publicationOrder`, skipping packages already published at the
 * exact planned version. Safe to call repeatedly against the same immutable manifest: a prior
 * partial failure leaves already-published packages in the registry, and this function skips
 * them on the next call instead of failing on a duplicate-version publish.
 */
/**
 * @param {{ manifest: unknown, publicationOrder: unknown[], registry: string, rootDirectory: string,
 *   commandRunner?: CommandRunner, log?: LineLogger, logError?: LineLogger }} options
 */
export function publishReleaseCandidates({
  manifest,
  publicationOrder,
  registry,
  rootDirectory,
  commandRunner = runPackageCommand,
  log = () => {},
  logError = () => {},
}) {
  const published = [];
  const skipped = [];
  for (const entry of publicationOrder) {
    const version = expectedVersionForEntry(manifest, entry);
    if (isPackageVersionPublished({ packageName: entry.package, version, registry, commandRunner })) {
      skipped.push({ package: entry.package, version });
      log(`Skipping ${entry.package}@${version}: already published at this exact version.`);
      continue;
    }
    const result = publishReleaseCandidateEntry({ entry, registry, rootDirectory, commandRunner });
    if (result.stdout) log(result.stdout);
    if (result.stderr) logError(result.stderr);
    published.push({ package: entry.package, version });
  }
  return { published, skipped };
}

export async function preparePublicationOrder({ manifestPath, registry, expectedIdentity, exceptionsPath }) {
  const rootDirectory = process.cwd();
  const nativePackage = readJsonFile(path.join(rootDirectory, "packages", "codegraph-native", "package.json"));
  const expectedTargets = getSupportedNativeTargetSuffixes(nativePackage);
  await readNativeTargetExceptions(
    exceptionsPath ?? path.join(rootDirectory, "scripts", "certification", "native-target-exceptions.json"),
  );

  // Complete every read-only preflight before the first registry write.
  const manifest = await readReleaseCandidateManifest(manifestPath, { verifyFiles: true, expectedTargets });
  assertReleaseCandidateIdentity(manifest, expectedIdentity);
  const publicationOrder = releaseCandidatePublicationOrder(manifest).map((entry) => ({
    ...entry,
    absolutePath: path.resolve(path.dirname(manifestPath), entry.file),
  }));
  return { manifest, publicationOrder, rootDirectory, registry };
}
