import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildProjectIndexFromFiles,
  findReferences,
  goToDefinition,
  listSymbols,
  type ProjectIndex,
} from "../src/index.js";
import * as nativeRuntime from "../src/native/treeSitterNative.js";

const nativeDescribe = nativeRuntime.isNativeTreeSitterAvailable()
  ? describe
  : describe.skip;
const sampleRoot = path.resolve(process.cwd(), "tests", "samples");
const tempDirs: string[] = [];

type SymbolExpectation = {
  file: string;
  names: string[];
};

type SemanticExpectation = {
  root: string;
  files: string[];
  symbols?: SymbolExpectation[];
  goto: {
    file: string;
    line: number;
    column: number;
    expectedStatus: "ok" | "not_found";
  };
  references: {
    file: string;
    line: number;
    column: number;
    expectedStatus: "ok" | "not_found";
  };
};

afterAll(async () => {
  for (const dir of tempDirs) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

function normalizeFile(file: string): string {
  return path.resolve(file).replace(/\\/g, "/");
}

function normalizeGraphEdges(index: ProjectIndex): string[] {
  return index.graph.edges
    .map((edge) => {
      const target =
        edge.to.type === "file"
          ? `file:${normalizeFile(edge.to.path)}`
          : `external:${edge.to.name}`;
      return `${normalizeFile(edge.from)}=>${target}`;
    })
    .sort();
}

function normalizeSymbols(
  index: ProjectIndex,
  expectations: SymbolExpectation[] | undefined,
): Record<string, string[]> {
  if (!expectations) {
    return {};
  }
  const normalized: Record<string, string[]> = {};
  for (const expectation of expectations) {
    const file = normalizeFile(expectation.file);
    const symbolNames = new Set(
      listSymbols(index, { file }).map((symbol) => symbol.name),
    );
    normalized[file] = expectation.names
      .filter((name) => symbolNames.has(name))
      .sort();
  }
  return normalized;
}

async function normalizeGoto(
  index: ProjectIndex,
  request: SemanticExpectation["goto"],
): Promise<{ status: "ok"; file: string; line: number } | { status: "not_found" }> {
  const result = await goToDefinition(index, {
    file: normalizeFile(request.file),
    line: request.line,
    column: request.column,
  });
  if (result.status !== "ok") {
    return { status: "not_found" };
  }
  return {
    status: "ok",
    file: normalizeFile(result.definition.file),
    line: result.definition.range.start.line,
  };
}

async function normalizeReferences(
  index: ProjectIndex,
  request: SemanticExpectation["references"],
): Promise<
  | { status: "ok"; refs: string[] }
  | { status: "not_found" }
> {
  const result = await findReferences(index, {
    file: normalizeFile(request.file),
    line: request.line,
    column: request.column,
  });
  if (result.status !== "ok") {
    return { status: "not_found" };
  }
  return {
    status: "ok",
    refs: result.references
      .map((reference) => `${normalizeFile(reference.file)}:${reference.range.start.line}`)
      .sort(),
  };
}

async function withNativeMode<T>(
  mode: "native" | "js",
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.CODEGRAPH_DISABLE_NATIVE;
  if (mode === "js") {
    process.env.CODEGRAPH_DISABLE_NATIVE = "1";
  } else {
    delete process.env.CODEGRAPH_DISABLE_NATIVE;
  }
  nativeRuntime.__resetNativeTreeSitterBindingForTests();
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.CODEGRAPH_DISABLE_NATIVE;
    } else {
      process.env.CODEGRAPH_DISABLE_NATIVE = previous;
    }
    nativeRuntime.__resetNativeTreeSitterBindingForTests();
  }
}

async function buildSemanticIndex(
  expectation: SemanticExpectation,
  mode: "native" | "js",
): Promise<ProjectIndex> {
  return await withNativeMode(mode, async () => {
    const files = expectation.files.map(normalizeFile);
    return await buildProjectIndexFromFiles(expectation.root, files);
  });
}

