/**
 * PHP additions to the shared name lookup order. Classes, functions, and constants occupy
 * separate namespaces, so the syntactic role of the use selects which one a name can bind.
 */
import { findClosestBinding } from "../navigation-local.js";
import { findPhpImportAlias, inferPhpQualifiedReferenceImportType } from "../navigation-php.js";
import { okGoToResult } from "../navigation-provenance.js";
import {
  phpClassReferenceMatchesDefinition,
  phpReferenceRoleMatchesKind,
  resolveIndexedPhpClassReference,
  resolvePhpExplicitImport,
  resolvePhpSameScopeRoleDefinition,
} from "../php-namespace-symbols.js";
import { scopeNodesFor } from "../scope-nodes.js";
import type { SymbolDef } from "../types.js";
import type { BareNameUse, NameLookupPolicy } from "../name-resolution.js";

/** A class-reference form (`new X`, `X::y`, a type) cannot bind a same-named function. */
const isClassReference = (use: BareNameUse): boolean => inferPhpQualifiedReferenceImportType(use.node) === "class";

const classMatches = (use: BareNameUse, lookupName: string, def: SymbolDef): boolean =>
  phpClassReferenceMatchesDefinition(
    use.index,
    use.parsed.source,
    use.parsed.tree,
    use.node,
    lookupName,
    use.mod.imports,
    def,
  );

export const phpLookupPolicy: NameLookupPolicy = {
  beforeLexical(use, lookupName) {
    const { index, mod, file, node, name, scopeIndex, parsed } = use;
    const variableTypes = scopeNodesFor("php").assignmentIdentifierTypes;
    if (variableTypes?.has(node.type) || (node.parent && variableTypes?.has(node.parent.type))) {
      const variable = findClosestBinding(scopeIndex, file, lookupName, node, parsed.sup, parsed.source, parsed.tree);
      if (!variable) return { status: "not_found", reason: "No matching PHP variable definition" };
      return okGoToResult(index, variable, { resolution: "exact", confidence: "high" });
    }
    // A declaration names itself even when an unrelated namespace uses the same spelling.
    const declaration = mod.locals.find(
      (local) => local.range.start.index === node.startIndex && local.range.end.index === node.endIndex,
    );
    if (declaration) return okGoToResult(index, declaration, { resolution: "exact", confidence: "high" });
    const role = use.phpImportType ?? "const";
    const binding = findPhpImportAlias(mod.imports, name, role);
    const alias = binding ? resolvePhpExplicitImport(index, binding, role) : null;
    if (alias) {
      return okGoToResult(index, alias, {
        via: { importedFrom: alias.file, exportedName: alias.localName },
        resolution: "import",
        confidence: "high",
      });
    }
    if (!isClassReference(use)) return undefined;
    const phpClass = resolveIndexedPhpClassReference(index, parsed.source, parsed.tree, node, lookupName, mod.imports);
    if (!phpClass) return undefined;
    return okGoToResult(index, phpClass, {
      via: { exportedName: phpClass.localName },
      resolution: "php-qualified",
      confidence: "high",
    });
  },

  // Scope and export fallbacks may only name this exact class, or a symbol of the use's role.
  onLocal({ use, lookupName, closestBinding }, local) {
    const { index, mod, node, parsed } = use;
    if (isClassReference(use) && !classMatches(use, lookupName, local)) {
      return { status: "not_found", reason: "No matching PHP class" };
    }
    if (phpReferenceRoleMatchesKind(node, local.kind)) return undefined;
    const sameScope = closestBinding
      ? resolvePhpSameScopeRoleDefinition(index, mod, parsed.source, parsed.tree, node, lookupName, closestBinding)
      : null;
    if (sameScope) return okGoToResult(index, sameScope, { resolution: "exact", confidence: "high" });
    return { status: "not_found", reason: "No matching PHP symbol role" };
  },

  afterCrossModule({ use, lookupName }, resolved) {
    if (resolved?.status !== "ok") return undefined;
    if (isClassReference(use) && !classMatches(use, lookupName, resolved.definition)) {
      return { status: "not_found", reason: "No matching PHP class" };
    }
    if (!phpReferenceRoleMatchesKind(use.node, resolved.definition.kind)) {
      return { status: "not_found", reason: "No matching PHP symbol role" };
    }
    return undefined;
  },
};
