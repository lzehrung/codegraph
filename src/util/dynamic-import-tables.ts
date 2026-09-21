import { buildJsLikeLiteralMask, stripJsLikeComments } from "./comments.js";
import { PYTHON_IDENTIFIER_SOURCE } from "./identifiers.js";
import { buildTriviaMask } from "./trivia.js";

/**
 * Per-language dynamic-import adapters for the runner in `./specifiers.js`.
 *
 * The runner and the shared constant-path fold stay in `./specifiers.js`; this module owns
 * only the per-language call shapes and the path-fold profiles they name. The runner builds
 * the table once and injects its fold implementations (`DynamicImportFoldHelpers`), so the
 * two modules never import each other at runtime and no cycle forms.
 */

/** Root a folded constant path is resolved against: the file's directory, the file itself,
 * or the project root. */
export type DynamicBase = "fileDir" | "filePath" | "project";

/** A folded constant path: one rooted base plus its literal segments. */
export type FoldedPath = { base: DynamicBase; segments: string[] };

/** Resolves a folded path against the root its base names. */
export type FoldedPathResolver = (folded: FoldedPath, fromFile: string, projectRoot: string) => string | null;

/**
 * Per-language inputs to the shared constant-path fold: the base tokens that root a computed
 * path and the join-style helper calls that combine a base with literal segments. Tokens are
 * compared after whitespace removal, so `dirname(__FILE__)` and `process.cwd()` fold like
 * identifiers. Languages without a concatenation operator only fold join-helper arguments.
 */
export type PathFoldProfile = {
  bases: Readonly<Record<string, DynamicBase>>;
  joinHelpers: readonly string[];
  /** Top-level concatenation operator between constant parts (PHP `.`). */
  concat?: string;
};

const JS_PATH_FOLD_PROFILE: PathFoldProfile = {
  bases: {
    __dirname: "fileDir",
    __filename: "filePath",
    "import.meta.url": "filePath",
    "process.cwd()": "project",
  },
  joinHelpers: ["path.join", "path.resolve"],
};

const RUBY_PATH_FOLD_PROFILE: PathFoldProfile = {
  bases: { __dir__: "fileDir" },
  joinHelpers: ["File.join"],
};

const PHP_PATH_FOLD_PROFILE: PathFoldProfile = {
  bases: { __DIR__: "fileDir", "dirname(__FILE__)": "fileDir" },
  joinHelpers: [],
  concat: ".",
};

export type DynamicImportPreparation = {
  /** Python importlib alias tables collected once per file. */
  pythonImportlibAliases?: Set<string>;
  pythonImportModuleAliases?: Set<string>;
};

export type DynamicImportShapeContext = {
  /** The text the shape's pattern ran over (comment-blanked for the JS family). */
  text: string;
  match: RegExpMatchArray;
  fromFile: string;
  projectRoot: string;
  preparation: DynamicImportPreparation;
};

export type DynamicImportCallShape = {
  /** Pattern over the entry's matching text; capture 1 holds the foldable argument, or the
   * fold reads the argument from the match end (Python's escape-aware literal reader). */
  pattern: RegExp;
  fold: (context: DynamicImportShapeContext) => string | null;
};

export type DynamicImportEntry = {
  /** Matching text, blanking comments through the shared trivia lexer where needed; string
   * literals stay intact so folds can read their contents. */
  text: (source: string) => string;
  /** Non-code guard over the matching text; matches starting inside trivia are skipped. */
  guard: (text: string) => Uint8Array | undefined;
  /** Per-file preparation, evaluated once per extraction. */
  prepare?: (source: string) => DynamicImportPreparation;
  shapes: readonly DynamicImportCallShape[];
};

/**
 * The shared fold implementation `./specifiers.js` injects. Keeping these as parameters rather
 * than importing them is what keeps the entries here independent of the runner module.
 */
export type DynamicImportFoldHelpers = {
  /** Builds a shape fold that reads capture 1 as a constant path and resolves the fold. */
  foldCapturedPath: (
    profile: PathFoldProfile,
    resolve: FoldedPathResolver,
  ) => (context: DynamicImportShapeContext) => string | null;
  /** Folds a `new URL("...", import.meta.url)` argument list. */
  foldNewUrlArgument: (argText: string, profile: PathFoldProfile) => FoldedPath | null;
  resolveFoldedPathAgainstBase: FoldedPathResolver;
  /** Resolves against the containing file's directory regardless of the named base. */
  resolveFoldedPathAgainstFileDir: (folded: FoldedPath, fromFile: string) => string | null;
  /** Resolves by concatenation onto the containing file's directory. */
  resolveFoldedPathByConcatenation: (folded: FoldedPath, fromFile: string) => string | null;
  /** Folds a Python dynamic-import call into a static module string. */
  foldPythonDynamicModuleArgument: (
    source: string,
    match: RegExpMatchArray,
    preparation: DynamicImportPreparation,
  ) => string | null;
  /** Collects the importlib alias tables a Python file's dynamic-import calls may use. */
  collectPythonDynamicImportAliases: (source: string) => {
    importlibAliases: Set<string>;
    importModuleAliases: Set<string>;
  };
};