function sampleExpectation(
  rootDir: string,
  files: string[],
  symbols: SymbolExpectation[] | undefined,
  goto: SemanticExpectation["goto"],
  references: SemanticExpectation["references"],
): SemanticExpectation {
  const root = path.join(sampleRoot, rootDir);
  return {
    root,
    files: files.map((file) => path.join(root, file)),
    symbols: symbols?.map((expectation) => ({
      file: path.join(root, expectation.file),
      names: expectation.names,
    })),
    goto: { ...goto, file: path.join(root, goto.file) },
    references: { ...references, file: path.join(root, references.file) },
  };
}

async function expectSemanticParity(
  expectation: SemanticExpectation,
): Promise<void> {
  const nativeIndex = await buildSemanticIndex(expectation, "native");
  const jsIndex = await buildSemanticIndex(expectation, "js");

  expect(normalizeGraphEdges(nativeIndex)).toEqual(normalizeGraphEdges(jsIndex));
  expect(normalizeSymbols(nativeIndex, expectation.symbols)).toEqual(
    normalizeSymbols(jsIndex, expectation.symbols),
  );

  const nativeGoto = await normalizeGoto(nativeIndex, expectation.goto);
  const jsGoto = await normalizeGoto(jsIndex, expectation.goto);
  expect(nativeGoto).toEqual(jsGoto);
  expect(nativeGoto.status).toBe(expectation.goto.expectedStatus);

  const nativeReferences = await normalizeReferences(nativeIndex, expectation.references);
  const jsReferences = await normalizeReferences(jsIndex, expectation.references);
  expect(nativeReferences).toEqual(jsReferences);
  expect(nativeReferences.status).toBe(expectation.references.expectedStatus);
}

async function createTypeScriptNormalizationCase(): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-semantic-"));
  tempDirs.push(root);
  const moduleFile = path.join(root, "module.ts");
  const consumerFile = path.join(root, "consumer.ts");

  await fsp.writeFile(
    moduleFile,
    [
      "class InternalClass {}",
      "export class ExportedClass {}",
      "const assigned = InternalClass;",
      "export = assigned;",
    ].join("\n"),
    "utf8",
  );
  await fsp.writeFile(
    consumerFile,
    [
      "import assigned = require('./module');",
      "const instance = new assigned();",
      "console.log(instance);",
    ].join("\n"),
    "utf8",
  );

  return {
    root,
    files: [moduleFile, consumerFile],
    symbols: [
      {
        file: moduleFile,
        names: ["InternalClass", "ExportedClass", "assigned"],
      },
    ],
    goto: {
      file: consumerFile,
      line: 2,
      column: 22,
      expectedStatus: "ok",
    },
    references: {
      file: moduleFile,
      line: 3,
      column: 7,
      expectedStatus: "ok",
    },
  };
}

