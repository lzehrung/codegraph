import path from "node:path";
import { replaceContents } from "../../util/collections.js";
import { resolvedImportFile } from "../imports/context.js";
import type { DeclarationHooks } from "../language-hook-types.js";
import type { PublicSurfaceHooks } from "../public-surface-types.js";
import type { ExportEntry, ImportBinding } from "../types.js";

const PACKAGE_INIT = /^__init__\.pyi?$/iu;

function completePythonExports(
  imports: readonly ImportBinding[],
  exports: ExportEntry[],
  explicitNames: ReadonlySet<string>,
  hasExplicitList: boolean,
): void {
  for (const binding of imports) {
    if (binding.mechanism !== "python" || !binding.moduleLevel) continue;
    const fromModule = resolvedImportFile(binding);
    if (fromModule === undefined) continue;
    if (binding.kind === "named") {
      if (binding.local.startsWith("_")) continue;
      exports.push({
        type: "reexport",
        exportedAs: binding.local,
        fromModule,
        moduleSpecifier: binding.from,
        sourceSpecifier: binding.imported,
      });
    } else if (binding.kind === "namespace" && !binding.localNS.startsWith("_")) {
      exports.push({
        type: "namespaceReexport",
        exportedAs: binding.localNS,
        fromModule,
        moduleSpecifier: binding.from,
      });
    } else if (binding.kind === "star") {
      // Every statement matters: importing the same module again restores its later binding.
      exports.push({
        type: "exportStar",
        fromModule,
        moduleSpecifier: binding.from,
        sourceSpecifier: binding.from,
      });
    }
  }
  if (!hasExplicitList) return;
  const seen = new Set<string>();
  const filtered = exports.filter((entry) => {
    if (entry.type === "local") {
      if (!explicitNames.has(entry.exportedAs)) return false;
      if (seen.has(entry.exportedAs)) return false;
      seen.add(entry.exportedAs);
      return true;
    }
    if (entry.type === "reexport") return explicitNames.has(entry.exportedAs);
    return true;
  });
  replaceContents(exports, filtered);
}

export const pythonDeclarations: DeclarationHooks = {
  complexityKeywords: [/\belif\b/g, /\bexcept\b/g],
  explicitExportList: {
    targetCapture: "left",
    methodCapture: "method",
    itemCapture: "all_item",
    declarationCapture: "name",
    targetName: "__all__",
    additiveMethods: new Set(["extend", "append"]),
    privatePrefix: "_",
  },
  completeExports: completePythonExports,
};

export const pythonPublicSurface: PublicSurfaceHooks = {
  kind: (file) => (PACKAGE_INIT.test(path.basename(file)) ? "content" : undefined),
};
