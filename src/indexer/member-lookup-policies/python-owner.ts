import { collectMemberAccessChain, isReceiverNameNode } from "../../util/member-access.js";
import { isPythonDottedImportBinding, pythonDottedImportPackageFile } from "../python-dotted-imports.js";
import type { OwnerHooks } from "./types.js";

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
