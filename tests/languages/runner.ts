import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { chunkFile } from "../../src/chunking/chunkFile.js";
import { LANG_CONFIGS } from "../../src/bootstrap/treeSitterLanguages.js";
import type { LanguageTestDefinition } from "./types.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const tokenize = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

export function runLanguageTests(def: LanguageTestDefinition) {
  describe(`Language: ${def.id}`, () => {
    for (const sample of def.samples) {
      it(sample.name, () => {
        const config = LANG_CONFIGS[def.id];
        if (!config) {
          throw new Error(`Language config not found for ${def.id}`);
        }

        let source = sample.source;
        let filePath = `test.${def.id}`;

        if (sample.sourceFile) {
          const fullPath = path.join(dirname, "samples", sample.sourceFile);
          source = fs.readFileSync(fullPath, "utf8");
          filePath = sample.sourceFile;
        }

        if (source === undefined) {
          throw new Error(`No source provided for sample ${sample.name}`);
        }

        const chunks = chunkFile({
          language: config,
          source: source.trimStart(),
          filePath,
          minTokens: sample.options?.minTokens ?? 1,
          maxTokens: sample.options?.maxTokens ?? 1000,
          tokenizer: tokenize,
        });

        sample.expectedChunks(chunks);
      });
    }
  });
}
