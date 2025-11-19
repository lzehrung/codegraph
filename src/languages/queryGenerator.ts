import type { LanguageDefinition } from "./types.js";

/**
 * Generates a Tree-sitter query string for semantic chunking based on the language definition.
 */
export function generateChunkingQuery(def: LanguageDefinition): string {
  const parts: string[] = [];

  // 1. Comments
  if (def.structure.comments.length > 0) {
    parts.push(`;; ----- Comments -----`);
    for (const type of def.structure.comments) {
      parts.push(`(${type}) @chunk.comment`);
    }
    parts.push("");
  }

  // 2. Blocks (Classes, Functions, etc.)
  if (def.structure.blocks.length > 0) {
    parts.push(`;; ----- Blocks -----`);
    for (const block of def.structure.blocks) {
      let query = `(${block.type}`;
      if (block.nameQuery) {
        query += ` ${block.nameQuery}`;
      }
      
      if (block.isBlock !== false) {
        query += `) @chunk.block.${block.captureId || block.type}`;
      } else {
        query += `)`;
      }
      
      if (block.parentType) {
        query = `(${block.parentType} ${query})`;
      }
      
      parts.push(query);
    }
    parts.push("");
  }

  // 3. Split Points (Inner control flow)
  if (def.structure.splitPoints.length > 0) {
    parts.push(`;; ----- Split Points -----`);
    for (const type of def.structure.splitPoints) {
      parts.push(`(${type}) @chunk.block.inner`);
    }
    parts.push("");
  }

  return parts.join("\n");
}
