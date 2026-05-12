import fs from "node:fs";
import path from "node:path";
import {
  findReferencesById,
  getSymbolRange,
  resolveSymbolId,
  supportForFile,
} from "@lzehrung/codegraph";
import type { FileId, ImportBinding, ProjectIndex, SymbolHandle } from "@lzehrung/codegraph";
import { isWithinProjectRoot, normalizeProjectFile } from "./pathBoundary.js";
import type { RefactorResult, TextEdit, TriviaMode } from "./types.js";

export interface MoveOptions {
  trivia?: TriviaMode;
}

function deleteEndForRange(end: number, source: string): number {
  let deleteEnd = end;
  if (source.slice(deleteEnd, deleteEnd + 2) === "\r\n") {
    deleteEnd += 2;
  } else if (source[deleteEnd] === "\n") {
    deleteEnd += 1;
  }
  return deleteEnd;
}

function rangeToDeleteEdit(file: string, start: number, end: number, source: string): TextEdit {
  const deleteEnd = deleteEndForRange(end, source);
  return { file, start, end: deleteEnd, newText: "" };
}

function readTargetInsertion(targetFile: string, body: string): { offset: number; text: string; source: string } {
  try {
    const source = fs.readFileSync(targetFile, "utf8");
    const prefix = source.length > 0 && !source.endsWith("\n") ? "\n" : "";
    return { offset: source.length, text: `${prefix}${body}\n`, source };
  } catch {
    return { offset: 0, text: `${body}\n`, source: "" };
  }
}

function explicitSpecifierExtension(specifier: string | undefined): string {
  if (!specifier) return "";
  return path.posix.extname(specifier);
}

function relativeSpecifier(fromFile: string, toFile: string, originalSpecifier?: string): string {
  const fromDir = path.dirname(fromFile);
  const parsed = path.parse(toFile);
  const targetExtension = explicitSpecifierExtension(originalSpecifier);
  const targetName = targetExtension ? `${parsed.name}${targetExtension}` : parsed.name;
  const targetPath = path.join(parsed.dir, targetName);
  let relative = path.relative(fromDir, targetPath).replace(/\\/g, "/");
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative;
}

function splitSpecifiers(specifiers: string): string[] {
  return specifiers
    .split(",")
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier.length > 0);
}

function specifierNames(specifier: string): { imported: string; local: string } {
  const [importedRaw, localRaw] = specifier.split(/\s+as\s+/);
  const imported = normalizeImportedSpecifierName(importedRaw ?? "");
  return {
    imported,
    local: (localRaw ?? imported).trim(),
  };
}

function normalizeImportedSpecifierName(name: string): string {
  return name.trim().replace(/^type\s+/, "");
}

