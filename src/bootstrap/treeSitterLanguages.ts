import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import tsLanguages from "tree-sitter-typescript";

import type { Language } from "tree-sitter";

import { makeLanguageConfig, type LanguageConfig } from "../chunking/languageConfig.js";

export type { LanguageConfig };

const dirname = path.dirname(fileURLToPath(import.meta.url));

function readQuery(relPath: string): string {
  const fullPath = path.join(dirname, "..", "treeSitter", "queries", relPath);
  return fs.readFileSync(fullPath, "utf8");
}

const jsQuery = readQuery("javascript-blocks.scm");
const tsQuery = readQuery("typescript-blocks.scm");
const tsxQuery = readQuery("tsx-blocks.scm");
const pyQuery = readQuery("python-blocks.scm");

const LangJS = JavaScript as unknown as Language;
const LangPY = Python as unknown as Language;
const LangTS = tsLanguages.typescript as unknown as Language;
const LangTSX = tsLanguages.tsx as unknown as Language;

export const LANG_CONFIGS: Record<string, LanguageConfig> = {
  javascript: makeLanguageConfig("javascript", LangJS, jsQuery),
  typescript: makeLanguageConfig("typescript", LangTS, tsQuery),
  tsx: makeLanguageConfig("tsx", LangTSX, tsxQuery),
  python: makeLanguageConfig("python", LangPY, pyQuery),
};

