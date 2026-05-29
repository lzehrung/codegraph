import path from "node:path";
import { findReferences, goToDefinition } from "../indexer/navigation.js";
import { ensureParsedContext } from "../indexer/parse-context.js";
import { SymbolKind, type ProjectIndex, type Reference, type SymbolDef } from "../indexer/types.js";
import { supportForFile } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import { sliceText, toRange } from "../util/ast.js";
import {
  getCallCompatibilityProvider,
  getCallCompatibilitySupportedLanguages,
  registerCallCompatibilityExtractors,
} from "./call-compatibility/providers/index.js";
import type { CallCompatibilityHint, ChangedSymbol, ImpactDiagnostics } from "./types.js";

export interface CallableSignature {
  minArgs: number;
  maxArgs: number | null;
  confidence: "high";
}

export interface ExtractCallableSignatureRequest {
  languageId: string;
  source: string;
  symbolStartIndex: number;
  tree?: SyntaxTreeLike;
}

export interface CallsiteArguments {
  argCount: number;
  confidence: "high";
}

export interface ExtractCallsiteArgumentsRequest {
  languageId: string;
  source: string;
  calleeStartIndex: number;
  calleeEndIndex?: number;
  tree?: SyntaxTreeLike;
}

type BalancedRange = {
  start: number;
  end: number;
  inner: string;
};

type AngleMode = "always" | "type-context";

interface SignatureParameterText {
  text: string;
  skipFirstReceiver: boolean;
}

function isJsTsLanguage(languageId: string): boolean {
  return (
    languageId === "javascript" ||
    languageId === "typescript" ||
    languageId === "tsx" ||
    languageId === "jsx" ||
    languageId === "js" ||
    languageId === "ts"
  );
}

function supportsCallCompatibilityLanguage(languageId: string): boolean {
  return getCallCompatibilityProvider(languageId) !== null;
}

function findOpeningParen(source: string, startIndex: number): number {
  if (startIndex < 0 || startIndex >= source.length) {
    return -1;
  }
  return source.indexOf("(", startIndex);
}

function findSignatureOpeningParen(source: string, startIndex: number): number {
  if (startIndex < 0 || startIndex >= source.length) {
    return -1;
  }

  let quote: string | null = null;
  let escaped = false;
  let isTypeAnnotation = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];

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

    const commentEnd = findCommentEnd(source, index);
    if (commentEnd !== null) {
      if (commentEnd < 0) {
        return -1;
      }
      index = commentEnd - 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "<") {
      const closeIndex = findBalancedAngleBrackets(source, index);
      if (closeIndex < 0) {
        return -1;
      }
      index = closeIndex;
      continue;
    }
    if (char === ":") {
      isTypeAnnotation = true;
      continue;
    }
    if (char === "=") {
      if (source[index + 1] === ">") {
        index += 1;
        continue;
      }
      isTypeAnnotation = false;
      continue;
    }
    if (char === "(") {
      if (!isTypeAnnotation) {
        return index;
      }
      const balanced = findBalancedParentheses(source, index);
      if (!balanced) {
        return -1;
      }
      index = balanced.end - 1;
    }
  }

  return -1;
}

function findCommentEnd(source: string, index: number): number | null {
  if (source[index] !== "/") {
    return null;
  }

  const nextChar = source[index + 1];
  if (nextChar === "/") {
    const newlineIndex = source.indexOf("\n", index + 2);
    if (newlineIndex < 0) {
      return source.length;
    }
    return newlineIndex;
  }

  if (nextChar === "*") {
    const closeIndex = source.indexOf("*/", index + 2);
    if (closeIndex < 0) {
      return -1;
    }
    return closeIndex + 2;
  }

  return null;
}

