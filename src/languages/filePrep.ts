import fsp from "node:fs/promises";
import type { JsLanguage } from "../languages/types.js";

import {
  JS_SUPPORT,
  TS_SUPPORT,
  TSX_SUPPORT,
  supportForFile,
  supportById,
  type LanguageSupport,
} from "../languages.js";
import {
  prepareSFCScriptSource,
  detectSFCFramework,
  type SFCFramework,
} from "./sfc.js";

interface ParserInput {
  source: string;
  sup: LanguageSupport;
  lang: JsLanguage;
}

interface SourceInput {
  source: string;
  sup: LanguageSupport;
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
  opts?: { source?: string },
): Promise<ParserInput> {
  const prepared = await prepareSourceInput(file, opts);
  return {
    ...prepared,
    lang: prepared.sup.language(file),
  };
}

export async function prepareSourceInput(
  file: string,
  opts?: { source?: string },
): Promise<SourceInput> {
  const framework = detectSFCFramework(file);
  if (framework) {
    const rawSource = opts?.source ?? (await fsp.readFile(file, "utf8"));
    return prepareSFCSourceInput(rawSource, framework);
  }

  const sup = supportForFile(file);
  if (!sup) throw new UnsupportedParserInputError(file);
  const rawSource = opts?.source ?? (await fsp.readFile(file, "utf8"));
  return {
    source: rawSource,
    sup,
  };
}

export function isUnsupportedParserInputError(
  error: unknown,
): error is UnsupportedParserInputError {
  return error instanceof UnsupportedParserInputError;
}

function prepareSFCSourceInput(
  source: string,
  framework: SFCFramework,
): SourceInput {
  const { maskedSource, scriptLangId } = prepareSFCScriptSource(
    source,
    framework,
  );
  const sup =
    SCRIPT_SUPPORT_MAP[scriptLangId] ?? supportById(scriptLangId) ?? JS_SUPPORT;
  return {
    source: maskedSource,
    sup,
  };
}
