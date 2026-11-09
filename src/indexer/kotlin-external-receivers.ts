/**
 * Well-known types outside the project, for the Kotlin lambda receiver rules in `kotlin-lambda-receiver.ts`: the
 * callees whose lambda has one of them as receiver (`launch`, `buildList`, `sequence`), and the names a bare call may
 * bind to through such a receiver or supertype.
 *
 * A type's names are its members and the extension functions that apply to it from the default imports and
 * `kotlinx.coroutines`: the metadata of `kotlin-stdlib` and `kotlinx-coroutines-core` 2.4.21 and the JDK's reflected
 * members, as kotlinc 2.4.21 binds them (sampled with probe programs: a same-named enclosing member loses to every
 * listed name and wins over every unlisted one). A name outside the set is never one of the type's, so a bare call
 * with that name goes on to the enclosing scope. A listed extension needs its import, so a listed name is only ever
 * "may bind here", never proof of a target.
 */
import { normalizeKotlinIdentifier } from "../util/identifiers.js";
import type { ModuleIndex } from "./types.js";

const NAME_GROUPS: Readonly<Record<string, string>> = {
  any: `
    also apply equals hashCode let run runCatching takeIf takeUnless to toString
  `,
  iterable: `
    add addAll all allDistinct allDistinctBy allEqual allEqualBy any asFlow asIterable asSequence associate
    associateBy associateByTo associateTo associateWith associateWithTo average awaitAll chunked clear contains
    containsAll count distinct distinctBy drop dropWhile elementAt elementAtOrElse elementAtOrNull equals filter
    filterIndexed filterIndexedTo filterIsInstance filterIsInstanceTo filterNot filterNotNull filterNotNullTo
    filterNotTo filterTo find findLast first firstNotNullOf firstNotNullOfOrNull firstOrNull flatMap flatMapIndexed
    flatMapIndexedTo flatMapTo flatten fold foldIndexed forEach forEachIndexed groupBy groupByTo groupingBy hashCode
    ifEmpty indexOf indexOfFirst indexOfLast intersect isEmpty isNotEmpty isNullOrEmpty isSorted isSortedBy
    isSortedByDescending isSortedDescending isSortedWith iterator joinAll joinTo joinToString last lastIndexOf
    lastOrNull map mapIndexed mapIndexedNotNull mapIndexedNotNullTo mapIndexedTo mapNotNull mapNotNullTo mapTo max
    maxBy maxByOrNull maxOf maxOfOrNull maxOfWith maxOfWithOrNull maxOrNull maxWith maxWithOrNull merge min minBy
    minByOrNull minOf minOfOrNull minOfWith minOfWithOrNull minOrNull minWith minWithOrNull minus minusAssign
    minusElement none onEach onEachIndexed orEmpty parallelStream partition plus plusAssign plusElement random
    randomOrNull reduce reduceIndexed reduceIndexedOrNull reduceOrNull remove removeAll removeIf requireNoNulls
    retainAll reversed runningFold runningFoldIndexed runningReduce runningReduceIndexed scan scanIndexed shuffled
    single singleOrNull size sorted sortedBy sortedByDescending sortedDescending sortedWith spliterator stream
    subtract sum sumBy sumByDouble sumOf take takeWhile toArray toBooleanArray toByteArray toCharArray toCollection
    toDoubleArray toFloatArray toHashSet toIntArray toList toLongArray toMap toMutableList toMutableSet toSet
    toShortArray toSortedSet toTypedArray toUByteArray toUIntArray toULongArray toUShortArray union unzip windowed
    withIndex zip zipWithNext
  `,
  list: `
    add addAll addFirst addLast asReversed binarySearch binarySearchBy clear component1 component2 component3
    component4 component5 contains containsAll dropLast dropLastWhile elementAt elementAtOrElse elementAtOrNull equals
    fill findLast first firstOrNull foldRight foldRightIndexed forEach get getFirst getLast getOrElse getOrNull
    hashCode indexOf indexOfFirst indexOfLast isEmpty iterator last lastIndexOf lastOrNull listIterator orEmpty
    parallelStream reduceRight reduceRightIndexed reduceRightIndexedOrNull reduceRightOrNull remove removeAll removeAt
    removeFirst removeFirstOrNull removeIf removeLast removeLastOrNull replaceAll requireNoNulls retainAll reverse
    reversed set shuffle single singleOrNull size slice sort sortBy sortByDescending sortDescending sortWith
    spliterator stream subList takeLast takeLastWhile toArray
  `,
  set: `
    add addAll clear contains containsAll equals forEach hashCode isEmpty iterator minus minusElement orEmpty
    parallelStream plus plusElement remove removeAll removeIf retainAll size spliterator stream toArray
  `,
  map: `
    all any asIterable asSequence clear compute computeIfAbsent computeIfPresent contains containsKey containsValue
    count entrySet equals filter filterKeys filterNot filterNotTo filterTo filterValues firstNotNullOf
    firstNotNullOfOrNull flatMap flatMapTo forEach get getOrDefault getOrElse getOrPut getValue hashCode ifEmpty
    isEmpty isNotEmpty isNullOrEmpty iterator keySet map mapKeys mapKeysTo mapNotNull mapNotNullTo mapTo mapValues
    mapValuesTo maxBy maxByOrNull maxOf maxOfOrNull maxOfWith maxOfWithOrNull maxWith maxWithOrNull merge minBy
    minByOrNull minOf minOfOrNull minOfWith minOfWithOrNull minWith minWithOrNull minus minusAssign none onEach
    onEachIndexed orEmpty plus plusAssign put putAll putIfAbsent remove replace replaceAll set setValue size toList
    toMap toMutableMap toProperties toSortedMap values withDefault
  `,
  charSequence: `
    all any append appendLine appendRange appendln asIterable asSequence associate associateBy associateByTo
    associateTo associateWith associateWithTo charAt chars chunked chunkedSequence codePoints commonPrefixWith
    commonSuffixWith contains contentEquals count drop dropLast dropLastWhile dropWhile elementAt elementAtOrElse
    elementAtOrNull endsWith filter filterIndexed filterIndexedTo filterNot filterNotTo filterTo find findAnyOf
    findLast findLastAnyOf first firstNotNullOf firstNotNullOfOrNull firstOrNull flatMap flatMapIndexed
    flatMapIndexedTo flatMapTo fold foldIndexed foldRight foldRightIndexed forEach forEachIndexed getOrElse getOrNull
    groupBy groupByTo groupingBy hasSurrogatePairAt ifBlank ifEmpty indexOf indexOfAny indexOfFirst indexOfLast
    isBlank isEmpty isNotBlank isNotEmpty isNullOrBlank isNullOrEmpty iterator last lastIndexOf lastIndexOfAny
    lastOrNull length lineSequence lines map mapIndexed mapIndexedNotNull mapIndexedNotNullTo mapIndexedTo mapNotNull
    mapNotNullTo mapTo matches max maxBy maxByOrNull maxOf maxOfOrNull maxOfWith maxOfWithOrNull maxOrNull maxWith
    maxWithOrNull min minBy minByOrNull minOf minOfOrNull minOfWith minOfWithOrNull minOrNull minWith minWithOrNull
    none onEach onEachIndexed padEnd padStart partition random randomOrNull reduce reduceIndexed reduceIndexedOrNull
    reduceOrNull reduceRight reduceRightIndexed reduceRightIndexedOrNull reduceRightOrNull regionMatches removePrefix
    removeRange removeSuffix removeSurrounding repeat replace replaceFirst replaceRange reversed runningFold
    runningFoldIndexed runningReduce runningReduceIndexed scan scanIndexed single singleOrNull slice split
    splitToSequence startsWith subSequence substring sumBy sumByDouble sumOf take takeLast takeLastWhile takeWhile
    toCollection toHashSet toList toMutableList toSet toSortedSet toString trim trimEnd trimStart windowed
    windowedSequence withIndex zip zipWithNext
  `,
  stringBuilder: `
    append appendCodePoint appendLine appendRange appendln capacity charAt chars clear codePointAt codePointBefore
    codePointCount codePoints compareTo delete deleteAt deleteCharAt deleteRange ensureCapacity equals getChars
    hashCode indexOf insert insertRange isEmpty lastIndexOf length offsetByCodePoints repeat replace reverse set
    setCharAt setLength setRange subSequence substring toCharArray toString trimToSize
  `,
  comparable: `
    coerceAtLeast coerceAtMost coerceIn compareTo rangeTo rangeUntil
  `,
  coroutineScope: `
    actor async broadcast cancel ensureActive future launch newCoroutineContext plus produce
  `,
  producerScope: `
    awaitClose close invokeOnClose offer send sendBlocking trySend trySendBlocking
  `,
  flowCollector: `
    cancel emit emitAll
  `,
  sequenceScope: `
    equals hashCode toString yield yieldAll
  `,
  throwable: `
    addSuppressed equals fillInStackTrace getCause getLocalizedMessage getMessage getStackTrace getSuppressed hashCode
    initCause printStackTrace setStackTrace stackTraceToString toString
  `,
  closeable: `
    close use
  `,
  runnable: `
    run
  `,
};

