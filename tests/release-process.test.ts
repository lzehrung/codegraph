import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runGit } from "./helpers/git.js";

const releaseSourceFiles = [
  "scripts/release.mjs",
  "scripts/release-lib.mjs",
  "scripts/changelog-fragments-lib.mjs",
  "scripts/native-targets-lib.mjs",
  "scripts/build-native-if-available.mjs",
  "scripts/build-native-if-available-lib.mjs",
  "packages/codegraph-native/platform.js",
];

const pendingFragments = {
  "changes/unreleased/first.md": "---\nsection: Fixed\n---\n\nFirst fix.\n",
  "changes/unreleased/second.md": "---\nsection: Breaking\n---\n\nSecond change.\n",
};

function writeFixture(root: string, relative: string, contents: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function prepareReleaseProject(root: string, fragments: Record<string, string> = pendingFragments): string {
  const project = path.join(root, "project");
  for (const relative of releaseSourceFiles) {
    writeFixture(project, relative, fs.readFileSync(path.resolve(relative), "utf8"));
  }
  const manifests = {
    "package.json": {
      name: "@lzehrung/codegraph",
      version: "3.2.1",
      type: "module",
      dependencies: { "@lzehrung/codegraph-core": "3.2.1", "@lzehrung/codegraph-native": "^1.0.0" },
    },
    "packages/codegraph-core/package.json": {
      name: "@lzehrung/codegraph-core",
      version: "3.2.1",
      type: "module",
      dependencies: { "@lzehrung/codegraph-native": "^1.0.0" },
    },
    "packages/codegraph-native/package.json": {
      name: "@lzehrung/codegraph-native",
      version: "1.0.0",
      type: "module",
    },
  };
  for (const [file, manifest] of Object.entries(manifests)) {
    writeFixture(project, file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  writeFixture(project, "package-lock.json", "{}\n");
  writeFixture(
    project,
    "CHANGELOG.md",
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "## [3.2.1] - 2026-11-11",
      "",
      "- Earlier fix.",
      "",
      "[Unreleased]: https://github.com/lzehrung/codegraph/compare/v3.2.1...HEAD",
      "[3.2.1]: https://github.com/lzehrung/codegraph/releases/tag/v3.2.1",
      "",
    ].join("\n"),
  );
  for (const [file, contents] of Object.entries(fragments)) writeFixture(project, file, contents);
  runGit(project, ["init", "-q"]);
  runGit(project, ["symbolic-ref", "HEAD", "refs/heads/release-test"]);
  runGit(project, ["config", "core.autocrlf", "false"]);
  runGit(project, ["add", "."]);
  runGit(project, ["commit", "-qm", "Source release notes"]);
  runGit(root, ["init", "--bare", "-q", "remote.git"]);
  runGit(project, ["remote", "add", "origin", path.join(root, "remote.git")]);
  runGit(project, ["push", "-qu", "origin", "HEAD"]);
  return project;
}

function releaseCommandEnvironment(root: string): NodeJS.ProcessEnv {
  const directory = path.join(root, "commands");
  const stub = path.join(directory, "command.mjs");
  writeFixture(
    root,
    "commands/command.mjs",
    [
      'import fs from "node:fs";',
      "const [command, ...args] = process.argv.slice(2);",
      'fs.appendFileSync(process.env.RELEASE_COMMAND_LOG, JSON.stringify([command, ...args]) + "\\n");',
      'const failTests = process.env.RELEASE_FAIL_TESTS && command === "npm" && args.join(" ") === "run test:ci";',
      "process.exit(failTests ? 1 : 0);",
      "",
    ].join("\n"),
  );
  for (const command of ["npm", "npx", "cargo"]) {
    if (process.platform === "win32") {
      writeFixture(root, `commands/${command}.cmd`, `@"${process.execPath}" "${stub}" ${command} %*\r\n`);
    } else {
      const executable = [process.execPath, stub, command]
        .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
        .join(" ");
      writeFixture(root, `commands/${command}`, `#!/bin/sh\nexec ${executable} "$@"\n`);
      fs.chmodSync(path.join(directory, command), 0o755);
    }
  }
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const inheritedPath = pathKey ? env[pathKey] : "";
  if (pathKey) delete env[pathKey];
  return {
    ...env,
    PATH: `${directory}${path.delimiter}${inheritedPath ?? ""}`,
    GIT_AUTHOR_NAME: "Tests",
    GIT_AUTHOR_EMAIL: "tests@example.com",
    GIT_COMMITTER_NAME: "Tests",
    GIT_COMMITTER_EMAIL: "tests@example.com",
    RELEASE_COMMAND_LOG: path.join(root, "commands.jsonl"),
  };
}

describe("local release process", () => {
  it.each(["empty", "malformed"] as const)("rejects an %s fragment set before modifying any tracked file", (state) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-release-invalid-"));
    try {
      const fragments: Record<string, string> = {};
      if (state === "malformed") fragments["changes/unreleased/invalid.md"] = "---\nsection: Other\n---\n\nInvalid.\n";
      const project = prepareReleaseProject(root, fragments);
      const env = releaseCommandEnvironment(root);
      const result = spawnSync(process.execPath, ["scripts/release.mjs", "patch", "--package", "root"], {
        cwd: project,
        env,
        encoding: "utf8",
        windowsHide: true,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      if (state === "empty") expect(result.stderr).toContain("CHANGELOG.md is not prepared for version 3.2.2");
      else expect(result.stderr).toContain("expected front matter");
      expect(runGit(project, ["status", "--porcelain"])).toBe("");
      expect(runGit(project, ["rev-list", "--count", "HEAD"])).toBe("1");
      expect(runGit(project, ["tag", "--list"])).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists versions before a read-only changelog write fails, then resumes", (context) => {
    if (process.getuid?.() === 0)
      context.skip("Requires an unprivileged user that respects read-only file permissions.");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-release-readonly-"));
    const changelog = path.join(root, "project", "CHANGELOG.md");
    try {
      const project = prepareReleaseProject(root);
      const env = releaseCommandEnvironment(root);
      const source = fs.readFileSync(changelog, "utf8");
      fs.chmodSync(changelog, 0o444);
      const release = (type: string) =>
        spawnSync(process.execPath, ["scripts/release.mjs", type, "--package", "root"], {
          cwd: project,
          env,
          encoding: "utf8",
          windowsHide: true,
        });
      const failed = release("patch");
      expect(failed.status, `${failed.stdout}\n${failed.stderr}`).not.toBe(0);
      expect(failed.stderr).toMatch(/EACCES|EPERM/);
      expect(
        runGit(project, ["status", "--porcelain"])
          .split("\n")
          .map((line) => line.trim()),
      ).toEqual(["M package.json", "M packages/codegraph-core/package.json"]);
      expect(fs.readFileSync(changelog, "utf8")).toBe(source);
      for (const [file, contents] of Object.entries(pendingFragments)) {
        expect(fs.readFileSync(path.join(project, file), "utf8")).toBe(contents);
      }
      expect(runGit(project, ["rev-list", "--count", "HEAD"])).toBe("1");
      expect(runGit(project, ["tag", "--list"])).toBe("");
      fs.chmodSync(changelog, 0o644);
      const resumed = release("resume");
      expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
      expect(runGit(project, ["status", "--porcelain"])).toBe("");
      expect(runGit(project, ["rev-list", "--count", "HEAD"])).toBe("2");
      expect(runGit(project, ["show", "HEAD:package.json"])).toContain('"version": "3.2.2"');
      expect(runGit(project, ["show", "HEAD:packages/codegraph-core/package.json"])).toContain('"version": "3.2.2"');
      expect(runGit(project, ["ls-tree", "-r", "--name-only", "HEAD", "--", "changes/unreleased/"])).toBe("");
    } finally {
      if (fs.existsSync(changelog)) fs.chmodSync(changelog, 0o666);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["fresh", "after-check-failure", "prepared-with-fragments"] as const)(
    "commits consumed fragments and planned versions: %s",
    (scenario) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-release-process-"));
      try {
        const project = prepareReleaseProject(root);
        const env = releaseCommandEnvironment(root);
        const release = (type: string, failTests = false) =>
          spawnSync(process.execPath, ["scripts/release.mjs", type, "--package", "root"], {
            cwd: project,
            env: { ...env, RELEASE_FAIL_TESTS: failTests ? "1" : "" },
            encoding: "utf8",
            windowsHide: true,
          });
        let result = release("patch", scenario !== "fresh");
        if (scenario !== "fresh") {
          expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
          expect(result.stderr).toContain("test:ci failed with status 1");
          expect(runGit(project, ["rev-list", "--count", "HEAD"])).toBe("1");
          expect(runGit(project, ["tag", "--list"])).toBe("");
          expect(fs.readdirSync(path.join(project, "changes/unreleased"))).toEqual([]);
          const prepared = fs.readFileSync(path.join(project, "CHANGELOG.md"), "utf8");
          if (scenario === "prepared-with-fragments") {
            // Recreate the state after the prepared write but before any fragment unlink.
            for (const [file, contents] of Object.entries(pendingFragments)) writeFixture(project, file, contents);
          }
          result = release("resume");
          expect(fs.readFileSync(path.join(project, "CHANGELOG.md"), "utf8")).toBe(prepared);
        }
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(runGit(project, ["status", "--porcelain"])).toBe("");
        expect(runGit(project, ["rev-list", "--count", "HEAD"])).toBe("2");
        expect(runGit(project, ["diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"])).toBe(
          [
            "M\tCHANGELOG.md",
            "D\tchanges/unreleased/first.md",
            "D\tchanges/unreleased/second.md",
            "M\tpackage.json",
            "M\tpackages/codegraph-core/package.json",
          ].join("\n"),
        );
        expect(runGit(project, ["show", "HEAD:package.json"])).toContain('"version": "3.2.2"');
        expect(runGit(project, ["show", "HEAD:packages/codegraph-core/package.json"])).toContain('"version": "3.2.2"');
        expect(runGit(project, ["show", "HEAD:CHANGELOG.md"])).toContain(
          "### Breaking\n\n- Second change.\n\n### Fixed\n\n- First fix.",
        );
        expect(runGit(project, ["ls-tree", "-r", "--name-only", "HEAD", "--", "changes/unreleased/"])).toBe("");
        expect(runGit(project, ["tag", "--list"]).split("\n")).toEqual(["@lzehrung/codegraph@3.2.2", "v3.2.2"]);
        expect(runGit(project, ["ls-remote", "origin", "refs/heads/release-test"]).split("\t")[0]).toBe(
          runGit(project, ["rev-parse", "HEAD"]),
        );
        const calls = fs.readFileSync(path.join(root, "commands.jsonl"), "utf8");
        expect(calls).toContain('["npm","run","test:ci"]');
        expect(calls).toContain('["npm","run","build"]');
        expect(calls).toContain('["npx","--yes","npm@10.9.2","ci","--ignore-scripts","--dry-run"]');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
