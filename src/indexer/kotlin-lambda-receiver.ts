/**
 * Kotlin lambdas with an implicit receiver. A lambda passed where a function type with a receiver is expected
 * (`Builder.() -> Unit`, `x.apply { }`, `with(x) { }`) binds a bare call to a member of that receiver before any member
 * of the enclosing type, so `build { emit() }` calls `Builder.emit` even when the enclosing class declares an `emit`.
 * Receivers nest innermost first. A receiver that lacks the name, or whose member the call cannot reach, hands the
 * lookup to the next one, and finally to the enclosing type.
 *
 * What proves a lambda's receiver, from declarations and syntax, never from inferred expression types:
 * - a callee declared in the project names its parameter's type: a function type with a receiver (through a type alias)
 *   gives that receiver type, any other type gives none; when go-to-definition cannot name one callee (overloads,
 *   `expect`/`actual`, an extension on an implicit receiver), the project declarations of that name that could take the
 *   call decide together, and disagreeing declarations prove nothing;
 * - a callee the project does not declare is a function from the standard library or kotlinx.coroutines when its name
 *   says so: `apply`, `run` and `runCatching` called on a receiver expression, and `with(x)`, run the lambda on the type
 *   of that expression, `launch`, `buildList`, `sequence` and the other builders give a known external receiver whose
 *   names are listed, while `let`, `also`, `forEach`, `map`, SAM constructors such as `Runnable { }` and the other
 *   plain-lambda functions have no receiver;
 * - any other trailing lambda may have a receiver whose members the index does not hold, so a bare call inside it is
 *   unproven. A lambda in parentheses or by name of an unknown callee is read as an ordinary function argument.
 *
 * A receiver whose type is outside the project, or a project type with a supertype outside it that no table knows,
 * cannot rule a name out, so the call stays unproven there too. A nullable receiver (`Builder?.() -> Unit`) is
 * reached only through `?.`, so a bare call does not bind to its members.
 */
import { getCallArgumentCount } from "../languages/callable-arity.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import {
  memberContainerDef,
  nearestMemberContainer,
  receiverConstructorExpression,
} from "../graphs/symbol-graph-detailed/receiver-calls.js";
import { UNPROVEN_KOTLIN_LAMBDA_RECEIVER_REASON } from "./ambiguous-resolution.js";
import { sliceText } from "../util/ast.js";
import { normalizeKotlinIdentifier } from "../util/identifiers.js";
import { fileIdentityKey } from "../util/paths.js";
import { getPackageDeclarationName } from "./compilation-units.js";
import { projectCallablesNamed } from "./kotlin-callable-index.js";
import {
  externalBuilderReceiver,
  externalTypeNames,
  isJdkSamConstructor,
  JDK_EXECUTOR_TYPES,
  resolveExternalType,
  UNIVERSAL_EXTENSION_NAMES,
} from "./kotlin-external-receivers.js";
import { declaredVisibility, lookupReceiverTypeMember, topLevelDeclarationInScope } from "./kotlin-receiver-members.js";
import { kotlinPropertyInvocationArity } from "./member-selection.js";
import { definitionWithoutDeferredSteps, type JvmTypeNameResolver } from "./name-resolution-types.js";
import { declarationReaches, memberAcceptsCallAt, type ReceiverTypeMember } from "./navigation-goto.js";
import { okGoToResult } from "./navigation-provenance.js";
import { findClosestScopeBinding, getOrBuildScopeIndex } from "./navigation-local.js";
import type { ParsedFileContext } from "./parse-context.js";
import { ensureParsedContextForIndex, rethrowStaleQuerySource } from "./parsed-cache.js";
import type { ScopeIndex } from "./scope.js";
import { bindsTypeParameter } from "./type-parameters.js";
import { type GoToResult, type ModuleIndex, type ProjectIndex, type SymbolDef, SymbolKind } from "./types.js";

/** What a lambda literal's implicit receiver is. */
export type LambdaReceiver =
  | { kind: "none" }
  /** An instance of a project class or interface, whose members can be searched. */
  | { kind: "type"; def: SymbolDef; nullable: boolean }
  /** A well-known type outside the project, with the names a bare call may bind to through it. */
  | { kind: "external"; names: ReadonlySet<string> }
  /** A receiver may exist, and its members are not in the index. */
  | { kind: "unproven" };

/** The receivers of the lambdas of one file, by the start index of each lambda. */
export type LambdaReceiverCache = Map<number, Promise<LambdaReceiver>>;

/** What the lambdas around a bare call say about its name. */
export type LambdaReceiverVerdict =
  | { status: "member"; member: SymbolDef }
  /** A receiver that is not indexed may declare the name, which hides a member of the enclosing type. */
  | { status: "unproven" }
  /**
   * A known external receiver declares or extends the name, or a project receiver's property of that name may be
   * invoked through its type, so no other declaration is provably the call's target.
   */
  | { status: "shadowed" }
  | { status: "none" };

/** A file whose names a lookup reads. */
type Site = { mod: ModuleIndex; parsed: ParsedFileContext; scopeIndex: ScopeIndex };

/** What the settling consumer supplies to prove lambda receivers. */
export type LambdaReceiverEnvironment = {
  index: ProjectIndex;
  /** The file holding the call. */
  site: Site;
  /** The definition a callee name resolves to, as go-to-definition resolves it; null when nothing proves one. */
  resolveCallee(callee: SyntaxNodeLike): Promise<SymbolDef | null>;
  resolveTypeName: JvmTypeNameResolver;
  classified: LambdaReceiverCache;
};

const NONE: LambdaReceiver = { kind: "none" };
const UNPROVEN: LambdaReceiver = { kind: "unproven" };
const UNPROVEN_VERDICT: LambdaReceiverVerdict = { status: "unproven" };
const SHADOWED_VERDICT: LambdaReceiverVerdict = { status: "shadowed" };
const NO_VERDICT: LambdaReceiverVerdict = { status: "none" };
const OMITTED_MEMBER: ReceiverTypeMember = { status: "omitted" };

/** What a receiver gives a call: its member, or a property of the name that its type may make callable. */
type CalledMember = ReceiverTypeMember | { status: "maybe-invoked" };
const MAYBE_INVOKED_MEMBER: CalledMember = { status: "maybe-invoked" };

/** A class body ends the lambdas that sit between a call and its enclosing type's members. */
const CLASS_BODY_TYPES: Readonly<Record<string, true>> = { class_body: true, enum_class_body: true };

/** Type syntax that can follow a parameter name. */
const TYPE_NODE_TYPES: Readonly<Record<string, true>> = {
  function_type: true,
  nullable_type: true,
  parenthesized_type: true,
  user_type: true,
};

/** `apply`, `run` and `runCatching` run their lambda on the receiver expression they are called on. */
const STDLIB_RECEIVER_FUNCTIONS: Readonly<Record<string, true>> = { apply: true, run: true, runCatching: true };

