import path from "node:path";
import { findUsageReferences, getCppEquivalentCallableDefinitions, goToDefinition } from "../indexer/navigation.js";
import { ensureParsedContext, type ParsedFileContext } from "../indexer/parse-context.js";
import { findClosestScopeBinding, getOrBuildScopeIndex, resolveNamedDefinition } from "../indexer/navigation-local.js";
import {
  cppCallableShapeForNode,
  cppCallableIsDefinition,
  cppEquivalentCallableBindings,
} from "../indexer/cpp-callables.js";
import { getCachedReferenceCandidateFiles } from "../indexer/navigation-references.js";
import type { Binding } from "../indexer/scope-types.js";
import { SymbolKind, type ProjectIndex, type Reference, type SymbolDef } from "../indexer/types.js";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import {
  CALLABLE_DECLARATION_NODE_TYPES,
  CALLABLE_VARIABLE_VALUE_NODE_TYPES,
  getCallableArity,
  getCallableArityFromParameterText,
  getCallableDeclarationKind,
  getCallArgumentCount,
  getCallArgumentCountFromArgumentText,
  type CallableBinding,
  type CallableDeclarationKind,
} from "../languages/callable-arity.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import { sliceText, toRange } from "../util/ast.js";
import { fileIdentityKey } from "../util/paths.js";
import {
  getCallCompatibilityLanguageProfile,
  getCallCompatibilityProvider,
  getCallCompatibilitySupportedLanguages,
  registerCallCompatibilityExtractors,
} from "./call-compatibility/providers/index.js";
import type {
  CallableSignature,
  CallsiteArguments,
  ExtractCallableSignatureRequest,
  ExtractCallsiteArgumentsRequest,
} from "./call-compatibility/types.js";

import {
  findSignatureOpeningParen,
  findCallOpeningParen,
  findBalancedParentheses,
} from "./call-compatibility/text-scanner.js";

import type { ReferenceLookupCache } from "./reference-cache.js";
import { findAncestorOfTypes } from "./signature-node-utils.js";
import type { CallCompatibilityHint, ChangedSymbol, ImpactDiagnostics } from "./types.js";
import {
  canStartReferenceLookup,
  recordReferenceLookupOmitted,
  recordReferenceLookupStarted,
  type ImpactWorkBudget,
} from "./budgets.js";
function supportsCallCompatibilityLanguage(languageId: string): boolean {
  return getCallCompatibilityProvider(languageId) !== null;
}

export type {
  CallableSignature,
  CallsiteArguments,
  ExtractCallableSignatureRequest,
  ExtractCallsiteArgumentsRequest,
} from "./call-compatibility/types.js";

function referenceScanLimitForCallsites(maxRefs: number): number {
  return Math.max(maxRefs + 50, maxRefs * 4);
}

const callableDeclarationTypes: ReadonlySet<string> = new Set(Object.keys(CALLABLE_DECLARATION_NODE_TYPES));

function extractCallableSignatureFromProvider(request: ExtractCallableSignatureRequest): CallableSignature | null {
  const profile = getCallCompatibilityLanguageProfile(request.languageId);
  if (!profile) {
    return null;
  }
  const binding = request.binding ?? "bound";
  if (request.tree) {
    const node = request.tree.rootNode.descendantForIndex(request.symbolStartIndex, request.symbolStartIndex);
    const declaration = findAncestorOfTypes(node, callableDeclarationTypes);
    if (declaration) {
      const arity = getCallableArity({ languageId: request.languageId, source: request.source, declaration, binding });
      if (arity) {
        return { ...arity, confidence: "high" };
      }
      // A tree-proven declaration with no provable parameter structure is unknown, except a
      // variable declarator whose value is not callable: that shape always fell back to the
      // source scan, and the fallback must not change for it.
      const valueNode = declaration.type === "variable_declarator" ? declaration.childForFieldName("value") : null;
      const fallsThroughToSource =
        declaration.type === "variable_declarator" &&
        (!valueNode || !CALLABLE_VARIABLE_VALUE_NODE_TYPES[valueNode.type]);
      if (!fallsThroughToSource) {
        return null;
      }
    }
  }
  if (!profile.sourceFallback) {
    return null;
  }
  const openIndex = findSignatureOpeningParen(request.source, request.symbolStartIndex);
  const balanced = findBalancedParentheses(request.source, openIndex);
  if (!balanced) {
    return null;
  }
  const arity = getCallableArityFromParameterText({
    languageId: request.languageId,
    parameterText: balanced.inner,
    binding,
  });
  return arity ? { ...arity, confidence: "high" } : null;
}

