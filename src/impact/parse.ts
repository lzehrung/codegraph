import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
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
  return { files: state.files };
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

function decodeGitPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed;
  }

  // Git quotes a path when it contains non-ASCII or special bytes, escaping each raw byte
  // independently as `\NNN` (octal). A multi-byte UTF-8 character becomes several consecutive
  // `\NNN` escapes that must be recombined as raw bytes and decoded together as UTF-8 -
  // decoding each escape as its own code point (the previous approach) mojibakes every
  // non-ASCII path (e.g. "café.ts" became "cafÃ©.ts").
  const inner = trimmed.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < inner.length; ) {
    const char = inner[index]!;
    if (char !== "\\") {
      const codePoint = inner.codePointAt(index)!;
      bytes.push(...Buffer.from(String.fromCodePoint(codePoint), "utf8"));
      index += codePoint > 0xffff ? 2 : 1;
      continue;
    }
    const octal = inner.slice(index + 1, index + 4).match(/^[0-7]{1,3}/);
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      index += 1 + octal[0].length;
      continue;
    }
    const next = inner[index + 1];
    if (next === "\\" || next === '"') {
      bytes.push(next.charCodeAt(0));
      index += 2;
      continue;
    }
    if (next === "n") {
      bytes.push(0x0a);
      index += 2;
      continue;
    }
    if (next === "r") {
      bytes.push(0x0d);
      index += 2;
      continue;
    }
    if (next === "t") {
      bytes.push(0x09);
      index += 2;
      continue;
    }
    // Unrecognized escape: keep the backslash literally.
    bytes.push(0x5c);
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripDiffGitPrefix(pathValue: string, prefix: "a/" | "b/"): string {
  return pathValue.startsWith(prefix) ? pathValue.slice(prefix.length) : pathValue;
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
    currentFile._fromPath = decodeGitPath(line.slice(4));
    return;
  }
  if (line.startsWith("+++ ")) {
    currentFile._toPath = decodeGitPath(line.slice(4));
  }
}

const DIFF_GIT_HEADER_PREFIX = "diff --git ";
const QUOTED_PATH_SEGMENT = `"(?:[^"\\\\]|\\\\.)*"`;
// Git quotes each side of the header independently, so a rename between an ASCII and a
// non-ASCII path (or vice versa) can have only one side quoted. Quoted branches are tried
// first since they are unambiguous (the closing quote is exact); the unquoted/unquoted
// fallback keeps the original earliest-" b/"-split heuristic, which is the best a regex can
// do when neither side is delimited (a literal " b/" inside an unquoted path is a
// pre-existing, accepted limitation, unchanged by this fix).
const DIFF_GIT_HEADER_BOTH_QUOTED = new RegExp(`^(${QUOTED_PATH_SEGMENT}) (${QUOTED_PATH_SEGMENT})$`);
const DIFF_GIT_HEADER_A_QUOTED = new RegExp(`^(${QUOTED_PATH_SEGMENT}) b\\/(.+)$`);
const DIFF_GIT_HEADER_B_QUOTED = new RegExp(`^a\\/(.+?) (${QUOTED_PATH_SEGMENT})$`);
const DIFF_GIT_HEADER_PLAIN = /^a\/(.+?) b\/(.+)$/;

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

  const plain = remainder.match(DIFF_GIT_HEADER_PLAIN);
  if (!plain) return null;
  return buildInitiatedFile(`a/${plain[1]}`, `b/${plain[2]}`);
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
