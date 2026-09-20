import fs from "node:fs";
import path from "node:path";
import { resolvePythonModule } from "../../util/resolution.js";
import { maskPythonCommentsAndStrings, stripPythonCommentsAndStrings } from "../../util/comments.js";
import { PYTHON_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import type { NativeMatch } from "../../native/tree-sitter-native.js";
import { utf8ByteOffsetToStringIndex } from "../../util/rust-test-modules.js";
import type { ImportBindingSink, ResolvedImportTarget } from "./context.js";
import { attributeNamedBindingRanges } from "./binding-ranges.js";
import type { ImportBinding } from "../types.js";

export type PythonImportExtractionContext = ImportBindingSink & {
  file: string;
  projectRoot: string;
  source: string;
  getBindings: () => ImportBinding[];
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
  explicitAlias: boolean,
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
    ...(explicitAlias ? { explicitAlias: true } : {}),
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
// Matches at a physical line start (capturing its indentation) or immediately after a `;`
// that ends a preceding simple statement on the same line, so `x = 1; import os` and a
// multi-line parenthesized statement's trailing `; import os` are both recognized. A
// compound-suite header's `:` is deliberately excluded, so `if x: import os` still is not.
const PYTHON_MODULE_IMPORT_PATTERN = new RegExp(
  String.raw`(^[\t ]*|;[\t ]*)import\s+(${PYTHON_IDENTIFIER_SOURCE}(?:\.${PYTHON_IDENTIFIER_SOURCE})*)\s*(?:as\s+(${PYTHON_IDENTIFIER_SOURCE}))?`,
  "gmu",
);
const PYTHON_MODULE_LIST_ITEM_PATTERN = new RegExp(
  String.raw`^(${PYTHON_IDENTIFIER_SOURCE}(?:\.${PYTHON_IDENTIFIER_SOURCE})*)(?:\s+as\s+(${PYTHON_IDENTIFIER_SOURCE}))?$`,
  "u",
);

function isPythonModuleLevelImportPrefix(prefix: string): boolean {
  if (/^[\t ]/.test(prefix)) return false;
  const cleaned = stripPythonCommentsAndStrings(prefix).trim();
  if (!cleaned) return true;
  // A same-line suite belongs to its compound statement, not the module.
  if (/^(?:async\s+)?(?:if|elif|else|for|while|try|except|finally|with|def|class)\b/.test(cleaned)) {
    return false;
  }
  const delimiters: string[] = [];
  for (const char of cleaned) {
    if (char === "(") delimiters.push(")");
    else if (char === "[") delimiters.push("]");
    else if (char === "{") delimiters.push("}");
    else if (char === ")" || char === "]" || char === "}") {
      // A closing delimiter with no matching open on this physical line belongs to a
      // bracket opened on a preceding physical line (e.g. a multi-line parenthesized
      // statement or suite header); it does not by itself make this a nested suite.
      if (delimiters[delimiters.length - 1] === char) delimiters.pop();
    }
  }
  if (delimiters.length || !cleaned.endsWith(";")) return false;
  return true;
}

// `maskedSrc` has comments/strings blanked to same-length whitespace (offset-preserving), so
// `keywordStart` and every position derived from it line up with the real source.
// `isPythonModuleLevelImportPrefix` re-strips its input, which is a harmless no-op here
// since `maskedSrc` is already comment/string-free content-wise.
function isModuleLevelKeywordInStrippedSource(maskedSrc: string, keywordStart: number): boolean {
  const lineStart = maskedSrc.lastIndexOf("\n", keywordStart - 1) + 1;
  return isPythonModuleLevelImportPrefix(maskedSrc.slice(lineStart, keywordStart));
}

function normalizePythonImportStatement(statement: string): string {
  return stripPythonCommentsAndStrings(statement)
    .replace(/\\\r?\n[\t ]*/g, " ")
    .trim();
}

async function collectPythonImportStatement(
  context: PythonImportExtractionContext,
  statement: string,
  moduleLevel: boolean,
  statementStartIndex?: number,
): Promise<boolean> {
  const normalized = normalizePythonImportStatement(statement);
  const fromMatch = normalized.match(/^from\s+([^\s]+)\s+import\s+([\s\S]+)$/u);
  if (fromMatch) {
    const moduleSpec = fromMatch[1]!;
    const importedList = fromMatch[2]!.trim().replace(/^\(\s*|\s*\)$/g, "");
    const bindingCountBefore = context.getBindings().length;
    for (const item of maskPythonCommentsAndStrings(importedList)
      .replace(/^\(\s*|\s*\)$/g, "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)) {
      if (item === "*") {
        await pushStarImport(context, moduleSpec, moduleLevel);
        continue;
      }
      const aliasMatch = item.match(PYTHON_NAMED_IMPORT_PATTERN);
      if (!aliasMatch) continue;
      const imported = aliasMatch[1]!;
      await pushNamedImport(
        context,
        moduleSpec,
        imported,
        aliasMatch[2] ?? imported,
        moduleLevel,
        aliasMatch[2] !== undefined,
      );
    }
    if (statementStartIndex !== undefined) {
      // Mask comments and strings without changing UTF-16 offsets. Parenthesized import
      // lists can contain comments before later specifiers, so truncating at the first `#`
      // would discard valid binding tokens and fail the whole range batch.
      const searchText = maskPythonCommentsAndStrings(statement);
      attributeNamedBindingRanges({
        bindings: context.getBindings(),
        fromIndex: bindingCountBefore,
        text: searchText,
        textStartIndex: statementStartIndex,
        source: context.source,
      });
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
    const prefix = context.source.slice(lineStart, startIndex);
    const moduleLevel = isPythonModuleLevelImportPrefix(prefix);
    await collectPythonImportStatement(context, statementCapture.text, moduleLevel, startIndex);
  }
}

export async function collectPythonImportsFromSource(context: PythonImportExtractionContext): Promise<void> {
  // Masked (not stripped): comment/string content becomes same-length whitespace instead of
  // being deleted, so every `match.index`/group position below is an exact offset into
  // `context.source` and named bindings can be range-attributed the same way the native
  // match path is.
  const pySrc = maskPythonCommentsAndStrings(context.source);
  // Boundary group 1 captures either the line's leading indentation or the `;` (plus any
  // following tabs/spaces) that separates this import from a completed simple statement on
  // the same physical line; a compound-suite header's `:` is not part of this alternation, so
  // `if x: import os` still is not recognized as a statement start here.
  const fromLinePattern = /(^[\t ]*|;[\t ]*)from\s+([^\s]+)\s+import\s+(\([\s\S]*?\)|[^\n;#]+)/gm;
  for (const match of pySrc.matchAll(fromLinePattern)) {
    const keywordStart = match.index + match[1]!.length;
    const mod = match[2]!.trim();
    const moduleLevel = isModuleLevelKeywordInStrippedSource(pySrc, keywordStart);
    const listText = match[3]!;
    const bindingListText = maskPythonCommentsAndStrings(listText);
    const bindingCountBefore = context.getBindings().length;
    const items = bindingListText
      .replace(/^\(\s*|\s*\)$/g, "")
      .split(",")
      .map((item) => item.trim());
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
      await pushNamedImport(context, mod, imported, local, moduleLevel, aliasMatch[2] !== undefined);
    }
    // `listText` (group 3) always ends at the same position as `match[0]`, so its own start
    // is a fixed offset back from the full match's end -- no extra re-scan needed.
    const listStart = match.index + match[0].length - listText.length;
    attributeNamedBindingRanges({
      bindings: context.getBindings(),
      fromIndex: bindingCountBefore,
      text: listText,
      textStartIndex: listStart,
      source: context.source,
    });
  }

  const importPattern = PYTHON_MODULE_IMPORT_PATTERN;
  for (const match of pySrc.matchAll(importPattern)) {
    const keywordStart = match.index + match[1]!.length;
    const dotted = match[2]!;
    const local = match[3] ?? dotted.split(".")[0]!;
    const moduleLevel = isModuleLevelKeywordInStrippedSource(pySrc, keywordStart);
    await pushDefaultImport(context, dotted, local, moduleLevel);
  }
}