/** Name groups, then names of the type's own, for each external type. */
const EXTERNAL_TYPE_ROWS: Readonly<Record<string, { groups: readonly string[]; own?: string }>> = {
  "kotlinx.coroutines.CoroutineScope": { groups: ["any", "coroutineScope"] },
  "kotlinx.coroutines.channels.ProducerScope": { groups: ["any", "coroutineScope", "producerScope"] },
  "kotlinx.coroutines.flow.FlowCollector": { groups: ["any", "flowCollector"] },
  "kotlin.sequences.SequenceScope": { groups: ["any", "sequenceScope"] },
  "kotlin.collections.MutableList": { groups: ["any", "iterable", "list"] },
  "kotlin.collections.MutableSet": { groups: ["any", "iterable", "set"] },
  "kotlin.collections.MutableMap": { groups: ["any", "map"] },
  "kotlin.text.StringBuilder": { groups: ["any", "charSequence", "stringBuilder", "comparable"] },
  "java.util.ArrayList": { groups: ["any", "iterable", "list"], own: "clone ensureCapacity trimToSize" },
  "java.util.LinkedList": {
    groups: ["any", "iterable", "list"],
    own: "clone descendingIterator element offer offerFirst offerLast peek peekFirst peekLast poll pollFirst pollLast pop push removeFirstOccurrence removeLastOccurrence",
  },
  "java.util.HashMap": { groups: ["any", "map"], own: "clone" },
  "java.util.LinkedHashMap": {
    groups: ["any", "map"],
    own: "clone firstEntry lastEntry pollFirstEntry pollLastEntry putFirst putLast reversed sequencedEntrySet sequencedKeySet sequencedValues",
  },
  "java.util.HashSet": { groups: ["any", "iterable", "set"], own: "clone" },
  "java.util.LinkedHashSet": {
    groups: ["any", "iterable", "set"],
    own: "addFirst addLast clone getFirst getLast removeFirst removeLast",
  },
  "java.lang.Throwable": { groups: ["any", "throwable"] },
  "java.lang.Runnable": { groups: ["any", "runnable"] },
  "java.lang.Comparable": { groups: ["any", "comparable"] },
  "java.io.Closeable": { groups: ["any", "closeable"] },
  "java.lang.AutoCloseable": { groups: ["any", "closeable"] },
  "java.io.Serializable": { groups: ["any"] },
  "java.lang.Cloneable": { groups: ["any"] },
};

