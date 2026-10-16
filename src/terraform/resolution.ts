import path from "node:path";
import { getCompilationUnitPeers } from "../indexer/compilation-units.js";
import { ensureParsedContext } from "../indexer/parse-context.js";
import type { ModuleIndex, ProjectIndex, SymbolDef } from "../indexer/types.js";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import { isNativeRequiredUnavailableError } from "../native/runtime.js";
import type { FileId } from "../types.js";
import { fileIdentityKey } from "../util/paths.js";
import { terraformLocalModuleDirectory } from "../util/resolution/terraform.js";
import {
  extractTerraformFacts,
  type TerraformDeclaration,
  type TerraformDeclarationKind,
  type TerraformFileFacts,
  type TerraformModuleObjectUse,
  type TerraformReferenceTarget,
} from "./syntax.js";

/**
 * The one place that decides what a Terraform reference names. `goToDefinition`,
 * `findReferences`, and rename preview all resolve sites here.
 *
 * - `var`, `local`, `module`, resource, and data source references resolve within the module
 *   directory of the referring file.
 * - `module.<name>.<output>` and module call arguments resolve in the directory named by the
 *   call's literal local `source`. Registry, Git, and other remote sources are not followed.
 * - A name declared more than once in one module is ambiguous and resolves to nothing.
 */

export const TERRAFORM_LANGUAGE_ID = "terraform";

/**
 * A failed resolution. `ambiguous` lists the declarations that tie when a name is declared more
 * than once in one module, so references can report partial coverage instead of a clean miss.
 */
export type TerraformNotFound = { status: "not_found"; reason: string; ambiguous?: SymbolDef[] };

export type TerraformResolution = { status: "ok"; def: SymbolDef } | TerraformNotFound;

type DeclarationQuery = { kind: TerraformDeclarationKind; type?: string; name: string };

type DeclarationMatch =
  | { status: "ok"; file: FileId; declaration: TerraformDeclaration; def: SymbolDef }
  | TerraformNotFound;

export function isTerraformFile(index: ProjectIndex, file: FileId): boolean {
  return supportForFileWithoutHeaderSample(file, index.languageExtensions)?.id === TERRAFORM_LANGUAGE_ID;
}

const factsByModule = new WeakMap<ModuleIndex, Promise<TerraformFileFacts | null>>();

async function computeFacts(index: ProjectIndex, module: ModuleIndex): Promise<TerraformFileFacts | null> {
  try {
    const parsed = await ensureParsedContext(
      module.file,
      index.parsed?.get(fileIdentityKey(module.file)),
      index.languageExtensions,
    );
    if (parsed.sup.id !== TERRAFORM_LANGUAGE_ID) return null;
    return extractTerraformFacts(parsed.tree.rootNode);
  } catch (error) {
    if (isNativeRequiredUnavailableError(error)) throw error;
    return null;
  }
}

/**
 * Declarations and reference sites of one indexed Terraform file, or null when the file is not
 * indexed or could not be parsed. Cached per indexed module, so a re-indexed file is re-read.
 */
export function terraformFactsForFile(index: ProjectIndex, file: FileId): Promise<TerraformFileFacts | null> {
  const module = index.byFile.get(fileIdentityKey(file));
  if (!module) return Promise.resolve(null);
  let facts = factsByModule.get(module);
  if (!facts) {
    facts = computeFacts(index, module);
    factsByModule.set(module, facts);
  }
  return facts;
}

/** Indexed Terraform files of the module (directory) that contains `file`, including `file`. */
export function terraformModuleFiles(index: ProjectIndex, file: FileId): FileId[] {
  return [...getCompilationUnitPeers(index, file).files]
    .filter((peer) => isTerraformFile(index, peer))
    .sort((left, right) => left.localeCompare(right));
}

type DirectoryLookup = { source: ProjectIndex["byFile"]; size: number; files: Map<string, FileId> };

const directoryLookups = new WeakMap<ProjectIndex, DirectoryLookup>();

/** One indexed Terraform file per module directory, for resolving a module call's directory. */
function indexedTerraformFileInDirectory(index: ProjectIndex, directory: string): FileId | undefined {
  let lookup = directoryLookups.get(index);
  if (!lookup || lookup.source !== index.byFile || lookup.size !== index.byFile.size) {
    const files = new Map<string, FileId>();
    for (const module of index.byFile.values()) {
      if (!isTerraformFile(index, module.file)) continue;
      const key = fileIdentityKey(path.dirname(module.file));
      if (!files.has(key)) files.set(key, module.file);
    }
    lookup = { source: index.byFile, size: index.byFile.size, files };
    directoryLookups.set(index, lookup);
  }
  return lookup.files.get(fileIdentityKey(directory));
}

