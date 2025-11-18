import { describe, expect, it } from "vitest";

import { LANG_CONFIGS } from "../src/bootstrap/treeSitterLanguages.js";
import { chunkFile } from "../src/chunking/chunkFile.js";
import { chunkTextFile } from "../src/chunking/chunkTextFile.js";

const tokenize = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

describe("chunkFile detailed behavior", () => {
  it("splits large JavaScript blocks using inner control-flow hints", () => {
    const source = `
function big(value) {
  if (value > 10) {
    for (let i = 0; i < value; i++) {
      value -= i;
    }
  }

  while (value > 0) {
    value--;
  }

  if (value < -10) {
    value = Math.abs(value);
  }

  return value;
}
`.trimStart();

    const maxTokens = 20;
    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source,
      filePath: "big.js",
      minTokens: 1,
      maxTokens,
      tokenizer: tokenize,
    });

    const functionChunks = chunks.filter((c) => c.type === "function" && c.name === "big");
    expect(functionChunks.length).toBeGreaterThan(1);
    expect(functionChunks.every((c) => c.tokenCount <= maxTokens)).toBe(true);
  });

  it("detects JavaScript functions assigned to variables and properties", () => {
    const source = `
const alpha = () => {
  return 1;
};

let beta = function () {
  return 2;
};

exports.run = function named() {
  return alpha() + beta();
};

gamma = () => {
  return exports.run();
};
`.trimStart();

    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source,
      filePath: "assigned.js",
      minTokens: 1,
      maxTokens: 200,
      tokenizer: tokenize,
    });

    const functionNames = chunks
      .filter((c) => c.type === "function")
      .map((c) => c.name)
      .filter((name): name is string => Boolean(name));

    expect(functionNames).toEqual(expect.arrayContaining(["alpha", "beta", "exports.run", "gamma"]));
  });

  it("merges adjacent small chunks of different types and emits misc ranges", () => {
    const source = `
// short note
const value = 1;
value + 2;
`.trimStart();

    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source,
      filePath: "merge.js",
      minTokens: 6,
      maxTokens: 100,
      tokenizer: tokenize,
    });

    const merged = chunks.find((c) => c.type.includes("+"));
    expect(merged).toBeDefined();
    expect(merged?.type).toBe("comment+module_var");
    expect(merged?.tokenCount).toBeGreaterThanOrEqual(6);

    const misc = chunks.find((c) => c.type === "misc");
    expect(misc).toBeDefined();
    expect(misc?.text).toContain("value + 2");
  });

  it("captures TypeScript namespaces and modules", () => {
    const source = `
namespace Tools {
  export function build() {
    return "ok";
  }
}

module Legacy {
  export const version = 1;
}
`.trimStart();

    const chunks = chunkFile({
      language: LANG_CONFIGS.typescript,
      source,
      filePath: "ns.ts",
      minTokens: 1,
      maxTokens: 200,
      tokenizer: tokenize,
    });

    expect(chunks.some((c) => c.type === "namespace" && c.name === "Tools")).toBe(true);
    expect(chunks.some((c) => c.type === "namespace" && c.name === "Legacy")).toBe(true);
    expect(chunks.some((c) => c.type === "function" && c.name === "build")).toBe(true);
  });

  it("splits Python functions that contain elif/else blocks", () => {
    const source = `
def categorize(x):
    if x > 0:
        return "positive"
    elif x == 0:
        return "zero"
    else:
        return "negative"


def helper():
    return categorize(1)
`.trimStart();

    const maxTokens = 12;
    const chunks = chunkFile({
      language: LANG_CONFIGS.python,
      source,
      filePath: "logic.py",
      minTokens: 1,
      maxTokens,
      tokenizer: tokenize,
    });

    const categorizeChunks = chunks.filter((c) => c.type === "function" && c.name === "categorize");
    expect(categorizeChunks.length).toBeGreaterThan(1);
    expect(categorizeChunks.every((c) => c.tokenCount <= maxTokens)).toBe(true);
    expect(chunks.some((c) => c.type === "function" && c.name === "helper")).toBe(true);
  });
});

describe("chunkTextFile", () => {
  it("splits text blobs according to the token budget", () => {
    const source = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`).join("\n");

    const chunks = chunkTextFile({
      source,
      filePath: "notes.txt",
      languageId: "text",
      minTokens: 1,
      maxTokens: 6,
      tokenizer: tokenize,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.tokenCount <= 6)).toBe(true);
    expect(chunks[0]?.filePath).toBe("notes.txt");
    const combined = chunks.map((c) => c.text).join("\n");
    expect(combined).toContain("line 1");
    expect(combined).toContain("line 24");
  });
});