function findCallOpeningParen(source: string, startIndex: number, endIndex?: number): number {
  if (endIndex === undefined) {
    return findOpeningParen(source, startIndex);
  }
  if (endIndex < startIndex || endIndex > source.length) {
    return -1;
  }

  let skippedWhitespace = false;
  for (let index = endIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === undefined) {
      return -1;
    }
    if (/\s/.test(char)) {
      skippedWhitespace = true;
      continue;
    }
    if (char === "(") {
      return index;
    }
    if (char === "<") {
      if (skippedWhitespace) {
        return -1;
      }
      const closeIndex = findBalancedAngleBrackets(source, index);
      if (closeIndex < 0) {
        return -1;
      }
      for (let afterGeneric = closeIndex + 1; afterGeneric < source.length; afterGeneric += 1) {
        const nextChar = source[afterGeneric];
        if (nextChar === undefined) {
          return -1;
        }
        if (/\s/.test(nextChar)) {
          continue;
        }
        if (nextChar === "(") {
          return afterGeneric;
        }
        return -1;
      }
      return -1;
    }
    return -1;
  }
  return -1;
}

function findBalancedAngleBrackets(source: string, openIndex: number): number {
  if (source[openIndex] !== "<") {
    return -1;
  }

  let depth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

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

    const commentEnd = findCommentEnd(source, index);
    if (commentEnd !== null) {
      if (commentEnd < 0) {
        return -1;
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
        return -1;
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
        return -1;
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
        return -1;
      }
      continue;
    }
    const atTopLevel = !parenDepth && !bracketDepth && !braceDepth;
    if (char === "<" && atTopLevel) {
      depth += 1;
      continue;
    }
    if (char === ">" && source[index - 1] !== "=" && atTopLevel) {
      depth -= 1;
      if (!depth) {
        return index;
      }
      if (depth < 0) {
        return -1;
      }
    }
  }

  return -1;
}

