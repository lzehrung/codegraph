import { makeLanguageConfig, type LanguageConfig } from "../chunking/languageConfig.js";
import { JAVASCRIPT_DEF } from "../languages/definitions/javascript.js";
import { PYTHON_DEF } from "../languages/definitions/python.js";
import { TYPESCRIPT_DEF, TSX_DEF } from "../languages/definitions/typescript.js";

export type { LanguageConfig };

export const LANG_CONFIGS: Record<string, LanguageConfig> = {
  javascript: makeLanguageConfig(JAVASCRIPT_DEF),
  typescript: makeLanguageConfig(TYPESCRIPT_DEF),
  tsx: makeLanguageConfig(TSX_DEF),
  python: makeLanguageConfig(PYTHON_DEF),
};