function importEditsForSpecifier(modFile: string, from: string, name: string, targetFile: string): TextEdit[] {
  let source: string;
  try {
    source = fs.readFileSync(modFile, "utf8");
  } catch {
    return [];
  }

  const edits: TextEdit[] = [];
  const importPattern = new RegExp(
    `import\\s+(?<typeKeyword>type\\s+)?\\{(?<specifiers>[^}]+)\\}\\s*from\\s*(?<quote>["'])${escapeRegExp(from)}\\k<quote>;?`,
    "g",
  );
  for (let match: RegExpExecArray | null = importPattern.exec(source); match; match = importPattern.exec(source)) {
    const specifiers = match.groups?.["specifiers"];
    if (!specifiers) continue;
    const parts = splitSpecifiers(specifiers);
    const moved = parts.filter((part) => {
      const names = specifierNames(part);
      return names.imported === name;
    });
    if (moved.length === 0) continue;
    const remaining = parts.filter((part) => !moved.includes(part));
    const quote = match.groups?.["quote"] ?? "'";
    const importPrefix = match.groups?.["typeKeyword"] ? "import type" : "import";
    const targetSpecifier = relativeSpecifier(modFile, targetFile, from);
    const replacement =
      remaining.length > 0
        ? [
            `${importPrefix} { ${remaining.join(", ")} } from ${quote}${from}${quote};`,
            `${importPrefix} { ${moved.join(", ")} } from ${quote}${targetSpecifier}${quote};`,
          ].join("\n")
        : `${importPrefix} { ${moved.join(", ")} } from ${quote}${targetSpecifier}${quote};`;
    edits.push({
      file: modFile,
      start: match.index,
      end: match.index + match[0].length,
      newText: replacement,
    });
  }
  return edits;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function targetHasCollision(index: ProjectIndex, targetFile: string, name: string): boolean {
  const mod = index.byFile.get(targetFile);
  if (!mod) return false;
  return mod.locals.some((local) => local.localName === name);
}

function importInsertionOffset(source: string): number {
  let offset = 0;
  while (offset < source.length) {
    const importStart = skipWhitespace(source, offset);
    const importEnd = importDeclarationEndAt(source, importStart);
    if (importEnd === null) return offset;
    offset = importEnd;
  }
  return offset;
}

function skipWhitespace(source: string, offset: number): number {
  let index = offset;
  while (index < source.length && /\s/u.test(source[index]!)) {
    index += 1;
  }
  return index;
}

function importDeclarationEndAt(source: string, offset: number): number | null {
  if (!source.startsWith("import", offset)) return null;
  const afterKeyword = offset + "import".length;
  if (isIdentifierPart(source[afterKeyword])) return null;
  const nextToken = skipInlineWhitespace(source, afterKeyword);
  if (source[nextToken] === "(") return null;

  let braceDepth = 0;
  for (let index = afterKeyword; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"') {
      index = quotedLiteralEnd(source, index, char);
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(braceDepth - 1, 0);
      continue;
    }
    if (char === ";") return endOfStatementLine(source, index + 1);
    if (braceDepth === 0 && char === "\n") return index + 1;
  }
  return source.length;
}

function endOfStatementLine(source: string, offset: number): number {
  if (source.slice(offset, offset + 2) === "\r\n") return offset + 2;
  if (source[offset] === "\n") return offset + 1;
  return offset;
}

function isIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/u.test(char);
}

function skipInlineWhitespace(source: string, offset: number): number {
  let index = offset;
  while (source[index] === " " || source[index] === "\t") {
    index += 1;
  }
  return index;
}

function quotedLiteralEnd(source: string, offset: number, quote: string): number {
  for (let index = offset + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === quote) return index;
  }
  return source.length - 1;
}

function firstExplicitRelativeSpecifier(source: string): string | undefined {
  const importPattern = /^\s*(?:import|export)\b[^\r\n]*\bfrom\s*["'](?<specifier>\.{1,2}\/[^"']+)["']/gm;
  for (
    let match: RegExpExecArray | null = importPattern.exec(source);
    match;
    match = importPattern.exec(source)
  ) {
    const specifier = match.groups?.["specifier"];
    if (explicitSpecifierExtension(specifier)) return specifier;
  }
  return undefined;
}

function importFromMovedTarget(sourceFile: string, source: string, name: string, targetFile: string): string {
  const specifierStyle = firstExplicitRelativeSpecifier(source);
  return `import { ${name} } from '${relativeSpecifier(sourceFile, targetFile, specifierStyle)}';\n`;
}

function bindingLocalName(binding: ImportBinding): string | undefined {
  if (binding.kind === "namespace") return binding.localNS;
  if (binding.kind === "star") return undefined;
  return binding.local;
}

function bindingImportText(binding: ImportBinding, targetFile: string): string | undefined {
  const local = bindingLocalName(binding);
  if (!local || typeof binding.resolved !== "string") return undefined;
  const specifier = relativeSpecifier(targetFile, binding.resolved, binding.from);
  const quote = "'";
  if (binding.kind === "default") {
    const importKeyword = binding.typeOnly ? "import type" : "import";
    return `${importKeyword} ${binding.local} from ${quote}${specifier}${quote};\n`;
  }
  if (binding.kind === "namespace") {
    const importKeyword = binding.typeOnly ? "import type" : "import";
    return `${importKeyword} * as ${binding.localNS} from ${quote}${specifier}${quote};\n`;
  }
  if (binding.kind === "star") return undefined;
  const importKeyword = binding.typeOnly ? "import type" : "import";
  const specifierText = binding.imported === binding.local ? binding.imported : `${binding.imported} as ${binding.local}`;
  return `${importKeyword} { ${specifierText} } from ${quote}${specifier}${quote};\n`;
}

