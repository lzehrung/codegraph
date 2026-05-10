import fs from "node:fs";
import path from "node:path";
import { findReferencesById, resolveSymbolId } from "../indexer/symbols.js";
import type { ProjectIndex, SymbolHandle } from "../indexer/types.js";
import type { FileId } from "../types.js";
import { getSymbolRange } from "./trivia.js";
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

function readTargetInsertion(targetFile: string, body: string): { offset: number; text: string } {
  try {
    const source = fs.readFileSync(targetFile, "utf8");
    const prefix = source.length > 0 && !source.endsWith("\n") ? "\n" : "";
    return { offset: source.length, text: `${prefix}${body}\n` };
  } catch {
    return { offset: 0, text: `${body}\n` };
  }
}

function relativeSpecifier(fromFile: string, toFile: string): string {
  const fromDir = path.dirname(fromFile);
  const parsed = path.parse(toFile);
  const targetWithoutExtension = path.join(parsed.dir, parsed.name);
  let relative = path.relative(fromDir, targetWithoutExtension).replace(/\\/g, "/");
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
  const imported = (importedRaw ?? "").trim();
  return {
    imported,
    local: (localRaw ?? imported).trim(),
  };
}

function importEditForSpecifier(modFile: string, from: string, name: string, targetFile: string): TextEdit | null {
  let source: string;
  try {
    source = fs.readFileSync(modFile, "utf8");
  } catch {
    return null;
  }

  const importPattern = new RegExp(
    `import\\s*\\{(?<specifiers>[^}]+)\\}\\s*from\\s*(?<quote>["'])${escapeRegExp(from)}\\k<quote>;?`,
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
    const targetSpecifier = relativeSpecifier(modFile, targetFile);
    const replacement =
      remaining.length > 0
        ? `import { ${remaining.join(", ")} } from ${quote}${from}${quote};\nimport { ${moved.join(", ")} } from ${quote}${targetSpecifier}${quote};`
        : `import { ${moved.join(", ")} } from ${quote}${targetSpecifier}${quote};`;
    return {
      file: modFile,
      start: match.index,
      end: match.index + match[0].length,
      newText: replacement,
    };
  }
  return null;
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
  const importBlock = /^(?:\s*import\b[^\n]*(?:\r?\n|$))+/u.exec(source);
  return importBlock ? importBlock[0].length : 0;
}

function importFromMovedTarget(sourceFile: string, name: string, targetFile: string): string {
  return `import { ${name} } from '${relativeSpecifier(sourceFile, targetFile)}';\n`;
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
  const normalizedTarget = path.resolve(targetFile).replace(/\\/g, "/");
  if (def.file === normalizedTarget) {
    return { status: "unsupported", edits: [], warnings: [], reason: "symbol is already in target file" };
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
  const fullRange = getSymbolRange(index, def, { trivia: opts.trivia ?? "leading-all" });
  const start = fullRange.start.index;
  const end = fullRange.end.index;
  if (start === undefined || end === undefined || end < start) {
    return { status: "error", edits: [], warnings: [], reason: "symbol range does not include byte offsets" };
  }

  const body = source.slice(start, end).trimEnd();
  const insertion = readTargetInsertion(normalizedTarget, body);
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
  const importText = sourceKeepsReference ? importFromMovedTarget(def.file, def.localName, normalizedTarget) : "";
  const sourceImportOffset = importInsertionOffset(source);
  const deleteEditNewText =
    importText && start <= sourceImportOffset && sourceImportOffset <= deleteEnd ? importText : "";
  const edits: TextEdit[] = [
    { ...rangeToDeleteEdit(def.file, start, end, source), newText: deleteEditNewText },
    {
      file: normalizedTarget,
      start: insertion.offset,
      end: insertion.offset,
      newText: insertion.text,
    },
  ];
  if (importText && deleteEditNewText.length === 0) {
    edits.push({ file: def.file, start: sourceImportOffset, end: sourceImportOffset, newText: importText });
  }

  for (const mod of index.byFile.values()) {
    const sourceSpecifiers = new Set(
      mod.imports
        .filter((binding) => binding.kind === "named" && binding.resolved === def.file)
        .map((binding) => binding.from),
    );
    for (const from of sourceSpecifiers) {
      const edit = importEditForSpecifier(mod.file, from, def.localName, normalizedTarget);
      if (edit) edits.push(edit);
    }
  }

  return { status: "ok", edits, warnings: [] };
}
