import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProjectIndexFromFiles, getUndocumentedApiSurface } from "../src/index.js";
import { captureCli } from "./helpers/cli.js";

const fixtures = [
  {
    language: "typescript",
    extension: "ts",
    source: "/** documented */\nexport function documented() {}\nexport function undocumented() {}\n",
    captures: true,
  },
  {
    language: "tsx",
    extension: "tsx",
    source:
      "/** documented */\nexport function documented() { return <div />; }\nexport function undocumented() { return <div />; }\n",
    captures: true,
  },
  {
    language: "javascript",
    extension: "js",
    source: "/** documented */\nexport function documented() {}\nexport function undocumented() {}\n",
    captures: true,
  },
  {
    language: "python",
    extension: "py",
    source: "# documented\ndef documented():\n    pass\n\ndef undocumented():\n    pass\n",
    captures: true,
  },
  {
    language: "php",
    extension: "php",
    source: "<?php\n/** documented */\nfunction documented() {}\nfunction undocumented() {}\n",
    captures: false,
  },
  {
    language: "go",
    extension: "go",
    source: "package sample\n// documented\nfunc Documented() {}\nfunc Undocumented() {}\n",
    captures: true,
  },
  {
    language: "java",
    extension: "java",
    source: "/** documented */\npublic class Documented {}\npublic class Undocumented {}\n",
    captures: true,
  },
  {
    language: "c",
    extension: "c",
    source: "/** documented */\nint documented(void) { return 1; }\nint undocumented(void) { return 2; }\n",
    captures: false,
  },
  {
    language: "cpp",
    extension: "cpp",
    source: "/** documented */\nint documented() { return 1; }\nint undocumented() { return 2; }\n",
    captures: false,
  },
  {
    language: "csharp",
    extension: "cs",
    source: "/** documented */\npublic class Documented {}\npublic class Undocumented {}\n",
    captures: true,
  },
  {
    language: "kotlin",
    extension: "kt",
    source: "/** documented */\nfun documented() = 1\nfun undocumented() = 2\n",
    captures: true,
  },
  {
    language: "ruby",
    extension: "rb",
    source: "# documented\nclass Documented\nend\nclass Undocumented\nend\n",
    captures: false,
  },
  {
    language: "rust",
    extension: "rs",
    source: "/// documented\npub fn documented() {}\npub fn undocumented() {}\n",
    captures: true,
  },
  {
    language: "swift",
    extension: "swift",
    source: "/// documented\npublic func documented() {}\npublic func undocumented() {}\n",
    captures: false,
  },
  {
    language: "zig",
    extension: "zig",
    source: "/// documented\npub fn documented() void {}\npub fn undocumented() void {}\n",
    captures: true,
  },
  {
    language: "sql",
    extension: "sql",
    source: "-- documented\nCREATE TABLE documented (id INTEGER);\nCREATE TABLE undocumented (id INTEGER);\n",
    captures: false,
  },
  {
    language: "scss",
    extension: "scss",
    source: "/** documented */\n@mixin documented { color: red; }\n@mixin undocumented { color: blue; }\n",
    captures: true,
  },
] as const;

describe("undocumented public API", () => {
  it.each(fixtures)("classifies $language exports", async (fixture) => {
    const { extension, source, captures } = fixture;
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-undocumented-"));
    try {
      const file = path.join(root, `fixture.${extension}`);
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndexFromFiles(root, [file], { native: "on", cache: "off" });
      const exported = [...index.byFile.values()].flatMap((mod) =>
        mod.exports.filter((entry) => entry.type === "local"),
      );
      const documented = exported.find((entry) => entry.target.localName.toLowerCase() === "documented");
      const undocumented = exported.find((entry) => entry.target.localName.toLowerCase() === "undocumented");
      expect(documented).toBeDefined();
      expect(undocumented).toBeDefined();
      expect(!!documented?.target.docstring).toBe(captures);
      expect(undocumented?.target.docstring).toBeUndefined();
      const reported = getUndocumentedApiSurface(index);
      expect(reported.map((item) => item.name.toLowerCase())).toContain("undocumented");
      expect(reported.some((item) => item.name.toLowerCase() === "documented")).toBe(!captures);
      expect(reported.find((item) => item.name.toLowerCase() === "undocumented")).toMatchObject({
        file: file.replaceAll("\\", "/"),
        kind: expect.any(String),
        range: {
          start: { line: expect.any(Number) },
          end: { line: expect.any(Number) },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints pretty locations and structured JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-undocumented-cli-"));
    try {
      await writeFile(
        path.join(root, "api.ts"),
        "/** documented */\nexport function documented() {}\nexport function undocumented() {}\n",
        "utf8",
      );
      const pretty = await captureCli(["apisurface", "--root", root, "--undocumented", "--pretty"]);
      const json = await captureCli(["apisurface", "--root", root, "--undocumented", "--json"]);
      expect(pretty.exitCode).toBeUndefined();
      expect(pretty.stdout).toContain("api.ts:3:17-3:");
      expect(pretty.stdout).toContain("undocumented (function, exported as undocumented)");
      expect(pretty.stdout).not.toContain("documented (function, exported as documented)");
      expect(json.exitCode).toBeUndefined();
      const items: unknown = JSON.parse(json.stdout);
      expect(items).toEqual([
        expect.objectContaining({
          file: "api.ts",
          name: "undocumented",
          kind: "function",
          exportedAs: "undocumented",
          range: { start: expect.objectContaining({ line: 3 }), end: expect.any(Object) },
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
