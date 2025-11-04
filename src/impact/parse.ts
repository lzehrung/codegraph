import type { Diff, FileChange, Hunk } from "./types.js";

export function parseUnifiedDiff(diffText: string): Diff {
  const files: FileChange[] = [];
  const lines = diffText.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Look for file header: diff --git a/path b/path
    if (line?.startsWith("diff --git")) {
      const fileChange = parseFileChange(lines, i);
      if (fileChange) {
        files.push(fileChange);
        i = fileChange._nextIndex;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  return { files };
}

function parseFileChange(lines: string[], startIndex: number): (FileChange & { _nextIndex: number }) | null {
  let i = startIndex;

  // Skip the diff --git line
  if (!lines[i]?.startsWith("diff --git")) return null;
  i++;

  // Parse file paths from diff --git a/path b/path
  const diffLine = lines[startIndex]!;
  const match = diffLine.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!match) return null;

  const oldPath = match[1]!;
  const newPath = match[2]!;

  // Determine change kind and actual paths by examining the diff markers
  let kind: FileChange["kind"] = "modified";
  let actualPath = newPath;
  let actualOldPath = oldPath;

  // Look for file mode indicators and ---/+++ lines
  let hasNewFileMode = false;
  let hasDeletedFileMode = false;
  let fromPath = "";
  let toPath = "";

  // Skip to find the relevant lines
  let checkIndex = i;
  while (checkIndex < lines.length && !lines[checkIndex]?.startsWith("@@")) {
    const line = lines[checkIndex];
    if (line?.startsWith("new file mode")) {
      hasNewFileMode = true;
    } else if (line?.startsWith("deleted file mode")) {
      hasDeletedFileMode = true;
    } else if (line?.startsWith("--- ")) {
      fromPath = line.slice(4);
    } else if (line?.startsWith("+++ ")) {
      toPath = line.slice(4);
    }
    checkIndex++;
  }

  // Determine kind based on mode markers and paths
  if (hasNewFileMode || fromPath === "/dev/null") {
    kind = "added";
    actualPath = newPath;
  } else if (hasDeletedFileMode || toPath === "/dev/null") {
    kind = "deleted";
    actualPath = oldPath;
  } else if (oldPath !== newPath) {
    kind = "renamed";
    actualPath = newPath;
    actualOldPath = oldPath;
  }

  // Skip the header lines we examined
  i = checkIndex;

  const hunks: Hunk[] = [];

  // Parse hunks
  while (i < lines.length) {
    const line = lines[i];

    // Look for hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    if (line?.startsWith("@@")) {
      const hunk = parseHunk(lines, i);
      if (hunk) {
        hunks.push(hunk.hunk);
        i = hunk._nextIndex;
      } else {
        i++;
      }
    } else if (line?.startsWith("diff --git")) {
      // Next file starts
      break;
    } else {
      i++;
    }
  }

  return {
    path: actualPath,
    kind,
    oldPath: kind === "renamed" ? actualOldPath : "",
    hunks,
    _nextIndex: i
  };
}

function parseHunk(lines: string[], startIndex: number): ({ hunk: Hunk; _nextIndex: number }) | null {
  const headerLine = lines[startIndex];
  if (!headerLine?.startsWith("@@")) return null;

  // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
  const match = headerLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;

  const newStart = parseInt(match[1]!);
  const hunkLines: string[] = [];
  let i = startIndex + 1;

  // Collect lines until next hunk or file
  while (i < lines.length) {
    const line = lines[i];

    if (line?.startsWith("@@") || line?.startsWith("diff --git")) {
      break;
    }

    // Only collect added/modified lines (+ and space lines in new file context)
    if (line?.startsWith("+") || line?.startsWith(" ")) {
      hunkLines.push(line);
    }

    i++;
  }

  return {
    hunk: {
      startLine: newStart,
      lines: hunkLines
    },
    _nextIndex: i
  };
}