/** Types that share another row's names: subclasses that declare nothing of their own. */
const EXTERNAL_TYPE_SAME_AS: Readonly<Record<string, string>> = {
  "java.lang.StringBuilder": "kotlin.text.StringBuilder",
  "java.lang.Exception": "java.lang.Throwable",
  "java.lang.RuntimeException": "java.lang.Throwable",
  "java.lang.Error": "java.lang.Throwable",
  "java.lang.IllegalArgumentException": "java.lang.Throwable",
  "java.lang.IllegalStateException": "java.lang.Throwable",
  "java.lang.UnsupportedOperationException": "java.lang.Throwable",
  "java.io.IOException": "java.lang.Throwable",
  "java.util.NoSuchElementException": "java.lang.Throwable",
};

/** The types a bare spelling names without an import: the default imports of `kotlin.*`, `kotlin.collections.*`, and `java.lang.*`. */
const DEFAULT_IMPORT_TYPES: Readonly<Record<string, string>> = {
  MutableList: "kotlin.collections.MutableList",
  MutableSet: "kotlin.collections.MutableSet",
  MutableMap: "kotlin.collections.MutableMap",
  StringBuilder: "kotlin.text.StringBuilder",
  SequenceScope: "kotlin.sequences.SequenceScope",
  ArrayList: "java.util.ArrayList",
  LinkedHashMap: "java.util.LinkedHashMap",
  HashMap: "java.util.HashMap",
  LinkedHashSet: "java.util.LinkedHashSet",
  HashSet: "java.util.HashSet",
  Throwable: "java.lang.Throwable",
  Exception: "java.lang.Exception",
  RuntimeException: "java.lang.RuntimeException",
  Error: "java.lang.Error",
  IllegalArgumentException: "java.lang.IllegalArgumentException",
  IllegalStateException: "java.lang.IllegalStateException",
  UnsupportedOperationException: "java.lang.UnsupportedOperationException",
  Comparable: "java.lang.Comparable",
  Runnable: "java.lang.Runnable",
  Cloneable: "java.lang.Cloneable",
  AutoCloseable: "java.lang.AutoCloseable",
};

