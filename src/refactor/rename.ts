import fs from "node:fs";
import { supportForFile } from "../languages.js";
import { findReferencesById, resolveSymbolId } from "../indexer/symbols.js";
import { isValidIdentifier } from "./identifier.js";
import type { ProjectIndex, SymbolHandle } from "../indexer/types.js";
import type { Range } from "../types.js";
import type { RefactorResult, TextEdit } from "./types.js";

export interface RenameOptions {
  includeStringMatches?: boolean;
}

function editKey(file: string, range: Range): string {
  return `${file}:${range.start.index ?? 0}:${range.end.index ?? 0}`;
}

function rangeToEdit(file: string, range: Range, newText: string): TextEdit | null {
  const start = range.start.index;
  const end = range.end.index;
  if (start === undefined || end === undefined || end < start) return null;
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

function collectNamedImportEdits(index: ProjectIndex, oldName: string, targetFile: string, newName: string): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const mod of index.byFile.values()) {
    const namedImports = mod.imports.filter(
      (binding) =>
        binding.kind === "named" &&
        binding.imported === oldName &&
        binding.local === oldName &&
        binding.resolved === targetFile,
    );
    if (namedImports.length === 0) continue;
    let source: string;
    try {
      source = fs.readFileSync(mod.file, "utf8");
    } catch {
      continue;
    }
    for (const binding of namedImports) {
      const importPattern = new RegExp(
        `import\\s*\\{(?<specifiers>[^}]+)\\}\\s*from\\s*["']${escapeRegExp(binding.from)}["']`,
        "g",
      );
      for (let match: RegExpExecArray | null = importPattern.exec(source); match; match = importPattern.exec(source)) {
        const specifiers = match.groups?.["specifiers"];
        if (!specifiers) continue;
        const specifierOffset = match.index + match[0].indexOf(specifiers);
        const nameMatch = new RegExp(`\\b${escapeRegExp(oldName)}\\b`).exec(specifiers);
        if (!nameMatch?.index && nameMatch?.index !== 0) continue;
        const start = specifierOffset + nameMatch.index;
        const end = start + oldName.length;
        edits.push({ file: mod.file, start, end, newText: newName });
        break;
      }
    }
  }
  return edits;
}

export async function renameSymbol(
  index: ProjectIndex,
  id: SymbolHandle,
  newName: string,
  _opts: RenameOptions = {},
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
  const declarationEdit = rangeToEdit(def.file, def.range, newName);
  if (declarationEdit) {
    edits.push(declarationEdit);
    seen.add(editKey(def.file, def.range));
  }

  for (const reference of references.references) {
    const key = editKey(reference.file, reference.range);
    if (seen.has(key)) continue;
    const edit = rangeToEdit(reference.file, reference.range, newName);
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
