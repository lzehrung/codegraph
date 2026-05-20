import fsp from "node:fs/promises";
import path from "node:path";
import { LANG_CONFIGS } from "../bootstrap/treeSitterLanguages.js";
import { chunkFile } from "../chunking/chunkFile.js";
import { chunkSFCFile } from "../chunking/chunkSFC.js";
import { chunkTextFile } from "../chunking/chunkTextFile.js";
import { supportForFile } from "../languages.js";
import { parsePositiveIntegerOption } from "./options.js";

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

export type ChunkCommandContext = {
  positionals: string[];
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  cwd: () => string;
  writeJSONLine: (value: unknown) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

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

  try {
    const filePath = path.resolve(context.cwd(), inputFilePath);
    const source = await fsp.readFile(filePath, "utf8");
    const ext = path.extname(filePath).toLowerCase();

    let languageId = context.getOpt("--language");
    if (!languageId) {
      const support = supportForFile(filePath);
      languageId = support ? normalizeChunkLanguageId(support.id) : chunkTextLanguageByExtension[ext] || "text";
    } else {
      languageId = normalizeChunkLanguageId(languageId);
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
      context.writeJSONLine(
        chunkTextFile({
          source,
          filePath,
          languageId,
          minTokens,
          maxTokens,
        }),
      );
      return;
    }

    if (isSFC) {
      context.writeJSONLine(
        chunkSFCFile({
          source,
          filePath,
          framework: languageId as "vue" | "svelte",
          minTokens,
          maxTokens,
        }),
      );
      return;
    }

    const langConfig = LANG_CONFIGS[languageId];
    if (!langConfig) {
      context.writeStderrLine(`Unsupported language: ${languageId}`);
      context.exit(1);
    }
    context.writeJSONLine(
      chunkFile({
        language: langConfig,
        source,
        filePath,
        minTokens,
        maxTokens,
      }),
    );
  } catch (error) {
    context.writeStderrLine(`Chunking failed: ${error instanceof Error ? error.message : String(error)}`);
    context.exit(1);
  }
}
