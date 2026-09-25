/**
 * Shared callable arity facts derived from syntax trees.
 *
 * This leaf module is the single source of truth for two questions: how many explicit arguments a
 * callable declaration accepts (`getCallableArity`) and how many explicit arguments a call passes
 * (`getCallArgumentCount`). Impact analysis, the detailed symbol graph, and member navigation all
 * consume these functions so one language rule cannot drift between consumers.
 *
 * Parameter and argument structure comes from parameter/argument nodes, not from comma-splitting
 * spans: a generic type comma (`Map<String, Integer> value`) is not a parameter boundary, and a
 * default value the grammar stores as a sibling of its parameter (Swift `default_value`, Kotlin's
 * bare default expression) is not a second parameter. Unknown or unprovable shapes return null so
 * callers can report unknown results instead of a wrong count.
 *
 * The module must stay a leaf: it may import only pure text scanning
 * (`../impact/call-compatibility/text-scanner.js`) and `./types.js`, never navigation, scope,
 * graph, or index-building code, so graph and navigation consumers can import it without a
 * dependency cycle.
 */

import {
  findBalancedParentheses,
  findCommentEnd,
  findOpeningParen,
  splitTopLevelCommaGroups,
} from "../impact/call-compatibility/text-scanner.js";
import type { SyntaxNodeLike } from "./types.js";

/** Inclusive accepted explicit-argument range. `maxArgs: null` means unbounded (variadic). */
export type CallableArity = { minArgs: number; maxArgs: number | null };

/**
 * How the callable's receiver is supplied by the call form. `"bound"` (the default) means the call
 * form supplies the receiver, so a receiver parameter accepts no explicit argument; `"unbound"`
 * means the receiver is passed explicitly as the first argument (Python class access to an
 * instance method, Rust UFCS calls). Static methods declare no receiver and never drop a parameter
 * under either binding.
 */
export type CallableBinding = "bound" | "unbound";

/**
 * Call form that resolved C# member callsites use, shared by the detailed graph, receiver
 * navigation, and impact. Codegraph resolves a C# extension method only through its declaring
 * static class (`Ext.M(value)`, including alias- and namespace-qualified owners) or a bare call
 * inside it, never through the extended value (`value.M()` needs receiver-type inference and
 * stays unresolved), so the `this` receiver is an explicit argument at every resolved callsite.
 * Every other language's member lookup binds the receiver.
 */
export function memberLookupBinding(languageId: string): CallableBinding {
  return languageId === "csharp" ? "unbound" : "bound";
}

/**
 * What kind of callable a declaration is, for call-form binding decisions. `"instance-method"` and
 * `"class-method"` declarations have a receiver; `"static-method"` and `"function"` declarations do
 * not. Python decorators decide between the three method kinds.
 */
export type CallableDeclarationKind = "function" | "instance-method" | "class-method" | "static-method";

/** Node types that anchor a callable declaration when scanning up from a symbol position. */
export const CALLABLE_DECLARATION_NODE_TYPES: Record<string, true> = {
  arrow_function: true,
  constructor_declaration: true,
  declaration: true,
  function: true,
  function_declaration: true,
  function_declarator: true,
  function_definition: true,
  function_expression: true,
  function_item: true,
  function_signature_item: true,
  generator_function_declaration: true,
  init_declaration: true,
  local_function_statement: true,
  method: true,
  method_declaration: true,
  method_definition: true,
  protocol_function_declaration: true,
  singleton_method: true,
  variable_declarator: true,
};

/** Node types whose value may be a callable for `variable_declarator` declarations. */
export const CALLABLE_VARIABLE_VALUE_NODE_TYPES: Record<string, true> = {
  arrow_function: true,
  function: true,
  function_expression: true,
};

/** Parameter-list node types searched when the declaration exposes no parameter field. */
const PARAMETER_LIST_NODE_TYPES: Record<string, true> = {
  formal_parameters: true,
  function_parameter_clause: true,
  function_value_parameters: true,
  method_parameters: true,
  parameter_list: true,
  parameters: true,
};

/** Argument-list node types searched inside a call node. */
const ARGUMENT_LIST_NODE_TYPES: Record<string, true> = {
  argument_list: true,
  arguments: true,
  value_arguments: true,
};

/** Call node types accepted when locating or climbing trailing-closure wrapper calls. */
const CALL_NODE_TYPES: Record<string, true> = {
  call: true,
  call_expression: true,
  function_call_expression: true,
  invocation_expression: true,
  member_call_expression: true,
  method_invocation: true,
  object_creation_expression: true,
  scoped_call_expression: true,
};

/**
 * Everything the arity extractors know about one language's parameter and argument shapes. A row
 * omits a capability by leaving its field null/empty; the generic rule then applies. The node-type
 * lists mirror the pinned grammars this repository loads (tree-sitter-java `receiver_parameter`,
 * tree-sitter-swift parameter/default_value siblings, tree-sitter-kotlin-ng `parameter_modifiers`).
 */
