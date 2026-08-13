import fs from "node:fs";
import { describe, expect, it } from "vitest";

const releaseWorkflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
const standaloneWorkflow = fs.readFileSync(".github/workflows/standalone-release.yml", "utf8");

function jobBlock(workflow: string, jobName: string): string {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing workflow job ${jobName}`);
  const remaining = workflow.slice(start + marker.length);
  const nextJob = /^ {2}[a-z0-9-]+:\s*$/m.exec(remaining);
  return workflow.slice(start, nextJob ? start + marker.length + nextJob.index : undefined);
}

describe("certified release workflows", () => {
  it("finishes package certification and publication before standalone previews", () => {
    const assemble = jobBlock(releaseWorkflow, "assemble-release-candidates");
    const publish = jobBlock(releaseWorkflow, "publish-certified");
    const buildNative = jobBlock(releaseWorkflow, "build-native-artifacts");
    const security = jobBlock(releaseWorkflow, "security-production");
    const smoke = jobBlock(releaseWorkflow, "package-smoke");
    const packageFunnel = jobBlock(releaseWorkflow, "package-funnel");
    const report = jobBlock(releaseWorkflow, "certification-report");
    expect(releaseWorkflow).toContain("id-token: write");
    expect(releaseWorkflow).toContain("bootstrap_public_npm:");
    expect(releaseWorkflow).toContain("default: false");
    expect(releaseWorkflow).not.toContain("registry-auth-preflight:");
    expect(releaseWorkflow).not.toContain("PACKAGE_PUBLISH_TOKEN");
    expect(releaseWorkflow).not.toContain("npm.pkg.github.com");
    expect(buildNative).not.toContain("registry-auth-preflight");
    expect(publish).toContain("environment: npm-prod");
    expect(publish).toContain("registry-url: https://registry.npmjs.org");
    expect(publish).toContain("Verify trusted-publishing runtime");
    expect(publish).toContain("11.5.1 minimum for trusted publishing");
    expect(publish).toContain("Require bootstrap token when requested");
    expect(publish).toContain("BOOTSTRAP_PUBLIC_NPM: ${{ inputs.bootstrap_public_npm }}");
    expect(publish).toContain(
      "NPM_BOOTSTRAP_TOKEN: ${{ inputs.bootstrap_public_npm && secrets.NPM_BOOTSTRAP_TOKEN || '' }}",
    );
    expect(publish).toContain('if [ "$BOOTSTRAP_PUBLIC_NPM" = "true" ]; then');
    expect(publish).toContain('export NODE_AUTH_TOKEN="$NPM_BOOTSTRAP_TOKEN"');
    expect(publish).not.toContain("NODE_AUTH_TOKEN:");
    expect(assemble).toContain("- build-native-artifacts");
    expect(security).toContain("- assemble-release-candidates");
    expect(smoke).toContain("- security-production");
    expect(packageFunnel).toContain("- assemble-release-candidates");
    expect(report).toContain("- package-smoke");
    expect(report).toContain("- package-smoke-reduced");
    expect(report).toContain("- package-funnel");
    expect(report).toContain("- tests-release");
    expect(report).toContain("- fixture-hermeticity");
    expect(publish).toContain("- certification-report");
    expect(releaseWorkflow).not.toContain("build-standalone-archives");
    expect(releaseWorkflow).not.toContain("standalone-funnel");
    expect(releaseWorkflow).not.toContain("standalone-release-assets");
  });

  it("chains the reusable standalone workflow after certified publication", () => {
    const standalone = jobBlock(releaseWorkflow, "standalone-release");

    expect(standalone).toContain("- plan-release");
    expect(standalone).toContain("- publish-certified");
    expect(standalone).toContain("uses: ./.github/workflows/standalone-release.yml");
    expect(standalone).toContain("release_tag: v${{ needs.plan-release.outputs.root_version }}");
    expect(standaloneWorkflow).toContain("workflow_call:");
  });

  it("publishes only certified package assets before standalone enrichment", () => {
    const publish = jobBlock(releaseWorkflow, "publish-certified");
    const preflightIndex = publish.indexOf("Require passing certification envelope before registry writes");
    const publishIndex = publish.indexOf("Publish only certified tarballs");
    const releaseIndex = publish.indexOf("Create GitHub Release from certified assets");

    expect(releaseWorkflow.split("assemble-release-candidates.mjs")).toHaveLength(2);
    expect(releaseWorkflow).not.toContain("npm pack");
    expect(publish).toContain("publish-release-candidates.mjs");
    expect(publish).toContain("registry-url: https://registry.npmjs.org");
    expect(publish).toContain("environment: npm-prod");
    expect(publish).not.toContain("PACKAGE_PUBLISH_TOKEN");
    expect(publish).toContain('export NODE_AUTH_TOKEN="$NPM_BOOTSTRAP_TOKEN"');
    expect(publish).not.toContain("NODE_AUTH_TOKEN:");
    expect(publish).not.toContain("CODEGRAPH_PACKAGES_TOKEN_B64");
    expect(publish).not.toContain("base64 --decode");
    expect(publish).toContain("temp/release-candidates/packages/*.tgz");
    expect(publish).toContain("temp/release-candidates/SHA256SUMS");
    expect(publish).toContain("release-candidate-manifest.json");
    expect(publish).toContain("Standalone preview assets are built, smoked, and attached by the final release job.");
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(preflightIndex);
    expect(releaseIndex).toBeGreaterThan(publishIndex);
  });

  it("certifies planned package identities and records every release manifest", () => {
    const tests = jobBlock(releaseWorkflow, "tests-release");
    const publish = jobBlock(releaseWorkflow, "publish-certified");

    expect(tests).toContain("Prepare planned package manifests");
    expect(tests).toContain("restoreCorePackageManifest");
    expect(tests).toContain("restoreNativePackageManifest");
    expect(tests).toContain("restoreRootPackageManifest");
    expect(tests.indexOf("Prepare planned package manifests")).toBeGreaterThan(
      tests.indexOf("npm ci --ignore-scripts"),
    );
    expect(tests.indexOf("Prepare planned package manifests")).toBeLessThan(tests.indexOf("npm run build"));
    expect(publish).toContain("packages/codegraph-core/package.json");
    expect(publish).toContain('["@lzehrung/codegraph-core", process.env.ROOT_VERSION]');
    expect(publish).toContain("@lzehrung/codegraph-core@$ROOT_VERSION");
  });

  it("builds both musl targets through Zig instead of host glibc tools", () => {
    const build = jobBlock(releaseWorkflow, "build-native-artifacts");

    expect(build).toContain("- os: ubuntu-latest\n            rust-target: aarch64-unknown-linux-musl");
    expect(build).toContain("uses: mlugg/setup-zig@v2");
    expect(build).toContain("version: 0.15.2");
    expect(build).toContain("uses: taiki-e/install-action@v2");
    expect(build).toContain("tool: cargo-zigbuild");
    expect(build).toContain("Build native musl target with Zig");
    expect(build).toContain("${{ matrix.rust-target }} -x");
    expect(build).toContain("Reject glibc-linked musl artifacts");
    expect(build).toContain("readelf -d");
    expect(build).toContain("libgcc_s\\.so|libc\\.so\\.6|ld-linux");
    expect(build).not.toContain("musl-tools");
    expect(build).not.toContain("libgcc-s1");
    expect(build).not.toContain("LIBRARY_PATH=");
    expect(build).not.toContain("RUSTFLAGS=");
  });

  it("supports reusable and manual standalone assembly for an existing release", () => {
    const plan = jobBlock(standaloneWorkflow, "plan-standalone");
    const download = jobBlock(standaloneWorkflow, "download-release-candidates");
    const build = jobBlock(standaloneWorkflow, "build-standalone-archives");
    const smoke = jobBlock(standaloneWorkflow, "smoke-standalone-archives");
    const funnel = jobBlock(standaloneWorkflow, "standalone-funnel");
    const assets = jobBlock(standaloneWorkflow, "assemble-standalone-release-assets");
    const publish = jobBlock(standaloneWorkflow, "publish-standalone-assets");

    expect(standaloneWorkflow).toContain("workflow_call:");
    expect(standaloneWorkflow).toContain("workflow_dispatch:");
    expect(standaloneWorkflow).toContain("release_tag:");
    expect(standaloneWorkflow).toContain('["rev-parse", "HEAD^"]');
    expect(plan).toContain("fetch-depth: 2");
    expect(download).toContain('gh release download "$RELEASE_TAG"');
    expect(download).toContain("release-candidate-manifest.json");
    expect(download).toContain("{ verifyFiles: true }");
    expect(download).not.toContain('--pattern "SHA256SUMS"');
    expect(download).toContain('fs.writeFileSync("temp/release-candidates/SHA256SUMS"');
    expect(build).toContain("- download-release-candidates");
    expect(build).toContain("npm run build:standalone --");
    expect(build).toContain('"${{ steps.packages.outputs.root }}"');
    expect(build).toContain('"${{ steps.packages.outputs.core }}"');
    expect(build).toContain('"${{ steps.packages.outputs.native }}"');
    expect(build).toContain('"${{ steps.packages.outputs.nativeTarget }}"');
    expect(build).not.toContain('"ls", "--omit=dev"');
    expect(smoke).toContain("- build-standalone-archives");
    expect(smoke).toContain("installStandaloneBundle");
    expect(funnel).toContain("- build-standalone-archives");
    expect(funnel).toContain("ref: ${{ github.workflow_sha }}");
    expect(funnel).toContain("Run published POSIX bootstrap");
    expect(funnel).toContain("Run published PowerShell bootstrap");
    expect(funnel).toContain("--channel standalone");
    expect(assets).toContain("- smoke-standalone-archives");
    expect(assets).toContain("- standalone-funnel");
    expect(assets).toContain("sha256sum codegraph-* install.sh install.ps1");
    expect(publish).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(publish).toContain("- assemble-standalone-release-assets");
    expect(publish).toContain('gh release upload "$RELEASE_TAG"');
    expect(publish).toContain("--clobber");
  });

  it("retains runtime package funnels and the structural Windows ARM64 exception", () => {
    const smoke = jobBlock(releaseWorkflow, "package-smoke");
    const funnel = jobBlock(releaseWorkflow, "package-funnel");
    const runtimeTargets = [
      { alpine: false, nativeTarget: "win32-x64-msvc", target: "win32-x64" },
      { alpine: false, nativeTarget: "linux-x64-gnu", target: "linux-x64" },
      { alpine: false, nativeTarget: "linux-arm64-gnu", target: "linux-arm64" },
      { alpine: true, nativeTarget: "linux-x64-musl", target: "linux-x64" },
      { alpine: true, nativeTarget: "linux-arm64-musl", target: "linux-arm64" },
      { alpine: false, nativeTarget: "darwin-x64", target: "darwin-x64" },
      { alpine: false, nativeTarget: "darwin-arm64", target: "darwin-arm64" },
    ];

    for (const runtime of runtimeTargets) {
      expect(smoke).toMatch(new RegExp(`target: ${runtime.nativeTarget}\\n\\s+mode: runtime`));
      expect(funnel).toMatch(
        new RegExp(
          `target: ${runtime.target}\\n\\s+native-target: ${runtime.nativeTarget}\\n\\s+alpine: ${runtime.alpine}`,
        ),
      );
    }
    expect(smoke).toMatch(/target: win32-arm64-msvc\n\s+mode: structural/);
    expect(funnel).not.toContain("win32-arm64");
  });
});