function findBalancedParentheses(source: string, openIndex: number): BalancedRange | null {
  if (openIndex < 0 || source[openIndex] !== "(") {
    return null;
  }

  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

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

    const commentEnd = findCommentEnd(source, index);
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
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (!depth) {
        return {
          start: openIndex,
          end: index + 1,
          inner: source.slice(openIndex + 1, index),
        };
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  return null;
}

function hasTypeContextBeforeLessThan(text: string, index: number, groupStart: number): boolean {
  const left = text.slice(groupStart, index).trimEnd();
  if (!left) {
    return false;
  }

  const typeKeywordPattern = /(^|[\s([{,:?=<>|&])(?:as|satisfies|new)\s+[A-Za-z_$][\w$.[\]\s]*$/;
  return typeKeywordPattern.test(left) || hasOpenTypeAnnotationBefore(text, index, groupStart);
}

function hasOpenTypeAnnotationBefore(text: string, index: number, groupStart: number): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: string | null = null;
  let escaped = false;
  let hasTypeAnnotation = false;

  for (let current = groupStart; current < index; current += 1) {
    const char = text[current];

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

    const commentEnd = findCommentEnd(text, current);
    if (commentEnd !== null) {
      if (commentEnd < 0) {
        return false;
      }
      current = commentEnd - 1;
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
    if (!atTopLevel) {
      continue;
    }
    if (char === ":") {
      hasTypeAnnotation = true;
      continue;
    }
    if (char === "=" && text[current + 1] !== ">") {
      hasTypeAnnotation = false;
    }
  }

  return hasTypeAnnotation;
}

function previousSignificantIndex(text: string, index: number, groupStart: number): number {
  for (let current = index - 1; current >= groupStart; current -= 1) {
    const char = text[current];
    if (char !== undefined && !/\s/.test(char)) {
      return current;
    }
  }
  return -1;
}

function previousSignificantChar(text: string, index: number, groupStart: number): string | null {
  const previousIndex = previousSignificantIndex(text, index, groupStart);
  if (previousIndex < 0) {
    return null;
  }
  return text[previousIndex] ?? null;
}

function previousSignificantCharBefore(text: string, index: number, groupStart: number): string | null {
  const previousIndex = previousSignificantIndex(text, index, groupStart);
  if (previousIndex < 0) {
    return null;
  }

  return previousSignificantChar(text, previousIndex, groupStart);
}

function canStartRegexLiteral(text: string, index: number, groupStart: number): boolean {
  if (text[index] !== "/" || text[index + 1] === "/" || text[index + 1] === "*") {
    return false;
  }

  const previous = previousSignificantChar(text, index, groupStart);
  if (!previous) {
    return true;
  }
  if (previous === ">" && previousSignificantCharBefore(text, index, groupStart) === "=") {
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

function splitTopLevelCommaGroups(text: string, angleMode: AngleMode): string[] | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const groups: string[] = [];
  let groupStart = 0;
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
        return null;
      }
      index = commentEnd - 1;
      continue;
    }

    if (canStartRegexLiteral(text, index, groupStart)) {
      const regexEnd = findRegexLiteralEnd(text, index);
      if (regexEnd === null) {
        return null;
      }
      if (regexEnd < 0) {
        return null;
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
        return null;
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
        return null;
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
        return null;
      }
      continue;
    }
    const atDelimiterTopLevel = !parenDepth && !bracketDepth && !braceDepth;
    if (
      char === "<" &&
      atDelimiterTopLevel &&
      (angleDepth || angleMode === "always" || hasTypeContextBeforeLessThan(text, index, groupStart))
    ) {
      angleDepth += 1;
      continue;
    }
    if (char === ">" && angleDepth && text[index - 1] !== "=" && atDelimiterTopLevel) {
      angleDepth -= 1;
      continue;
    }

    const atTopLevel = atDelimiterTopLevel && !angleDepth;
    if (char === "," && atTopLevel) {
      groups.push(text.slice(groupStart, index).trim());
      groupStart = index + 1;
    }
  }

  if (quote || parenDepth || bracketDepth || braceDepth || angleDepth) {
    return null;
  }

  groups.push(text.slice(groupStart).trim());
  if (groups.length && groups[groups.length - 1] === "") {
    groups.pop();
  }
  return groups;
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

function findAncestorOfTypes(node: SyntaxNodeLike | null, types: ReadonlySet<string>): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (types.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function findFirstDescendantOfTypes(node: SyntaxNodeLike, types: ReadonlySet<string>): SyntaxNodeLike | null {
  for (const child of node.namedChildren ?? []) {
    if (types.has(child.type)) {
      return child;
    }
    const found = findFirstDescendantOfTypes(child, types);
    if (found) {
      return found;
    }
  }
  return null;
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

function directSignatureParameterNode(node: SyntaxNodeLike): SyntaxNodeLike | null {
  return (
    node.childForFieldName("parameters") ??
    node.childForFieldName("params") ??
    node.childForFieldName("parameter") ??
    null
  );
}

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

function isRestParameter(languageId: string, parameter: string): boolean {
  const trimmed = parameter.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === "..." || trimmed.startsWith("...")) {
    return true;
  }
  if (languageId === "python" || languageId === "ruby") {
    return trimmed.startsWith("*") || trimmed.startsWith("**");
  }
  if (languageId === "go") {
    return trimmed.includes("...");
  }
  if (languageId === "csharp") {
    return /\bparams\b/.test(trimmed);
  }
  if (languageId === "kotlin") {
    return /\bvararg\b/.test(trimmed);
  }
  if (languageId === "swift") {
    return trimmed.endsWith("...");
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
  const parameters = splitTopLevelCommaGroups(parameterText, angleMode);
  if (!parameters) {
    return null;
  }

  let minArgs = 0;
  let maxArgs = 0;
  let positionalArgCount = 0;
  let hasRest = false;

  parameters.forEach((parameter, index) => {
    const trimmed = parameter.trim();
    if (!trimmed || isReceiverParameter(languageId, trimmed, index, skipFirstReceiver)) {
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
    return callsiteFromArgumentText(request.languageId, astArgumentText);
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

function findCallsiteArgumentText(request: ExtractCallsiteArgumentsRequest): string | null {
  if (!request.tree) {
    return null;
  }

  const endIndex = request.calleeEndIndex ?? request.calleeStartIndex;
  const node = request.tree.rootNode.descendantForIndex(request.calleeStartIndex, endIndex);
  const callNode = findAncestorOfTypes(node, callExpressionTypes);
  if (!callNode) {
    return null;
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
    if (argumentNode.type === "call_suffix") {
      const nested = findFirstDescendantOfTypes(argumentNode, new Set(["value_arguments"]));
      if (nested) {
        text = request.source.slice(nested.startIndex, nested.endIndex).trim();
      }
    }
    if (text.startsWith("(") && text.endsWith(")")) {
      return text.slice(1, -1);
    }
    return text;
  }

  if (request.languageId === "zig") {
    const openIndex = findOpeningParen(request.source, callNode.startIndex);
    const balanced = findBalancedParentheses(request.source, openIndex);
    return balanced?.inner ?? null;
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

function callsiteFromArgumentText(languageId: string, argumentText: string): CallsiteArguments | null {
  const args = splitTopLevelCommaGroups(argumentText, "type-context");
  if (!args) {
    return null;
  }

  for (const arg of args) {
    if (hasUncountableSpreadArgument(languageId, arg)) {
      return null;
    }
  }

  return { argCount: args.length, confidence: "high" };
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
    left.file === right.file &&
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
  const module = index.byFile.get(changedSymbol.file);
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

  const module = index.byFile.get(ref.file);
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
): Promise<Reference[]> {
  const refs: Reference[] = [];
  const seen = new Set<string>();

  for (const [file] of index.byFile) {
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
    const parsed = await ensureParsedContext(file, index.parsed?.get(file));

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
                const key = `${file}:${range.start.line}:${range.start.column}`;
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

function incrementSkippedReason(diagnostics: ImpactDiagnostics["callCompatibility"] | undefined, reason: string): void {
  if (!diagnostics) {
    return;
  }
  diagnostics.skippedByReason[reason] = (diagnostics.skippedByReason[reason] ?? 0) + 1;
}

export async function attachCallCompatibilityHints(
  index: ProjectIndex,
  changedSymbols: ChangedSymbol[],
  options: {
    maxRefs: number;
    projectRoot?: string;
    diagnostics?: ImpactDiagnostics;
    shouldIncludeReference?: (file: string) => boolean;
  },
): Promise<void> {
  for (const changedSymbol of changedSymbols) {
    delete changedSymbol.callCompatibility;
  }

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

    const parsedDefinition = await ensureParsedContext(changedSymbol.file, index.parsed?.get(changedSymbol.file));
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
    const referenceResult = await findReferences(
      index,
      {
        def: {
          file: changedSymbol.file,
          localName: changedSymbol.name,
          kind: changedSymbol.kind,
          range: changedSymbol.range,
        },
      },
      { maxReferences: referenceScanLimit },
    );
    let refs: Reference[] = [];
    const shouldIncludeReference = options.shouldIncludeReference ?? (() => true);
    if (referenceResult.status === "ok") {
      refs = referenceResult.references.filter((ref) => shouldIncludeReference(ref.file));
    }

    const seenRefs = new Set(refs.map((ref) => `${ref.file}:${ref.range.start.line}:${ref.range.start.column}`));
    const hints: CallCompatibilityHint[] = [];
    let consideredCallsites = 0;

    const addHintForReference = async (ref: Reference): Promise<void> => {
      if (ref.file === changedSymbol.file && sameRangeStart(ref.range, changedSymbol.range)) {
        return;
      }
      if (consideredCallsites >= options.maxRefs) {
        return;
      }

      const calleeStartIndex = ref.range.start.index;
      if (calleeStartIndex === undefined) {
        return;
      }

      const parsedCallsite = await ensureParsedContext(ref.file, index.parsed?.get(ref.file));
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
        return;
      }
      consideredCallsites += 1;

      const compatibility = classifyCompatibility(signature, actual);
      const callerSymbolId = findCallerSymbolId(index, ref);
      let callsiteFile = ref.file;
      if (options.projectRoot) {
        callsiteFile = path.relative(options.projectRoot, ref.file).replace(/\\/g, "/");
      }
      hints.push({
        ...compatibility,
        changedSymbolId: changedSymbol.id,
        callsiteFile,
        callsiteRange: ref.range,
        ...(callerSymbolId ? { callerSymbolId } : {}),
        expected: signature,
        actual,
      });
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
