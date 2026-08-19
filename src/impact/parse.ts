import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { decodeGitPath } from "../util/git.js";
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
  _isBinary?: boolean;
  _modeChanged?: boolean;
  _similarityIndex?: number;
};

type DiffParserState = {
  files: FileChange[];
  currentFile: ParsedFileChange | null;
  currentHunk: Hunk | null;
  warning?: string;
};

export function parseUnifiedDiff(diffText: string): Diff {
  const state = createParserState();
  const lines = diffText.split(/\r?\n/);

  for (const line of lines) {
    parseDiffLine(state, line);
  }

  return finishParserState(state);
}

export async function parseUnifiedDiffStreaming(stream: Readable): Promise<Diff> {
  const state = createParserState();
  const decoder = new StringDecoder("utf8");
  let buffered = "";

  for await (const chunk of stream) {
    buffered += decodeStreamChunk(decoder, chunk);
    buffered = parseBufferedLines(state, buffered);
  }

  buffered += decoder.end();
  buffered = parseBufferedLines(state, buffered);

  if (buffered) {
    parseDiffLine(state, buffered.endsWith("\r") ? buffered.slice(0, -1) : buffered);
  }

  return finishParserState(state);
}

function createParserState(): DiffParserState {
  return {
    files: [],
    currentFile: null,
    currentHunk: null,
  };
}

function parseBufferedLines(state: DiffParserState, buffered: string): string {
  let lineStart = 0;
  for (;;) {
    const newlineIndex = buffered.indexOf("\n", lineStart);
    if (newlineIndex < 0) break;
    const lineEnd = newlineIndex > lineStart && buffered[newlineIndex - 1] === "\r" ? newlineIndex - 1 : newlineIndex;
    parseDiffLine(state, buffered.slice(lineStart, lineEnd));
    lineStart = newlineIndex + 1;
  }

  return buffered.slice(lineStart);
}

function parseDiffLine(state: DiffParserState, line: string): void {
  if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
    finishCurrentFile(state);
    state.warning ??=
      "Combined/merge diffs are not supported; rerun Git diff with -m to produce per-parent unified files.";
    return;
  }
  if (line.startsWith("diff --git")) {
    finishCurrentFile(state);
    state.currentFile = initiateFile(line);
    state.currentHunk = null;
    return;
  }
  if (!state.currentFile) return;

  if (line.startsWith("@@")) {
    if (state.currentHunk) {
      state.currentFile.hunks.push(state.currentHunk);
    }
    state.currentHunk = initiateHunk(line);
    return;
  }

  if (state.currentHunk) {
    if (!line.startsWith("\\")) {
      const prefix = line[0];
      if (prefix === "+" || prefix === "-" || prefix === " ") {
        state.currentHunk.lines.push(line);
      }
    }
    return;
  }

  parseHeaderLine(state.currentFile, line);
}

function finishParserState(state: DiffParserState): Diff {
  finishCurrentFile(state);
  return {
    files: state.files,
    ...(state.warning ? { warning: state.warning } : {}),
  };
}

function finishCurrentFile(state: DiffParserState): void {
  if (!state.currentFile) return;

  if (state.currentHunk) {
    state.currentFile.hunks.push(state.currentHunk);
  }
  finalizeFile(state.currentFile);
  state.files.push(state.currentFile);
  state.currentFile = null;
  state.currentHunk = null;
}

function decodeStreamChunk(decoder: StringDecoder, chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return decoder.write(chunk);
  if (chunk instanceof Uint8Array) return decoder.write(Buffer.from(chunk));
  return String(chunk);
}

function stripDiffGitPrefix(pathValue: string, prefix: "a/" | "b/"): string {
  return pathValue.startsWith(prefix) ? pathValue.slice(prefix.length) : pathValue;
}