function extractCallsiteArgumentsFromProvider(request: ExtractCallsiteArgumentsRequest): CallsiteArguments | null {
  const profile = getCallCompatibilityLanguageProfile(request.languageId);
  if (!profile) {
    return null;
  }
  const callNode = request.tree ? locateCallsiteCallNode(request) : null;
  if (callNode) {
    const argCount = getCallArgumentCount({ languageId: request.languageId, source: request.source, call: callNode });
    return argCount === null ? null : { argCount, confidence: "high" };
  }
  if (!profile.sourceFallback) {
    return null;
  }
  const openIndex = findCallOpeningParen(request.source, request.calleeStartIndex, request.calleeEndIndex);
  const balanced = findBalancedParentheses(request.source, openIndex);
  if (!balanced) {
    return null;
  }
  const argCount = getCallArgumentCountFromArgumentText({
    languageId: request.languageId,
    argumentText: balanced.inner,
  });
  return argCount === null ? null : { argCount, confidence: "high" };
}

registerCallCompatibilityExtractors({
  extractSignature: extractCallableSignatureFromProvider,
  extractCallsite: extractCallsiteArgumentsFromProvider,
});

export function extractCallableSignature(request: ExtractCallableSignatureRequest): CallableSignature | null {
  const provider = getCallCompatibilityProvider(request.languageId);
  if (!provider) {
    return null;
  }
  return provider.extractSignature(request);
}

export function extractCallsiteArguments(request: ExtractCallsiteArgumentsRequest): CallsiteArguments | null {
  const provider = getCallCompatibilityProvider(request.languageId);
  if (!provider) {
    return null;
  }
  return provider.extractCallsite(request);
}

/**
 * Call node types recognized at a callee range. PHP member and scoped call forms stay excluded:
 * callsite extraction for them remains the documented limitation it was before the shared arity
 * facts existed, so no caller sees a newly counted or newly dropped callsite here.
 */
const CALL_EXPRESSION_NODE_TYPES: Record<string, true> = {
  call: true,
  call_expression: true,
  function_call_expression: true,
  invocation_expression: true,
  method_invocation: true,
  object_creation_expression: true,
};

const callExpressionTypes: ReadonlySet<string> = new Set(Object.keys(CALL_EXPRESSION_NODE_TYPES));

/**
 * Locate and validate the call node for a callee range. The callee must sit inside the call's
 * target expression, so a non-callee reference inside a call (an argument, for example) is not a
 * callsite, and a trailing-closure wrapper call counts as the callsite.
 */
function locateCallsiteCallNode(request: ExtractCallsiteArgumentsRequest): SyntaxNodeLike | null {
  if (!request.tree) {
    return null;
  }
  const endIndex = request.calleeEndIndex ?? request.calleeStartIndex;
  const node = request.tree.rootNode.descendantForIndex(request.calleeStartIndex, endIndex);
  let callNode = findAncestorOfTypes(node, callExpressionTypes);
  if (!callNode) {
    return null;
  }
  let parentCallNode = callNode.parent;
  while (parentCallNode && callExpressionTypes.has(parentCallNode.type)) {
    const trailingText = request.source.slice(callNode.endIndex, parentCallNode.endIndex).trimStart();
    if (!trailingText.startsWith("{")) {
      break;
    }
    callNode = parentCallNode;
    parentCallNode = callNode.parent;
  }
  if (request.calleeStartIndex < callNode.startIndex || request.calleeStartIndex > callNode.endIndex) {
    return null;
  }
  const targetNode = callTargetNode(callNode);
  if (!targetNode || request.calleeStartIndex < targetNode.startIndex || endIndex > targetNode.endIndex) {
    return null;
  }
  return callNode;
}

function isCallableChangedSymbol(symbol: ChangedSymbol): boolean {
  return (
    symbol.kind === SymbolKind.Function ||
    symbol.kind === SymbolKind.Default ||
    symbol.kind === SymbolKind.Variable ||
    String(symbol.kind) === "method"
  );
}

function sameRangeStart(left: Range, right: Range): boolean {
  const leftIndex = left.start.index;
  const rightIndex = right.start.index;
  return left.start.line === right.start.line && left.start.column === right.start.column && leftIndex === rightIndex;
}

function sameDefinition(left: SymbolDef, right: SymbolDef): boolean {
  return (
    fileIdentityKey(left.file) === fileIdentityKey(right.file) &&
    left.localName === right.localName &&
    left.kind === right.kind &&
    left.range.start.index === right.range.start.index
  );
}

