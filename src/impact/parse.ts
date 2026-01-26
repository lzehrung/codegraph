import readline from "node:readline";
import { Readable } from "node:stream";
import type { Diff, FileChange, Hunk } from "./types.js";

export function parseUnifiedDiff(diffText: string): Diff {
  const files: FileChange[] = [];
  const lines = diffText.split(/\r?\n/);

  let currentFile: any = null;
  let currentHunk: Hunk | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (currentFile) {
        if (currentHunk) currentFile.hunks.push(currentHunk);
        finalizeFile(currentFile);
        files.push(currentFile);
      }
      currentFile = initiateFile(line);
      currentHunk = null;
    } else if (currentFile) {
      if (line.startsWith("@@")) {
        if (currentHunk) {
          currentFile.hunks.push(currentHunk);
        }
        currentHunk = initiateHunk(line);
      } else if (currentHunk) {
        if (!line.startsWith("\\")) {
          const prefix = line[0];
          if (prefix === "+" || prefix === "-" || prefix === " ") {
            currentHunk.lines.push(line);
          }
        }
      } else {
        // Parsing header
        if (line.startsWith("new file mode")) {
          currentFile._hasNewFileMode = true;
        } else if (line.startsWith("deleted file mode")) {
          currentFile._hasDeletedFileMode = true;
        } else if (line.startsWith("--- ")) {
          currentFile._fromPath = line.slice(4);
        } else if (line.startsWith("+++ ")) {
          currentFile._toPath = line.slice(4);
        }
      }
    }
  }

  if (currentFile) {
    if (currentHunk) currentFile.hunks.push(currentHunk);
    finalizeFile(currentFile);
    files.push(currentFile);
  }

  return { files };
}

export async function parseUnifiedDiffStreaming(
  stream: Readable,
): Promise<Diff> {
  const rl = readline.createInterface({
    input: stream,
    terminal: false,
  });

  const files: FileChange[] = [];
  let currentFile: any = null;
  let currentHunk: Hunk | null = null;

  for await (const line of rl) {
    if (line.startsWith("diff --git")) {
      if (currentFile) {
        if (currentHunk) currentFile.hunks.push(currentHunk);
        finalizeFile(currentFile);
        files.push(currentFile);
      }
      currentFile = initiateFile(line);
      currentHunk = null;
    } else if (currentFile) {
      if (line.startsWith("@@")) {
        if (currentHunk) {
          currentFile.hunks.push(currentHunk);
        }
        currentHunk = initiateHunk(line);
      } else if (currentHunk) {
        if (!line.startsWith("\\")) {
          const prefix = line[0];
          if (prefix === "+" || prefix === "-" || prefix === " ") {
            currentHunk.lines.push(line);
          }
        }
      } else {
        // Parsing header
        if (line.startsWith("new file mode")) {
          currentFile._hasNewFileMode = true;
        } else if (line.startsWith("deleted file mode")) {
          currentFile._hasDeletedFileMode = true;
        } else if (line.startsWith("--- ")) {
          currentFile._fromPath = line.slice(4);
        } else if (line.startsWith("+++ ")) {
          currentFile._toPath = line.slice(4);
        }
      }
    }
  }

  if (currentFile) {
    if (currentHunk) currentFile.hunks.push(currentHunk);
    finalizeFile(currentFile);
    files.push(currentFile);
  }

  return { files };
}

function initiateFile(line: string) {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!match) return null;
  return {
    path: match[2]!,
    kind: "modified" as const,
    oldPath: "",
    hunks: [],
    _oldPathFromHeader: match[1]!,
    _newPathFromHeader: match[2]!,
  };
}

function initiateHunk(line: string) {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return {
    oldStart: parseInt(match[1]!),
    newStart: parseInt(match[2]!),
    lines: [],
  };
}

function finalizeFile(file: any) {
  if (file._hasNewFileMode || file._fromPath === "/dev/null") {
    file.kind = "added";
    file.path = file._newPathFromHeader;
  } else if (file._hasDeletedFileMode || file._toPath === "/dev/null") {
    file.kind = "deleted";
    file.path = file._oldPathFromHeader;
  } else if (file._oldPathFromHeader !== file._newPathFromHeader) {
    file.kind = "renamed";
    file.path = file._newPathFromHeader;
    file.oldPath = file._oldPathFromHeader;
  }
  // Cleanup internal properties
  delete file._hasNewFileMode;
  delete file._hasDeletedFileMode;
  delete file._fromPath;
  delete file._toPath;
  delete file._oldPathFromHeader;
  delete file._newPathFromHeader;
}
