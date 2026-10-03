/**
 * Per-language import-resolution capabilities for declaration-resolved imports, implicit
 * compilation units, and external-specifier re-resolution. Rows are keyed by language id,
 * following the trivia-table precedent in `../util/trivia-tables.ts`: resolvers keep the
 * algorithms; this table keeps the per-language facts.
 *
 * Every registered language has a row. A document, style, or data format row carries only
 * `omittedReason`; a source-language row declares each capability it has and names a one-line
 * reason for each capability it omits, so an omission cannot flip silently.
 * `implicitCompilationUnitGroup` is not its own capability: absent means the language id.
 * `tests/import-resolution-tables.test.ts` asserts both halves.
 *
 * `DECLARATION_RESOLVED_IMPORT_LANGUAGES`, `IMPLICIT_UNIT_LANGUAGES`, and the external-specifier
 * rule are derived from these rows.
 */

/**
 * How an added file can satisfy an external import specifier.
 * Separator names stay data; the incremental plan compiles them into patterns.
 */
export type ExternalSpecifierSeparator = "path" | "slash" | "dot" | "python" | "rust";

export type ExternalSpecifierResolutionData = {
  separator: ExternalSpecifierSeparator;
  /** Directory names an import can name: the parent only, or every ancestor. */
  importNamesDirectory?: "parent" | "ancestors";
  /**
   * Declaration imports name packages, not files.
   * Any added file with one of these extensions re-resolves this language's importers.
   */
  reResolveAnyAddedExtensions?: readonly string[];
  /** An added file stem may match any module segment, not only the last. */
  matchesModuleSegments?: boolean;
};

/**
 * Files of this language can name each other's top-level declarations without an import.
 * `package` reads a package clause. `namespace` reads namespace declarations.
 * `module` is the file's directory.
 */
export type ImplicitCompilationUnitKind = "package" | "namespace" | "module";

export type ImportResolutionRow = {
  /** Why the language has none of these resolution capabilities. */
  omittedReason?: string;
  /**
   * Imports name declarations in other files, so a content change can move the target.
   */
  resolvesImportsFromDeclarations?: true;
  /** Why imports do not resolve through declarations in other files. */
  resolvesImportsFromDeclarationsOmittedReason?: string;
  /** Implicit compilation unit for this language, when it has one. */
  implicitCompilationUnit?: ImplicitCompilationUnitKind;
  /** Why files cannot name each other's top-level declarations without an import. */
  implicitCompilationUnitOmittedReason?: string;
  /**
   * Languages that share one unit identity. Java and Kotlin use `jvm`.
   * Absent means the language id.
   */
  implicitCompilationUnitGroup?: string;
  /**
   * How an added file can satisfy an external specifier.
   * Absent means a path separator and no declaration-wide re-resolution.
   */
  externalSpecifierResolution?: ExternalSpecifierResolutionData;
  /** Why the language keeps the default path separator and does not re-resolve every added file. */
  externalSpecifierResolutionOmittedReason?: string;
};

const ECMASCRIPT_DECLARATION_OMITTED = "An import names a module specifier, not a declaration in another file.";
const ECMASCRIPT_UNIT_OMITTED = "A cross-file name arrives through an import; files are not bare-name peers.";
const ECMASCRIPT_SPECIFIER_OMITTED =
  "Specifiers use the default path separator and match the resolved file stem, not every added file.";
const STYLESHEET_OMITTED =
  "Style language; no declaration imports, implicit compilation unit, or external-specifier rule.";

const ECMASCRIPT_ROW: ImportResolutionRow = {
  resolvesImportsFromDeclarationsOmittedReason: ECMASCRIPT_DECLARATION_OMITTED,
  implicitCompilationUnitOmittedReason: ECMASCRIPT_UNIT_OMITTED,
  externalSpecifierResolutionOmittedReason: ECMASCRIPT_SPECIFIER_OMITTED,
};

const JVM_DECLARATION_EXTENSIONS = [".java", ".kt", ".kts", ".ktm"];

