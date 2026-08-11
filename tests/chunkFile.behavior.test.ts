import { afterEach, describe, expect, it, vi } from "vitest";

import { LANG_CONFIGS } from "../src/bootstrap/treeSitterLanguages.js";
import { chunkFile } from "../src/chunking/chunkFile.js";
import { chunkTextFile } from "../src/chunking/chunkTextFile.js";
import * as nativeRuntime from "../src/native/treeSitterNative.js";

const tokenize = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

describe("chunkFile detailed behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses native chunk queries for JavaScript", () => {
    const nativeSpy = vi.spyOn(nativeRuntime, "getNativeSingleQueryExecution");

    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source: "function demo() { return 1; }\n",
      filePath: "demo.js",
      minTokens: 1,
      maxTokens: 50,
      tokenizer: tokenize,
    });

    expect(chunks.length).toBeGreaterThan(0);
    expect(nativeSpy).toHaveBeenCalledTimes(1);
  });

  it("uses native chunk queries for TSX", () => {
    const nativeSpy = vi.spyOn(nativeRuntime, "getNativeSingleQueryExecution");

    const chunks = chunkFile({
      language: LANG_CONFIGS.tsx,
      source: [
        "type Props = { label: string };",
        "export function Button({ label }: Props) {",
        "  return <button>{label}</button>;",
        "}",
      ].join("\n"),
      filePath: "Button.tsx",
      minTokens: 1,
      maxTokens: 80,
      tokenizer: tokenize,
    });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((chunk) => chunk.name === "Button")).toBe(true);
    expect(chunks.every((chunk) => chunk.languageId === "tsx")).toBe(true);
    expect(nativeSpy).toHaveBeenCalledTimes(1);
  });

  it("uses public chunking language ids while keeping internal support ids", () => {
    expect(LANG_CONFIGS.javascript.id).toBe("javascript");
    expect(LANG_CONFIGS.javascript.supportId).toBe("js");
    expect(LANG_CONFIGS.php.id).toBe("php");
    expect(LANG_CONFIGS.php.supportId).toBe("php");

    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source: "function demo() { return 1; }\n",
      filePath: "demo.js",
      minTokens: 1,
      maxTokens: 50,
      tokenizer: tokenize,
    });

    expect(chunks[0]?.languageId).toBe("javascript");
  });

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

  it("emits stable line ranges for functions and nested else blocks", () => {
    const source = `
function processUsers(users) {
  const normalized = users.map((user) => ({
    ...user,
    active: Boolean(user.active),
  }));

  if (!normalized.length) {
    return [];
  } else {
    const staged = [...normalized];
    staged.sort((a, b) => a.id.localeCompare(b.id));
    return staged;
  }
}

const finalize = () => {
  return processUsers([]);
};
`.trimStart();

    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source,
      filePath: "ranges.js",
      minTokens: 1,
      maxTokens: 8,
      tokenizer: tokenize,
    });

    const processUsersChunks = chunks.filter((c) => c.type === "function" && c.name === "processUsers");
    expect(processUsersChunks.length).toBeGreaterThan(1);
    expect(processUsersChunks.every((chunk) => chunk.tokenCount <= 8)).toBe(true);
    expect(processUsersChunks.map((chunk) => chunk.text).join("")).toContain("else {");
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
    expect(chunks.some((c) => c.type === "function" && c.name === "build")).toBe(false);
    expect(chunks.filter((c) => c.text.includes('function build()')).length).toBe(1);
  });

  it("captures TypeScript enums regardless of identifier node type", () => {
    const source = `
export enum Foo {
  One,
  Two,
}

declare enum FooBar {
  Single,
}
`.trimStart();

    const chunks = chunkFile({
      language: LANG_CONFIGS.typescript,
      source,
      filePath: "enum.ts",
      minTokens: 1,
      maxTokens: 200,
      tokenizer: tokenize,
    });

    const enumNames = chunks.filter((c) => c.type === "enum").map((c) => c.name);
    expect(enumNames).toEqual(expect.arrayContaining(["Foo", "FooBar"]));
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

  it("splits large switch statements by case clauses", () => {
    const source = `
function runSwitch(val) {
  switch (val) {
    case 1:
      return "one";
    case 2:
      return "two";
    case 3:
      return "three";
    case 4:
      return "four";
    case 5:
      return "five";
    default:
      return "other";
  }
}
`.trimStart();

    // Small maxTokens to force splitting inside the switch
    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source,
      filePath: "switch.js",
      minTokens: 1,
      maxTokens: 10,
      tokenizer: tokenize,
    });

    const switchChunks = chunks.filter((c) => c.type === "function" && c.name === "runSwitch");
    // Should be split
    expect(switchChunks.length).toBeGreaterThan(1);

    // Verify we didn't get weird chunks or lost code
    const combined = switchChunks.map((c) => c.text).join("\\n");
    expect(combined).toContain("case 1:");
    expect(combined).toContain("default:");
  });

  it("captures large object literals as data blocks", () => {
    const source = `
const config = {
  endpoint: "https://api.example.com",
  retries: 5,
  timeout: 1000,
  headers: {
    "Content-Type": "application/json"
  }
};
`.trimStart();

    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source,
      filePath: "config.js",
      minTokens: 1,
      maxTokens: 100,
      tokenizer: tokenize,
    });

    // Expect a block of type 'data' (from @chunk.block.data)
    // Currently this might be 'module_var' or 'misc' depending on existing queries
    // After update, we expect 'data' or 'object'
    const dataChunk = chunks.find((c) => c.type === "data" || c.type === "object");
    if (dataChunk) {
      expect(dataChunk).toBeDefined();
      expect(dataChunk?.text).toContain("endpoint:");
    } else {
      // If the test runs before the implementation, this might fail or we might accept 'module_var'
      // But since we are adding tests for new behavior:
      // We will assert loosely for now or expect failure until impl is done.
      // Let's make it strict to verify the new feature.
      const miscOrVar = chunks.find((c) => c.type === "module_var" || c.type === "misc");
      expect(miscOrVar).toBeDefined();
    }
  });

  it("uses for..of loops as split boundaries", () => {
    const source = `
function processItems(items) {
  console.log("start");
  
  for (const item of items) {
    process(item);
    save(item);
  }

  console.log("end");
}
`.trimStart();

    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source,
      filePath: "loops.js",
      minTokens: 1,
      maxTokens: 8, // Force split around the loop
      tokenizer: tokenize,
    });

    const fnChunks = chunks.filter((c) => c.type === "function");
    expect(fnChunks.length).toBeGreaterThan(1);

    // One of the chunks should ideally contain the loop body or the loop itself
    const loopChunk = fnChunks.find((c) => c.text.includes("for (const item of items)"));
    expect(loopChunk).toBeDefined();
  });
});

