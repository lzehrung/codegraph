import fsp from "node:fs/promises";
import path from "node:path";
import { LANG_CONFIGS } from "../bootstrap/treeSitterLanguages.js";
import { chunkFile } from "../chunking/chunkFile.js";
import { chunkSFCFile } from "../chunking/chunkSFC.js";
import { chunkTextFile } from "../chunking/chunkTextFile.js";
import type { Chunk } from "../chunking/types.js";
import { supportForFile } from "../languages.js";
import { parseSourceLocationInput } from "../util/sourceLocation.js";
import {
  exitWithError,
  type CliCwdContext,
  type CliJsonWriterContext,
  type CliOptionContext,
  type CliPositionalsContext,
  type CliStderrExitContext,
  type CliStdoutWriterContext,
} from "./context.js";
import { parsePositiveIntegerOption } from "./options.js";
import { writeCliOutput } from "./pretty.js";

const chunkLanguageAliases: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
};

const chunkTextLanguageByExtension: Record<string, string> = {
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
};

const chunkLanguageHelp = Array.from(
  new Set([...Object.keys(LANG_CONFIGS).sort(), "vue", "svelte", "json", "yaml", "text"]),
).join(", ");

function normalizeChunkLanguageId(languageId: string): string {
  return chunkLanguageAliases[languageId] ?? languageId;
}
function formatChunkLine(chunk: Chunk): string {
  const lineRange = chunk.startLine === chunk.endLine ? `${chunk.startLine}` : `${chunk.startLine}-${chunk.endLine}`;
  const location = `${chunk.filePath ?? "(input)"}:${lineRange}`;
  let descriptor = chunk.type;
  if (chunk.name) {
    descriptor = `${descriptor} ${chunk.name}`;
  }
  return `- ${location} ${descriptor} (${chunk.tokenCount} tokens)`;
}

function formatChunkSummary(chunks: readonly Chunk[]): string {
  if (!chunks.length) {
    return "No chunks.";
  }
  return [`${chunks.length} chunk(s).`, ...chunks.map(formatChunkLine)].join("\n");
}

export type ChunkCommandContext = CliPositionalsContext &
  CliOptionContext &
  CliCwdContext &
  CliJsonWriterContext &
  CliStdoutWriterContext &
  CliStderrExitContext;

export async function handleChunkCommand(context: ChunkCommandContext): Promise<void> {
  const inputFilePath = context.positionals[0];
  if (!inputFilePath) {
    context.writeStderrLine("Usage: chunk <file-path> [options]");
    context.writeStderrLine("Options:");
    context.writeStderrLine("  --min-tokens N    Minimum tokens per chunk (default: 150)");
    context.writeStderrLine("  --max-tokens N    Maximum tokens per chunk (default: 400)");
    context.writeStderrLine(`  --language LANG   Language override (${chunkLanguageHelp})`);
    context.writeStderrLine("  --text            Force text chunking mode");
    context.exit(2);
  }
  const languageOverride = context.getOpt("--language");
  if (languageOverride) {
    const languageId = normalizeChunkLanguageId(languageOverride);
    const isSupported =
      languageId === "vue" || languageId === "svelte" || languageId === "text" || !!LANG_CONFIGS[languageId];
    if (!isSupported) {
      context.writeStderrLine(
        `Unsupported --language value "${languageId}". Supported languages: ${chunkLanguageHelp}.`,
      );
      context.exit(2);
    }
  }

  try {
    const filePath = path.resolve(context.cwd(), parseSourceLocationInput(inputFilePath).file);
    const source = await fsp.readFile(filePath, "utf8");
    const ext = path.extname(filePath).toLowerCase();

    let languageId: string;
    if (!languageOverride) {
      const support = supportForFile(filePath);
      languageId = support ? normalizeChunkLanguageId(support.id) : chunkTextLanguageByExtension[ext] || "text";
    } else {
      languageId = normalizeChunkLanguageId(languageOverride);
    }

    const forceText = context.hasFlag("--text");
    const minTokensRaw = context.getOpt("--min-tokens");
    const maxTokensRaw = context.getOpt("--max-tokens");
    const minTokens = parsePositiveIntegerOption(minTokensRaw, "--min-tokens", 150);
    const maxTokens = parsePositiveIntegerOption(maxTokensRaw, "--max-tokens", 400);
    if (maxTokens < minTokens) {
      throw new Error(
        `Invalid --max-tokens value "${maxTokens}". Expected a value greater than or equal to --min-tokens.`,
      );
    }

    const isSFC = languageId === "vue" || languageId === "svelte";
    if (forceText || (!isSFC && !LANG_CONFIGS[languageId])) {
      writeCliOutput(
        context,
        chunkTextFile({
          source,
          filePath,
          languageId,
          minTokens,
          maxTokens,
        }),
        formatChunkSummary,
      );
      return;
    }

    if (isSFC) {
      writeCliOutput(
        context,
        chunkSFCFile({
          source,
          filePath,
          framework: languageId as "vue" | "svelte",
          minTokens,
          maxTokens,
        }),
        formatChunkSummary,
      );
      return;
    }

    const langConfig = LANG_CONFIGS[languageId];
    if (!langConfig) {
      context.writeStderrLine(`Unsupported language: ${languageId}`);
      context.exit(1);
    }
    writeCliOutput(
      context,
      chunkFile({
        language: langConfig,
        source,
        filePath,
        minTokens,
        maxTokens,
      }),
      formatChunkSummary,
    );
  } catch (error) {
    exitWithError(context, error, 1, "Chunking failed");
  }
}
