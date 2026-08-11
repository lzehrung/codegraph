import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "java",
  samples: [
    {
      name: "chunks Java structures",
      sourceFile: "java.sample.java",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 4 },
        { type: "class", name: "MyClass", startLine: 5, endLine: 15 },
        { type: "method", name: "MyClass", startLine: 8, endLine: 10 },
        { type: "method", name: "myMethod", startLine: 12, endLine: 14 },
        { type: "misc", startLine: 15, endLine: 16 },
        { type: "interface", name: "MyInterface", startLine: 17, endLine: 19 },
        { type: "method", name: "interfaceMethod", startLine: 18, endLine: 18 },
        { type: "misc", startLine: 19, endLine: 20 },
        { type: "enum", name: "MyEnum", startLine: 21, endLine: 25 },
      ],
    },
  ],
  parity: {
    sampleDir: "java",
    exact: {
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
          to: { type: "file", path: "pkg/Mode.java" },
        },
        {
          from: "WildcardImports.java",
          to: { type: "file", path: "pkg/PackageService.java" },
        },
        {
          from: "WildcardImports.java",
          to: { type: "file", path: "pkg/PackageTypes.java" },
        },
        {
          from: "WildcardImports.java",
          to: { type: "file", path: "pkg/ScopedEnums.java" },
        },
        {
          from: "StaticWildcardImports.java",
          to: { type: "file", path: "utils/Utils.java" },
        },
        {
          from: "EnumMemberAccess.java",
          to: { type: "file", path: "pkg/ScopedEnums.java" },
        },
      ],
      symbols: [
        {
          file: "NestedTypes.java",
          symbols: [
            { name: "NestedTypes", kind: "class" },
            { name: "InnerHelper", kind: "class" },
            { name: "run", kind: "function" },
            { name: "Contract", kind: "interface" },
            { name: "execute", kind: "function" },
          ],
        },
        {
          file: "utils/Utils.java",
          symbols: [
            { name: "Utils", kind: "class" },
            { name: "helperFunction", kind: "function" },
            { name: "UtilityClass", kind: "class" },
          ],
        },
        {
          file: "pkg/PackageTypes.java",
          symbols: [
            { name: "PackageTypes", kind: "class" },
            { name: "NestedValue", kind: "class" },
            { name: "ServiceContract", kind: "interface" },
            { name: "serve", kind: "function" },
          ],
        },
        {
          file: "pkg/Mode.java",
          symbols: [
            { name: "Mode", kind: "type" },
            { name: "FAST", kind: "variable" },
            { name: "SLOW", kind: "variable" },
          ],
        },
        {
          file: "pkg/PackageService.java",
          symbols: [
            { name: "PackageService", kind: "interface" },
            { name: "serve", kind: "function" },
          ],
        },
        {
          file: "pkg/ScopedEnums.java",
          symbols: [
            { name: "ScopedEnums", kind: "class" },
            { name: "PrimaryMode", kind: "type" },
            { name: "Ready", kind: "variable" },
            { name: "shadow", kind: "function" },
            { name: "SecondaryMode", kind: "variable" },
            { name: "Missing", kind: "variable" },
            { name: "nested", kind: "variable" },
            { name: "Missing", kind: "variable" },
            { name: "SecondaryMode", kind: "type" },
            { name: "Ready", kind: "variable" },
          ],
        },
        {
          file: "RecordTypes.java",
          symbols: [
            { name: "Sized", kind: "interface" },
            { name: "size", kind: "function" },
            { name: "Point", kind: "class" },
            { name: "sum", kind: "function" },
            { name: "NamedShape", kind: "class" },
            { name: "size", kind: "function" },
          ],
        },
        {
          file: "AnnotationTypes.java",
          symbols: [{ name: "AnnotatedMarker", kind: "interface" }],
        },
      ],
      references: [
        {
          name: "find references for wildcard-imported interface",
          file: "pkg/PackageTypes.java",
          line: 7,
          column: 11,
          exactCount: 2,
        },
        {
          name: "find references for wildcard-imported package interfaces across files",
          file: "pkg/PackageService.java",
          line: 3,
          column: 18,
          exactCount: 2,
        },
        {
          name: "find references for static wildcard-imported methods",
          file: "utils/Utils.java",
          line: 4,
          column: 22,
          exactCount: 4,
        },
      ],
    },
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
  },
};

runLanguageTests(definition);
