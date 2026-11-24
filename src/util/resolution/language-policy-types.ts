import type { CollectModuleSpecifiersOptions } from "../../graphs/specifiers.js";
import type { ImportResolver } from "../../indexer/imports/context.js";
import type { ImportBinding } from "../../indexer/import-types.js";
import type { LanguageSupport } from "../../languages.js";
import type { SyntaxTreeLike } from "../../languages/types.js";
import type { NativeQueryResults } from "../../native/contracts.js";
import type { FileId } from "../../types.js";
import type { resolveImportSpecifier } from "../resolution.js";
import type { ModuleSpecifier } from "../specifiers.js";
import type { SpecifierTargetMetadata, SpecifierTargets } from "./specifier-targets.js";

/** Inputs already owned by a file's import-binding extraction. */
export type ImportCollectionContext = {
  file: string;
  projectRoot: string;
  source: string;
  support: LanguageSupport;
  resolve: ImportResolver;
  tree?: SyntaxTreeLike | null;
  nativeQueries?: NativeQueryResults | null;
};

/** Per-file additions to graph specifiers and indexed import bindings. */
export type SpecifierCollectionHooks = Readonly<{
  appendSpecifiers?: (
    support: LanguageSupport,
    source: string,
    options: CollectModuleSpecifiersOptions | undefined,
    output: ModuleSpecifier[],
  ) => void | Promise<void>;
  appendBindings?: (context: ImportCollectionContext, output: ImportBinding[]) => void | Promise<void>;
}>;

/** Specifier extraction policy; absent collection keeps generic native-query extraction. */
export type SpecifierExtractionPolicy = Readonly<{
  collect?: SpecifierCollectionHooks;
}>;

/** The existing optional argument of resolveImportSpecifier, without its optional wrapper. */
export type ImportSpecifierOptions = NonNullable<Parameters<typeof resolveImportSpecifier>[4]>;

/** Language-specific import targets; undefined continues the existing generic resolver. */
export type SpecifierTargetPolicy = Readonly<{
  resolve?: (
    file: string,
    specifier: string,
    metadata: SpecifierTargetMetadata,
  ) => Promise<SpecifierTargets | undefined>;
  resolveImport?: (
    projectRoot: string,
    fromFile: string,
    specifier: string,
    options: ImportSpecifierOptions,
  ) => Promise<FileId | { external: string } | undefined>;
}>;