const SEPARATOR = /\s+/;

function nameSet(...texts: readonly (string | undefined)[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const text of texts) {
    for (const name of text?.split(SEPARATOR) ?? []) if (name) names.add(name);
  }
  return names;
}

const typeNames = new Map<string, ReadonlySet<string>>();

/** The names a bare call may bind to through an instance of `fqn`; undefined when the type is not a known one. */
export function externalTypeNames(fqn: string): ReadonlySet<string> | undefined {
  const cached = typeNames.get(fqn);
  if (cached) return cached;
  const row = EXTERNAL_TYPE_ROWS[EXTERNAL_TYPE_SAME_AS[fqn] ?? fqn];
  if (!row) return undefined;
  const names = nameSet(...row.groups.map((group) => NAME_GROUPS[group]), row.own);
  typeNames.set(fqn, names);
  return names;
}

/** Every known external type, by fully qualified name. */
export const KNOWN_EXTERNAL_TYPES: readonly string[] = [
  ...Object.keys(EXTERNAL_TYPE_ROWS),
  ...Object.keys(EXTERNAL_TYPE_SAME_AS),
];

/**
 * Extension functions that apply to every receiver, so a bare call of one inside a lambda with any receiver goes to
 * that receiver's extension before a member of the enclosing type.
 */
export const UNIVERSAL_EXTENSION_NAMES: ReadonlySet<string> = nameSet(NAME_GROUPS.any);

/** A callee whose trailing lambda has a known external receiver, and the package its import proves it. */
type ExternalBuilder = { receiver: string; packages: readonly string[] };

