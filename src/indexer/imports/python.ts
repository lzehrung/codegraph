import fs from "node:fs";
import path from "node:path";
import { PY_SUPPORT } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { ProjectedSyntaxTree } from "../../native/projected-tree.js";
import { getNativeSyntaxTreeExecution, type NativeMatch } from "../../native/tree-sitter-native.js";
import { maskPythonCommentsAndStrings, stripPythonCommentsAndStrings } from "../../util/comments.js";
import { currentProbeCache, type FsProbeCache } from "../../util/fs-probe-cache.js";
import { PYTHON_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import { fileIdentityKey } from "../../util/paths.js";
import { mapLimit } from "../../util/concurrency.js";
import { resolveSpecifierTargets } from "../../util/resolution/specifier-targets.js";
import { resolvePythonSubmoduleExact } from "../../util/resolution/python.js";
import { utf8ByteOffsetToStringIndex } from "../../util/rust-test-modules.js";
import { pythonTypeCheckingContext, startsPythonCompoundHeader } from "../../util/python-type-checking.js";
import { buildScopeIndexFromSource } from "../scope.js";
import type { ImportBinding, ModuleIndex } from "../types.js";
import { attributeNamedBindingRanges } from "./binding-ranges.js";
import type { ImportBindingSink, ResolvedImportTarget } from "./context.js";

export type PythonImportExtractionContext = ImportBindingSink & {
  file: string;
  projectRoot: string;
  source: string;
  getBindings: () => ImportBinding[];
  /** The package initializers this file's imports read, when no index build shares them across files. */
  packageInitializers?: Map<string, PythonPackageInitializer | null>;
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
  statementStartIndex?: number,
): Promise<void> {
  const resolved = await resolvePythonImportTarget(context.projectRoot, context.file, moduleSpec);
  context.pushBinding({
    kind: "star",
    from: moduleSpec,
    resolved,
    mechanism: "python",
    moduleLevel,
    ...(statementStartIndex !== undefined ? { pythonStatementStartIndex: statementStartIndex } : {}),
    ...(typeOnly ? { typeOnly: true } : {}),
  });
}

type PythonInitializerImportItem = { readonly name: string | undefined; readonly local: string | undefined };

/** A module-level import statement of a package initializer, with every aliased or dotted name it lists. */
type PythonInitializerImport =
  | {
      readonly kind: "from";
      readonly startIndex: number;
      readonly specifier: string;
      readonly items: readonly PythonInitializerImportItem[];
    }
  | { readonly kind: "import"; readonly startIndex: number; readonly items: readonly PythonInitializerImportItem[] };

/** What a package initializer binds at module level, read once from its syntax tree. */
type PythonPackageInitializer = {
  /** The start index of each module-level definition, by normalized name. */
  readonly definitions: ReadonlyMap<string, number>;
  /** Module-level import statements in source order. */
  readonly imports: readonly PythonInitializerImport[];
};

/**
 * The package initializers one index build has read, kept as long as the build's probe cache snapshot (a reset drops
 * them, and the next build reads each file again).
 */
const buildPackageInitializers = new WeakMap<
  FsProbeCache,
  { id: number; initializers: Map<string, PythonPackageInitializer | null> }
>();

/** A build shares what it read of each initializer across its files; outside a build, the importing file keeps it. */
function packageInitializerCache(context: PythonImportExtractionContext): Map<string, PythonPackageInitializer | null> {
  const probes = currentProbeCache();
  if (!probes) return (context.packageInitializers ??= new Map());
  let cached = buildPackageInitializers.get(probes);
  if (cached?.id !== probes.id) {
    cached = { id: probes.id, initializers: new Map() };
    buildPackageInitializers.set(probes, cached);
  }
  return cached.initializers;
}

function initializerImportItems(statement: SyntaxNodeLike): PythonInitializerImportItem[] {
  const items: PythonInitializerImportItem[] = [];
  for (const item of statement.namedChildren) {
    if (item.type === "aliased_import") {
      items.push({ name: item.childForFieldName("name")?.text, local: item.childForFieldName("alias")?.text });
    } else if (item.type === "dotted_name") {
      items.push({ name: item.text, local: item.text });
    }
  }
  return items;
}

function readPythonPackageInitializer(file: string): PythonPackageInitializer | null {
  let tree: ProjectedSyntaxTree;
  const definitions = new Map<string, number>();
  try {
    const source = fs.readFileSync(file, "utf8");
    const syntax = getNativeSyntaxTreeExecution(source, PY_SUPPORT).tree;
    if (!syntax) return null;
    tree = new ProjectedSyntaxTree(source, syntax);
    const moduleScope = buildScopeIndexFromSource(file, source, PY_SUPPORT, [], { tree }).allScopes[0]!;
    for (const [name, binding] of moduleScope.map) {
      const start = binding.def?.start.index;
      if (start !== undefined) definitions.set(name, start);
    }
  } catch {
    // A missing/unreadable initializer gives no proof that a submodule is safe to choose.
    return null;
  }
  const imports: PythonInitializerImport[] = [];
  for (const statement of tree.rootNode.namedChildren) {
    const startIndex = statement.startIndex;
    if (statement.type === "import_from_statement") {
      const specifier = statement.childForFieldName("module_name")?.text;
      if (specifier) imports.push({ kind: "from", startIndex, specifier, items: initializerImportItems(statement) });
    } else if (statement.type === "import_statement") {
      imports.push({ kind: "import", startIndex, items: initializerImportItems(statement) });
    }
  }
  return { definitions, imports };
}

/** Inspect only the resolved package initializer, and only when a competing submodule exists. */
function pythonPackageInitializer(
  context: PythonImportExtractionContext,
  file: string,
): PythonPackageInitializer | null {
  const initializers = packageInitializerCache(context);
  const cached = initializers.get(file);
  if (cached !== undefined) return cached;
  const initializer = readPythonPackageInitializer(file);
  initializers.set(file, initializer);
  return initializer;
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
  const initializer = pythonPackageInitializer(context, resolved);
  if (!initializer) return true;

  const localDefinition = initializer.definitions.get(PY_SUPPORT.normalizeIdentifier(imported));
  let attribute = localDefinition !== undefined;
  const submoduleKey = fileIdentityKey(submodule);
  const packageKey = fileIdentityKey(resolved);
  for (const statement of initializer.imports) {
    if (localDefinition !== undefined && statement.startIndex < localDefinition) continue;
    if (statement.kind === "from") {
      const target = await resolvePythonImportTarget(context.projectRoot, resolved, statement.specifier);
      const targetKey = typeof target === "string" ? fileIdentityKey(target) : undefined;
      const loadsSubmodule = targetKey === submoduleKey;
      if (loadsSubmodule) attribute = false;
      for (const { name, local } of statement.items) {
        if (targetKey === packageKey && name === imported) attribute = false;
        else if (local === imported) attribute = true;
      }
      continue;
    }
    for (const { name: dotted, local } of statement.items) {
      if (!dotted) continue;
      const target = await resolvePythonImportTarget(context.projectRoot, resolved, dotted);
      if (typeof target === "string" && fileIdentityKey(target) === submoduleKey) attribute = false;
      else if (local === imported) attribute = true;
    }
  }
  return attribute;
}

const PYTHON_PACKAGE_INITIALIZERS: ReadonlySet<string> = new Set(["__init__.py", "__init__.pyi"]);
const PYTHON_MODULE_SUFFIX = /\.pyi?$/u;

/** The module a resolved Python target is: `pkg/mod` for `pkg/mod.py` or `pkg/mod/__init__.py`; a directory is itself. */
function pythonModulePath(target: string): string {
  if (PYTHON_PACKAGE_INITIALIZERS.has(path.basename(target))) return path.dirname(target);
  return target.replace(PYTHON_MODULE_SUFFIX, "");
}

/**
 * The cached importers in `importers` whose `from pkg import name` read a package initializer `pkg/__init__.py` (or
 * `.pyi`) among `changedFiles` to choose between the package attribute and the submodule (`pushNamedImport`): a named
 * binding of that initializer whose name a submodule competes for, and a submodule binding whose `from` clause resolves
 * to it. `import pkg.name` binds the submodule without reading the initializer, so its importer is left out, and so is
 * every importer in `skip`.
 */
export async function pythonPackageInitializerReaders(
  projectRoot: string,
  changedFiles: Iterable<string>,
  importers: ReadonlyMap<string, { readonly mod: ModuleIndex }>,
  skip: ReadonlySet<string>,
  concurrency: number,
): Promise<string[]> {
  const initializers = new Set<string>();
  const packages = new Set<string>();
  for (const file of changedFiles) {
    if (!PYTHON_PACKAGE_INITIALIZERS.has(path.basename(file))) continue;
    initializers.add(fileIdentityKey(file));
    packages.add(fileIdentityKey(path.dirname(file)));
  }
  const readers: string[] = [];
  if (!initializers.size) return readers;
  const choseAttributeOfInitializer = (resolved: string, imported: string): boolean =>
    initializers.has(fileIdentityKey(resolved)) && resolvePythonSubmoduleExact(resolved, imported) !== undefined;
  const isSubmoduleOfChangedPackage = (resolved: string): boolean =>
    packages.has(fileIdentityKey(path.dirname(pythonModulePath(resolved))));
  const submoduleImporters: Array<{ file: string; specifiers: Set<string> }> = [];
  for (const [file, { mod }] of importers) {
    if (skip.has(file)) continue;
    let specifiers: Set<string> | undefined;
    let readsInitializer = false;
    for (const binding of mod.imports) {
      if (binding.mechanism !== "python" || typeof binding.resolved !== "string") continue;
      if (binding.kind === "named" && choseAttributeOfInitializer(binding.resolved, binding.imported)) {
        readsInitializer = true;
        break;
      }
      if (binding.kind === "namespace" && isSubmoduleOfChangedPackage(binding.resolved)) {
        (specifiers ??= new Set()).add(binding.from);
      }
    }
    if (readsInitializer) readers.push(file);
    else if (specifiers) submoduleImporters.push({ file, specifiers });
  }
  const resolvesToInitializer = await mapLimit(submoduleImporters, concurrency, async ({ file, specifiers }) => {
    for (const specifier of specifiers) {
      const target = await resolvePythonImportTarget(projectRoot, file, specifier);
      if (typeof target === "string" && initializers.has(fileIdentityKey(target))) return true;
    }
    return false;
  });
  submoduleImporters.forEach(({ file }, index) => {
    if (resolvesToInitializer[index]) readers.push(file);
  });
  return readers;
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

/** Start of the line holding `index`; Python ends lines with LF, CRLF, or a lone CR. */
function pythonLineStart(text: string, index: number): number {
  return Math.max(text.lastIndexOf("\n", index - 1), text.lastIndexOf("\r", index - 1)) + 1;
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
        await pushStarImport(context, moduleSpec, moduleLevel, typeOnly, statementStartIndex);
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