export interface CallableArityLanguageProfile {
  /** Receiver-parameter recognition; see {@link CallableBinding} for how binding maps to slots. */
  readonly receiver: {
    /** Parameter node types that are the receiver (Java `receiver_parameter`, Rust `self_parameter`). */
    readonly nodeTypes: readonly string[];
    /** First-parameter text spellings that identify a receiver (Rust `self` forms, Ruby `self`). */
    readonly firstParameterExact: readonly string[];
    /** First-parameter text prefixes that identify a typed receiver (Rust `self:` forms). */
    readonly firstParameterTypedPrefixes: readonly string[];
    /**
     * Type-only parameters named this (JS/TS `this: T`). They are never argument slots under
     * either binding because the language cannot pass them at a call.
     */
    readonly phantomThisKeyword: string | null;
    /**
     * Scope-gated first-parameter receivers (Python): inside a class body the first parameter is
     * the receiver whatever its spelling, unless a decorator makes the method static.
     */
    readonly scopedFirstParameter: {
      readonly methodScopeTypes: readonly string[];
      readonly nonMethodScopeTypes: readonly string[];
      readonly staticDecorators: readonly string[];
      readonly classDecorators: readonly string[];
    } | null;
  };
  /**
   * When the declaration exposes no parameter-list node, treat its direct children of this type as
   * parameters (Swift). Null disables the fallback.
   */
  readonly directParameterChildType: string | null;
  /** Standalone parameter tokens that group parameters without occupying a slot (`/`, `*`). */
  readonly parameterSeparators: readonly string[];
  /** Parameter prefixes that mark a rest/variadic parameter. */
  readonly restPrefixes: readonly string[];
  /** Word-boundary patterns that mark a rest/variadic parameter. */
  readonly restWordPatterns: readonly RegExp[];
  /** Marker in the parameter name (before the first `:`) that makes it optional. */
  readonly optionalNameMarker: string | null;
  /** Pattern matching keyword parameters that occupy their own slot, or null. */
  readonly keywordParameterPattern: RegExp | null;
  /** Pattern matching keyword parameters whose value makes them optional, or null. */
  readonly keywordParameterValuePattern: RegExp | null;
  /** Parameter texts that occupy zero slots (C-family `void`). */
  readonly zeroSlotParameters: readonly string[];
  /** Parameter node types that are ordinary parameters. */
  readonly parameterNodeTypes: readonly string[];
  /** Node types that modify the following parameter instead of standing alone (Kotlin `vararg`). */
  readonly modifierNodeTypes: readonly string[];
  /** Parameter node types that occupy zero slots (Ruby `block_parameter`, Python separators). */
  readonly zeroSlotNodeTypes: readonly string[];
  /** Parameter node types that are rest/variadic forms. */
  readonly restNodeTypes: readonly string[];
  /** Parameter node types that are optional by construction (defaults inside the node). */
  readonly optionalNodeTypes: readonly string[];
  /**
   * Merge runs of non-parameter named children into one synthetic parameter. Needed for C# `params`
   * forms, which the pinned grammar flattens into the parameter list instead of a parameter node.
   */
  readonly mergeParameterRuns: boolean;
  /** Count leading name identifiers as separate slots (Go grouped names `a, b string`). */
  readonly leadingNameSlots: boolean;
  /**
   * Whether the signature comma scan may treat `/.../` as a regex literal. Off for Python, whose
   * `/` positional-only separator would otherwise terminate the scan.
   */
  readonly signatureCommaScanDetectsRegexLiterals: boolean;
  /** Whether extraction may fall back to source-level parenthesis scanning when the AST path fails. */
  readonly sourceFallback: boolean;
  /** Whether callsite extraction may scan for the call parentheses when the AST has no argument list. */
  readonly callsiteParenthesesFallback: boolean;
  /** Leading argument prefixes that make a callsite argument count uncountable. */
  readonly spreadPrefixes: readonly string[];
  /** Argument node types that spread uncountable argument lists (Kotlin `spread_expression`). */
  readonly spreadNodeTypes: readonly string[];
  /** Trailing closure node types that count as trailing arguments (Swift/Kotlin). */
  readonly trailingClosureNodeTypes: readonly string[];
}

const GENERIC_PROFILE: CallableArityLanguageProfile = {
  receiver: {
    nodeTypes: [],
    firstParameterExact: [],
    firstParameterTypedPrefixes: [],
    phantomThisKeyword: null,
    scopedFirstParameter: null,
  },
  directParameterChildType: null,
  parameterSeparators: [],
  restPrefixes: [],
  restWordPatterns: [],
  optionalNameMarker: null,
  keywordParameterPattern: null,
  keywordParameterValuePattern: null,
  zeroSlotParameters: [],
  parameterNodeTypes: [],
  modifierNodeTypes: [],
  zeroSlotNodeTypes: [],
  restNodeTypes: [],
  optionalNodeTypes: [],
  mergeParameterRuns: false,
  leadingNameSlots: false,
  signatureCommaScanDetectsRegexLiterals: true,
  sourceFallback: false,
  callsiteParenthesesFallback: false,
  spreadPrefixes: [],
  spreadNodeTypes: [],
  trailingClosureNodeTypes: [],
};

/** C-family rows: a bare `void` parameter list occupies zero slots. */
const cFamilyProfile: CallableArityLanguageProfile = {
  ...GENERIC_PROFILE,
  zeroSlotParameters: ["void"],
  parameterNodeTypes: [
    "parameter_declaration",
    "optional_parameter_declaration",
    "variadic_parameter",
    "variadic_parameter_declaration",
  ],
  restNodeTypes: ["variadic_parameter", "variadic_parameter_declaration"],
  optionalNodeTypes: ["optional_parameter_declaration"],
};

/** ECMAScript-family rows: `this` parameters, `?`-marked optionals, and the source-level fallback. */
const jsFamilyProfile: CallableArityLanguageProfile = {
  ...GENERIC_PROFILE,
  receiver: {
    ...GENERIC_PROFILE.receiver,
    // `this` parameters are type-only receivers at any position; never an argument slot.
    phantomThisKeyword: "this",
  },
  parameterNodeTypes: ["required_parameter", "optional_parameter"],
  optionalNodeTypes: ["optional_parameter"],
  optionalNameMarker: "?",
  // The AST path can fail where the source still shows the call, so paren scanning rescues it.
  sourceFallback: true,
};

