import path from "node:path";
import { findReferences, goToDefinition } from "../indexer/navigation.js";
import { ensureParsedContext } from "../indexer/parse-context.js";
import { SymbolKind, type ProjectIndex, type Reference, type SymbolDef } from "../indexer/types.js";
import { supportForFile } from "../languages.js";
import { isJsTsLanguage } from "../languages/js-family.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import { sliceText, toRange } from "../util/ast.js";
import { fileIdentityKey } from "../util/paths.js";
import {
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
  type AngleMode,
  findOpeningParen,
  findSignatureOpeningParen,
  findCommentEnd,
  findCallOpeningParen,
  findBalancedParentheses,
  canStartRegexLiteral,
  findRegexLiteralEnd,
  splitTopLevelCommaGroups
} from "./call-compatibility/textScanner.js";

function supportsCallCompatibilityLanguage(languageId: string): boolean {
  return getCallCompatibilityProvider(languageId) !== null;
}
import type { ReferenceLookupCache } from "./referenceCache.js";
import {
  directSignatureParameterNode,
  findAncestorOfTypes,
  findFirstDescendantOfTypes,
} from "./signature-node-utils.js";
import type { CallCompatibilityHint, ChangedSymbol, ImpactDiagnostics } from "./types.js";
import {
  canStartReferenceLookup,
  recordReferenceLookupOmitted,
  recordReferenceLookupStarted,
  type ImpactWorkBudget,
} from "./budgets.js";

export type {
  CallableSignature,
  CallsiteArguments,
  ExtractCallableSignatureRequest,
  ExtractCallsiteArgumentsRequest,
} from "./call-compatibility/types.js";

interface SignatureParameterText {
  text: string;
  skipFirstReceiver: boolean;
}

interface CallsiteArgumentText {
  text: string;
  trailingArgumentCount: number;
}