/**
 * Standard library functions whose lambda takes no receiver (plus kotlin.test's `assertFails*` and the JDK's
 * `computeIfAbsent` and `removeIf`). Each name is checked against kotlinc 2.4: a bare `toString()` in its lambda still
 * calls the enclosing receiver's, in every overload the check reached. A name missing here is only a missed proof.
 */
const STDLIB_PLAIN_LAMBDA_NAMES = `
  also let takeIf takeUnless use repeat lazy synchronized thread withLock measureNanoTime measureTimeMillis
  measureTime measureTimedValue
  check checkNotNull require requireNotNull assertFails assertFailsWith
  getOrElse getOrPut onSuccess onFailure recover mapKeys mapValues filterKeys filterValues computeIfAbsent
  all any count find first firstOrNull firstNotNullOf firstNotNullOfOrNull last lastOrNull single singleOrNull none
  map mapIndexed mapIndexedTo mapNotNull mapNotNullTo mapTo flatMap flatMapIndexed flatMapTo
  fold foldIndexed foldRight reduce reduceOrNull reduceRight runningFold runningReduce scan sumOf
  forEach forEachIndexed forEachLine useLines onEach onEachIndexed ifBlank ifEmpty joinToString
  filter filterIndexed filterNot filterNotTo filterTo distinctBy partition removeAll removeIf
  takeWhile takeLastWhile dropWhile dropLastWhile indexOfFirst indexOfLast chunked windowed zip zipWithNext
  maxBy maxByOrNull maxOf maxOfOrNull minBy minByOrNull minOf minOfOrNull sortBy sortedBy sortedByDescending
  associate associateBy associateTo associateByTo associateWith associateWithTo groupBy groupByTo
  Array ByteArray CharArray IntArray List MutableList generateSequence usePinned withScopedMemoryAllocator
`;
/**
 * `usePinned` and `withScopedMemoryAllocator` are Kotlin/Native and Kotlin/Wasm functions that take `(T) -> R`, a type
 * with no receiver; the JVM kotlinc cannot run those two. `memScoped` takes `MemScope.() -> R`, an external receiver:
 * unproven. `execute` and `submit` are not here: a JDK executor takes a Java functional interface, but a Gradle
 * `Action` (a SAM with receiver) has the same method names, so a proven executor receiver decides them.
 */
const STDLIB_PLAIN_LAMBDA_FUNCTIONS: Readonly<Record<string, true>> = Object.fromEntries(
  STDLIB_PLAIN_LAMBDA_NAMES.split(/\s+/)
    .filter(Boolean)
    .map((name): [string, true] => [name, true]),
);

/** Parameter types no lambda converts to, so a declaration taking one in the lambda's position is not the callee. */
const VALUE_TYPE_NAMES: Readonly<Record<string, true>> = {
  Boolean: true,
  Byte: true,
  Short: true,
  Int: true,
  Long: true,
  Float: true,
  Double: true,
  Char: true,
  String: true,
  Number: true,
  CharSequence: true,
  Unit: true,
  Nothing: true,
};

/** `execute { }` and `submit { }`, which take a plain lambda only on a JDK executor. */
const EXECUTOR_FUNCTIONS: Readonly<Record<string, true>> = { execute: true, submit: true };

const MAX_ALIAS_DEPTH = 4;
/**
 * More declarations of one name than this, after the argument count rules some out, are not read: the callee stays
 * unproven.
 */
const MAX_CALLEE_CANDIDATES = 40;
const VARARG_MODIFIER = /\bvararg\b/;

/** Where a lambda stands in the call that receives it. */
type ArgumentSlot =
  | { kind: "trailing" }
  | { kind: "positional"; index: number }
  | { kind: "named"; name: string }
  /** A spread or named argument precedes it, so its position does not name a parameter. */
  | { kind: "unplaced" };

type LambdaArgument = {
  /** The callee's name: `build` in `build { }`, `forward` in `delegate?.forward { }`; null for any other callee. */
  callee: SyntaxNodeLike | null;
  /** The expression a member call is made on: `delegate` in `delegate?.forward { }`. */
  receiverExpression: SyntaxNodeLike | null;
  /** The call's parenthesized arguments, absent for `build { }`. */
  argumentList: SyntaxNodeLike | null;
  /** The call the lambda is an argument of; null where the grammar leaves none (`foo<T> { }`). */
  call: SyntaxNodeLike | null;
  slot: ArgumentSlot;
};

type LambdaContext =
  | { kind: "argument"; argument: LambdaArgument }
  /** A property initializer, whose declared type decides the receiver. */
  | { kind: "declared"; type: SyntaxNodeLike }
  /** A position whose expected type cannot be read, such as the misparsed `foo<T> { }`. */
  | { kind: "unproven" }
  /**
   * No expected type is declared: a lambda there has no receiver. That covers a returned value, an assignment's right
   * side, a super-constructor argument, a default value, and every other position without a declared type.
   */
  | { kind: "plain" };

const PLAIN_CONTEXT: LambdaContext = { kind: "plain" };
const UNPROVEN_CONTEXT: LambdaContext = { kind: "unproven" };

/**
 * The lambdas between `node` and the class body (or file) whose members it reaches, innermost first. Their receivers
 * outrank those members; a lambda outside that class body ranks below them.
 */
export function enclosingLambdas(node: SyntaxNodeLike): SyntaxNodeLike[] {
  const lambdas: SyntaxNodeLike[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (CLASS_BODY_TYPES[current.type]) break;
    if (current.type === "lambda_literal") lambdas.push(current);
  }
  return lambdas;
}

function calleeShape(expression: SyntaxNodeLike | undefined): Pick<LambdaArgument, "callee" | "receiverExpression"> {
  if (expression?.type === "identifier") return { callee: expression, receiverExpression: null };
  if (expression?.type === "navigation_expression") {
    const [receiverExpression, callee, ...rest] = expression.namedChildren;
    if (receiverExpression && callee?.type === "identifier" && !rest.length) return { callee, receiverExpression };
  }
  return { callee: null, receiverExpression: null };
}

/** `build { }` and `build(1) { }`: the lambda is the trailing argument of the call around its wrapper. */
function trailingLambdaContext(wrapper: SyntaxNodeLike): LambdaContext {
  const call = wrapper.parent;
  if (call?.type !== "call_expression") return PLAIN_CONTEXT;
  const target = call.namedChildren[0];
  const invocation = target?.type === "call_expression" ? target : null;
  const argumentList = invocation?.namedChildren.find((child) => child.type === "value_arguments") ?? null;
  const shape = calleeShape(invocation ? invocation.namedChildren[0] : target);
  return { kind: "argument", argument: { ...shape, argumentList, call, slot: { kind: "trailing" } } };
}

/** The name of a `name = value` argument. */
function argumentLabel(valueArgument: SyntaxNodeLike): SyntaxNodeLike | null {
  const [first, second] = valueArgument.namedChildren;
  return first?.type === "identifier" && second ? first : null;
}

