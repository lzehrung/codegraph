/** Kotlin named/import stage. */
import type { NamedImportRules } from "../name-import-stage-types.js";
import { namedImportStage } from "../navigation-named-core.js";
import { scopeNodesFor } from "../scope-nodes.js";

/** `::Name` names a callable, and a type position reads only type declarations. */
const KOTLIN_NAMED_IMPORT_RULES: NamedImportRules = {
  scopeRow: scopeNodesFor("kotlin"),
  callableReferenceType: "callable_reference",
  typeOnlyUses: true,
};

export const kotlinNamedImportStage = namedImportStage(KOTLIN_NAMED_IMPORT_RULES);
