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
    
    const added = streamResult.files.find(f => f.path === "added.ts");
    expect(added?.kind).toBe("added");
    
    const deleted = streamResult.files.find(f => f.path === "deleted.ts");
    expect(deleted?.kind).toBe("deleted");
    
    const modified = streamResult.files.find(f => f.path === "modified.ts");
    expect(modified?.kind).toBe("modified");
    
    const renamed = streamResult.files.find(f => f.path === "renamed_new.ts");
    expect(renamed?.kind).toBe("renamed");
    expect(renamed?.oldPath).toBe("renamed_old.ts");
    expect(renamed?.similarityIndex).toBe(92);

    const copied = streamResult.files.find(f => f.path === "copied.ts");
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
    const chunks = sampleDiff.split("\n").map(l => l + "\n");
    const stream = Readable.from(chunks);
    const result = await parseUnifiedDiffStreaming(stream);
    expect(result.files).toHaveLength(6);
  });

  it("should propagate stream errors", async () => {
    const stream = new Readable({
      read() {
        this.emit("error", new Error("stream error"));
      }
    });
    
    await expect(parseUnifiedDiffStreaming(stream)).rejects.toThrow("stream error");
  });
});