function referenceScanLimitForCallsites(maxRefs: number): number {
  return Math.max(maxRefs + 50, maxRefs * 4);
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

function isOptionalParameter(parameter: string): boolean {
  const colonIndex = parameter.indexOf(":");
  let searchText = parameter;
  if (colonIndex >= 0) {
    searchText = parameter.slice(0, colonIndex);
  }
  return searchText.includes("?") || hasTopLevelEquals(parameter);
}

function isThisParameter(parameter: string): boolean {
  const colonIndex = parameter.indexOf(":");
  if (colonIndex < 0) {
    return parameter.trim() === "this";
  }
  return parameter.slice(0, colonIndex).trim() === "this";
}

const callableDeclarationTypes = new Set([
  "function_declaration",
  "function_definition",
  "function_item",
  "method",
  "singleton_method",
  "method_declaration",
  "constructor_declaration",
  "init_declaration",
  "protocol_function_declaration",
  "arrow_function",
  "function",
  "function_expression",
  "variable_declarator",
  "declaration",
]);

const callableVariableValueTypes = new Set(["arrow_function", "function_expression", "function"]);

const parameterListTypes = new Set([
  "parameters",
  "parameter_list",
  "formal_parameters",
  "function_value_parameters",
  "method_parameters",
]);

function isPythonMethodDeclaration(declaration: SyntaxNodeLike): boolean {
  let current = declaration.parent;
  while (current) {
    if (current.type === "class_definition") {
      return true;
    }
    if (current.type === "function_definition") {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function shouldSkipFirstReceiverParameter(languageId: string, declaration: SyntaxNodeLike): boolean {
  if (languageId === "python") {
    return isPythonMethodDeclaration(declaration);
  }
  return true;
}

function findSignatureParameterText(request: ExtractCallableSignatureRequest): SignatureParameterText | null {
  if (!request.tree) {
    return null;
  }

  const node = request.tree.rootNode.descendantForIndex(request.symbolStartIndex, request.symbolStartIndex);
  const declaration = findAncestorOfTypes(node, callableDeclarationTypes);
  if (!declaration) {
    return null;
  }

  let params = directSignatureParameterNode(declaration);
  if (!params && declaration.type === "variable_declarator") {
    const valueNode = declaration.childForFieldName("value");
    if (!valueNode || !callableVariableValueTypes.has(valueNode.type)) {
      return null;
    }
    params = directSignatureParameterNode(valueNode) ?? findFirstDescendantOfTypes(valueNode, parameterListTypes);
  }
  if (!params) {
    params = findFirstDescendantOfTypes(declaration, parameterListTypes);
  }
  if (!params) {
    if (request.languageId === "swift") {
      const parameterNodes = declaration.namedChildren.filter((child) => child.type === "parameter");
      const first = parameterNodes[0];
      const last = parameterNodes[parameterNodes.length - 1];
      if (first && last) {
        return {
          text: request.source.slice(first.startIndex, last.endIndex),
          skipFirstReceiver: shouldSkipFirstReceiverParameter(request.languageId, declaration),
        };
      }
    }
    return {
      text: "",
      skipFirstReceiver: shouldSkipFirstReceiverParameter(request.languageId, declaration),
    };
  }

  const text = request.source.slice(params.startIndex, params.endIndex).trim();
  if (text.startsWith("(") && text.endsWith(")")) {
    return {
      text: text.slice(1, -1),
      skipFirstReceiver: shouldSkipFirstReceiverParameter(request.languageId, declaration),
    };
  }
  return {
    text,
    skipFirstReceiver: shouldSkipFirstReceiverParameter(request.languageId, declaration),
  };
}

function isReceiverParameter(
  languageId: string,
  parameter: string,
  index: number,
  skipFirstReceiver: boolean,
): boolean {
  if (!skipFirstReceiver) {
    return false;
  }
  const trimmed = parameter.trim();
  if (!index && (languageId === "python" || languageId === "ruby")) {
    return trimmed === "self" || trimmed === "cls" || trimmed.startsWith("self:") || trimmed.startsWith("cls:");
  }
  if (!index && languageId === "rust") {
    return trimmed === "self" || trimmed === "&self" || trimmed === "&mut self" || trimmed.startsWith("self:");
  }
  if (isJsTsLanguage(languageId)) {
    return isThisParameter(trimmed);
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

    if (canStartRegexLiteral(text, index, 0)) {
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

function isParameterSeparator(languageId: string, parameter: string): boolean {
  const trimmed = parameter.trim();
  return languageId === "python" && (trimmed === "/" || trimmed === "*");
}

function isRestParameter(languageId: string, parameter: string): boolean {
  const trimmed = parameter.trim();
  if (!trimmed) {
    return false;
  }
  if (hasTopLevelEllipsis(trimmed)) {
    return true;
  }
  if (languageId === "python" || languageId === "ruby") {
    return trimmed.startsWith("*") || trimmed.startsWith("**");
  }
  if (languageId === "csharp") {
    return /\bparams\b/.test(trimmed);
  }
  if (languageId === "kotlin") {
    return /\bvararg\b/.test(trimmed);
  }
  return false;
}

function isOptionalParameterForLanguage(languageId: string, parameter: string): boolean {
  const trimmed = parameter.trim();
  if (!trimmed) {
    return false;
  }
  if (isJsTsLanguage(languageId)) {
    return isOptionalParameter(trimmed);
  }
  if (languageId === "ruby" && /^[A-Za-z_]\w*:\s*\S/.test(trimmed)) {
    return true;
  }
  return hasTopLevelEquals(trimmed);
}

function parameterSlotCount(languageId: string, parameter: string): number {
  const trimmed = parameter.trim();
  if (!trimmed) {
    return 0;
  }
  if ((languageId === "c" || languageId === "cpp") && trimmed === "void") {
    return 0;
  }
  return 1;
}

function signatureFromParameterText(
  languageId: string,
  parameterText: string,
  angleMode: AngleMode,
  skipFirstReceiver = true,
): CallableSignature | null {
  const parameters = splitTopLevelCommaGroups(parameterText, angleMode, languageId !== "python");
  if (!parameters) {
    return null;
  }

  let minArgs = 0;
  let maxArgs = 0;
  let positionalArgCount = 0;
  let hasRest = false;

  parameters.forEach((parameter, index) => {
    const trimmed = parameter.trim();
    if (
      !trimmed ||
      isParameterSeparator(languageId, trimmed) ||
      isReceiverParameter(languageId, trimmed, index, skipFirstReceiver)
    ) {
      return;
    }
    if (isRestParameter(languageId, trimmed)) {
      hasRest = true;
      return;
    }
    if (languageId === "ruby" && /^[A-Za-z_]\w*:/.test(trimmed)) {
      maxArgs += 1;
      if (!isOptionalParameterForLanguage(languageId, trimmed)) {
        minArgs += 1;
      }
      return;
    }
    const slotCount = parameterSlotCount(languageId, trimmed);
    if (!slotCount) {
      return;
    }
    positionalArgCount += slotCount;
    maxArgs += slotCount;
    if (!isOptionalParameterForLanguage(languageId, trimmed)) {
      minArgs = positionalArgCount;
    }
  });

  return { minArgs, maxArgs: hasRest ? null : maxArgs, confidence: "high" };
}

function extractCallableSignatureFromProvider(request: ExtractCallableSignatureRequest): CallableSignature | null {
  if (!supportsCallCompatibilityLanguage(request.languageId)) {
    return null;
  }

  const astParameterText = findSignatureParameterText(request);
  if (astParameterText !== null) {
    return signatureFromParameterText(
      request.languageId,
      astParameterText.text,
      "type-context",
      astParameterText.skipFirstReceiver,
    );
  }

  if (!isJsTsLanguage(request.languageId)) {
    return null;
  }

  const openIndex = findSignatureOpeningParen(request.source, request.symbolStartIndex);
  const balanced = findBalancedParentheses(request.source, openIndex);
  if (!balanced) {
    return null;
  }

  return signatureFromParameterText(request.languageId, balanced.inner, "type-context");
}

function extractCallsiteArgumentsFromProvider(request: ExtractCallsiteArgumentsRequest): CallsiteArguments | null {
  if (!supportsCallCompatibilityLanguage(request.languageId)) {
    return null;
  }

  const astArgumentText = findCallsiteArgumentText(request);
  if (astArgumentText !== null) {
    return callsiteFromArgumentText(request.languageId, astArgumentText.text, astArgumentText.trailingArgumentCount);
  }

  if (!isJsTsLanguage(request.languageId)) {
    return null;
  }

  const openIndex = findCallOpeningParen(request.source, request.calleeStartIndex, request.calleeEndIndex);
  const balanced = findBalancedParentheses(request.source, openIndex);
  if (!balanced) {
    return null;
  }

  return callsiteFromArgumentText(request.languageId, balanced.inner);
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

const callExpressionTypes = new Set([
  "call_expression",
  "call",
  "method_invocation",
  "invocation_expression",
  "function_call_expression",
  "object_creation_expression",
]);

const argumentListTypes = new Set(["argument_list", "arguments", "value_arguments", "call_suffix"]);

function countTrailingClosureArguments(text: string): number | null {
  let startIndex = 0;
  let count = 0;

  while (startIndex < text.length) {
    while (/\s/.test(text[startIndex] ?? "")) {
      startIndex += 1;
    }
    if (startIndex === text.length) {
      return count;
    }
    if (text[startIndex] !== "{") {
      return null;
    }

    let braceDepth = 0;
    let quote: string | null = null;
    let escaped = false;
    let closed = false;
    for (let index = startIndex; index < text.length; index += 1) {
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
          return null;
        }
        index = commentEnd - 1;
        continue;
      }

      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") {
        braceDepth += 1;
        continue;
      }
      if (char === "}") {
        braceDepth -= 1;
        if (braceDepth < 0) {
          return null;
        }
        if (!braceDepth) {
          startIndex = index + 1;
          count += 1;
          closed = true;
          break;
        }
      }
    }
    if (!closed) {
      return null;
    }
  }

  return count;
}

function findCallsiteArgumentText(request: ExtractCallsiteArgumentsRequest): CallsiteArgumentText | null {
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

  const argumentNode =
    callNode.childForFieldName("arguments") ??
    callNode.namedChildren.find((child) => argumentListTypes.has(child.type)) ??
    findFirstDescendantOfTypes(callNode, argumentListTypes);
  if (argumentNode) {
    let text = request.source.slice(argumentNode.startIndex, argumentNode.endIndex).trim();
    let trailingArgumentCount = 0;
    const callSuffix =
      argumentNode.type === "call_suffix"
        ? argumentNode
        : findFirstDescendantOfTypes(callNode, new Set(["call_suffix"]));
    const valueArguments =
      argumentNode.type === "value_arguments"
        ? argumentNode
        : findFirstDescendantOfTypes(callSuffix ?? argumentNode, new Set(["value_arguments"]));
    if (valueArguments) {
      const trailingEndIndex = callSuffix?.endIndex ?? callNode.endIndex;
      const trailingText = request.source.slice(valueArguments.endIndex, trailingEndIndex).trim();
      const count = countTrailingClosureArguments(trailingText);
      if (count === null) {
        return null;
      }
      text = request.source.slice(valueArguments.startIndex, valueArguments.endIndex).trim();
      trailingArgumentCount = count;
    }
    if (text.startsWith("(") && text.endsWith(")")) {
      return { text: text.slice(1, -1), trailingArgumentCount };
    }
    return { text, trailingArgumentCount };
  }

  if (request.languageId === "zig") {
    const openIndex = findOpeningParen(request.source, callNode.startIndex);
    const balanced = findBalancedParentheses(request.source, openIndex);
    return balanced ? { text: balanced.inner, trailingArgumentCount: 0 } : null;
  }

  return null;
}

function hasUncountableSpreadArgument(languageId: string, arg: string): boolean {
  const trimmed = arg.trim();
  if (trimmed.startsWith("...")) {
    return true;
  }
  if (languageId === "python" || languageId === "ruby") {
    return trimmed.startsWith("*") || trimmed.startsWith("**");
  }
  if (languageId === "php") {
    return trimmed.startsWith("...");
  }
  return false;
}

function callsiteFromArgumentText(
  languageId: string,
  argumentText: string,
  trailingArgumentCount = 0,
): CallsiteArguments | null {
  const args = splitTopLevelCommaGroups(argumentText, "type-context");
  if (!args) {
    return null;
  }

  for (const arg of args) {
    if (hasUncountableSpreadArgument(languageId, arg)) {
      return null;
    }
  }

  return { argCount: args.length + trailingArgumentCount, confidence: "high" };
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

function hasSameFileOverloadCandidates(
  index: ProjectIndex,
  changedSymbol: ChangedSymbol,
  languageId: string,
  source: string,
  tree: SyntaxTreeLike,
): boolean {
  const module = index.byFile.get(fileIdentityKey(changedSymbol.file));
  if (!module) {
    return false;
  }

  const changedStartIndex = changedSymbol.range.start.index;
  if (changedStartIndex === undefined) {
    return false;
  }
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
      languageId,
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

function findCallerSymbolId(index: ProjectIndex, ref: Reference): string | undefined {
  const startIndex = ref.range.start.index;
  if (startIndex === undefined) {
    return undefined;
  }

  const module = index.byFile.get(fileIdentityKey(ref.file));
  if (!module) {
    return undefined;
  }

  let best: SymbolDef | undefined;
  for (const local of module.locals) {
    if (!rangeContainsIndex(local.range, startIndex)) {
      continue;
    }
    if (!best) {
      best = local;
      continue;
    }

    const localSpan = (local.range.end.index ?? 0) - (local.range.start.index ?? 0);
    const bestSpan = (best.range.end.index ?? 0) - (best.range.start.index ?? 0);
    if (localSpan < bestSpan) {
      best = local;
    }
  }

  if (!best) {
    return undefined;
  }
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

async function collectVerifiedCallsiteReferences(
  index: ProjectIndex,
  changedSymbol: ChangedSymbol,
  maxRefs: number,
  shouldIncludeReference: (file: string) => boolean,
  diagnostics: ImpactDiagnostics["callCompatibility"] | undefined,
): Promise<Reference[]> {
  const refs: Reference[] = [];
  const seen = new Set<string>();

  for (const module of index.byFile.values()) {
    const file = module.file;
    if (refs.length >= maxRefs) {
      break;
    }
    if (!shouldIncludeReference(file)) {
      continue;
    }
    const support = supportForFile(file);
    if (!support || !supportsCallCompatibilityLanguage(support.id)) {
      continue;
    }
    const parsed = await tryEnsureParsedContext(file, index.parsed?.get(fileIdentityKey(file)), diagnostics);
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
            const result = await goToDefinition(index, {
              file,
              line: gotoNode.startPosition.row + 1,
              column: gotoNode.startPosition.column + 1,
            });
            if (result.status === "ok") {
              const def: SymbolDef = {
                file: changedSymbol.file,
                localName: changedSymbol.name,
                kind: changedSymbol.kind,
                range: changedSymbol.range,
              };
              if (sameDefinition(result.definition, def)) {
                const range = toRange(gotoNode);
                const key = `${fileIdentityKey(file)}:${range.start.line}:${range.start.column}`;
                if (!seen.has(key)) {
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

async function tryEnsureParsedContext(
  file: string,
  parsedEntry: Parameters<typeof ensureParsedContext>[1],
  diagnostics: ImpactDiagnostics["callCompatibility"] | undefined,
): Promise<Awaited<ReturnType<typeof ensureParsedContext>> | null> {
  try {
    return await ensureParsedContext(file, parsedEntry);
  } catch {
    incrementSkippedReason(diagnostics, "parse-failed");
    return null;
  }
}

function incrementSkippedReason(diagnostics: ImpactDiagnostics["callCompatibility"] | undefined, reason: string): void {
  if (!diagnostics) {
    return;
  }
  diagnostics.skippedByReason[reason] = (diagnostics.skippedByReason[reason] ?? 0) + 1;
}

async function buildCallCompatibilityHintForReference(input: {
  index: ProjectIndex;
  changedSymbol: ChangedSymbol;
  signature: CallableSignature;
  ref: Reference;
  diagnostics?: ImpactDiagnostics["callCompatibility"] | undefined;
  projectRoot?: string | undefined;
}): Promise<CallCompatibilityHint | null> {
  const { index, changedSymbol, signature, ref, diagnostics, projectRoot } = input;
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

  const compatibility = classifyCompatibility(signature, actual);
  const callerSymbolId = findCallerSymbolId(index, ref);
  const callsiteFile = projectRoot ? path.relative(projectRoot, ref.file).replace(/\\/g, "/") : ref.file;
  return {
    ...compatibility,
    changedSymbolId: changedSymbol.id,
    callsiteFile,
    callsiteRange: ref.range,
    ...(callerSymbolId ? { callerSymbolId } : {}),
    expected: signature,
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
    if (
      hasSameFileOverloadCandidates(
        index,
        changedSymbol,
        parsedDefinition.sup.id,
        parsedDefinition.source,
        parsedDefinition.tree,
      )
    ) {
      incrementSkippedReason(diagnostics, "overload_set");
      continue;
    }

    const referenceScanLimit = referenceScanLimitForCallsites(options.maxRefs);
    const referenceDef = {
      file: changedSymbol.file,
      localName: changedSymbol.name,
      kind: changedSymbol.kind,
      range: changedSymbol.range,
    };
    if (options.workBudget) {
      recordReferenceLookupStarted(options.workBudget);
    }
    const referenceResult = await (options.referenceCache
      ? options.referenceCache.get(index, referenceDef, { maxReferences: referenceScanLimit })
      : findReferences(index, { def: referenceDef }, { maxReferences: referenceScanLimit }));
    let refs: Reference[] = [];
    const shouldIncludeReference = options.shouldIncludeReference ?? (() => true);
    if (referenceResult.status === "ok") {
      refs = referenceResult.references.filter((ref) => shouldIncludeReference(ref.file));
    }

    const seenRefs = new Set(refs.map((ref) => `${ref.file}:${ref.range.start.line}:${ref.range.start.column}`));
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
        ref,
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
      consideredCallsites < options.maxRefs && (referenceResult.status !== "ok" || !consideredCallsites);
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
        );
        for (const ref of verifiedCallsites) {
          if (consideredCallsites >= options.maxRefs) {
            break;
          }
          const key = `${ref.file}:${ref.range.start.line}:${ref.range.start.column}`;
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
