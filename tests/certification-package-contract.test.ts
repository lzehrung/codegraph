import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PackageCertificationError,
  computeFileSha256,
  readReleaseCandidateManifest,
  releaseCandidatePublicationOrder,
  selectReleaseCandidatePackages,
  validateNativeTargetExceptions,
  validateReleaseCandidateManifest,
} from "../scripts/certification/package-contract-lib.mjs";
import { getNativeTargetMetadata, nativeTargetMetadata } from "../scripts/native-targets-lib.mjs";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-certification-contract-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function candidateRecord(
  directory: string,
  packageName: string,
  file: string,
  target?: string,
): Promise<Record<string, unknown>> {
  const filePath = path.join(directory, file);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${packageName}\n`, "utf8");
  return {
    package: packageName,
    ...(target ? { target } : {}),
    file: file.replaceAll(path.sep, "/"),
    sha256: await computeFileSha256(filePath),
    size: fs.statSync(filePath).size,
  };
}

async function writeManifest(directory: string): Promise<string> {
  const target = "win32-x64-msvc";
  const manifest = {
    schemaVersion: 1,
    sourceRevision: "a".repeat(40),
    rootVersion: "2.0.0",
    nativeVersion: "3.0.0",
    files: [
      await candidateRecord(directory, "@lzehrung/codegraph", "packages/root.tgz"),
      await candidateRecord(directory, "@lzehrung/codegraph-core", "packages/core.tgz"),
      await candidateRecord(directory, "@lzehrung/codegraph-native", "packages/native.tgz"),
      await candidateRecord(directory, `@lzehrung/codegraph-native-${target}`, `packages/native-${target}.tgz`, target),
    ],
  };
  const manifestPath = path.join(directory, "release-candidate-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("release candidate package contract", () => {
  it("fails before package selection when a certified tarball checksum changes", async () => {
    const directory = temporaryDirectory();
    const manifestPath = await writeManifest(directory);
    const candidatePath = path.join(directory, "packages", "native-win32-x64-msvc.tgz");
    const candidateBytes = fs.readFileSync(candidatePath);
    candidateBytes[0] = candidateBytes[0] ^ 1;
    fs.writeFileSync(candidatePath, candidateBytes);

    await expect(
      readReleaseCandidateManifest(manifestPath, {
        verifyFiles: true,
        expectedTargets: ["win32-x64-msvc"],
      }),
    ).rejects.toMatchObject({ code: "checksum-mismatch" });
  });

  it("uses a stable target-mismatch error for a wrong native package", () => {
    expect(() =>
      validateReleaseCandidateManifest(
        {
          schemaVersion: 1,
          sourceRevision: "a".repeat(40),
          rootVersion: "2.0.0",
          nativeVersion: "3.0.0",
          files: [
            {
              package: "@lzehrung/codegraph",
              file: "packages/root.tgz",
              sha256: "a".repeat(64),
              size: 1,
            },
            {
              package: "@lzehrung/codegraph-core",
              file: "packages/core.tgz",
              sha256: "d".repeat(64),
              size: 1,
            },
            {
              package: "@lzehrung/codegraph-native",
              file: "packages/native.tgz",
              sha256: "b".repeat(64),
              size: 1,
            },
            {
              package: "@lzehrung/codegraph-native-linux-x64-gnu",
              target: "win32-x64-msvc",
              file: "packages/wrong-target.tgz",
              sha256: "c".repeat(64),
              size: 1,
            },
          ],
        },
        { expectedTargets: ["win32-x64-msvc"] },
      ),
    ).toThrowError(expect.objectContaining<Partial<PackageCertificationError>>({ code: "target-mismatch" }));
  });

  it("orders target packages before native, core, and root publication", async () => {
    const directory = temporaryDirectory();
    const manifestPath = await writeManifest(directory);
    const manifest = await readReleaseCandidateManifest(manifestPath, {
      verifyFiles: true,
      expectedTargets: ["win32-x64-msvc"],
    });

    expect(releaseCandidatePublicationOrder(manifest).map((entry) => entry.package)).toEqual([
      "@lzehrung/codegraph-native-win32-x64-msvc",
      "@lzehrung/codegraph-native",
      "@lzehrung/codegraph-core",
      "@lzehrung/codegraph",
    ]);
  });
});

describe("native target certification classes", () => {
  it("labels only win32-arm64-msvc as structural", () => {
    expect(getNativeTargetMetadata("win32-arm64-msvc").certificationClass).toBe("structural");
    expect(
      nativeTargetMetadata
        .filter((target) => target.certificationClass === "runtime")
        .map((target) => target.suffix)
        .sort(),
    ).toEqual(
      [
        "darwin-arm64",
        "darwin-x64",
        "linux-arm64-gnu",
        "linux-arm64-musl",
        "linux-x64-gnu",
        "linux-x64-musl",
        "win32-x64-msvc",
      ].sort(),
    );
  });

  it("requires an owned, reasoned, unexpired structural exception", () => {
    const exception = {
      schemaVersion: 1,
      exceptions: [
        {
          target: "win32-arm64-msvc",
          certificationClass: "structural",
          owner: "@release-owner",
          expires: "2027-01-31",
          reason: "No matching runtime host is available.",
        },
      ],
    };

    expect(validateNativeTargetExceptions(exception, { now: new Date("2026-07-27T00:00:00Z") })).toEqual(exception);
    expect(() => validateNativeTargetExceptions(exception, { now: new Date("2027-02-01T00:00:00Z") })).toThrowError(
      expect.objectContaining<Partial<PackageCertificationError>>({ code: "structural-exception-expired" }),
    );
  });
});
