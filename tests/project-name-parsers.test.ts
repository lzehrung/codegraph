import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseGradlePropertiesName,
  parseIniName,
  parseSetupPyName,
} from "../src/util/projectFiles/parsers.js";
import { discoverProjectFiles } from "../src/util/projectFiles.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("project name parsers", () => {
  it.each([
    {
      name: "reads section key",
      raw: "[metadata]\nname = demo-ini\n",
      section: "metadata",
      key: "name",
      expected: "demo-ini",
    },
    {
      name: "ignores other sections and comments",
      raw: "; comment\n[other]\nname = nope\n[metadata]\n# hi\nname = yes-ini\n",
      section: "metadata",
      key: "name",
      expected: "yes-ini",
    },
    {
      name: "returns null when missing",
      raw: "[metadata]\nversion = 1\n",
      section: "metadata",
      key: "name",
      expected: null,
    },
  ])("parseIniName $name", ({ raw, section, key, expected }) => {
    expect(parseIniName(raw, section, key)).toBe(expected);
  });

  it.each([
    { name: "double quotes", raw: 'name = "setup-demo"\n', expected: "setup-demo" },
    { name: "single quotes", raw: "name = 'setup-single'\n", expected: "setup-single" },
    { name: "missing", raw: "version = '1'\n", expected: null },
  ])("parseSetupPyName $name", ({ raw, expected }) => {
    expect(parseSetupPyName(raw)).toBe(expected);
  });

  it.each([
    { name: "quoted value", raw: "rootProject.name = \"gradle-demo\"\n", expected: "gradle-demo" },
    { name: "single quotes", raw: "rootProject.name = 'gradle-single'\n", expected: "gradle-single" },
    { name: "missing", raw: "org.gradle.jvmargs=-Xmx1g\n", expected: null },
  ])("parseGradlePropertiesName $name", ({ raw, expected }) => {
    expect(parseGradlePropertiesName(raw)).toBe(expected);
  });

  it("discovers the project name from a setup.cfg fixture", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-project-name-"));
    roots.push(root);
    await fs.writeFile(path.join(root, "setup.cfg"), "[metadata]\nname = fixture-project\n", "utf8");
    await fs.writeFile(path.join(root, "main.py"), "print('hi')\n", "utf8");
    const files = await discoverProjectFiles(root);
    const setupCfg = files.find((file) => file.path.replace(/\\/g, "/").endsWith("setup.cfg"));
    expect(setupCfg?.name).toBe("fixture-project");
  });
});
