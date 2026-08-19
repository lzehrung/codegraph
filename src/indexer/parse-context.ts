import { isGraphOnlyLanguage } from "../documentLinks.js";
import type { LanguageExtensionMap } from "../languages.js";
import { prepareSourceInput, type PreparedSFCEmbeddedBlock } from "../languages/filePrep.js";
import {
  getNativeQueryExecution,
  getNativeSyntaxTreeExecution,
  type NativeQueryResults,
  type NativeRuntimeMode,
  type NativeSyntaxTree,
} from "../native/treeSitterNative.js";
import type { NativeFallbackReason } from "../native/contracts.js";
import { ProjectedSyntaxTree } from "../native/projectedTree.js";
import type { LanguageSupport } from "../languages.js";
import type { ParserLanguage, SyntaxTreeLike } from "../languages/types.js";
import { DEFAULT_NATIVE_SOURCE_MAX_BYTES } from "../worker/nativeExtractWorker.js";

export type ParsedFileContext = {
  source: string;
  tree: SyntaxTreeLike;
  sup: LanguageSupport;
  lang?: ParserLanguage;
  nativeQueries?: NativeQueryResults | null;
  embeddedBlocks?: PreparedSFCEmbeddedBlock[];
};

export type ParsedFileCacheEntry = {
  source: string;
  tree: SyntaxTreeLike;
  sup: LanguageSupport | undefined;
  lang?: ParserLanguage;
  nativeQueries?: NativeQueryResults | null;
};

export type PreparedFileContext = {
  file: string;
  source: string;
  sup: LanguageSupport;
  lang?: ParserLanguage;
  nativeMode?: NativeRuntimeMode;
  embeddedBlocks?: PreparedSFCEmbeddedBlock[];
  nativeQueries: NativeQueryResults | null;
  /** Transferable native tree POJO from workers; avoids a second parse on the main thread. */
  syntaxTree?: NativeSyntaxTree | null;
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
  const rootNode: SyntaxTreeLike["rootNode"] = {
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
  const { file, source, sup, nativeMode, nativeQueries, embeddedBlocks } = context;
  const graphOnlyLanguage = isGraphOnlyLanguage(sup.id);
  if (graphOnlyLanguage) {
    return {
      parsed: {
        source,
        tree: createGraphOnlySyntaxTree(),
        sup,
        ...(embeddedBlocks ? { embeddedBlocks } : {}),
        nativeQueries,
      },
      nativeFallbackReason: "unsupportedLanguage",
    };
  }
  if (context.syntaxTree) {
    return {
      parsed: {
        source,
        tree: new ProjectedSyntaxTree(source, context.syntaxTree),
        ...(context.lang ? { lang: context.lang } : {}),
        sup,
        ...(embeddedBlocks ? { embeddedBlocks } : {}),
        nativeQueries,
      },
    };
  }
  if (context.nativeError?.startsWith("source exceeds native byte limit")) {
    return {
      parsed: null,
      nativeFallbackReason: "queryFailure",
      nativeError: context.nativeError,
    };
  }
  const nativeTreeExecution = getNativeSyntaxTreeExecution(source, sup, nativeMode);
  if (nativeTreeExecution.tree) {
    return {
      parsed: {
        source,
        tree: new ProjectedSyntaxTree(source, nativeTreeExecution.tree),
        ...(context.lang ? { lang: context.lang } : {}),
        sup,
        ...(embeddedBlocks ? { embeddedBlocks } : {}),
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
  const attempt = attemptParsePreparedFileContext(context);
  if (attempt.parsed) return attempt.parsed;
  if (context.nativeMode !== "on") {
    return {
      source: context.source,
      tree: createGraphOnlySyntaxTree(),
      sup: context.sup,
      ...(context.embeddedBlocks ? { embeddedBlocks: context.embeddedBlocks } : {}),
      nativeQueries: context.nativeQueries,
    };
  }
  throw new Error(`Failed to reconstruct syntax tree for ${context.file}`);
}

export async function prepareFileForIndexing(
  file: string,
  native?: NativeRuntimeMode,
  languageExtensions?: LanguageExtensionMap,
  source?: string,
): Promise<PreparedFileContext> {
  const prep = await prepareSourceInput(file, { languageExtensions, ...(source !== undefined ? { source } : {}) });
  if (isGraphOnlyLanguage(prep.sup.id)) {
    return {
      file,
      source: prep.source,
      sup: prep.sup,
      ...(prep.embeddedBlocks ? { embeddedBlocks: prep.embeddedBlocks } : {}),
      ...(native ? { nativeMode: native } : {}),
      nativeQueries: null,
    };
  }

  const sourceBytes = Buffer.byteLength(prep.source, "utf8");
  if (sourceBytes > DEFAULT_NATIVE_SOURCE_MAX_BYTES) {
    return {
      file,
      source: prep.source,
      sup: prep.sup,
      ...(prep.embeddedBlocks ? { embeddedBlocks: prep.embeddedBlocks } : {}),
      ...(native ? { nativeMode: native } : {}),
      nativeQueries: null,
      nativeFallbackReason: "queryFailure",
      nativeError: `source exceeds native byte limit (${sourceBytes} > ${DEFAULT_NATIVE_SOURCE_MAX_BYTES})`,
    };
  }
  const nativeExecution = getNativeQueryExecution(prep.source, prep.sup, native);

  return {
    file,
    source: prep.source,
    sup: prep.sup,
    ...(prep.embeddedBlocks ? { embeddedBlocks: prep.embeddedBlocks } : {}),
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
  languageExtensions?: LanguageExtensionMap,
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
  return parsePreparedFileContext(await prepareFileForIndexing(file, undefined, languageExtensions));
}
