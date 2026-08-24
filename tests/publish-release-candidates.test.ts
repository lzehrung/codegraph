import { describe, expect, it, vi } from "vitest";
import {
  CORE_PACKAGE_NAME,
  NATIVE_META_PACKAGE_NAME,
  NATIVE_TARGET_PACKAGE_PREFIX,
  ROOT_PACKAGE_NAME,
} from "../scripts/certification/package-contract-lib.mjs";
import {
  isPackageVersionPublished,
  publishReleaseCandidateEntry,
  publishReleaseCandidates,
} from "../scripts/certification/publish-release-candidates-lib.mjs";

const REGISTRY = "https://registry.npmjs.org";
const NATIVE_TARGET_PACKAGE = `${NATIVE_TARGET_PACKAGE_PREFIX}win32-x64-msvc`;

function manifest() {
  return { rootVersion: "2.2.0", nativeVersion: "2.2.0" };
}

function publicationOrder() {
  return [
    { package: NATIVE_TARGET_PACKAGE, target: "win32-x64-msvc", file: "packages/a.tgz", absolutePath: "/rc/a.tgz" },
    { package: NATIVE_META_PACKAGE_NAME, file: "packages/native.tgz", absolutePath: "/rc/native.tgz" },
    { package: CORE_PACKAGE_NAME, file: "packages/core.tgz", absolutePath: "/rc/core.tgz" },
    { package: ROOT_PACKAGE_NAME, file: "packages/root.tgz", absolutePath: "/rc/root.tgz" },
  ];
}

/** Simulates a real npm registry that only knows about already-published package/version pairs. */
type FakeCommandResult = { exitCode: number | null; rawStdout: string; stdout: string; stderr: string };

