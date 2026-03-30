import { describe, expect, it } from "vitest";
import {
  bumpVersion,
  computePublishPlan,
  isAllowedResumePath,
} from "../scripts/release-lib.mjs";

describe("release script helpers", () => {
  it("bumps semantic versions by release type", () => {
    expect(bumpVersion("1.8.37", "patch")).toBe("1.8.38");
    expect(bumpVersion("1.8.37", "minor")).toBe("1.9.0");
    expect(bumpVersion("1.8.37", "major")).toBe("2.0.0");
  });

  it("allows resume only for managed release files", () => {
    expect(isAllowedResumePath("package.json")).toBe(true);
    expect(
      isAllowedResumePath("optional-packages/codegraph-js-fallback/package.json"),
    ).toBe(true);
    expect(isAllowedResumePath("src/indexer.ts")).toBe(false);
  });

  it("skips already published packages while keeping missing ones", () => {
    expect(
      computePublishPlan({
        shouldPublish: true,
        publishedRoot: true,
        publishedNativeMeta: true,
        publishedJsFallback: false,
      }),
    ).toEqual({
      publishNativeTargets: false,
      publishNativeMeta: false,
      publishJsFallback: true,
      publishRoot: false,
    });
  });

  it("publishes everything when no package exists yet", () => {
    expect(
      computePublishPlan({
        shouldPublish: true,
        publishedRoot: false,
        publishedNativeMeta: false,
        publishedJsFallback: false,
      }),
    ).toEqual({
      publishNativeTargets: true,
      publishNativeMeta: true,
      publishJsFallback: true,
      publishRoot: true,
    });
  });
});