/** Every indexed Terraform file, in path order. */
export function indexedTerraformFiles(index: ProjectIndex): FileId[] {
  return [...index.byFile.values()]
    .map((module) => module.file)
    .filter((file) => isTerraformFile(index, file))
    .sort((left, right) => left.localeCompare(right));
}

function definitionForDeclaration(
  index: ProjectIndex,
  file: FileId,
  declaration: TerraformDeclaration,
): SymbolDef | undefined {
  const module = index.byFile.get(fileIdentityKey(file));
  return module?.locals.find(
    (local) => local.localName === declaration.name && local.range.start.index === declaration.range.start.index,
  );
}

function describe(query: DeclarationQuery): string {
  return query.type ? `${query.kind} ${query.type}.${query.name}` : `${query.kind} ${query.name}`;
}

async function matchingDeclarations(
  index: ProjectIndex,
  files: readonly FileId[],
  query: DeclarationQuery,
): Promise<Array<{ file: FileId; declaration: TerraformDeclaration }>> {
  const matches: Array<{ file: FileId; declaration: TerraformDeclaration }> = [];
  for (const file of files) {
    const facts = await terraformFactsForFile(index, file);
    for (const declaration of facts?.declarations ?? []) {
      if (declaration.kind !== query.kind || declaration.name !== query.name) continue;
      if (query.type !== undefined && declaration.type !== query.type) continue;
      matches.push({ file, declaration });
    }
  }
  return matches;
}

function indexedDefinitions(
  index: ProjectIndex,
  matches: ReadonlyArray<{ file: FileId; declaration: TerraformDeclaration }>,
): SymbolDef[] {
  return matches.flatMap((match) => {
    const def = definitionForDeclaration(index, match.file, match.declaration);
    return def ? [def] : [];
  });
}

async function findDeclaration(
  index: ProjectIndex,
  files: readonly FileId[],
  query: DeclarationQuery,
): Promise<DeclarationMatch> {
  const matches = await matchingDeclarations(index, files, query);
  const [match, ...others] = matches;
  if (!match) return { status: "not_found", reason: `No Terraform ${describe(query)} declaration in the module` };
  if (others.length) {
    return {
      status: "not_found",
      reason: `Terraform ${describe(query)} is declared more than once in the module`,
      ambiguous: indexedDefinitions(index, matches),
    };
  }
  const def = definitionForDeclaration(index, match.file, match.declaration);
  if (!def) return { status: "not_found", reason: `Terraform ${describe(query)} declaration is not indexed` };
  return { status: "ok", file: match.file, declaration: match.declaration, def };
}

/** The directory a module call in `file`'s module sources, or a reason it has none. */
async function calledModuleDirectory(
  index: ProjectIndex,
  file: FileId,
  moduleName: string,
): Promise<{ status: "ok"; directory: string; forEach: boolean } | TerraformNotFound> {
  const call = await findDeclaration(index, terraformModuleFiles(index, file), { kind: "module", name: moduleName });
  if (call.status !== "ok") return call;
  const source = call.declaration.source;
  if (source === undefined) return { status: "not_found", reason: `Module ${moduleName} has no literal source` };
  const directory = terraformLocalModuleDirectory(call.file, source);
  if (!directory) return { status: "not_found", reason: `Module source ${source} is not a local path` };
  return { status: "ok", directory, forEach: call.declaration.forEach === true };
}

/** Indexed files of the module that a module call in `file` sources, or a reason it has none. */
async function calledModuleFiles(
  index: ProjectIndex,
  file: FileId,
  moduleName: string,
  instanceSelected: boolean,
): Promise<{ status: "ok"; files: FileId[] } | TerraformNotFound> {
  const called = await calledModuleDirectory(index, file, moduleName);
  if (called.status !== "ok") return called;
  // `module.m.key.out` on a `for_each` call selects instance `key`, so `key` is not an output.
  if (called.forEach && !instanceSelected) {
    return { status: "not_found", reason: `Module ${moduleName} uses for_each; select an instance before an output` };
  }
  const childFile = indexedTerraformFileInDirectory(index, called.directory);
  if (!childFile) return { status: "not_found", reason: `Module ${moduleName} source has no indexed Terraform files` };
  return { status: "ok", files: terraformModuleFiles(index, childFile) };
}