/** Python rows: class-scoped first parameters are receivers; separators and rest markers diverge. */
const pythonProfile: CallableArityLanguageProfile = {
  ...GENERIC_PROFILE,
  receiver: {
    ...GENERIC_PROFILE.receiver,
    // Instance and class methods drop their first parameter; static methods and module functions
    // keep it as an ordinary slot whatever its spelling.
    scopedFirstParameter: {
      methodScopeTypes: ["class_definition"],
      nonMethodScopeTypes: ["function_definition"],
      staticDecorators: ["staticmethod"],
      classDecorators: ["classmethod"],
    },
  },
  parameterNodeTypes: [
    "identifier",
    "default_parameter",
    "typed_parameter",
    "typed_default_parameter",
    "list_splat_pattern",
    "dictionary_splat_pattern",
    "tuple_pattern",
  ],
  zeroSlotNodeTypes: ["positional_separator", "keyword_separator"],
  restNodeTypes: ["list_splat_pattern", "dictionary_splat_pattern"],
  optionalNodeTypes: ["default_parameter", "typed_default_parameter"],
  parameterSeparators: ["/", "*"],
  restPrefixes: ["*"],
  spreadPrefixes: ["*"],
  spreadNodeTypes: ["list_splat", "dictionary_splat"],
  // `/` is the positional-only separator, so the signature comma-scan cannot treat `/.../` as a regex.
  signatureCommaScanDetectsRegexLiterals: false,
};

/** Ruby rows: `self` is the only receiver spelling; block capture occupies no positional slot. */
const rubyProfile: CallableArityLanguageProfile = {
  ...GENERIC_PROFILE,
  receiver: {
    ...GENERIC_PROFILE.receiver,
    // `cls` and other names are ordinary parameters; only error-recovered `self` is a receiver.
    firstParameterExact: ["self"],
  },
  parameterNodeTypes: [
    "identifier",
    "optional_parameter",
    "splat_parameter",
    "hash_splat_parameter",
    "keyword_parameter",
    "keyword_rest_parameter",
    "block_parameter",
    "proc_parameter",
    "forward_parameter",
    "bare_parameter",
    "rest_parameter",
  ],
  zeroSlotNodeTypes: ["block_parameter", "proc_parameter"],
  restNodeTypes: [
    "splat_parameter",
    "hash_splat_parameter",
    "keyword_rest_parameter",
    "forward_parameter",
    "rest_parameter",
  ],
  optionalNodeTypes: ["optional_parameter"],
  restPrefixes: ["*"],
  spreadPrefixes: ["*"],
  keywordParameterPattern: /^[A-Za-z_]\w*:/,
  keywordParameterValuePattern: /^[A-Za-z_]\w*:\s*\S/,
};

/** Rust rows: `self_parameter` receivers, including typed `self:` forms. */
const rustProfile: CallableArityLanguageProfile = {
  ...GENERIC_PROFILE,
  receiver: {
    ...GENERIC_PROFILE.receiver,
    nodeTypes: ["self_parameter"],
    firstParameterExact: ["self", "&self", "&mut self"],
    firstParameterTypedPrefixes: ["self:"],
  },
  parameterNodeTypes: ["parameter", "self_parameter"],
};

/**
 * Language ids the callable-arity extractors declare support for, in diagnostics order. The list is
 * filtered against the registry by the call-compatibility provider registry so a stale id can never
 * be reported as supported.
 */