const COROUTINES = ["kotlinx.coroutines"];
const COROUTINE_SCOPE_BUILDER: ExternalBuilder = {
  receiver: "kotlinx.coroutines.CoroutineScope",
  packages: COROUTINES,
};
const PRODUCER_SCOPE = "kotlinx.coroutines.channels.ProducerScope";

/**
 * `launch { }` and the other builders whose lambda takes a known external receiver: the coroutine builders (imported
 * from kotlinx.coroutines) and the standard library's `buildList { }`, `buildString { }`, and `sequence { }` (default
 * imports). Each name and receiver is checked against kotlinc 2.4.21.
 */
const EXTERNAL_BUILDERS: Readonly<Record<string, ExternalBuilder>> = {
  launch: COROUTINE_SCOPE_BUILDER,
  async: COROUTINE_SCOPE_BUILDER,
  runBlocking: COROUTINE_SCOPE_BUILDER,
  withContext: COROUTINE_SCOPE_BUILDER,
  coroutineScope: COROUTINE_SCOPE_BUILDER,
  supervisorScope: COROUTINE_SCOPE_BUILDER,
  withTimeout: COROUTINE_SCOPE_BUILDER,
  withTimeoutOrNull: COROUTINE_SCOPE_BUILDER,
  produce: { receiver: PRODUCER_SCOPE, packages: ["kotlinx.coroutines.channels"] },
  flow: { receiver: "kotlinx.coroutines.flow.FlowCollector", packages: ["kotlinx.coroutines.flow"] },
  channelFlow: { receiver: PRODUCER_SCOPE, packages: ["kotlinx.coroutines.flow"] },
  callbackFlow: { receiver: PRODUCER_SCOPE, packages: ["kotlinx.coroutines.flow"] },
  buildList: { receiver: "kotlin.collections.MutableList", packages: [] },
  buildSet: { receiver: "kotlin.collections.MutableSet", packages: [] },
  buildMap: { receiver: "kotlin.collections.MutableMap", packages: [] },
  buildString: { receiver: "kotlin.text.StringBuilder", packages: [] },
  sequence: { receiver: "kotlin.sequences.SequenceScope", packages: [] },
  iterator: { receiver: "kotlin.sequences.SequenceScope", packages: [] },
};

/**
 * Whether `mod` imports `name` from one of `packages` by name or by star. A name with no package is visible without
 * an import (a default import).
 */
function importsFromPackages(mod: ModuleIndex, name: string, packages: readonly string[]): boolean {
  if (!packages.length) return true;
  return mod.imports.some((imp) => {
    if (imp.kind === "star") return packages.includes(imp.from);
    return imp.kind === "named" && packages.some((pkg) => imp.from === `${pkg}.${name}` && imp.imported === name);
  });
}

/** The external receiver type of `name`'s lambda when `mod` calls the standard or kotlinx function of that name. */
export function externalBuilderReceiver(mod: ModuleIndex, name: string): string | undefined {
  const builder = Object.hasOwn(EXTERNAL_BUILDERS, name) ? EXTERNAL_BUILDERS[name] : undefined;
  return builder && importsFromPackages(mod, name, builder.packages) ? builder.receiver : undefined;
}

/**
 * JDK functional interfaces called as SAM constructors (`Runnable { }`): the lambda converts to a Java interface and
 * has no receiver. `Thread { }` takes a `Runnable` the same way. Each name maps to the package that declares it.
 */
