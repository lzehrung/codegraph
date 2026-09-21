/**
 * Per-language member-access and receiver-shape tables for `./member-access.ts` and the receiver
 * pass in `../graphs/symbol-graph-detailed/receiver-calls.ts`. Rows are keyed by language id,
 * following the trivia-table precedent in `./trivia-tables.ts`: the walkers keep the algorithm,
 * the table keeps the per-language node types, extraction shapes, and receiver keywords.
 *
 * Every registered language has a row. A document, style, or data format row carries only
 * `omittedReason`; a source-language row declares each capability it has and names a one-line
 * reason for each capability it omits, so an omission cannot flip silently.
 * `tests/member-access-tables.test.ts` asserts both halves and re-derives every declared node
 * type from that language's pinned grammar.
 */

/** Receiver spellings that denote the type declaring the calling member, per language. */
export type ReceiverKeywords = {
  /** Keywords naming the type that declares the calling member. */
  own: readonly string[];
  /** Own-type keywords that name an instance rather than the type itself. */
  instanceOwn: readonly string[];
  /** Keywords naming a supertype of the declaring type. */
  supertype: readonly string[];
};

/**
 * How one child of a member-access node is extracted: by field name with a positional fallback,
 * by plain child index, or by named-child index with a plain-child fallback.
 */
export type MemberAccessChild = { field: string; fallbackIndex: number } | { index: number } | { namedIndex: number };

export type MemberAccessShape = {
  /**
   * Member-access node types the shape applies to. A shape without `nodeTypes` is the language's
   * fallback for every other member-access node and must be the last shape in its row.
   */
  nodeTypes?: readonly string[];
  object: MemberAccessChild;
  /** `{ navigation: true }` defers to `getNavigationExpressionProperty`'s navigation-suffix walk. */
  property: MemberAccessChild | { navigation: true };
};

export type MemberAccessRow = {
  /** Why the language has no member-access capability at all; only document, style, and data formats set it. */
  omittedReason?: string;
  /** Member-expression node type for a support whose `nodeTypes.memberExpression` capability is absent. */
  memberExpressionType?: string;
  /** Node types added to the shared traversal base set in `memberAccessTraversalTypes`. */
  extraTraversalTypes?: readonly string[];
  /** Node types added to the shared generic member-access list in `isMemberAccessNode`. */
  extraMemberAccessTypes?: readonly string[];
  /** Extraction shapes for `getMemberAccessParts`, tried in order before the shared generic default. */
  memberAccessShapes?: readonly MemberAccessShape[];
  /** Why the language declares no shapes of its own: the shared generic default is its extraction. */
  memberAccessOmittedReason?: string;
  /** Kotlin fallback: a degraded `navigation_suffix` leaves the property as the expression's last named child. */
  navigationFallbackLastChild?: true;
  /** Identifiers that name the type declaring the calling member. */
  receiverKeywords?: ReceiverKeywords;
  /** Why the language declares no receiver keywords. */
  receiverKeywordsOmittedReason?: string;
  /**
   * Node types that list declared base types on a class-like declaration. Used by
   * `super`/`parent`/`base` member navigation; omitted when the language has no
   * supertype receiver keyword.
   */
  baseListNodeTypes?: readonly string[];
};

/** C models dotted access as `field_expression`; C++ also exposes scoped `qualified_identifier`. */
const C_FIELD_ACCESS_SHAPE: MemberAccessShape = {
  nodeTypes: ["field_expression"],
  object: { field: "argument", fallbackIndex: 0 },
  property: { field: "field", fallbackIndex: 2 },
};

const CPP_QUALIFIED_ACCESS_SHAPE: MemberAccessShape = {
  nodeTypes: ["qualified_identifier"],
  object: { field: "scope", fallbackIndex: 0 },
  property: { field: "name", fallbackIndex: 2 },
};

const THIS_SUPER_RECEIVERS: ReceiverKeywords = { own: ["this"], instanceOwn: ["this"], supertype: ["super"] };
const SELF_RECEIVERS: ReceiverKeywords = { own: ["self"], instanceOwn: ["self"], supertype: ["super"] };

