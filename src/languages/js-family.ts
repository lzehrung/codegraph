import "./all.js";
import { getLanguageById } from "./registry.js";

/**
 * Languages that share the ECMAScript grammar family: `import type` classification, receiver
 * `this`/`super` handling, and call-compatibility parameter rules all branch on this predicate.
 *
 * The registry has no family field, so the family is declared here and then filtered through the
 * registry. A language id that was never registered (`javascript`, `typescript`, `jsx`) cannot
 * make the predicate true, and the declaration itself is asserted registered by
 * `tests/language-capability-registry.test.ts`.
 */
const JS_FAMILY_LANGUAGE_ID_DECLARATIONS = ["js", "ts", "tsx"] as const;

export const jsFamilyLanguageIdDeclarations: readonly string[] = JS_FAMILY_LANGUAGE_ID_DECLARATIONS;

const jsFamilyLanguageIds: ReadonlySet<string> = new Set(
  JS_FAMILY_LANGUAGE_ID_DECLARATIONS.filter((languageId) => getLanguageById(languageId) !== undefined),
);

export function isJsTsLanguage(languageId: string): boolean {
  return jsFamilyLanguageIds.has(languageId);
}
