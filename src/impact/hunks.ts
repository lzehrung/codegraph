import type { FileChange } from "./types.js";

export type HunkLineText = {
  added: string[];
  removed: string[];
  changed: string[];
};

export function collectChangedLines(hunks: FileChange["hunks"]): Set<number> {
  const changedLines = new Set<number>();
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    let deletionStreak = 0;
    for (const line of hunk.lines) {
      if (line.startsWith(" ")) {
        oldLine += 1;
        newLine += 1;
        deletionStreak = 0;
      } else if (line.startsWith("+")) {
        changedLines.add(newLine);
        newLine += 1;
        deletionStreak = 0;
      } else if (line.startsWith("-")) {
        const mappedLine = newLine > 0 ? newLine + deletionStreak : oldLine;
        changedLines.add(mappedLine);
        oldLine += 1;
        deletionStreak += 1;
      }
    }
  }
  return changedLines;
}

export function collectRemovedLines(change: FileChange): Set<number> {
  const removed = new Set<number>();
  for (const hunk of change.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    let deletionStreak = 0;
    for (const line of hunk.lines) {
      if (line.startsWith(" ")) {
        oldLine += 1;
        newLine += 1;
        deletionStreak = 0;
        continue;
      }
      if (line.startsWith("-")) {
        const mapped = newLine > 0 ? newLine + deletionStreak : oldLine;
        removed.add(mapped);
        oldLine += 1;
        deletionStreak += 1;
        continue;
      }
      if (line.startsWith("+")) {
        newLine += 1;
        deletionStreak = 0;
      }
    }
  }
  return removed;
}

export function collectHunkLineText(change: FileChange): HunkLineText {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const hunk of change.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        const text = line.slice(1);
        added.push(text);
        changed.push(text);
      } else if (line.startsWith("-")) {
        const text = line.slice(1);
        removed.push(text);
        changed.push(text);
      }
    }
  }
  return { added, removed, changed };
}

export function newFileRangeForHunk(hunk: FileChange["hunks"][number]): { start: number; end: number } {
  let newLine = hunk.newStart;
  let lastNewLine = newLine - 1;
  for (const line of hunk.lines) {
    if (line.startsWith(" ") || line.startsWith("+")) {
      lastNewLine = newLine;
      newLine += 1;
    }
  }
  return { start: hunk.newStart, end: Math.max(hunk.newStart, lastNewLine) };
}
