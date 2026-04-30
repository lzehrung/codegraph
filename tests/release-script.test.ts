import { describe, expect, it } from "vitest";
import {
  bumpVersion,
  computePublishPlan,
  computePublishExecutionSteps,
  detectChangedReleasePackages,
  getReleasePackage,
  isAllowedResumePath,
  parseGitStatusPaths,
  recoverNativePackageManifestForResume,
  recoverRootPackageManifestForResume,
  restoreRootPackageManifest,
  restoreNativePackageManifest,
  sanitizeJsFallbackPackageManifest,
  sanitizePublishedRootPackageManifest,
  selectLatestLegacyTag,
  selectLatestSemverTag,
  tagNameForPackageVersion,
  tagNamesForPackageVersion,
} from "../scripts/release-lib.mjs";

describe("release script helpers", () => {
  it("bumps semantic versions by release type", () => {
    expect(bumpVersion("1.8.37", "patch")).toBe("1.8.38");
    expect(bumpVersion("1.8.37", "minor")).toBe("1.9.0");
    expect(bumpVersion("1.8.37", "major")).toBe("2.0.0");
  });

  it("allows resume only for managed release files", () => {
    expect(isAllowedResumePath("package.json")).toBe(true);
    expect(isAllowedResumePath("scripts/release-lib.mjs")).toBe(true);
    expect(isAllowedResumePath("scripts/release.mjs")).toBe(true);
    expect(isAllowedResumePath("tests/release-script.test.ts")).toBe(true);
    expect(isAllowedResumePath("packages/codegraph-js-fallback/package.json")).toBe(true);
    expect(isAllowedResumePath("src/indexer.ts")).toBe(false);
  });

  it("parses null-delimited git status output for modified and renamed paths", () => {
    expect(parseGitStatusPaths([" M package.json", "R  scripts/release-renamed.mjs", "scripts/release.mjs"].join("\0"))).toEqual([
      "package.json",
      "scripts/release-renamed.mjs",
    ]);
  });

  it("resolves release package selectors by id and package name", () => {
    expect(getReleasePackage("root").name).toBe("@lzehrung/codegraph");
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
    ).toEqual(["root", "native", "js-fallback"]);
  });

  it("treats release packaging scripts as root package changes", () => {
    expect(detectChangedReleasePackages(["scripts/release.mjs", "scripts/release-lib.mjs", "tests/release-script.test.ts"])).toEqual([
      "root",
    ]);
  });

  it("publishes only selected packages that are not already in the registry", () => {
    expect(
      computePublishPlan({
        shouldPublish: true,
        selectedPackageNames: ["@lzehrung/codegraph", "@lzehrung/codegraph-js-fallback"],
        publishedPackageNames: new Set(["@lzehrung/codegraph"]),
      }),
    ).toEqual({
      publishByPackage: {
        "@lzehrung/codegraph": false,
        "@lzehrung/codegraph-js-fallback": true,
      },
      publishNativeTargets: false,
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

  it("publishes native and fallback packages before preparing the root manifest", () => {
    expect(
      computePublishExecutionSteps({
        publishByPackage: {
          "@lzehrung/codegraph-native": true,
          "@lzehrung/codegraph-js-fallback": true,
          "@lzehrung/codegraph": true,
        },
        publishNativeTargets: true,
      }),
    ).toEqual(["publishNativeTargets", "publishNativeMeta", "publishJsFallback", "prepareRootManifest", "publishRoot"]);
  });

  it("selects the latest package-scoped tag by version", () => {
    expect(selectLatestSemverTag(["@lzehrung/codegraph@1.8.41", "@lzehrung/codegraph@1.8.43", "@lzehrung/codegraph@1.8.42"])).toBe(
      "@lzehrung/codegraph@1.8.43",
    );
  });

  it("selects the latest legacy synchronized release tag by version", () => {
    expect(selectLatestLegacyTag(["v1.8.40", "v1.8.42", "v1.8.41"])).toBe("v1.8.42");
  });

  it("formats package-scoped release tags", () => {
    expect(tagNameForPackageVersion("@lzehrung/codegraph-js-fallback", "1.8.44")).toBe("@lzehrung/codegraph-js-fallback@1.8.44");
  });

  it("formats both repo and package-scoped tags for root releases", () => {
    expect(tagNamesForPackageVersion("@lzehrung/codegraph", "1.8.44")).toEqual(["v1.8.44", "@lzehrung/codegraph@1.8.44"]);
  });

  it("keeps non-root releases package-scoped only", () => {
    expect(tagNamesForPackageVersion("@lzehrung/codegraph-native", "1.8.44")).toEqual(["@lzehrung/codegraph-native@1.8.44"]);
  });

  it("sanitizes the fallback package manifest for publishing", () => {
    expect(
      sanitizeJsFallbackPackageManifest({
        name: "@lzehrung/codegraph-js-fallback",
        version: "1.8.44",
        dependencies: {
          "@lzehrung/codegraph": "file:../..",
          "tree-sitter": "^0.25.0",
        },
      }),
    ).toEqual({
      name: "@lzehrung/codegraph-js-fallback",
      version: "1.8.44",
      dependencies: {
        "tree-sitter": "^0.25.0",
      },
    });
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
          "better-sqlite3": "^12.5.0",
        },
      }),
    ).toEqual({
      name: "@lzehrung/codegraph",
      version: "1.8.44",
      dependencies: {
        "better-sqlite3": "^12.5.0",
      },
    });
  });

  it("restores the root source manifest shape while keeping the selected version", () => {
    expect(
      restoreRootPackageManifest(
        {
          name: "@lzehrung/codegraph",
          version: "1.8.43",
          workspaces: ["packages/*"],
          scripts: {
            "publish:patch": "node ./scripts/release.mjs patch --publish",
          },
        },
        "1.8.44",
      ),
    ).toEqual({
      name: "@lzehrung/codegraph",
      version: "1.8.44",
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
          dependencies: {
            "better-sqlite3": "^12.5.0",
          },
        },
        {
          name: "@lzehrung/codegraph",
          version: "1.8.45",
          scripts: {
            "publish:resume": "node ./scripts/release.mjs resume --publish",
          },
          workspaces: ["packages/*"],
          devDependencies: {
            vitest: "^3.2.4",
          },
          dependencies: {
            "better-sqlite3": "^12.5.0",
          },
        },
      ),
    ).toEqual({
      name: "@lzehrung/codegraph",
      version: "1.8.46",
      scripts: {
        "publish:resume": "node ./scripts/release.mjs resume --publish",
      },
      workspaces: ["packages/*"],
      devDependencies: {
        vitest: "^3.2.4",
      },
      dependencies: {
        "better-sqlite3": "^12.5.0",
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