// Git appends a bare trailing tab to `--- `/`+++ ` header lines whenever the pathname
// contains a space (quoted or not), to keep the path boundary unambiguous the way the
// traditional `diff -u` timestamp field did. It is a line-format marker, never part of the
// real filename, so strip it before quote-decoding: leaving it in place would make a quoted
// path fail `decodeGitPath`'s closing-quote check entirely.
function stripTrailingHeaderTab(rawPath: string): string {
  return rawPath.endsWith("\t") ? rawPath.slice(0, -1) : rawPath;
}

function parseHeaderLine(currentFile: ParsedFileChange, line: string): void {
  if (line.startsWith("new file mode")) {
    currentFile._hasNewFileMode = true;
    currentFile._modeChanged = true;
    return;
  }
  if (line.startsWith("deleted file mode")) {
    currentFile._hasDeletedFileMode = true;
    currentFile._modeChanged = true;
    return;
  }
  if (line.startsWith("old mode ") || line.startsWith("new mode ")) {
    currentFile._modeChanged = true;
    return;
  }
  if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
    currentFile._isBinary = true;
    return;
  }
  if (line.startsWith("similarity index ")) {
    const match = line.match(/^similarity index\s+(\d+)%$/);
    if (match?.[1]) {
      currentFile._similarityIndex = parseInt(match[1], 10);
    }
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
    currentFile._fromPath = decodeGitPath(stripTrailingHeaderTab(line.slice(4)));
    return;
  }
  if (line.startsWith("+++ ")) {
    currentFile._toPath = decodeGitPath(stripTrailingHeaderTab(line.slice(4)));
  }
}

const DIFF_GIT_HEADER_PREFIX = "diff --git ";
const QUOTED_PATH_SEGMENT = `"(?:[^"\\\\]|\\\\.)*"`;
// Git quotes each side of the header independently, so a rename between an ASCII and a
// non-ASCII path (or vice versa) can have only one side quoted. Quoted branches are tried
// first since they are unambiguous (the closing quote is exact); the unquoted/unquoted
// fallback below (`resolveAmbiguousHeaderPaths`) prefers the split whose halves are equal,
// which resolves the common same-path case even when an unquoted path itself contains the
// literal text " b/". `buildInitiatedFile` stores its guess only as
// `_oldPathFromHeader`/`_newPathFromHeader`; `finalizeFile` still overrides it with the
// unambiguous single-path `--- a/X`/`+++ b/Y` (and rename/copy from/to) lines whenever Git
// emits them, so a genuinely undecidable split only survives for pure renames/copies that
// have no content hunks and therefore no `---`/`+++` lines to correct it.
const DIFF_GIT_HEADER_BOTH_QUOTED = new RegExp(`^(${QUOTED_PATH_SEGMENT}) (${QUOTED_PATH_SEGMENT})$`);
const DIFF_GIT_HEADER_A_QUOTED = new RegExp(`^(${QUOTED_PATH_SEGMENT}) b\\/(.+)$`);
const DIFF_GIT_HEADER_B_QUOTED = new RegExp(`^a\\/(.+?) (${QUOTED_PATH_SEGMENT})$`);

/**
 * The unquoted/unquoted fallback for `diff --git a/X b/Y`: try every position where the
 * text " b/" occurs and prefer the split whose two halves are literally equal, since a
 * changed file's old and new paths are the same string in every case that reaches this
 * fallback (Git always emits `rename from`/`rename to` or `copy from`/`copy to` lines
 * instead when the paths genuinely differ). Only when no split produces equal halves - an
 * undecidable case with no other information available - fall back to the earliest split.
 */
function resolveAmbiguousHeaderPaths(remainder: string): { aSpec: string; bSpec: string } | null {
  if (!remainder.startsWith("a/")) return null;
  const afterA = remainder.slice(2);
  const separator = " b/";
  const splitIndices: number[] = [];
  for (let index = afterA.indexOf(separator); index !== -1; index = afterA.indexOf(separator, index + 1)) {
    splitIndices.push(index);
  }
  if (!splitIndices.length) return null;

  let chosen = splitIndices[0]!;
  for (const index of splitIndices) {
    if (afterA.slice(0, index) === afterA.slice(index + separator.length)) {
      chosen = index;
      break;
    }
  }
  return { aSpec: `a/${afterA.slice(0, chosen)}`, bSpec: `b/${afterA.slice(chosen + separator.length)}` };
}

