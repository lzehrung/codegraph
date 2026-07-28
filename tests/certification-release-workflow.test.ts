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
  it("uses the plan, build, assemble, certify, and publish DAG", () => {
    const assemble = jobBlock("assemble-release-candidates");
    const security = jobBlock("security-production");
    const smoke = jobBlock("package-smoke");
    const report = jobBlock("certification-report");
    const publish = jobBlock("publish-certified");

    expect(assemble).toContain("- build-native-artifacts");
    expect(security).toContain("- assemble-release-candidates");
    expect(smoke).toContain("- security-production");
    expect(report).toContain("- package-smoke");
    expect(report).toContain("- package-smoke-reduced");
    expect(report).toContain("- semantic-release");
    expect(report).toContain("- fixture-hermeticity");
    expect(publish).toContain("- certification-report");
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

  it("executes every runtime target and keeps Windows ARM64 structural-only", () => {
    const smoke = jobBlock("package-smoke");
    const runtimeTargets = [
      "win32-x64-msvc",
      "linux-x64-gnu",
      "linux-arm64-gnu",
      "linux-x64-musl",
      "linux-arm64-musl",
      "darwin-x64",
      "darwin-arm64",
    ];

    for (const target of runtimeTargets) {
      expect(smoke).toMatch(new RegExp(`target: ${target}\\n\\s+mode: runtime`));
    }
    expect(smoke).toMatch(/target: win32-arm64-msvc\n\s+mode: structural/);
    expect(smoke).not.toMatch(/target: win32-arm64-msvc\n\s+mode: runtime/);
    expect(smoke).toMatch(/target: linux-x64-musl\n\s+mode: runtime\n\s+alpine: true/);
    expect(smoke).toMatch(/target: linux-arm64-musl\n\s+mode: runtime\n\s+alpine: true/);
    expect(smoke).toContain("node:24-alpine");
  });

  it("fails closed on incomplete reports before the first registry write", () => {
    const report = jobBlock("certification-report");
    const publish = jobBlock("publish-certified");

    expect(report).toContain("--verify-reports temp/package-smoke-reports");
    expect(report).toContain("--require-reduced");
    expect(report).toContain("assemble-certification-report.mjs");
    expect(report).toContain("certification-report-v1.json");
    expect(publish).toContain('report.summary?.status === "pass"');
    expect(publish).toContain("--expected-source-revision");
    expect(publish).toContain("--expected-root-version");
    expect(publish).toContain("--expected-native-version");
  });
});
