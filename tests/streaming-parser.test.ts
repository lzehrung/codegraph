import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { parseUnifiedDiffStreaming, parseUnifiedDiff } from "../src/impact/parse.js";

describe("Streaming Diff Parser", () => {
  const sampleDiff = `diff --git a/added.ts b/added.ts
new file mode 100644
--- /dev/null
+++ b/added.ts
@@ -0,0 +1,1 @@
+new
diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
--- a/deleted.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-old
diff --git a/modified.ts b/modified.ts
--- a/modified.ts
+++ b/modified.ts
@@ -1,1 +1,1 @@
-old
+new
diff --git a/renamed_old.ts b/renamed_new.ts
similarity index 92%
rename from renamed_old.ts
rename to renamed_new.ts
--- a/renamed_old.ts
+++ b/renamed_new.ts
@@ -1,1 +1,1 @@
-old
+new
diff --git a/source.ts b/copied.ts
copy from source.ts
copy to copied.ts
--- a/source.ts
+++ b/copied.ts
@@ -1,1 +1,1 @@
-old
+new
diff --git a/assets/logo.png b/assets/logo.png
old mode 100644
new mode 100755
Binary files a/assets/logo.png and b/assets/logo.png differ
`;

  it("should parse streaming diff identically to synchronous parser", async () => {
    const syncResult = parseUnifiedDiff(sampleDiff);
    const stream = Readable.from([sampleDiff]);
    const streamResult = await parseUnifiedDiffStreaming(stream);

    expect(streamResult).toEqual(syncResult);

    expect(streamResult.files).toHaveLength(6);

    const added = streamResult.files.find((f) => f.path === "added.ts");
    expect(added?.kind).toBe("added");

    const deleted = streamResult.files.find((f) => f.path === "deleted.ts");
    expect(deleted?.kind).toBe("deleted");

    const modified = streamResult.files.find((f) => f.path === "modified.ts");
    expect(modified?.kind).toBe("modified");

    const renamed = streamResult.files.find((f) => f.path === "renamed_new.ts");
    expect(renamed?.kind).toBe("renamed");
    expect(renamed?.oldPath).toBe("renamed_old.ts");
    expect(renamed?.similarityIndex).toBe(92);

    const copied = streamResult.files.find((f) => f.path === "copied.ts");
    expect(copied?.kind).toBe("added");
    expect(copied?.oldPath).toBe("source.ts");

    const binary = streamResult.files.find((f) => f.path === "assets/logo.png");
    expect(binary?.isBinary).toBe(true);
    expect(binary?.modeChanged).toBe(true);
  });

  it("should handle large chunks correctly", async () => {
    const stream = Readable.from([sampleDiff]);
    const result = await parseUnifiedDiffStreaming(stream);
    expect(result.files).toHaveLength(6);
  });

  it("should parse very large hunks consistently", async () => {
    const oldLines = Array.from({ length: 2500 }, (_, idx) => `old_${idx}`);
    const newLines = Array.from({ length: 2500 }, (_, idx) => `new_${idx}`);
    const hunkLines: string[] = [];
    for (let idx = 0; idx < oldLines.length; idx += 1) {
      hunkLines.push(`-${oldLines[idx]}`);
      hunkLines.push(`+${newLines[idx]}`);
    }

    const largeDiff = `diff --git a/large.ts b/large.ts
--- a/large.ts
+++ b/large.ts
@@ -1,2500 +1,2500 @@
${hunkLines.join("\n")}
`;

    const syncResult = parseUnifiedDiff(largeDiff);
    const streamResult = await parseUnifiedDiffStreaming(Readable.from([largeDiff]));

    expect(streamResult).toEqual(syncResult);
    const parsedHunk = streamResult.files[0]?.hunks[0];
    expect(parsedHunk?.lines.length).toBe(5000);
  });

  it("should handle multi-line chunks correctly", async () => {
    const chunks = sampleDiff.split("\n").map((l) => l + "\n");
    const stream = Readable.from(chunks);
    const result = await parseUnifiedDiffStreaming(stream);
    expect(result.files).toHaveLength(6);
  });

  it("should handle CRLF line endings split across buffer chunks", async () => {
    const crlfDiff = sampleDiff.replace(/\n/g, "\r\n");
    const syncResult = parseUnifiedDiff(crlfDiff);
    const stream = Readable.from(Array.from(crlfDiff, (char) => Buffer.from(char)));
    const streamResult = await parseUnifiedDiffStreaming(stream);

    expect(streamResult).toEqual(syncResult);
  });

  it("should preserve UTF-8 characters split across buffer chunks", async () => {
    const utf8Diff = `diff --git a/utf8.ts b/utf8.ts
--- a/utf8.ts
+++ b/utf8.ts
@@ -1,1 +1,1 @@
-const label = "plain";
+const label = "caf\u00e9";
`;
    const bytes = Buffer.from(utf8Diff, "utf8");
    const splitMarker = Buffer.from("\u00e9", "utf8");
    const splitIndex = bytes.indexOf(splitMarker) + 1;
    const stream = Readable.from([bytes.subarray(0, splitIndex), bytes.subarray(splitIndex)]);
    const streamResult = await parseUnifiedDiffStreaming(stream);

    expect(splitIndex).toBeGreaterThan(0);
    expect(streamResult).toEqual(parseUnifiedDiff(utf8Diff));
    expect(streamResult.files[0]?.hunks[0]?.lines).toContain('+const label = "caf\u00e9";');
  });

  it("should propagate stream errors", async () => {
    const stream = new Readable({
      read() {
        this.emit("error", new Error("stream error"));
      },
    });

    await expect(parseUnifiedDiffStreaming(stream)).rejects.toThrow("stream error");
  });
});

