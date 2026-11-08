/**
 * Kotlin lambdas with an implicit receiver. A lambda passed where a function type with a receiver is expected
 * (`Builder.() -> Unit`, `x.apply { }`, `with(x) { }`) binds a bare call to a member of that receiver before any member
 * of the enclosing type, so `build { emit() }` calls `Builder.emit` even when the enclosing class declares an `emit`.
 * Receivers nest innermost first. A receiver that lacks the name hands the lookup to the next one, and finally to the
 * enclosing type.
 *
 * What proves a lambda's receiver, from declarations and syntax, never from inferred expression types:
 * - a callee declared in the project names its parameter's type: a function type with a receiver (through a type alias)
 *   gives that receiver type, any other type gives none;
 * - a callee the project does not declare is a Kotlin standard library function when its name says so: `apply`, `run`
 *   and `runCatching` called on a receiver expression, and `with(x)`, run the lambda on the type of that expression,
 *   while `let`, `also`, `forEach`, `map` and the other plain-lambda functions have no receiver;
 * - any other trailing lambda may have a receiver whose members the index does not hold, so a bare call inside it is
 *   unproven. A lambda in parentheses or by name of an unknown callee is read as an ordinary function argument.
 *
 * A receiver type outside the project, or a project type with a supertype outside it, cannot rule a name out, so the
 * call stays unproven there too. An explicit `this` is not modeled.
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
import { definitionWithoutDeferredSteps, type JvmTypeNameResolver } from "./name-resolution-types.js";
import { lookupReceiverTypeMember, memberAcceptsCallAt } from "./navigation-goto.js";
import { okGoToResult } from "./navigation-provenance.js";
import { getOrBuildScopeIndex } from "./navigation-local.js";
import type { ParsedFileContext } from "./parse-context.js";
import { ensureParsedContextForIndex, rethrowStaleQuerySource } from "./parsed-cache.js";
import type { ScopeIndex } from "./scope.js";
import { bindsTypeParameter } from "./type-parameters.js";
import { type GoToResult, type ModuleIndex, type ProjectIndex, type SymbolDef, SymbolKind } from "./types.js";

/** What a lambda literal's implicit receiver is. */
export type LambdaReceiver =
  | { kind: "none" }
  /** An instance of a project class or interface, whose members can be searched. */
  | { kind: "type"; def: SymbolDef }
  /** A receiver may exist, and its members are not in the index. */
  | { kind: "unproven" };

/** The receivers of the lambdas of one file, by the start index of each lambda. */
export type LambdaReceiverCache = Map<number, Promise<LambdaReceiver>>;

/** What the lambdas around a bare call say about its name. */
export type LambdaReceiverVerdict =
  | { status: "member"; member: SymbolDef }
  | { status: "unproven" }
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
const NO_VERDICT: LambdaReceiverVerdict = { status: "none" };

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
  Array ByteArray CharArray IntArray List MutableList generateSequence execute submit usePinned withScopedMemoryAllocator