export const MEMBER_ACCESS_ROWS: Record<string, MemberAccessRow> = {
  adoc: { omittedReason: "AsciiDoc document format; embedded code blocks parse as their own language." },
  astro: { omittedReason: "Astro document format; scripts parse as js/ts and templates as html." },
  c: {
    memberAccessShapes: [C_FIELD_ACCESS_SHAPE],
    receiverKeywordsOmittedReason:
      "C has no receiver keyword; member access always names an explicit object or pointer.",
  },
  cpp: {
    memberAccessShapes: [C_FIELD_ACCESS_SHAPE, CPP_QUALIFIED_ACCESS_SHAPE],
    receiverKeywords: { own: ["this"], instanceOwn: ["this"], supertype: [] },
  },
  css: { omittedReason: "Style language; no member-access concept." },
  csharp: {
    memberAccessShapes: [{ object: { index: 0 }, property: { index: 2 } }],
    receiverKeywords: { own: ["this"], instanceOwn: ["this"], supertype: ["base"] },
    baseListNodeTypes: ["base_list"],
  },
  go: {
    extraTraversalTypes: ["qualified_type"],
    extraMemberAccessTypes: ["qualified_type"],
    memberAccessShapes: [{ nodeTypes: ["qualified_type"], object: { namedIndex: 0 }, property: { namedIndex: 1 } }],
    // Go has no receiver keyword: a method call's receiver is an ordinary value. The row still
    // exists so go receivers must be proven rather than falling back to a bare name.
    receiverKeywords: { own: [], instanceOwn: [], supertype: [] },
  },
  hbs: { omittedReason: "Handlebars document format; embedded scripts parse as their own language." },
  html: { omittedReason: "Document format; embedded scripts parse as their own language." },
  java: {
    memberAccessShapes: [
      {
        nodeTypes: ["method_invocation"],
        object: { field: "object", fallbackIndex: 0 },
        property: { field: "name", fallbackIndex: 2 },
      },
      {
        nodeTypes: ["scoped_identifier", "scoped_type_identifier"],
        object: { field: "scope", fallbackIndex: 0 },
        property: { field: "name", fallbackIndex: 2 },
      },
    ],
    receiverKeywords: THIS_SUPER_RECEIVERS,
    baseListNodeTypes: ["superclass"],
  },
  js: {
    memberAccessOmittedReason:
      "The shared generic default already reads member_expression's object and property fields.",
    receiverKeywords: THIS_SUPER_RECEIVERS,
    baseListNodeTypes: ["class_heritage"],
  },
  kotlin: {
    memberAccessShapes: [
      { nodeTypes: ["navigation_expression"], object: { namedIndex: 0 }, property: { navigation: true } },
    ],
    navigationFallbackLastChild: true,
    receiverKeywords: THIS_SUPER_RECEIVERS,
    baseListNodeTypes: ["delegation_specifiers"],
  },
  less: { omittedReason: "Style language; no member-access concept." },
  markdown: { omittedReason: "Document format; fenced code blocks parse as their own language." },
  mdx: { omittedReason: "MDX document format; scripts parse as js/ts and templates as html." },
  php: {
    extraMemberAccessTypes: ["member_call_expression", "nullsafe_member_call_expression", "scoped_call_expression"],
    memberAccessShapes: [
      {
        nodeTypes: ["member_call_expression", "nullsafe_member_call_expression"],
        object: { field: "object", fallbackIndex: 0 },
        property: { field: "name", fallbackIndex: 2 },
      },
      {
        nodeTypes: ["scoped_call_expression"],
        object: { field: "scope", fallbackIndex: 0 },
        property: { field: "name", fallbackIndex: 2 },
      },
    ],
    receiverKeywords: { own: ["$this", "self", "static"], instanceOwn: ["$this"], supertype: ["parent"] },
    baseListNodeTypes: ["base_clause"],
  },
  python: {
    memberExpressionType: "attribute",
    memberAccessShapes: [
      { object: { field: "object", fallbackIndex: 0 }, property: { field: "attribute", fallbackIndex: 2 } },
    ],
    receiverKeywords: { own: ["self", "cls"], instanceOwn: ["self"], supertype: [] },
  },
  rst: { omittedReason: "reStructuredText document format; embedded code blocks parse as their own language." },
  ruby: {
    memberExpressionType: "call",
    memberAccessShapes: [
      {
        nodeTypes: ["scope_resolution"],
        object: { field: "scope", fallbackIndex: 0 },
        property: { field: "name", fallbackIndex: 2 },
      },
      // Ruby models every other member access as a `call` node with receiver and method fields.
      { object: { field: "receiver", fallbackIndex: 0 }, property: { field: "method", fallbackIndex: 2 } },
    ],
    receiverKeywords: { own: ["self"], instanceOwn: ["self"], supertype: [] },
  },
  rust: {
    memberAccessShapes: [
      {
        nodeTypes: ["scoped_identifier"],
        object: { field: "path", fallbackIndex: 0 },
        property: { field: "name", fallbackIndex: 2 },
      },
    ],
    receiverKeywords: { own: ["self", "Self"], instanceOwn: ["self"], supertype: [] },
  },
  scss: { omittedReason: "Style language; no member-access concept." },
  svelte: { omittedReason: "Svelte component format; script blocks parse as js/ts and templates as html." },
  sql: { omittedReason: "Data language; no member-access concept." },
  swift: {
    memberAccessShapes: [
      { nodeTypes: ["navigation_expression"], object: { namedIndex: 0 }, property: { navigation: true } },
    ],
    receiverKeywords: SELF_RECEIVERS,
    baseListNodeTypes: ["inheritance_specifier"],
  },
  ts: {
    memberAccessOmittedReason:
      "The shared generic default already reads member_expression's object and property fields.",
    receiverKeywords: THIS_SUPER_RECEIVERS,
    baseListNodeTypes: ["extends_clause"],
  },
  tsx: {
    memberAccessOmittedReason:
      "The shared generic default already reads member_expression's object and property fields.",
    receiverKeywords: THIS_SUPER_RECEIVERS,
    baseListNodeTypes: ["extends_clause"],
  },
  vue: { omittedReason: "Vue component format; script blocks parse as js/ts and templates as html." },
  zig: {
    memberAccessOmittedReason: "No per-language extraction today; the shared generic default is zig's behavior.",
    receiverKeywords: { own: ["self"], instanceOwn: ["self"], supertype: [] },
  },
};