export const IMPORT_RESOLUTION_ROWS: Record<string, ImportResolutionRow> = {
  adoc: { omittedReason: "AsciiDoc document format; embedded code blocks parse as their own language." },
  astro: { omittedReason: "Astro document format; scripts parse as js/ts and templates as html." },
  c: {
    resolvesImportsFromDeclarationsOmittedReason: "A #include names a header file, not a declaration in another file.",
    implicitCompilationUnitOmittedReason:
      "Each translation unit is one file; a cross-file name arrives through an include.",
    externalSpecifierResolutionOmittedReason:
      "Include paths use the default path separator and match the header file stem.",
  },
  cpp: {
    resolvesImportsFromDeclarations: true,
    implicitCompilationUnitOmittedReason:
      "Each translation unit is one file; a cross-file name arrives through an include or module import.",
    externalSpecifierResolutionOmittedReason:
      "Includes use the default path separator; named modules re-resolve from declaration history, not an extension rule.",
  },
  css: { omittedReason: STYLESHEET_OMITTED },
  csharp: {
    resolvesImportsFromDeclarations: true,
    implicitCompilationUnit: "namespace",
    externalSpecifierResolution: {
      separator: "path",
      reResolveAnyAddedExtensions: [".cs", ".csx"],
    },
  },
  go: {
    resolvesImportsFromDeclarationsOmittedReason:
      "An import path names a package directory, not a declaration scanned from another file.",
    implicitCompilationUnit: "package",
    externalSpecifierResolution: {
      separator: "slash",
      importNamesDirectory: "parent",
    },
  },
  hbs: { omittedReason: "Handlebars document format; embedded scripts parse as their own language." },
  html: { omittedReason: "Document format; embedded scripts parse as their own language." },
  java: {
    resolvesImportsFromDeclarations: true,
    implicitCompilationUnit: "package",
    implicitCompilationUnitGroup: "jvm",
    externalSpecifierResolution: {
      separator: "dot",
      reResolveAnyAddedExtensions: JVM_DECLARATION_EXTENSIONS,
    },
  },
  js: ECMASCRIPT_ROW,
  kotlin: {
    resolvesImportsFromDeclarations: true,
    implicitCompilationUnit: "package",
    implicitCompilationUnitGroup: "jvm",
    externalSpecifierResolution: {
      separator: "dot",
      reResolveAnyAddedExtensions: JVM_DECLARATION_EXTENSIONS,
    },
  },
  less: { omittedReason: STYLESHEET_OMITTED },
  markdown: { omittedReason: "Document format; fenced code blocks parse as their own language." },
  mdx: { omittedReason: "MDX document format; scripts parse as js/ts and templates as html." },
  php: {
    resolvesImportsFromDeclarations: true,
    implicitCompilationUnitOmittedReason:
      "A cross-file name arrives through a use or include, not a shared package, namespace, or module unit.",
    externalSpecifierResolution: {
      separator: "path",
      reResolveAnyAddedExtensions: [".php", ".phtml", ".php4", ".php8"],
    },
  },
  python: {
    resolvesImportsFromDeclarationsOmittedReason:
      "An import names a module path, not a declaration that can move to another file.",
    implicitCompilationUnitOmittedReason:
      "A cross-file name arrives through an import; the same directory is not a bare-name unit.",
    externalSpecifierResolution: {
      separator: "python",
      importNamesDirectory: "ancestors",
    },
  },
  rst: { omittedReason: "reStructuredText document format; embedded code blocks parse as their own language." },
  ruby: {
    resolvesImportsFromDeclarationsOmittedReason: "require and load name a file, not a declaration in another file.",
    implicitCompilationUnitOmittedReason: "A cross-file name arrives through require, load, or autoload.",
    externalSpecifierResolutionOmittedReason:
      "Require paths use the default path separator and match the loaded file stem.",
  },
  rust: {
    resolvesImportsFromDeclarationsOmittedReason:
      "A use path names a module file, not a declaration discovered by scanning other files.",
    implicitCompilationUnitOmittedReason: "A cross-file name arrives through a use or mod item.",
    externalSpecifierResolution: {
      separator: "rust",
      matchesModuleSegments: true,
    },
  },
  scss: { omittedReason: STYLESHEET_OMITTED },
  sql: {
    omittedReason: "Data language; no declaration imports, implicit compilation unit, or external-specifier rule.",
  },
  svelte: { omittedReason: "Svelte component format; script blocks parse as js/ts and templates as html." },
  swift: {
    resolvesImportsFromDeclarationsOmittedReason:
      "An import names a module; same-module declarations are visible without resolving that import to a file.",
    implicitCompilationUnit: "module",
    externalSpecifierResolutionOmittedReason:
      "Module imports are not file stems, so an added file does not re-resolve importers through an extension rule.",
  },
  ts: ECMASCRIPT_ROW,
  tsx: ECMASCRIPT_ROW,
  vue: { omittedReason: "Vue component format; script blocks parse as js/ts and templates as html." },
  zig: {
    resolvesImportsFromDeclarationsOmittedReason: "@import names a file path, not a declaration in another file.",
    implicitCompilationUnitOmittedReason: "A cross-file name arrives through @import.",
    externalSpecifierResolutionOmittedReason:
      "@import paths use the default path separator and match the imported file stem.",
  },
};

/**
 * Languages that resolve imports through declarations in other files
 * (C# namespaces, JVM packages, PHP namespaces, C++ named modules).
 * A content change in a dependency can move the target.
 */
export const DECLARATION_RESOLVED_IMPORT_LANGUAGES: ReadonlySet<string> = new Set(
  Object.entries(IMPORT_RESOLUTION_ROWS)
    .filter(([, row]) => row.resolvesImportsFromDeclarations)
    .map(([languageId]) => languageId),
);