function callableDeclarationAt(tree: SyntaxTreeLike, startIndex: number): SyntaxNodeLike | null {
  const node = tree.rootNode.descendantForIndex(startIndex, startIndex);
  return findAncestorOfTypes(node, callableDeclarationTypes);
}

function sameOverloadContainer(left: SyntaxNodeLike | null, right: SyntaxNodeLike | null): boolean {
  if (!left || !right || !left.parent || !right.parent) {
    return false;
  }
  return left.parent.id === right.parent.id;
}

function changedCppCallableBinding(
  index: ProjectIndex,
  changedSymbol: ChangedSymbol,
  parsed: ParsedFileContext,
): Binding | undefined {
  if (parsed.sup.id !== "cpp") return undefined;
  const module = index.byFile.get(fileIdentityKey(changedSymbol.file));
  if (!module) return undefined;
  const scope = getOrBuildScopeIndex(index, module.file, parsed.source, parsed.sup, module, parsed.tree);
  return scope.bindings
    .get(parsed.sup.normalizeIdentifier(changedSymbol.name))
    ?.find((binding) => binding.kind === "function" && binding.def && sameRangeStart(binding.def, changedSymbol.range));
}

function hasSameFileOverloadCandidates(
  index: ProjectIndex,
  changedSymbol: ChangedSymbol,
  parsed: ParsedFileContext,
): boolean {
  const module = index.byFile.get(fileIdentityKey(changedSymbol.file));
  if (!module) {
    return false;
  }

  const changedStartIndex = changedSymbol.range.start.index;
  if (changedStartIndex === undefined) {
    return false;
  }
  const { source, tree, sup } = parsed;
  const changedDeclaration = callableDeclarationAt(tree, changedStartIndex);

  for (const local of module.locals) {
    if (local.localName !== changedSymbol.name || sameRangeStart(local.range, changedSymbol.range)) {
      continue;
    }
    const symbolStartIndex = local.range.start.index;
    if (symbolStartIndex === undefined) {
      continue;
    }
    const localDeclaration = callableDeclarationAt(tree, symbolStartIndex);
    if (!sameOverloadContainer(changedDeclaration, localDeclaration)) {
      continue;
    }
    const signature = extractCallableSignature({
      languageId: sup.id,
      source,
      symbolStartIndex,
      tree,
    });
    if (signature) {
      return true;
    }
  }
  return false;
}

function rangeContainsIndex(range: Range, index: number): boolean {
  const startIndex = range.start.index;
  const endIndex = range.end.index;
  if (startIndex === undefined || endIndex === undefined) {
    return false;
  }
  return index >= startIndex && index <= endIndex;
}

export type CallerRangeEntry = {
  local: SymbolDef;
  maxEndIndex: number;
};

export type CallerRangeIndex = ReadonlyMap<string, CallerRangeEntry[]>;

export function buildCallerRangeIndex(index: ProjectIndex): CallerRangeIndex {
  const byFile = new Map<string, CallerRangeEntry[]>();
  for (const module of index.byFile.values()) {
    const entries = module.locals
      .flatMap((local) => {
        const startIndex = local.range.start.index;
        const endIndex = local.range.end.index;
        if (startIndex === undefined || endIndex === undefined) return [];
        return [{ local, maxEndIndex: endIndex }];
      })
      .sort((left, right) => {
        const startDifference = left.local.range.start.index! - right.local.range.start.index!;
        if (startDifference !== 0) return startDifference;
        return left.local.range.end.index! - right.local.range.end.index!;
      });
    let maxEndIndex = Number.NEGATIVE_INFINITY;
    for (const entry of entries) {
      maxEndIndex = Math.max(maxEndIndex, entry.local.range.end.index!);
      entry.maxEndIndex = maxEndIndex;
    }
    byFile.set(fileIdentityKey(module.file), entries);
  }
  return byFile;
}

export function findCallerSymbolId(callerRangeIndex: CallerRangeIndex, ref: Reference): string | undefined {
  const startIndex = ref.range.start.index;
  if (startIndex === undefined) return undefined;

  const entries = callerRangeIndex.get(fileIdentityKey(ref.file));
  if (!entries?.length) return undefined;

  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const middleStart = entries[middle]!.local.range.start.index!;
    if (middleStart <= startIndex) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  let best: SymbolDef | undefined;
  for (let index = low - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.maxEndIndex < startIndex) break;
    if (!rangeContainsIndex(entry.local.range, startIndex)) continue;
    if (!best) {
      best = entry.local;
      continue;
    }
    const localSpan = (entry.local.range.end.index ?? 0) - (entry.local.range.start.index ?? 0);
    const bestSpan = (best.range.end.index ?? 0) - (best.range.start.index ?? 0);
    if (localSpan < bestSpan) best = entry.local;
  }

  if (!best) return undefined;
  const bestStartIndex = best.range.start.index ?? 0;
  return `${best.file}::${best.localName}::${bestStartIndex}`;
}

