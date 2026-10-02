import { LANGUAGE_SUPPORTS } from "../languages.js";

/**
 * Languages that resolve imports through declarations in other files
 * (C# namespaces, JVM packages, PHP namespaces, C++ named modules).
 * A content change in a dependency can move the target.
 */
export const DECLARATION_RESOLVED_IMPORT_LANGUAGES: ReadonlySet<string> = new Set(
  LANGUAGE_SUPPORTS.filter((support) => support.resolvesImportsFromDeclarations).map((support) => support.id),
);
