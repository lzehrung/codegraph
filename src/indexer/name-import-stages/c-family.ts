/** C and C++ named/import stages. */
import type { NamedImportRules } from "../name-import-stage-types.js";
import { namedImportStage } from "../navigation-named-core.js";

/** C exports are split into tag and ordinary names, and a header declaration arrives through an include. */
const C_NAMED_IMPORT_RULES: NamedImportRules = { splitExportNamespaces: true, crossFileExportsAreImports: true };

/** Only a qualified C++ name (`ns::name`) reads the export lookup; an unqualified one resolves through imports. */
const CPP_NAMED_IMPORT_RULES: NamedImportRules = { exportLookupSeparator: "::" };

export const cNamedImportStage = namedImportStage(C_NAMED_IMPORT_RULES);
export const cppNamedImportStage = namedImportStage(CPP_NAMED_IMPORT_RULES);
