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
}

type BalancedRange = {
  start: number;
  end: number;
  inner: string;
};

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

function splitTopLevelCommaGroups(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const groups: string[] = [];
  let groupStart = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
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

    const atTopLevel = !parenDepth && !bracketDepth && !braceDepth;
    if (char === "," && atTopLevel) {
      groups.push(text.slice(groupStart, index).trim());
      groupStart = index + 1;
    }
  }

  if (quote || parenDepth || bracketDepth || braceDepth) {
    return null;
  }

  groups.push(text.slice(groupStart).trim());
  return groups;
}

function hasTopLevelChar(text: string, needle: string): boolean {
  const groups = splitTopLevelCommaGroups(text);
  if (!groups) {
    return false;
  }
  const onlyGroup = groups[0];
  return groups.length === 1 && Boolean(onlyGroup?.includes(needle));
}

function isOptionalParameter(parameter: string): boolean {
  const colonIndex = parameter.indexOf(":");
  let searchText = parameter;
  if (colonIndex >= 0) {
    searchText = parameter.slice(0, colonIndex);
  }
  return searchText.includes("?") || hasTopLevelChar(parameter, "=");
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

  const parameters = splitTopLevelCommaGroups(balanced.inner);
  if (!parameters) {
    return null;
  }

  let minArgs = 0;
  let hasRest = false;
  for (const parameter of parameters) {
    const trimmed = parameter.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("...")) {
      hasRest = true;
      continue;
    }
    if (!isOptionalParameter(trimmed)) {
      minArgs += 1;
    }
  }

  const maxArgs = hasRest ? null : parameters.length;
  return { minArgs, maxArgs, confidence: "high" };
}

export function extractCallsiteArguments(request: ExtractCallsiteArgumentsRequest): CallsiteArguments | null {
  if (!isJsTsLanguage(request.languageId)) {
    return null;
  }

  const openIndex = findOpeningParen(request.source, request.calleeStartIndex);
  const balanced = findBalancedParentheses(request.source, openIndex);
  if (!balanced) {
    return null;
  }

  const args = splitTopLevelCommaGroups(balanced.inner);
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
  return symbol.kind === SymbolKind.Function || symbol.kind === SymbolKind.Default;
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
      { maxReferences: options.maxRefs },
    );
    if (refs.status !== "ok") {
      continue;
    }

    const hints: CallCompatibilityHint[] = [];
    for (const ref of refs.references) {
      if (ref.file === changedSymbol.file && sameRangeStart(ref.range, changedSymbol.range)) {
        continue;
      }

      const calleeStartIndex = ref.range.start.index;
      if (calleeStartIndex === undefined) {
        continue;
      }

      const parsedCallsite = await ensureParsedContext(ref.file, index.parsed?.get(ref.file));
      const actual = extractCallsiteArguments({
        languageId: parsedCallsite.sup.id,
        source: parsedCallsite.source,
        calleeStartIndex,
      });
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
