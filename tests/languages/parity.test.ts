import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definitions: LanguageTestDefinition[] = [
  {
    id: "typescript",
    parity: {
      sampleDir: "typescript",
      dependencyGraph: [
        { from: "main.ts", to: { type: "file", path: "utils.ts" } },
        { from: "utils.ts", to: { type: "file", path: "helpers.ts" } },
      ],
      symbols: [
        {
          file: "utils.ts",
          includes: [
            { name: "helperFunction" },
            { name: "UtilityClass" },
            { name: "UtilityType" },
          ],
        },
      ],
      goToDefinition: [
        {
          name: "go to definition resolves helperFunction",
          file: "main.ts",
          line: 7,
          column: 25,
          expectedDefinition: { file: "utils.ts", line: 1 },
        },
      ],
      references: [
        {
          name: "find references for helperFunction",
          file: "utils.ts",
          line: 1,
          column: 16,
          minimumCount: 3,
        },
      ],
    },
  },
  {
    id: "tsx",
    parity: {
      sampleDir: "tsx",
      dependencyGraph: [
        { from: "App.tsx", to: { type: "file", path: "components/Button.tsx" } },
        { from: "App.tsx", to: { type: "file", path: "utils.ts" } },
        { from: "utils.ts", to: { type: "external", name: "lodash" } },
      ],
      symbols: [
        {
          file: "components/Button.tsx",
          includes: [{ name: "Button" }, { name: "ButtonProps" }],
        },
      ],
      goToDefinition: [
        {
          name: "go to definition resolves Button",
          file: "App.tsx",
          line: 6,
          column: 20,
          expectedDefinition: { file: "components/Button.tsx", line: 5 },
        },
      ],
      references: [
        {
          name: "find references for formatLabel",
          file: "utils.ts",
          line: 3,
          column: 17,
          minimumCount: 2,
        },
      ],
    },
  },
  {
    id: "javascript",
    parity: {
      sampleDir: "javascript",
      dependencyGraph: [
        { from: "main.js", to: { type: "file", path: "utils.js" } },
        { from: "main.js", to: { type: "file", path: "helpers.js" } },
      ],
      symbols: [
        {
          file: "utils.js",
          includes: [{ name: "helperFunction" }, { name: "UtilityClass" }],
        },
      ],
      goToDefinition: [
        {
          name: "go to definition resolves helperFunction",
          file: "main.js",
          line: 7,
          column: 25,
          expectedDefinition: { file: "utils.js", line: 1 },
        },
      ],
      references: [
        {
          name: "find references for helperFunction",
          file: "utils.js",
          line: 1,
          column: 16,
          minimumCount: 3,
        },
      ],
    },
  },
  {
    id: "python",
    parity: {
      sampleDir: "python",
      dependencyGraph: [
        { from: "main.py", to: { type: "file", path: "utils.py" } },
        { from: "main.py", to: { type: "file", path: "helpers.py" } },
      ],
      symbols: [
        {
          file: "utils.py",
          includes: [{ name: "helper_function" }, { name: "UtilityClass" }],
        },
      ],
      goToDefinition: [
        {
          name: "go to definition resolves helper_function",
          file: "main.py",
          line: 11,
          column: 18,
          expectedDefinition: { file: "utils.py", line: 1 },
        },
      ],
      references: [
        {
          name: "find references for helper_function",
          file: "utils.py",
          line: 1,
          column: 16,
          minimumCount: 3,
        },
      ],
    },
  },
  {
    id: "go",
    parity: {
      sampleDir: "go",
      dependencyGraph: [
        { from: "main.go", to: { type: "file", path: "utils.go" } },
        { from: "main.go", to: { type: "file", path: "helpers.go" } },
        { from: "utils.go", to: { type: "file", path: "helpers.go" } },
      ],
      symbols: [
        {
          file: "utils.go",
          includes: [{ name: "HelperFunction" }, { name: "UtilityClass" }],
        },
      ],
      goToDefinition: [
        {
          name: "go to definition resolves HelperFunction",
          file: "main.go",
          line: 9,
          column: 9,
          expectedStatus: "not_found",
        },
      ],
      references: [
        {
          name: "find references for HelperFunction",
          file: "utils.go",
          line: 5,
          column: 6,
          minimumCount: 1,
        },
      ],
    },
  },
  {
    id: "java",
    parity: {
      sampleDir: "java",
      dependencyGraph: [
        { from: "main.java", to: { type: "file", path: "utils/Utils.java" } },
        { from: "main.java", to: { type: "file", path: "helpers/Helpers.java" } },
      ],
      symbols: [
        {
          file: "utils/Utils.java",
          includes: [{ name: "Utils" }, { name: "helperFunction" }],
        },
      ],
      goToDefinition: [
        {
          name: "go to definition resolves helperFunction",
          file: "main.java",
          line: 8,
          column: 11,
          expectedDefinition: { file: "utils/Utils.java", line: 4 },
        },
      ],
      references: [
        {
          name: "find references for helperFunction",
          file: "utils/Utils.java",
          line: 4,
          column: 22,
          minimumCount: 1,
        },
      ],
    },
  },
  {
    id: "csharp",
    parity: {
      sampleDir: "csharp",
      dependencyGraph: [
        { from: "Main.cs", to: { type: "file", path: "Utils.cs" } },
        { from: "Main.cs", to: { type: "file", path: "Helpers.cs" } },
      ],
      symbols: [
        {
          file: "Utils.cs",
          includes: [{ name: "UtilsClass" }, { name: "HelperFunction" }],
        },
      ],
      goToDefinition: [
        {
          name: "go to definition resolves HelperFunction",
          file: "Main.cs",
          line: 7,
          column: 16,
          expectedDefinition: { file: "Utils.cs", line: 3 },
        },
      ],
      references: [
        {
          name: "find references for HelperFunction",
          file: "Utils.cs",
          line: 3,
          column: 24,
          minimumCount: 3,
        },
      ],
    },
  },
  {
    id: "ruby",
    parity: {
      sampleDir: "ruby",
      dependencyGraph: [
        { from: "main.rb", to: { type: "file", path: "utils.rb" } },
        { from: "main.rb", to: { type: "file", path: "helpers.rb" } },
      ],
      symbols: [
        {
          file: "utils.rb",
          includes: [{ name: "helper_function" }, { name: "UtilityClass" }],
        },
      ],
      goToDefinition: [
        {
          name: "go to definition resolves helper_function",
          file: "main.rb",
          line: 4,
          column: 7,
          expectedDefinition: { file: "utils.rb", line: 2 },
        },
      ],
      references: [
        {
          name: "find references for helper_function",
          file: "utils.rb",
          line: 2,
          column: 12,
          minimumCount: 2,
        },
      ],
    },
  },
  {
    id: "rust",
    parity: {
      sampleDir: "rust",
      dependencyGraph: [
        { from: "main.rs", to: { type: "file", path: "utils.rs" } },
        { from: "main.rs", to: { type: "file", path: "helpers.rs" } },
      ],
      symbols: [
        {
          file: "utils.rs",
          includes: [{ name: "helper_function" }, { name: "UtilityStruct" }],
        },
      ],
      goToDefinition: [
        {
          name: "go to definition resolves helper_function",
          file: "main.rs",
          line: 8,
          column: 5,
          expectedDefinition: { file: "utils.rs", line: 1 },
        },
      ],
      references: [
        {
          name: "find references for helper_function",
          file: "utils.rs",
          line: 1,
          column: 8,
          minimumCount: 2,
        },
      ],
    },
  },
  {
    id: "html",
    parity: {
      sampleDir: "html",
      goToDefinition: [
        {
          name: "go to definition is not available",
          file: "index.html",
          line: 9,
          column: 14,
          expectedStatus: "not_found",
        },
      ],
      references: [
        {
          name: "find references is not available",
          file: "index.html",
          line: 9,
          column: 14,
          expectedStatus: "not_found",
        },
      ],
    },
  },
  {
    id: "css",
    parity: {
      sampleDir: "css",
      goToDefinition: [
        {
          name: "go to definition is not available",
          file: "base.css",
          line: 1,
          column: 2,
          expectedStatus: "not_found",
        },
      ],
      references: [
        {
          name: "find references is not available",
          file: "base.css",
          line: 1,
          column: 2,
          expectedStatus: "not_found",
        },
      ],
    },
  },
  {
    id: "scss",
    parity: {
      sampleDir: "scss",
      dependencyGraph: [
        { from: "main.scss", to: { type: "external", name: "./variables" } },
        { from: "main.scss", to: { type: "external", name: "./mixins" } },
        { from: "main.scss", to: { type: "external", name: "./missing" } },
      ],
      goToDefinition: [
        {
          name: "go to definition is not available",
          file: "_variables.scss",
          line: 3,
          column: 2,
          expectedStatus: "not_found",
        },
      ],
      references: [
        {
          name: "find references is not available",
          file: "_variables.scss",
          line: 3,
          column: 2,
          expectedStatus: "not_found",
        },
      ],
    },
  },
  {
    id: "less",
    parity: {
      sampleDir: "less",
      goToDefinition: [
        {
          name: "go to definition is not available",
          file: "variables.less",
          line: 3,
          column: 2,
          expectedStatus: "not_found",
        },
      ],
      references: [
        {
          name: "find references is not available",
          file: "variables.less",
          line: 3,
          column: 2,
          expectedStatus: "not_found",
        },
      ],
    },
  },
  {
    id: "vue",
    parity: {
      sampleDir: "vue",
      goToDefinition: [
        {
          name: "go to definition is not available",
          file: "App.vue",
          line: 2,
          column: 17,
          expectedStatus: "not_found",
        },
      ],
      references: [
        {
          name: "find references is not available",
          file: "App.vue",
          line: 2,
          column: 17,
          expectedStatus: "not_found",
        },
      ],
    },
  },
  {
    id: "svelte",
    parity: {
      sampleDir: "svelte",
      goToDefinition: [
        {
          name: "go to definition is not available",
          file: "App.svelte",
          line: 3,
          column: 19,
          expectedStatus: "not_found",
        },
      ],
      references: [
        {
          name: "find references is not available",
          file: "App.svelte",
          line: 3,
          column: 19,
          expectedStatus: "not_found",
        },
      ],
    },
  },
];

for (const definition of definitions) {
  runLanguageTests(definition);
}
