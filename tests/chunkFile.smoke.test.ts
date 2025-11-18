import { describe, expect, it } from "vitest";

import { LANG_CONFIGS } from "../src/bootstrap/treeSitterLanguages.js";
import { chunkFile } from "../src/chunking/chunkFile.js";

const testTokenizer = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

function logChunks(label: string, chunks: ReturnType<typeof chunkFile>) {
  // eslint-disable-next-line no-console
  console.log(`\n== ${label} ==`);
  for (const c of chunks) {
    const namePart = c.name ? ` (${c.name})` : "";
    // eslint-disable-next-line no-console
    console.log(
      `[${c.languageId}] ${c.type}${namePart} [${c.startLine}-${c.endLine}] tokens=${c.tokenCount}`,
    );
  }
}

describe("chunkFile smoke tests", () => {
  it("chunks JavaScript", () => {
    const source = `
// Top comment about Foo

import fs from "fs";

const API_BASE_URL = "https://example.com";

class Foo {
  constructor(id) {
    this.id = id;
  }

  bar(x) {
    if (x > 0) {
      return x;
    }
    return -x;
  }
}

// standalone function
function baz(y) {
  return y * 2;
}
`.trimStart();

    const chunks = chunkFile({
      language: LANG_CONFIGS.javascript,
      source,
      filePath: "sample.js",
      minTokens: 1,
      maxTokens: 1000,
      tokenizer: testTokenizer,
    });

    logChunks("JavaScript", chunks);

    expect(chunks.some((c) => c.type === "comment")).toBe(true);
    expect(chunks.some((c) => c.type === "imports")).toBe(true);
    expect(chunks.some((c) => c.type === "module_var" && c.name === "API_BASE_URL")).toBe(true);
    expect(chunks.some((c) => c.type === "class" && c.name === "Foo")).toBe(true);
    expect(chunks.some((c) => c.type === "method" && c.name === "bar")).toBe(true);
    expect(chunks.some((c) => c.type === "function" && c.name === "baz")).toBe(true);
  });

  it("chunks TypeScript", () => {
    const source = `
import type { Config } from "./types";

interface User {
  id: string;
  name: string;
}

enum Role {
  Admin,
  User,
}

type UserId = string;

class Service {
  constructor(private id: UserId) {}

  getRole(user: User): Role {
    return Role.User;
  }
}

function helper(x: number): number {
  return x * 2;
}
`.trimStart();

    const chunks = chunkFile({
      language: LANG_CONFIGS.typescript,
      source,
      filePath: "sample.ts",
      minTokens: 1,
      maxTokens: 1000,
      tokenizer: testTokenizer,
    });

    logChunks("TypeScript", chunks);

    expect(chunks.some((c) => c.type === "imports")).toBe(true);
    expect(chunks.some((c) => c.type === "interface" && c.name === "User")).toBe(true);
    expect(chunks.some((c) => c.type === "enum" && c.name === "Role")).toBe(true);
    expect(chunks.some((c) => c.type === "type_alias" && c.name === "UserId")).toBe(true);
    expect(chunks.some((c) => c.type === "class" && c.name === "Service")).toBe(true);
    expect(chunks.some((c) => c.type === "function" && c.name === "helper")).toBe(true);
  });

  it("chunks Python with docstrings", () => {
    const source = `
"""Module docstring explaining the purpose of this file."""

import os
from pathlib import Path

CONFIG_PATH = Path("config.yml")

class Foo:
  """Class docstring for Foo."""

  def method(self, x):
    """Method docstring."""
    if x > 0:
      return x
    return -x


def top_level(y):
  """Top-level function docstring."""
  for i in range(y):
    print(i)
`.trimStart();

    const chunks = chunkFile({
      language: LANG_CONFIGS.python,
      source,
      filePath: "sample.py",
      minTokens: 1,
      maxTokens: 1000,
      tokenizer: testTokenizer,
    });

    logChunks("Python", chunks);

    expect(chunks.some((c) => c.type === "docstring")).toBe(true);
    expect(chunks.some((c) => c.type === "imports")).toBe(true);
    expect(chunks.some((c) => c.type === "module_var" && c.name === "CONFIG_PATH")).toBe(true);

    const classChunk = chunks.find((c) => c.type === "class" && c.name === "Foo");
    expect(classChunk).toBeDefined();

    const methodChunk = chunks.find((c) => c.type === "function" && c.name === "method");
    expect(methodChunk).toBeDefined();

    const topLevelFunc = chunks.find((c) => c.type === "function" && c.name === "top_level");
    expect(topLevelFunc).toBeDefined();

    const docstringChunks = chunks.filter((c) => c.type === "docstring");
    expect(docstringChunks.length).toBe(1);
    expect(docstringChunks[0]?.text).toBe('"""Module docstring explaining the purpose of this file."""');
  });
});

