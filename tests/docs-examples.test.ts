import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(import.meta.dirname, "..");
const documentedFiles = [
  "README.md",
  "docs/library-api.md",
  "docs/agent-workflows.md",
  "packages/codegraph-core/README.md",
] as const;
const typescriptPath = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");

type DocumentedExample = {
  file: string;
  source: string;
};

function extractTypeScriptExamples(file: string, source: string): DocumentedExample[] {
  const examples: DocumentedExample[] = [];
  const pattern = /^```ts\r?\n([\s\S]*?)^```$/gm;
  let match = pattern.exec(source);
  while (match) {
    const exampleSource = match[1];
    if (exampleSource === undefined) throw new Error(`Missing TypeScript fence source in ${file}.`);
    examples.push({ file, source: exampleSource });
    match = pattern.exec(source);
  }
  return examples;
}

function documentationTsconfig() {
  return {
    compilerOptions: {
      baseUrl: rootDir,
      exactOptionalPropertyTypes: true,
      module: "nodenext",
      moduleDetection: "force",
      moduleResolution: "nodenext",
      noEmit: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      strict: true,
      target: "esnext",
      typeRoots: [path.join(rootDir, "node_modules", "@types")],
      types: ["node"],
      verbatimModuleSyntax: true,
      paths: {
        "@lzehrung/codegraph": ["dist/index.d.ts"],
        "@lzehrung/codegraph/agent": ["dist/agent.d.ts"],
        "@lzehrung/codegraph/mcp": ["dist/mcp.d.ts"],
        "@lzehrung/codegraph-core": ["packages/codegraph-core/dist/index.d.ts"],
        "@lzehrung/codegraph-core/agent": ["packages/codegraph-core/dist/agent.d.ts"],
      },
    },
    include: ["*.ts"],
  };
}

describe("documented TypeScript examples", () => {
  it("compiles every TypeScript fence against built declarations", async () => {
    const documentSources = await Promise.all(
      documentedFiles.map(async (file) => ({ file, source: await fsp.readFile(path.join(rootDir, file), "utf8") })),
    );
    const examples = documentSources.flatMap(({ file, source }) => extractTypeScriptExamples(file, source));
    expect(examples.length).toBeGreaterThan(0);

    const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-doc-examples-"));
    try {
      await fsp.writeFile(path.join(temporaryDirectory, "package.json"), '{"type":"module"}\n', "utf8");
      await fsp.writeFile(
        path.join(temporaryDirectory, "tsconfig.json"),
        `${JSON.stringify(documentationTsconfig(), null, 2)}\n`,
        "utf8",
      );
      await Promise.all(
        examples.map(async (example, index) => {
          const label = `${example.file} TypeScript fence ${index + 1}`;
          const source = `// ${label}\n${example.source}`;
          await fsp.writeFile(path.join(temporaryDirectory, `example-${index}.ts`), source, "utf8");
        }),
      );

      const result = spawnSync(process.execPath, [typescriptPath, "--project", "tsconfig.json"], {
        cwd: temporaryDirectory,
        encoding: "utf8",
        timeout: 30_000,
      });
      if (result.error) throw result.error;
      expect(result.status, `${result.stdout}\n${result.stderr}`.trim()).toBe(0);
    } finally {
      await fsp.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