function callTargetNode(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const explicitTarget =
    node.childForFieldName("function") ??
    node.childForFieldName("callee") ??
    node.childForFieldName("name") ??
    node.childForFieldName("method") ??
    node.childForFieldName("member") ??
    node.childForFieldName("expression");
  if (explicitTarget) {
    return explicitTarget;
  }
  const argumentTypes = new Set(["argument_list", "arguments", "value_arguments", "call_suffix"]);
  return node.namedChildren.find((child) => !argumentTypes.has(child.type)) ?? null;
}

function bestGotoNode(target: SyntaxNodeLike, symbolName: string, source: string): SyntaxNodeLike {
  let best = target;
  const walk = (node: SyntaxNodeLike): void => {
    if (sliceText(node, source) === symbolName) {
      best = node;
    }
    for (const child of node.namedChildren ?? []) {
      walk(child);
    }
  };
  walk(target);
  return best;
}

function cppUnqualifiedCallTarget(
  index: ProjectIndex,
  file: string,
  parsed: ParsedFileContext,
  target: SyntaxNodeLike,
): SymbolDef | null {
  if (parsed.sup.id !== "cpp" || target.type !== "identifier") return null;
  const module = index.byFile.get(fileIdentityKey(file));
  if (!module) return null;
  const name = sliceText(target, parsed.source);
  const scope = getOrBuildScopeIndex(index, file, parsed.source, parsed.sup, module, parsed.tree);
  const binding = findClosestScopeBinding(scope, name, target, parsed.sup);
  if (binding?.kind === "function") {
    const equivalents = cppEquivalentCallableBindings(binding);
    if (equivalents.length !== (binding.sameScopeFunctionBindings?.length ?? 1)) return null;
    const canonical = equivalents.find((candidate) => cppCallableIsDefinition(candidate.node)) ?? equivalents[0];
    const range = canonical?.def;
    if (!range) return null;
    return module.locals.find((local) => sameRangeStart(local.range, range)) ?? null;
  }
  // A local variable or parameter shadows the function; member expressions and
  // ambiguous overload sets cannot be recovered as unqualified calls.
  if (binding && !binding.import) return null;
  const resolved = resolveNamedDefinition(index, module, file, parsed.sup, name);
  if (resolved?.status !== "ok" || resolved.definition.kind !== SymbolKind.Function) return null;
  return resolved.definition;
}

async function collectVerifiedCallsiteReferences(
  index: ProjectIndex,
  changedSymbol: ChangedSymbol,
  maxRefs: number,
  shouldIncludeReference: (file: string) => boolean,
  diagnostics: ImpactDiagnostics["callCompatibility"] | undefined,
  parsedDefinition: ParsedFileContext,
  equivalentDefinitions: readonly SymbolDef[] | undefined,
  excludedReferences: ReadonlySet<string>,
): Promise<Reference[]> {
  const refs: Reference[] = [];
  const seen = new Set<string>();
  const languageId = parsedDefinition.sup.id;
  const def: SymbolDef = {
    file: changedSymbol.file,
    localName: changedSymbol.name,
    kind: changedSymbol.kind,
    range: changedSymbol.range,
  };
  let candidateFiles: Set<string> | undefined;
  if ((languageId === "c" || languageId === "cpp") && changedSymbol.kind === SymbolKind.Function) {
    candidateFiles = new Set<string>();
    for (const definition of equivalentDefinitions ?? [def]) {
      const module = index.byFile.get(fileIdentityKey(definition.file));
      const exportedNames =
        module?.exports.flatMap((entry) =>
          entry.type === "local" && sameDefinition(entry.target, definition) ? [entry.exportedAs] : [],
        ) ?? [];
      if (!exportedNames.length) exportedNames.push(definition.localName);
      candidateFiles.add(fileIdentityKey(definition.file));
      for (const file of getCachedReferenceCandidateFiles(index, definition, exportedNames, false, languageId)) {
        candidateFiles.add(fileIdentityKey(file));
      }
    }
  }

  for (const module of index.byFile.values()) {
    const file = module.file;
    if (candidateFiles && !candidateFiles.has(fileIdentityKey(file))) continue;
    if (refs.length >= maxRefs) {
      break;
    }
    if (!shouldIncludeReference(file)) {
      continue;
    }
    const support = supportForFileWithoutHeaderSample(file, index.languageExtensions);
    if (!support || !supportsCallCompatibilityLanguage(support.id)) {
      continue;
    }
    const parsed = await tryEnsureParsedContext(
      file,
      index.parsed?.get(fileIdentityKey(file)),
      index.languageExtensions,
      diagnostics,
    );
    if (!parsed) {
      continue;
    }

    const walk = async (node: SyntaxNodeLike): Promise<void> => {
      if (refs.length >= maxRefs) {
        return;
      }
      if (callExpressionTypes.has(node.type)) {
        const target = callTargetNode(node);
        if (target) {
          const gotoNode = bestGotoNode(target, changedSymbol.name, parsed.source);
          if (sliceText(gotoNode, parsed.source) === changedSymbol.name) {
            const result = await goToDefinition(
              index,
              {
                file,
                line: gotoNode.startPosition.row + 1,
                column: gotoNode.startPosition.column + 1,
              },
              parsed,
            );
            // Navigation rejects invalid C++ arity. Compatibility diagnostics need
            // the unique lexical/import binding before judging the argument count.
            const definition =
              result.status === "ok" ? result.definition : cppUnqualifiedCallTarget(index, file, parsed, target);
            if (definition) {
              if (
                sameDefinition(definition, def) ||
                equivalentDefinitions?.some((candidate) => sameDefinition(definition, candidate))
              ) {
                const range = toRange(gotoNode);
                const key = `${fileIdentityKey(file)}:${range.start.line}:${range.start.column}`;
                if (!seen.has(key) && !excludedReferences.has(key)) {
                  seen.add(key);
                  refs.push({ file, range });
                }
              }
            }
          }
        }
      }
      for (const child of node.namedChildren ?? []) {
        await walk(child);
      }
    };

    await walk(parsed.tree.rootNode);
  }

  return refs;
}

