import fs from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");

function jobBlock(jobName: string): string {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing release workflow job ${jobName}`);
  const remaining = workflow.slice(start + marker.length);
  const nextJob = /^ {2}[a-z0-9-]+:\s*$/m.exec(remaining);
  return workflow.slice(start, nextJob ? start + marker.length + nextJob.index : undefined);
}

describe("certified release workflow", () => {
  it("uses the plan, build, funnel, certify, and publish DAG", () => {
    const assemble = jobBlock("assemble-release-candidates");
    const security = jobBlock("security-production");
    const smoke = jobBlock("package-smoke");
    const packageFunnel = jobBlock("package-funnel");
    const report = jobBlock("certification-report");
    const publish = jobBlock("publish-certified");
    const standaloneBuild = jobBlock("build-standalone-archives");
    const standaloneSmoke = jobBlock("smoke-standalone-archives");
    const standaloneFunnel = jobBlock("standalone-funnel");
    const standaloneAssets = jobBlock("assemble-standalone-release-assets");

    expect(assemble).toContain("- build-native-artifacts");
    expect(standaloneBuild).toContain("- assemble-release-candidates");
    expect(standaloneSmoke).toContain("- build-standalone-archives");
    expect(standaloneFunnel).toContain("- build-standalone-archives");
    expect(standaloneAssets).toContain("- smoke-standalone-archives");
    expect(standaloneAssets).toContain("- standalone-funnel");
    expect(standaloneAssets).toContain("- plan-release");
    expect(security).toContain("- assemble-release-candidates");
    expect(smoke).toContain("- security-production");
    expect(packageFunnel).toContain("- assemble-release-candidates");
    expect(packageFunnel).toContain("- security-production");
    expect(report).toContain("- package-smoke");
    expect(report).toContain("- package-smoke-reduced");
    expect(report).toContain("- package-funnel");
    expect(report).toContain("- standalone-funnel");
    expect(report).toContain("- semantic-release");
    expect(report).toContain("- fixture-hermeticity");
    expect(publish).toContain("- certification-report");
    expect(publish).toContain("- assemble-standalone-release-assets");
  });

  it("packs candidates once and publishes only the certified tarballs", () => {
    const assemble = jobBlock("assemble-release-candidates");
    const publish = jobBlock("publish-certified");
    const preflightIndex = publish.indexOf("Require passing certification envelope before registry writes");
    const publishIndex = publish.indexOf("Publish only certified tarballs");
    const releaseIndex = publish.indexOf("Create GitHub Release from certified assets");

    expect(workflow.split("assemble-release-candidates.mjs")).toHaveLength(2);
    expect(workflow).not.toContain("npm pack");
    expect(workflow).not.toContain("npm run publish:");
    expect(assemble).toContain("Upload immutable release candidates");
    expect(publish).toContain("publish-release-candidates.mjs");
    expect(publish).toContain("release-candidate-manifest.json");
    expect(publish).toContain("SHA256SUMS");
    expect(publish).toContain("packages/*.tgz");
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(preflightIndex);
    expect(releaseIndex).toBeGreaterThan(publishIndex);
  });

  it("runs full package funnels for every runtime native target and exempts structural Windows ARM64", () => {
    const smoke = jobBlock("package-smoke");
    const funnel = jobBlock("package-funnel");
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
    expect(smoke).not.toMatch(/target: win32-arm64-msvc\n\s+mode: runtime/);
    expect(funnel).not.toContain("win32-arm64");
    expect(funnel).toContain("run-funnel-smoke.mjs");
    expect(funnel).toContain("--channel package");
    expect(funnel).toContain("release-candidate-manifest.json");
    expect(funnel).toContain("funnel-package-${{ matrix.native-target }}.json");
    expect(funnel).toContain("Upload package FunnelResultV1");
    expect(funnel).toContain("node:24-alpine");
  });

  it("assembles every standalone target and runs exact installer funnels for every runtime target", () => {
    const build = jobBlock("build-standalone-archives");
    const smoke = jobBlock("smoke-standalone-archives");
    const funnel = jobBlock("standalone-funnel");
    const targets = ["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
    const runtimeTargets = ["win32-x64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

    expect(build).toContain("Setup target-matching Node");
    expect(build).toContain("architecture: ${{ matrix.arch }}");
    expect(build).toContain("Install already-built package bytes");
    expect(build).toContain("npm run build:standalone --");
    expect(build).toContain('--package-root "$RUNNER_TEMP/standalone-package/node_modules/@lzehrung/codegraph"');
    for (const target of targets) {
      expect(build).toContain(`target: ${target}`);
      expect(smoke).toContain(`target: ${target}`);
    }
    for (const target of runtimeTargets) {
      expect(funnel).toContain(`target: ${target}`);
    }
    expect(build).toMatch(/os: windows-latest\n\s+arch: x64\n\s+target: win32-arm64/);
    expect(build).toContain("node-v${nodeVersion}-win-arm64.zip");
    expect(build).toContain("Node ${nodeVersion} ARM64 checksum verification failed.");
    expect(build).toContain("--allow-cross-target ${{ matrix.target == 'win32-arm64' }}");
    expect(smoke).toMatch(/target: win32-arm64\n\s+mode: structural/);
    expect(smoke).not.toMatch(/target: win32-arm64\n\s+mode: runtime/);
    expect(funnel).not.toContain("win32-arm64");
    expect(funnel).toContain("standalone-candidate-${{ matrix.target }}");
    expect(funnel).toContain("run-funnel-smoke.mjs");
    expect(funnel).toContain("--channel standalone");
    expect(funnel).toContain("Run exact standalone installer funnel");
    expect(build).toContain("temp/standalone/SHA256SUMS");
    expect(funnel).toContain("Run published POSIX bootstrap");
    expect(funnel).toContain("Run published PowerShell bootstrap");
    expect(funnel).toContain("CODEGRAPH_RELEASE_BASE_URL");
    expect(funnel).toContain("./install.sh --yes");
    expect(funnel).toContain("./install.ps1 -Yes");
    expect(funnel).toContain("funnel-standalone-${{ matrix.target }}.json");
    expect(funnel).toContain("Upload standalone FunnelResultV1");
  });

  it("promotes exact smoked standalone bytes and aggregates their release checksums", () => {
    const build = jobBlock("build-standalone-archives");
    const smoke = jobBlock("smoke-standalone-archives");
    const assets = jobBlock("assemble-standalone-release-assets");
    const publish = jobBlock("publish-certified");

    expect(workflow.split("npm run build:standalone --")).toHaveLength(2);
    expect(build).toContain("standalone-candidate-${{ matrix.target }}");
    expect(smoke).toContain("standalone-candidate-${{ matrix.target }}");
    expect(assets).toContain("- standalone-funnel");
    expect(smoke).toContain("installStandaloneBundle");
    expect(smoke).toContain("verifyStandaloneBundle");
    expect(smoke).toContain("manifest.sourceRevision === process.env.EXPECTED_SOURCE_REVISION");
    expect(smoke).toContain("manifest.version === process.env.EXPECTED_VERSION");
    expect(smoke).toContain("standalone-smoked-${{ matrix.target }}");
    expect(smoke).not.toContain("npm run build:standalone");
    expect(assets).toContain("pattern: standalone-smoked-*");
    expect(assets).toContain("sha256sum codegraph-*");
    expect(assets).toContain("cp install.sh install.ps1 temp/standalone-release-assets/");
    expect(assets).toContain("sha256sum codegraph-* install.sh install.ps1");
    expect(assets).toContain("name: standalone-release-assets");
    expect(publish).toContain("name: standalone-release-assets");
    expect(publish).toContain("temp/standalone-release-assets/codegraph-*");
    expect(publish).toContain("temp/standalone-release-assets/SHA256SUMS");
    expect(publish).toContain("temp/standalone-release-assets/install.sh");
    expect(publish).toContain("temp/standalone-release-assets/install.ps1");
    expect(publish).not.toContain("standalone-candidate-");
  });

  it("fails closed on incomplete reports before the first registry write", () => {
    const report = jobBlock("certification-report");
    const publish = jobBlock("publish-certified");

    expect(report).toContain("--verify-reports temp/package-smoke-reports");
    expect(report).toContain("--require-reduced");
    expect(report).toContain("assemble-certification-report.mjs");
    expect(report).toContain("certification-report-v1.json");
    expect(report).toContain("- package-funnel");
    expect(report).toContain("- standalone-funnel");
    expect(publish).toContain('report.summary?.status === "pass"');
    expect(publish).toContain("--expected-source-revision");
    expect(publish).toContain("--expected-root-version");
    expect(publish).toContain("--expected-native-version");
  });
});
