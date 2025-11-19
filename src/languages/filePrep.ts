import fsp from "node:fs/promises";
import type Parser from "tree-sitter";

import {
  JS_SUPPORT,
  TS_SUPPORT,
  TSX_SUPPORT,
  supportForFile,
  supportById,
  type LanguageSupport,
} from "../languages.js";
import { prepareSFCScriptSource, detectSFCFramework, type SFCFramework } from "./sfc.js";

interface ParserInput {
  source: string;
  sup: LanguageSupport;
  lang: Parser.Language;
}

const SCRIPT_SUPPORT_MAP: Record<string, LanguageSupport> = {
  js: JS_SUPPORT,
  ts: TS_SUPPORT,
  tsx: TSX_SUPPORT,
};

export async function prepareParserInput(file: string, opts?: { source?: string }): Promise<ParserInput> {
  const rawSource = opts?.source ?? (await fsp.readFile(file, "utf8"));
  const framework = detectSFCFramework(file);
  if (framework) {
    return prepareSFCParserInput(file, rawSource, framework);
  }

  const sup = supportForFile(file);
  return {
    source: rawSource,
    sup,
    lang: sup.language(file),
  };
}

async function prepareSFCParserInput(
  file: string,
  source: string,
  framework: SFCFramework
): Promise<ParserInput> {
  const { maskedSource, scriptLangId } = prepareSFCScriptSource(source, framework);
  const sup =
    SCRIPT_SUPPORT_MAP[scriptLangId] ?? supportById(scriptLangId) ?? JS_SUPPORT;
  return {
    source: maskedSource,
    sup,
    lang: sup.language(file),
  };
}


