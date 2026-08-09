import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertCompleteNativeTargetArtifacts,
  getSupportedNativeTargetPackageNames,
} from "../scripts/native-targets-lib.mjs";
import {
  bumpVersion,
  computePublishPlan,
  computePublishExecutionSteps,
  detectChangedReleasePackages,
  getReleasePackage,
  hasTagForPackageVersion,
  isAllowedResumePath,
  isNativeTargetArtifactPath,
  parseGitStatusPaths,
  recoverNativePackageManifestForResume,
  recoverRootPackageManifestForResume,
  prepareNativePackageManifestForPublish,
  restoreRootPackageManifest,
  restoreNativePackageManifest,
  sanitizePublishedRootPackageManifest,
  selectLatestLegacyTag,
  selectLatestSemverTag,
  tagNameForPackageVersion,
  tagNamesForPackageVersion,
} from "../scripts/release-lib.mjs";

const nativeSourcePackage = {
  name: "@lzehrung/codegraph-native",
  version: "1.8.49",
  files: ["index.js", "index.d.ts", "platform.js"],
  napi: {
    packageName: "@lzehrung/codegraph-native",
    targets: [
      "x86_64-pc-windows-msvc",
      "aarch64-pc-windows-msvc",
      "x86_64-apple-darwin",
      "aarch64-apple-darwin",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
      "x86_64-unknown-linux-musl",
      "aarch64-unknown-linux-musl",
    ],
  },
};

function supportedNativeOptionalDependencies(version: string): Record<string, string> {
  return Object.fromEntries(getSupportedNativeTargetPackageNames(nativeSourcePackage).map((name) => [name, version]));
}

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function reportHasGlibcRuntime(report: ReturnType<NonNullable<typeof process.report>["getReport"]>): boolean {
  return "glibcVersionRuntime" in report.header;
}

function currentNativeTargetSuffix(): string | null {
  if (process.platform === "win32") {
    if (process.arch === "x64") return "win32-x64-msvc";
    if (process.arch === "arm64") return "win32-arm64-msvc";
  }
  if (process.platform === "darwin") {
    if (process.arch === "x64") return "darwin-x64";
    if (process.arch === "arm64") return "darwin-arm64";
  }
  if (process.platform === "linux") {
    const report = process.report?.getReport();
    const abi = report && reportHasGlibcRuntime(report) ? "gnu" : "musl";
    if (process.arch === "x64") return `linux-x64-${abi}`;
    if (process.arch === "arm64") return `linux-arm64-${abi}`;
  }
  return null;
}