function placesByPosition(valueArgument: SyntaxNodeLike): boolean {
  const spread = valueArgument.namedChildren.some((child) => child.type === "spread_expression");
  return !spread && !argumentLabel(valueArgument);
}

/** `build(1, { })` and `build(block = { })`. */
function argumentLambdaContext(valueArgument: SyntaxNodeLike): LambdaContext {
  const list = valueArgument.parent;
  const call = list?.parent;
  if (list?.type !== "value_arguments" || call?.type !== "call_expression") return PLAIN_CONTEXT;
  const siblings = list.namedChildren.filter((child) => child.type === "value_argument");
  const position = siblings.findIndex((child) => child.startIndex === valueArgument.startIndex);
  const label = argumentLabel(valueArgument);
  let slot: ArgumentSlot = { kind: "positional", index: position };
  if (label) slot = { kind: "named", name: normalizeKotlinIdentifier(label.text) };
  else if (position < 0 || !siblings.slice(0, position).every(placesByPosition)) slot = { kind: "unplaced" };
  return { kind: "argument", argument: { ...calleeShape(call.namedChildren[0]), argumentList: list, call, slot } };
}

/** `val block: Builder.() -> Unit = { }`. */
function propertyLambdaContext(property: SyntaxNodeLike): LambdaContext {
  const declaration = property.namedChildren.find((child) => child.type === "variable_declaration");
  const type = declaration?.namedChildren[1];
  return type ? { kind: "declared", type } : PLAIN_CONTEXT;
}
/**
 * The grammar reads `foo<T> { }`, a generic call whose only argument is its trailing lambda, as the comparisons
 * `(foo < T) > { }`. Any other operand position is a lambda whose expected type cannot be read.
 */
function comparisonLambdaContext(lambda: SyntaxNodeLike, comparison: SyntaxNodeLike): LambdaContext {
  const closing = comparison.childForFieldName("operator");
  const opening = comparison.childForFieldName("left");
  if (closing?.type !== ">" || comparison.childForFieldName("right")?.startIndex !== lambda.startIndex) {
    return UNPROVEN_CONTEXT;
  }
  if (opening?.type !== "binary_expression" || opening.childForFieldName("operator")?.type !== "<") {
    return UNPROVEN_CONTEXT;
  }
  const shape = calleeShape(opening.childForFieldName("left") ?? undefined);
  return { kind: "argument", argument: { ...shape, argumentList: null, call: null, slot: { kind: "trailing" } } };
}

function lambdaContext(lambda: SyntaxNodeLike): LambdaContext {
  const parent = lambda.parent;
  if (!parent) return PLAIN_CONTEXT;
  if (parent.type === "annotated_lambda") return trailingLambdaContext(parent);
  if (parent.type === "value_argument") return argumentLambdaContext(parent);
  if (parent.type === "property_declaration") return propertyLambdaContext(parent);
  if (parent.type === "binary_expression") return comparisonLambdaContext(lambda, parent);
  return PLAIN_CONTEXT;
}

/** The node that names a type in a lookup: the identifier of a plain `Builder`, the whole of a qualified `p.Builder`. */
function typeNameNode(type: SyntaxNodeLike): SyntaxNodeLike {
  const [only, ...others] = type.namedChildren.filter((child) => child.type === "identifier");
  return only && !others.length ? only : type;
}

/** The type inside any nullability and parentheses, and whether a `?` wrapped it. */
function peelType(type: SyntaxNodeLike): { type: SyntaxNodeLike; nullable: boolean } {
  let current = type;
  let nullable = false;
  while (current.type === "nullable_type" || current.type === "parenthesized_type") {
    nullable = nullable || current.type === "nullable_type";
    const inner = current.namedChildren.find((child) => child.type !== "type_modifiers");
    if (!inner) break;
    current = inner;
  }
  return { type: current, nullable };
}

/** The receiver of a function type: `Builder` in `Builder.() -> Unit`, null for `(Builder) -> Unit`. */
function functionTypeReceiver(functionType: SyntaxNodeLike): SyntaxNodeLike | null {
  const first = functionType.namedChildren.find((child) => child.type !== "type_modifiers");
  return first && first.type !== "function_type_parameters" ? first : null;
}

function isNominalType(def: SymbolDef): boolean {
  return (def.kind === SymbolKind.Class || def.kind === SymbolKind.Interface) && !def.typeParameter;
}

async function resolveType(
  env: LambdaReceiverEnvironment,
  site: Site,
  node: SyntaxNodeLike,
): Promise<SymbolDef | null> {
  return definitionWithoutDeferredSteps(
    await env.resolveTypeName(env.index, site.mod, site.parsed, site.scopeIndex, node),
  );
}

/** The declaration a definition names, with the file it is read in; null when that file cannot be read. */
async function declarationOf(
  index: ProjectIndex,
  def: SymbolDef,
): Promise<{ node: SyntaxNodeLike; site: Site } | null> {
  const start = def.range.start.index;
  const mod = index.byFile.get(fileIdentityKey(def.file));
  if (start === undefined || !mod) return null;
  try {
    const parsed = await ensureParsedContextForIndex(index, def.file);
    const node = parsed.tree.rootNode.descendantForIndex(start, start).parent;
    if (!node) return null;
    const scopeIndex = getOrBuildScopeIndex(index, def.file, parsed.source, parsed.sup, mod, parsed.tree);
    return { node, site: { mod, parsed, scopeIndex } };
  } catch (error) {
    rethrowStaleQuerySource(error);
    return null;
  }
}

/** The target of a type alias, through the aliases it names. */
async function aliasTarget(
  env: LambdaReceiverEnvironment,
  alias: SymbolDef,
): Promise<{ type: SyntaxNodeLike; site: Site } | null> {
  const declaration = await declarationOf(env.index, alias);
  if (declaration?.node.type !== "type_alias") return null;
  const type = declaration.node.namedChildren.find((child) => TYPE_NODE_TYPES[child.type]);
  return type ? { type, site: declaration.site } : null;
}

/** A receiver type outside the project that a table lists, else unproven. */
function externalReceiver(site: Site, type: SyntaxNodeLike): LambdaReceiver {
  const fqn = resolveExternalType(site.mod, type.text);
  const names = fqn ? externalTypeNames(fqn) : undefined;
  return names ? { kind: "external", names } : UNPROVEN;
}

/** The receiver an instance of the type `node` is, as declared in `site`. */
async function receiverOfType(
  env: LambdaReceiverEnvironment,
  site: Site,
  node: SyntaxNodeLike,
): Promise<LambdaReceiver> {
  const { type, nullable } = peelType(node);
  if (type.type !== "user_type") return UNPROVEN;
  const def = await resolveType(env, site, typeNameNode(type));
  if (def) return isNominalType(def) ? { kind: "type", def, nullable } : UNPROVEN;
  // A nullable external receiver is reached only through `?.`, which no table models.
  return nullable ? UNPROVEN : externalReceiver(site, type);
}

