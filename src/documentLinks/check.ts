import fsp from "node:fs/promises";
import path from "node:path";
import { extractMarkdownLinkOccurrences, type MarkdownLinkOccurrence } from "./markdown.js";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import { isFilePathWithinRoot, normalizePath, toProjectDisplayPath, toProjectRelativePath } from "../util/paths.js";
import { listProjectFiles, type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";

type MarkdownLinkCheckPosition = {
  line: number;
  column: number;
};

type MarkdownLinkCheckRange = {
  start: MarkdownLinkCheckPosition;
  end: MarkdownLinkCheckPosition;
};

export type MarkdownLinkCheckFailureReason = "missing_file" | "missing_reference" | "missing_fragment" | "outside_root";

export type MarkdownLinkCheckFailure = {
  file: string;
  range: MarkdownLinkCheckRange;
  raw: string;
  reason: MarkdownLinkCheckFailureReason;
  target?: string;
};

export type MarkdownLinkCheckResult = {
  schemaVersion: 1;
  root: string;
  summary: {
    filesScanned: number;
    linksChecked: number;
    externalSkipped: number;
    failures: number;
  };
  failures: MarkdownLinkCheckFailure[];
};

type TargetStatus = { status: "found"; isDirectory: boolean; realPath: string } | { status: "missing" };

type LocalLinkTarget = {
  path: string;
  fragment?: string;
};

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

export async function checkMarkdownLinks(
  projectRoot: string,
  discovery?: ProjectFileDiscoveryOptions,
): Promise<MarkdownLinkCheckResult> {
  const root = path.resolve(projectRoot);
  return await checkMarkdownLinksInFiles(root, await listProjectFiles(root, undefined, discovery));
}

export async function checkMarkdownLinksInFiles(
  projectRoot: string,
  files: Iterable<string>,
): Promise<MarkdownLinkCheckResult> {
  const root = path.resolve(projectRoot);
  const realRoot = await fsp.realpath(root);
  const markdownFileCandidates = await Promise.all(
    Array.from(files, async (file) => {
      const absoluteFile = path.resolve(root, file);
      const relativeFile = toProjectRelativePath(root, absoluteFile);
      if (relativeFile !== null) return path.resolve(realRoot, relativeFile);
      try {
        return await fsp.realpath(absoluteFile);
      } catch {
        return absoluteFile;
      }
    }),
  );
  const markdownFiles = Array.from(new Set(markdownFileCandidates))
    .filter((file) => isFilePathWithinRoot(realRoot, file))
    .filter((file) => supportForFileWithoutHeaderSample(file)?.id === "markdown");
  const targetStatusByPath = new Map<string, Promise<TargetStatus>>();
  const anchorsByPath = new Map<string, Promise<Set<string>>>();
  const failures: MarkdownLinkCheckFailure[] = [];
  let linksChecked = 0;
  let externalSkipped = 0;

  for (const file of markdownFiles) {
    const displayFile = await recoverDisplayFileCasing(file);
    const source = await readMarkdownFile(file);
    const occurrences = extractMarkdownLinkOccurrences(source);
    for (const occurrence of occurrences) {
      if ("missingReference" in occurrence) {
        linksChecked += 1;
        failures.push(toFailure(realRoot, displayFile, occurrence, "missing_reference"));
        continue;
      }

      const target = parseLocalLinkTarget(occurrence.destination);
      if (!target) continue;
      const externalTarget =
        !WINDOWS_ABSOLUTE_PATH.test(target.path) && (URI_SCHEME.test(target.path) || target.path.startsWith("//"));
      if (externalTarget) {
        externalSkipped += 1;
        continue;
      }

      linksChecked += 1;
      const resolvedTarget = resolveMarkdownTarget(realRoot, file, target.path);
      if (!isFilePathWithinRoot(realRoot, resolvedTarget)) {
        failures.push(toFailure(realRoot, displayFile, occurrence, "outside_root", resolvedTarget));
        continue;
      }

      const targetStatus = await cachedTargetStatus(resolvedTarget, targetStatusByPath);
      if (targetStatus.status === "missing") {
        failures.push(toFailure(realRoot, displayFile, occurrence, "missing_file", resolvedTarget));
        continue;
      }
      if (!isFilePathWithinRoot(realRoot, targetStatus.realPath)) {
        failures.push(toFailure(realRoot, displayFile, occurrence, "outside_root", resolvedTarget));
        continue;
      }
      if (!target.fragment || targetStatus.isDirectory || supportForFileWithoutHeaderSample(resolvedTarget)?.id !== "markdown") continue;

      const anchors = await cachedMarkdownAnchors(targetStatus.realPath, anchorsByPath);
      if (!anchors.has(target.fragment)) {
        failures.push(toFailure(realRoot, displayFile, occurrence, "missing_fragment", resolvedTarget));
      }
    }
  }

  failures.sort(compareFailures);
  return {
    schemaVersion: 1,
    root: normalizePath(root),
    summary: {
      filesScanned: markdownFiles.length,
      linksChecked,
      externalSkipped,
      failures: failures.length,
    },
    failures,
  };
}

async function recoverDisplayFileCasing(file: string): Promise<string> {
  const dir = path.dirname(file);
  const base = path.basename(file);
  try {
    const entries = await fsp.readdir(dir);
    const match = entries.find((entry) => entry.toLowerCase() === base.toLowerCase());
    return match ? path.join(dir, match) : file;
  } catch {
    return file;
  }
}

function parseLocalLinkTarget(destination: string): LocalLinkTarget | null {
  let trimmed = destination.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed) return null;

  const hashIndex = trimmed.indexOf("#");
  const pathWithQuery = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const queryIndex = pathWithQuery.indexOf("?");
  const targetPath = queryIndex >= 0 ? pathWithQuery.slice(0, queryIndex) : pathWithQuery;
  const fragment = hashIndex >= 0 ? decodeFragment(trimmed.slice(hashIndex + 1)) : undefined;
  return {
    path: decodeMarkdownPath(targetPath),
    ...(fragment ? { fragment } : {}),
  };
}

