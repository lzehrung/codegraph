import { isGraphOnlyLanguage } from "../document-links.js";
import { createHash } from "node:crypto";
import type { LanguageExtensionMap } from "../languages.js";
import { prepareSourceInput, type PreparedSFCEmbeddedBlock } from "../languages/file-prep.js";
import {
  getNativeExtractionExecution,
  getNativeSyntaxTreeExecution,
  type NativeQueryResults,
  type NativeSyntaxTree,
} from "../native/tree-sitter-native.js";
import type { NativeFallbackReason } from "../native/contracts.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import type { LanguageSupport } from "../languages.js";
import type { SyntaxTreeLike } from "../languages/types.js";
import { DEFAULT_NATIVE_SOURCE_MAX_BYTES } from "../native/source-limits.js";

export type ParsedFileContext = {
  source: string;
  tree: SyntaxTreeLike;
  sup: LanguageSupport;
  nativeQueries?: NativeQueryResults | null;
  embeddedBlocks?: PreparedSFCEmbeddedBlock[];
};

export type ParsedFileCacheEntry = {
  source: string;
  tree: SyntaxTreeLike;
  sup: LanguageSupport | undefined;
  nativeQueries?: NativeQueryResults | null;
};

export type PreparedFileContext = {
  file: string;
  source: string;
  originalSource?: string;
  sup: LanguageSupport;
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

/** A query parse could not produce a syntax tree, even though the source was readable. */
export class SyntaxTreeUnavailableError extends Error {
  /**
   * Set only for the native node or depth projection limit, and only to that native message.
   * Other failures, including a source over the byte limit, leave it unset so callers still throw.
   */
  readonly projectionLimit: string | undefined;

  constructor(file: string, reason: string, projectionLimit?: string) {
    super(`Failed to reconstruct native syntax tree for ${file}: ${reason}`);
    this.name = "SyntaxTreeUnavailableError";
    this.projectionLimit = projectionLimit;
  }
}

const SYNTAX_PROJECTION_LIMIT = /^syntax tree projection exceeded max (?:node|depth) limit \(\d+\)$/;

/** The native projection-limit message, or undefined when `message` is a different failure. */
export function syntaxProjectionLimitDetail(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return SYNTAX_PROJECTION_LIMIT.exec(message)?.[0];
}

/** True when `error` is the native projection limit, not another syntax-tree failure. */
export function isSyntaxProjectionLimitError(
  error: unknown,
): error is SyntaxTreeUnavailableError & { readonly projectionLimit: string } {
  if (!(error instanceof SyntaxTreeUnavailableError)) return false;
  const limit = error.projectionLimit;
  return typeof limit === "string" && syntaxProjectionLimitDetail(limit) === limit;
}

/** SHA-256 of the source text a projection-limit fact was recorded for. */
export function sourceContentFingerprint(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

/** Consumer-facing reason. It names the failure and does not include a file path. */
export function syntaxTreeUnavailablePublicReason(
  error: SyntaxTreeUnavailableError & { readonly projectionLimit: string },
): string {
  return `Syntax tree unavailable: ${error.projectionLimit}`;
}

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
    childForFieldNameAt: () => null,
    descendantForIndex: () => rootNode,
    descendantForPosition: () => rootNode,
  };
  return {
    rootNode,
  };
}
export function attemptParsePreparedFileContext(context: PreparedFileContext): PreparedFileParseAttempt {
  const { source, sup, nativeQueries, embeddedBlocks } = context;
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
    };
  }
  if (context.syntaxTree) {
    return {
      parsed: {
        source,
        tree: new ProjectedSyntaxTree(source, context.syntaxTree),
        sup,
        ...(embeddedBlocks ? { embeddedBlocks } : {}),
        nativeQueries,
      },
    };
  }
  if (Buffer.byteLength(source, "utf8") > DEFAULT_NATIVE_SOURCE_MAX_BYTES) {
    return {
      parsed: null,
      nativeFallbackReason: "sourceTooLarge",
      ...(context.nativeError ? { nativeError: context.nativeError } : {}),
    };
  }
  const projectionLimit = syntaxProjectionLimitDetail(context.nativeError);
  if (projectionLimit) {
    return {
      parsed: null,
      nativeFallbackReason: context.nativeFallbackReason ?? "queryFailure",
      ...(context.nativeError ? { nativeError: context.nativeError } : {}),
    };
  }
  const nativeTreeExecution = getNativeSyntaxTreeExecution(source, sup);
  if (nativeTreeExecution.tree) {
    return {
      parsed: {
        source,
        tree: new ProjectedSyntaxTree(source, nativeTreeExecution.tree),
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
  const projectionLimit = syntaxProjectionLimitDetail(attempt.nativeError);
  throw new SyntaxTreeUnavailableError(
    context.file,
    attempt.nativeError ?? attempt.nativeFallbackReason ?? "no tree",
    projectionLimit,
  );
}

export async function prepareFileForIndexing(
  file: string,
  languageExtensions?: LanguageExtensionMap,
  source?: string,
  support?: LanguageSupport,
): Promise<PreparedFileContext> {
  const prep = await prepareSourceInput(file, {
    languageExtensions,
    ...(source !== undefined ? { source } : {}),
    ...(support ? { support } : {}),
  });
  if (isGraphOnlyLanguage(prep.sup.id)) {
    return {
      file,
      source: prep.source,
      sup: prep.sup,
      ...(prep.embeddedBlocks ? { embeddedBlocks: prep.embeddedBlocks } : {}),
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
      nativeQueries: null,
      nativeFallbackReason: "sourceTooLarge",
      nativeError: `source exceeds native byte limit (${sourceBytes} > ${DEFAULT_NATIVE_SOURCE_MAX_BYTES})`,
    };
  }
  // One combined native call for queries and the syntax tree: they're independent native
  // functions, each backed by its own Tree-sitter parse, so calling them separately parses
  // the file twice. The worker path already avoids this via `extractLanguage`; this is the
  // same call for the non-worker path (small projects below the worker auto-threshold, and
  // SFC files, which are never routed to workers). Populating `syntaxTree` here lets
  // `attemptParsePreparedFileContext`'s existing `if (context.syntaxTree)` branch reuse it
  // instead of triggering a second parse via `getNativeSyntaxTreeExecution`.
  const nativeExecution = getNativeExtractionExecution(prep.source, prep.sup);

  return {
    file,
    source: prep.source,
    ...(prep.originalSource !== undefined ? { originalSource: prep.originalSource } : {}),
    sup: prep.sup,
    ...(prep.embeddedBlocks ? { embeddedBlocks: prep.embeddedBlocks } : {}),
    nativeQueries: nativeExecution.results,
    syntaxTree: nativeExecution.tree,
    ...(nativeExecution.fallbackReason ? { nativeFallbackReason: nativeExecution.fallbackReason } : {}),
    ...(nativeExecution.error ? { nativeError: nativeExecution.error } : {}),
  };
}

export async function parseFile(file: string): Promise<ParsedFileContext> {
  return parsePreparedFileContext(await prepareFileForIndexing(file));
}

/** Query-time navigation needs the syntax tree, not the indexer's native query captures. */
export async function parseNavigationContext(
  file: string,
  languageExtensions?: LanguageExtensionMap,
  source?: string,
): Promise<ParsedFileContext> {
  const prepared = await prepareSourceInput(file, { languageExtensions, ...(source !== undefined ? { source } : {}) });
  const context: PreparedFileContext = { file, source: prepared.source, sup: prepared.sup, nativeQueries: null };
  if (prepared.embeddedBlocks) context.embeddedBlocks = prepared.embeddedBlocks;
  return parsePreparedFileContext(context);
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
      nativeQueries: parsedEntry.nativeQueries ?? null,
    };
  }
  return parsePreparedFileContext(await prepareFileForIndexing(file, languageExtensions));
}
