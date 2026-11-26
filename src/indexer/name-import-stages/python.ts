/** Python named/import stage. */
import type { NamedImportRules } from "../name-import-stage-types.js";
import { namedImportStage } from "../navigation-named-core.js";
import { pythonNamespaceExportFile } from "../python-dotted-imports.js";
import { scopeNodesFor } from "../scope-nodes.js";

/**
 * Module bindings follow source order and a function body reads the ones in force when it runs. A module that runs an
 * unaliased `import a.b` exports `a` as the namespace of the leaf, but the name is the package.
 */
const PYTHON_NAMED_IMPORT_RULES: NamedImportRules = {
  scopeRow: scopeNodesFor("python"),
  namespaceExportFile: pythonNamespaceExportFile,
};

export const pythonNamedImportStage = namedImportStage(PYTHON_NAMED_IMPORT_RULES);
