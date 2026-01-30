import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { chunkFile } from "../../../src/chunking/chunkFile.js";
import { chunkTextFile } from "../../../src/chunking/chunkTextFile.js";
import { LANG_CONFIGS } from "../../../src/bootstrap/treeSitterLanguages.js";

/**
 * Integration example showing how LLM agents can use semantic chunking
 * to prepare codebases for processing and vector embeddings.
 */
describe("chunking integration examples", () => {
  const sampleDir = path.join(__dirname);

  it("chunks code semantically and filters by type", async () => {
    const codePath = path.join(sampleDir, "sample-code.js");
    const source = fs.readFileSync(codePath, "utf8");

    // Chunk the JavaScript file semantically
    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source,
      filePath: codePath,
      minTokens: 10, // Allow smaller chunks for demo
      maxTokens: 200,
    });

    // Filter chunks by type for different processing needs
    const functionChunks = chunks.filter(c => c.type === "function");
    const commentChunks = chunks.filter(c => c.type === "comment");

    // Verify we captured the key functions
    expect(functionChunks.some(c => c.name === "validateEmail")).toBe(true);
    expect(functionChunks.some(c => c.name === "processUsers")).toBe(true);

    // Check we captured the JSDoc comment
    expect(commentChunks.length).toBeGreaterThan(0);
    expect(commentChunks[0]?.text).toContain("Utility functions");

    // Simulate feeding chunks to an embedding client
    const embeddingInputs = chunks.map(chunk => ({
      id: chunk.id,
      content: chunk.text,
      metadata: {
        language: chunk.languageId,
        type: chunk.type,
        name: chunk.name,
        file: chunk.filePath,
        lines: `${chunk.startLine}-${chunk.endLine}`,
      },
    }));

    // Verify structure suitable for embeddings
    expect(embeddingInputs.length).toBeGreaterThan(3);
    expect(embeddingInputs[0]).toHaveProperty("content");
    expect(embeddingInputs[0]).toHaveProperty("metadata");
  });

  it("chunks JSON config files for structured data processing", async () => {
    const configPath = path.join(sampleDir, "sample-config.json");
    const source = fs.readFileSync(configPath, "utf8");

    // Chunk the JSON file by token limits
    const chunks = chunkTextFile({
      source,
      filePath: configPath,
      languageId: "json",
      minTokens: 50,
      maxTokens: 150,
    });

    // JSON should typically be chunked into manageable pieces
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(c => c.tokenCount <= 150)).toBe(true);

    // Verify metadata
    expect(chunks[0]?.languageId).toBe("json");
    expect(chunks[0]?.filePath).toBe(configPath);

    // Simulate processing for configuration analysis
    const configInsights = chunks.map(chunk => ({
      content: chunk.text,
      // Could extract JSON keys/values for analysis
      tokenCount: chunk.tokenCount,
    }));

    expect(configInsights.length).toBe(chunks.length);
  });

  it("handles large files with intelligent splitting", async () => {
    const codePath = path.join(sampleDir, "sample-code.js");
    const source = fs.readFileSync(codePath, "utf8");

    // Use restrictive token limits to force splitting
    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source,
      filePath: codePath,
      minTokens: 5, // Very small minimum
      maxTokens: 30, // Force splitting of larger blocks
    });

    // Should have captured the processUsers function
    const processUsersChunks = chunks.filter(c => c.name === "processUsers");
    expect(processUsersChunks.length).toBeGreaterThan(0);

    // All chunks should respect token limits
    expect(chunks.every(c => c.tokenCount <= 30)).toBe(true);

    // Simulate chunk processing pipeline
    const processedChunks = chunks.map(chunk => ({
      ...chunk,
      // Add processing metadata
      processed: true,
      embedding: `embedding_for_${chunk.id}`,
    }));

    expect(processedChunks.every(c => c.processed)).toBe(true);
  });

  it("provides agent-friendly chunk metadata for decision making", async () => {
    const codePath = path.join(sampleDir, "sample-code.js");
    const source = fs.readFileSync(codePath, "utf8");

    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source,
      filePath: codePath,
      minTokens: 10, // Allow smaller chunks for better granularity
      maxTokens: 100,
    });


    // Demonstrate filtering for different agent needs
    const functionChunks = chunks.filter(c => c.type === "function" && c.name);
    const structuralChunks = chunks.filter(c =>
      ["class", "function", "method", "interface"].includes(c.type)
    );

    // Agent could prioritize functions for API understanding
    expect(functionChunks.length).toBeGreaterThan(0);

    // Agent could use structural elements for code navigation
    expect(structuralChunks.length).toBeGreaterThanOrEqual(functionChunks.length);

    // Demonstrate chunk prioritization by type and size
    const prioritized = chunks
      .filter(c => c.type !== "misc") // Skip filler chunks
      .sort((a, b) => {
        // Prioritize functions/methods, then by size
        const typeOrder = { function: 0, method: 1, class: 2 };
        const aOrder = typeOrder[a.type as keyof typeof typeOrder] ?? 99;
        const bOrder = typeOrder[b.type as keyof typeof typeOrder] ?? 99;
        return aOrder - bOrder || b.tokenCount - a.tokenCount; // Larger first
      });

    expect(prioritized[0]?.type).toBe("function");
  });
});