async function receiverOfFunctionType(
  env: LambdaReceiverEnvironment,
  site: Site,
  functionType: SyntaxNodeLike,
): Promise<LambdaReceiver> {
  const receiver = functionTypeReceiver(functionType);
  return receiver ? receiverOfType(env, site, receiver) : NONE;
}

/** `fun interface` declares a SAM whose lambda has no receiver; the grammar leaves the two keywords unnamed. */
function isFunInterface(declaration: SyntaxNodeLike): boolean {
  let sawFun = false;
  for (let index = 0; ; index += 1) {
    const child = declaration.child(index);
    if (!child || child.type === "identifier") return false;
    if (child.type === "fun") sawFun = true;
    else if (child.type === "interface") return sawFun;
  }
}

/** The receiver of a lambda converted to the `fun interface` `declaration`: none, unless an annotation may add one. */
function funInterfaceReceiver(declaration: SyntaxNodeLike): LambdaReceiver {
  const modifiers = declaration.namedChildren.find((child) => child.type === "modifiers");
  return modifiers?.namedChildren.some((modifier) => modifier.type === "annotation") ? UNPROVEN : NONE;
}

/** A lambda passed as a project class or interface: only a `fun interface` takes one. */
async function receiverOfProjectType(env: LambdaReceiverEnvironment, def: SymbolDef): Promise<LambdaReceiver | null> {
  const declaration = await declarationOf(env.index, def);
  if (declaration?.site.parsed.sup.id !== "kotlin" || declaration.node.type !== "class_declaration") return NONE;
  return isFunInterface(declaration.node) ? funInterfaceReceiver(declaration.node) : null;
}

/**
 * A lambda passed as a type outside the project. A value type takes no lambda. Gradle's `Action` is a SAM with a
 * receiver wherever the Kotlin DSL applies, so it is unproven. Anything else converts to a Java interface or takes
 * the lambda as is: no receiver.
 */
function receiverOfExternalParameterType(type: SyntaxNodeLike): LambdaReceiver | null {
  const name = normalizeKotlinIdentifier((type.text.split("<")[0] ?? "").split(".").pop() ?? "");
  if (Object.hasOwn(VALUE_TYPE_NAMES, name)) return null;
  return name === "Action" ? UNPROVEN : NONE;
}

/**
 * The receiver of a lambda whose expected type is `type`, as declared in `site`; null when no lambda converts to that
 * type, so a declaration with such a parameter is not the callee.
 */
async function receiverOfDeclaredType(
  env: LambdaReceiverEnvironment,
  site: Site,
  type: SyntaxNodeLike,
  depth = 0,
): Promise<LambdaReceiver | null> {
  const { type: peeled } = peelType(type);
  if (peeled.type === "function_type") return receiverOfFunctionType(env, site, peeled);
  // A lambda converted to an interface or any other type has no receiver. Only an alias can hide a function type.
  if (peeled.type !== "user_type") return NONE;
  const def = await resolveType(env, site, typeNameNode(peeled));
  if (!def) return receiverOfExternalParameterType(peeled);
  if (def.typeParameter) return NONE;
  if (def.kind !== SymbolKind.TypeAlias) return receiverOfProjectType(env, def);
  const target = depth < MAX_ALIAS_DEPTH ? await aliasTarget(env, def) : null;
  return target ? receiverOfDeclaredType(env, target.site, target.type, depth + 1) : UNPROVEN;
}

type ParameterEntry = { name: string; type: SyntaxNodeLike | null; variadic: boolean };

/** The parameters of one parameter list, with the `vararg` modifier that precedes each. */
function parameterEntries(list: SyntaxNodeLike): ParameterEntry[] {
  const entries: ParameterEntry[] = [];
  let variadic = false;
  for (const child of list.namedChildren) {
    if (child.type === "parameter_modifiers") {
      variadic = variadic || VARARG_MODIFIER.test(child.text);
      continue;
    }
    if (child.type !== "parameter" && child.type !== "class_parameter") continue;
    const name = child.namedChildren.find((part) => part.type === "identifier");
    const modifiers = child.namedChildren.find((part) => part.type === "parameter_modifiers");
    entries.push({
      name: name ? normalizeKotlinIdentifier(name.text) : "",
      type: child.namedChildren.find((part) => TYPE_NODE_TYPES[part.type]) ?? null,
      variadic: variadic || (!!modifiers && VARARG_MODIFIER.test(modifiers.text)),
    });
    variadic = false;
  }
  return entries;
}

/** The parameter a lambda in `slot` is passed to: null when the list has none there, "unplaced" when position cannot say. */
function parameterAtSlot(entries: readonly ParameterEntry[], slot: ArgumentSlot): ParameterEntry | null | "unplaced" {
  if (slot.kind === "unplaced") return "unplaced";
  if (slot.kind === "named") return entries.find((entry) => entry.name === slot.name) ?? null;
  if (slot.kind === "trailing") {
    const last = entries[entries.length - 1];
    return last?.variadic ? "unplaced" : (last ?? null);
  }
  if (entries.slice(0, slot.index).some((entry) => entry.variadic)) return "unplaced";
  return entries[slot.index] ?? null;
}

/**
 * The receiver of a lambda passed to the parameter of `list` that `slot` names; null when the list has no such
 * parameter, or its type takes no lambda.
 */
async function receiverOfParameterList(
  env: LambdaReceiverEnvironment,
  site: Site,
  list: SyntaxNodeLike,
  slot: ArgumentSlot,
): Promise<LambdaReceiver | null> {
  const parameter = parameterAtSlot(parameterEntries(list), slot);
  if (parameter === "unplaced") return UNPROVEN;
  if (!parameter) return null;
  return parameter.type ? receiverOfDeclaredType(env, site, parameter.type) : UNPROVEN;
}

/** Every constructor's parameter list: the primary one and each secondary one. */
function constructorParameterLists(classNode: SyntaxNodeLike): SyntaxNodeLike[] {
  const lists: SyntaxNodeLike[] = [];
  const primary = classNode.namedChildren.find((child) => child.type === "primary_constructor");
  const primaryList = primary?.namedChildren.find((child) => child.type === "class_parameters");
  if (primaryList) lists.push(primaryList);
  const body = classNode.namedChildren.find((child) => child.type === "class_body");
  for (const member of body?.namedChildren ?? []) {
    if (member.type !== "secondary_constructor") continue;
    const list = member.namedChildren.find((child) => child.type === "function_value_parameters");
    if (list) lists.push(list);
  }
  return lists;
}

function sameDefinition(left: SymbolDef, right: SymbolDef): boolean {
  return (
    fileIdentityKey(left.file) === fileIdentityKey(right.file) && left.range.start.index === right.range.start.index
  );
}

