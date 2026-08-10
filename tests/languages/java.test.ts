import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "java",
  samples: [
    {
      name: "chunks Java structures",
      sourceFile: "java.sample.java",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "class" && c.name === "MyClass")).toBe(true);
        expect(chunks.some((c) => c.type === "method" && c.name === "myMethod")).toBe(true);
        expect(chunks.some((c) => c.type === "interface" && c.name === "MyInterface")).toBe(true);
        expect(chunks.some((c) => c.type === "enum" && c.name === "MyEnum")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "java",
    dependencyGraph: [
      {
        from: "static-imports.java",
        to: { type: "file", path: "utils/Utils.java" },
      },
      {
        from: "static-imports.java",
        to: { type: "file", path: "helpers/Helpers.java" },
      },
      {
        from: "WildcardImports.java",
        to: { type: "file", path: "pkg/PackageTypes.java" },
      },
      {
        from: "WildcardImports.java",
        to: { type: "file", path: "pkg/PackageService.java" },
      },
      {
        from: "StaticWildcardImports.java",
        to: { type: "file", path: "utils/Utils.java" },
      },
    ],
    symbols: [
      {
        file: "NestedTypes.java",
        includes: [{ name: "NestedTypes" }, { name: "InnerHelper" }, { name: "run" }, { name: "Contract" }],
      },
      {
        file: "utils/Utils.java",
        includes: [{ name: "UtilityClass" }],
      },
      {
        file: "pkg/PackageTypes.java",
        includes: [{ name: "PackageTypes" }, { name: "NestedValue" }, { name: "ServiceContract" }],
      },
      {
        file: "pkg/Mode.java",
        includes: [
          { name: "Mode", kind: "type" },
          { name: "FAST", kind: "variable" },
          { name: "SLOW", kind: "variable" },
        ],
      },
      {
        file: "pkg/PackageService.java",
        includes: [{ name: "PackageService" }],
      },
      {
        file: "pkg/ScopedEnums.java",
        includes: [
          { name: "ScopedEnums", kind: "class" },
          { name: "PrimaryMode", kind: "type" },
          { name: "SecondaryMode", kind: "type" },
          { name: "Ready", kind: "variable" },
        ],
      },
      {
        file: "RecordTypes.java",
        includes: [
          { name: "Point", kind: "class" },
          { name: "NamedShape", kind: "class" },
          { name: "Sized", kind: "interface" },
        ],
      },
    ],
    goToDefinition: [
      {
        name: "go to definition resolves wildcard-imported nested type",
        file: "WildcardImports.java",
        line: 6,
        column: 16,
        expectedDefinition: { file: "pkg/PackageTypes.java", line: 4 },
      },
      {
        name: "go to definition resolves wildcard-imported package interfaces across files",
        file: "WildcardImports.java",
        line: 8,
        column: 3,
        expectedDefinition: { file: "pkg/PackageService.java", line: 3 },
      },
      {
        name: "go to definition resolves wildcard-imported enum type",
        file: "WildcardImports.java",
        line: 9,
        column: 3,
        expectedDefinition: { file: "pkg/Mode.java", line: 3 },
      },
      {
        name: "go to definition resolves wildcard-imported enum constants",
        file: "WildcardImports.java",
        line: 9,
        column: 20,
        expectedDefinition: { file: "pkg/Mode.java", line: 4 },
      },
      {
        name: "go to definition resolves enum constants by owner",
        file: "EnumMemberAccess.java",
        line: 6,
        column: 62,
        expectedDefinition: { file: "pkg/ScopedEnums.java", line: 18 },
      },
      {
        name: "go to definition ignores nested locals for missing Java owner members",
        file: "EnumMemberAccess.java",
        line: 7,
        column: 32,
        expectedStatus: "not_found",
      },
      {
        name: "go to definition resolves static wildcard imports",
        file: "StaticWildcardImports.java",
        line: 7,
        column: 5,
        expectedDefinition: { file: "utils/Utils.java", line: 4 },
      },
    ],
    references: [
      {
        name: "find references for wildcard-imported interface",
        file: "pkg/PackageTypes.java",
        line: 7,
        column: 11,
        minimumCount: 2,
      },
      {
        name: "find references for wildcard-imported package interfaces across files",
        file: "pkg/PackageService.java",
        line: 3,
        column: 18,
        minimumCount: 2,
      },
      {
        name: "find references for static wildcard-imported methods",
        file: "utils/Utils.java",
        line: 4,
        column: 22,
        minimumCount: 2,
      },
    ],
  },
};

runLanguageTests(definition);