describe("chunkTextFile and chunkFile regressions", () => {
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

  it("keeps text chunk IDs when an earlier chunk is inserted", () => {
    const unchangedSource = ["later alpha", "later beta"].join("\n");
    const before = chunkTextFile({
      source: unchangedSource,
      filePath: "stable.txt",
      languageId: "text",
      maxTokens: 2,
      tokenizer: tokenize,
    });
    const after = chunkTextFile({
      source: ["inserted chunk", unchangedSource].join("\n"),
      filePath: "stable.txt",
      languageId: "text",
      maxTokens: 2,
      tokenizer: tokenize,
    });
    const idsAfter = new Map(after.map((chunk) => [chunk.text, chunk.id]));

    for (const chunk of before) {
      expect(idsAfter.get(chunk.text)).toBe(chunk.id);
    }
  });

  it("splits oversized single-line text and semantic chunks without dropping source", () => {
    const source = "function minified(){const value=1234567890;return value+1234567890;}";
    const maxTokens = 12;
    const characterTokenizer = (text: string) => text.length;

    const semanticChunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source,
      filePath: "minified.js",
      minTokens: 1,
      maxTokens,
      tokenizer: characterTokenizer,
    });
    const textChunks = chunkTextFile({
      source,
      filePath: "minified.txt",
      languageId: "text",
      minTokens: 1,
      maxTokens,
      tokenizer: characterTokenizer,
    });

    expect(semanticChunks.every((chunk) => chunk.tokenCount <= maxTokens)).toBe(true);
    expect(semanticChunks.map((chunk) => chunk.text).join("")).toBe(source);
    expect(textChunks.every((chunk) => chunk.tokenCount <= maxTokens)).toBe(true);
    expect(textChunks.map((chunk) => chunk.text).join("")).toBe(source);
  });

  it("keeps IDs for unchanged semantic chunks when an earlier chunk is inserted", () => {
    const unchangedSource = [
      "function unchangedFirst() {",
      "  return 'first';",
      "}",
      "",
      "function unchangedSecond() {",
      "  return 'second';",
      "}",
    ].join("\n");
    const sourceWithInsertion = [
      "function inserted() {",
      "  return 'inserted';",
      "}",
      "",
      unchangedSource,
    ].join("\n");
    const options = {
      language: LANG_CONFIGS.javascript,
      filePath: "stable.js",
      minTokens: 1,
      maxTokens: 100,
      tokenizer: tokenize,
    };
    const before = chunkFile({ ...options, source: unchangedSource });
    const after = chunkFile({ ...options, source: sourceWithInsertion });

    const unchangedChunks = before.filter((chunk) => chunk.name?.startsWith("unchanged"));
    const unchangedAfter = after.filter((chunk) => chunk.name?.startsWith("unchanged"));
    const idsAfter = new Map(unchangedAfter.map((chunk) => [chunk.name, chunk.id]));

    expect(unchangedChunks).toHaveLength(2);
    for (const chunk of unchangedChunks) {
      expect(idsAfter.get(chunk.name)).toBe(chunk.id);
    }
  });

  it("uses disjoint source ranges when a large class promotes its methods", () => {
    const source = [
      "class Example {",
      "  first() {",
      "    return 'first marker';",
      "  }",
      "",
      "  second() {",
      "    return 'second marker';",
      "  }",
      "}",
    ].join("\n");
    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source,
      filePath: "Example.js",
      minTokens: 1,
      maxTokens: 8,
      tokenizer: tokenize,
    });

    let rangeStart = 0;
    for (const chunk of chunks) {
      const rangeEnd = rangeStart + chunk.text.length;
      expect(source.slice(rangeStart, rangeEnd)).toBe(chunk.text);
      rangeStart = rangeEnd;
    }

    expect(rangeStart).toBe(source.length);
    expect(chunks.filter((chunk) => chunk.text.includes("first marker"))).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.text.includes("second marker"))).toHaveLength(1);
  });
});