function sameReceiver(left: LambdaReceiver, right: LambdaReceiver): boolean {
  if (left.kind === "type" && right.kind === "type") {
    return left.nullable === right.nullable && sameDefinition(left.def, right.def);
  }
  if (left.kind === "external" && right.kind === "external") return left.names === right.names;
  return left.kind === "none" && right.kind === "none";
}

/** Declarations that all give a lambda the same receiver decide together; any other mix proves nothing. */
function agreedReceiver(outcomes: readonly LambdaReceiver[]): LambdaReceiver {
  const [first, ...rest] = outcomes;
  if (!first) return UNPROVEN;
  return rest.every((outcome) => sameReceiver(first, outcome)) ? first : UNPROVEN;
}

/** Constructors that take a lambda in `slot` agree on its receiver, or the call names none of them. */
async function receiverOfConstructors(
  env: LambdaReceiverEnvironment,
  site: Site,
  classNode: SyntaxNodeLike,
  slot: ArgumentSlot,
): Promise<LambdaReceiver | null> {
  const outcomes: LambdaReceiver[] = [];
  for (const list of constructorParameterLists(classNode)) {
    const outcome = await receiverOfParameterList(env, site, list, slot);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes.length ? agreedReceiver(outcomes) : null;
}

/** The receiver of the lambda in `slot` of a call to the function or class `declaration`; null when it takes none there. */
async function receiverOfDeclaration(
  env: LambdaReceiverEnvironment,
  declaration: { node: SyntaxNodeLike; site: Site },
  slot: ArgumentSlot,
): Promise<LambdaReceiver | null> {
  const { node, site } = declaration;
  if (node.type === "class_declaration") {
    // `Handler { }` on a `fun interface` is its SAM constructor.
    if (isFunInterface(node)) return funInterfaceReceiver(node);
    return receiverOfConstructors(env, site, node, slot);
  }
  if (node.type !== "function_declaration") return UNPROVEN;
  const list = node.namedChildren.find((child) => child.type === "function_value_parameters");
  return list ? receiverOfParameterList(env, site, list, slot) : null;
}

/** Whether a call with `argumentCount` arguments can be made to `def`: unknown counts and arities accept. */
function acceptsArgumentCount(def: SymbolDef, argumentCount: number | undefined): boolean {
  const arity = def.callable?.arity;
  if (argumentCount === undefined || !arity) return true;
  return argumentCount >= arity.minArgs && (arity.maxArgs === null || argumentCount <= arity.maxArgs);
}

/**
 * Whether the call can name the declaration `node` from where it stands, so an unrelated same-named declaration
 * elsewhere in the project (another package, another class) does not outvote the library function the call means. A
 * member is reached on any receiver expression, through a class body around the call, or through a class the
 * enclosing classes derive from; a top-level function, through this file, its package, or an import, and with an
 * explicit receiver only when it is an extension.
 */
async function declarationInScope(
  env: LambdaReceiverEnvironment,
  argument: LambdaArgument,
  def: SymbolDef,
  node: SyntaxNodeLike,
): Promise<boolean> {
  const { index, site } = env;
  const sameFile = fileIdentityKey(def.file) === fileIdentityKey(site.mod.file);
  const body = node.parent;
  if (body && CLASS_BODY_TYPES[body.type]) {
    const use = argument.callee ?? argument.call;
    if (argument.receiverExpression || !use) return true;
    if (sameFile && body.startIndex <= use.startIndex && use.endIndex <= body.endIndex) return true;
    const container = nearestMemberContainer(node);
    if (!container) return false;
    for (let using = nearestMemberContainer(use); using; using = nearestMemberContainer(using)) {
      const usingDef = memberContainerDef(site.mod, using);
      if (!usingDef) return true;
      const reaches = await declarationReaches(index, usingDef, {
        file: def.file,
        containerStart: container.startIndex,
      });
      if (reaches !== "no") return true;
    }
    return false;
  }
  if (body?.type !== "source_file") return sameFile;
  if (argument.receiverExpression && !extensionReceiverType(node)) return false;
  return sameFile || topLevelDeclarationInScope(index, site.mod, def);
}

/** Whether two declarations of one name are overloads of each other: declared in one body, or top-level in one package. */
function sameOverloadGroup(
  index: ProjectIndex,
  resolved: { def: SymbolDef; node: SyntaxNodeLike },
  def: SymbolDef,
  node: SyntaxNodeLike,
): boolean {
  const resolvedBody = resolved.node.parent;
  const body = node.parent;
  if (!resolvedBody || !body) return false;
  const sameFile = fileIdentityKey(resolved.def.file) === fileIdentityKey(def.file);
  if (sameFile && resolvedBody.startIndex === body.startIndex) return true;
  if (resolvedBody.type !== "source_file" || body.type !== "source_file") return false;
  return (
    getPackageDeclarationName(index, resolved.def.file, "kotlin") ===
    getPackageDeclarationName(index, def.file, "kotlin")
  );
}

/**
 * The receivers that each project declaration of the callee's name gives the lambda, when go-to-definition cannot
 * name one callee, or names one overload of a group (`overloadOf`). A declaration that cannot take this call is left
 * out: one that rejects the argument count, one the call cannot reach or see (another package, a private one of
 * another file) or, for a named overload, that is not in its group, one with no lambda parameter in the lambda's place.
 */
async function candidateReceivers(
  env: LambdaReceiverEnvironment,
  argument: LambdaArgument,
  name: string,
  overloadOf?: { def: SymbolDef; node: SyntaxNodeLike },
): Promise<LambdaReceiver[]> {
  const { source, sup } = env.site.parsed;
  const argumentCount = argument.call
    ? (getCallArgumentCount({ languageId: sup.id, source, call: argument.call }) ?? undefined)
    : undefined;
  const defs = projectCallablesNamed(env.index, name).filter((def) => acceptsArgumentCount(def, argumentCount));
  if (defs.length > MAX_CALLEE_CANDIDATES) return [UNPROVEN];
  const outcomes: LambdaReceiver[] = [];
  for (const def of defs) {
    const declaration = await declarationOf(env.index, def);
    if (!declaration) {
      outcomes.push(UNPROVEN);
      continue;
    }
    const otherFile = fileIdentityKey(def.file) !== fileIdentityKey(env.site.mod.file);
    if (otherFile && declaredVisibility(declaration.node) === "private") continue;
    if (overloadOf && !sameOverloadGroup(env.index, overloadOf, def, declaration.node)) continue;
    if (!overloadOf && !(await declarationInScope(env, argument, def, declaration.node))) continue;
    const outcome = await receiverOfDeclaration(env, declaration, argument.slot);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}

/** The type of an expression a lambda runs on, when a declaration or constructor call proves it. */
async function receiverOfExpression(
  env: LambdaReceiverEnvironment,
  expression: SyntaxNodeLike,
): Promise<LambdaReceiver> {
  // Inside a lambda, `this` is whichever receiver is closest, and the enclosing lambdas already supply those.
  if (expression.type === "this_expression") return expression.namedChildren.length ? UNPROVEN : NONE;
  const { parsed } = env.site;
  const evidence = receiverConstructorExpression(expression, parsed.source, parsed.sup);
  if (!evidence) return UNPROVEN;
  if (bindsTypeParameter(sliceText(evidence, parsed.source), evidence, parsed.source, parsed.sup)) return UNPROVEN;
  const def = await resolveType(env, env.site, evidence);
  return def && isNominalType(def) ? { kind: "type", def, nullable: false } : UNPROVEN;
}

/** The expression `with` runs its lambda on: its first argument. */
function withSubject(argument: LambdaArgument): SyntaxNodeLike | null {
  const { argumentList, slot } = argument;
  if (slot.kind !== "trailing" && !(slot.kind === "positional" && slot.index === 1)) return null;
  const first = argumentList?.namedChildren.find((child) => child.type === "value_argument");
  return first?.namedChildren[first.namedChildren.length - 1] ?? null;
}

/** The `java.util.concurrent.Executors` factories that return an executor. */
const EXECUTOR_FACTORY = /^new[A-Za-z]*(?:Pool|Executor)$/;

/** `Executors.newFixedThreadPool(4)`: a call of a JDK `Executors` factory that returns an executor. */
function isExecutorsFactoryCall(mod: ModuleIndex, expression: SyntaxNodeLike): boolean {
  if (expression.type !== "call_expression") return false;
  const callee = expression.namedChildren[0];
  const [qualifier, factory] = callee?.type === "navigation_expression" ? callee.namedChildren : [];
  if (!qualifier || factory?.type !== "identifier" || !EXECUTOR_FACTORY.test(factory.text)) return false;
  return !!resolveExternalType(mod, qualifier.text, ["java.util.concurrent.Executors"]);
}

/**
 * Whether the receiver expression of `execute { }` or `submit { }` is a JDK executor: declared or constructed as one,
 * made by an `Executors` factory, or a property or local that an `Executors` factory initializes.
 */
function isJdkExecutor(env: LambdaReceiverEnvironment, expression: SyntaxNodeLike): boolean {
  const { parsed, mod, scopeIndex } = env.site;
  const evidence = receiverConstructorExpression(expression, parsed.source, parsed.sup);
  if (evidence) return !!resolveExternalType(mod, sliceText(evidence, parsed.source), JDK_EXECUTOR_TYPES);
  if (isExecutorsFactoryCall(mod, expression)) return true;
  if (expression.type !== "identifier") return false;
  const binding = findClosestScopeBinding(scopeIndex, expression.text, expression, parsed.sup);
  const declaration = binding?.kind === "local" ? binding.node?.parent?.parent : null;
  const initializer = declaration?.type === "property_declaration" ? declaration.namedChildren.at(-1) : null;
  return !!initializer && isExecutorsFactoryCall(mod, initializer);
}

/** A callee the project does not declare: the library function its name says, or null for any other name. */
async function receiverOfLibraryFunction(
  env: LambdaReceiverEnvironment,
  argument: LambdaArgument,
  name: string,
): Promise<LambdaReceiver | null> {
  const { receiverExpression, slot } = argument;
  if (Object.hasOwn(STDLIB_RECEIVER_FUNCTIONS, name)) {
    // A bare `apply { }` or `run { }` runs on the enclosing `this`, which the lookup already tries.
    if (!receiverExpression) return NONE;
    return slot.kind === "trailing" ? receiverOfExpression(env, receiverExpression) : UNPROVEN;
  }
  if (name === "with" && !receiverExpression) {
    const subject = withSubject(argument);
    return subject ? receiverOfExpression(env, subject) : UNPROVEN;
  }
  if (slot.kind === "trailing") {
    const builder = externalBuilderReceiver(env.site.mod, name);
    const names = builder ? externalTypeNames(builder) : undefined;
    if (names) return { kind: "external", names };
    if (isJdkSamConstructor(env.site.mod, name, receiverExpression?.text)) return NONE;
  }
  if (Object.hasOwn(EXECUTOR_FUNCTIONS, name)) {
    return receiverExpression && isJdkExecutor(env, receiverExpression) ? NONE : null;
  }
  return Object.hasOwn(STDLIB_PLAIN_LAMBDA_FUNCTIONS, name) ? NONE : null;
}

async function receiverOfArgument(env: LambdaReceiverEnvironment, argument: LambdaArgument): Promise<LambdaReceiver> {
  const { callee, slot } = argument;
  // An unknown callee's trailing lambda is a builder lambda as often as not; one in parentheses is a callback.
  const unknownCallee = slot.kind === "trailing" ? UNPROVEN : NONE;
  if (!callee) return unknownCallee;
  const name = normalizeKotlinIdentifier(sliceText(callee, env.site.parsed.source));
  // A callee the project declares nowhere is a library function, so resolving it as a project name would find nothing.
  const declared = projectCallablesNamed(env.index, name);
  const def = declared.length ? await env.resolveCallee(callee) : null;
  if (def && (def.kind === SymbolKind.Function || def.kind === SymbolKind.Class)) {
    // Go-to-definition names one declaration of an overload group by name and arity alone, so the group decides.
    const declaration = await declarationOf(env.index, def);
    if (declaration && !argument.receiverExpression && declared.length > 1) {
      const group = await candidateReceivers(env, argument, name, { def, node: declaration.node });
      if (group.length) return agreedReceiver(group);
    }
    const own = declaration ? await receiverOfDeclaration(env, declaration, slot) : null;
    if (own) return own;
    // The declaration go-to-definition named takes no lambda there, so the callee is another declaration in scope.
    const others = declared.length > 1 ? await candidateReceivers(env, argument, name) : [];
    return others.length ? agreedReceiver(others) : UNPROVEN;
  }
  // The name may be a project declaration go-to-definition could not choose among, or a library function: both count.
  const outcomes = await candidateReceivers(env, argument, name);
  const library = await receiverOfLibraryFunction(env, argument, name);
  if (library) outcomes.push(library);
  return outcomes.length ? agreedReceiver(outcomes) : unknownCallee;
}

async function classifyLambda(env: LambdaReceiverEnvironment, lambda: SyntaxNodeLike): Promise<LambdaReceiver> {
  const context = lambdaContext(lambda);
  if (context.kind === "argument") return receiverOfArgument(env, context.argument);
  if (context.kind === "declared") return (await receiverOfDeclaredType(env, env.site, context.type)) ?? NONE;
  return context.kind === "unproven" ? UNPROVEN : NONE;
}

function receiverOfLambda(env: LambdaReceiverEnvironment, lambda: SyntaxNodeLike): Promise<LambdaReceiver> {
  let receiver = env.classified.get(lambda.startIndex);
  if (!receiver) {
    receiver = classifyLambda(env, lambda);
    env.classified.set(lambda.startIndex, receiver);
  }
  return receiver;
}

/** How a call can reach a property: through a function it holds, through an `invoke` its type may declare, or not. */
type PropertyInvocation = "invokable" | "plain" | "unproven";

const LITERAL_NODE_TYPES: Readonly<Record<string, true>> = {
  number_literal: true,
  float_literal: true,
  string_literal: true,
  character_literal: true,
};

/** `val size = 5` or `= true`: a literal initializer proves a value type without typing any expression. */
function isLiteralInitializer(node: SyntaxNodeLike): boolean {
  if (LITERAL_NODE_TYPES[node.type]) return true;
  return node.type === "identifier" && (node.text === "true" || node.text === "false");
}

/**
 * A member extension `operator fun Int.invoke(tag: String)` in the receiver's own class outranks the enclosing
 * type's function for a call of its plain `val size: Int`, so no property is provably plain while the project declares
 * one. A top-level extension ranks below the members of every implicit receiver and does not.
 */
async function projectDeclaresMemberInvokeExtension(env: LambdaReceiverEnvironment): Promise<boolean> {
  for (const def of projectCallablesNamed(env.index, "invoke")) {
    if (def.kind !== SymbolKind.Function) continue;
    const declaration = await declarationOf(env.index, def);
    if (!declaration) return true;
    const { node } = declaration;
    const inClassBody = !!node.parent && !!CLASS_BODY_TYPES[node.parent.type];
    if (inClassBody && extensionReceiverType(node)) return true;
  }
  return false;
}

/** Whether `type` is a Kotlin value type (`Int`, `String`) that no import or project declaration renames. */
async function isPlainValueType(env: LambdaReceiverEnvironment, site: Site, type: SyntaxNodeLike): Promise<boolean> {
  const { type: peeled } = peelType(type);
  if (peeled.type !== "user_type") return false;
  const spelled = peeled.text.replace(/\s+/g, "");
  const name = normalizeKotlinIdentifier(spelled.startsWith("kotlin.") ? spelled.slice("kotlin.".length) : spelled);
  if (!Object.hasOwn(VALUE_TYPE_NAMES, name)) return false;
  const imported = site.mod.imports.some(
    (imp) => imp.kind === "named" && normalizeKotlinIdentifier(imp.local) === name,
  );
  return !imported && !(await resolveType(env, site, typeNameNode(peeled)));
}

/** Whether the property declaration spells a function type, a lambda, or a callable reference a call can invoke. */
function holdsFunction(declaration: SyntaxNodeLike, type: SyntaxNodeLike | null): boolean {
  if (declaration.type === "class_parameter") return type?.type === "function_type";
  const name = declaration.namedChildren.find((child) => child.type === "identifier");
  return !!name && kotlinPropertyInvocationArity(name) !== undefined;
}

/** Whether the property declaration proves a value type: a declared `Int` or `String`, or a literal initializer. */
async function holdsValueType(
  env: LambdaReceiverEnvironment,
  declaration: { node: SyntaxNodeLike; site: Site },
  type: SyntaxNodeLike | null,
): Promise<boolean> {
  if (type) return isPlainValueType(env, declaration.site, type);
  const property = declaration.node.parent;
  return declaration.node.type === "variable_declaration" && !!property?.namedChildren.some(isLiteralInitializer);
}

/**
 * What a call can mean for the member `def`. A property that holds a function (a function type, a lambda, a callable
 * reference) is invoked. One that holds a value type (`val size: Int`) has no `invoke`, so the call passes it by. A
 * property of any other type may declare `invoke`: an alias of a function type, a class with the operator, a type the
 * index does not hold. A function, class, or object is called as written.
 */
async function propertyInvocation(env: LambdaReceiverEnvironment, def: SymbolDef): Promise<PropertyInvocation> {
  if (def.callable) return "invokable";
  const declaration = await declarationOf(env.index, def);
  if (!declaration) return "unproven";
  const { node } = declaration;
  if (node.type !== "variable_declaration" && node.type !== "class_parameter") return "invokable";
  const type = node.namedChildren.find((child) => TYPE_NODE_TYPES[child.type]) ?? null;
  if (holdsFunction(node, type)) return "invokable";
  const plain = (await holdsValueType(env, declaration, type)) && !(await projectDeclaresMemberInvokeExtension(env));
  return plain ? "plain" : "unproven";
}

/**
 * `lookupReceiverTypeMember` for a call. A property answers it only when a call can invoke it. A plain one is no
 * candidate, so the lookup passes to the next receiver and the enclosing type, as kotlinc does. One whose type may
 * declare `invoke` may answer it, which leaves the call unproven and no other declaration provably its target.
 */
async function lookupCalledMember(
  env: LambdaReceiverEnvironment,
  use: SyntaxNodeLike,
  receiver: SymbolDef,
  name: string,
  argumentCount: number | undefined,
): Promise<CalledMember> {
  const found = await lookupReceiverTypeMember(env.index, env.site.mod, use, receiver, name, argumentCount, "call");
  if (found.status !== "member") return found;
  const invocation = await propertyInvocation(env, found.member);
  if (invocation === "invokable") return found;
  return invocation === "plain" ? OMITTED_MEMBER : MAYBE_INVOKED_MEMBER;
}

/**
 * What a project-typed receiver says about the bare call `use`: its member when the call can reach one, `unproven`
 * when the lookup cannot tell, `shadowed` when a property of the name may be invoked through its type, and null when
 * the receiver is passed over. A nullable receiver's members need `?.`, so its members never answer a bare call. An
 * extension on every receiver (`run`, `let`, `toString`) answers before a member of the enclosing type, unless the
 * receiver declares the name itself.
 */
async function typedReceiverVerdict(
  env: LambdaReceiverEnvironment,
  use: { node: SyntaxNodeLike; name: string },
  receiver: { def: SymbolDef; nullable: boolean },
): Promise<LambdaReceiverVerdict | null> {
  const { parsed } = env.site;
  const call = use.node.parent ?? use.node;
  const argumentCount = getCallArgumentCount({ languageId: "kotlin", source: parsed.source, call }) ?? undefined;
  const found = await lookupCalledMember(env, use.node, receiver.def, use.name, argumentCount);
  if (found.status === "unproven") return UNPROVEN_VERDICT;
  if (found.status === "maybe-invoked" && !receiver.nullable) return SHADOWED_VERDICT;
  // A receiver whose only declaration of the name takes another argument count is no candidate; the next receiver is tried.
  if (
    found.status === "member" &&
    !receiver.nullable &&
    memberAcceptsCallAt(env.index, found.member, use.node, parsed.source, "kotlin")
  ) {
    return { status: "member", member: found.member };
  }
  return UNIVERSAL_EXTENSION_NAMES.has(normalizeKotlinIdentifier(use.name)) ? UNPROVEN_VERDICT : null;
}

/**
 * What the lambdas between the bare call `use` and its class body say about `name`: a member of the closest receiver
 * that declares it, `unproven` when a receiver that may declare it cannot be searched, `shadowed` when a known
 * external receiver declares or extends it or a receiver's property of that name may be invoked through its type, or
 * `none` when no receiver claims it and the enclosing type decides. `lambdas` are the lambdas around the call when the
 * caller already walked them.
 */
export async function kotlinLambdaReceiverVerdict(
  env: LambdaReceiverEnvironment,
  use: { node: SyntaxNodeLike; name: string; lambdas?: readonly SyntaxNodeLike[] },
): Promise<LambdaReceiverVerdict> {
  const name = normalizeKotlinIdentifier(use.name);
  for (const lambda of use.lambdas ?? enclosingLambdas(use.node)) {
    const receiver = await receiverOfLambda(env, lambda);
    if (receiver.kind === "none") continue;
    if (receiver.kind === "unproven") return UNPROVEN_VERDICT;
    if (receiver.kind === "external") {
      if (receiver.names.has(name)) return SHADOWED_VERDICT;
      continue;
    }
    const verdict = await typedReceiverVerdict(env, use, receiver);
    if (verdict) return verdict;
  }
  return NO_VERDICT;
}

/** A Kotlin `this` that may not be the enclosing type's: inside a lambda that may have a receiver, or labeled. */
export function kotlinThisNeedsScopeProof(node: SyntaxNodeLike): boolean {
  return node.type === "this_expression" && (!!node.namedChildren.length || !!enclosingLambdas(node).length);
}

const NO_MEMBER_REASON = "No matching receiver member definition";

/** Whether `lambda` is the one `this@label` names: by its explicit label, else by the callee it is passed to. */
function lambdaIsLabeled(lambda: SyntaxNodeLike, label: string): boolean {
  const explicit = lambda.parent?.namedChildren.find((child) => child.type === "label");
  if (explicit) return normalizeKotlinIdentifier(explicit.text.replace(/@$/, "")) === label;
  const context = lambdaContext(lambda);
  const callee = context.kind === "argument" ? context.argument.callee : null;
  return !!callee && normalizeKotlinIdentifier(callee.text) === label;
}

/** What a plain `this` is: the closest lambda that has a receiver, or `enclosing` when none of the lambdas does. */
async function innermostReceiver(
  env: LambdaReceiverEnvironment,
  access: SyntaxNodeLike,
): Promise<LambdaReceiver | "enclosing"> {
  for (const lambda of enclosingLambdas(access)) {
    const receiver = await receiverOfLambda(env, lambda);
    if (receiver.kind !== "none") return receiver;
  }
  return "enclosing";
}

/** The type before the name of an extension function declaration: `Builder` in `fun Builder.configure() { }`. */
function extensionReceiverType(declaration: SyntaxNodeLike): SyntaxNodeLike | null {
  if (declaration.type !== "function_declaration") return null;
  const name = declaration.childForFieldName("name");
  if (!name) return null;
  const type = declaration.namedChildren.find(
    (child) => child.startIndex < name.startIndex && (child.type === "user_type" || child.type === "nullable_type"),
  );
  return type ?? null;
}

/**
 * The receiver of the extension function `this@label` names, from the type its declaration spells before the name:
 * `fun Builder.configure() { this@configure.emit() }`. A function of that name that declares no receiver names none.
 */
async function extensionFunctionReceiver(
  env: LambdaReceiverEnvironment,
  access: SyntaxNodeLike,
  label: string,
): Promise<LambdaReceiver | null> {
  for (let current = access.parent; current; current = current.parent) {
    if (current.type !== "function_declaration") continue;
    const name = current.childForFieldName("name");
    if (!name || normalizeKotlinIdentifier(name.text) !== label) continue;
    const typeNode = extensionReceiverType(current);
    return typeNode ? receiverOfType(env, env.site, typeNode) : NONE;
  }
  return null;
}

/** What `this@label` names: a lambda by its label, else an enclosing named type or extension function; no such scope has no receiver. */
async function labeledReceiver(
  env: LambdaReceiverEnvironment,
  access: SyntaxNodeLike,
  label: string,
): Promise<LambdaReceiver> {
  const lambda = enclosingLambdas(access).find((candidate) => lambdaIsLabeled(candidate, label));
  if (lambda) return receiverOfLambda(env, lambda);
  for (let container = nearestMemberContainer(access); container; container = nearestMemberContainer(container)) {
    const name = container.childForFieldName("name");
    if (!name || normalizeKotlinIdentifier(name.text) !== label) continue;
    const def = memberContainerDef(env.site.mod, container);
    return def ? { kind: "type", def, nullable: false } : UNPROVEN;
  }
  return (await extensionFunctionReceiver(env, access, label)) ?? NONE;
}

/**
 * The member `this.m` or `this@label.m` names when `this` is not the enclosing type's: a member of the closest lambda
 * receiver, or of the lambda or type the label names. A receiver whose members cannot be searched leaves no target.
 * Null leaves the access to the shared member lookup, which reads `this` as the enclosing type.
 */
export async function kotlinThisMemberResult(
  env: LambdaReceiverEnvironment,
  property: SyntaxNodeLike,
): Promise<GoToResult | null> {
  const access = property.parent;
  const [subject, name, ...rest] = access?.type === "navigation_expression" ? access.namedChildren : [];
  if (!access || subject?.type !== "this_expression" || name?.startIndex !== property.startIndex || rest.length) {
    return null;
  }
  if (!kotlinThisNeedsScopeProof(subject)) return null;
  const { index, site } = env;
  const { source } = site.parsed;
  const call = access.parent;
  const callNode =
    call?.type === "call_expression" && call.namedChildren[0]?.startIndex === access.startIndex ? call : null;
  const argumentCount = callNode
    ? (getCallArgumentCount({ languageId: "kotlin", source, call: callNode }) ?? undefined)
    : undefined;
  const label = subject.namedChildren[0];
  const receiver = label
    ? await labeledReceiver(env, access, normalizeKotlinIdentifier(label.text))
    : await innermostReceiver(env, access);
  if (receiver === "enclosing") return null;
  if (receiver.kind === "none") return { status: "not_found", reason: NO_MEMBER_REASON };
  if (receiver.kind !== "type") return { status: "not_found", reason: UNPROVEN_KOTLIN_LAMBDA_RECEIVER_REASON };
  const member = sliceText(property, source);
  const found = callNode
    ? await lookupCalledMember(env, property, receiver.def, member, argumentCount)
    : await lookupReceiverTypeMember(index, site.mod, property, receiver.def, member, argumentCount);
  if (found.status === "member") {
    return okGoToResult(index, found.member, {
      via: { exportedName: member },
      resolution: "member-access",
      confidence: "medium",
    });
  }
  const unproven = found.status === "unproven" || found.status === "maybe-invoked";
  return {
    status: "not_found",
    reason: unproven ? UNPROVEN_KOTLIN_LAMBDA_RECEIVER_REASON : NO_MEMBER_REASON,
  };
}
