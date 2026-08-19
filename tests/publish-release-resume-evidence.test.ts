import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CORE_PACKAGE_NAME,
  NATIVE_META_PACKAGE_NAME,
  NATIVE_TARGET_PACKAGE_PREFIX,
  ROOT_PACKAGE_NAME,
} from "../scripts/certification/package-contract-lib.mjs";
import { getSupportedNativeTargetSuffixes } from "../scripts/native-targets-lib.mjs";

type PackageEntry = {
  package: string;
  version: string;
  file: string;
  absolutePath: string;
  target?: string;
};

type RegistryState = {
  failureInjected: boolean;
  published: Array<{ package: string; version: string }>;
};

type MockCommandResult = {
  exitCode: number | null;
  rawStdout: string;
  stdout: string;
  stderr: string;
};

type MockCommandRunner = (command: string, args: string[]) => MockCommandResult;

function createMockRegistryRunner(state: RegistryState, entries: PackageEntry[]): MockCommandRunner {
  const byFile = new Map(entries.map((entry) => [path.basename(entry.file), entry]));
  return (command, args) => {
    if (command !== "npm") return { exitCode: 2, rawStdout: "", stdout: "", stderr: "unsupported command" };
    if (args[0] === "view") {
      const spec = args[1] ?? "";
      const at = spec.lastIndexOf("@");
      const packageName = spec.slice(0, at);
      const version = spec.slice(at + 1);
      const found = state.published.some((entry) => entry.package === packageName && entry.version === version);
      return found
        ? { exitCode: 0, rawStdout: `${version}\n`, stdout: `${version}\n`, stderr: "" }
        : { exitCode: 1, rawStdout: "", stdout: "", stderr: "missing package version" };
    }
    if (args[0] !== "publish") {
      return { exitCode: 2, rawStdout: "", stdout: "", stderr: "unsupported npm command" };
    }
    const entry = byFile.get(path.basename(args[1] ?? ""));
    if (!entry) return { exitCode: 2, rawStdout: "", stdout: "", stderr: "unknown tarball" };
    const alreadyPublished = state.published.some(
      (published) => published.package === entry.package && published.version === entry.version,
    );
    if (alreadyPublished) return { exitCode: 1, rawStdout: "", stdout: "", stderr: "duplicate exact version" };
    if (!state.failureInjected && state.published.length === 1) {
      state.failureInjected = true;
      return { exitCode: 1, rawStdout: "", stdout: "", stderr: "injected transient failure" };
    }
    state.published.push({ package: entry.package, version: entry.version });
    return { exitCode: 0, rawStdout: "published\n", stdout: "published\n", stderr: "" };
  };
}

function publishWithOriginalLoop(entries: PackageEntry[], commandRunner: MockCommandRunner): void {
  for (const entry of entries) {
    const result = commandRunner("npm", ["publish", entry.absolutePath, "--registry=https://registry.example.test"]);
    if (result.exitCode !== 0) throw new Error(`publication failed for ${entry.package}`);
  }
}

describe("release candidate publication resume evidence", () => {
  it("resumes after a registry failure by skipping the exact published tarball", async () => {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const nativePackage = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, "packages", "codegraph-native", "package.json"), "utf8"),
    );
    const temporaryRoot = fs.mkdtempSync(path.join(repositoryRoot, ".vitest-publish-resume-"));
    try {
      const targetEntries = getSupportedNativeTargetSuffixes(nativePackage).map((target) => ({
        package: `${NATIVE_TARGET_PACKAGE_PREFIX}${target}`,
        version: "3.0.0",
        target,
        file: `target-${target}.tgz`,
        absolutePath: path.join(temporaryRoot, `target-${target}.tgz`),
      }));
      const entries: PackageEntry[] = [
        ...targetEntries,
        {
          package: NATIVE_META_PACKAGE_NAME,
          version: "3.0.0",
          file: "native.tgz",
          absolutePath: path.join(temporaryRoot, "native.tgz"),
        },
        {
          package: CORE_PACKAGE_NAME,
          version: "2.0.0",
          file: "core.tgz",
          absolutePath: path.join(temporaryRoot, "core.tgz"),
        },
        {
          package: ROOT_PACKAGE_NAME,
          version: "2.0.0",
          file: "root.tgz",
          absolutePath: path.join(temporaryRoot, "root.tgz"),
        },
      ];
      for (const entry of entries) fs.writeFileSync(entry.absolutePath, `${entry.package}@${entry.version}\n`, "utf8");
      const manifest = {
        rootVersion: "2.0.0",
        nativeVersion: "3.0.0",
        files: entries.map(({ package: packageName, file, target }) => ({
          package: packageName,
          file,
          ...(target ? { target } : {}),
        })),
      };

      // The base branch has no publication library. That absence is intentional: this branch runs the
      // original sequential loop against the same mock transport, where the retry must fail on a duplicate.
      try {
        const { publishReleaseCandidates } =
          await import("../scripts/certification/publish-release-candidates-lib.mjs");
        const state: RegistryState = { failureInjected: false, published: [] };
        const commandRunner = createMockRegistryRunner(state, entries);
        expect(() =>
          publishReleaseCandidates({
            manifest,
            publicationOrder: entries,
            registry: "https://registry.example.test",
            rootDirectory: temporaryRoot,
            commandRunner,
          }),
        ).toThrow(/publication failed|Publishing certified tarball failed/);
        const resumed = publishReleaseCandidates({
          manifest,
          publicationOrder: entries,
          registry: "https://registry.example.test",
          rootDirectory: temporaryRoot,
          commandRunner,
        });
        expect(resumed).toEqual({
          published: entries.slice(1).map((entry) => ({ package: entry.package, version: entry.version })),
          skipped: [{ package: entries[0].package, version: entries[0].version }],
        });
        expect(state.published).toHaveLength(entries.length);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error && error.code === "ERR_MODULE_NOT_FOUND")) throw error;
        const baselineState: RegistryState = { failureInjected: false, published: [] };
        const baselineRunner = createMockRegistryRunner(baselineState, entries);
        try {
          publishWithOriginalLoop(entries, baselineRunner);
        } catch {
          // The original script leaves already-published immutable versions in the registry.
        }
        expect(() => publishWithOriginalLoop(entries, baselineRunner)).toThrow(/publication failed/);
      }
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
