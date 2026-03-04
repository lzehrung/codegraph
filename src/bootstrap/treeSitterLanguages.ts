import {
  makeLanguageConfig,
  type LanguageConfig,
} from "../chunking/languageConfig.js";
import { getAllLanguages } from "../languages/registry.js";
import "../languages/all.js";

export type { LanguageConfig };

const idToConfigKey: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  tsx: "tsx",
  python: "python",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  ruby: "ruby",
  go: "go",
  java: "java",
  csharp: "csharp",
  rust: "rust",
  c: "c",
  cpp: "cpp",
  kotlin: "kotlin",
  swift: "swift",
};

export const LANG_CONFIGS: Record<string, LanguageConfig> = {};

for (const lang of getAllLanguages()) {
  const key = idToConfigKey[lang.id] || lang.id;
  // Skip languages that are not used for direct semantic chunking
  if (lang.id === "vue" || lang.id === "svelte") continue;
  LANG_CONFIGS[key] = makeLanguageConfig(lang);
}
