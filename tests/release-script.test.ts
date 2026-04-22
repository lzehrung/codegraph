import { describe, expect, it } from "vitest";
import {
  bumpVersion,
  computePublishPlan,
  detectChangedReleasePackages,
  getReleasePackage,
  isAllowedResumePath,
  restoreNativePackageManifest,
  sanitizeJsFallbackPackageManifest,
  selectLatestLegacyTag,
  selectLatestSemverTag,
  tagNameForPackageVersion,
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
    expect(
      isAllowedResumePath("optional-packages/codegraph-js-fallback/package.json"),
    ).toBe(true);
    expect(isAllowedResumePath("src/indexer.ts")).toBe(false);
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
        "optional-packages/codegraph-js-fallback/package.json",
        "docs/scenario-catalog.md",
      ]),
    ).toEqual(["root", "native", "js-fallback"]);
  });

  it("publishes only selected packages that are not already in the registry", () => {
    expect(
      computePublishPlan({
        shouldPublish: true,
        selectedPackageNames: [
          "@lzehrung/codegraph",
          "@lzehrung/codegraph-js-fallback",
        ],
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

  it("selects the latest package-scoped tag by version", () => {
    expect(
      selectLatestSemverTag([
        "@lzehrung/codegraph@1.8.41",
        "@lzehrung/codegraph@1.8.43",
        "@lzehrung/codegraph@1.8.42",
      ]),
    ).toBe("@lzehrung/codegraph@1.8.43");
  });

  it("selects the latest legacy synchronized release tag by version", () => {
    expect(selectLatestLegacyTag(["v1.8.40", "v1.8.42", "v1.8.41"])).toBe(
      "v1.8.42",
    );
  });

  it("formats package-scoped release tags", () => {
    expect(
      tagNameForPackageVersion("@lzehrung/codegraph-js-fallback", "1.8.44"),
    ).toBe("@lzehrung/codegraph-js-fallback@1.8.44");
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
