import fsp from "node:fs/promises";
import type { ParserLanguage } from "../languages/types.js";

import { JS_SUPPORT, TS_SUPPORT, TSX_SUPPORT, supportForFile, supportById } from "../languages.js";
import type { LanguageExtensionMap, LanguageSupport } from "../languages.js";
import {
  buildSvelteTemplateBlocks,
  detectSFCFramework,
  parseSFC,
  prepareSFCBlockSource,
  prepareSFCScriptSource,
  styleLanguageKey,
  templateLanguageKey,
} from "./sfc.js";
import type { SFCBlock, SFCFramework } from "./sfc.js";

interface ParserInput {
  source: string;
  sup: LanguageSupport;
  lang: ParserLanguage;
}

export interface PreparedSFCEmbeddedBlock {
  block: SFCBlock;
  source: string;
  sup: LanguageSupport;
}

export interface SourceInput {
  source: string;
  sup: LanguageSupport;
  embeddedBlocks?: PreparedSFCEmbeddedBlock[];
}

export class UnsupportedParserInputError extends Error {
  readonly file: string;

  constructor(file: string) {
    super(`Unsupported file extension: ${file}`);
    this.name = "UnsupportedParserInputError";
    this.file = file;
  }
}

const SCRIPT_SUPPORT_MAP: Record<string, LanguageSupport> = {
  js: JS_SUPPORT,
  ts: TS_SUPPORT,
  tsx: TSX_SUPPORT,
};

export async function prepareParserInput(
  file: string,
  opts?: { source?: string | undefined; languageExtensions?: LanguageExtensionMap | undefined },
): Promise<ParserInput> {
  const prepared = await prepareSourceInput(file, opts);
  return {
    ...prepared,
    lang: prepared.sup.language(file),
  };
}

export async function prepareSourceInput(
  file: string,
  opts?: { source?: string | undefined; languageExtensions?: LanguageExtensionMap | undefined },
): Promise<SourceInput> {
  const framework = detectSFCFramework(file);
  if (framework) {
    const rawSource = opts?.source ?? (await fsp.readFile(file, "utf8"));
    return prepareSFCSourceInput(rawSource, framework);
  }

  const sup = supportForFile(file, opts?.languageExtensions);
  if (!sup) throw new UnsupportedParserInputError(file);
  const rawSource = opts?.source ?? (await fsp.readFile(file, "utf8"));
  return {
    source: rawSource,
    sup,
  };
}

export function isUnsupportedParserInputError(error: unknown): error is UnsupportedParserInputError {
  return error instanceof UnsupportedParserInputError;
}

function prepareSFCSourceInput(source: string, framework: SFCFramework): SourceInput {
  const { maskedSource, scriptLangId } = prepareSFCScriptSource(source, framework);
  const sup = SCRIPT_SUPPORT_MAP[scriptLangId] ?? supportById(scriptLangId) ?? JS_SUPPORT;
  const parsedBlocks = parseSFC(source);
  const blocks =
    framework === "svelte" ? [...parsedBlocks, ...buildSvelteTemplateBlocks(source, parsedBlocks)] : parsedBlocks;
  const embeddedBlocks = prepareEmbeddedSFCBlocks(source, framework, blocks);
  return {
    source: maskedSource,
    sup,
    ...(embeddedBlocks.length ? { embeddedBlocks } : {}),
  };
}

function prepareEmbeddedSFCBlocks(
  source: string,
  framework: SFCFramework,
  blocks: SFCBlock[],
): PreparedSFCEmbeddedBlock[] {
  const prepared: PreparedSFCEmbeddedBlock[] = [];
  for (const block of blocks) {
    let languageId: "css" | "scss" | "less" | "html" | null = null;
    if (block.type === "style") {
      languageId = styleLanguageKey(block);
    } else if (block.type === "template") {
      languageId = templateLanguageKey(framework);
    }
    if (!languageId) continue;

    const sup = supportById(languageId);
    if (!sup) continue;
    prepared.push({
      block,
      source: prepareSFCBlockSource(source, block),
      sup,
    });
  }
  return prepared;
}