function decodeMarkdownPath(targetPath: string): string {
  return decodeUriComponent(unescapeMarkdownPunctuation(targetPath));
}

function decodeFragment(fragment: string): string {
  return decodeUriComponent(fragment);
}

function decodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unescapeMarkdownPunctuation(value: string): string {
  let unescaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    const escapedCharacter = value.charAt(index + 1);
    if (character === "\\" && isMarkdownPunctuation(escapedCharacter)) {
      unescaped += escapedCharacter;
      index += 1;
      continue;
    }
    unescaped += character;
  }
  return unescaped;
}

function isMarkdownPunctuation(value: string): boolean {
  const code = value.charCodeAt(0);
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  );
}

function resolveMarkdownTarget(root: string, sourceFile: string, destination: string): string {
  if (!destination) return sourceFile;
  if (WINDOWS_ABSOLUTE_PATH.test(destination)) return path.resolve(destination);
  if (destination.startsWith("/")) return path.join(root, destination);
  return path.resolve(path.dirname(sourceFile), destination);
}

async function cachedTargetStatus(
  target: string,
  targetStatusByPath: Map<string, Promise<TargetStatus>>,
): Promise<TargetStatus> {
  let status = targetStatusByPath.get(target);
  if (!status) {
    status = readTargetStatus(target);
    targetStatusByPath.set(target, status);
  }
  return await status;
}

async function readTargetStatus(target: string): Promise<TargetStatus> {
  try {
    const realPath = await fsp.realpath(target);
    const stats = await fsp.stat(realPath);
    return { status: "found", isDirectory: stats.isDirectory(), realPath };
  } catch (error) {
    if (isMissingPathError(error)) return { status: "missing" };
    throw new Error(
      `Failed to inspect Markdown link target ${normalizePath(target)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function cachedMarkdownAnchors(
  target: string,
  anchorsByPath: Map<string, Promise<Set<string>>>,
): Promise<Set<string>> {
  let anchors = anchorsByPath.get(target);
  if (!anchors) {
    anchors = readMarkdownFile(target).then(collectMarkdownAnchors);
    anchorsByPath.set(target, anchors);
  }
  return await anchors;
}

async function readMarkdownFile(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to read Markdown file ${normalizePath(file)}: ${error.message}`);
    }
    throw error;
  }
}

function collectMarkdownAnchors(source: string): Set<string> {
  const anchors = new Set<string>();
  const lines = source.split(/\r?\n/);
  let fence: "`" | "~" | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.charAt(0);
      if (marker === "`" || marker === "~") {
        fence = fence === marker ? null : (fence ?? marker);
      }
      continue;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) continue;

    const atx = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/);
    if (atx?.[1]) {
      addMarkdownAnchor(anchors, atx[1]);
      continue;
    }

    const underline = lines[index + 1];
    if (line.trim() && underline && /^ {0,3}(?:=+|-+)[ \t]*$/.test(underline)) {
      addMarkdownAnchor(anchors, line);
      index += 1;
    }
  }

  return anchors;
}

function addMarkdownAnchor(anchors: Set<string>, heading: string): void {
  const baseSlug = markdownHeadingSlug(heading);
  if (!baseSlug) return;

  let slug = baseSlug;
  let suffix = 1;
  while (anchors.has(slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
  anchors.add(slug);
}

function markdownHeadingSlug(heading: string): string {
  return renderMarkdownHeading(heading)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
    .replace(/\s+/g, "-");
}

function renderMarkdownHeading(heading: string): string {
  return unescapeMarkdownPunctuation(heading)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[\\`*~]/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+(?=\S)/gu, "$1")
    .replace(/_+(?=\s|$)/g, "");
}

function toFailure(
  root: string,
  file: string,
  occurrence: MarkdownLinkOccurrence,
  reason: MarkdownLinkCheckFailureReason,
  target?: string,
): MarkdownLinkCheckFailure {
  return {
    file: toProjectDisplayPath(root, file),
    range: {
      start: { line: occurrence.range.start.line, column: occurrence.range.start.column },
      end: { line: occurrence.range.end.line, column: occurrence.range.end.column },
    },
    raw: occurrence.raw,
    reason,
    ...(target ? { target: toProjectDisplayPath(root, target) } : {}),
  };
}

function compareFailures(left: MarkdownLinkCheckFailure, right: MarkdownLinkCheckFailure): number {
  const fileOrder = left.file.localeCompare(right.file);
  if (fileOrder) return fileOrder;
  const lineOrder = left.range.start.line - right.range.start.line;
  if (lineOrder) return lineOrder;
  return left.range.start.column - right.range.start.column;
}
