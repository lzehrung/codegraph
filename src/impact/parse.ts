import readline from "node:readline";
import { Readable } from "node:stream";
import type { Diff, FileChange, Hunk } from "./types.js";

type ParsedFileChange = FileChange & {
  _hasNewFileMode?: boolean;
  _hasDeletedFileMode?: boolean;
  _renameFrom?: string;
  _renameTo?: string;
  _copyFrom?: string;
  _copyTo?: string;
  _fromPath?: string;
  _toPath?: string;
  _oldPathFromHeader?: string;
  _newPathFromHeader?: string;
};

export function parseUnifiedDiff(diffText: string): Diff {
  const files: FileChange[] = [];
  const lines = diffText.split(/\r?\n/);

  let currentFile: ParsedFileChange | null = null;
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
        parseHeaderLine(currentFile, line);
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
  let currentFile: ParsedFileChange | null = null;
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
        parseHeaderLine(currentFile, line);
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

function decodeGitPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed;
  }

  const inner = trimmed.slice(1, -1);
  const decoded = inner.replace(
    /\\(\\|"|n|r|t|[0-7]{1,3})/g,
    (match, token: string) => {
      if (token === "\\") return "\\";
      if (token === '"') return '"';
      if (token === "n") return "\n";
      if (token === "r") return "\r";
      if (token === "t") return "\t";
      if (/^[0-7]{1,3}$/.test(token)) {
        return String.fromCharCode(parseInt(token, 8));
      }
      return match;
    },
  );
  return decoded;
}

function parseHeaderLine(currentFile: ParsedFileChange, line: string): void {
  if (line.startsWith("new file mode")) {
    currentFile._hasNewFileMode = true;
    return;
  }
  if (line.startsWith("deleted file mode")) {
    currentFile._hasDeletedFileMode = true;
    return;
  }
  if (line.startsWith("rename from ")) {
    currentFile._renameFrom = decodeGitPath(line.slice("rename from ".length));
    return;
  }
  if (line.startsWith("rename to ")) {
    currentFile._renameTo = decodeGitPath(line.slice("rename to ".length));
    return;
  }
  if (line.startsWith("copy from ")) {
    currentFile._copyFrom = decodeGitPath(line.slice("copy from ".length));
    return;
  }
  if (line.startsWith("copy to ")) {
    currentFile._copyTo = decodeGitPath(line.slice("copy to ".length));
    return;
  }
  if (line.startsWith("--- ")) {
    currentFile._fromPath = decodeGitPath(line.slice(4));
    return;
  }
  if (line.startsWith("+++ ")) {
    currentFile._toPath = decodeGitPath(line.slice(4));
  }
}

function initiateFile(line: string): ParsedFileChange | null {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) return null;
  return {
    path: decodeGitPath(match[2]!),
    kind: "modified" as const,
    oldPath: "",
    hunks: [],
    _oldPathFromHeader: decodeGitPath(match[1]!),
    _newPathFromHeader: decodeGitPath(match[2]!),
  };
}

function initiateHunk(line: string): Hunk | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return {
    oldStart: parseInt(match[1]!),
    newStart: parseInt(match[2]!),
    lines: [],
  };
}

function finalizeFile(file: ParsedFileChange): void {
  const renameFrom = file._renameFrom ?? file._oldPathFromHeader;
  const renameTo = file._renameTo ?? file._newPathFromHeader;
  const copyFrom = file._copyFrom;
  const copyTo = file._copyTo ?? file._newPathFromHeader;

  if (file._hasNewFileMode || file._fromPath === "/dev/null") {
    file.kind = "added";
    file.path = file._newPathFromHeader ?? file.path;
  } else if (file._hasDeletedFileMode || file._toPath === "/dev/null") {
    file.kind = "deleted";
    file.path = file._oldPathFromHeader ?? file.path;
  } else if (copyFrom && copyTo) {
    file.kind = "added";
    file.path = copyTo;
    file.oldPath = copyFrom;
  } else if (renameFrom && renameTo && renameFrom !== renameTo) {
    file.kind = "renamed";
    file.path = renameTo;
    file.oldPath = renameFrom;
  }

  delete file._hasNewFileMode;
  delete file._hasDeletedFileMode;
  delete file._renameFrom;
  delete file._renameTo;
  delete file._copyFrom;
  delete file._copyTo;
  delete file._fromPath;
  delete file._toPath;
  delete file._oldPathFromHeader;
  delete file._newPathFromHeader;
}
