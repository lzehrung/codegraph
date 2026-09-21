/**
 * Per-language arity shapes for call-compatibility signature and callsite extraction, keyed by
 * language id.
 *
 * Before this table the generic extractors in `../call-compatibility.ts` branched on language ids
 * in more than a dozen places: receiver recognition and skip policy, the Swift parameter-child
 * fallback, parameter separators, rest and optional/keyword markers, the zero-slot `void` list,
 * the signature comma-scan mode, the JS/TS source-level fallback, the Zig callsite-parentheses
 * fallback, and uncountable spread markers each carried their own conditional, so a language
 * without a branch silently inherited another language's rules.
 *
 * Every supported language now has one complete row and the extractors receive the resolved row;
 * they never compare language ids. A row omits a capability by leaving its field null/empty and
 * its comment names the reason. `tests/impact-call-compatibility/provider-registry.test.ts`
 * asserts the table covers exactly the supported languages and names only registered ids.
 */

/**
 * Language ids the call-compatibility extractor declares support for, in diagnostics order.
 * The registry has no call-compatibility flag, so the list is declared here and filtered through
 * the registry by `./index.js`: a stale id such as the old `javascript`/`typescript`/`jsx`
 * spellings can never be reported as supported.
 * `tests/language-capability-registry.test.ts` asserts every declaration is registered.
 */
export const CALL_COMPATIBILITY_LANGUAGE_ID_DECLARATIONS = [
  "c",
  "cpp",
  "csharp",
  "go",
  "java",
  "js",
  "kotlin",
  "php",
  "python",
  "ruby",
  "rust",
  "swift",
  "ts",
  "tsx",
  "zig",
] as const;

export type CallCompatibilityLanguageId = (typeof CALL_COMPATIBILITY_LANGUAGE_ID_DECLARATIONS)[number];

/**
 * Everything the signature and callsite extractors know about one language's arity shapes.
 * Field semantics mirror the pre-table branches one-for-one; null/empty means the language has
 * no such capability and the generic rule applies.
 */
export interface CallCompatibilityLanguageProfile {
  /**
   * Method-receiver handling when counting signature slots. A parameter is a receiver only if
   * the recognition lists match it: `firstPositionExact`/`firstPositionTypedPrefixes` apply at
   * parameter index 0, and `thisKeyword` matches the name before the first `:` at any index.
   * A recognized receiver is dropped only when `skipFirst` allows it: `"always"` for every
   * declaration, or `"class-methods"` when the declaration nests inside a `methodScopeTypes`
   * ancestor before a `nonMethodScopeTypes` ancestor.
   */
  readonly receiver: {
    readonly skipFirst: "always" | "class-methods";
    readonly methodScopeTypes: readonly string[];
    readonly nonMethodScopeTypes: readonly string[];
    readonly firstPositionExact: readonly string[];
    readonly firstPositionTypedPrefixes: readonly string[];
    readonly thisKeyword: string | null;
  };
  /**
   * When the declaration exposes no parameter-list node, span its direct children of this type
   * instead (Swift's `parameter` children). Null disables the fallback.
   */
  readonly directParameterChildType: string | null;
  /** Standalone parameter tokens that group parameters without occupying a slot. */
  readonly parameterSeparators: readonly string[];
  /** Parameter prefixes that mark a rest/variadic parameter. */
  readonly restPrefixes: readonly string[];
  /** Word-boundary patterns that mark a rest/variadic parameter. */
  readonly restWordPatterns: readonly RegExp[];
  /** Marker that must appear in the parameter name (before the first `:`) to make it optional. */
  readonly optionalNameMarker: string | null;
  /** Pattern matching keyword parameters that occupy their own slot, or null. */
  readonly keywordParameterPattern: RegExp | null;
  /** Pattern matching keyword parameters whose value makes them optional, or null. */
  readonly keywordParameterValuePattern: RegExp | null;
  /** Parameter texts that occupy zero slots. */
  readonly zeroSlotParameters: readonly string[];
  /**
   * Whether the signature comma-scan may treat `/.../` as a regex literal. Off for Python,
   * whose `/` positional-only separator would otherwise terminate the scan.
   */
  readonly signatureCommaScanDetectsRegexLiterals: boolean;
  /** Whether extraction may fall back to source-level parenthesis scanning when the AST path fails. */
  readonly sourceFallback: boolean;
  /** Whether callsite extraction may scan for the call parentheses when the AST has no argument list. */
  readonly callsiteParenthesesFallback: boolean;
  /** Leading argument prefixes that make a callsite argument count uncountable. */
  readonly spreadPrefixes: readonly string[];
}

/**
 * The rules every language without a divergence inherits: no receiver recognition, rest via the
 * generic top-level `...` scan, optionals via the generic top-level `=`, regex-literal-aware
 * signature comma splitting, and no source-level or callsite fallbacks.
 */