const JS_DYNAMIC_PATH_CALL_PATTERN =
  /(?<!["'`])\b(?:require|import)\s*\(\s*(path\.(?:join|resolve)\s*\((?:[^()]|\([^()]*\))*\))\s*\)/g;
const JS_DYNAMIC_URL_CALL_PATTERN = /(?<!["'`])\b(?:require|import)\s*\(\s*(new\s+URL\s*\([^)]*\))\s*\)/g;
const RUBY_REQUIRE_FILE_JOIN_PATTERN =
  /(?<![\p{XID_Continue}])require\s*\(?\s*(File\.join\s*\((?:[^()]|\([^()]*\))*\))/gu;
const PHP_COMPUTED_INCLUDE_PATTERN =
  /(?<![\p{XID_Continue}$])(?:include_once|include|require_once|require)\b\s*\(?\s*([^;\r\n]*?)\s*\)?\s*;/gu;
const PYTHON_DYNAMIC_CALL_PREFIX_PATTERN = new RegExp(
  String.raw`(?<![._\p{XID_Continue}])(${PYTHON_IDENTIFIER_SOURCE})(?:\s*\.\s*(${PYTHON_IDENTIFIER_SOURCE}))?\s*\(\s*(?:name\s*=\s*)?`,
  "gmu",
);

type DynamicImportLanguageId = "js" | "ts" | "python" | "ruby" | "php";

/**
 * Builds the dynamic-import adapter table keyed by registered language id. Callers supply the
 * shared fold implementation; the per-file preparation and matching rules stay here with the
 * language that needs them.
 */
export function createDynamicImportEntries(
  folds: DynamicImportFoldHelpers,
): Readonly<Partial<Record<string, DynamicImportEntry>>> {
  const JS_TS_DYNAMIC_IMPORT_ENTRY: DynamicImportEntry = {
    // Comments are blanked before matching so a `require(...)` inside a comment cannot match;
    // string literals stay intact because the fold reads their contents.
    text: stripJsLikeComments,
    guard: buildJsLikeLiteralMask,
    shapes: [
      {
        pattern: JS_DYNAMIC_PATH_CALL_PATTERN,
        fold: folds.foldCapturedPath(JS_PATH_FOLD_PROFILE, folds.resolveFoldedPathAgainstBase),
      },
      {
        pattern: JS_DYNAMIC_URL_CALL_PATTERN,
        fold: ({ match, fromFile }) => {
          const folded = folds.foldNewUrlArgument(match[1] ?? "", JS_PATH_FOLD_PROFILE);
          return folded ? folds.resolveFoldedPathAgainstFileDir(folded, fromFile) : null;
        },
      },
    ],
  };

  const RUBY_DYNAMIC_IMPORT_ENTRY: DynamicImportEntry = {
    text: (source) => source,
    guard: (text) => buildTriviaMask(text, "ruby"),
    shapes: [
      {
        // Only the computed `require File.join(__dir__, ...)` form is folded here; bare-string
        // requires flow through the static pipeline and `$LOAD_PATH` lookups stay external.
        pattern: RUBY_REQUIRE_FILE_JOIN_PATTERN,
        fold: folds.foldCapturedPath(RUBY_PATH_FOLD_PROFILE, folds.resolveFoldedPathByConcatenation),
      },
    ],
  };

  const PHP_DYNAMIC_IMPORT_ENTRY: DynamicImportEntry = {
    text: (source) => source,
    guard: (text) => buildTriviaMask(text, "php"),
    shapes: [
      {
        // Computed `include`/`require` whose path is a constant chain rooted at `__DIR__` (or
        // the legacy `dirname(__FILE__)`); plain string operands stay with the static pipeline
        // and the include-path search stays external.
        pattern: PHP_COMPUTED_INCLUDE_PATTERN,
        fold: folds.foldCapturedPath(PHP_PATH_FOLD_PROFILE, folds.resolveFoldedPathByConcatenation),
      },
    ],
  };

  const PYTHON_DYNAMIC_IMPORT_ENTRY: DynamicImportEntry = {
    text: (source) => source,
    guard: (text) => buildTriviaMask(text, "python"),
    prepare: (source) => {
      const { importlibAliases, importModuleAliases } = folds.collectPythonDynamicImportAliases(source);
      return { pythonImportlibAliases: importlibAliases, pythonImportModuleAliases: importModuleAliases };
    },
    shapes: [
      {
        pattern: PYTHON_DYNAMIC_CALL_PREFIX_PATTERN,
        fold: ({ text, match, preparation }) => folds.foldPythonDynamicModuleArgument(text, match, preparation),
      },
    ],
  };

  const entries = {
    js: JS_TS_DYNAMIC_IMPORT_ENTRY,
    ts: JS_TS_DYNAMIC_IMPORT_ENTRY,
    python: PYTHON_DYNAMIC_IMPORT_ENTRY,
    ruby: RUBY_DYNAMIC_IMPORT_ENTRY,
    php: PHP_DYNAMIC_IMPORT_ENTRY,
  } satisfies Record<DynamicImportLanguageId, DynamicImportEntry>;
  return entries;
}