function buildInitiatedFile(aSpec: string, bSpec: string): ParsedFileChange {
  const aPath = stripDiffGitPrefix(decodeGitPath(aSpec), "a/");
  const bPath = stripDiffGitPrefix(decodeGitPath(bSpec), "b/");
  return {
    path: bPath,
    kind: "modified" as const,
    oldPath: "",
    hunks: [],
    _oldPathFromHeader: aPath,
    _newPathFromHeader: bPath,
  };
}

function initiateFile(line: string): ParsedFileChange | null {
  if (!line.startsWith(DIFF_GIT_HEADER_PREFIX)) return null;
  const remainder = line.slice(DIFF_GIT_HEADER_PREFIX.length);

  const bothQuoted = remainder.match(DIFF_GIT_HEADER_BOTH_QUOTED);
  if (bothQuoted) return buildInitiatedFile(bothQuoted[1]!, bothQuoted[2]!);

  const aQuoted = remainder.match(DIFF_GIT_HEADER_A_QUOTED);
  if (aQuoted) return buildInitiatedFile(aQuoted[1]!, `b/${aQuoted[2]}`);

  const bQuoted = remainder.match(DIFF_GIT_HEADER_B_QUOTED);
  if (bQuoted) return buildInitiatedFile(`a/${bQuoted[1]}`, bQuoted[2]!);

  const plain = resolveAmbiguousHeaderPaths(remainder);
  if (!plain) return null;
  return buildInitiatedFile(plain.aSpec, plain.bSpec);
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
  // The `diff --git a/X b/Y` header line is ambiguous when both sides are unquoted and one
  // side's path itself contains the literal separator text " b/" (e.g. a file named
  // "foo b/bar"): the earliest-split fallback can pick the wrong boundary. The `--- a/X` and
  // `+++ b/Y` lines each carry exactly one path with an unambiguous prefix, so prefer them
  // (and the equally unambiguous rename/copy from/to lines) over the header split whenever
  // Git emitted them; only fall back to the header split when no other source is available
  // (pure renames/copies without content hunks omit `---`/`+++` entirely).
  const unambiguousOldPath =
    file._fromPath !== undefined && file._fromPath !== "/dev/null"
      ? stripDiffGitPrefix(file._fromPath, "a/")
      : undefined;
  const unambiguousNewPath =
    file._toPath !== undefined && file._toPath !== "/dev/null" ? stripDiffGitPrefix(file._toPath, "b/") : undefined;

  const renameFrom = file._renameFrom ?? unambiguousOldPath ?? file._oldPathFromHeader;
  const renameTo = file._renameTo ?? unambiguousNewPath ?? file._newPathFromHeader;
  const copyFrom = file._copyFrom;
  const copyTo = file._copyTo ?? unambiguousNewPath ?? file._newPathFromHeader;

  if (file._hasNewFileMode || file._fromPath === "/dev/null") {
    file.kind = "added";
    file.path = unambiguousNewPath ?? file._newPathFromHeader ?? file.path;
  } else if (file._hasDeletedFileMode || file._toPath === "/dev/null") {
    file.kind = "deleted";
    file.path = unambiguousOldPath ?? file._oldPathFromHeader ?? file.path;
  } else if (copyFrom && copyTo) {
    file.kind = "added";
    file.path = copyTo;
    file.oldPath = copyFrom;
  } else if (renameFrom && renameTo && renameFrom !== renameTo) {
    file.kind = "renamed";
    file.path = renameTo;
    file.oldPath = renameFrom;
  } else {
    file.path = unambiguousNewPath ?? file.path;
  }

  if (file._isBinary) {
    file.isBinary = true;
  }
  if (file._modeChanged) {
    file.modeChanged = true;
  }
  if (file._similarityIndex !== undefined) {
    file.similarityIndex = file._similarityIndex;
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
  delete file._isBinary;
  delete file._modeChanged;
  delete file._similarityIndex;
}
