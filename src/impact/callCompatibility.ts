import path from "node:path";
import { findReferences } from "../indexer/navigation.js";
import { ensureParsedContext } from "../indexer/parse-context.js";
import { SymbolKind, type ProjectIndex, type Reference, type SymbolDef } from "../indexer/types.js";
import type { Range } from "../types.js";
import type { CallCompatibilityHint, ChangedSymbol } from "./types.js";

export interface CallableSignature {
  minArgs: number;
  maxArgs: number | null;
  confidence: "high";
}

export interface ExtractCallableSignatureRequest {
  languageId: string;
  source: string;
  symbolStartIndex: number;
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
}

type BalancedRange = {
  start: number;
  end: number;
  inner: string;
};

type AngleMode = "always" | "type-context";

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

function findOpeningParen(source: string, startIndex: number): number {
  if (startIndex < 0 || startIndex >= source.length) {
    return -1;
  }
  return source.indexOf("(", startIndex);
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
  return typeKeywordPattern.test(left);
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
      (angleMode === "always" || hasTypeContextBeforeLessThan(text, index, groupStart))
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

export function extractCallableSignature(request: ExtractCallableSignatureRequest): CallableSignature | null {
  if (!isJsTsLanguage(request.languageId)) {
    return null;
  }

  const openIndex = findOpeningParen(request.source, request.symbolStartIndex);
  const balanced = findBalancedParentheses(request.source, openIndex);
  if (!balanced) {
    return null;
  }

  const parameters = splitTopLevelCommaGroups(balanced.inner, "always");
  if (!parameters) {
    return null;
  }

  let minArgs = 0;
  let hasRest = false;
  let maxArgs = 0;
  for (const parameter of parameters) {
    const trimmed = parameter.trim();
    if (!trimmed) {
      continue;
    }
    if (isThisParameter(trimmed)) {
      continue;
    }
    if (trimmed.startsWith("...")) {
      hasRest = true;
      continue;
    }
    maxArgs += 1;
    if (!isOptionalParameter(trimmed)) {
      minArgs += 1;
    }
  }

  return { minArgs, maxArgs: hasRest ? null : maxArgs, confidence: "high" };
}

export function extractCallsiteArguments(request: ExtractCallsiteArgumentsRequest): CallsiteArguments | null {
  if (!isJsTsLanguage(request.languageId)) {
    return null;
  }

  const openIndex = findCallOpeningParen(request.source, request.calleeStartIndex, request.calleeEndIndex);
  const balanced = findBalancedParentheses(request.source, openIndex);
  if (!balanced) {
    return null;
  }

  const args = splitTopLevelCommaGroups(balanced.inner, "type-context");
  if (!args) {
    return null;
  }

  for (const arg of args) {
    if (arg.trim().startsWith("...")) {
      return null;
    }
  }

  return { argCount: args.length, confidence: "high" };
}

function isCallableChangedSymbol(symbol: ChangedSymbol): boolean {
  return (
    symbol.kind === SymbolKind.Function || symbol.kind === SymbolKind.Default || symbol.kind === SymbolKind.Variable
  );
}

function sameRangeStart(left: Range, right: Range): boolean {
  const leftIndex = left.start.index;
  const rightIndex = right.start.index;
  return left.start.line === right.start.line && left.start.column === right.start.column && leftIndex === rightIndex;
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

export async function attachCallCompatibilityHints(
  index: ProjectIndex,
  changedSymbols: ChangedSymbol[],
  options: { maxRefs: number; projectRoot?: string },
): Promise<void> {
  if (options.maxRefs <= 0) {
    return;
  }

  for (const changedSymbol of changedSymbols) {
    if (!changedSymbol.signatureChanged || !isCallableChangedSymbol(changedSymbol)) {
      continue;
    }

    const parsedDefinition = await ensureParsedContext(changedSymbol.file, index.parsed?.get(changedSymbol.file));
    const signature = extractCallableSignature({
      languageId: parsedDefinition.sup.id,
      source: parsedDefinition.source,
      symbolStartIndex: changedSymbol.range.start.index ?? 0,
    });
    if (!signature) {
      continue;
    }

    const refs = await findReferences(
      index,
      {
        def: {
          file: changedSymbol.file,
          localName: changedSymbol.name,
          kind: changedSymbol.kind,
          range: changedSymbol.range,
        },
      },
      { maxReferences: options.maxRefs + 1 },
    );
    if (refs.status !== "ok") {
      continue;
    }

    const hints: CallCompatibilityHint[] = [];
    let consideredCallsites = 0;
    for (const ref of refs.references) {
      if (ref.file === changedSymbol.file && sameRangeStart(ref.range, changedSymbol.range)) {
        continue;
      }
      if (consideredCallsites >= options.maxRefs) {
        break;
      }
      consideredCallsites += 1;

      const calleeStartIndex = ref.range.start.index;
      if (calleeStartIndex === undefined) {
        continue;
      }

      const parsedCallsite = await ensureParsedContext(ref.file, index.parsed?.get(ref.file));
      const callsiteRequest: ExtractCallsiteArgumentsRequest = {
        languageId: parsedCallsite.sup.id,
        source: parsedCallsite.source,
        calleeStartIndex,
        ...(ref.range.end.index !== undefined ? { calleeEndIndex: ref.range.end.index } : {}),
      };
      const actual = extractCallsiteArguments(callsiteRequest);
      if (!actual) {
        continue;
      }

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
    }

    if (hints.length) {
      changedSymbol.callCompatibility = hints;
    }
  }
}
