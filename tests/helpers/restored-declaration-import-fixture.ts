import fsp from "node:fs/promises";
import {
  buildGraphDelta,
  buildProjectIndex,
  buildProjectIndexIncremental,
  type BuildReport,
  type GraphDeltaReport,
  type ProjectIndex,
} from "../../src/index.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { columnOf, writeFixtureFiles } from "../languages/callable-consumer-fixtures.js";
import { mkTmpDir } from "./filesystem.js";

type RestoredDeclarationFixture = {
  languageId: string;
  extension: string;
  ownerName: string;
  ownerLines: string[];
  missingSource: string;
  consumerLines: string[];
  unrelatedLines: string[];
  decoyLines: string[];
  useLine: number;
  declarationLine: number;
  specifier: string;
};

export const RESTORED_DECLARATION_FIXTURES = [
  {
    languageId: "java",
    extension: "java",
    ownerName: "Gadget",
    ownerLines: ["package lib;", "public class Gadget {}", ""],
    missingSource: "package lib;\nclass Different {}\n",
    consumerLines: ["package app;", "import lib.Gadget;", "class Use { Gadget value; }", ""],
    unrelatedLines: ["package extra;", "import missing.Gadget;", "class Unrelated { Gadget value; }", ""],
    decoyLines: ["package other;", "public class Gadget {}", ""],
    useLine: 3,
    declarationLine: 2,
    specifier: "lib.Gadget",
  },
  {
    languageId: "kotlin",
    extension: "kt",
    ownerName: "Library",
    ownerLines: ["package lib", "class Gadget", ""],
    missingSource: "package lib\nclass Different\n",
    consumerLines: ["package app", "import lib.Gadget", "fun use(value: Gadget): Gadget = value", ""],
    unrelatedLines: ["package extra", "import missing.Gadget", "fun unrelated(value: Gadget): Gadget = value", ""],
    decoyLines: ["package other", "class Gadget", ""],
    useLine: 3,
    declarationLine: 2,
    specifier: "lib.Gadget",
  },
  {
    languageId: "csharp",
    extension: "cs",
    ownerName: "Library",
    ownerLines: ["namespace Lib;", "public class Gadget {}", ""],
    missingSource: "namespace Lib;\npublic class Different {}\n",
    consumerLines: ["using Gadget = Lib.Gadget;", "class Use { Gadget value; }", ""],
    unrelatedLines: ["using Gadget = Missing.Gadget;", "class Unrelated { Gadget value; }", ""],
    decoyLines: ["namespace Other;", "public class Gadget {}", ""],
    useLine: 2,
    declarationLine: 2,
    specifier: "Lib.Gadget",
  },
  {
    languageId: "php",
    extension: "php",
    ownerName: "Definitions",
    ownerLines: ["<?php", "namespace Lib;", "class Gadget {}", ""],
    missingSource: "<?php\nnamespace Lib;\nclass Different {}\n",
    consumerLines: [
      "<?php",
      "namespace App;",
      "use Lib\\Gadget;",
      "function consume(Gadget $value): Gadget { return $value; }",
      "",
    ],
    unrelatedLines: [
      "<?php",
      "namespace Extra;",
      "use Missing\\Gadget;",
      "function unrelated(Gadget $value): Gadget { return $value; }",
      "",
    ],
    decoyLines: ["<?php", "namespace Other;", "class Gadget {}", ""],
    useLine: 4,
    declarationLine: 3,
    specifier: "Lib\\Gadget",
  },
  {
    languageId: "cpp",
    extension: "cpp",
    ownerName: "Library",
    ownerLines: ["export module lib;", "export class Gadget {};", ""],
    missingSource: "export module different;\nexport class Gadget {};\n",
    consumerLines: ["import lib;", "Gadget value;", ""],
    unrelatedLines: ["import missing;", "Gadget extra;", ""],
    decoyLines: ["export module other;", "export class Gadget {};", ""],
    useLine: 2,
    declarationLine: 2,
    specifier: "lib",
  },
] satisfies RestoredDeclarationFixture[];

export type RestoredDeclarationProject = {
  root: string;
  owner: string;
  consumer: string;
  unrelated: string;
  decoy: string;
  query: { file: string; line: number; column: number };
  declaration: { file: string; line: number; column: number };
  initial: ProjectIndex;
  missing: ProjectIndex;
  missingCold: ProjectIndex;
  restored: ProjectIndex;
  cold: ProjectIndex;
  report: BuildReport;
  missingReport: BuildReport;
  delta: GraphDeltaReport | undefined;
};

/** Exercise the full transition without changing the importer or adding/removing any files. */
export async function withRestoredDeclarationImport(
  fixture: RestoredDeclarationFixture,
  cache: "disk" | "memory",
  check: (project: RestoredDeclarationProject) => Promise<void>,
  restoreWithDelta = false,
): Promise<void> {
  const root = await mkTmpDir("cg-restored-declaration-");
  try {
    const ownerRelative = `lib/${fixture.ownerName}.${fixture.extension}`;
    const consumerRelative = `app/Use.${fixture.extension}`;
    const unrelatedRelative = `extra/Unrelated.${fixture.extension}`;
    const decoyRelative = `other/Gadget.${fixture.extension}`;
    const files = await writeFixtureFiles(root, {
      [ownerRelative]: fixture.ownerLines.join("\n"),
      [consumerRelative]: fixture.consumerLines.join("\n"),
      [unrelatedRelative]: fixture.unrelatedLines.join("\n"),
      [decoyRelative]: fixture.decoyLines.join("\n"),
    });
    const owner = files[ownerRelative]!;
    const consumer = files[consumerRelative]!;
    const build = { cache, threads: 1 };
    const initial = await buildProjectIndex(root, build);
    await fsp.writeFile(owner, fixture.missingSource, "utf8");
    const missingReport: BuildReport = { timings: {} };
    const missing = await buildProjectIndexIncremental(root, { ...build, report: missingReport });
    const missingCold = await buildProjectIndex(root, { cache: "off", threads: 1 });
    await fsp.writeFile(owner, fixture.ownerLines.join("\n"), "utf8");
    const report: BuildReport = { timings: {} };
    const delta = restoreWithDelta ? await buildGraphDelta(root, { ...build, report }) : undefined;
    const restored = await buildProjectIndexIncremental(root, {
      ...build,
      ...(!restoreWithDelta ? { report } : {}),
    });
    const cold = await buildProjectIndex(root, { cache: "off", threads: 1 });
    await check({
      root,
      owner,
      consumer,
      unrelated: files[unrelatedRelative]!,
      decoy: files[decoyRelative]!,
      query: {
        file: consumer,
        line: fixture.useLine,
        column: columnOf(fixture.consumerLines, fixture.useLine, "Gadget"),
      },
      declaration: {
        file: owner,
        line: fixture.declarationLine,
        column: columnOf(fixture.ownerLines, fixture.declarationLine, "Gadget"),
      },
      initial,
      missing,
      missingCold,
      restored,
      cold,
      report,
      missingReport,
      delta,
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

export function declarationImportTargets(index: ProjectIndex, file: string): string[] {
  return index.graph.edges
    .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file))
    .map((edge) => {
      if (edge.to.type === "file") return `file:${fileIdentityKey(edge.to.path)}`;
      return `external:${edge.to.name}`;
    })
    .sort();
}