describe("release script helpers", () => {
  it("keeps release lockfile generation compatible with CI npm ci", () => {
    const releaseScript = fs.readFileSync("scripts/release.mjs", "utf8");

    expect(releaseScript).toContain('run("npm", ["install"])');
    expect(releaseScript).not.toContain('run("node", ["./scripts/patch-tree-sitter-node24.mjs"])');
    expect(releaseScript).not.toContain('run("npm", ["rebuild"])');
    expect(
      releaseScript.indexOf('run("node", ["./scripts/build-native-if-available.mjs", "--strict"])'),
    ).toBeGreaterThan(releaseScript.indexOf('run("npm", ["install"])'));
    expect(releaseScript).toContain('run("node", ["./scripts/stage-native-package.mjs", "--if-missing"])');
    expect(releaseScript).toContain("assertCompleteNativeTargetArtifacts(nativeRootPath");
    expect(releaseScript).toContain("if (!rootVersion && nativeVersion)");
    expect(releaseScript).toContain('const intendedVersion = versionPlan.get("root") ?? sourceManifest.version');
    expect(releaseScript).toContain(
      'const nativeVersion = versionPlan.get("native") ?? readJson(nativePackagePath).version',
    );
    expect(releaseScript).toContain("restoreRootPackageManifest(sourceManifest, intendedVersion, nativeVersion)");
    expect(fs.readFileSync("scripts/publish-native-targets.mjs", "utf8")).toContain(
      "Skipping existing native target package",
    );
    expect(fs.readFileSync("scripts/publish-native-targets.mjs", "utf8")).toContain("previously published versions");
    expect(releaseScript.indexOf("prepareNativeTargetArtifactsForPublish();")).toBeGreaterThan(
      releaseScript.indexOf('run("node", ["./scripts/build-native-if-available.mjs", "--strict"])'),
    );
    expect(releaseScript.indexOf('run("npm", ["run", "test:ci"])')).toBeGreaterThan(
      releaseScript.indexOf("prepareNativeTargetArtifactsForPublish();"),
    );
    expect(releaseScript).not.toContain("--legacy-peer-deps");
    expect(releaseScript).toContain('"packages/codegraph-core/package.json"');
  });

  it("stages the core package manifest in the release commit", () => {
    const releaseScript = fs.readFileSync("scripts/release.mjs", "utf8");
    const commitAndTag = releaseScript.slice(releaseScript.indexOf("function commitAndTag"));
    expect(commitAndTag).toContain('"packages/codegraph-core/package.json"');
    expect(commitAndTag).toContain('"packages/codegraph-native/package.json"');
  });

  it("bumps semantic versions by release type", () => {
    expect(bumpVersion("1.8.37", "patch")).toBe("1.8.38");
    expect(bumpVersion("1.8.37", "minor")).toBe("1.9.0");
    expect(bumpVersion("1.8.37", "major")).toBe("2.0.0");
  });

  it("updates only the native package version for pre-build release artifacts", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-native-version-"));
    const nativePackageDir = path.join(tempDir, "packages", "codegraph-native");
    const scriptPath = path.resolve(process.cwd(), "scripts/set-native-package-version.mjs");
    fs.mkdirSync(nativePackageDir, { recursive: true });
    fs.writeFileSync(
      path.join(nativePackageDir, "package.json"),
      `${JSON.stringify({
        name: "@lzehrung/codegraph-native",
        version: "1.8.49",
        files: ["index.js", "index.d.ts", "platform.js"],
      })}\n`,
    );

    try {
      const result = spawnSync(process.execPath, [scriptPath, "1.8.50"], {
        cwd: tempDir,
        encoding: "utf8",
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readJsonFile(path.join(nativePackageDir, "package.json"))).toEqual({
        name: "@lzehrung/codegraph-native",
        version: "1.8.50",
        files: ["index.js", "index.d.ts", "platform.js"],
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps an existing staged native artifact when staging only missing targets", () => {
    const suffix = currentNativeTargetSuffix();
    expect(suffix).toBeTruthy();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-native-stage-"));
    const targetDir = path.join(tempDir, "packages", "codegraph-native", "npm", String(suffix));
    const targetFile = path.join(targetDir, `index.${suffix}.node`);
    const scriptPath = path.resolve(process.cwd(), "scripts/stage-native-package.mjs");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetFile, "downloaded artifact");

    try {
      const result = spawnSync(process.execPath, [scriptPath, "--if-missing"], {
        cwd: tempDir,
        encoding: "utf8",
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Keeping existing staged native artifact");
      expect(fs.readFileSync(targetFile, "utf8")).toBe("downloaded artifact");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allows resume only for managed release files", () => {
    expect(isAllowedResumePath("package.json")).toBe(true);
    expect(isAllowedResumePath("scripts/check-native-artifacts.mjs")).toBe(true);
    expect(isAllowedResumePath("scripts/native-targets-lib.mjs")).toBe(true);
    expect(isAllowedResumePath("scripts/publish-native-targets.mjs")).toBe(true);
    expect(isAllowedResumePath("scripts/release-lib.mjs")).toBe(true);
    expect(isAllowedResumePath("scripts/release.mjs")).toBe(true);
    expect(isAllowedResumePath("scripts/set-native-package-version.mjs")).toBe(true);
    expect(isAllowedResumePath("scripts/stage-native-package.mjs")).toBe(true);
    expect(isAllowedResumePath("scripts/sync-native-meta.mjs")).toBe(true);
    expect(isAllowedResumePath("tests/release-script.test.ts")).toBe(true);
    expect(isAllowedResumePath("packages/codegraph-js-fallback/package.json")).toBe(false);
    expect(isAllowedResumePath("src/indexer.ts")).toBe(false);
  });

  it("recognizes generated native target artifacts separately from managed release files", () => {
    expect(isNativeTargetArtifactPath("packages/codegraph-native/npm/linux-x64-gnu/index.linux-x64-gnu.node")).toBe(
      true,
    );
    expect(isNativeTargetArtifactPath("packages/codegraph-native/npm/win32-arm64-msvc/package.json")).toBe(true);
    expect(isNativeTargetArtifactPath("packages/codegraph-native/package.json")).toBe(false);
    expect(isNativeTargetArtifactPath("packages/codegraph-js-fallback/package.json")).toBe(false);
  });

  it("parses null-delimited git status output for modified and renamed paths", () => {
    expect(
      parseGitStatusPaths([" M package.json", "R  scripts/release-renamed.mjs", "scripts/release.mjs"].join("\0")),
    ).toEqual(["package.json", "scripts/release-renamed.mjs"]);
  });

  it("resolves release package selectors by id and package name", () => {
    expect(getReleasePackage("root").name).toBe("@lzehrung/codegraph");
    expect(getReleasePackage("core").name).toBe("@lzehrung/codegraph-core");
    expect(getReleasePackage("@lzehrung/codegraph-native").id).toBe("native");
  });

  it("maps changed paths to the owning release packages", () => {
    expect(
      detectChangedReleasePackages([
        "src/index.ts",
        "packages/codegraph-native/Cargo.toml",
        "packages/codegraph-js-fallback/package.json",
        "docs/scenario-catalog.md",
      ]),
    ).toEqual(["root", "core", "native"]);
  });

  it("treats published MCP documentation as a root package change", () => {
    expect(detectChangedReleasePackages(["docs/mcp.md"])).toEqual(["root", "core"]);
  });

  it("treats release packaging scripts as root package changes", () => {
    expect(
      detectChangedReleasePackages([
        ".github/workflows/release.yml",
        "PUBLISHING.md",
        "scripts/certification/assemble-release-candidates.mjs",
        "scripts/certification/package-contract-lib.mjs",
        "scripts/certification/run-package-smoke.mjs",
        "tests/certification-release-workflow.test.ts",
        "scripts/release.mjs",
        "scripts/release-lib.mjs",
        "tests/release-script.test.ts",
      ]),
    ).toEqual(["root", "core"]);
  });

  it("treats native packaging gates as root package changes", () => {
    expect(
      detectChangedReleasePackages([
        "scripts/check-native-artifacts.mjs",
        "scripts/native-targets-lib.mjs",
        "scripts/publish-native-targets.mjs",
        "scripts/set-native-package-version.mjs",
        "scripts/stage-native-package.mjs",
        "scripts/sync-native-meta.mjs",
      ]),
    ).toEqual(["root", "core"]);
  });

  it("publishes only selected root and native packages that are not already in the registry", () => {
    expect(
      computePublishPlan({
        shouldPublish: true,
        selectedPackageNames: ["@lzehrung/codegraph", "@lzehrung/codegraph-native"],
        publishedPackageNames: new Set(["@lzehrung/codegraph"]),
      }),
    ).toEqual({
      publishByPackage: {
        "@lzehrung/codegraph": false,
        "@lzehrung/codegraph-native": true,
      },
      publishNativeTargets: true,
    });
  });

  it("publishes native targets only when the native meta package is selected", () => {
    expect(
      computePublishPlan({
        shouldPublish: true,
        selectedPackageNames: ["@lzehrung/codegraph-native"],
        publishedPackageNames: new Set(),
      }),
    ).toEqual({
      publishByPackage: {
        "@lzehrung/codegraph-native": true,
      },
      publishNativeTargets: true,
    });
  });

  it("publishes native packages before preparing the root manifest", () => {
    expect(
      computePublishExecutionSteps({
        publishByPackage: {
          "@lzehrung/codegraph-native": true,
          "@lzehrung/codegraph": true,
        },
        publishNativeTargets: true,
      }),
    ).toEqual([
      "publishNativeTargets",
      "prepareNativeMeta",
      "publishNativeMeta",
      "prepareCoreManifest",
      "publishCore",
      "prepareRootManifest",
      "publishRoot",
    ]);
  });

  it("selects the latest package-scoped tag by version", () => {
    expect(
      selectLatestSemverTag(["@lzehrung/codegraph@1.8.41", "@lzehrung/codegraph@1.8.43", "@lzehrung/codegraph@1.8.42"]),
    ).toBe("@lzehrung/codegraph@1.8.43");
  });

  it("selects the latest legacy synchronized release tag by version", () => {
    expect(selectLatestLegacyTag(["v1.8.40", "v1.8.42", "v1.8.41"])).toBe("v1.8.42");
  });

  it("formats package-scoped release tags", () => {
    expect(tagNameForPackageVersion("@lzehrung/codegraph-native", "1.8.44")).toBe("@lzehrung/codegraph-native@1.8.44");
  });

  it("formats both repo and package-scoped tags for root releases", () => {
    expect(tagNamesForPackageVersion("@lzehrung/codegraph", "1.8.44")).toEqual([
      "v1.8.44",
      "@lzehrung/codegraph@1.8.44",
    ]);
  });

  it("detects when the current version is already tagged for a root release", () => {
    expect(hasTagForPackageVersion("@lzehrung/codegraph", "1.8.44", ["v1.8.44"])).toBe(true);
    expect(hasTagForPackageVersion("@lzehrung/codegraph", "1.8.44", ["@lzehrung/codegraph@1.8.44"])).toBe(true);
    expect(hasTagForPackageVersion("@lzehrung/codegraph", "1.8.44", ["v1.8.45"])).toBe(false);
  });

  it("keeps non-root releases package-scoped only", () => {
    expect(tagNamesForPackageVersion("@lzehrung/codegraph-native", "1.8.44")).toEqual([
      "@lzehrung/codegraph-native@1.8.44",
    ]);
  });

  it("rejects the removed JS fallback package selector", () => {
    expect(() => getReleasePackage("js-fallback")).toThrow(
      "Unknown release package selector: js-fallback. Use one of: root, @lzehrung/codegraph, core, @lzehrung/codegraph-core, native, @lzehrung/codegraph-native",
    );
    expect(() => getReleasePackage("@lzehrung/codegraph-js-fallback")).toThrow(
      "Unknown release package selector: @lzehrung/codegraph-js-fallback. Use one of: root, @lzehrung/codegraph, core, @lzehrung/codegraph-core, native, @lzehrung/codegraph-native",
    );
  });

  it("sanitizes the root package manifest for publishing", () => {
    expect(
      sanitizePublishedRootPackageManifest({
        name: "@lzehrung/codegraph",
        version: "1.8.44",
        workspaces: ["packages/*"],
        scripts: {
          build: "npm run clean && tsc -p tsconfig.json",
          "publish:patch": "node ./scripts/release.mjs patch --publish",
        },
        devDependencies: {
          vitest: "^3.2.4",
        },
        dependencies: {
          "fast-glob": "^3.3.3",
        },
      }),
    ).toEqual({
      name: "@lzehrung/codegraph",
      version: "1.8.44",
      dependencies: {
        "fast-glob": "^3.3.3",
      },
    });
  });

  it("restores the root source manifest shape while keeping the selected version", () => {
    expect(
      restoreRootPackageManifest(
        {
          name: "@lzehrung/codegraph",
          version: "1.8.43",
          optionalDependencies: {
            "@lzehrung/codegraph-native": "^1.8.43",
          },
          workspaces: ["packages/*"],
          scripts: {
            "publish:patch": "node ./scripts/release.mjs patch --publish",
          },
        },
        "1.8.44",
        "1.8.48",
      ),
    ).toEqual({
      name: "@lzehrung/codegraph",
      version: "1.8.44",
      optionalDependencies: {
        "@lzehrung/codegraph-native": "^1.8.48",
      },
      workspaces: ["packages/*"],
      scripts: {
        "publish:patch": "node ./scripts/release.mjs patch --publish",
      },
    });
  });

  it("recovers a sanitized root manifest during release resume", () => {
    expect(
      recoverRootPackageManifestForResume(
        {
          name: "@lzehrung/codegraph",
          version: "1.8.46",
          optionalDependencies: {
            "@lzehrung/codegraph-native": "^1.8.48",
          },
          dependencies: {
            "fast-glob": "^3.3.3",
          },
        },
        {
          name: "@lzehrung/codegraph",
          version: "1.8.45",
          optionalDependencies: {
            "@lzehrung/codegraph-native": "^1.8.45",
          },
          scripts: {
            "publish:resume": "node ./scripts/release.mjs resume --publish",
          },
          workspaces: ["packages/*"],
          devDependencies: {
            vitest: "^3.2.4",
          },
          dependencies: {
            "fast-glob": "^3.3.3",
          },
        },
      ),
    ).toEqual({
      name: "@lzehrung/codegraph",
      version: "1.8.46",
      optionalDependencies: {
        "@lzehrung/codegraph-native": "^1.8.48",
      },
      scripts: {
        "publish:resume": "node ./scripts/release.mjs resume --publish",
      },
      workspaces: ["packages/*"],
      devDependencies: {
        vitest: "^3.2.4",
      },
      dependencies: {
        "fast-glob": "^3.3.3",
      },
    });
  });

  it("recovers a generated native manifest during release resume", () => {
    expect(
      recoverNativePackageManifestForResume(
        {
          name: "@lzehrung/codegraph-native",
          version: "1.8.46",
          optionalDependencies: {
            "@lzehrung/codegraph-native-win32-x64-msvc": "1.8.46",
          },
        },
        {
          name: "@lzehrung/codegraph-native",
          version: "1.8.45",
          files: ["index.js", "index.d.ts"],
          napi: {
            packageName: "@lzehrung/codegraph-native",
          },
        },
      ),
    ).toEqual({
      name: "@lzehrung/codegraph-native",
      version: "1.8.46",
      files: ["index.js", "index.d.ts"],
      napi: {
        packageName: "@lzehrung/codegraph-native",
      },
    });
  });

  it("keeps generated native platform dependencies in the publish manifest", () => {
    expect(
      prepareNativePackageManifestForPublish(nativeSourcePackage, "1.8.50", {
        name: "@lzehrung/codegraph-native",
        version: "1.8.50",
        optionalDependencies: supportedNativeOptionalDependencies("1.8.50"),
      }),
    ).toEqual({
      name: "@lzehrung/codegraph-native",
      version: "1.8.50",
      files: ["index.js", "index.d.ts", "platform.js"],
      napi: {
        packageName: "@lzehrung/codegraph-native",
        targets: [
          "x86_64-pc-windows-msvc",
          "aarch64-pc-windows-msvc",
          "x86_64-apple-darwin",
          "aarch64-apple-darwin",
          "x86_64-unknown-linux-gnu",
          "aarch64-unknown-linux-gnu",
          "x86_64-unknown-linux-musl",
          "aarch64-unknown-linux-musl",
        ],
      },
      optionalDependencies: supportedNativeOptionalDependencies("1.8.50"),
    });
  });

  it("rejects native publish manifests with only one generated platform dependency", () => {
    expect(() =>
      prepareNativePackageManifestForPublish(nativeSourcePackage, "1.8.50", {
        name: "@lzehrung/codegraph-native",
        version: "1.8.50",
        optionalDependencies: {
          "@lzehrung/codegraph-native-win32-x64-msvc": "1.8.50",
        },
      }),
    ).toThrow(/incomplete generated native platform optionalDependencies/i);
  });

  it("rejects native publish manifests with stale target dependency versions", () => {
    expect(() =>
      prepareNativePackageManifestForPublish(nativeSourcePackage, "1.8.50", {
        name: "@lzehrung/codegraph-native",
        version: "1.8.50",
        optionalDependencies: supportedNativeOptionalDependencies("1.8.49"),
      }),
    ).toThrow(/wrong version/i);
  });

  it("rejects native publish manifests without generated platform dependencies", () => {
    expect(() =>
      prepareNativePackageManifestForPublish(
        {
          name: "@lzehrung/codegraph-native",
          version: "1.8.49",
          files: ["index.js", "index.d.ts"],
        },
        "1.8.50",
        {
          name: "@lzehrung/codegraph-native",
          version: "1.8.50",
        },
      ),
    ).toThrow(/generated native platform optionalDependencies/i);
  });

  it("requires staged native artifacts for every supported target", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-native-targets-"));
    const nativeRoot = path.join(tempDir, "packages", "codegraph-native");
    const windowsTargetDir = path.join(nativeRoot, "npm", "win32-x64-msvc");
    fs.mkdirSync(windowsTargetDir, { recursive: true });
    fs.writeFileSync(
      path.join(windowsTargetDir, "package.json"),
      JSON.stringify({
        name: "@lzehrung/codegraph-native-win32-x64-msvc",
        main: "index.win32-x64-msvc.node",
      }),
    );
    fs.writeFileSync(path.join(windowsTargetDir, "index.win32-x64-msvc.node"), "");

    try {
      expect(() => assertCompleteNativeTargetArtifacts(nativeRoot, nativeSourcePackage)).toThrow(
        /Missing staged native artifacts for supported targets/i,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("restores the native source manifest shape while keeping the selected version", () => {
    expect(
      restoreNativePackageManifest(
        {
          name: "@lzehrung/codegraph-native",
          version: "1.8.43",
          optionalDependencies: {
            "@lzehrung/codegraph-native-source-owned": "^1.0.0",
          },
          files: ["index.js"],
        },
        "1.8.44",
      ),
    ).toEqual({
      name: "@lzehrung/codegraph-native",
      version: "1.8.44",
      optionalDependencies: {
        "@lzehrung/codegraph-native-source-owned": "^1.0.0",
      },
      files: ["index.js"],
    });
  });
});