function classifyCompatibility(
  expected: CallableSignature,
  actual: CallsiteArguments,
): Pick<CallCompatibilityHint, "status" | "reason"> {
  if (actual.argCount < expected.minArgs) {
    return { status: "likely_mismatch", reason: "argument_count_below_minimum" };
  }
  if (expected.maxArgs !== null && actual.argCount > expected.maxArgs) {
    return { status: "likely_mismatch", reason: "argument_count_above_maximum" };
  }
  return { status: "compatible", reason: "compatible_argument_count" };
}

function tryEnsureParsedContext(
  file: string,
  parsedEntry: Parameters<typeof ensureParsedContext>[1],
  languageExtensions: Parameters<typeof ensureParsedContext>[2],
  diagnostics: ImpactDiagnostics["callCompatibility"] | undefined,
): Promise<ParsedFileContext | null> {
  return ensureParsedContext(file, parsedEntry, languageExtensions).catch(() => {
    incrementSkippedReason(diagnostics, "parse-failed");
    return null;
  });
}

function incrementSkippedReason(diagnostics: ImpactDiagnostics["callCompatibility"] | undefined, reason: string): void {
  if (!diagnostics) {
    return;
  }
  diagnostics.skippedByReason[reason] = (diagnostics.skippedByReason[reason] ?? 0) + 1;
}

/** Declaration containers whose `name` field names the receiver type at a member call. */
const OWNER_CONTAINER_TYPES: Record<string, true> = {
  class_declaration: true,
  class_definition: true,
  class_specifier: true,
  impl_item: true,
  interface_declaration: true,
  object_declaration: true,
  struct_specifier: true,
  trait_item: true,
};

