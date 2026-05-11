import fs from "node:fs";
import { maskJsLikeCommentsAndStrings, supportForFile } from "@lzehrung/codegraph";
import type { FileId, ProjectIndex, Range } from "@lzehrung/codegraph";
import type { RefactorResult, TextEdit } from "./types.js";
import { isValidIdentifier } from "./identifier.js";

export interface ExtractOptions {
  newName: string;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function offsetForPosition(starts: number[], position: { line: number; column: number }): number | null {
  const lineStart = starts[position.line - 1];
  if (lineStart === undefined) return null;
  return lineStart + Math.max(position.column - 1, 0);
}

function rangeOffsets(source: string, range: Range): { start: number; end: number } | null {
  const startIndex = range.start.index;
  const endIndex = range.end.index;
  if (startIndex !== undefined && endIndex !== undefined) {
    return { start: startIndex, end: endIndex };
  }
  const starts = lineStarts(source);
  const start = offsetForPosition(starts, range.start);
  const end = offsetForPosition(starts, range.end);
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

type FunctionEnvelope = {
  start: number;
  bodyStart: number;
  bodyEnd: number;
  params: string[];
};

function findFunctionEnvelope(source: string, regionStart: number, regionEnd: number): FunctionEnvelope | null {
  const braceSource = maskJsLikeCommentsAndStrings(source);
  const pattern =
    /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\((?<params>[^)]*)\)\s*\{/g;
  let found: FunctionEnvelope | null = null;
  for (let match: RegExpExecArray | null = pattern.exec(source); match; match = pattern.exec(source)) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findMatchingBrace(braceSource, bodyStart - 1);
    if (bodyEnd === null) continue;
    if (bodyStart <= regionStart && regionEnd <= bodyEnd) {
      found = {
        start: match.index,
        bodyStart,
        bodyEnd,
        params: parseParams(match.groups?.["params"] ?? ""),
      };
    }
  }
  return found;
}

function findMatchingBrace(source: string, openBrace: number): number | null {
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function parseParams(params: string): string[] {
  return params
    .split(",")
    .map((param) => param.trim().split(/[:=]/)[0]?.trim() ?? "")
    .filter((param) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(param));
}

function collectDeclaredNames(source: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  const addName = (name: string | undefined): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  const variableStatementPattern = /\b(?:const|let|var)\s+(?<declarations>[^;\n]+)/g;
  for (
    let match: RegExpExecArray | null = variableStatementPattern.exec(source);
    match;
    match = variableStatementPattern.exec(source)
  ) {
    const declarations = match.groups?.["declarations"] ?? "";
    for (const declaration of declarations.split(",")) {
      addName(/^\s*(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/.exec(declaration)?.groups?.["name"]);
    }
  }

  const namedDeclarationPattern =
    /\bfunction\s+(?<fn>[A-Za-z_$][A-Za-z0-9_$]*)|\bclass\s+(?<className>[A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (
    let match: RegExpExecArray | null = namedDeclarationPattern.exec(source);
    match;
    match = namedDeclarationPattern.exec(source)
  ) {
    addName(match.groups?.["fn"] ?? match.groups?.["className"]);
  }
  return names;
}

function hasIdentifier(source: string, name: string): boolean {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(source);
}

function collectInputs(selected: string, params: string[], precedingSource: string): string[] {
  const identifiers = new Set(selected.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) ?? []);
  const inputs: string[] = [];
  const seen = new Set<string>();
  for (const name of [...params, ...collectDeclaredNames(precedingSource)]) {
    if (!identifiers.has(name) || seen.has(name)) continue;
    seen.add(name);
    inputs.push(name);
  }
  return inputs;
}

function findDeclarationsUsedAfter(selected: string, followingSource: string): string[] {
  return collectDeclaredNames(selected).filter((name) => hasIdentifier(followingSource, name));
}

function unsupportedControlFlowReason(selected: string): string | null {
  if (/\breturn\b/.test(selected)) return "regions with return statements are unsupported";
  if (/\b(?:break|continue|yield|await)\b|\b(?:this|arguments|super)\b|new\.target/.test(selected)) {
    return "regions with unsupported control flow or context-sensitive bindings are unsupported";
  }
  return null;
}

function leadingIndent(text: string): string {
  return /^[ \t]*/.exec(text)?.[0] ?? "";
}

function normalizeExtractedBody(selected: string): string {
  const lines = selected.replace(/\s+$/u, "").split(/\r?\n/);
  return lines.map((line) => (line.startsWith("  ") ? line : `  ${line.trimStart()}`)).join("\n");
}

export function extractFunction(
  _index: ProjectIndex,
  region: { file: FileId; range: Range },
  opts: ExtractOptions,
): Promise<RefactorResult> {
  const support = supportForFile(region.file);
  const languageId = support?.id ?? "ts";
  if (languageId !== "ts" && languageId !== "tsx" && languageId !== "js" && languageId !== "jsx") {
    return Promise.resolve({
      status: "unsupported",
      edits: [],
      warnings: [],
      reason: `${languageId} extract is not supported`,
    });
  }
  const identifier = isValidIdentifier(languageId, opts.newName);
  if (!identifier.ok) {
    return Promise.resolve({ status: "unsupported", edits: [], warnings: [], reason: identifier.reason });
  }

  let source: string;
  try {
    source = fs.readFileSync(region.file, "utf8");
  } catch (error) {
    return Promise.resolve({
      status: "error",
      edits: [],
      warnings: [],
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const offsets = rangeOffsets(source, region.range);
  if (!offsets) {
    return Promise.resolve({
      status: "error",
      edits: [],
      warnings: [],
      reason: "region range does not resolve to offsets",
    });
  }
  const selected = source.slice(offsets.start, offsets.end);
  const controlFlowReason = unsupportedControlFlowReason(selected);
  if (controlFlowReason) {
    return Promise.resolve({ status: "unsupported", edits: [], warnings: [], reason: controlFlowReason });
  }
  const envelope = findFunctionEnvelope(source, offsets.start, offsets.end);
  if (!envelope) {
    return Promise.resolve({
      status: "unsupported",
      edits: [],
      warnings: [],
      reason: "region must be inside one function body",
    });
  }
  const declarationsUsedAfter = findDeclarationsUsedAfter(selected, source.slice(offsets.end, envelope.bodyEnd));
  if (declarationsUsedAfter.length > 0) {
    return Promise.resolve({
      status: "unsupported",
      edits: [],
      warnings: [],
      reason: `selected declarations are used after the region: ${declarationsUsedAfter.join(", ")}`,
    });
  }

  const inputs = collectInputs(selected, envelope.params, source.slice(envelope.bodyStart, offsets.start));
  const helper = `function ${opts.newName}(${inputs.join(", ")}) {\n${normalizeExtractedBody(selected)}\n}\n\n`;
  const call = `${leadingIndent(selected)}${opts.newName}(${inputs.join(", ")});\n`;
  const edits: TextEdit[] = [
    { file: region.file, start: envelope.start, end: envelope.start, newText: helper },
    { file: region.file, start: offsets.start, end: offsets.end, newText: call },
  ];
  return Promise.resolve({ status: "ok", edits, warnings: [] });
}
