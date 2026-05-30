import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { buildProjectIndex, SymbolKind } from "../src/index.js";
import { locateChangedSymbols } from "../src/impact/map.js";

type MethodLocalCase = {
  label: string;
  file: string;
  source: string;
  methodName: string;
  methodLine: number;
  bodyLine: number;
  oldBody: string;
  bodyEdit: string;
  enclosingName?: string;
};

const methodLocalCases: MethodLocalCase[] = [
  {
    label: "JavaScript class method",
    file: "service.js",
    source: ["export class Service {", "  run(value) {", "    return value;", "  }", "}", ""].join("\n"),
    methodName: "run",
    methodLine: 2,
    bodyLine: 3,
    oldBody: "-    return value;",
    bodyEdit: "+    return value + 1;",
    enclosingName: "Service",
  },
  {
    label: "TypeScript class method",
    file: "service.ts",
    source: ["export class Service {", "  run(value: number): number {", "    return value;", "  }", "}", ""].join(
      "\n",
    ),
    methodName: "run",
    methodLine: 2,
    bodyLine: 3,
    oldBody: "-    return value;",
    bodyEdit: "+    return value + 1;",
    enclosingName: "Service",
  },
  {
    label: "TSX class method",
    file: "service.tsx",
    source: ["export class Service {", "  run(value: number): number {", "    return value;", "  }", "}", ""].join(
      "\n",
    ),
    methodName: "run",
    methodLine: 2,
    bodyLine: 3,
    oldBody: "-    return value;",
    bodyEdit: "+    return value + 1;",
    enclosingName: "Service",
  },
  {
    label: "Python class method",
    file: "service.py",
    source: ["class Service:", "    def run(self, value):", "        return value", ""].join("\n"),
    methodName: "run",
    methodLine: 2,
    bodyLine: 3,
    oldBody: "-        return value",
    bodyEdit: "+        return value + 1",
    enclosingName: "Service",
  },
  {
    label: "PHP class method",
    file: "service.php",
    source: ["<?php", "class Service {", "  public function run($value) {", "    return $value;", "  }", "}", ""].join(
      "\n",
    ),
    methodName: "run",
    methodLine: 3,
    bodyLine: 4,
    oldBody: "-    return $value;",
    bodyEdit: "+    return $value + 1;",
    enclosingName: "Service",
  },
  {
    label: "Java class method",
    file: "Service.java",
    source: ["class Service {", "  int run(int value) {", "    return value;", "  }", "}", ""].join("\n"),
    methodName: "run",
    methodLine: 2,
    bodyLine: 3,
    oldBody: "-    return value;",
    bodyEdit: "+    return value + 1;",
    enclosingName: "Service",
  },
  {
    label: "C# class method",
    file: "Service.cs",
    source: ["class Service {", "  int Run(int value) {", "    return value;", "  }", "}", ""].join("\n"),
    methodName: "Run",
    methodLine: 2,
    bodyLine: 3,
    oldBody: "-    return value;",
    bodyEdit: "+    return value + 1;",
    enclosingName: "Service",
  },
  {
    label: "Go receiver method",
    file: "service.go",
    source: [
      "package main",
      "type Service struct{}",
      "func (s Service) Run(value int) int {",
      "  return value",
      "}",
      "",
    ].join("\n"),
    methodName: "Run",
    methodLine: 3,
    bodyLine: 4,
    oldBody: "-  return value",
    bodyEdit: "+  return value + 1",
    enclosingName: "Service",
  },
  {
    label: "Kotlin class method",
    file: "Service.kt",
    source: ["class Service {", "  fun run(value: Int): Int {", "    return value", "  }", "}", ""].join("\n"),
    methodName: "run",
    methodLine: 2,
    bodyLine: 3,
    oldBody: "-    return value",
    bodyEdit: "+    return value + 1",
    enclosingName: "Service",
  },
  {
    label: "Ruby class method",
    file: "service.rb",
    source: ["class Service", "  def run(value)", "    value", "  end", "end", ""].join("\n"),
    methodName: "run",
    methodLine: 2,
    bodyLine: 3,
    oldBody: "-    value",
    bodyEdit: "+    value + 1",
    enclosingName: "Service",
  },
  {
    label: "Rust impl method",
    file: "service.rs",
    source: [
      "struct Service;",
      "impl Service {",
      "  fn run(&self, value: i32) -> i32 {",
      "    value",
      "  }",
      "}",
      "",
    ].join("\n"),
    methodName: "run",
    methodLine: 3,
    bodyLine: 4,
    oldBody: "-    value",
    bodyEdit: "+    value + 1",
    enclosingName: "Service",
  },
  {
    label: "Swift class method",
    file: "Service.swift",
    source: ["class Service {", "  func run(_ value: Int) -> Int {", "    return value", "  }", "}", ""].join("\n"),
    methodName: "run",
    methodLine: 2,
    bodyLine: 3,
    oldBody: "-    return value",
    bodyEdit: "+    return value + 1",
    enclosingName: "Service",
  },
  {
    label: "C++ class method",
    file: "service.cpp",
    source: ["class Service {", "public:", "  int run(int value) {", "    return value;", "  }", "};", ""].join("\n"),
    methodName: "run",
    methodLine: 3,
    bodyLine: 4,
    oldBody: "-    return value;",
    bodyEdit: "+    return value + 1;",
    enclosingName: "Service",
  },
  {
    label: "Zig struct function",
    file: "service.zig",
    source: [
      "const Service = struct {",
      "  pub fn run(self: Service, value: i32) i32 {",
      "    _ = self;",
      "    return value;",
      "  }",
      "};",
      "",
    ].join("\n"),
    methodName: "run",
    methodLine: 2,
    bodyLine: 4,
    oldBody: "-    return value;",
    bodyEdit: "+    return value + 1;",
    enclosingName: "Service",
  },
];