/** Every language that declares receiver keywords, guarded by the registry-consistency test. */
export const receiverKeywordLanguageIds: readonly string[] = Object.keys(MEMBER_ACCESS_ROWS).filter(
  (languageId) => MEMBER_ACCESS_ROWS[languageId]!.receiverKeywords !== undefined,
);

/** Languages that emit proven receiver `calls` edges from the shared keyword table. */
export function supportsReceiverCallEdges(languageId: string): boolean {
  return MEMBER_ACCESS_ROWS[languageId]?.receiverKeywords !== undefined;
}

/** Languages where goto and references require proven receivers and do not fall back to a bare name. */
export function supportsReceiverMemberNavigation(languageId: string): boolean {
  return MEMBER_ACCESS_ROWS[languageId]?.receiverKeywords !== undefined;
}

export function keywordReceiverKind(languageId: string, receiverName: string): "own" | "supertype" | null {
  const keywords = MEMBER_ACCESS_ROWS[languageId]?.receiverKeywords;
  if (!keywords) return null;
  if (keywords.own.includes(receiverName)) return "own";
  if (keywords.supertype.includes(receiverName)) return "supertype";
  return null;
}

/**
 * Instance-own keywords (`this`, `$this`) require instance members.
 * Other own keywords name the declaring type and may still bind instance members
 * (PHP `self::` / `static::` late static binding), so they do not force a static-only filter.
 */
export function ownReceiverMemberScope(languageId: string, receiverName: string): "instance" | "any" | null {
  const keywords = MEMBER_ACCESS_ROWS[languageId]?.receiverKeywords;
  if (!keywords?.own.includes(receiverName)) return null;
  return keywords.instanceOwn.includes(receiverName) ? "instance" : "any";
}

export function isKeywordReceiver(languageId: string, receiverName: string): boolean {
  return keywordReceiverKind(languageId, receiverName) !== null;
}