export const CALLABLE_ARITY_LANGUAGE_ID_DECLARATIONS = [
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

export type CallableArityLanguageId = (typeof CALLABLE_ARITY_LANGUAGE_ID_DECLARATIONS)[number];

export const CALLABLE_ARITY_LANGUAGE_PROFILES: Record<CallableArityLanguageId, CallableArityLanguageProfile> = {
  c: cFamilyProfile,
  cpp: cFamilyProfile,
  // `params` marks the rest parameter; the pinned grammar flattens `params` forms into list children.
  // An extension method's leading `this T value` parameter (a `modifier` child spelled `this`) is its
  // receiver: `value.M()` supplies it, while `Ext.M(value)` passes it explicitly.
  csharp: {
    ...GENERIC_PROFILE,
    receiver: { ...GENERIC_PROFILE.receiver, firstParameterTypedPrefixes: ["this "] },
    parameterNodeTypes: ["parameter"],
    mergeParameterRuns: true,
    restWordPatterns: [/\bparams\b/],
  },
  // Grouped names `a, b string` share one parameter node; `...string` variadics are node-typed.
  go: {
    ...GENERIC_PROFILE,
    parameterNodeTypes: ["parameter_declaration"],
    restNodeTypes: ["variadic_parameter_declaration"],
    leadingNameSlots: true,
  },
  // `receiver_parameter` nodes are explicit receivers; `spread_parameter` nodes are variadic.
  java: {
    ...GENERIC_PROFILE,
    receiver: { ...GENERIC_PROFILE.receiver, nodeTypes: ["receiver_parameter"] },
    parameterNodeTypes: ["formal_parameter", "receiver_parameter", "spread_parameter"],
    restNodeTypes: ["spread_parameter"],
  },
  js: jsFamilyProfile,
  ts: jsFamilyProfile,
  tsx: jsFamilyProfile,
  // `vararg` rides a parameter_modifiers sibling; spread calls (`*values`) are uncountable.
  kotlin: {
    ...GENERIC_PROFILE,
    parameterNodeTypes: ["parameter"],
    modifierNodeTypes: ["parameter_modifiers", "parameter_modifier"],
    restWordPatterns: [/\bvararg\b/],
    spreadPrefixes: ["*"],
    spreadNodeTypes: ["spread_expression"],
    trailingClosureNodeTypes: ["annotated_lambda"],
  },
  // `...$rest` spreads ride the generic leading-`...` rules; promotion parameters are plain slots.
  php: {
    ...GENERIC_PROFILE,
    parameterNodeTypes: ["simple_parameter", "variadic_parameter", "property_promotion_parameter"],
    restNodeTypes: ["variadic_parameter"],
    spreadNodeTypes: ["variadic_parameter"],
  },
  python: pythonProfile,
  ruby: rubyProfile,
  rust: rustProfile,
  // Parameter clauses expose no list node; span the declaration's direct `parameter` children.
  swift: {
    ...GENERIC_PROFILE,
    directParameterChildType: "parameter",
    trailingClosureNodeTypes: ["lambda_literal"],
  },
  // Callsites expose no argument-list node; scan for the call parentheses instead.
  zig: { ...GENERIC_PROFILE, parameterNodeTypes: ["parameter"], callsiteParenthesesFallback: true },
};

/**
 * Resolved arity profile for a language id, or null when the id is not a declared arity language.
 * The extractors branch on this profile, never on language ids.
 */
export function getCallableArityProfile(languageId: string): CallableArityLanguageProfile | null {
  if (!(CALLABLE_ARITY_LANGUAGE_ID_DECLARATIONS as readonly string[]).includes(languageId)) {
    return null;
  }
  return CALLABLE_ARITY_LANGUAGE_PROFILES[languageId as CallableArityLanguageId];
}

function hasTopLevelEquals(text: string): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    const commentEnd = findCommentEnd(text, index);
    if (commentEnd !== null) {
      if (commentEnd < 0) {
        return false;
      }
      index = commentEnd - 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth -= 1;
      if (parenDepth < 0) {
        return false;
      }
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth -= 1;
      if (bracketDepth < 0) {
        return false;
      }
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) {
        return false;
      }
      continue;
    }
    const atTopLevel = !parenDepth && !bracketDepth && !braceDepth;
    if (char === "<" && atTopLevel) {
      angleDepth += 1;
      continue;
    }
    if (char === ">" && text[index - 1] !== "=" && atTopLevel && angleDepth) {
      angleDepth -= 1;
      continue;
    }
    if (char === "=" && text[index + 1] !== ">" && atTopLevel && !angleDepth) {
      return true;
    }
  }

  return false;
}

function hasTopLevelEllipsis(text: string): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    const commentEnd = findCommentEnd(text, index);
    if (commentEnd !== null) {
      if (commentEnd < 0) {
        return false;
      }
      index = commentEnd - 1;
      continue;
    }

    if (canStartRegexLiteral(text, index)) {
      const regexEnd = findRegexLiteralEnd(text, index);
      if (regexEnd === null || regexEnd < 0) {
        return false;
      }
      index = regexEnd - 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth -= 1;
      if (parenDepth < 0) {
        return false;
      }
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth -= 1;
      if (bracketDepth < 0) {
        return false;
      }
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) {
        return false;
      }
      continue;
    }
    const atDelimiterTopLevel = !parenDepth && !bracketDepth && !braceDepth;
    if (char === "<" && atDelimiterTopLevel) {
      angleDepth += 1;
      continue;
    }
    if (char === ">" && angleDepth && atDelimiterTopLevel && text[index - 1] !== "=") {
      angleDepth -= 1;
      continue;
    }
    if (!angleDepth && atDelimiterTopLevel && text.startsWith("...", index)) {
      return true;
    }
  }

  return false;
}

function canStartRegexLiteral(text: string, index: number): boolean {
  if (text[index] !== "/" || text[index + 1] === "/" || text[index + 1] === "*") {
    return false;
  }
  let previous: string | null = null;
  for (let current = index - 1; current >= 0; current -= 1) {
    const char = text[current];
    if (char !== undefined && !/\s/.test(char)) {
      previous = char;
      break;
    }
  }
  if (!previous) {
    return true;
  }
  return "([{,=:+-!*?&|;".includes(previous);
}

function findRegexLiteralEnd(text: string, index: number): number | null {
  if (text[index] !== "/" || text[index + 1] === "/" || text[index + 1] === "*") {
    return null;
  }
  let escaped = false;
  let inCharacterClass = false;
  for (let current = index + 1; current < text.length; current += 1) {
    const char = text[current];
    if (char === "\n" || char === "\r") {
      return -1;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "]") {
      inCharacterClass = false;
      continue;
    }
    if (char === "/" && !inCharacterClass) {
      let endIndex = current + 1;
      while (/[A-Za-z]/.test(text[endIndex] ?? "")) {
        endIndex += 1;
      }
      return endIndex;
    }
  }
  return -1;
}

/** One parameter of a declaration, reduced to the facts the arity count needs. */
interface ParameterFact {
  text: string;
  nodeType: string | null;
  slots: number;
  forcedOptional: boolean;
  forcedRest: boolean;
  forcedZeroSlot: boolean;
}

type ReceiverMatch = "bound-receiver" | "phantom";

interface EnumerationResult {
  parameters: ParameterFact[];
  hasRest: boolean;
}

function sliceOf(source: string, node: SyntaxNodeLike): string {
  return source.slice(node.startIndex, node.endIndex);
}

function isNamedChild(parent: SyntaxNodeLike, child: SyntaxNodeLike): boolean {
  for (const named of parent.namedChildren ?? []) {
    if (named.startIndex === child.startIndex && named.type === child.type) {
      return true;
    }
  }
  return false;
}