function fakeRegistryRunner(
  publishedVersions: Map<string, string>,
  publishBehavior: (absolutePath: string) => FakeCommandResult,
) {
  return vi.fn((command: string, args: string[]) => {
    if (args[0] === "view") {
      const [, name, version] = /^(.+)@([^@]+)$/.exec(args[1]) ?? [];
      const publishedVersion = name ? publishedVersions.get(name) : undefined;
      if (publishedVersion && publishedVersion === version) {
        return { exitCode: 0, rawStdout: `${version}\n`, stdout: `${version}\n`, stderr: "" };
      }
      return { exitCode: 1, rawStdout: "", stdout: "", stderr: "npm error 404 Not Found" };
    }
    if (args[0] === "publish") {
      return publishBehavior(args[1]);
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  });
}

describe("publishReleaseCandidates resumability", () => {
  it("skips a package already published at the exact planned version", () => {
    const commandRunner = fakeRegistryRunner(new Map([[NATIVE_TARGET_PACKAGE, "2.2.0"]]), () => ({
      exitCode: 0,
      rawStdout: "",
      stdout: "+ published",
      stderr: "",
    }));

    const { published, skipped } = publishReleaseCandidates({
      manifest: manifest(),
      publicationOrder: publicationOrder(),
      registry: REGISTRY,
      rootDirectory: "/rc",
      commandRunner,
    });

    expect(skipped).toEqual([{ package: NATIVE_TARGET_PACKAGE, version: "2.2.0" }]);
    expect(published.map((entry) => entry.package)).toEqual([
      NATIVE_META_PACKAGE_NAME,
      CORE_PACKAGE_NAME,
      ROOT_PACKAGE_NAME,
    ]);
    // Only the three not-yet-published packages should reach `npm publish`.
    const publishCalls = commandRunner.mock.calls.filter((call) => call[1][0] === "publish");
    expect(publishCalls).toHaveLength(3);
  });

  it("routes publish stderr to the error logger", () => {
    const commandRunner = fakeRegistryRunner(new Map(), () => ({
      exitCode: 0,
      rawStdout: "published\n",
      stdout: "published\n",
      stderr: "npm notice: published with a warning\n",
    }));
    const output: string[] = [];
    const errors: string[] = [];

    publishReleaseCandidates({
      manifest: manifest(),
      publicationOrder: publicationOrder().slice(0, 1),
      registry: REGISTRY,
      rootDirectory: "/rc",
      commandRunner,
      log: (line: string) => output.push(line),
      logError: (line: string) => errors.push(line),
    });

    expect(output).toEqual(["published\n"]);
    expect(errors).toEqual(["npm notice: published with a warning\n"]);
  });

  it("stops and throws after an injected publish failure, leaving later packages unattempted", () => {
    const commandRunner = fakeRegistryRunner(new Map(), (packageAbsolutePath: string) => {
      if (packageAbsolutePath === "/rc/native.tgz") {
        return { exitCode: 1, rawStdout: "", stdout: "", stderr: "npm error 403 Forbidden" };
      }
      return { exitCode: 0, rawStdout: "+ published", stdout: "+ published", stderr: "" };
    });

    expect(() =>
      publishReleaseCandidates({
        manifest: manifest(),
        publicationOrder: publicationOrder(),
        registry: REGISTRY,
        rootDirectory: "/rc",
        commandRunner,
      }),
    ).toThrow(/Publishing certified tarball failed/);

    const publishCalls = commandRunner.mock.calls.filter((call) => call[1][0] === "publish");
    // The native-target package (order[0]) succeeded, then native.tgz (order[1]) failed and
    // publication stopped: core.tgz and root.tgz must never have been attempted.
    expect(publishCalls).toHaveLength(2);
  });

  it("resumes after a partial failure by skipping every already-published package and finishing the rest", () => {
    // First attempt: native target publishes, then the native meta package fails.
    const firstRunner = fakeRegistryRunner(new Map(), (absolutePath: string) =>
      absolutePath === "/rc/native.tgz"
        ? { exitCode: 1, rawStdout: "", stdout: "", stderr: "npm error 403 Forbidden" }
        : { exitCode: 0, rawStdout: "+ published", stdout: "+ published", stderr: "" },
    );
    expect(() =>
      publishReleaseCandidates({
        manifest: manifest(),
        publicationOrder: publicationOrder(),
        registry: REGISTRY,
        rootDirectory: "/rc",
        commandRunner: firstRunner,
      }),
    ).toThrow();

    // Resume: the registry now reports the native-target package as published (it landed before
    // the failure); everything else still needs to publish. The same manifest/order is reused,
    // exactly as a re-run of the workflow job would do against the immutable release candidates.
    const secondRunner = fakeRegistryRunner(new Map([[NATIVE_TARGET_PACKAGE, "2.2.0"]]), () => ({
      exitCode: 0,
      rawStdout: "",
      stdout: "+ published",
      stderr: "",
    }));
    const { published, skipped } = publishReleaseCandidates({
      manifest: manifest(),
      publicationOrder: publicationOrder(),
      registry: REGISTRY,
      rootDirectory: "/rc",
      commandRunner: secondRunner,
    });

    expect(skipped).toEqual([{ package: NATIVE_TARGET_PACKAGE, version: "2.2.0" }]);
    expect(published.map((entry) => entry.package)).toEqual([
      NATIVE_META_PACKAGE_NAME,
      CORE_PACKAGE_NAME,
      ROOT_PACKAGE_NAME,
    ]);
    const secondPublishCalls = secondRunner.mock.calls.filter((call) => call[1][0] === "publish");
    // The native-target package must never be republished on resume.
    expect(secondPublishCalls.map((call) => call[1][1])).not.toContain("/rc/a.tgz");
    expect(secondPublishCalls).toHaveLength(3);
  });

  it("reports registry membership through isPackageVersionPublished", () => {
    const commandRunner = vi.fn().mockReturnValue({ exitCode: 0, rawStdout: "2.2.0\n" });
    expect(
      isPackageVersionPublished({
        packageName: ROOT_PACKAGE_NAME,
        version: "2.2.0",
        registry: REGISTRY,
        commandRunner,
      }),
    ).toBe(true);
    expect(commandRunner).toHaveBeenCalledWith(
      "npm",
      ["view", `${ROOT_PACKAGE_NAME}@2.2.0`, "version", `--registry=${REGISTRY}`],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );

    const notFoundRunner = vi.fn().mockReturnValue({ exitCode: 1, rawStdout: "" });
    expect(
      isPackageVersionPublished({
        packageName: ROOT_PACKAGE_NAME,
        version: "2.2.0",
        registry: REGISTRY,
        commandRunner: notFoundRunner,
      }),
    ).toBe(false);
  });

  it("raises a typed certification error naming the failed package on publish failure", () => {
    const commandRunner = vi.fn().mockReturnValue({ exitCode: 1, stdout: "", stderr: "boom" });
    expect(() =>
      publishReleaseCandidateEntry({
        entry: { package: ROOT_PACKAGE_NAME, file: "packages/root.tgz", absolutePath: "/rc/root.tgz" },
        registry: REGISTRY,
        rootDirectory: "/rc",
        commandRunner,
      }),
    ).toThrow(`Publishing certified tarball failed for ${ROOT_PACKAGE_NAME}.`);
  });
});