nativeDescribe("native semantic parity", () => {
  it(
    "matches native and JS semantics for representative language fixtures",
    async () => {
    const cases: SemanticExpectation[] = [
      sampleExpectation(
        "typescript",
        ["main.ts", "utils.ts", "helpers.ts"],
        [{ file: "utils.ts", names: ["helperFunction", "UtilityClass"] }],
        { file: "main.ts", line: 7, column: 25, expectedStatus: "ok" },
        { file: "utils.ts", line: 1, column: 16, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "javascript",
        ["main.js", "utils.js", "helpers.js"],
        [{ file: "utils.js", names: ["helperFunction", "UtilityClass"] }],
        { file: "main.js", line: 7, column: 25, expectedStatus: "ok" },
        { file: "utils.js", line: 1, column: 16, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "tsx",
        ["App.tsx", "components/Button.tsx", "utils.ts"],
        [{ file: "components/Button.tsx", names: ["Button"] }],
        { file: "App.tsx", line: 6, column: 20, expectedStatus: "ok" },
        { file: "utils.ts", line: 3, column: 17, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "python",
        ["main.py", "utils.py", "helpers.py"],
        [{ file: "utils.py", names: ["helper_function", "UtilityClass"] }],
        { file: "main.py", line: 11, column: 18, expectedStatus: "ok" },
        { file: "utils.py", line: 1, column: 16, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "go",
        ["main.go", "utils.go", "helpers.go"],
        [{ file: "utils.go", names: ["HelperFunction", "UtilityClass"] }],
        { file: "main.go", line: 9, column: 9, expectedStatus: "ok" },
        { file: "utils.go", line: 9, column: 6, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "java",
        ["main.java", "utils/Utils.java", "helpers/Helpers.java"],
        [{ file: "utils/Utils.java", names: ["Utils", "helperFunction"] }],
        { file: "main.java", line: 8, column: 11, expectedStatus: "ok" },
        { file: "utils/Utils.java", line: 4, column: 22, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "csharp",
        ["Main.cs", "Utils.cs", "Helpers.cs"],
        [{ file: "Utils.cs", names: ["UtilsClass", "HelperFunction"] }],
        { file: "Main.cs", line: 7, column: 16, expectedStatus: "ok" },
        { file: "Utils.cs", line: 3, column: 24, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "rust",
        ["main.rs", "utils.rs", "helpers.rs"],
        [{ file: "utils.rs", names: ["helper_function", "UtilityStruct"] }],
        { file: "main.rs", line: 8, column: 5, expectedStatus: "ok" },
        { file: "utils.rs", line: 1, column: 8, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "kotlin",
        ["main.kt", "utils/helperFunction.kt", "helpers/helperFromHelpers.kt"],
        [{ file: "utils/helperFunction.kt", names: ["helperFunction", "UtilityClass"] }],
        { file: "main.kt", line: 6, column: 15, expectedStatus: "ok" },
        { file: "utils/helperFunction.kt", line: 3, column: 5, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "swift",
        ["main.swift", "Utils.swift", "Helpers.swift"],
        [{ file: "Utils.swift", names: ["helperFunction", "UtilityStruct"] }],
        { file: "main.swift", line: 5, column: 21, expectedStatus: "ok" },
        { file: "Utils.swift", line: 1, column: 13, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "c",
        ["main.c", "utils.h", "utils.c", "helpers.h", "helpers.c"],
        [{ file: "utils.h", names: ["helper_function", "Utility"] }],
        { file: "main.c", line: 5, column: 15, expectedStatus: "ok" },
        { file: "utils.h", line: 8, column: 5, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "cpp",
        ["main.cpp", "utils.hpp", "helpers.hpp"],
        [{ file: "utils.hpp", names: ["helperFunction", "UtilityClass"] }],
        { file: "main.cpp", line: 5, column: 15, expectedStatus: "ok" },
        { file: "utils.hpp", line: 7, column: 5, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "ruby",
        ["main.rb", "utils.rb", "helpers.rb"],
        [{ file: "utils.rb", names: ["helper_function", "UtilityClass"] }],
        { file: "main.rb", line: 4, column: 7, expectedStatus: "ok" },
        { file: "utils.rb", line: 2, column: 12, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "html",
        ["index.html", "about.html", "app.js", "inline-helper.js", "styles.css"],
        undefined,
        { file: "index.html", line: 10, column: 14, expectedStatus: "not_found" },
        { file: "index.html", line: 10, column: 14, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "css",
        ["main.css", "base.css", "theme.css"],
        undefined,
        { file: "base.css", line: 1, column: 2, expectedStatus: "not_found" },
        { file: "base.css", line: 1, column: 2, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "less",
        ["main.less", "variables.less", "theme.less"],
        undefined,
        { file: "variables.less", line: 1, column: 2, expectedStatus: "not_found" },
        { file: "variables.less", line: 1, column: 2, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "scss",
        ["main.scss", "use-partials.scss", "_variables.scss", "_mixins.scss"],
        undefined,
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "not_found" },
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "vue",
        ["App.vue", "Child.vue", "logic.ts"],
        undefined,
        { file: "App.vue", line: 2, column: 17, expectedStatus: "not_found" },
        { file: "App.vue", line: 2, column: 17, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "svelte",
        ["App.svelte", "Widget.svelte", "logic.ts"],
        undefined,
        { file: "App.svelte", line: 2, column: 17, expectedStatus: "not_found" },
        { file: "App.svelte", line: 2, column: 17, expectedStatus: "not_found" },
      ),
    ];

    for (const testCase of cases) {
      await expectSemanticParity(testCase);
    }
    },
    30_000,
  );

  it("matches native and JS semantics for normalization-sensitive TypeScript export assignment", async () => {
    const testCase = await createTypeScriptNormalizationCase();
    await expectSemanticParity(testCase);
  });
});