/** True when `use` in `file` may read an output of the module whose files include `def`. */
export async function terraformModuleUseTargetsDefinition(
  index: ProjectIndex,
  file: FileId,
  use: TerraformModuleObjectUse,
  def: SymbolDef,
): Promise<boolean> {
  const called = await calledModuleDirectory(index, file, use.module);
  if (called.status !== "ok" || (use.onlyForEach && !called.forEach)) return false;
  return fileIdentityKey(called.directory) === fileIdentityKey(path.dirname(def.file));
}

/** Resolves one reference target written in `file` to its indexed declaration. */
export async function resolveTerraformTarget(
  index: ProjectIndex,
  file: FileId,
  target: TerraformReferenceTarget,
): Promise<TerraformResolution> {
  let files: FileId[];
  let query: DeclarationQuery;
  if (target.kind === "output" || target.kind === "input") {
    const instanceSelected = target.kind === "input" || target.instanceSelected;
    const called = await calledModuleFiles(index, file, target.module, instanceSelected);
    if (called.status !== "ok") return called;
    files = called.files;
    query = { kind: target.kind === "output" ? "output" : "variable", name: target.name };
  } else {
    files = terraformModuleFiles(index, file);
    query = target;
  }
  const match = await findDeclaration(index, files, query);
  return match.status === "ok" ? { status: "ok", def: match.def } : match;
}

/** The Terraform declaration that an indexed definition names, if any. */
export async function terraformDeclarationForDefinition(
  index: ProjectIndex,
  def: SymbolDef,
): Promise<TerraformDeclaration | undefined> {
  const facts = await terraformFactsForFile(index, def.file);
  return facts?.declarations.find(
    (declaration) => declaration.name === def.localName && declaration.range.start.index === def.range.start.index,
  );
}

/**
 * Declarations in the same module that renaming `def` to `newName` would collide with. Terraform
 * keeps one namespace per declaration kind (and per type for resources and data sources), so only
 * a same-kind declaration with that name conflicts.
 */
export async function terraformRenameCollisions(
  index: ProjectIndex,
  def: SymbolDef,
  newName: string,
): Promise<SymbolDef[]> {
  if (!isTerraformFile(index, def.file)) return [];
  const declaration = await terraformDeclarationForDefinition(index, def);
  if (!declaration) return [];
  const query: DeclarationQuery = {
    kind: declaration.kind,
    ...(declaration.type === undefined ? {} : { type: declaration.type }),
    name: newName,
  };
  return indexedDefinitions(index, await matchingDeclarations(index, terraformModuleFiles(index, def.file), query));
}

/** Input variable names Terraform reserves because module calls use them as meta-arguments. */
const RESERVED_INPUT_NAMES = new Set([
  "source",
  "version",
  "providers",
  "count",
  "for_each",
  "lifecycle",
  "depends_on",
  "locals",
]);

/** True when renaming `def` to `newName` would give an input variable a reserved name. */
export async function isTerraformReservedRename(
  index: ProjectIndex,
  def: SymbolDef,
  newName: string,
): Promise<boolean> {
  if (!RESERVED_INPUT_NAMES.has(newName) || !isTerraformFile(index, def.file)) return false;
  return (await terraformDeclarationForDefinition(index, def))?.kind === "variable";
}

/**
 * Files outside the declaring module that can reference a declaration: every file of each module
 * that calls the declaring directory through a local source. Call arguments name input variables,
 * and `module.<name>.<output>` can appear in any file of the calling module.
 */
export async function terraformModuleCallerFiles(index: ProjectIndex, def: SymbolDef): Promise<FileId[]> {
  const directoryKey = fileIdentityKey(path.dirname(def.file));
  const callers = new Map<string, FileId>();
  for (const file of indexedTerraformFiles(index)) {
    const facts = await terraformFactsForFile(index, file);
    const callsDirectory = facts?.declarations.some((declaration) => {
      if (declaration.kind !== "module" || declaration.source === undefined) return false;
      const directory = terraformLocalModuleDirectory(file, declaration.source);
      return directory !== null && fileIdentityKey(directory) === directoryKey;
    });
    if (!callsDirectory) continue;
    for (const peer of terraformModuleFiles(index, file)) callers.set(fileIdentityKey(peer), peer);
  }
  return [...callers.values()];
}