function ownerTypeNameOf(declaration: SyntaxNodeLike, source: string): string | null {
  let current = declaration.parent;
  while (current) {
    if (OWNER_CONTAINER_TYPES[current.type]) {
      const name = current.childForFieldName("name");
      return name ? sliceText(name, source) : null;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Resolve which receiver binding form a callsite uses. Python bare calls reach the plain function
 * and pass the receiver explicitly; Python member calls on a provably class-valued receiver do the
 * same only for instance methods, because class and static methods bind (or declare) no instance
 * receiver. Rust `Type::target(...)` calls are unbound UFCS forms. A C# extension method called
 * through its declaring static class (`Ext.M(value)`) passes the `this` receiver explicitly.
 * Everything else supplies the receiver through the call form.
 */
function callBindingForm(input: {
  languageId: string;
  callNode: SyntaxNodeLike;
  source: string;
  parsedCallsite: ParsedFileContext;
  file: string;
  index: ProjectIndex;
  declarationKind: CallableDeclarationKind | null;
  ownerTypeName: string | null;
}): CallableBinding {
  const { languageId, callNode, source, parsedCallsite, file, index, declarationKind, ownerTypeName } = input;
  const callee = callTargetNode(callNode);
  if (languageId === "rust") {
    return callee?.type === "scoped_identifier" ? "unbound" : "bound";
  }
  if (languageId === "csharp") {
    const receiver = callee?.type === "member_access_expression" ? callee.childForFieldName("expression") : null;
    const receiverText = receiver ? sliceText(receiver, source).trim() : "";
    return ownerTypeName && receiverText === ownerTypeName ? "unbound" : "bound";
  }
  if (languageId !== "python" || !callee) {
    return "bound";
  }
  if (callee.type === "identifier") {
    return "unbound";
  }
  if (callee.type !== "attribute") {
    return "bound";
  }
  const receiver = callee.namedChildren[0] ?? null;
  if (!receiver) {
    return "bound";
  }
  const receiverText = sliceText(receiver, source).trim();
  if (receiverText === "self" || receiverText === "cls" || receiverText === "super()") {
    return "bound";
  }
  if (declarationKind !== "instance-method") {
    return "bound";
  }
  if (ownerTypeName && receiverText === ownerTypeName) {
    return "unbound";
  }
  if (receiver.type === "identifier") {
    const module = index.byFile.get(fileIdentityKey(file));
    if (module) {
      const resolved = resolveNamedDefinition(index, module, file, parsedCallsite.sup, receiverText);
      if (resolved?.status === "ok" && resolved.definition.kind === SymbolKind.Class) {
        return "unbound";
      }
    }
  }
  return "bound";
}

async function buildCallCompatibilityHintForReference(input: {
  index: ProjectIndex;
  changedSymbol: ChangedSymbol;
  signature: CallableSignature;
  unboundSignature: CallableSignature | null;
  declarationKind: CallableDeclarationKind | null;
  ownerTypeName: string | null;
  ref: Reference;
  callerRangeIndex: CallerRangeIndex;
  diagnostics?: ImpactDiagnostics["callCompatibility"] | undefined;
  projectRoot?: string | undefined;
}): Promise<CallCompatibilityHint | null> {
  const {
    index,
    changedSymbol,
    signature,
    unboundSignature,
    declarationKind,
    ownerTypeName,
    ref,
    callerRangeIndex,
    diagnostics,
    projectRoot,
  } = input;
  if (
    fileIdentityKey(ref.file) === fileIdentityKey(changedSymbol.file) &&
    sameRangeStart(ref.range, changedSymbol.range)
  ) {
    return null;
  }

  const calleeStartIndex = ref.range.start.index;
  if (calleeStartIndex === undefined) {
    return null;
  }

  const parsedCallsite = await tryEnsureParsedContext(
    ref.file,
    index.parsed?.get(fileIdentityKey(ref.file)),
    index.languageExtensions,
    diagnostics,
  );
  if (!parsedCallsite) {
    return null;
  }
  const callsiteRequest: ExtractCallsiteArgumentsRequest = {
    languageId: parsedCallsite.sup.id,
    source: parsedCallsite.source,
    calleeStartIndex,
    tree: parsedCallsite.tree,
    ...(ref.range.end.index !== undefined ? { calleeEndIndex: ref.range.end.index } : {}),
  };
  const actual = extractCallsiteArguments(callsiteRequest);
  if (!actual) {
    if (diagnostics) {
      diagnostics.unknownCallsites += 1;
    }
    return null;
  }

  // Pick the arity for the call form: an unbound call passes the receiver as its first argument,
  // so it must be compared against the receiver-inclusive range instead of the bound one.
  let expected = signature;
  const hasDistinctUnboundForm =
    unboundSignature !== null &&
    (unboundSignature.minArgs !== signature.minArgs || unboundSignature.maxArgs !== signature.maxArgs);
  if (hasDistinctUnboundForm) {
    const callNode = parsedCallsite.tree ? locateCallsiteCallNode(callsiteRequest) : null;
    const binding = callNode
      ? callBindingForm({
          languageId: parsedCallsite.sup.id,
          callNode,
          source: parsedCallsite.source,
          parsedCallsite,
          file: ref.file,
          index,
          declarationKind,
          ownerTypeName,
        })
      : "bound";
    if (binding === "unbound" && unboundSignature) {
      expected = unboundSignature;
    }
  }

  const compatibility = classifyCompatibility(expected, actual);
  const callerSymbolId = findCallerSymbolId(callerRangeIndex, ref);
  const callsiteFile = projectRoot ? path.relative(projectRoot, ref.file).replace(/\\/g, "/") : ref.file;
  return {
    ...compatibility,
    changedSymbolId: changedSymbol.id,
    callsiteFile,
    callsiteRange: ref.range,
    ...(callerSymbolId ? { callerSymbolId } : {}),
    expected,
    actual,
  };
}
function resetCallCompatibilityHints(changedSymbols: ChangedSymbol[]): void {
  for (const changedSymbol of changedSymbols) {
    delete changedSymbol.callCompatibility;
  }
}
export async function attachCallCompatibilityHints(
  index: ProjectIndex,
  changedSymbols: ChangedSymbol[],
  options: {
    maxRefs: number;
    projectRoot?: string;
    diagnostics?: ImpactDiagnostics;
    shouldIncludeReference?: (file: string) => boolean;
    referenceCache?: ReferenceLookupCache;
    workBudget?: ImpactWorkBudget;
  },
): Promise<void> {
  resetCallCompatibilityHints(changedSymbols);

  if (options.maxRefs <= 0) {
    return;
  }
  const callerRangeIndex = buildCallerRangeIndex(index);

  const diagnostics = options.diagnostics?.callCompatibility;
  if (diagnostics) {
    diagnostics.supportedLanguages = [...getCallCompatibilitySupportedLanguages()];
  }

  for (const changedSymbol of changedSymbols) {
    if (!changedSymbol.signatureChanged || !isCallableChangedSymbol(changedSymbol)) {
      if (changedSymbol.signatureChanged) {
        incrementSkippedReason(diagnostics, "not_callable");
      }
      continue;
    }
    if (options.workBudget && !canStartReferenceLookup(options.workBudget)) {
      recordReferenceLookupOmitted(options.workBudget, 1);
      continue;
    }

    const parsedDefinition = await tryEnsureParsedContext(
      changedSymbol.file,
      index.parsed?.get(fileIdentityKey(changedSymbol.file)),
      index.languageExtensions,
      diagnostics,
    );
    if (!parsedDefinition) {
      continue;
    }
    if (!supportsCallCompatibilityLanguage(parsedDefinition.sup.id)) {
      if (diagnostics && !diagnostics.unsupportedLanguages.includes(parsedDefinition.sup.id)) {
        diagnostics.unsupportedLanguages.push(parsedDefinition.sup.id);
      }
      incrementSkippedReason(diagnostics, "unsupported_language");
      continue;
    }
    const signature = extractCallableSignature({
      languageId: parsedDefinition.sup.id,
      source: parsedDefinition.source,
      symbolStartIndex: changedSymbol.range.start.index ?? 0,
      tree: parsedDefinition.tree,
    });
    if (!signature) {
      incrementSkippedReason(diagnostics, "signature_unknown");
      continue;
    }
    // Receiver-bearing declarations accept different argument counts per call form: a bound call
    // never passes the receiver, an unbound call does. Both arities are merged below so prototype
    // defaults apply to each.
    const unboundSignature = extractCallableSignature({
      languageId: parsedDefinition.sup.id,
      source: parsedDefinition.source,
      symbolStartIndex: changedSymbol.range.start.index ?? 0,
      tree: parsedDefinition.tree,
      binding: "unbound",
    });
    const hasDistinctUnboundForm =
      unboundSignature !== null &&
      (unboundSignature.minArgs !== signature.minArgs || unboundSignature.maxArgs !== signature.maxArgs);
    const arityTargets: CallableSignature[] =
      hasDistinctUnboundForm && unboundSignature ? [signature, unboundSignature] : [signature];
    const cppBinding = changedCppCallableBinding(index, changedSymbol, parsedDefinition);
    const equivalentBindings = cppBinding ? cppEquivalentCallableBindings(cppBinding) : undefined;
    const hasOverloads =
      cppBinding && equivalentBindings
        ? equivalentBindings.length !== (cppBinding.sameScopeFunctionBindings?.length ?? 1)
        : hasSameFileOverloadCandidates(index, changedSymbol, parsedDefinition);
    if (hasOverloads) {
      incrementSkippedReason(diagnostics, "overload_set");
      continue;
    }
    const module = index.byFile.get(fileIdentityKey(changedSymbol.file));
    const referenceDef: SymbolDef = module?.locals.find(
      (local) => local.kind === changedSymbol.kind && sameRangeStart(local.range, changedSymbol.range),
    ) ?? {
      file: changedSymbol.file,
      localName: changedSymbol.name,
      kind: changedSymbol.kind,
      range: changedSymbol.range,
    };
    const equivalentDefinitions =
      parsedDefinition.sup.id === "cpp"
        ? await getCppEquivalentCallableDefinitions(index, referenceDef, parsedDefinition)
        : undefined;
    // Default arguments can live on a prototype rather than its definition.
    // Both sites describe the same accepted range.
    if (equivalentDefinitions) {
      for (const definition of equivalentDefinitions) {
        const startIndex = definition.range.start.index;
        if (startIndex === undefined) continue;
        const parsed =
          fileIdentityKey(definition.file) === fileIdentityKey(referenceDef.file)
            ? parsedDefinition
            : await tryEnsureParsedContext(
                definition.file,
                index.parsed?.get(fileIdentityKey(definition.file)),
                index.languageExtensions,
                diagnostics,
              );
        if (!parsed) continue;
        const node = parsed.tree.rootNode.descendantForIndex(startIndex, startIndex);
        const shape = cppCallableShapeForNode(node);
        if (!shape) continue;
        for (const target of arityTargets) {
          target.minArgs = Math.min(target.minArgs, shape.minArity);
          if (target.maxArgs === null || shape.maxArity === null) {
            target.maxArgs = null;
          } else {
            target.maxArgs = Math.max(target.maxArgs, shape.maxArity);
          }
        }
      }
    }

    const changedStartIndex = changedSymbol.range.start.index;
    const declarationNode =
      changedStartIndex === undefined ? null : callableDeclarationAt(parsedDefinition.tree, changedStartIndex);
    const declarationKind = declarationNode
      ? getCallableDeclarationKind({
          languageId: parsedDefinition.sup.id,
          source: parsedDefinition.source,
          declaration: declarationNode,
        })
      : null;
    const ownerTypeName = declarationNode ? ownerTypeNameOf(declarationNode, parsedDefinition.source) : null;

    const referenceScanLimit = referenceScanLimitForCallsites(options.maxRefs);
    if (options.workBudget) {
      recordReferenceLookupStarted(options.workBudget);
    }
    const referenceResult = await (options.referenceCache
      ? options.referenceCache.getUsages(index, referenceDef, { maxReferences: referenceScanLimit })
      : findUsageReferences(index, { def: referenceDef }, { maxReferences: referenceScanLimit }));
    let refs: Reference[] = [];
    const shouldIncludeReference = options.shouldIncludeReference ?? (() => true);
    if (referenceResult.status === "ok") {
      refs = referenceResult.references.filter((ref) => shouldIncludeReference(ref.file));
    }

    const seenRefs = new Set(
      refs.map((ref) => `${fileIdentityKey(ref.file)}:${ref.range.start.line}:${ref.range.start.column}`),
    );
    const hints: CallCompatibilityHint[] = [];
    let consideredCallsites = 0;

    const addHintForReference = async (ref: Reference): Promise<void> => {
      if (consideredCallsites >= options.maxRefs) {
        return;
      }
      const hint = await buildCallCompatibilityHintForReference({
        index,
        changedSymbol,
        signature,
        unboundSignature: hasDistinctUnboundForm ? unboundSignature : null,
        declarationKind,
        ownerTypeName,
        ref,
        callerRangeIndex,
        diagnostics,
        ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      });
      if (!hint) {
        return;
      }
      consideredCallsites += 1;
      hints.push(hint);
    };

    for (const ref of refs) {
      if (consideredCallsites >= options.maxRefs) {
        break;
      }
      await addHintForReference(ref);
    }

    const shouldRunVerifiedScan =
      consideredCallsites < options.maxRefs &&
      (parsedDefinition.sup.id === "c" ||
        parsedDefinition.sup.id === "cpp" ||
        referenceResult.status !== "ok" ||
        !consideredCallsites);
    if (shouldRunVerifiedScan) {
      const verifiedScanLimit = Math.max(
        0,
        Math.min(referenceScanLimit - refs.length, options.maxRefs - consideredCallsites),
      );
      if (verifiedScanLimit) {
        const verifiedCallsites = await collectVerifiedCallsiteReferences(
          index,
          changedSymbol,
          verifiedScanLimit,
          shouldIncludeReference,
          diagnostics,
          parsedDefinition,
          equivalentDefinitions,
          seenRefs,
        );
        for (const ref of verifiedCallsites) {
          if (consideredCallsites >= options.maxRefs) {
            break;
          }
          const key = `${fileIdentityKey(ref.file)}:${ref.range.start.line}:${ref.range.start.column}`;
          if (seenRefs.has(key)) {
            continue;
          }
          seenRefs.add(key);
          await addHintForReference(ref);
        }
      }
    }

    if (hints.length) {
      changedSymbol.callCompatibility = hints;
      if (diagnostics) {
        diagnostics.emittedHints += hints.length;
      }
    }
  }
}
