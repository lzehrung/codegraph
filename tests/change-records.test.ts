import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHANGELOG_SECTIONS,
  parseChangelogFragment,
  readChangelogFragments,
  renderChangelogFragments,
  unreleasedSection,
} from "../scripts/changelog-fragments-lib.mjs";
import {
  CACHE_EPOCH_BASES,
  CACHE_EPOCH_DIRECTORY,
  GENERATED_CACHE_EPOCH_MODULE,
  deriveCacheEpoch,
  generateCacheEpochs,
  readCacheEpochs,
} from "../scripts/cache-epochs-lib.mjs";
import { finalizeChangelogForRelease, stagePreparedReleaseChangelog } from "../scripts/release-lib.mjs";

const roots: string[] = [];
const sourceChangelog = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [3.2.1] - 2026-11-11",
  "",
  "### Fixed",
  "",
  "- Previous release.",
  "",
  "[Unreleased]: https://github.com/lzehrung/codegraph/compare/v3.2.1...HEAD",
  "[3.2.1]: https://github.com/lzehrung/codegraph/releases/tag/v3.2.1",
  "",
].join("\n");

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-change-records-"));
  roots.push(root);
  return root;
}

function writeFile(root: string, relative: string, contents: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function fragment(section: string, text: string): string {
  return `---\nsection: ${section}\n---\n\n${text}\n`;
}

function seedEpochs(root: string): void {
  for (const kind of ["core", "language"])
    writeFile(root, `${CACHE_EPOCH_DIRECTORY}/${kind}/baseline.txt`, "Baseline.\n");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("changelog fragments", () => {
  it("merges all sections in canonical order and entries in code-unit filename order", () => {
    const root = tempRoot();
    for (const section of [...CHANGELOG_SECTIONS].reverse()) {
      writeFile(root, `changes/unreleased/z-${section.toLowerCase()}.md`, fragment(section, `Last ${section}.`));
      writeFile(root, `changes/unreleased/a-${section.toLowerCase()}.md`, fragment(section, `First ${section}.`));
    }
    const fragments = readChangelogFragments(root);
    const expected = CHANGELOG_SECTIONS.map(
      (section) => `### ${section}\n\n- First ${section}.\n- Last ${section}.`,
    ).join("\n\n");
    expect(renderChangelogFragments([...fragments].reverse())).toBe(expected);
    const released = finalizeChangelogForRelease(sourceChangelog, "3.2.2", "2026-11-21", fragments);
    expect(released).toContain(`## [Unreleased]\n\n## [3.2.2] - 2026-11-21\n\n${expected}\n\n## [3.2.1]`);
    expect(released).toContain("[Unreleased]: https://github.com/lzehrung/codegraph/compare/v3.2.2...HEAD");
  });

  it("accepts CRLF and wrapped entry paragraphs", () => {
    expect(
      parseChangelogFragment("wrapped.md", fragment("Fixed", "First line\n  continues.").replaceAll("\n", "\r\n")),
    ).toEqual({
      name: "wrapped.md",
      section: "Fixed",
      text: "First line continues.",
    });
  });

  it.each([
    ["bad name.md", fragment("Fixed", "Entry.")],
    ["../escape.md", fragment("Fixed", "Entry.")],
    ["entry.md", fragment("Other", "Entry.")],
    ["entry.md", fragment("Fixed", "")],
    ["entry.md", "section: Fixed\nEntry.\n"],
    ["entry.md", fragment("Fixed", "### Heading")],
    ["entry.md", fragment("Fixed", "- A bullet")],
    ["entry.md", fragment("Fixed", "One.\n\nTwo.")],
    ["entry.md", "---\nsection: Fixed\nextra: ignored\n---\n\nEntry.\n"],
  ])("rejects malformed fragment %s (%s)", (name, contents) => {
    expect(() => parseChangelogFragment(name, contents)).toThrow();
  });

  it("accepts an empty directory and preserves an already prepared release", () => {
    const root = tempRoot();
    expect(readChangelogFragments(root)).toEqual([]);
    fs.mkdirSync(path.join(root, "changes/unreleased"), { recursive: true });
    expect(readChangelogFragments(root)).toEqual([]);
    expect(renderChangelogFragments([])).toBe("");
    expect(() => finalizeChangelogForRelease(sourceChangelog, "3.2.2", "2026-11-21", [])).toThrow();
    const prepared = finalizeChangelogForRelease(sourceChangelog, "3.2.2", "2026-11-21", [
      parseChangelogFragment("repair.md", fragment("Fixed", "Repair.")),
    ]);
    expect(finalizeChangelogForRelease(prepared, "3.2.2", "2026-11-22", [])).toBe(prepared);
    expect(
      finalizeChangelogForRelease(prepared, "3.2.2", "2026-11-22", [
        parseChangelogFragment("repair.md", fragment("Fixed", "Repair.")),
      ]),
    ).toBe(prepared);
  });

  it.each(["- Direct note.", "Arbitrary prose.", "### Fixed"])("rejects direct Unreleased edits: %s", (entry) => {
    expect(() =>
      unreleasedSection(sourceChangelog.replace("## [Unreleased]\n", `## [Unreleased]\n\n${entry}\n`)),
    ).toThrow("add a changes/unreleased/<slug>.md fragment");
  });

  it("rejects fragments that are directories and refuses to consume changed source notes", () => {
    const root = tempRoot();
    writeFile(root, "CHANGELOG.md", sourceChangelog);
    writeFile(root, "changes/unreleased/repair.md", fragment("Fixed", "Repair."));
    const prepared = finalizeChangelogForRelease(sourceChangelog, "3.2.2", "2026-11-21", readChangelogFragments(root));
    writeFile(root, "changes/unreleased/extra.md", fragment("Added", "A later note."));
    expect(() => stagePreparedReleaseChangelog(root, prepared, "3.2.2")).toThrow(
      "Restore the consumed fragments from the release source revision (see PUBLISHING.md).",
    );
    expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(sourceChangelog);
    expect(readChangelogFragments(root)).toHaveLength(2);
    fs.mkdirSync(path.join(root, "changes/unreleased/nested"));
    expect(() => readChangelogFragments(root)).toThrow("regular file");
  });

  it("ignores dotfiles and rejects other stray fragment names clearly", () => {
    const root = tempRoot();
    writeFile(root, "changes/unreleased/repair.md", fragment("Fixed", "Repair."));
    const expected = readChangelogFragments(root);
    for (const name of [".DS_Store", ".gitkeep"]) writeFile(root, `changes/unreleased/${name}`, "ignored\n");
    expect(readChangelogFragments(root)).toEqual(expected);
    for (const name of [".slug.md", ".slug.txt"]) {
      writeFile(root, `changes/unreleased/${name}`, fragment("Fixed", "Must not be silently ignored."));
      expect(() => readChangelogFragments(root)).toThrow("expected <slug>.md");
      fs.unlinkSync(path.join(root, "changes/unreleased", name));
    }
    writeFile(root, "changes/unreleased/README.md", "Not a fragment.\n");
    expect(() => readChangelogFragments(root)).toThrow("expected <slug>.md");
  });

  it("consumes an already prepared matching fragment set and rejects a partially consumed set", () => {
    const root = tempRoot();
    const first = "changes/unreleased/first.md";
    const second = "changes/unreleased/second.md";
    writeFile(root, first, fragment("Fixed", "First."));
    writeFile(root, second, fragment("Breaking", "Second."));
    const fragments = readChangelogFragments(root);
    const prepared = finalizeChangelogForRelease(sourceChangelog, "3.2.2", "2026-11-21", fragments);
    writeFile(root, "CHANGELOG.md", prepared);
    fs.unlinkSync(path.join(root, first));
    expect(() => stagePreparedReleaseChangelog(root, prepared, "3.2.2")).toThrow(
      "Restore the consumed fragments from the release source revision (see PUBLISHING.md).",
    );
    expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(prepared);
    expect(readChangelogFragments(root)).toHaveLength(1);
    writeFile(root, first, fragment("Fixed", "First."));
    stagePreparedReleaseChangelog(root, prepared, "3.2.2");
    expect(readChangelogFragments(root)).toEqual([]);
    expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(prepared);
  });

  it("validates the repository's actual change records", () => {
    const result = spawnSync(process.execPath, [path.resolve("scripts/check-changes.mjs")], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Change records valid:");
  });

  it("checks fragments, empty Unreleased content, and epoch reasons through the check command", () => {
    const root = tempRoot();
    writeFile(root, "CHANGELOG.md", sourceChangelog);
    seedEpochs(root);
    const run = () =>
      spawnSync(process.execPath, [path.resolve("scripts/check-changes.mjs")], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      });
    expect(run().status).toBe(0);
    writeFile(root, "changes/unreleased/repair.md", fragment("Fixed", "Repair."));
    expect(run().status).toBe(0);
    writeFile(root, "CHANGELOG.md", sourceChangelog.replace("## [Unreleased]\n", "## [Unreleased]\n- Forbidden.\n"));
    expect(run().stderr).toContain("Do not edit the Unreleased section");
    writeFile(root, "CHANGELOG.md", sourceChangelog);
    writeFile(root, "changes/unreleased/repair.md", fragment("Invalid", "Repair."));
    expect(run().status).not.toBe(0);
    writeFile(root, "changes/unreleased/repair.md", fragment("Fixed", "Repair."));
    writeFile(root, `${CACHE_EPOCH_DIRECTORY}/core/bad.txt`, "Two\nlines\n");
    expect(run().stderr).toContain("one nonempty line");
  });
});

describe("additive cache epochs", () => {
  it.each(["core", "language"])("derives a stable safe-integer %s token from the sorted filename set", (kind) => {
    const names = ["zeta.txt", "alpha.txt"];
    const epoch = deriveCacheEpoch(kind, names);
    expect(deriveCacheEpoch(kind, [...names].reverse())).toBe(epoch);
    expect(names).toEqual(["zeta.txt", "alpha.txt"]);
    expect(Number.isSafeInteger(epoch)).toBe(true);
    expect(epoch).not.toBe(CACHE_EPOCH_BASES.core);
    expect(epoch).not.toBe(CACHE_EPOCH_BASES.language);
    expect(epoch).not.toBe(deriveCacheEpoch(kind, ["alpha.txt"]));
    expect(epoch).not.toBe(deriveCacheEpoch(kind, ["zeta.txt"]));
    expect(deriveCacheEpoch(kind, ["alpha.txt"])).not.toBe(deriveCacheEpoch(kind, ["zeta.txt"]));
    expect(epoch).not.toBe(deriveCacheEpoch(kind, []));
    expect(() => deriveCacheEpoch(kind, ["alpha.txt", "alpha.txt"])).toThrow("duplicate");
    expect(() => deriveCacheEpoch(kind, ["../escape.txt"])).toThrow("Invalid");
  });

  it("generates a self-contained module without rewriting it for unchanged inputs", () => {
    const root = tempRoot();
    seedEpochs(root);
    const epochs = generateCacheEpochs(root);
    const target = path.join(root, GENERATED_CACHE_EPOCH_MODULE);
    const source = fs.readFileSync(target, "utf8");
    expect(source).toContain(`CORE_ALGORITHM_EPOCH: number = ${epochs.core}`);
    expect(source).toContain(`LANGUAGE_BEHAVIOR_EPOCH: number = ${epochs.language}`);
    expect(source).not.toMatch(/readFile|readdir|node:fs|epochs\/core/);
    const previousTime = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(target, previousTime, previousTime);
    expect(generateCacheEpochs(root)).toEqual(epochs);
    expect(fs.statSync(target).mtimeMs).toBe(previousTime.getTime());
    writeFile(root, `${CACHE_EPOCH_DIRECTORY}/core/new-facts.txt`, "Changed facts.\n");
    const changed = generateCacheEpochs(root);
    expect(changed.core).not.toBe(epochs.core);
    expect(changed.language).toBe(epochs.language);
    expect(readCacheEpochs(root)).toEqual(changed);
    const changedSource = fs.readFileSync(target, "utf8");
    expect(changedSource).toContain(`CORE_ALGORITHM_EPOCH: number = ${changed.core}`);
    expect(changedSource).toContain(`LANGUAGE_BEHAVIOR_EPOCH: number = ${changed.language}`);
    writeFile(root, `${CACHE_EPOCH_DIRECTORY}/language/new-hook.txt`, "Changed hook.\n");
    const changedLanguage = generateCacheEpochs(root);
    expect(changedLanguage.core).toBe(changed.core);
    expect(changedLanguage.language).not.toBe(changed.language);
    const changedLanguageSource = fs.readFileSync(target, "utf8");
    expect(changedLanguageSource).toContain(`CORE_ALGORITHM_EPOCH: number = ${changedLanguage.core}`);
    expect(changedLanguageSource).toContain(`LANGUAGE_BEHAVIOR_EPOCH: number = ${changedLanguage.language}`);
  });

  it.each(["core", "language"])("ignores dotfiles and rejects stray %s entry names clearly", (kind) => {
    const root = tempRoot();
    seedEpochs(root);
    const expected = readCacheEpochs(root);
    for (const name of [".DS_Store", ".gitkeep"])
      writeFile(root, `${CACHE_EPOCH_DIRECTORY}/${kind}/${name}`, "ignored\n");
    expect(readCacheEpochs(root)).toEqual(expected);
    for (const name of [".slug.txt", ".slug.md"]) {
      writeFile(root, `${CACHE_EPOCH_DIRECTORY}/${kind}/${name}`, "Must not be silently ignored.\n");
      expect(() => readCacheEpochs(root)).toThrow("expected <slug>.txt");
      fs.unlinkSync(path.join(root, CACHE_EPOCH_DIRECTORY, kind, name));
    }
    writeFile(root, `${CACHE_EPOCH_DIRECTORY}/${kind}/README.md`, "Not an epoch.\n");
    expect(() => readCacheEpochs(root)).toThrow("expected <slug>.txt");
  });

  it.for(["core", "language"])("merges two branches' fragments and %s epochs", (kind, context) => {
    const versionResult = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
    expect(versionResult.status, versionResult.stderr).toBe(0);
    const version = /git version (\d+)\.(\d+)/.exec(versionResult.stdout);
    if (!version) throw new Error(`Unrecognized Git version: ${versionResult.stdout}`);
    const major = Number(version[1]);
    const minor = Number(version[2]);
    const supportsTreeMerge = major > 2 || (major === 2 && minor >= 38);
    if (!supportsTreeMerge) context.skip("Requires Git 2.38 or newer for merge-tree --write-tree.");
    const root = tempRoot();
    const environment = {
      ...process.env,
      GIT_AUTHOR_NAME: "Tests",
      GIT_AUTHOR_EMAIL: "tests@example.com",
      GIT_COMMITTER_NAME: "Tests",
      GIT_COMMITTER_EMAIL: "tests@example.com",
    };
    const git = (args: string[], input?: string, index?: string): string => {
      const env = { ...environment };
      if (index) Object.assign(env, { GIT_INDEX_FILE: path.join(root, index) });
      const result = spawnSync("git", args, { cwd: root, env, input, encoding: "utf8", windowsHide: true });
      expect(result.status, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(0);
      return result.stdout.trim();
    };
    git(["init", "--bare", "--quiet"]);
    const emptyTree = git(["hash-object", "-w", "-t", "tree", "--stdin"], "");
    const base = git(["commit-tree", emptyTree, "-m", "base"]);
    const makeBranch = (name: string, section: string): string => {
      const index = `index-${name}`;
      git(["read-tree", base], undefined, index);
      const files = {
        [`changes/unreleased/${name}.md`]: fragment(section, `${name} note.`),
        [`${CACHE_EPOCH_DIRECTORY}/${kind}/${name}.txt`]: `${name} cache change.\n`,
      };
      for (const [file, contents] of Object.entries(files)) {
        const blob = git(["hash-object", "-w", "--stdin"], contents);
        git(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], undefined, index);
      }
      const tree = git(["write-tree"], undefined, index);
      const commit = git(["commit-tree", tree, "-p", base, "-m", name]);
      git(["update-ref", `refs/heads/${name}`, commit]);
      return commit;
    };
    makeBranch("alpha", "Fixed");
    makeBranch("zeta", "Added");
    const mergedTree = git(["merge-tree", "--write-tree", "alpha", "zeta"]);
    const files = git(["ls-tree", "-r", "--name-only", mergedTree]).split("\n");
    expect(files).toHaveLength(4);
    const names = files.filter((file) => file.endsWith(".txt")).map((file) => path.basename(file));
    const alpha = deriveCacheEpoch(kind, ["alpha.txt"]);
    const zeta = deriveCacheEpoch(kind, ["zeta.txt"]);
    const merged = deriveCacheEpoch(kind, names);
    expect(merged).not.toBe(alpha);
    expect(merged).not.toBe(zeta);
    const fragments = files
      .filter((file) => file.endsWith(".md"))
      .map((file) => parseChangelogFragment(path.basename(file), git(["show", `${mergedTree}:${file}`])));
    expect(renderChangelogFragments(fragments)).toBe("### Added\n\n- zeta note.\n\n### Fixed\n\n- alpha note.");
    console.log(
      JSON.stringify({ demonstration: "conflict-free-merge", kind, files: files.length, alpha, zeta, merged }),
    );
  });
});
