import fs from "node:fs";
import path from "node:path";
import { resolvePythonModule } from "../../util/resolution.js";
import { stripPythonCommentsAndStrings } from "../../util/comments.js";
import { PYTHON_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import type { NativeMatch } from "../../native/tree-sitter-native.js";
import { utf8ByteOffsetToStringIndex } from "../../util/rust-test-modules.js";
import type { ImportBindingSink, ResolvedImportTarget } from "./context.js";

export type PythonImportExtractionContext = ImportBindingSink & {
  file: string;
  projectRoot: string;
  source: string;
};

function splitRelativeModuleSpec(moduleSpec: string): { relDots: number; mod: string | null } {
  const match = moduleSpec.match(/^(\.+)(.*)$/);
  if (!match) return { relDots: 0, mod: moduleSpec };
  return {
    relDots: match[1]!.length,
    mod: match[2] || null,
  };
}

function resolvePythonNamespaceMember(resolved: ResolvedImportTarget, imported: string): string | undefined {
  if (typeof resolved !== "string") return undefined;
  let baseDir = resolved;
  try {
    const stat = fs.statSync(baseDir);
    if (
      !stat.isDirectory() &&
      (baseDir.toLowerCase().endsWith("__init__.py") || baseDir.toLowerCase().endsWith("__init__.pyi"))
    ) {
      baseDir = path.dirname(baseDir);
    }
  } catch {
    return undefined;
  }

  const candidates = [
    path.join(baseDir, `${imported}.py`),
    path.join(baseDir, `${imported}.pyi`),
    path.join(baseDir, imported, "__init__.py"),
    path.join(baseDir, imported, "__init__.pyi"),
    path.join(baseDir, imported),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate.replace(/\\/g, "/");
      }
    } catch {
      // Ignore filesystem races and continue trying remaining namespace candidates.
    }
  }
  return undefined;
}

async function pushStarImport(
  context: PythonImportExtractionContext,
  moduleSpec: string,
  moduleLevel: boolean,
): Promise<void> {
  const { relDots, mod } = splitRelativeModuleSpec(moduleSpec);
  const resolved = await resolvePythonModule(context.projectRoot, context.file, mod, relDots);
  context.pushBinding({
    kind: "star",
    from: moduleSpec,
    resolved,
    mechanism: "python",
    moduleLevel,
  });
}

async function pushNamedImport(
  context: PythonImportExtractionContext,
  moduleSpec: string,
  imported: string,
  local: string,
  moduleLevel: boolean,
): Promise<void> {
  const { relDots, mod } = splitRelativeModuleSpec(moduleSpec);
  const resolved = await resolvePythonModule(context.projectRoot, context.file, mod, relDots);
  const namespaceResolved = resolvePythonNamespaceMember(resolved, imported);
  if (namespaceResolved) {
    context.pushBinding({
      kind: "namespace",
      localNS: local,
      from: moduleSpec,
      resolved: namespaceResolved,
      mechanism: "python",
      moduleLevel,
    });
    return;
  }

  context.pushBinding({
    kind: "named",
    local,
    imported,
    from: moduleSpec,
    resolved,
    mechanism: "python",
    moduleLevel,
  });
}

async function pushDefaultImport(
  context: PythonImportExtractionContext,
  dotted: string,
  local: string,
  moduleLevel: boolean,
): Promise<void> {
  const resolved = await resolvePythonModule(context.projectRoot, context.file, dotted, 0);
  context.pushBinding({
    kind: "namespace",
    localNS: local,
    from: dotted,
    resolved,
    mechanism: "python",
    moduleLevel,
  });
}

const PYTHON_NAMED_IMPORT_PATTERN = new RegExp(
  String.raw`^(${PYTHON_IDENTIFIER_SOURCE})(?:\s+as\s+(${PYTHON_IDENTIFIER_SOURCE}))?$`,
  "u",
);
const PYTHON_MODULE_IMPORT_PATTERN = new RegExp(
  String.raw`^[\t ]*import\s+(${PYTHON_IDENTIFIER_SOURCE}(?:\.${PYTHON_IDENTIFIER_SOURCE})*)\s*(?:as\s+(${PYTHON_IDENTIFIER_SOURCE}))?`,
  "gmu",
);
const PYTHON_MODULE_LIST_ITEM_PATTERN = new RegExp(
  String.raw`^(${PYTHON_IDENTIFIER_SOURCE}(?:\.${PYTHON_IDENTIFIER_SOURCE})*)(?:\s+as\s+(${PYTHON_IDENTIFIER_SOURCE}))?$`,
  "u",
);

