import { isGraphOnlyLanguage } from "../documentLinks.js";
import { prepareSourceInput } from "../languages/filePrep.js";
import {
  assertNativeRequiredAvailable,
  getNativeQueryExecution,
  getNativeSyntaxTreeExecution,
  type NativeQueryResults,
  type NativeRuntimeMode,
} from "../native/treeSitterNative.js";
import type { NativeFallbackReason } from "../native/contracts.js";
import { ProjectedSyntaxTree } from "../native/projectedTree.js";
import type { LanguageSupport } from "../languages.js";
import type { JsLanguage, SyntaxTreeLike } from "../languages/types.js";

export type ParsedFileContext = {
  source: string;
  tree: SyntaxTreeLike;
  sup: LanguageSupport;
  lang?: JsLanguage;
  nativeQueries?: NativeQueryResults | null;
};

export type ParsedFileCacheEntry = {
  source: string;
  tree: SyntaxTreeLike;
  sup: LanguageSupport | undefined;
  lang?: JsLanguage;
  nativeQueries?: NativeQueryResults | null;
};

export type PreparedFileContext = {
  file: string;
  source: string;
  sup: LanguageSupport;
  lang?: JsLanguage;
  nativeMode?: NativeRuntimeMode;
  nativeQueries: NativeQueryResults | null;
  nativeFallbackReason?: NativeFallbackReason;
  nativeError?: string;
};

export type PreparedFileParseAttempt = {
  parsed: ParsedFileContext | null;
  nativeFallbackReason?: NativeFallbackReason;
  nativeError?: string;
  jsError?: string;
};
function createGraphOnlySyntaxTree(): SyntaxTreeLike {
  const rootNode = {
    type: "document",
    text: "",
    startIndex: 0,
    endIndex: 0,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 0 },
    parent: null,
    namedChildren: [],
    child: () => null,
    childForFieldName: () => null,
    descendantForIndex: () => rootNode,
    descendantForPosition: () => rootNode,
  };
  return {
    rootNode,
  };
}

export function attemptParsePreparedFileContext(context: PreparedFileContext): PreparedFileParseAttempt {
  const { file, source, sup, nativeMode, nativeQueries } = context;
  const graphOnlyLanguage = isGraphOnlyLanguage(sup.id);
  if (graphOnlyLanguage) {
    return {
      parsed: {
        source,
        tree: createGraphOnlySyntaxTree(),
        sup,
        nativeQueries,
      },
      nativeFallbackReason: "unsupportedLanguage",
    };
  }
  const nativeTreeExecution = getNativeSyntaxTreeExecution(source, sup, nativeMode);
  if (nativeTreeExecution.tree) {
    return {
      parsed: {
        source,
        tree: new ProjectedSyntaxTree(source, nativeTreeExecution.tree),
        sup,
        nativeQueries,
      },
    };
  }
  return {
    parsed: null,
    ...(nativeTreeExecution.fallbackReason ? { nativeFallbackReason: nativeTreeExecution.fallbackReason } : {}),
    ...(nativeTreeExecution.error ? { nativeError: nativeTreeExecution.error } : {}),
  };
}

export function tryParsePreparedFileContext(context: PreparedFileContext): ParsedFileContext | null {
  return attemptParsePreparedFileContext(context).parsed;
}

export function parsePreparedFileContext(context: PreparedFileContext): ParsedFileContext {
  const parsed = tryParsePreparedFileContext(context);
  if (parsed) return parsed;
  throw new Error(`Failed to reconstruct syntax tree for ${context.file}`);
}

export async function prepareFileForIndexing(file: string, native?: NativeRuntimeMode): Promise<PreparedFileContext> {
  const prep = await prepareSourceInput(file);
  if (isGraphOnlyLanguage(prep.sup.id)) {
    assertNativeRequiredAvailable(native);
    return {
      file,
      source: prep.source,
      sup: prep.sup,
      ...(native ? { nativeMode: native } : {}),
      nativeQueries: null,
    };
  }

  const nativeExecution = getNativeQueryExecution(prep.source, prep.sup, native);

  return {
    file,
    source: prep.source,
    sup: prep.sup,
    ...(native ? { nativeMode: native } : {}),
    nativeQueries: nativeExecution.results,
    ...(nativeExecution.fallbackReason ? { nativeFallbackReason: nativeExecution.fallbackReason } : {}),
    ...(nativeExecution.error ? { nativeError: nativeExecution.error } : {}),
  };
}

export async function parseFile(file: string): Promise<ParsedFileContext> {
  return parsePreparedFileContext(await prepareFileForIndexing(file));
}

export async function ensureParsedContext(
  file: string,
  parsedEntry?: ParsedFileCacheEntry,
): Promise<ParsedFileContext> {
  if (parsedEntry?.sup) {
    return {
      source: parsedEntry.source,
      tree: parsedEntry.tree,
      sup: parsedEntry.sup,
      ...(parsedEntry.lang ? { lang: parsedEntry.lang } : {}),
      nativeQueries: parsedEntry.nativeQueries ?? null,
    };
  }
  return parsePreparedFileContext(await prepareFileForIndexing(file));
}
