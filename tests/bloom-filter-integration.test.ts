import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex, findReferences } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function isRetryableRmError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (!("code" in err)) return false;
  const code = err.code;
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

async function rmWithRetries(target: string): Promise<void> {
  const delaysMs = [0, 10, 25, 50, 100, 250];
  let lastErr: unknown;
  for (const delay of delaysMs) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryableRmError(err)) throw err;
    }
  }
  if (lastErr && !isRetryableRmError(lastErr)) throw lastErr;
}

// A call spaced with a Unicode separator that these grammars read as whitespace. Only the member call spells `helper`
// outside its definition: the importers name the class, so a filter holds the callee name only from the callee itself.
const SEPARATOR_CASES: Array<[string, string]> = [
  ["a no-break space", "\u00a0"],
  ["a line separator", "\u2028"],
  ["an ideographic space", "\u3000"],
];

type SeparatorFixture = {
  language: string;
  /** The file that defines the callee, and the position of its name in that file. */
  definition: { file: string; line: number; column: number };
  files: (separator: string) => Record<string, string>;
  /** The files that reference the definition, the defining file included. */
  referencing: string[];
};

function jsFamilyFixture(extension: string): SeparatorFixture {
  return {
    language: `a .${extension} file`,
    definition: { file: `api.${extension}`, line: 2, column: 10 },
    files: (separator) => ({
      [`api.${extension}`]: "export class Api {\n  static helper(a) {\n    return a;\n  }\n}\n",
      [`plain.${extension}`]: 'import { Api } from "./api";\nexport const plain = Api.helper("x");\n',
      [`separated.${extension}`]: `import { Api } from "./api";\nexport const separated = Api.helper${separator}("x");\n`,
      // A method of the same name on another class is no reference, however the call is spaced.
      [`decoy.${extension}`]: `export class Other {\n  static helper(a) {\n    return a;\n  }\n}\nexport const decoy = Other.helper${separator}("x");\n`,
    }),
    referencing: [`api.${extension}`, `plain.${extension}`, `separated.${extension}`],
  };
}

const SEPARATOR_FIXTURES: SeparatorFixture[] = [
  jsFamilyFixture("ts"),
  jsFamilyFixture("tsx"),
  jsFamilyFixture("js"),
  {
    language: "C#",
    definition: { file: "Api.cs", line: 2, column: 24 },
    files: (separator) => ({
      "Api.cs": "public class Api {\n  public static string Helper(string a) {\n    return a;\n  }\n}\n",
      "Plain.cs": 'public class Plain {\n  string v = Api.Helper("x");\n}\n',
      "Separated.cs": `public class Separated {\n  string v = Api.Helper${separator}("x");\n}\n`,
      "Decoy.cs": `public class Other {\n  public static string Helper(string a) {\n    return a;\n  }\n}\npublic class Decoy {\n  string v = Other.Helper${separator}("x");\n}\n`,
    }),
    referencing: ["Api.cs", "Plain.cs", "Separated.cs"],
  },
  {
    language: "Swift",
    definition: { file: "Api.swift", line: 2, column: 15 },
    files: (separator) => ({
      "Api.swift": "enum Api {\n  static func helper(_ a: String) -> String {\n    return a\n  }\n}\n",
      "Plain.swift": 'let plain = Api.helper("x")\n',
      "Separated.swift": `let separated = Api.helper${separator}("x")\n`,
      "Decoy.swift": `enum Other {\n  static func helper(_ a: String) -> String {\n    return a\n  }\n}\nlet decoy = Other.helper${separator}("x")\n`,
    }),
    referencing: ["Api.swift", "Plain.swift", "Separated.swift"],
  },
];
const SEPARATOR_FILE_CASES = SEPARATOR_FIXTURES.flatMap((fixture) =>
  SEPARATOR_CASES.map(([name, separator]): [string, string, SeparatorFixture, string] => [
    fixture.language,
    name,
    fixture,
    separator,
  ]),
);

describe("Bloom filter integration", () => {
  it("keeps references when symbols are imported with aliases", async () => {
    const root = await mkTmpDir("dg-bloom-alias-");
    const fileA = path.join(root, "a.ts");
    const fileB = path.join(root, "b.ts");

    await fsp.writeFile(fileA, "export function target() {\n  return 1;\n}\n", "utf8");
    await fsp.writeFile(fileB, "import { target as alias } from './a';\nexport const value = alias();\n", "utf8");

    try {
      const index = await buildProjectIndex(root, {
        cache: "off",
        useBloomFilters: true,
      });

      const file = fileA.replace(/\\/g, "/");
      const refs = await findReferences(index, { file, line: 1, column: 20 });

      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        const files = refs.references.map((ref) => ref.file);
        expect(files).toContain(fileB.replace(/\\/g, "/"));
      }
    } finally {
      await rmWithRetries(root);
    }
  });

  it("builds bloom filters even when cache is used", async () => {
    const root = await mkTmpDir("dg-bloom-cache-");
    const fileA = path.join(root, "a.ts");
    const fileB = path.join(root, "b.ts");

    await fsp.writeFile(fileA, "export const value = 123;\n", "utf8");
    await fsp.writeFile(fileB, "import { value } from './a';\nconsole.log(value);\n", "utf8");

    try {
      await buildProjectIndex(root, { cache: "disk", useBloomFilters: true });
      const index = await buildProjectIndex(root, {
        cache: "disk",
        useBloomFilters: true,
      });

      expect(index.bloomFilters).toBeDefined();
      if (index.bloomFilters) {
        expect(index.bloomFilters.size()).toBeGreaterThan(0);
      }
    } finally {
      await rmWithRetries(root);
    }
  });

  it.each(SEPARATOR_FILE_CASES)(
    "finds a call in %s whose callee is followed by %s",
    async (_language, _name, fixture, separator) => {
      const root = await mkTmpDir("dg-bloom-separator-");

      try {
        for (const [relative, source] of Object.entries(fixture.files(separator))) {
          await fsp.writeFile(path.join(root, relative), source, "utf8");
        }
        const referencingFiles = async (useBloomFilters: boolean): Promise<string[]> => {
          const index = await buildProjectIndex(root, { cache: "off", useBloomFilters });
          expect(index.bloomFilters !== undefined).toBe(useBloomFilters);
          const file = path.join(root, fixture.definition.file).replace(/\\/g, "/");
          const refs = await findReferences(index, {
            file,
            line: fixture.definition.line,
            column: fixture.definition.column,
          });
          if (refs.status !== "ok") throw new Error(`Expected references, found ${refs.status}`);
          return [...new Set(refs.references.map((ref) => path.basename(ref.file)))].sort();
        };

        expect(await referencingFiles(false)).toEqual(fixture.referencing);
        expect(await referencingFiles(true)).toEqual(fixture.referencing);
      } finally {
        await rmWithRetries(root);
      }
    },
  );
});
