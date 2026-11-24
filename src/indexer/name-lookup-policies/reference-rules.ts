import { cReferenceHooks, cppReferenceHooks } from "./c-family-references.js";
import { csharpGraphImportHooks, csharpReferenceHooks } from "./csharp-references.js";
import { javaReferenceHooks, kotlinGraphImportHooks, kotlinReferenceHooks } from "./jvm-references.js";
import { phpReferenceHooks } from "./php-references.js";
import { pythonReferenceHooks } from "./python-references.js";
import { rubyReferenceHooks } from "./ruby-references.js";
import { rustReferenceHooks } from "./rust-references.js";
import { scssReferenceHooks } from "./scss-references.js";
import { swiftGraphImportHooks, swiftReferenceHooks } from "./swift-references.js";
import { typescriptReferenceHooks } from "./typescript-references.js";
import type { ImportNameHooks, ReferenceHooks } from "../name-resolution-types.js";

const NO_REFERENCE_RULES: ReferenceHooks = {};
const REFERENCE_RULES: Readonly<Record<string, ReferenceHooks>> = {
  c: cReferenceHooks,
  cpp: cppReferenceHooks,
  csharp: csharpReferenceHooks,
  java: javaReferenceHooks,
  kotlin: kotlinReferenceHooks,
  php: phpReferenceHooks,
  python: pythonReferenceHooks,
  ruby: rubyReferenceHooks,
  rust: rustReferenceHooks,
  scss: scssReferenceHooks,
  swift: swiftReferenceHooks,
  ts: typescriptReferenceHooks,
  tsx: typescriptReferenceHooks,
};

const NO_GRAPH_IMPORT_RULES: ImportNameHooks = {};
const GRAPH_IMPORT_RULES: Readonly<Record<string, ImportNameHooks>> = {
  csharp: csharpGraphImportHooks,
  kotlin: kotlinGraphImportHooks,
  swift: swiftGraphImportHooks,
};

/** Leaf selection for reference and graph consumers already used by bare-name policy dependencies. */
export function referenceRulesFor(languageId: string): ReferenceHooks {
  return REFERENCE_RULES[languageId] ?? NO_REFERENCE_RULES;
}

export function graphImportRulesFor(languageId: string): ImportNameHooks {
  return GRAPH_IMPORT_RULES[languageId] ?? NO_GRAPH_IMPORT_RULES;
}