async function withTmpDir(name: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `cg-method-locals-${name}-`));
  try {
    await run(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

describe("method-like local symbols", () => {
  it.each(methodLocalCases)("$label is indexed as a function local", async (testCase) => {
    await withTmpDir(testCase.file.replace(/[^A-Za-z0-9]/g, "-"), async (root) => {
      const file = path.join(root, testCase.file).replace(/\\/g, "/");
      await fsp.writeFile(file, testCase.source, "utf8");

      const index = await buildProjectIndex(root);
      const moduleIndex = index.byFile.get(file);
      const methodLocal = moduleIndex?.locals.find(
        (local) => local.localName === testCase.methodName && local.range.start.line === testCase.methodLine,
      );

      expect(methodLocal).toBeDefined();
      expect(methodLocal?.kind).toBe(SymbolKind.Function);
    });
  });

  it.each(methodLocalCases)("$label body edits map to the method local", async (testCase) => {
    await withTmpDir(testCase.file.replace(/[^A-Za-z0-9]/g, "-"), async (root) => {
      const file = path.join(root, testCase.file).replace(/\\/g, "/");
      await fsp.writeFile(file, testCase.source, "utf8");

      const index = await buildProjectIndex(root);
      const changed = await locateChangedSymbols(index, file, [
        {
          oldStart: testCase.bodyLine,
          newStart: testCase.bodyLine,
          lines: [testCase.oldBody, testCase.bodyEdit],
        },
      ]);

      const changedMethod = changed.find((symbol) => symbol.name === testCase.methodName);
      expect(changedMethod).toBeDefined();
      expect(changedMethod?.kind).toBe(SymbolKind.Function);
      expect(changedMethod?.signatureChanged).toBe(false);
      if (testCase.enclosingName) {
        expect(changed.some((symbol) => symbol.name === testCase.enclosingName)).toBe(false);
      }
    });
  });

  it("maps a deleted method before another method to the enclosing class", async () => {
    await withTmpDir("deleted-method-before-next-method", async (root) => {
      const file = path.join(root, "service.ts").replace(/\\/g, "/");
      await fsp.writeFile(
        file,
        ["export class Service {", "  keep(): number {", "    return 2;", "  }", "}", ""].join("\n"),
        "utf8",
      );

      const index = await buildProjectIndex(root);
      const changed = await locateChangedSymbols(index, file, [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            " export class Service {",
            "-  run(): number {",
            "-    return 1;",
            "-  }",
            "   keep(): number {",
            "     return 2;",
            "   }",
          ],
        },
      ]);

      expect(changed.map((symbol) => symbol.name)).toEqual(["Service"]);
      expect(changed[0]).toEqual(
        expect.objectContaining({
          kind: SymbolKind.Class,
          signatureChanged: false,
        }),
      );
    });
  });

  it.each([
    {
      label: "TypeScript interface method signature",
      source: ["export interface Service {", "  run(value: string): void;", "}", ""].join("\n"),
      methodLine: 2,
      oldSignature: "-  run(value: string): void;",
      newSignature: "+  run(value: string, count: number): void;",
    },
    {
      label: "TypeScript abstract method signature",
      source: ["export abstract class Service {", "  abstract run(value: string): void;", "}", ""].join("\n"),
      methodLine: 2,
      oldSignature: "-  abstract run(value: string): void;",
      newSignature: "+  abstract run(value: string, count: number): void;",
    },
  ])("$label is indexed and receives signature edits", async (testCase) => {
    await withTmpDir(testCase.label.replace(/[^A-Za-z0-9]/g, "-"), async (root) => {
      const file = path.join(root, "service.ts").replace(/\\/g, "/");
      await fsp.writeFile(file, testCase.source, "utf8");

      const index = await buildProjectIndex(root);
      const moduleIndex = index.byFile.get(file);
      const methodLocal = moduleIndex?.locals.find(
        (local) => local.localName === "run" && local.range.start.line === testCase.methodLine,
      );
      const changed = await locateChangedSymbols(index, file, [
        {
          oldStart: testCase.methodLine,
          newStart: testCase.methodLine,
          lines: [testCase.oldSignature, testCase.newSignature],
        },
      ]);

      expect(methodLocal).toBeDefined();
      expect(methodLocal?.kind).toBe(SymbolKind.Function);
      expect(changed).toEqual([
        expect.objectContaining({
          name: "run",
          kind: SymbolKind.Function,
          signatureChanged: true,
        }),
      ]);
    });
  });
});