const GENERIC_PROFILE: CallCompatibilityLanguageProfile = {
  receiver: {
    skipFirst: "always",
    methodScopeTypes: [],
    nonMethodScopeTypes: [],
    firstPositionExact: [],
    firstPositionTypedPrefixes: [],
    thisKeyword: null,
  },
  directParameterChildType: null,
  parameterSeparators: [],
  restPrefixes: [],
  restWordPatterns: [],
  optionalNameMarker: null,
  keywordParameterPattern: null,
  keywordParameterValuePattern: null,
  zeroSlotParameters: [],
  signatureCommaScanDetectsRegexLiterals: true,
  sourceFallback: false,
  callsiteParenthesesFallback: false,
  spreadPrefixes: [],
};

/** C-family rows: a bare `void` parameter list occupies zero slots. */
const cFamilyProfile: CallCompatibilityLanguageProfile = {
  ...GENERIC_PROFILE,
  zeroSlotParameters: ["void"],
};

/** ECMAScript-family rows: `this` receivers, `?`-marked optionals, and the source-level fallback. */
const jsFamilyProfile: CallCompatibilityLanguageProfile = {
  ...GENERIC_PROFILE,
  receiver: {
    skipFirst: "always",
    methodScopeTypes: [],
    nonMethodScopeTypes: [],
    firstPositionExact: [],
    firstPositionTypedPrefixes: [],
    // `this` parameters are receivers at any position.
    thisKeyword: "this",
  },
  // `name?` optional parameters.
  optionalNameMarker: "?",
  // The AST path can fail where the source still shows the call, so paren scanning rescues it.
  sourceFallback: true,
};

/** Python rows: class methods drop `self`/`cls`; separators, rest markers, and scan mode diverge. */
const pythonProfile: CallCompatibilityLanguageProfile = {
  ...GENERIC_PROFILE,
  receiver: {
    // Instance methods drop the receiver; module-level functions keep it as a regular slot.
    skipFirst: "class-methods",
    methodScopeTypes: ["class_definition"],
    nonMethodScopeTypes: ["function_definition"],
    firstPositionExact: ["self", "cls"],
    firstPositionTypedPrefixes: ["self:", "cls:"],
    thisKeyword: null,
  },
  // `/` (positional-only) and `*` (keyword-only) group markers occupy no slot.
  parameterSeparators: ["/", "*"],
  // `*args`/`**kwargs` rest parameters, and the same prefixes make callsites uncountable.
  restPrefixes: ["*"],
  spreadPrefixes: ["*"],
  // `/` is the positional-only separator, so the signature comma-scan cannot treat `/.../` as a regex.
  signatureCommaScanDetectsRegexLiterals: false,
};

/** Ruby rows: self/cls receivers, keyword parameters, and `*rest` markers. */
const rubyProfile: CallCompatibilityLanguageProfile = {
  ...GENERIC_PROFILE,
  receiver: {
    skipFirst: "always",
    methodScopeTypes: [],
    nonMethodScopeTypes: [],
    firstPositionExact: ["self", "cls"],
    firstPositionTypedPrefixes: ["self:", "cls:"],
    thisKeyword: null,
  },
  // `*rest`/`**kw` rest parameters, and the same prefixes make callsites uncountable.
  restPrefixes: ["*"],
  spreadPrefixes: ["*"],
  // `name:` keyword parameters occupy their own slot; `name: value` carries a default and is optional.
  keywordParameterPattern: /^[A-Za-z_]\w*:/,
  keywordParameterValuePattern: /^[A-Za-z_]\w*:\s*\S/,
};

/** Rust rows: `self`, `&self`, and `&mut self` receivers, including typed `self:` forms. */
const rustProfile: CallCompatibilityLanguageProfile = {
  ...GENERIC_PROFILE,
  receiver: {
    skipFirst: "always",
    methodScopeTypes: [],
    nonMethodScopeTypes: [],
    firstPositionExact: ["self", "&self", "&mut self"],
    firstPositionTypedPrefixes: ["self:"],
    thisKeyword: null,
  },
};

export const CALL_COMPATIBILITY_LANGUAGE_PROFILES: Record<
  CallCompatibilityLanguageId,
  CallCompatibilityLanguageProfile
> = {
  c: cFamilyProfile,
  cpp: cFamilyProfile,
  // `params` marks the rest parameter.
  csharp: { ...GENERIC_PROFILE, restWordPatterns: [/\bparams\b/] },
  // Trailing `...string` variadics ride the generic top-level ellipsis scan.
  go: GENERIC_PROFILE,
  // `String...` variadics ride the generic top-level ellipsis scan; Java has no optional parameters.
  java: GENERIC_PROFILE,
  js: jsFamilyProfile,
  ts: jsFamilyProfile,
  tsx: jsFamilyProfile,
  // `vararg` marks the rest parameter.
  kotlin: { ...GENERIC_PROFILE, restWordPatterns: [/\bvararg\b/] },
  // `...$rest` spreads ride the generic leading-`...` callsite rule.
  php: GENERIC_PROFILE,
  python: pythonProfile,
  ruby: rubyProfile,
  rust: rustProfile,
  // Parameter clauses expose no list node; span the declaration's direct `parameter` children.
  swift: { ...GENERIC_PROFILE, directParameterChildType: "parameter" },
  // Callsites expose no argument-list node; scan for the call parentheses instead.
  zig: { ...GENERIC_PROFILE, callsiteParenthesesFallback: true },
};
