import fs from "node:fs";
import path from "node:path";
import { PY_SUPPORT } from "../../languages.js";
import type { SyntaxTreeLike } from "../../languages/types.js";
import { ProjectedSyntaxTree } from "../../native/projected-tree.js";
import { getNativeSyntaxTreeExecution, type NativeMatch } from "../../native/tree-sitter-native.js";
import { maskPythonCommentsAndStrings, stripPythonCommentsAndStrings } from "../../util/comments.js";
import { PYTHON_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import { fileIdentityKey } from "../../util/paths.js";
import { resolveSpecifierTargets } from "../../util/resolution/specifier-targets.js";
import { resolvePythonSubmoduleExact } from "../../util/resolution/python.js";
import { utf8ByteOffsetToStringIndex } from "../../util/rust-test-modules.js";
import {
  pythonStatements,
  pythonTypeCheckingContext,
  startsPythonCompoundHeader,
} from "../../util/python-type-checking.js";
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

async function resolvePythonImportTarget(
  projectRoot: string,
  fromFile: string,
  moduleSpec: string,
): Promise<ResolvedImportTarget> {
  const targets = await resolveSpecifierTargets(fromFile, moduleSpec, "python", {
    projectRoot,
  });
  const resolvedFile = targets.files[0];
  if (targets.files.length === 1 && resolvedFile) return resolvedFile;
  return { external: targets.externalName };
}

async function pushStarImport(
  context: PythonImportExtractionContext,
  moduleSpec: string,
  moduleLevel: boolean,
  typeOnly: boolean,
): Promise<void> {
  const resolved = await resolvePythonImportTarget(context.projectRoot, context.file, moduleSpec);
  context.pushBinding({
    kind: "star",
    from: moduleSpec,
    resolved,
    mechanism: "python",
    moduleLevel,
    ...(typeOnly ? { typeOnly: true } : {}),
  });
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
      const target = await resolvePythonImportTarget(context.projectRoot, resolved, specifier);
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
        const target = await resolvePythonImportTarget(context.projectRoot, resolved, dotted);
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
  typeOnly: boolean,
): Promise<void> {
  const resolved = await resolvePythonImportTarget(context.projectRoot, context.file, moduleSpec);
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
      ...(typeOnly ? { typeOnly: true } : {}),
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
    ...(typeOnly ? { typeOnly: true } : {}),
  });
}

async function pushDefaultImport(
  context: PythonImportExtractionContext,
  dotted: string,
  local: string,
  moduleLevel: boolean,
  explicitAlias: boolean,
  typeOnly: boolean,
): Promise<void> {
  const resolved = await resolvePythonImportTarget(context.projectRoot, context.file, dotted);
  context.pushBinding({
    kind: "namespace",
    localNS: local,
    from: dotted,
    ...(explicitAlias ? { explicitAlias: true } : {}),
    resolved,
    mechanism: "python",
    moduleLevel,
    ...(typeOnly ? { typeOnly: true } : {}),
  });
}

const PYTHON_NAMED_IMPORT_PATTERN = new RegExp(
  String.raw`^(${PYTHON_IDENTIFIER_SOURCE})(?:\s+as\s+(${PYTHON_IDENTIFIER_SOURCE}))?$`,
  "u",
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
  if (startsPythonCompoundHeader(cleaned)) return false;
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
/** Start of the line holding `index`; Python ends lines with LF, CRLF, or a lone CR. */
function pythonLineStart(text: string, index: number): number {
  return Math.max(text.lastIndexOf("\n", index - 1), text.lastIndexOf("\r", index - 1)) + 1;
}

function isModuleLevelKeywordInStrippedSource(maskedSrc: string, keywordStart: number): boolean {
  const lineStart = pythonLineStart(maskedSrc, keywordStart);
  return isPythonModuleLevelImportPrefix(maskedSrc.slice(lineStart, keywordStart));
}

function normalizePythonImportStatement(statement: string): string {
  return stripPythonCommentsAndStrings(statement)
    .replace(/\\(?:\r\n|\r|\n)[\t ]*/g, " ")
    .trim();
}

async function collectPythonImportStatement(
  context: PythonImportExtractionContext,
  statement: string,
  moduleLevel: boolean,
  typeOnly: boolean,
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
        await pushStarImport(context, moduleSpec, moduleLevel, typeOnly);
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
        typeOnly,
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
      typeOnly,
    );
  }
  return true;
}

export async function collectPythonImportsFromNativeMatches(
  context: PythonImportExtractionContext,
  matches: readonly NativeMatch[],
): Promise<void> {
  const isTypeOnly = pythonTypeCheckingContext(context.source);
  for (const match of matches) {
    const statementCapture = match.captures.find((capture) => capture.name === "stmt");
    if (!statementCapture) continue;
    const startIndex = utf8ByteOffsetToStringIndex(context.source, statementCapture.start.index);
    const lineStart = pythonLineStart(context.source, startIndex);
    const prefix = context.source.slice(lineStart, startIndex);
    const moduleLevel = isPythonModuleLevelImportPrefix(prefix);
    await collectPythonImportStatement(context, statementCapture.text, moduleLevel, isTypeOnly(startIndex), startIndex);
  }
}

export async function collectPythonImportsFromSource(context: PythonImportExtractionContext): Promise<void> {
  // Masked (not stripped): comment/string content becomes same-length whitespace instead of
  // being deleted, so every `match.index`/group position below is an exact offset into
  // `context.source` and named bindings can be range-attributed the same way the native
  // match path is.
  const pySrc = maskPythonCommentsAndStrings(context.source);
  const isTypeOnly = pythonTypeCheckingContext(context.source);
  // Each simple statement, including one-line suites and `a; b`, goes through the native
  // statement parser: `from` imports first, then `import a, b as c` lists.
  const statements = pythonStatements(pySrc);
  for (const keyword of ["from", "import"]) {
    const startsStatement = new RegExp(String.raw`^${keyword}\s`, "u");
    for (const { start, end } of statements) {
      if (!startsStatement.test(pySrc.slice(start, end))) continue;
      const moduleLevel = isModuleLevelKeywordInStrippedSource(pySrc, start);
      await collectPythonImportStatement(
        context,
        context.source.slice(start, end),
        moduleLevel,
        isTypeOnly(start),
        start,
      );
    }
  }
}