describe("Quoted diff --git headers (C12)", () => {
  it("decodes a non-ASCII path quoted and octal-escaped on both sides", () => {
    // Real `git diff` output for a non-ASCII filename: git quotes the path and escapes each
    // UTF-8 byte independently as \\NNN (octal). Recombining those bytes correctly requires
    // decoding them as raw bytes and re-parsing as UTF-8, not as individual code points.
    const diffText = `diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"
index 0000000..1111111 100644
--- "a/caf\\303\\251.ts"
+++ "b/caf\\303\\251.ts"
@@ -1 +1 @@
-old
+new
`;
    const parsed = parseUnifiedDiff(diffText);
    expect(parsed.files).toEqual([expect.objectContaining({ path: "café.ts", kind: "modified" })]);
  });

  it("decodes a rename where only the destination side needs quoting", () => {
    const diffText = `diff --git a/plain.ts "b/\\346\\227\\245\\346\\234\\254/renamed.ts"
similarity index 100%
rename from plain.ts
rename to "\\346\\227\\245\\346\\234\\254/renamed.ts"
`;
    const parsed = parseUnifiedDiff(diffText);
    expect(parsed.files).toEqual([
      expect.objectContaining({ path: "日本/renamed.ts", oldPath: "plain.ts", kind: "renamed" }),
    ]);
  });

  it("decodes an escaped double-quote character inside a quoted filename", () => {
    // A literal `"` in a path is itself one of the characters git must quote/escape; this
    // exercises the \\" escape specifically, independent of any octal-byte decoding.
    const diffText = `diff --git "a/quote\\"test.ts" "b/quote\\"test.ts"
index 0000000..1111111 100644
--- "a/quote\\"test.ts"
+++ "b/quote\\"test.ts"
@@ -1 +1 @@
-old
+new
`;
    const parsed = parseUnifiedDiff(diffText);
    expect(parsed.files).toEqual([expect.objectContaining({ path: 'quote"test.ts', kind: "modified" })]);
  });

  it("preserves trailing whitespace in an unquoted destination header path", () => {
    const pathWithTrailingSpace = `trailing${" "}`;
    const diffText = [
      `diff --git a/${pathWithTrailingSpace} b/${pathWithTrailingSpace}`,
      "index 0000000..1111111 100644",
      `--- a/${pathWithTrailingSpace}`,
      `+++ b/${pathWithTrailingSpace}`,
      "@@ -0,0 +1 @@",
      "+export const value = 1;",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diffText);

    expect(parsed.files).toEqual([expect.objectContaining({ path: pathWithTrailingSpace, kind: "modified" })]);
  });

  it("decodes escaped copy paths across diff and file headers", () => {
    const diffText = `diff --git "a/source\\t.ts" "b/copied\\t.ts"
similarity index 100%
copy from "source\\t.ts"
copy to "copied\\t.ts"
--- "a/source\\t.ts"
+++ "b/copied\\t.ts"
@@ -1 +1 @@
-old
+new
`;

    expect(parseUnifiedDiff(diffText).files).toEqual([
      expect.objectContaining({ kind: "added", path: "copied\t.ts", oldPath: "source\t.ts" }),
    ]);
  });

  it("disambiguates an unquoted path containing the literal header separator text using --- and +++", () => {
    // Git does not C-quote a plain space, so a real filename containing " b/" makes the
    // `diff --git a/X b/Y` line ambiguous at the regex level (multiple valid " b/" splits).
    // The single-path `---`/`+++` lines are never ambiguous and must win over the header
    // guess.
    const diffText = [
      "diff --git a/foo b/bar b/foo b/bar",
      "index 0000000..1111111 100644",
      "--- a/foo b/bar",
      "+++ b/foo b/bar",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diffText);
    expect(parsed.files).toEqual([expect.objectContaining({ path: "foo b/bar", kind: "modified" })]);
  });

  it("disambiguates an ambiguous added-file path using the +++ header", () => {
    const diffText = [
      "diff --git a/new b/file.ts b/new b/file.ts",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/new b/file.ts",
      "@@ -0,0 +1 @@",
      "+export const value = 1;",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diffText);
    expect(parsed.files).toEqual([expect.objectContaining({ path: "new b/file.ts", kind: "added" })]);
  });

  it("disambiguates an ambiguous deleted-file path using the --- header", () => {
    const diffText = [
      "diff --git a/old b/file.ts b/old b/file.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/old b/file.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const value = 1;",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diffText);
    expect(parsed.files).toEqual([expect.objectContaining({ path: "old b/file.ts", kind: "deleted" })]);
  });

  it("strips Git's trailing disambiguation tab from an unquoted --- / +++ path containing a space", () => {
    // Real `git diff` appends a bare trailing tab to `---`/`+++` lines whenever the
    // pathname contains a space, quoted or not (a holdover from the traditional `diff -u`
    // timestamp field). It must not become part of the resolved path.
    const diffText = [
      "diff --git a/with space.ts b/with space.ts",
      "index 0000000..1111111 100644",
      "--- a/with space.ts\t",
      "+++ b/with space.ts\t",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diffText);
    expect(parsed.files).toEqual([expect.objectContaining({ path: "with space.ts", kind: "modified" })]);
  });

  it("strips Git's trailing disambiguation tab from a quoted --- / +++ path", () => {
    // The trailing tab sits outside the closing quote, so leaving it in place would make
    // decodeGitPath's `endsWith('"')` check fail and return the raw quoted text unparsed.
    const diffText = [
      'diff --git "a/caf\\303\\251 with space.ts" "b/caf\\303\\251 with space.ts"',
      "index 0000000..1111111 100644",
      '--- "a/caf\\303\\251 with space.ts"\t',
      '+++ "b/caf\\303\\251 with space.ts"\t',
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diffText);
    expect(parsed.files).toEqual([expect.objectContaining({ path: "café with space.ts", kind: "modified" })]);
  });
});