function nameBeforeFirstColon(text: string): string {
  const colonIndex = text.indexOf(":");
  const namePortion = colonIndex >= 0 ? text.slice(0, colonIndex) : text;
  return namePortion.trim();
}

function decoratorName(node: SyntaxNodeLike): string | null {
  if (node.type === "identifier") {
    return node.text;
  }
  if (node.type === "attribute") {
    let last: string | null = null;
    for (const nested of node.namedChildren ?? []) {
      if (nested.type === "identifier") {
        last = nested.text;
      }
    }
    return last;
  }
  if (node.type === "call") {
    const callee = node.childForFieldName("function") ?? node.childForFieldName("decorator") ?? null;
    return callee ? decoratorName(callee) : null;
  }
  for (const child of node.namedChildren ?? []) {
    const name = decoratorName(child);
    if (name !== null) {
      return name;
    }
  }
  return null;
}

function scopedKindOf(
  declaration: SyntaxNodeLike,
  rule: NonNullable<CallableArityLanguageProfile["receiver"]["scopedFirstParameter"]>,
): CallableDeclarationKind {
  let scopeKind: "method" | "function" | null = null;
  let current = declaration.parent;
  while (current && scopeKind === null) {
    if (rule.methodScopeTypes.includes(current.type)) {
      scopeKind = "method";
      break;
    }
    if (rule.nonMethodScopeTypes.includes(current.type)) {
      scopeKind = "function";
      break;
    }
    current = current.parent;
  }
  if (scopeKind !== "method") {
    return "function";
  }

  let decoratorOwner: SyntaxNodeLike | null = declaration.parent;
  while (decoratorOwner) {
    if (decoratorOwner.type === "decorated_definition") {
      break;
    }
    if (rule.methodScopeTypes.includes(decoratorOwner.type)) {
      decoratorOwner = null;
      break;
    }
    decoratorOwner = decoratorOwner.parent;
  }
  for (const child of decoratorOwner?.namedChildren ?? []) {
    if (child.type !== "decorator") {
      continue;
    }
    const name = decoratorName(child);
    if (name !== null && rule.staticDecorators.includes(name)) {
      return "static-method";
    }
    if (name !== null && rule.classDecorators.includes(name)) {
      return "class-method";
    }
  }
  return "instance-method";
}

function receiverMatchFor(
  profile: CallableArityLanguageProfile,
  parameter: { text: string; nodeType: string | null },
  index: number,
  kind: CallableDeclarationKind,
): ReceiverMatch | null {
  const phantomKeyword = profile.receiver.phantomThisKeyword;
  if (phantomKeyword !== null && nameBeforeFirstColon(parameter.text) === phantomKeyword) {
    return "phantom";
  }
  if (parameter.nodeType !== null && profile.receiver.nodeTypes.includes(parameter.nodeType)) {
    return "bound-receiver";
  }
  if (index) {
    return null;
  }
  const trimmed = parameter.text.trim();
  if (profile.receiver.firstParameterExact.includes(trimmed)) {
    return "bound-receiver";
  }
  if (profile.receiver.firstParameterTypedPrefixes.some((prefix) => trimmed.startsWith(prefix))) {
    return "bound-receiver";
  }
  const scopedRule = profile.receiver.scopedFirstParameter;
  if (scopedRule && (kind === "instance-method" || kind === "class-method")) {
    return "bound-receiver";
  }
  return null;
}

function isRestParameter(profile: CallableArityLanguageProfile, parameter: string): boolean {
  const trimmed = parameter.trim();
  if (!trimmed) {
    return false;
  }
  if (hasTopLevelEllipsis(trimmed)) {
    return true;
  }
  if (profile.restPrefixes.some((prefix) => trimmed.startsWith(prefix))) {
    return true;
  }
  return profile.restWordPatterns.some((pattern) => pattern.test(trimmed));
}

function isOptionalParameter(profile: CallableArityLanguageProfile, parameter: string): boolean {
  const trimmed = parameter.trim();
  if (!trimmed) {
    return false;
  }
  const nameMarker = profile.optionalNameMarker;
  if (nameMarker !== null) {
    const namePortion = nameBeforeFirstColon(trimmed);
    if (namePortion.includes(nameMarker)) {
      return true;
    }
  }
  if (profile.keywordParameterValuePattern?.test(trimmed)) {
    return true;
  }
  return hasTopLevelEquals(trimmed);
}

function parameterSlotCount(
  profile: CallableArityLanguageProfile,
  parameterNode: SyntaxNodeLike | null,
  text: string,
): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  if (profile.zeroSlotParameters.includes(trimmed)) {
    return 0;
  }
  if (profile.leadingNameSlots && parameterNode) {
    let names = 0;
    for (const child of parameterNode.namedChildren ?? []) {
      if (child.type === "identifier") {
        names += 1;
      }
    }
    return names > 0 ? names : 1;
  }
  return 1;
}

function isParameterNodeType(profile: CallableArityLanguageProfile, type: string): boolean {
  return (
    profile.parameterNodeTypes.includes(type) ||
    profile.zeroSlotNodeTypes.includes(type) ||
    profile.restNodeTypes.includes(type) ||
    profile.optionalNodeTypes.includes(type)
  );
}

type ParameterRegion =
  | { kind: "list"; node: SyntaxNodeLike }
  | { kind: "single"; node: SyntaxNodeLike }
  | { kind: "direct"; declaration: SyntaxNodeLike; parameterType: string };