const SAM_CONSTRUCTOR_PACKAGES: Readonly<Record<string, string>> = Object.fromEntries([
  ["Runnable", "java.lang"],
  ["Thread", "java.lang"],
  ["Comparator", "java.util"],
  ...["Callable", "Executor", "ThreadFactory"].map((name): [string, string] => [name, "java.util.concurrent"]),
  ...`
    BiConsumer BiFunction BinaryOperator BiPredicate BooleanSupplier Consumer DoubleBinaryOperator DoubleConsumer
    DoubleFunction DoublePredicate DoubleSupplier DoubleToIntFunction DoubleToLongFunction DoubleUnaryOperator Function
    IntBinaryOperator IntConsumer IntFunction IntPredicate IntSupplier IntToDoubleFunction IntToLongFunction
    IntUnaryOperator LongBinaryOperator LongConsumer LongFunction LongPredicate LongSupplier LongToDoubleFunction
    LongToIntFunction LongUnaryOperator ObjDoubleConsumer ObjIntConsumer ObjLongConsumer Predicate Supplier
    ToDoubleBiFunction ToDoubleFunction ToIntBiFunction ToIntFunction ToLongBiFunction ToLongFunction UnaryOperator
  `
    .split(SEPARATOR)
    .filter(Boolean)
    .map((name): [string, string] => [name, "java.util.function"]),
]);

/** The SAM constructors visible without an import: `java.lang.*` and `kotlin.Comparator`. */
const SAM_DEFAULT_IMPORTED: Readonly<Record<string, true>> = { Runnable: true, Thread: true, Comparator: true };

/**
 * Whether a call of `name` with a trailing lambda in `mod` is a JDK SAM constructor: the bare name when the file
 * imports it (or sees it by default), or the name qualified by its package (`java.util.concurrent.Callable { }`).
 */
export function isJdkSamConstructor(mod: ModuleIndex, name: string, qualifier?: string): boolean {
  const home = Object.hasOwn(SAM_CONSTRUCTOR_PACKAGES, name) ? SAM_CONSTRUCTOR_PACKAGES[name] : undefined;
  if (!home) return false;
  if (qualifier !== undefined) return typeSpellingPath(qualifier) === home;
  return Object.hasOwn(SAM_DEFAULT_IMPORTED, name) || importsFromPackages(mod, name, [home]);
}

/** JDK executors, whose `execute { }` and `submit { }` take a Java functional interface. */
export const JDK_EXECUTOR_TYPES: readonly string[] = [
  "java.util.concurrent.Executor",
  "java.util.concurrent.ExecutorService",
  "java.util.concurrent.ScheduledExecutorService",
  "java.util.concurrent.ThreadPoolExecutor",
  "java.util.concurrent.ScheduledThreadPoolExecutor",
  "java.util.concurrent.ForkJoinPool",
];

/** `Foo` for `Foo<T>`, with identifier quoting removed from each segment. */
function typeSpellingPath(spelling: string): string {
  const withoutArguments = spelling.split("<")[0] ?? spelling;
  return withoutArguments
    .split(".")
    .map((segment) => normalizeKotlinIdentifier(segment.trim()))
    .join(".");
}

/**
 * The fully qualified name, among `candidates`, that a type spelling in `mod` denotes: the spelling itself when it is
 * qualified, else the type a named import binds to that spelling, a star import of its package, or a default import.
 */
export function resolveExternalType(
  mod: ModuleIndex,
  spelling: string,
  candidates: readonly string[] = KNOWN_EXTERNAL_TYPES,
): string | undefined {
  const path = typeSpellingPath(spelling);
  if (path.includes(".")) return candidates.find((fqn) => fqn === path);
  const named = mod.imports.find((imp) => imp.kind === "named" && normalizeKotlinIdentifier(imp.local) === path);
  if (named?.kind === "named") return candidates.find((fqn) => fqn === named.from);
  const simple = (fqn: string): string => fqn.slice(fqn.lastIndexOf(".") + 1);
  const starred = candidates.find(
    (fqn) =>
      simple(fqn) === path &&
      mod.imports.some((imp) => imp.kind === "star" && imp.from === fqn.slice(0, fqn.lastIndexOf("."))),
  );
  if (starred) return starred;
  const implicit = Object.hasOwn(DEFAULT_IMPORT_TYPES, path) ? DEFAULT_IMPORT_TYPES[path] : undefined;
  return implicit && candidates.includes(implicit) ? implicit : undefined;
}
