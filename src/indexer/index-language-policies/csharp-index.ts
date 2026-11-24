import { normalizeCsharpQualifiedName } from "../../util/identifiers.js";
import { collectCsharpNamespaceFacts, csharpGenericArity } from "../../util/csharp-tree.js";
import type { ProjectFactsPolicy } from "../../util/project-file-facts-types.js";
import type { DeclarationHooks } from "../language-hook-types.js";
import type { PublicSurfaceHooks } from "../public-surface-types.js";

export const csharpProjectFacts: ProjectFactsPolicy = {
  slot: "csharp",
  degradationFact: "csharpNamespaceFacts",
  collect: (_source, tree) => ({ csharpNamespaceFacts: tree ? collectCsharpNamespaceFacts(tree) : null }),
  prime: (file, facts, extensions, primeNamespaces) =>
    primeNamespaces(file, facts?.csharpNamespaceFacts ?? null, extensions),
  namespaceFacts: (tree, facts) => facts?.csharpNamespaceFacts ?? collectCsharpNamespaceFacts(tree),
};

export const csharpDeclarations: DeclarationHooks = { nominalArity: csharpGenericArity };

export const csharpPublicSurface: PublicSurfaceHooks = {
  normalizeImportName(name) {
    const normalized = normalizeCsharpQualifiedName(name);
    return normalized.startsWith("global::") ? normalized.slice("global::".length) : normalized;
  },
};