function dependencyImportsForMovedBody(index: ProjectIndex, sourceFile: string, targetFile: string, body: string): string {
  const mod = index.byFile.get(sourceFile);
  if (!mod) return "";
  const maskedBody = maskInactiveCode(body);
  const imports: string[] = [];
  const seen = new Set<string>();
  for (const binding of mod.imports) {
    const local = bindingLocalName(binding);
    if (!local || !new RegExp(`\\b${escapeRegExp(local)}\\b`).test(maskedBody)) continue;
    const text = bindingImportText(binding, targetFile);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    imports.push(text);
  }
  return imports.join("");
}

function maskInactiveCode(source: string): string {
  const chars = source.split("");

  function maskChar(index: number): void {
    if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  }

  function maskRange(start: number, end: number): void {
    for (let index = start; index < end; index += 1) {
      maskChar(index);
    }
  }

  function skipLineComment(start: number, end: number): number {
    let index = start;
    while (index < end && source[index] !== "\n") {
      index += 1;
    }
    maskRange(start, index);
    return index;
  }

  function skipBlockComment(start: number, end: number): number {
    let index = start + 2;
    while (index < end && !(source[index] === "*" && source[index + 1] === "/")) {
      index += 1;
    }
    const commentEnd = index < end ? index + 2 : end;
    maskRange(start, commentEnd);
    return commentEnd;
  }

  function skipQuoted(start: number, end: number, quote: string): number {
    let index = start + 1;
    maskChar(start);
    while (index < end) {
      maskChar(index);
      if (source[index] === "\\") {
        index += 1;
        if (index < end) maskChar(index);
      } else if (source[index] === quote) {
        return index + 1;
      }
      index += 1;
    }
    return index;
  }

  function scanTemplate(start: number, end: number): number {
    let index = start + 1;
    maskChar(start);
    while (index < end) {
      if (source[index] === "\\") {
        maskChar(index);
        index += 1;
        if (index < end) maskChar(index);
      } else if (source[index] === "`") {
        maskChar(index);
        return index + 1;
      } else if (source[index] === "$" && source[index + 1] === "{") {
        index = scanCode(index + 2, end, "}");
      } else {
        maskChar(index);
      }
      index += 1;
    }
    return index;
  }

  function scanCode(start: number, end: number, stopChar: string | null): number {
    let braceDepth = 0;
    let index = start;
    while (index < end) {
      const char = source[index];
      const next = source[index + 1];
      if (stopChar && char === "}" && braceDepth === 0) return index;
      if (char === "/" && next === "/") {
        index = skipLineComment(index, end);
        continue;
      }
      if (char === "/" && next === "*") {
        index = skipBlockComment(index, end);
        continue;
      }
      if (char === "'" || char === '"') {
        index = skipQuoted(index, end, char);
        continue;
      }
      if (char === "`") {
        index = scanTemplate(index, end);
        continue;
      }
      if (stopChar && char === "{") braceDepth += 1;
      if (stopChar && char === "}" && braceDepth > 0) braceDepth -= 1;
      index += 1;
    }
    return index;
  }

  scanCode(0, source.length, null);
  return chars.join("");
}

function isMoveSupportedFile(file: string): boolean {
  const languageId = supportForFile(file)?.id;
  return languageId === "ts" || languageId === "tsx" || languageId === "js" || languageId === "jsx";
}

function normalizeTargetFile(index: ProjectIndex, targetFile: FileId): string {
  return normalizeProjectFile(index.projectRoot, targetFile);
}

function targetBoundaryReason(index: ProjectIndex, targetFile: string): string | null {
  if (!index.projectRoot || isWithinProjectRoot(index.projectRoot, targetFile)) return null;
  return "target file is outside project root";
}

