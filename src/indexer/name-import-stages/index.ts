/**
 * Leaf selection of the named/import stages. It imports no navigation consumer and no name or member policy registry,
 * so those registries and the helpers they hold can select a stage without a dependency cycle.
 */
import type { NamedImportStage } from "../name-import-stage-types.js";
import { genericNamedImportStage } from "../navigation-named-core.js";
import { cNamedImportStage, cppNamedImportStage } from "./c-family.js";
import { csharpNamedImportStage } from "./csharp.js";
import { kotlinNamedImportStage } from "./kotlin.js";
import { pythonNamedImportStage } from "./python.js";

const STAGES: Readonly<Record<string, NamedImportStage>> = {
  c: cNamedImportStage,
  cpp: cppNamedImportStage,
  csharp: csharpNamedImportStage,
  kotlin: kotlinNamedImportStage,
  python: pythonNamedImportStage,
};

/** The named/import stage of a use language; select it once per query, module or loaded target file. */
export function namedImportStageFor(languageId: string): NamedImportStage {
  return STAGES[languageId] ?? genericNamedImportStage;
}
