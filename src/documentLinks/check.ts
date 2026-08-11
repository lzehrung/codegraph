import fsp from "node:fs/promises";
import path from "node:path";
import { extractMarkdownLinkOccurrences, type MarkdownLinkOccurrence } from "./markdown.js";
import { supportForFile } from "../languages.js";
import { isFilePathWithinRoot, normalizePath, toProjectDisplayPath } from "../util/paths.js";
import { listProjectFiles } from "../util/projectFiles.js";

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

type TargetStatus = { status: "found"; isDirectory: boolean } | { status: "missing" };

type LocalLinkTarget = {
  path: string;
  fragment?: string;
};

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

export async function checkMarkdownLinks(projectRoot: string): Promise<MarkdownLinkCheckResult> {
  const root = path.resolve(projectRoot);
  return await checkMarkdownLinksInFiles(root, await listProjectFiles(root));
}

export async function checkMarkdownLinksInFiles(
  projectRoot: string,
  files: Iterable<string>,
): Promise<MarkdownLinkCheckResult> {
  const root = path.resolve(projectRoot);
  const markdownFiles = Array.from(new Set(Array.from(files, (file) => path.resolve(root, file))))
    .filter((file) => isFilePathWithinRoot(root, file))
    .filter((file) => supportForFile(file)?.id === "markdown");
  const targetStatusByPath = new Map<string, Promise<TargetStatus>>();
  const anchorsByPath = new Map<string, Promise<Set<string>>>();
  const failures: MarkdownLinkCheckFailure[] = [];
  let linksChecked = 0;
  let externalSkipped = 0;

  for (const file of markdownFiles) {
    const source = await readMarkdownFile(file);
    const occurrences = extractMarkdownLinkOccurrences(source);
    for (const occurrence of occurrences) {
      if ("missingReference" in occurrence) {
        linksChecked += 1;
        failures.push(toFailure(root, file, occurrence, "missing_reference"));
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
      const resolvedTarget = resolveMarkdownTarget(root, file, target.path);
      if (!isFilePathWithinRoot(root, resolvedTarget)) {
        failures.push(toFailure(root, file, occurrence, "outside_root", resolvedTarget));
        continue;
      }

      const targetStatus = await cachedTargetStatus(resolvedTarget, targetStatusByPath);
      if (targetStatus.status === "missing") {
        failures.push(toFailure(root, file, occurrence, "missing_file", resolvedTarget));
        continue;
      }
      if (!target.fragment || targetStatus.isDirectory || supportForFile(resolvedTarget)?.id !== "markdown") continue;

      const anchors = await cachedMarkdownAnchors(resolvedTarget, anchorsByPath);
      if (!anchors.has(target.fragment)) {
        failures.push(toFailure(root, file, occurrence, "missing_fragment", resolvedTarget));
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
    path: targetPath,
    ...(fragment ? { fragment } : {}),
  };
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
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
    const stats = await fsp.stat(target);
    return { status: "found", isDirectory: stats.isDirectory() };
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
  const counts = new Map<string, number>();
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
      addMarkdownAnchor(anchors, counts, atx[1]);
      continue;
    }

    const underline = lines[index + 1];
    if (line.trim() && underline && /^ {0,3}(?:=+|-+)[ \t]*$/.test(underline)) {
      addMarkdownAnchor(anchors, counts, line);
      index += 1;
    }
  }

  return anchors;
}

function addMarkdownAnchor(anchors: Set<string>, counts: Map<string, number>, heading: string): void {
  const slug = markdownHeadingSlug(heading);
  if (!slug) return;
  const duplicateCount = counts.get(slug) ?? 0;
  counts.set(slug, duplicateCount + 1);
  anchors.add(duplicateCount ? `${slug}-${duplicateCount}` : slug);
}

function markdownHeadingSlug(heading: string): string {
  return heading
    .replace(/<[^>]*>/g, "")
    .replace(/[\\`*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-\s]/gu, "")
    .replace(/\s+/g, "-");
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
