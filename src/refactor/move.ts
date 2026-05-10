import fs from "node:fs";
import path from "node:path";
import { resolveSymbolId } from "../indexer/symbols.js";
import type { ProjectIndex, SymbolHandle } from "../indexer/types.js";
import type { FileId } from "../types.js";
import { getSymbolRange } from "./trivia.js";
import type { RefactorResult, TextEdit, TriviaMode } from "./types.js";

export interface MoveOptions {
  trivia?: TriviaMode;
  createTargetFile?: boolean;
  exportFromTarget?: boolean;
  leaveSourceShim?: boolean;
  importStyle?: "named" | "default" | "preserve";
}

function rangeToDeleteEdit(file: string, start: number, end: number, source: string): TextEdit {
  let deleteEnd = end;
  if (source.slice(deleteEnd, deleteEnd + 2) === "\r\n") {
    deleteEnd += 2;
  } else if (source[deleteEnd] === "\n") {
    deleteEnd += 1;
  }
  return { file, start, end: deleteEnd, newText: "" };
}

function insertionPointForTarget(targetFile: string): number {
  try {
    return fs.readFileSync(targetFile, "utf8").length;
  } catch {
    return 0;
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

export function moveSymbol(
  index: ProjectIndex,
  id: SymbolHandle,
  targetFile: FileId,
  opts: MoveOptions = {},
): Promise<RefactorResult> {
  const def = resolveSymbolId(index, id);
  if (!def) {
    return Promise.resolve({ status: "error", edits: [], warnings: [], reason: "unknown handle" });
  }
  const normalizedTarget = path.resolve(targetFile).replace(/\\/g, "/");
  if (def.file === normalizedTarget) {
    return Promise.resolve({ status: "unsupported", edits: [], warnings: [], reason: "symbol is already in target file" });
  }
  if (targetHasCollision(index, normalizedTarget, def.localName)) {
    return Promise.resolve({ status: "unsupported", edits: [], warnings: [], reason: `target already declares ${def.localName}` });
  }

  let source: string;
  try {
    source = fs.readFileSync(def.file, "utf8");
  } catch (error) {
    return Promise.resolve({
      status: "error",
      edits: [],
      warnings: [],
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const fullRange = getSymbolRange(index, def, { trivia: opts.trivia ?? "leading-all" });
  const start = fullRange.start.index;
  const end = fullRange.end.index;
  if (start === undefined || end === undefined || end < start) {
    return Promise.resolve({ status: "error", edits: [], warnings: [], reason: "symbol range does not include byte offsets" });
  }

  const body = source.slice(start, end).trimEnd();
  const edits: TextEdit[] = [
    rangeToDeleteEdit(def.file, start, end, source),
    {
      file: normalizedTarget,
      start: insertionPointForTarget(normalizedTarget),
      end: insertionPointForTarget(normalizedTarget),
      newText: `${body}\n`,
    },
  ];

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

  return Promise.resolve({ status: "ok", edits, warnings: [] });
}