function normalizePythonImportStatement(statement: string): string {
  return statement.replace(/\\\r?\n[\t ]*/g, " ").trim();
}

async function collectPythonImportStatement(
  context: PythonImportExtractionContext,
  statement: string,
  moduleLevel: boolean,
): Promise<boolean> {
  const normalized = normalizePythonImportStatement(statement);
  const fromMatch = normalized.match(/^from\s+([^\s]+)\s+import\s+([\s\S]+)$/u);
  if (fromMatch) {
    const moduleSpec = fromMatch[1]!;
    const importedList = fromMatch[2]!.trim().replace(/^\(\s*|\s*\)$/g, "");
    for (const item of importedList
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)) {
      if (item === "*") {
        await pushStarImport(context, moduleSpec, moduleLevel);
        continue;
      }
      const aliasMatch = item.match(PYTHON_NAMED_IMPORT_PATTERN);
      if (!aliasMatch) continue;
      const imported = aliasMatch[1]!;
      await pushNamedImport(context, moduleSpec, imported, aliasMatch[2] ?? imported, moduleLevel);
    }
    return true;
  }

  const importMatch = normalized.match(/^import\s+([\s\S]+)$/u);
  if (!importMatch) return false;
  for (const item of importMatch[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const aliasMatch = item.match(PYTHON_MODULE_LIST_ITEM_PATTERN);
    if (!aliasMatch) continue;
    const dotted = aliasMatch[1]!;
    await pushDefaultImport(context, dotted, aliasMatch[2] ?? dotted.split(".")[0]!, moduleLevel);
  }
  return true;
}

export async function collectPythonImportsFromNativeMatches(
  context: PythonImportExtractionContext,
  matches: readonly NativeMatch[],
): Promise<void> {
  for (const match of matches) {
    const statementCapture = match.captures.find((capture) => capture.name === "stmt");
    if (!statementCapture) continue;
    const startIndex = utf8ByteOffsetToStringIndex(context.source, statementCapture.start.index);
    const lineStart = context.source.lastIndexOf("\n", startIndex - 1) + 1;
    const moduleLevel = !/^[\t ]/.test(context.source.slice(lineStart, startIndex));
    await collectPythonImportStatement(context, statementCapture.text, moduleLevel);
  }
}

export async function collectPythonImportsFromSource(context: PythonImportExtractionContext): Promise<void> {
  const pySrc = stripPythonCommentsAndStrings(context.source);
  const fromLinePattern = /^[\t ]*from\s+([^\s]+)\s+import\s+([^\n#]+)/gm;
  for (const match of pySrc.matchAll(fromLinePattern)) {
    const mod = match[1]!.trim();
    const moduleLevel = !/^[\t ]/.test(match[0]);
    const items = match[2]!.split(",").map((item) => item.trim());
    for (const item of items) {
      if (item === "*") {
        await pushStarImport(context, mod, moduleLevel);
        continue;
      }
      // PEP 3131 permits Unicode identifiers (XID_Start/XID_Continue); an ASCII-only
      // character class here silently drops every non-ASCII imported name's binding.
      const aliasMatch = item.match(PYTHON_NAMED_IMPORT_PATTERN);
      if (!aliasMatch) continue;
      const imported = aliasMatch[1]!;
      const local = aliasMatch[2] ?? imported;
      await pushNamedImport(context, mod, imported, local, moduleLevel);
    }
  }

  const importPattern = PYTHON_MODULE_IMPORT_PATTERN;
  for (const match of pySrc.matchAll(importPattern)) {
    const dotted = match[1]!;
    const local = match[2] ?? dotted.split(".")[0]!;
    await pushDefaultImport(context, dotted, local, !/^[\t ]/.test(match[0]));
  }
}
