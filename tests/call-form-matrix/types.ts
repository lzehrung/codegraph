/**
 * Shared types for the call-form coverage matrix
 * (docs/plans/2026-09-28-unified-name-resolution.md, Step 1).
 *
 * A cell is one language and one call form: a small project, a use site, the declaration it
 * must resolve to (or `not_found`), and a same-named decoy declaration it must not resolve to.
 * `tests/call-form-matrix/harness.ts` runs every cell through `goToDefinition`, `findReferences`,
 * and `buildSymbolGraphDetailed`, plus three metamorphic checks.
 */

/** Internal language ids, matching `getLanguageById` in `src/languages.ts`. */
export type Language =
  | "ts"
  | "tsx"
  | "js"
  | "python"
  | "php"
  | "go"
  | "java"
  | "c"
  | "cpp"
  | "csharp"
  | "kotlin"
  | "ruby"
  | "rust"
  | "swift"
  | "zig";

/** Display order, matching the language table in `docs/language-parity.md`. */
export const LANGUAGE_ORDER: readonly Language[] = [
  "ts",
  "tsx",
  "js",
  "python",
  "php",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "kotlin",
  "ruby",
  "rust",
  "swift",
  "zig",
];

export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  ts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  python: "Python",
  php: "PHP",
  go: "Go",
  java: "Java",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  kotlin: "Kotlin",
  ruby: "Ruby",
  rust: "Rust",
  swift: "Swift",
  zig: "Zig",
};

/** The ten call-form columns, in the order the plan lists them. */
export type CallForm =
  | "bare-call"
  | "qualified-call"
  | "self-member-call"
  | "typed-local-receiver"
  | "static-receiver"
  | "construction"
  | "imported-alias"
  | "overload-arity"
  | "inherited-member"
  | "super-call";

export const CALL_FORM_ORDER: readonly CallForm[] = [
  "bare-call",
  "qualified-call",
  "self-member-call",
  "typed-local-receiver",
  "static-receiver",
  "construction",
  "imported-alias",
  "overload-arity",
  "inherited-member",
  "super-call",
];

export const CALL_FORM_NAMES: Readonly<Record<CallForm, string>> = {
  "bare-call": "Bare call",
  "qualified-call": "Qualified/namespace call",
  "self-member-call": "This/self member call",
  "typed-local-receiver": "Typed-local receiver",
  "static-receiver": "Static/type receiver",
  construction: "Construction",
  "imported-alias": "Imported/aliased name",
  "overload-arity": "Overload by argument count",
  "inherited-member": "Inherited member",
  "super-call": "Super/base call",
};

/**
 * A call form a language has no idiomatic way to express, with the reason why. Keeps the
 * generated report's "Omitted" status tied to an explicit, data-driven reason instead of a
 * missing cell, so deleting a covered cell cannot regenerate a report that silently calls the
 * form omitted (`./omissions.ts` cross-checks this against the cell tables).
 */
export type CallFormOmission = {
  callForm: CallForm;
  reason: string;
};

/** A declaration address: a file, a 1-based line, and a token that appears on that line. */
export type TokenAddress = {
  file: string;
  line: number;
  token: string;
  /** Which occurrence of `token` on the line, 1-based. Defaults to the first. */
  occurrence?: number;
};

/** The shape of declaration the generated "elsewhere" decoy file should take (metamorphic check a). */
export type DecoyKind = "callable" | "type";

export type MovedVariant = {
  /** The whole project after moving the declaration. Usually `{ ...cell.files, ... }` with the declaring file moved. */
  files: Readonly<Record<string, string>>;
  /** Where the declaration lives after the move. */
  expected: TokenAddress;
  /** Where the decoy lives after the move, when the move shifts it. Defaults to the cell's decoy. */
  decoy?: TokenAddress;
};

export type MatrixEdge = {
  label: "calls" | "instantiates";
  fromFile: string;
  fromName: string;
};

export type GapClassification = "confident-wrong" | "common-code-miss" | "rare-form-miss";

export const GAP_CLASSIFICATION_LABELS: Readonly<Record<GapClassification, string>> = {
  "confident-wrong": "confident wrong answer",
  "common-code-miss": "common-code miss",
  "rare-form-miss": "rare-form miss",
};

export type KnownGap = {
  reason: string;
  classification: GapClassification;
  /** The minimal repro: current vs. expected behavior. */
  repro: string;
};

export type MatrixCell = {
  /** Unique id, e.g. "cpp/bare-call". Used as the fixture directory prefix and the report key. */
  id: string;
  language: Language;
  callForm: CallForm;
  /** Project-relative path -> source text. */
  files: Readonly<Record<string, string>>;
  use: TokenAddress;
  expected: TokenAddress | "not_found";
  /**
   * A same-named declaration, already part of `files`, that must not be the answer. Required:
   * inclusion and exclusion are tested together (AGENTS.md).
   */
  decoy: TokenAddress;
  decoyKind: DecoyKind;
  /** Set when the use site is a call, member call, or construction the detailed graph records. */
  edge?: MatrixEdge;
  /**
   * The decoy is a genuinely ambiguous candidate (ordinary code gives no proof it is excluded),
   * so `findReferences` coverage of it must stay partial rather than complete. Rare: most cells
   * resolve the decoy away by a proven fact (an import, a classified receiver, a visibility rule).
   */
  decoyAmbiguous?: boolean;
  /** A variant of the project with the declaration moved; the answer must follow it. */
  moved?: MovedVariant;
  /**
   * The use token is a keyword, such as Ruby's bare `super`, not a name. References of the
   * declaration do not list a keyword, so the cell checks that they exclude it.
   */
  keywordUse?: boolean;
  /** Set when this cell fails today. The suite still runs it, through `it.fails`, so a fix is visible. */
  knownGap?: KnownGap;
};
