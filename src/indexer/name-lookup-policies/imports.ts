import type { ImportNameRules } from "../import-name-types.js";
import { resolvePythonSubmoduleExact } from "../../util/resolution/python.js";
import { CSHARP_IMPORT_NAME_RULES } from "./csharp-imports.js";
import { JAVA_IMPORT_NAME_RULES, KOTLIN_IMPORT_NAME_RULES } from "./jvm-imports.js";
import { RUBY_IMPORT_NAME_RULES } from "./ruby-imports.js";

const NO_RULES: ImportNameRules = {};
const STYLESHEET_RULES: ImportNameRules = { starExpansion: { localFallback: "exports-only" } };
const RULES: Readonly<Record<string, ImportNameRules>> = {
  c: { includedAmbiguity: "continue" },
  csharp: CSHARP_IMPORT_NAME_RULES,
  css: STYLESHEET_RULES,
  less: STYLESHEET_RULES,
  scss: STYLESHEET_RULES,
  java: JAVA_IMPORT_NAME_RULES,
  kotlin: KOTLIN_IMPORT_NAME_RULES,
  ruby: RUBY_IMPORT_NAME_RULES,
  python: {
    exportStars: "last-wins",
    submoduleMechanism: "python",
    resolveSubmodule: resolvePythonSubmoduleExact,
  },
};

export function importNamePolicyFor(languageId: string | undefined): ImportNameRules {
  return languageId ? (RULES[languageId] ?? NO_RULES) : NO_RULES;
}