`;
/**
 * `execute` and `submit` are JDK executor methods (a lambda converted to a Java interface has no receiver). `usePinned`
 * and `withScopedMemoryAllocator` are Kotlin/Native and Kotlin/Wasm functions that take `(T) -> R`, a type with no
 * receiver; the JVM kotlinc cannot run those two. `memScoped` takes `MemScope.() -> R`, an external receiver: unproven.
 */
const STDLIB_PLAIN_LAMBDA_FUNCTIONS: Readonly<Record<string, true>> = Object.fromEntries(
  STDLIB_PLAIN_LAMBDA_NAMES.split(/\s+/)
    .filter(Boolean)
    .map((name): [string, true] => [name, true]),
);

const MAX_ALIAS_DEPTH = 4;
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
  slot: ArgumentSlot;
};

type LambdaContext =
  | { kind: "argument"; argument: LambdaArgument }
  /** A property initializer, whose declared type decides the receiver. */
  | { kind: "declared"; type: SyntaxNodeLike }
  /** A position whose expected type cannot be read, such as the misparsed `foo<T> { }`. */
  | { kind: "unproven" }
  /** No expected type: a lambda there has no receiver. */
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
  return { kind: "argument", argument: { ...shape, argumentList, slot: { kind: "trailing" } } };
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
  return { kind: "argument", argument: { ...calleeShape(call.namedChildren[0]), argumentList: list, slot } };
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
  return { kind: "argument", argument: { ...shape, argumentList: null, slot: { kind: "trailing" } } };
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

/** The type inside any nullability and parentheses. */
function peelType(type: SyntaxNodeLike): SyntaxNodeLike {
  let current = type;
  while (current.type === "nullable_type" || current.type === "parenthesized_type") {
    const inner = current.namedChildren.find((child) => child.type !== "type_modifiers");
    if (!inner) break;
    current = inner;
  }
  return current;
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

/** Whether `def` is declared directly in a class or object body: a member of some type. */
export async function declaredInTypeBody(index: ProjectIndex, def: SymbolDef): Promise<boolean> {
  const holder = (await declarationOf(index, def))?.node.parent;
  return !!holder && !!CLASS_BODY_TYPES[holder.type];
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

async function receiverOfFunctionType(
  env: LambdaReceiverEnvironment,
  site: Site,
  functionType: SyntaxNodeLike,
): Promise<LambdaReceiver> {
  const receiver = functionTypeReceiver(functionType);
  if (!receiver) return NONE;
  const type = peelType(receiver);
  if (type.type !== "user_type") return UNPROVEN;
  const def = await resolveType(env, site, typeNameNode(type));
  return def && isNominalType(def) ? { kind: "type", def } : UNPROVEN;
}

/** The receiver of a lambda whose expected type is `type`, as declared in `site`. */
async function receiverOfDeclaredType(
  env: LambdaReceiverEnvironment,
  site: Site,
  type: SyntaxNodeLike,
  depth = 0,
): Promise<LambdaReceiver> {
  const peeled = peelType(type);
  if (peeled.type === "function_type") return receiverOfFunctionType(env, site, peeled);
  // A lambda converted to an interface or any other type has no receiver. Only an alias can hide a function type.
  if (peeled.type !== "user_type") return NONE;
  const def = await resolveType(env, site, typeNameNode(peeled));
  if (def?.kind !== SymbolKind.TypeAlias) return NONE;
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

/** The receiver of a lambda passed to the parameter of `list` that `slot` names; null when the list has no such parameter. */
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

/** Constructors that take a lambda in `slot` agree on its receiver, or the call names none of them. */
async function receiverOfConstructors(
  env: LambdaReceiverEnvironment,
  site: Site,
  classNode: SyntaxNodeLike,
  slot: ArgumentSlot,
): Promise<LambdaReceiver> {
  const outcomes: LambdaReceiver[] = [];
  for (const list of constructorParameterLists(classNode)) {
    const outcome = await receiverOfParameterList(env, site, list, slot);
    if (outcome) outcomes.push(outcome);
  }
  const [first, ...rest] = outcomes;
  if (!first) return UNPROVEN;
  if (outcomes.every((outcome) => outcome.kind === "none")) return NONE;
  return rest.length ? UNPROVEN : first;
}

async function receiverOfDeclaredCallee(
  env: LambdaReceiverEnvironment,
  def: SymbolDef,
  slot: ArgumentSlot,
): Promise<LambdaReceiver> {
  const declaration = await declarationOf(env.index, def);
  if (declaration?.node.type === "class_declaration") {
    return receiverOfConstructors(env, declaration.site, declaration.node, slot);
  }
  if (declaration?.node.type !== "function_declaration") return UNPROVEN;
  const list = declaration.node.namedChildren.find((child) => child.type === "function_value_parameters");
  return (list ? await receiverOfParameterList(env, declaration.site, list, slot) : null) ?? UNPROVEN;
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
  return def && isNominalType(def) ? { kind: "type", def } : UNPROVEN;
}

/** The expression `with` runs its lambda on: its first argument. */
function withSubject(argument: LambdaArgument): SyntaxNodeLike | null {
  const { argumentList, slot } = argument;
  if (slot.kind !== "trailing" && !(slot.kind === "positional" && slot.index === 1)) return null;
  const first = argumentList?.namedChildren.find((child) => child.type === "value_argument");
  return first?.namedChildren[first.namedChildren.length - 1] ?? null;
}

/** A callee the project does not declare: the standard library function its name says, or null for any other name. */
async function receiverOfStandardFunction(
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
  return Object.hasOwn(STDLIB_PLAIN_LAMBDA_FUNCTIONS, name) ? NONE : null;
}

async function receiverOfArgument(env: LambdaReceiverEnvironment, argument: LambdaArgument): Promise<LambdaReceiver> {
  const { callee, slot } = argument;
  // An unknown callee's trailing lambda is a builder lambda as often as not; one in parentheses is a callback.
  const unknownCallee = slot.kind === "trailing" ? UNPROVEN : NONE;
  if (!callee) return unknownCallee;
  const def = await env.resolveCallee(callee);
  const callable = def && (def.kind === SymbolKind.Function || def.kind === SymbolKind.Class);
  if (def && callable) return receiverOfDeclaredCallee(env, def, slot);
  const name = normalizeKotlinIdentifier(sliceText(callee, env.site.parsed.source));
  return (await receiverOfStandardFunction(env, argument, name)) ?? unknownCallee;
}

async function classifyLambda(env: LambdaReceiverEnvironment, lambda: SyntaxNodeLike): Promise<LambdaReceiver> {
  const context = lambdaContext(lambda);
  if (context.kind === "argument") return receiverOfArgument(env, context.argument);
  if (context.kind === "declared") return receiverOfDeclaredType(env, env.site, context.type);
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

/**
 * What the lambdas between the bare call `use` and its class body say about `name`: a member of the closest receiver
 * that declares it, `unproven` when a receiver that may declare it cannot be searched, or `none` when no receiver
 * claims it and the enclosing type decides.
 */
export async function kotlinLambdaReceiverVerdict(
  env: LambdaReceiverEnvironment,
  use: { node: SyntaxNodeLike; name: string },
): Promise<LambdaReceiverVerdict> {
  const { parsed, mod } = env.site;
  const call = use.node.parent ?? use.node;
  const argumentCount = getCallArgumentCount({ languageId: "kotlin", source: parsed.source, call }) ?? undefined;
  for (const lambda of enclosingLambdas(use.node)) {
    const receiver = await receiverOfLambda(env, lambda);
    if (receiver.kind === "none") continue;
    if (receiver.kind === "unproven") return UNPROVEN_VERDICT;
    const found = await lookupReceiverTypeMember(env.index, mod, use.node, receiver.def, use.name, argumentCount);
    if (found.status === "unproven") return UNPROVEN_VERDICT;
    if (found.status === "omitted") continue;
    // A receiver whose only declaration of the name takes another argument count is no candidate; the next receiver is tried.
    const accepted = memberAcceptsCallAt(env.index, found.member, use.node, parsed.source, "kotlin");
    if (accepted) return { status: "member", member: found.member };
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

/** What `this@label` names: a lambda by its label, else an enclosing named type; no such scope has no receiver. */
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
    return def ? { kind: "type", def } : UNPROVEN;
  }
  return NONE;
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
  if (receiver.kind === "unproven") return { status: "not_found", reason: UNPROVEN_KOTLIN_LAMBDA_RECEIVER_REASON };
  const member = sliceText(property, source);
  const found = await lookupReceiverTypeMember(index, site.mod, property, receiver.def, member, argumentCount);
  if (found.status === "member") {
    return okGoToResult(index, found.member, {
      via: { exportedName: member },
      resolution: "member-access",
      confidence: "medium",
    });
  }
  return {
    status: "not_found",
    reason: found.status === "unproven" ? UNPROVEN_KOTLIN_LAMBDA_RECEIVER_REASON : NO_MEMBER_REASON,
  };
}
