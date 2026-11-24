import type { LanguageSupport } from "../languages.js";
import type { ImportBinding, ModuleIndex } from "./types.js";

export type PublicSurfaceKind = "api" | "content";

/** Declaration-import names changed in one language group of an incremental build. */
export type DeclarationNameChanges = {
  /** Names declared now and not before. */
  added: Set<string>;
  /** Names declared before and not now. */
  removed: Set<string>;
  /** JVM packages whose declaration completeness changed. */
  uncertainPackages: Set<string>;
  /** A JVM file with an unknown package changed completeness. */
  uncertainAnyPackage: boolean;
  /** A deleted file had no cached declarations. */
  unknownRemoval: boolean;
};

export function emptyDeclarationNameChanges(): DeclarationNameChanges {
  return {
    added: new Set<string>(),
    removed: new Set<string>(),
    uncertainPackages: new Set<string>(),
    uncertainAnyPackage: false,
    unknownRemoval: false,
  };
}

export type DeclarationImportRecheck = "none" | "resolve" | "reextract";

/** Language-specific public-surface and incremental import decisions. */
export type PublicSurfaceHooks = Readonly<{
  kind?: (file: string) => PublicSurfaceKind | undefined;
  nameSeparator?: string;
  normalizeImportName?: (name: string, support: LanguageSupport) => string;
  declarationNames?: (module: ModuleIndex, support: LanguageSupport) => Set<string> | undefined;
  declarationNameChanges?: (
    previous: ModuleIndex | undefined,
    current: ModuleIndex,
  ) => DeclarationNameChanges | null | undefined;
  recheck?: (
    binding: ImportBinding,
    support: LanguageSupport,
    changes: DeclarationNameChanges,
  ) => DeclarationImportRecheck | undefined;
  acceptSpecifier?: (specifier: string) => boolean;
  remainingSpecifierMatches?: (specifier: string, names: ReadonlySet<string>) => boolean;
  resolvedBindingNamesAdded?: (specifier: string, names: ReadonlySet<string>) => boolean;
  declarationCertaintyChanged?: (changes: DeclarationNameChanges) => boolean;
}>;
