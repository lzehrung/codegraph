import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findReferences, type ReferenceCoverage } from "../src/index.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { createTestIndexFromFiles } from "./test-utils.js";

type CoverageLookup = {
  coverage: ReferenceCoverage;
  file: (relativePath: string) => string;
};

/** Index `sources` and return reference coverage for the named definition. */
async function findCoverage(
  sources: Readonly<Record<string, string>>,
  definition: { file: string; name: string },
): Promise<CoverageLookup> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-parse-error-coverage-"));
  try {
    const files = new Map<string, string>();
    for (const [relativePath, contents] of Object.entries(sources)) {
      const filePath = path.join(root, relativePath).replace(/\\/g, "/");
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, contents, "utf8");
      files.set(relativePath, filePath);
    }
    const index = await createTestIndexFromFiles(root, [...files.values()]);
    const definitionPath = files.get(definition.file);
    if (!definitionPath) throw new Error(`Missing definition file ${definition.file}`);
    const def = index.byFile
      .get(fileIdentityKey(definitionPath))
      ?.locals.find((local) => local.localName === definition.name);
    if (!def) throw new Error(`Missing ${definition.name} in ${definition.file}`);
    const result = await findReferences(index, { def });
    if (result.status !== "ok") throw new Error(result.reason);
    return {
      coverage: result.referenceCoverage,
      file: (relativePath: string) => {
        const filePath = files.get(relativePath);
        if (!filePath) throw new Error(`Missing fixture file ${relativePath}`);
        return filePath;
      },
    };
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const complete = { scope: "indexed_candidates", state: "complete" } as const;

describe("parse-error coverage name matching", () => {
  describe("Terraform", () => {
    // An unclosed `${` interpolation is real HCL that tree-sitter-hcl reports as ERROR.
    // The ERROR text includes the traversal. HCL identifiers continue through `-`, so the
    // decoy spellings are different variables from `name`.
    const variable = 'variable "name" {}\n';

    it("keeps name complete when an ERROR range contains only var.name-other and var.other-name", async () => {
      const { coverage } = await findCoverage(
        {
          "variables.tf": variable,
          "broken.tf": 'output "o" {\n  value = "${var.name-other"\n}\noutput "p" {\n  value = "${var.other-name"\n}\n',
        },
        { file: "variables.tf", name: "name" },
      );
      expect(coverage).toEqual(complete);
    });

    it("marks name partial with parse_error when an ERROR range contains var.name", async () => {
      const { coverage, file } = await findCoverage(
        {
          "variables.tf": variable,
          "broken.tf": 'output "o" {\n  value = "${var.name"\n}\n',
        },
        { file: "variables.tf", name: "name" },
      );
      expect(coverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["parse_error"],
        affectedFiles: [file("broken.tf")],
      });
    });
  });

  describe("PHP", () => {
    it("marks Service partial with parse_error when an ERROR range contains new service(1;", async () => {
      // A bare `new service(1;` is recovered with a missing `)`, not an ERROR node. The extra
      // `}` makes tree-sitter-php wrap `new service(1;` in an ERROR whose text contains it.
      const { coverage, file } = await findCoverage(
        {
          "service.php": "<?php\nclass Service {}\n",
          "use.php": "<?php\nnew service(1; }\n",
        },
        { file: "service.php", name: "Service" },
      );
      expect(coverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["parse_error"],
        affectedFiles: [file("use.php")],
      });
    });

    it("keeps LIMIT complete when an ERROR range contains only limit", async () => {
      const { coverage } = await findCoverage(
        {
          "limit.php": '<?php\nconst LIMIT = 1;\n$x = "${limit";\n',
        },
        { file: "limit.php", name: "LIMIT" },
      );
      expect(coverage).toEqual(complete);
    });
  });

  describe("normalized ERROR identifiers", () => {
    it("matches C# verbatim identifiers with their normalized spelling", async () => {
      const { coverage, file } = await findCoverage(
        {
          "widget.cs": "class Widget {}\n",
          "broken.cs": "class Broken { void M() { @Widget ???; } }\n",
        },
        { file: "widget.cs", name: "Widget" },
      );
      expect(coverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["parse_error"],
        affectedFiles: [file("broken.cs")],
      });
    });

    it("matches PHP property identifiers without folding property case", async () => {
      const { coverage, file } = await findCoverage(
        {
          "box.php": "<?php\nclass Box { public $field; }\n",
          "broken.php": "<?php\n$box->field( ; }\n",
        },
        { file: "box.php", name: "$field" },
      );
      expect(coverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["parse_error"],
        affectedFiles: [file("broken.php")],
      });
    });
  });

  describe("namespace default values", () => {
    it("matches a CommonJS require binding of a directly exported module value", async () => {
      const { coverage, file } = await findCoverage(
        {
          "definition.js": "function target() {}\nmodule.exports = target;\n",
          "use.js": 'const alias = require("./definition");\nconst broken = <alias;\n',
        },
        { file: "definition.js", name: "target" },
      );
      expect(coverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["parse_error"],
        affectedFiles: [file("use.js")],
      });
    });

    it("matches ns.default only when default resolves to the target", async () => {
      const { coverage, file } = await findCoverage(
        {
          "definition.ts": "function target() {}\nexport default target;\n",
          "use.ts": 'import * as ns from "./definition";\nconst broken = <ns.default;\n',
        },
        { file: "definition.ts", name: "target" },
      );
      expect(coverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["parse_error"],
        affectedFiles: [file("use.ts")],
      });
    });

    it("does not match an unrelated default export or unrelated namespace import", async () => {
      const { coverage } = await findCoverage(
        {
          "definition.ts": "function target() {}\nexport function other() {}\n",
          "other.ts": "function unrelated() {}\nexport default unrelated;\n",
          "use.ts": 'import * as ns from "./other";\nconst broken = <ns.default;\n',
        },
        { file: "definition.ts", name: "target" },
      );
      expect(coverage).toEqual(complete);
    });
  });
  describe("TypeScript namespace imports", () => {
    const lib = "function internal() {}\nexport { internal as visible };\nexport function other() {}\n";

    it("marks internal partial with parse_error when an ERROR range contains ns.visible", async () => {
      const { coverage, file } = await findCoverage(
        {
          "lib.ts": lib,
          "use.ts": 'import * as ns from "./lib";\nconst broken = <ns.visible;\n',
        },
        { file: "lib.ts", name: "internal" },
      );
      expect(coverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["parse_error"],
        affectedFiles: [file("use.ts")],
      });
    });

    it("does not let an ERROR around ns.other affect internal", async () => {
      const { coverage } = await findCoverage(
        {
          "lib.ts": lib,
          "use.ts": 'import * as ns from "./lib";\nconst broken = <ns.other;\n',
        },
        { file: "lib.ts", name: "internal" },
      );
      expect(coverage).toEqual(complete);
    });
  });
});