function findParameterRegion(
  declaration: SyntaxNodeLike,
  profile: CallableArityLanguageProfile,
): ParameterRegion | null {
  const direct =
    declaration.childForFieldName("parameters") ??
    declaration.childForFieldName("params") ??
    declaration.childForFieldName("parameter");
  if (direct) {
    if (PARAMETER_LIST_NODE_TYPES[direct.type]) {
      return { kind: "list", node: direct };
    }
    return { kind: "single", node: direct };
  }
  if (declaration.type === "variable_declarator") {
    const valueNode = declaration.childForFieldName("value");
    if (!valueNode || !CALLABLE_VARIABLE_VALUE_NODE_TYPES[valueNode.type]) {
      return null;
    }
    return findParameterRegion(valueNode, profile);
  }
  for (const child of declaration.namedChildren ?? []) {
    if (PARAMETER_LIST_NODE_TYPES[child.type]) {
      return { kind: "list", node: child };
    }
    const nested = findNestedParameterList(child);
    if (nested) {
      return { kind: "list", node: nested };
    }
  }
  const directType = profile.directParameterChildType;
  if (directType !== null) {
    return { kind: "direct", declaration, parameterType: directType };
  }
  return null;
}

function findNestedParameterList(node: SyntaxNodeLike): SyntaxNodeLike | null {
  for (const child of node.namedChildren ?? []) {
    if (PARAMETER_LIST_NODE_TYPES[child.type]) {
      return child;
    }
    const nested = findNestedParameterList(child);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function enumerateListParameters(
  profile: CallableArityLanguageProfile,
  region: SyntaxNodeLike,
  source: string,
): EnumerationResult | null {
  const parameters: ParameterFact[] = [];
  let hasRest = false;
  let prefixText = "";
  let sawEquals = false;
  let last: ParameterFact | null = null;
  let lastEndIndex = region.startIndex;
  let runStartIndex = -1;
  let runEndIndex = -1;

  const flushRun = (): void => {
    if (runStartIndex < 0) {
      return;
    }
    const runText = source.slice(runStartIndex, runEndIndex);
    const fact: ParameterFact = {
      text: `${prefixText}${runText}`,
      nodeType: null,
      slots: parameterSlotCount(profile, null, runText),
      forcedOptional: false,
      forcedRest: false,
      forcedZeroSlot: false,
    };
    prefixText = "";
    lastEndIndex = runEndIndex;
    last = fact;
    parameters.push(fact);
    runStartIndex = -1;
    runEndIndex = -1;
  };

  for (let index = 0; ; index += 1) {
    const child = region.child(index);
    if (!child) {
      break;
    }
    if (child.type === "comment") {
      continue;
    }
    if (child.type === "ERROR" || child.type === "MISSING") {
      return null;
    }
    if (!isNamedChild(region, child)) {
      const trimmed = child.text.trim();
      if (trimmed === "=") {
        sawEquals = true;
        continue;
      }
      if (trimmed === "...") {
        hasRest = true;
        continue;
      }
      if (trimmed === "," || trimmed === "(" || trimmed === ")") {
        flushRun();
        continue;
      }
      if (profile.mergeParameterRuns && trimmed) {
        if (runStartIndex < 0) {
          runStartIndex = child.startIndex;
        }
        runEndIndex = child.endIndex;
        lastEndIndex = child.endIndex;
        sawEquals = false;
      }
      continue;
    }
    if (profile.modifierNodeTypes.includes(child.type)) {
      prefixText += `${sliceOf(source, child)} `;
      continue;
    }
    if (isParameterNodeType(profile, child.type)) {
      flushRun();
      const fact: ParameterFact = {
        text: `${prefixText}${sliceOf(source, child)}`,
        nodeType: child.type,
        slots: parameterSlotCount(profile, child, sliceOf(source, child)),
        forcedOptional: profile.optionalNodeTypes.includes(child.type),
        forcedRest: profile.restNodeTypes.includes(child.type),
        forcedZeroSlot: profile.zeroSlotNodeTypes.includes(child.type),
      };
      prefixText = "";
      sawEquals = false;
      lastEndIndex = child.endIndex;
      last = fact;
      parameters.push(fact);
      continue;
    }
    const gap = source.slice(lastEndIndex, child.startIndex);
    if (last && (sawEquals || gap.includes("="))) {
      flushRun();
      last.forcedOptional = true;
      sawEquals = false;
      lastEndIndex = child.endIndex;
      continue;
    }
    if (!profile.mergeParameterRuns) {
      return null;
    }
    if (runStartIndex < 0) {
      runStartIndex = child.startIndex;
    }
    runEndIndex = child.endIndex;
    lastEndIndex = child.endIndex;
    sawEquals = false;
  }

  flushRun();
  return { parameters, hasRest };
}

function enumerateDirectParameters(
  profile: CallableArityLanguageProfile,
  region: { declaration: SyntaxNodeLike; parameterType: string },
  source: string,
): EnumerationResult {
  const parameters: ParameterFact[] = [];
  let last: ParameterFact | null = null;
  let lastEndIndex = region.declaration.startIndex;

  for (const child of region.declaration.namedChildren ?? []) {
    if (child.type !== region.parameterType) {
      if (last === null) {
        continue;
      }
      const gap = source.slice(lastEndIndex, child.startIndex);
      if (gap.includes("=")) {
        last.forcedOptional = true;
        lastEndIndex = child.endIndex;
        continue;
      }
      break;
    }
    const fact: ParameterFact = {
      text: sliceOf(source, child),
      nodeType: child.type,
      slots: parameterSlotCount(profile, child, sliceOf(source, child)),
      forcedOptional: false,
      forcedRest: false,
      forcedZeroSlot: false,
    };
    lastEndIndex = child.endIndex;
    last = fact;
    parameters.push(fact);
  }
  return { parameters, hasRest: false };
}

function enumerateParameters(
  profile: CallableArityLanguageProfile,
  declaration: SyntaxNodeLike,
  source: string,
): EnumerationResult | null {
  const region = findParameterRegion(declaration, profile);
  if (region === null) {
    if (declaration.type === "variable_declarator") {
      return null;
    }
    if (CALLABLE_DECLARATION_NODE_TYPES[declaration.type]) {
      return { parameters: [], hasRest: false };
    }
    return null;
  }
  if (region.kind === "single") {
    const text = sliceOf(source, region.node);
    return {
      parameters: [
        {
          text,
          nodeType: region.node.type,
          slots: parameterSlotCount(profile, region.node, text),
          forcedOptional: profile.optionalNodeTypes.includes(region.node.type),
          forcedRest: profile.restNodeTypes.includes(region.node.type),
          forcedZeroSlot: profile.zeroSlotNodeTypes.includes(region.node.type),
        },
      ],
      hasRest: false,
    };
  }
  if (region.kind === "direct") {
    return enumerateDirectParameters(profile, region, source);
  }
  return enumerateListParameters(profile, region.node, source);
}

function kindFor(
  profile: CallableArityLanguageProfile,
  declaration: SyntaxNodeLike,
  parameters: readonly ParameterFact[],
): CallableDeclarationKind {
  const scopedRule = profile.receiver.scopedFirstParameter;
  if (scopedRule) {
    return scopedKindOf(declaration, scopedRule);
  }
  const hasReceiver = parameters.some(
    (parameter, index) => receiverMatchFor(profile, parameter, index, "function") === "bound-receiver",
  );
  return hasReceiver ? "instance-method" : "function";
}

function arityOfParameters(
  profile: CallableArityLanguageProfile,
  parameters: readonly ParameterFact[],
  initialHasRest: boolean,
  binding: CallableBinding,
  kind: CallableDeclarationKind,
): CallableArity {
  let minArgs = 0;
  let maxArgs = 0;
  let positionalArgCount = 0;
  let hasRest = initialHasRest;

  parameters.forEach((parameter, index) => {
    const trimmed = parameter.text.trim();
    if (!trimmed || profile.parameterSeparators.includes(trimmed)) {
      return;
    }
    const receiver = receiverMatchFor(profile, parameter, index, kind);
    if (receiver === "phantom") {
      return;
    }
    if (receiver === "bound-receiver" && binding === "bound") {
      return;
    }
    if (parameter.forcedZeroSlot) {
      return;
    }
    if (parameter.forcedRest || isRestParameter(profile, trimmed)) {
      hasRest = true;
      return;
    }
    const optional = parameter.forcedOptional || isOptionalParameter(profile, trimmed);
    if (profile.keywordParameterPattern?.test(trimmed)) {
      maxArgs += 1;
      if (!optional) {
        minArgs += 1;
      }
      return;
    }
    const slotCount = parameter.slots;
    if (!slotCount) {
      return;
    }
    positionalArgCount += slotCount;
    maxArgs += slotCount;
    if (!optional) {
      minArgs = positionalArgCount;
    }
  });

  return { minArgs, maxArgs: hasRest ? null : maxArgs };
}

/**
 * Accepted explicit-argument range of a callable declaration.
 *
 * `binding` selects the call form: `"bound"` (default) drops the declaration's receiver parameter
 * because the call form supplies it, while `"unbound"` counts it as an explicit argument. Python
 * static methods and module functions declare no receiver and never drop a parameter; JS/TS `this`
 * parameters are type-only and never occupy a slot. Returns null for unknown languages or shapes
 * the grammar cannot prove.
 */
export function getCallableArity(args: {
  languageId: string;
  source: string;
  declaration: SyntaxNodeLike;
  binding?: CallableBinding;
}): CallableArity | null {
  const profile = getCallableArityProfile(args.languageId);
  if (!profile) {
    return null;
  }
  const enumeration = enumerateParameters(profile, args.declaration, args.source);
  if (enumeration === null) {
    return null;
  }
  const kind = kindFor(profile, args.declaration, enumeration.parameters);
  return arityOfParameters(profile, enumeration.parameters, enumeration.hasRest, args.binding ?? "bound", kind);
}

/**
 * The kind of callable a declaration is. Python decorators separate instance methods, class
 * methods, and static methods; other languages only distinguish receiver-bearing methods from
 * plain functions. Returns null for unknown languages or nodes that declare no callable.
 */
export function getCallableDeclarationKind(args: {
  languageId: string;
  source: string;
  declaration: SyntaxNodeLike;
}): CallableDeclarationKind | null {
  const profile = getCallableArityProfile(args.languageId);
  if (!profile) {
    return null;
  }
  const scopedRule = profile.receiver.scopedFirstParameter;
  if (scopedRule) {
    return scopedKindOf(args.declaration, scopedRule);
  }
  const enumeration = enumerateParameters(profile, args.declaration, args.source);
  if (enumeration === null) {
    return null;
  }
  return kindFor(profile, args.declaration, enumeration.parameters);
}

/**
 * Accepted explicit-argument range from raw parameter-list text: the source-level fallback used
 * when no tree is available. Splitting and classification share the node-path rules so both paths
 * answer the same question the same way.
 */
export function getCallableArityFromParameterText(args: {
  languageId: string;
  parameterText: string;
  binding?: CallableBinding;
}): CallableArity | null {
  const profile = getCallableArityProfile(args.languageId);
  if (!profile) {
    return null;
  }
  const groups = splitTopLevelCommaGroups(
    args.parameterText,
    "type-context",
    profile.signatureCommaScanDetectsRegexLiterals,
  );
  if (!groups) {
    return null;
  }
  const parameters: ParameterFact[] = groups.map((text) => ({
    text,
    nodeType: null,
    slots: parameterSlotCount(profile, null, text),
    forcedOptional: false,
    forcedRest: false,
    forcedZeroSlot: false,
  }));
  return arityOfParameters(profile, parameters, false, args.binding ?? "bound", "function");
}

function hasUncountableSpreadArgument(
  profile: CallableArityLanguageProfile,
  arg: string,
  nodeType: string | null,
): boolean {
  if (nodeType !== null && profile.spreadNodeTypes.includes(nodeType)) {
    return true;
  }
  const trimmed = arg.trim();
  if (trimmed.startsWith("...")) {
    return true;
  }
  return profile.spreadPrefixes.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Explicit argument count of a call, counting trailing closures as arguments where the language
 * treats them that way (Swift, Kotlin). Returns null when an argument spread makes the count
 * unprovable or when the call shape is unknown.
 */
export function getCallArgumentCount(args: {
  languageId: string;
  source: string;
  call: SyntaxNodeLike;
}): number | null {
  const profile = getCallableArityProfile(args.languageId);
  if (!profile) {
    return null;
  }
  const callNode = outermostTrailingClosureCall(args.call, args.source);
  const argumentNode = findArgumentNode(callNode);
  const trailingCount = countTrailingClosureArguments(
    profile,
    findTrailingScope(callNode),
    argumentNode ? argumentNode.endIndex : -1,
  );
  if (argumentNode) {
    const count = countArgumentElements(profile, argumentNode, args.source);
    if (count === null) {
      return null;
    }
    return count + trailingCount;
  }
  if (profile.callsiteParenthesesFallback) {
    const openIndex = findOpeningParen(args.source, callNode.startIndex);
    const balanced = findBalancedParentheses(args.source, openIndex);
    if (!balanced) {
      return null;
    }
    return getCallArgumentCountFromArgumentText({ languageId: args.languageId, argumentText: balanced.inner });
  }
  return trailingCount > 0 ? trailingCount : null;
}

/**
 * Explicit argument count from raw argument-list text: the source-level fallback used when no tree
 * is available. Spread arguments make the count unprovable and return null.
 */
export function getCallArgumentCountFromArgumentText(args: {
  languageId: string;
  argumentText: string;
}): number | null {
  const profile = getCallableArityProfile(args.languageId);
  if (!profile) {
    return null;
  }
  const groups = splitTopLevelCommaGroups(args.argumentText, "type-context");
  if (!groups) {
    return null;
  }
  for (const group of groups) {
    if (hasUncountableSpreadArgument(profile, group, null)) {
      return null;
    }
  }
  return groups.length;
}

function outermostTrailingClosureCall(call: SyntaxNodeLike, source: string): SyntaxNodeLike {
  let callNode = call;
  let parent = callNode.parent;
  while (parent && CALL_NODE_TYPES[parent.type]) {
    const trailingText = source.slice(callNode.endIndex, parent.endIndex).trimStart();
    if (!trailingText.startsWith("{")) {
      break;
    }
    callNode = parent;
    parent = callNode.parent;
  }
  return callNode;
}

function findArgumentNode(callNode: SyntaxNodeLike): SyntaxNodeLike | null {
  const direct = callNode.childForFieldName("arguments") ?? callNode.childForFieldName("args");
  if (direct && direct.type !== "call_suffix") {
    return direct;
  }
  for (const child of callNode.namedChildren ?? []) {
    if (ARGUMENT_LIST_NODE_TYPES[child.type]) {
      return child;
    }
    if (child.type === "call_suffix") {
      return child.childForFieldName("arguments") ?? findNestedArgumentList(child);
    }
  }
  for (const child of callNode.namedChildren ?? []) {
    if (CALL_NODE_TYPES[child.type]) {
      const nested = findArgumentNode(child);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function findNestedArgumentList(node: SyntaxNodeLike): SyntaxNodeLike | null {
  for (const child of node.namedChildren ?? []) {
    if (ARGUMENT_LIST_NODE_TYPES[child.type]) {
      return child;
    }
    const nested = findNestedArgumentList(child);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function findTrailingScope(callNode: SyntaxNodeLike): SyntaxNodeLike {
  for (const child of callNode.namedChildren ?? []) {
    if (child.type === "call_suffix") {
      return child;
    }
  }
  return callNode;
}

function countArgumentElements(
  profile: CallableArityLanguageProfile,
  argumentNode: SyntaxNodeLike,
  source: string,
): number | null {
  let count = 0;
  for (const child of argumentNode.namedChildren ?? []) {
    if (child.type === "comment") {
      continue;
    }
    if (child.type === "ERROR" || child.type === "MISSING") {
      return null;
    }
    if (hasUncountableSpreadArgument(profile, sliceOf(source, child), child.type)) {
      return null;
    }
    count += 1;
  }
  return count;
}

function countTrailingClosureArguments(
  profile: CallableArityLanguageProfile,
  trailingScope: SyntaxNodeLike,
  afterIndex: number,
): number {
  if (!profile.trailingClosureNodeTypes.length) {
    return 0;
  }
  let count = 0;
  for (const child of trailingScope.namedChildren ?? []) {
    if (child.startIndex >= afterIndex && profile.trailingClosureNodeTypes.includes(child.type)) {
      count += 1;
    }
  }
  return count;
}
