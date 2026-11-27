import type { SyntaxNodeLike } from "../../languages/types.js";
import { collectMemberAccessChain, isReceiverNameNode } from "../../util/member-access.js";
import { fileIdentityKey } from "../../util/paths.js";
import type { ParsedFileContext } from "../parse-context.js";
import { ensureParsedContextForIndex } from "../parsed-cache.js";
import { isPythonDottedImportBinding, pythonDottedImportPackageFile } from "../python-dotted-imports.js";
import { definitionIdentityKey } from "../reference-context.js";
import type { ProjectIndex, SymbolDef } from "../types.js";
import type { OwnerHooks, ReceiverClassRef, ReceiverResolutionCache } from "./types.js";

type ParsedFileLoader = (file: string) => Promise<ParsedFileContext | null>;

/** The class body of the Python class `def`, read from its file. A file of another language holds no Python class. */
async function readPythonClassRef(
  index: ProjectIndex,
  def: SymbolDef,
  loadParsedFile: ParsedFileLoader | undefined,
): Promise<ReceiverClassRef | null> {
  const module = index.byFile.get(fileIdentityKey(def.file));
  if (!module) return null;
  const context = loadParsedFile ? await loadParsedFile(def.file) : await ensureParsedContextForIndex(index, def.file);
  if (!context || context.sup.id !== "python") return null;
  const start = def.range.start;
  const position = {
    row: start.line - 1,
    column: start.column - 1,
  };
  let current: SyntaxNodeLike | null = context.tree.rootNode.descendantForPosition(position, position);
  while (current && current.type !== "class_definition") {
    current = current.parent;
  }
  if (!current) return null;
  return { def, container: current, context, module };
}

/** The class body of the Python class `def`, read once per receiver walk that owns `cache`. */
export async function pythonClassRefFromDef(
  index: ProjectIndex,
  def: SymbolDef,
  loadParsedFile?: ParsedFileLoader,
  cache?: ReceiverResolutionCache,
): Promise<ReceiverClassRef | null> {
  const key = definitionIdentityKey(def);
  const cached = cache?.classRefs.get(key);
  if (cached) return cached;
  const pending = readPythonClassRef(index, def, loadParsedFile);
  cache?.classRefs.set(key, pending);
  return pending;
}

export const pythonQualifiedOwner: NonNullable<OwnerHooks["qualified"]> = (
  index,
  mod,
  baseName,
  path,
  _normalize,
  sup,
  use,
  deps,
) => {
  if (!use) return null;
  const chain = collectMemberAccessChain({ sup, source: use.source, chainNode: use.node });
  if (!chain || !isReceiverNameNode(sup, chain.base.type)) return null;
  const scope = use.scopeIndex ?? deps.getScopeIndex(index, mod, use.source, sup, use.tree);
  const binding = deps.pythonImportAtUse(mod, chain.base, use.source, use.tree, sup, scope);
  if (!binding || binding.kind !== "namespace") return null;
  const names = [baseName, ...path];
  for (let count = names.length - 1; count >= 1; count -= 1) {
    const moduleFile = deps.pythonDottedPhraseAtUse(
      index,
      mod,
      chain.base,
      names.slice(0, count).join("."),
      use.source,
      use.tree,
      sup,
      scope,
    );
    if (moduleFile === undefined) continue;
    return moduleFile ? (deps.resolveExportPath(index, moduleFile, names.slice(count), sup) ?? null) : null;
  }
  const file = isPythonDottedImportBinding(binding) ? pythonDottedImportPackageFile(index, binding) : binding.resolved;
  return typeof file === "string" ? (deps.resolveExportPath(index, file, path, sup) ?? null) : null;
};
