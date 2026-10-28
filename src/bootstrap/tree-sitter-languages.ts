import { makeLanguageConfig, type LanguageConfig } from "../chunking/language-config.js";
import { getAllLanguages } from "../languages/registry.js";
import "../languages/all.js";

export type { LanguageConfig };

const CHUNK_LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
};

/** The `LANG_CONFIGS` key for a language id: `js` and `ts` are keyed by their full names. */
export function chunkLanguageKey(id: string): string {
  return CHUNK_LANGUAGE_ALIASES[id] ?? id;
}

export const LANG_CONFIGS: Record<string, LanguageConfig> = {};

for (const lang of getAllLanguages()) {
  const key = chunkLanguageKey(lang.id);
  // Skip languages that are not used for direct semantic chunking
  if (
    lang.id === "vue" ||
    lang.id === "svelte" ||
    lang.id === "markdown" ||
    lang.id === "mdx" ||
    lang.id === "astro" ||
    lang.id === "hbs" ||
    lang.id === "rst" ||
    lang.id === "adoc"
  ) {
    continue;
  }
  LANG_CONFIGS[key] = makeLanguageConfig(lang, key);
}
