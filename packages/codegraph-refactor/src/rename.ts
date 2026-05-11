import fs from "node:fs";
import { findReferencesById, resolveSymbolId, supportForFile } from "@lzehrung/codegraph";
import { isValidIdentifier } from "./identifier.js";
import type { ProjectIndex, Range, SymbolHandle } from "@lzehrung/codegraph";
import type { RefactorResult, TextEdit } from "./types.js";

function editKey(file: string, range: Range): string {
  return `${file}:${range.start.index ?? 0}:${range.end.index ?? 0}`;
}

function rangeToEdit(file: string, range: Range, oldText: string, newText: string): TextEdit | null {
  const start = range.start.index;
  const end = range.end.index;
  if (start === undefined || end === undefined || end < start) return null;
  try {
    const source = fs.readFileSync(file, "utf8");
    if (source.slice(start, end) !== oldText) return null;
  } catch {
    return null;
  }
  return {
    file,
    start,
    end,
    newText,
    display: range,
  };
}

function isImportHandle(id: SymbolHandle): boolean {
  return id.split("::")[2] === "import";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function collectNamedImportEdits(
  index: ProjectIndex,
  oldName: string,
  targetFile: string,
  newName: string,
): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const mod of index.byFile.values()) {
    const sourceSpecifiers = Array.from(
      new Set(
        mod.imports
          .filter((binding) => binding.resolved === targetFile)
          .map((binding) => binding.from),
      ),
    );
    if (sourceSpecifiers.length === 0) continue;
    let source: string;
    try {
      source = fs.readFileSync(mod.file, "utf8");
    } catch {
      continue;
    }
    for (const from of sourceSpecifiers) {
      const importPattern = new RegExp(
        `import\\s+(?:type\\s+)?\\{(?<specifiers>[^}]+)\\}\\s*from\\s*["']${escapeRegExp(from)}["']`,
        "g",
      );
      for (let match: RegExpExecArray | null = importPattern.exec(source); match; match = importPattern.exec(source)) {
        const specifiers = match.groups?.["specifiers"];
        if (!specifiers) continue;
        const specifierOffset = match.index + match[0].indexOf(specifiers);
        const specifierPattern = /[^,]+/g;
        for (
          let specifierMatch: RegExpExecArray | null = specifierPattern.exec(specifiers);
          specifierMatch;
          specifierMatch = specifierPattern.exec(specifiers)
        ) {
          const specifier = specifierMatch[0];
          const names = specifierNames(specifier);
          if (names.imported !== oldName) continue;
          const importedOffset = specifier.search(new RegExp(`\\b${escapeRegExp(oldName)}\\b`));
          if (importedOffset < 0) continue;
          const start = specifierOffset + specifierMatch.index + importedOffset;
          const end = start + oldName.length;
          edits.push({ file: mod.file, start, end, newText: newName });
          break;
        }
      }
    }
  }
  return edits;
}

export async function renameSymbol(
  index: ProjectIndex,
  id: SymbolHandle,
  newName: string,
): Promise<RefactorResult> {
  if (isImportHandle(id)) {
    return {
      status: "unsupported",
      edits: [],
      warnings: [],
      reason: "rename import aliases by renaming the original declaration",
    };
  }

  const def = resolveSymbolId(index, id);
  if (!def) {
    return {
      status: "error",
      edits: [],
      warnings: [],
      reason: "unknown handle",
    };
  }

  const languageId = supportForFile(def.file)?.id ?? "ts";
  const identifier = isValidIdentifier(languageId, newName);
  if (!identifier.ok) {
    return {
      status: "unsupported",
      edits: [],
      warnings: [],
      reason: identifier.reason,
    };
  }

  if (def.localName === newName) {
    return { status: "ok", edits: [], warnings: [] };
  }

  const references = await findReferencesById(index, id);
  if (references.status !== "ok") {
    return {
      status: "error",
      edits: [],
      warnings: [],
      reason: references.reason,
    };
  }

  const edits: TextEdit[] = [];
  const seen = new Set<string>();
  const declarationEdit = rangeToEdit(def.file, def.range, def.localName, newName);
  if (declarationEdit) {
    edits.push(declarationEdit);
    seen.add(editKey(def.file, def.range));
  }

  for (const reference of references.references) {
    const key = editKey(reference.file, reference.range);
    if (seen.has(key)) continue;
    const edit = rangeToEdit(reference.file, reference.range, def.localName, newName);
    if (!edit) continue;
    edits.push(edit);
    seen.add(key);
  }

  for (const importEdit of collectNamedImportEdits(index, def.localName, def.file, newName)) {
    const key = `${importEdit.file}:${importEdit.start}:${importEdit.end}`;
    if (seen.has(key)) continue;
    edits.push(importEdit);
    seen.add(key);
  }

  return {
    status: "ok",
    edits,
    warnings: [],
  };
}
