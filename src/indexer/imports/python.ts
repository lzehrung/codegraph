import fs from "node:fs";
import path from "node:path";
import { PY_SUPPORT } from "../../languages.js";
import type { SyntaxTreeLike } from "../../languages/types.js";
import { ProjectedSyntaxTree } from "../../native/projected-tree.js";
import { getNativeSyntaxTreeExecution, type NativeMatch } from "../../native/tree-sitter-native.js";
import { maskPythonCommentsAndStrings, stripPythonCommentsAndStrings } from "../../util/comments.js";
import { PYTHON_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import { fileIdentityKey } from "../../util/paths.js";
import { resolvePythonModule } from "../../util/resolution.js";
import { utf8ByteOffsetToStringIndex } from "../../util/rust-test-modules.js";
import { buildScopeIndexFromSource } from "../scope.js";
import type { ImportBinding } from "../types.js";
import { attributeNamedBindingRanges } from "./binding-ranges.js";
import type { ImportBindingSink, ResolvedImportTarget } from "./context.js";

export type PythonImportExtractionContext = ImportBindingSink & {
  file: string;
  projectRoot: string;
  source: string;
  getBindings: () => ImportBinding[];
  packageSources?: Map<string, PythonPackageSource | null>;
};

function splitRelativeModuleSpec(moduleSpec: string): { relDots: number; mod: string | null } {
  const match = moduleSpec.match(/^(\.+)(.*)$/);
  if (!match) return { relDots: 0, mod: moduleSpec };
  return {
    relDots: match[1]!.length,
    mod: match[2] || null,
  };
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

/**
 * The submodule `from pkg import name` binds when `pkg` has no attribute `name`: `name.py`,
 * `name.pyi`, `name/__init__.py`, `name/__init__.pyi`, then a PEP 420 directory `name/`.
 * Python compares entries case-sensitively even on case-insensitive filesystems, so `Widget`
 * never names `widget.py`; the import stays a named binding of the package attribute.
 */
export function resolvePythonSubmoduleExact(resolved: ResolvedImportTarget, imported: string): string | undefined {
  if (typeof resolved !== "string") return undefined;
  let baseDir = resolved;
  let entries: fs.Dirent[];
  try {
    if (!fs.statSync(baseDir).isDirectory()) {
      const base = path.basename(baseDir);
      if (base !== "__init__.py" && base !== "__init__.pyi") return undefined;
      baseDir = path.dirname(baseDir);
    }
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const fileName of [`${imported}.py`, `${imported}.pyi`]) {
    if (entries.some((entry) => entry.isFile() && entry.name === fileName)) {
      return path.join(baseDir, fileName).replace(/\\/g, "/");
    }
  }
  if (!entries.some((entry) => entry.isDirectory() && entry.name === imported)) return undefined;
  const packageDir = path.join(baseDir, imported);
  let packageEntries: fs.Dirent[];
  try {
    packageEntries = fs.readdirSync(packageDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const initializer of ["__init__.py", "__init__.pyi"]) {
    if (packageEntries.some((entry) => entry.isFile() && entry.name === initializer)) {
      return path.join(packageDir, initializer).replace(/\\/g, "/");
    }
  }
  return packageDir.replace(/\\/g, "/");
}

type PythonPackageSource = {
  tree: SyntaxTreeLike;
  moduleBindings: ReturnType<typeof buildScopeIndexFromSource>["allScopes"][number]["map"];
};

/** Inspect only the resolved package initializer, and only when a competing submodule exists. */
function pythonPackageSource(context: PythonImportExtractionContext, file: string): PythonPackageSource | null {
  context.packageSources ??= new Map();
  if (context.packageSources.has(file)) return context.packageSources.get(file) ?? null;
  let result: PythonPackageSource | null = null;
  try {
    const source = fs.readFileSync(file, "utf8");
    const syntax = getNativeSyntaxTreeExecution(source, PY_SUPPORT).tree;
    if (syntax) {
      const tree = new ProjectedSyntaxTree(source, syntax);
      const scope = buildScopeIndexFromSource(file, source, PY_SUPPORT, [], { tree });
      result = { tree, moduleBindings: scope.allScopes[0]!.map };
    }
  } catch {
    // A missing/unreadable initializer gives no proof that a submodule is safe to choose.
  }
  context.packageSources.set(file, result);
  return result;
}

async function pythonPackageMayBindAttribute(
  context: PythonImportExtractionContext,
  resolved: ResolvedImportTarget,
  imported: string,
  submodule: string,
): Promise<boolean> {
  if (typeof resolved !== "string") return false;
  const basename = path.basename(resolved);
  if (basename !== "__init__.py" && basename !== "__init__.pyi") return false;
  const packageSource = pythonPackageSource(context, resolved);
  if (!packageSource) return true;

  const localDefinition = packageSource.moduleBindings.get(PY_SUPPORT.normalizeIdentifier(imported))?.def?.start.index;
  let attribute = localDefinition !== undefined;
  const submoduleKey = fileIdentityKey(submodule);
  const packageKey = fileIdentityKey(resolved);
  for (const statement of packageSource.tree.rootNode.namedChildren) {
    if (localDefinition !== undefined && statement.startIndex < localDefinition) continue;
    if (statement.type === "import_from_statement") {
      const specifier = statement.childForFieldName("module_name")?.text;
      if (!specifier) continue;
      const { relDots, mod } = splitRelativeModuleSpec(specifier);
      const target = await resolvePythonModule(context.projectRoot, resolved, mod, relDots);
      const targetKey = typeof target === "string" ? fileIdentityKey(target) : undefined;
      const loadsSubmodule = targetKey === submoduleKey;
      if (loadsSubmodule) attribute = false;
      for (const item of statement.namedChildren) {
        if (item.type !== "aliased_import" && item.type !== "dotted_name") continue;
        const name = item.type === "aliased_import" ? item.childForFieldName("name")?.text : item.text;
        const local = item.type === "aliased_import" ? item.childForFieldName("alias")?.text : name;
        if (targetKey === packageKey && name === imported) attribute = false;
        else if (local === imported) attribute = true;
      }
    } else if (statement.type === "import_statement") {
      for (const item of statement.namedChildren) {
        if (item.type !== "aliased_import" && item.type !== "dotted_name") continue;
        const dotted = item.type === "aliased_import" ? item.childForFieldName("name")?.text : item.text;
        if (!dotted) continue;
        const target = await resolvePythonModule(context.projectRoot, resolved, dotted, 0);
        if (typeof target === "string" && fileIdentityKey(target) === submoduleKey) attribute = false;
        else if ((item.type === "aliased_import" ? item.childForFieldName("alias")?.text : dotted) === imported) {
          attribute = true;
        }
      }
    }
  }
  return attribute;
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
  const submodule = resolvePythonSubmoduleExact(resolved, imported);
  if (submodule && !(await pythonPackageMayBindAttribute(context, resolved, imported, submodule))) {
    context.pushBinding({
      kind: "namespace",
      localNS: local,
      from: moduleSpec,
      ...(explicitAlias ? { explicitAlias: true } : {}),
      resolved: submodule,
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
  explicitAlias: boolean,
): Promise<void> {
  const resolved = await resolvePythonModule(context.projectRoot, context.file, dotted, 0);
  context.pushBinding({
    kind: "namespace",
    localNS: local,
    from: dotted,
    ...(explicitAlias ? { explicitAlias: true } : {}),
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
    await pushDefaultImport(
      context,
      dotted,
      aliasMatch[2] ?? dotted.split(".")[0]!,
      moduleLevel,
      aliasMatch[2] !== undefined,
    );
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
    await pushDefaultImport(context, dotted, local, moduleLevel, match[3] !== undefined);
  }
}