export async function moveSymbol(
  index: ProjectIndex,
  id: SymbolHandle,
  targetFile: FileId,
  opts: MoveOptions = {},
): Promise<RefactorResult> {
  const def = resolveSymbolId(index, id);
  if (!def) {
    return { status: "error", edits: [], warnings: [], reason: "unknown handle" };
  }
  const normalizedTarget = normalizeTargetFile(index, targetFile);
  const boundaryReason = targetBoundaryReason(index, normalizedTarget);
  if (boundaryReason) {
    return { status: "unsupported", edits: [], warnings: [], reason: boundaryReason };
  }
  if (def.file === normalizedTarget) {
    return { status: "unsupported", edits: [], warnings: [], reason: "symbol is already in target file" };
  }
  if (!isMoveSupportedFile(def.file) || !isMoveSupportedFile(normalizedTarget)) {
    return {
      status: "unsupported",
      edits: [],
      warnings: [],
      reason: "move is only supported for TypeScript and JavaScript files",
    };
  }
  if (fs.existsSync(normalizedTarget) && !index.byFile.has(normalizedTarget)) {
    return { status: "unsupported", edits: [], warnings: [], reason: "target file exists but was not indexed" };
  }
  if (targetHasCollision(index, normalizedTarget, def.localName)) {
    return { status: "unsupported", edits: [], warnings: [], reason: `target already declares ${def.localName}` };
  }

  let source: string;
  try {
    source = fs.readFileSync(def.file, "utf8");
  } catch (error) {
    return {
      status: "error",
      edits: [],
      warnings: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const fullRange = getSymbolRange(index, def, { trivia: opts.trivia ?? "leading-all", source: "disk" });
  const start = fullRange.start.index;
  const end = fullRange.end.index;
  if (start === undefined || end === undefined || end < start) {
    return { status: "error", edits: [], warnings: [], reason: "symbol range does not include byte offsets" };
  }

  const body = source.slice(start, end).trimEnd();
  const insertion = readTargetInsertion(normalizedTarget, body);
  const dependencyImports = dependencyImportsForMovedBody(index, def.file, normalizedTarget, body);
  const deleteEnd = deleteEndForRange(end, source);
  const references = await findReferencesById(index, id);
  if (references.status !== "ok") {
    return { status: "error", edits: [], warnings: [], reason: references.reason };
  }
  const sourceKeepsReference = references.references.some((reference) => {
    const referenceStart = reference.range.start.index;
    return (
      reference.file === def.file &&
      referenceStart !== undefined &&
      (referenceStart < start || deleteEnd <= referenceStart)
    );
  });
  const importText = sourceKeepsReference ? importFromMovedTarget(def.file, source, def.localName, normalizedTarget) : "";
  const sourceImportOffset = importInsertionOffset(source);
  const deleteEditNewText =
    importText && start <= sourceImportOffset && sourceImportOffset <= deleteEnd ? importText : "";
  const targetImportOffset = importInsertionOffset(insertion.source);
  const targetInsertionText =
    dependencyImports && insertion.offset === targetImportOffset
      ? `${dependencyImports}\n${insertion.text}`
      : insertion.text;
  const edits: TextEdit[] = [
    { ...rangeToDeleteEdit(def.file, start, end, source), newText: deleteEditNewText },
  ];
  if (dependencyImports && insertion.offset !== targetImportOffset) {
    edits.push({
      file: normalizedTarget,
      start: targetImportOffset,
      end: targetImportOffset,
      newText: `${dependencyImports}\n`,
    });
  }
  edits.push({
    file: normalizedTarget,
    start: insertion.offset,
    end: insertion.offset,
    newText: targetInsertionText,
  });
  if (importText && deleteEditNewText.length === 0) {
    edits.push({ file: def.file, start: sourceImportOffset, end: sourceImportOffset, newText: importText });
  }

  for (const mod of index.byFile.values()) {
    const sourceSpecifiers = new Set(
      mod.imports
        .filter((binding) => binding.resolved === def.file)
        .map((binding) => binding.from),
    );
    for (const from of sourceSpecifiers) {
      edits.push(...importEditsForSpecifier(mod.file, from, def.localName, normalizedTarget));
    }
  }

  return { status: "ok", edits, warnings: [] };
}
