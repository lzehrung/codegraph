/** C# named/import stage. */
import { csharpImportsForName } from "../csharp-global-usings.js";
import type { NamedImportRules } from "../name-import-stage-types.js";
import { namedImportStage } from "../navigation-named-core.js";
import { csharpShadowedStarsMayHold } from "../navigation-resolve.js";
import { scopeNodesFor } from "../scope-nodes.js";

/**
 * Global usings narrow the imports a name and its generic arity can reach, using directives and namespace regions
 * apply from their position, and a shadowed `using N;` may still hold a name other stars supply.
 */
const CSHARP_NAMED_IMPORT_RULES: NamedImportRules = {
  scopeRow: scopeNodesFor("csharp"),
  importsForName: csharpImportsForName,
  positionedExportLookup: true,
  starsMayHoldName: csharpShadowedStarsMayHold,
};

export const csharpNamedImportStage = namedImportStage(CSHARP_NAMED_IMPORT_RULES);
