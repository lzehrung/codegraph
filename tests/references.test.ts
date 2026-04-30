import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import * as indexer from "../src/indexer.js";
import {
  createTestIndex,
  createTestIndexFromFiles,
  testFindReferences,
  createTestIndexFromPath,
} from "./test-utils.js";

function expectReferenceAt(result: Awaited<ReturnType<typeof testFindReferences>>, file: string, line: number): void {
  if (result.status !== "ok") {
    return;
  }
  expect(result.references.some((reference) => reference.file === file && reference.range.start.line === line)).toBe(
    true,
  );
}

describe("Find References", () => {
  describe("TypeScript", () => {
    it("should find all references to exported function", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
      const utilsFile = path.join(samplePath, "utils.ts").replace(/\\/g, "/");

      // Test find-references on helperFunction definition on line 1
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === utilsFile && ref.range.start.line === 1);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find all references to exported class", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
      const utilsFile = path.join(samplePath, "utils.ts").replace(/\\/g, "/");

      // Test find-references on UtilityClass definition on line 5
      const result = await testFindReferences(index, utilsFile, 5, 14, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === utilsFile && ref.range.start.line === 5);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find references to namespace member", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
      const utilsFile = path.join(samplePath, "utils.ts").replace(/\\/g, "/");

      // Test find-references on helperFunction definition
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        // Should find both direct usage and namespace usage
        const namespaceUsage = result.references.find(
          (ref) => ref.file.includes("main.ts") && ref.via?.namespaceMember,
        );
        expect(namespaceUsage).toBeDefined();
      }
    });
  });

  describe("TSX", () => {
    it("should keep block context scoped to the enclosing component", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-tsx-block-context-"));
      try {
        const buttonFile = path.join(root, "Button.tsx");
        const appFile = path.join(root, "App.tsx");
        await fsp.writeFile(
          buttonFile,
          [
            "export function Button(props: { label: string }) {",
            "  return <button>{props.label}</button>;",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        await fsp.writeFile(
          appFile,
          [
            "import { Button } from './Button';",
            "",
            "function unrelated() {",
            "  return 'nope';",
            "}",
            "",
            "export function App() {",
            '  return <Button label="hi" />;',
            "}",
            "",
            "function trailing() {",
            "  return 'tail';",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const index = await createTestIndexFromPath(root);
        const result = await indexer.findReferences(
          index,
          { file: buttonFile.replace(/\\/g, "/"), line: 1, column: 17 },
          { context: "block", blockMaxLines: 50, maxReferences: 2 },
        );

        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          const appReference = result.references.find((reference) => reference.file === appFile.replace(/\\/g, "/"));
          expect(appReference?.context).toContain("function App()");
          expect(appReference?.context).toContain('<Button label="hi" />');
          expect(appReference?.context).not.toContain("function unrelated()");
          expect(appReference?.context).not.toContain("function trailing()");
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("should find references for JSX imports authored with .jsx extensions", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "tsx");
      const appFile = path.join(samplePath, "JsxImportApp.tsx").replace(/\\/g, "/");
      const buttonFile = path.join(samplePath, "components", "Button.tsx").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [appFile, buttonFile]);

      const result = await testFindReferences(index, buttonFile, 5, 17, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, buttonFile, 5);
        expectReferenceAt(result, appFile, 4);
      }
    });
  });

  describe("Python", () => {
    it("should find all references to exported function", async () => {
      const index = await createTestIndex("python");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "python");
      const utilsFile = path.join(samplePath, "utils.py").replace(/\\/g, "/");

      // Test find-references on helper_function definition on line 1
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === utilsFile && ref.range.start.line === 1);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find all references to exported class", async () => {
      const index = await createTestIndex("python");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "python");
      const utilsFile = path.join(samplePath, "utils.py").replace(/\\/g, "/");

      // Test find-references on UtilityClass definition on line 5
      const result = await testFindReferences(index, utilsFile, 5, 7, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === utilsFile && ref.range.start.line === 5);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find references to namespace member", async () => {
      const index = await createTestIndex("python");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "python");
      const utilsFile = path.join(samplePath, "utils.py").replace(/\\/g, "/");

      // Test find-references on helper_function definition
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        // Should find usages in main.py
        const mainPyRefs = result.references.filter((ref) => ref.file.includes("main.py"));
        expect(mainPyRefs.length).toBeGreaterThan(0);
      }
    });

    it("should ignore shadowed names for wildcard imports while keeping real references", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-py-star-refs-"));
      try {
        const utilFile = path.join(root, "util.py");
        const mainFile = path.join(root, "main.py");
        await fsp.writeFile(utilFile, ["foo = 1", "bar = 2", ""].join("\n"), "utf8");
        await fsp.writeFile(
          mainFile,
          ["from util import *", "foo = 2", "print(foo)", "print(bar)", ""].join("\n"),
          "utf8",
        );

        const index = await createTestIndexFromPath(root);
        const normalizedUtil = utilFile.replace(/\\/g, "/");
        const normalizedMain = mainFile.replace(/\\/g, "/");

        const fooRefs = await testFindReferences(index, normalizedUtil, 1, 1, 1);
        expect(fooRefs.status).toBe("ok");
        if (fooRefs.status === "ok") {
          expect(fooRefs.references.some((reference) => reference.file === normalizedMain)).toBe(false);
        }

        const barRefs = await testFindReferences(index, normalizedUtil, 2, 1, 2);
        expect(barRefs.status).toBe("ok");
        if (barRefs.status === "ok") {
          expectReferenceAt(barRefs, normalizedMain, 4);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("should avoid semantic fallback work for expanded wildcard imports", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-py-star-expanded-"));
      try {
        const utilFile = path.join(root, "util.py");
        const mainFile = path.join(root, "main.py");
        await fsp.writeFile(utilFile, ["foo = 1", ""].join("\n"), "utf8");
        await fsp.writeFile(mainFile, ["from util import *", "print(foo)", ""].join("\n"), "utf8");

        const index = await createTestIndexFromPath(root);
        const normalizedUtil = utilFile.replace(/\\/g, "/");
        const utilModule = index.byFile.get(normalizedUtil);
        const fooDef = utilModule?.locals.find((local) => local.localName === "foo");

        expect(fooDef).toBeDefined();
        if (!fooDef) {
          throw new Error("Expected foo definition to exist");
        }

        const goToDefinitionSpy = vi.spyOn(indexer, "goToDefinition");
        try {
          const result = await indexer.findReferences(index, { def: fooDef }, { maxReferences: 2 });

          expect(result.status).toBe("ok");
          if (result.status === "ok") {
            expect(result.references).toHaveLength(2);
            expectReferenceAt(result, mainFile.replace(/\\/g, "/"), 2);
          }
          expect(goToDefinitionSpy).not.toHaveBeenCalled();
        } finally {
          goToDefinitionSpy.mockRestore();
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("PHP", () => {
    it("should find all references to imported function", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const utilsFile = path.join(samplePath, "utils.php").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 13, 11, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, utilsFile, 13);
        expectReferenceAt(result, path.join(samplePath, "main.php").replace(/\\/g, "/"), 9);
      }
    });

    it("should find all references to imported class", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const utilsFile = path.join(samplePath, "utils.php").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 5, 7, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, utilsFile, 5);
        expectReferenceAt(result, path.join(samplePath, "main.php").replace(/\\/g, "/"), 10);
      }
    });

    it("should find references through grouped use aliases", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const toolboxFile = path.join(samplePath, "src", "Support", "Toolbox.php").replace(/\\/g, "/");
      const helperFile = path.join(samplePath, "src", "Support", "support_helper.php").replace(/\\/g, "/");
      const groupedFile = path.join(samplePath, "grouped-consumer.php").replace(/\\/g, "/");

      const toolboxResult = await testFindReferences(index, toolboxFile, 5, 7, 2);
      expect(toolboxResult.status).toBe("ok");
      if (toolboxResult.status === "ok") {
        expectReferenceAt(toolboxResult, toolboxFile, 5);
        expectReferenceAt(toolboxResult, groupedFile, 8);
      }

      const helperResult = await testFindReferences(index, helperFile, 5, 10, 2);
      expect(helperResult.status).toBe("ok");
      if (helperResult.status === "ok") {
        expectReferenceAt(helperResult, helperFile, 5);
        expectReferenceAt(helperResult, groupedFile, 9);
      }
    });

    it("should find references for fully-qualified Composer-mapped classes", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const serviceFile = path.join(samplePath, "src", "Domain", "Service.php").replace(/\\/g, "/");
      const qualifiedConsumerFile = path.join(samplePath, "composer-qualified-consumer.php").replace(/\\/g, "/");
      const staticConsumerFile = path.join(samplePath, "composer-static-qualified-consumer.php").replace(/\\/g, "/");
      const staticConstantConsumerFile = path
        .join(samplePath, "composer-static-constant-consumer.php")
        .replace(/\\/g, "/");
      const staticPropertyConsumerFile = path
        .join(samplePath, "composer-static-property-consumer.php")
        .replace(/\\/g, "/");
      const typedConsumerFile = path.join(samplePath, "composer-type-qualified-consumer.php").replace(/\\/g, "/");

      const result = await testFindReferences(index, serviceFile, 5, 7, 7);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, serviceFile, 5);
        expectReferenceAt(result, path.join(samplePath, "composer-consumer.php").replace(/\\/g, "/"), 5);
        expectReferenceAt(result, qualifiedConsumerFile, 3);
        expectReferenceAt(result, staticConsumerFile, 3);
        expectReferenceAt(result, staticConstantConsumerFile, 3);
        expectReferenceAt(result, staticPropertyConsumerFile, 3);
        expectReferenceAt(result, typedConsumerFile, 3);
        const uniqueRanges = new Set(
          result.references.map((reference) =>
            [reference.file, reference.range.start.index ?? -1, reference.range.end.index ?? -1].join(":"),
          ),
        );
        expect(uniqueRanges.size).toBe(result.references.length);
      }
    });

    it("should find references for function imports when class names collide", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const functionFile = path.join(samplePath, "src", "Collision", "ThingFunction.php").replace(/\\/g, "/");
      const consumerFile = path.join(samplePath, "function-import-consumer.php").replace(/\\/g, "/");

      const result = await testFindReferences(index, functionFile, 5, 10, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, functionFile, 5);
        expectReferenceAt(result, consumerFile, 5);
      }
    });

    it("should find references for classes declared in PHP bracketed namespace blocks", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const libraryFile = path.join(samplePath, "multi-namespace", "Library.php").replace(/\\/g, "/");
      const consumerFile = path.join(samplePath, "bracketed-consumer.php").replace(/\\/g, "/");
      const qualifiedConsumerFile = path.join(samplePath, "bracketed-qualified-consumer.php").replace(/\\/g, "/");

      const result = await testFindReferences(index, libraryFile, 8, 11, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, libraryFile, 8);
        expectReferenceAt(result, consumerFile, 5);
        expectReferenceAt(result, qualifiedConsumerFile, 3);
      }
    });

    it("should find fully-qualified references for classes declared in later PHP namespace blocks", async () => {
      const root = path.resolve(process.cwd(), "tests", "samples", "php");
      const files = [
        path.join(root, "multi-namespace", "Library.php"),
        path.join(root, "bracketed-qualified-consumer.php"),
      ];
      const index = await createTestIndexFromFiles(root, files);
      const libraryFile = path.join(root, "multi-namespace", "Library.php").replace(/\\/g, "/");
      const qualifiedConsumerFile = path.join(root, "bracketed-qualified-consumer.php").replace(/\\/g, "/");

      const result = await testFindReferences(index, libraryFile, 8, 11, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, libraryFile, 8);
        expectReferenceAt(result, qualifiedConsumerFile, 3);
      }
    });
  });

  describe("JavaScript", () => {
    it("should find all references to exported function", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const utilsFile = path.join(samplePath, "utils.js").replace(/\\/g, "/");

      // Test find-references on helperFunction definition on line 1
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === utilsFile && ref.range.start.line === 1);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find all references to exported class", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const utilsFile = path.join(samplePath, "utils.js").replace(/\\/g, "/");

      // Test find-references on UtilityClass definition on line 5
      const result = await testFindReferences(index, utilsFile, 5, 14, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === utilsFile && ref.range.start.line === 5);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find references to namespace member", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const utilsFile = path.join(samplePath, "utils.js").replace(/\\/g, "/");

      // Test find-references on helperFunction definition
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        // Should find both direct usage and namespace usage
        const namespaceUsage = result.references.find(
          (ref) => ref.file.includes("main.js") && ref.via?.namespaceMember,
        );
        expect(namespaceUsage).toBeDefined();
      }
    });

    it("should find references to CommonJS exports", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const legacyFile = path.join(samplePath, "legacy.js").replace(/\\/g, "/");

      // Test find-references on legacyFunction definition on line 2
      const result = await testFindReferences(index, legacyFile, 2, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === legacyFile && ref.range.start.line === 2);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find references in mixed module systems", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const mixedFile = path.join(samplePath, "mixed.js").replace(/\\/g, "/");

      // Test find-references on mixedFunction definition on line 5
      const result = await testFindReferences(index, mixedFile, 5, 16, 1);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === mixedFile && ref.range.start.line === 5);
        expect(definitionRef).toBeDefined();
      }
    });
  });

  describe("Go", () => {
    it("should find all references to exported function", async () => {
      const index = await createTestIndex("go");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const utilsFile = path.join(samplePath, "utils.go").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 5, 6, 1);
      if (result.status === "ok") {
        expect(
          result.references.some((reference) => reference.file === utilsFile && reference.range.start.line === 5),
        ).toBe(true);
      }
    });

    it("should find all references to exported struct type", async () => {
      const index = await createTestIndex("go");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const utilsFile = path.join(samplePath, "utils.go").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.go").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 9, 6, 3);
      expectReferenceAt(result, utilsFile, 9);
      expectReferenceAt(result, mainFile, 12);
    });

    it("should find aliased and interface references to exported struct type", async () => {
      const index = await createTestIndex("go");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const utilsFile = path.join(samplePath, "utils.go").replace(/\\/g, "/");
      const aliasedFile = path.join(samplePath, "aliased-types.go").replace(/\\/g, "/");
      const interfacesFile = path.join(samplePath, "interfaces.go").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 9, 6, 4);
      expectReferenceAt(result, aliasedFile, 9);
      expectReferenceAt(result, interfacesFile, 9);
    });
  });

  describe("C", () => {
    it("should find all references to shared function declaration", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "c");
      const utilsFile = path.join(samplePath, "utils.h").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.c").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.h").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 8, 5, 2);
      expectReferenceAt(result, utilsFile, 8);
      expectReferenceAt(result, mainFile, 5);
    });

    it("should retain the typedef struct definition in references", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "c");
      const utilsFile = path.join(samplePath, "utils.h").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.c").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.h").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 4, 16, 2);
      expectReferenceAt(result, utilsFile, 6);
      expectReferenceAt(result, mainFile, 6);
    });

    it("should find references to function-pointer typedef use sites", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "c");
      const advancedUseFile = path.join(samplePath, "advanced-use.c").replace(/\\/g, "/");
      const functionPointersFile = path.join(samplePath, "function-pointers.h").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [advancedUseFile, functionPointersFile]);

      const result = await testFindReferences(index, functionPointersFile, 3, 15, 2);
      expectReferenceAt(result, functionPointersFile, 3);
      expectReferenceAt(result, advancedUseFile, 4);
    });

    it("does not recover macro-expanded typedef use sites", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "c");
      const advancedUseFile = path.join(samplePath, "advanced-use.c").replace(/\\/g, "/");
      const functionPointersFile = path.join(samplePath, "function-pointers.h").replace(/\\/g, "/");
      const macroHeaderFile = path.join(samplePath, "macro-typedef.h").replace(/\\/g, "/");
      const macroUseFile = path.join(samplePath, "macro-typedef-use.c").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [
        advancedUseFile,
        functionPointersFile,
        macroHeaderFile,
        macroUseFile,
      ]);

      const result = await testFindReferences(index, functionPointersFile, 3, 15, 2);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, functionPointersFile, 3);
        expectReferenceAt(result, advancedUseFile, 4);
        const macroInvocationRecovered = result.references.some(
          (reference) => reference.file === macroUseFile && reference.range.start.line === 4,
        );
        expect(macroInvocationRecovered).toBe(false);
      }
    });
  });

  describe("C++", () => {
    it("should find all references to shared function declaration", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "cpp");
      const utilsFile = path.join(samplePath, "utils.hpp").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.cpp").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.hpp").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 7, 5, 2);
      expectReferenceAt(result, utilsFile, 7);
      expectReferenceAt(result, mainFile, 5);
    });

    it("should find all references to shared struct type", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "cpp");
      const utilsFile = path.join(samplePath, "utils.hpp").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.cpp").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.hpp").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 3, 8, 2);
      expectReferenceAt(result, utilsFile, 3);
      expectReferenceAt(result, mainFile, 6);
    });

    it("should find references to namespace-qualified alias targets", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "cpp");
      const usageFile = path.join(samplePath, "namespace-usage.cpp").replace(/\\/g, "/");
      const namespaceFile = path.join(samplePath, "namespaces.hpp").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [usageFile, namespaceFile]);

      const result = await testFindReferences(index, namespaceFile, 4, 7, 2);
      expectReferenceAt(result, namespaceFile, 4);
      expectReferenceAt(result, usageFile, 4);
    });
  });

  describe("Kotlin", () => {
    it("should find all references to imported function", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
      const utilsFile = path.join(samplePath, "utils", "helperFunction.kt").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.kt").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers", "helperFromHelpers.kt").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 3, 5, 2);
      expectReferenceAt(result, utilsFile, 3);
      expectReferenceAt(result, mainFile, 6);
    });

    it("should retain the imported class definition in references", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
      const utilsFile = path.join(samplePath, "utils", "helperFunction.kt").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.kt").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers", "helperFromHelpers.kt").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 7, 7, 2);
      expectReferenceAt(result, utilsFile, 7);
      expectReferenceAt(result, mainFile, 7);
    });

    it("should find wildcard-imported references to type aliases", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
      const consumerFile = path.join(samplePath, "TypeConsumers.kt").replace(/\\/g, "/");
      const moreTypesFile = path.join(samplePath, "utils", "MoreTypes.kt").replace(/\\/g, "/");
      const helperFile = path.join(samplePath, "utils", "helperFunction.kt").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [consumerFile, moreTypesFile, helperFile]);

      const result = await testFindReferences(index, moreTypesFile, 3, 11, 2);
      expectReferenceAt(result, moreTypesFile, 3);
      expectReferenceAt(result, consumerFile, 3);
    });

    it("should find wildcard-imported references to helper functions", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
      const consumerFile = path.join(samplePath, "TypeConsumers.kt").replace(/\\/g, "/");
      const moreTypesFile = path.join(samplePath, "utils", "MoreTypes.kt").replace(/\\/g, "/");
      const helperFile = path.join(samplePath, "utils", "helperFunction.kt").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [consumerFile, moreTypesFile, helperFile]);

      const result = await testFindReferences(index, helperFile, 3, 5, 2);
      expectReferenceAt(result, helperFile, 3);
      expectReferenceAt(result, consumerFile, 12);
    });
  });

  describe("Swift", () => {
    it("should find all references to imported function", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "swift");
      const utilsFile = path.join(samplePath, "Utils.swift").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.swift").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "Helpers.swift").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 1, 13, 2);
      expectReferenceAt(result, utilsFile, 1);
      expectReferenceAt(result, mainFile, 5);
    });

    it("should find all references to imported struct", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "swift");
      const utilsFile = path.join(samplePath, "Utils.swift").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.swift").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "Helpers.swift").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 5, 15, 2);
      expectReferenceAt(result, utilsFile, 5);
      expectReferenceAt(result, mainFile, 6);
    });

    it("should find references to imported static factory types", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "swift");
      const usageFile = path.join(samplePath, "AdvancedUsage.swift").replace(/\\/g, "/");
      const staticMembersFile = path.join(samplePath, "StaticMembers.swift").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "Utils.swift").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [usageFile, staticMembersFile, utilsFile]);

      const result = await testFindReferences(index, staticMembersFile, 6, 8, 2);
      expectReferenceAt(result, staticMembersFile, 6);
      expectReferenceAt(result, usageFile, 4);
    });
  });

  describe("C#", () => {
    it("should find all references to static method", async () => {
      const index = await createTestIndex("csharp");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "csharp");
      const utilsFile = path.join(samplePath, "Utils.cs").replace(/\\/g, "/");
      // helperFunction definition line 3 col ~24
      await testFindReferences(index, utilsFile, 3, 24, 3);
    });

    it("should find all references to nested class", async () => {
      const index = await createTestIndex("csharp");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "csharp");
      const utilsFile = path.join(samplePath, "Utils.cs").replace(/\\/g, "/");
      // UtilityClass definition line 4 col ~20
      await testFindReferences(index, utilsFile, 4, 20, 2);
    });

    it("should find references to namespace member", async () => {
      const index = await createTestIndex("csharp");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "csharp");
      const utilsFile = path.join(samplePath, "Utils.cs").replace(/\\/g, "/");
      // UtilsClass definition line 2 col ~20
      await testFindReferences(index, utilsFile, 2, 20, 3);
    });

    it("should find references to aliased member", async () => {
      const index = await createTestIndex("csharp");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "csharp");
      const utilsFile = path.join(samplePath, "Utils.cs").replace(/\\/g, "/");
      await testFindReferences(index, utilsFile, 2, 20, 3);
    });
  });

  describe("Java", () => {
    it("should find references to wildcard-imported interfaces", async () => {
      const index = await createTestIndex("java");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
      const packageFile = path.join(samplePath, "pkg", "PackageTypes.java").replace(/\\/g, "/");
      const wildcardFile = path.join(samplePath, "WildcardImports.java").replace(/\\/g, "/");

      const result = await testFindReferences(index, packageFile, 7, 11, 2);
      expectReferenceAt(result, packageFile, 7);
      expectReferenceAt(result, wildcardFile, 7);
    });

    it("should find references to wildcard-imported package interfaces across files", async () => {
      const index = await createTestIndex("java");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
      const packageFile = path.join(samplePath, "pkg", "PackageService.java").replace(/\\/g, "/");
      const wildcardFile = path.join(samplePath, "WildcardImports.java").replace(/\\/g, "/");

      const result = await testFindReferences(index, packageFile, 3, 18, 2);
      expectReferenceAt(result, packageFile, 3);
      expectReferenceAt(result, wildcardFile, 8);
    });

    it("should find references to static wildcard-imported methods", async () => {
      const index = await createTestIndex("java");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
      const utilsFile = path.join(samplePath, "utils", "Utils.java").replace(/\\/g, "/");
      const wildcardFile = path.join(samplePath, "StaticWildcardImports.java").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 4, 22, 2);
      expectReferenceAt(result, utilsFile, 4);
      expectReferenceAt(result, wildcardFile, 7);
    });
  });
  describe("Ruby", () => {
    it("should find all references to module function", async () => {
      const index = await createTestIndex("ruby");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "ruby");
      const utilsFile = path.join(samplePath, "utils.rb").replace(/\\/g, "/");
      // helper_function definition line 2 col 12
      await testFindReferences(index, utilsFile, 2, 12, 2);
    });
    it("should find all references to class", async () => {
      const index = await createTestIndex("ruby");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "ruby");
      const utilsFile = path.join(samplePath, "utils.rb").replace(/\\/g, "/");
      // UtilityClass definition line 4 col 10
      await testFindReferences(index, utilsFile, 4, 10, 2);
    });

    it("should find references to namespaced classes", async () => {
      const index = await createTestIndex("ruby");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "ruby");
      const namespacedFile = path.join(samplePath, "namespaced.rb").replace(/\\/g, "/");
      const consumerFile = path.join(samplePath, "consumer.rb").replace(/\\/g, "/");

      const result = await testFindReferences(index, namespacedFile, 5, 11, 2);
      expectReferenceAt(result, namespacedFile, 5);
      expectReferenceAt(result, consumerFile, 3);
    });
  });

  describe("Rust", () => {
    it("should find all references to helper_function", async () => {
      const index = await createTestIndex("rust");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const utilsFile = path.join(samplePath, "utils.rs").replace(/\\/g, "/");
      // helper_function definition line 1 col 8
      await testFindReferences(index, utilsFile, 1, 8, 2);
    });
    it("should find all references to helper_from_helpers", async () => {
      const index = await createTestIndex("rust");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const helpersFile = path.join(samplePath, "helpers.rs").replace(/\\/g, "/");
      // helper_from_helpers definition line 1 col 8
      await testFindReferences(index, helpersFile, 1, 8, 2);
    });

    it("should find references to nested module types", async () => {
      const index = await createTestIndex("rust");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const nestedFile = path.join(samplePath, "nested.rs").replace(/\\/g, "/");
      const nestedServiceFile = path.join(samplePath, "nested_service.rs").replace(/\\/g, "/");

      const result = await testFindReferences(index, nestedServiceFile, 1, 12, 2);
      expectReferenceAt(result, nestedServiceFile, 1);
      expectReferenceAt(result, nestedFile, 6);
    });

    it("should find references through aliased Rust imports", async () => {
      const index = await createTestIndex("rust");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const utilsFile = path.join(samplePath, "utils.rs").replace(/\\/g, "/");
      const aliasFile = path.join(samplePath, "aliased-use.rs").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 1, 8, 3);
      expectReferenceAt(result, aliasFile, 9);
    });
  });
});
