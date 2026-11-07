import fsp from "node:fs/promises";
import { expect } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  type BuildReport,
  type ProjectIndex,
} from "../../src/index.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { columnOf, writeFixtureFiles } from "../languages/callable-consumer-fixtures.js";
import { mkTmpDir } from "./filesystem.js";
import { declarationImportTargets } from "./restored-declaration-import-fixture.js";

/**
 * Two files declare the same imported name, so an importer cannot bind either one. PHP is the exception: it
 * binds the first declaring file, so deleting or renaming the other one never changes its importer.
 */
export type DuplicateDeclarationFixture = {
  languageId: string;
  extension: string;
  /** Declared by both duplicate files. */
  declarerLines: string[];
  /** Replaces a duplicate: the same package, namespace, or module scope (a module name for C++) with another name. */
  renamedLines: string[];
  consumerLines: string[];
  /** Imports a name that no file declares, so it must stay external through every step. */
  unrelatedLines: string[];
  /** Declares the imported name in another package, namespace, or module, so it is never a target. */
  decoyLines: string[];
  useLine: number;
  declarationLine: number;
  specifier: string;
  duplicatedTarget: "ambiguous" | "first";
};

export const DUPLICATE_DECLARATION_FIXTURES = [
  {
    languageId: "java",
    extension: "java",
    declarerLines: ["package lib;", "public class Gadget {}", ""],
    renamedLines: ["package lib;", "public class Different {}", ""],
    consumerLines: ["package app;", "import lib.Gadget;", "class Use { Gadget value; }", ""],
    unrelatedLines: ["package extra;", "import missing.Gadget;", "class Unrelated { Gadget value; }", ""],
    decoyLines: ["package other;", "public class Gadget {}", ""],
    useLine: 3,
    declarationLine: 2,
    specifier: "lib.Gadget",
    duplicatedTarget: "ambiguous",
  },
  {
    languageId: "kotlin",
    extension: "kt",
    declarerLines: ["package lib", "class Gadget", ""],
    renamedLines: ["package lib", "class Different", ""],
    consumerLines: ["package app", "import lib.Gadget", "fun use(value: Gadget): Gadget = value", ""],
    unrelatedLines: ["package extra", "import missing.Gadget", "fun unrelated(value: Gadget): Gadget = value", ""],
    decoyLines: ["package other", "class Gadget", ""],
    useLine: 3,
    declarationLine: 2,
    specifier: "lib.Gadget",
    duplicatedTarget: "ambiguous",
  },
  {
    languageId: "csharp",
    extension: "cs",
    declarerLines: ["namespace Lib;", "public class Gadget {}", ""],
    renamedLines: ["namespace Lib;", "public class Different {}", ""],
    consumerLines: ["using Gadget = Lib.Gadget;", "class Use { Gadget value; }", ""],
    unrelatedLines: ["using Gadget = Missing.Gadget;", "class Unrelated { Gadget value; }", ""],
    decoyLines: ["namespace Other;", "public class Gadget {}", ""],
    useLine: 2,
    declarationLine: 2,
    specifier: "Lib.Gadget",
    duplicatedTarget: "ambiguous",
  },
  {
    languageId: "php",
    extension: "php",
    declarerLines: ["<?php", "namespace Lib;", "class Gadget {}", ""],
    renamedLines: ["<?php", "namespace Lib;", "class Different {}", ""],
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
    duplicatedTarget: "first",
  },
  {
    languageId: "cpp",
    extension: "cpp",
    declarerLines: ["export module lib;", "export class Gadget {};", ""],
    renamedLines: ["export module different;", "export class Gadget {};", ""],
    consumerLines: ["import lib;", "Gadget value;", ""],
    unrelatedLines: ["import missing;", "Gadget extra;", ""],
    decoyLines: ["export module other;", "export class Gadget {};", ""],
    useLine: 2,
    declarationLine: 2,
    specifier: "lib",
    duplicatedTarget: "ambiguous",
  },
] satisfies DuplicateDeclarationFixture[];

export type DuplicateMutation = "delete" | "rename";

/** Which duplicate the mutation edits. The other one stays declared. PHP binds `first` while both exist. */
export type DuplicateDeclarer = "first" | "second";

/** Every language with each way to remove either duplicate. */
export const DUPLICATE_DECLARATION_CASES = DUPLICATE_DECLARATION_FIXTURES.flatMap((fixture) =>
  (["delete", "rename"] as const).flatMap((mutation) =>
    (["first", "second"] as const).map((declarer) => ({
      fixture,
      languageId: fixture.languageId,
      mutation,
      declarer,
    })),
  ),
);

export type DuplicateDeclarationProject = {
  root: string;
  first: string;
  second: string;
  /** The duplicate the mutation edited, and the one that stays declared. */
  mutated: string;
  survivor: string;
  consumer: string;
  unrelated: string;
  decoy: string;
  query: { file: string; line: number; column: number };
  /** The survivor's declaration of the imported name. */
  declaration: { file: string; line: number; column: number };
  duplicated: ProjectIndex;
  removed: ProjectIndex;
  removedCold: ProjectIndex;
  removedReport: BuildReport;
  restored: ProjectIndex;
  restoredCold: ProjectIndex;
  restoredReport: BuildReport;
};

/**
 * Builds two duplicate declarers and their importers, removes one declaration (deleting the file, or renaming
 * its declaration away), updates incrementally, then restores it and updates again. A cold build follows every
 * update so callers can compare the cached answer with the ground truth.
 */
export async function withDuplicateDeclarations(
  fixture: DuplicateDeclarationFixture,
  options: { cache: "disk" | "memory"; mutation: DuplicateMutation; declarer: DuplicateDeclarer },
  check: (project: DuplicateDeclarationProject) => Promise<void>,
): Promise<void> {
  const root = await mkTmpDir("cg-duplicate-declaration-");
  try {
    const ext = fixture.extension;
    const firstRelative = `one/First.${ext}`;
    const secondRelative = `two/Second.${ext}`;
    const consumerRelative = `app/Use.${ext}`;
    const unrelatedRelative = `extra/Unrelated.${ext}`;
    const decoyRelative = `other/Gadget.${ext}`;
    const declarerSource = fixture.declarerLines.join("\n");
    const files = await writeFixtureFiles(root, {
      [firstRelative]: declarerSource,
      [secondRelative]: declarerSource,
      [consumerRelative]: fixture.consumerLines.join("\n"),
      [unrelatedRelative]: fixture.unrelatedLines.join("\n"),
      [decoyRelative]: fixture.decoyLines.join("\n"),
    });
    const first = files[firstRelative]!;
    const second = files[secondRelative]!;
    const mutated = options.declarer === "first" ? first : second;
    const survivor = options.declarer === "first" ? second : first;
    const build = { cache: options.cache, threads: 1 } as const;
    const cold = { cache: "off", threads: 1 } as const;
    const duplicated = await buildProjectIndex(root, build);
    if (options.mutation === "delete") await fsp.rm(mutated);
    else await fsp.writeFile(mutated, fixture.renamedLines.join("\n"), "utf8");
    const removedReport: BuildReport = { timings: {} };
    const removed = await buildProjectIndexIncremental(root, { ...build, report: removedReport });
    const removedCold = await buildProjectIndex(root, cold);
    await fsp.writeFile(mutated, declarerSource, "utf8");
    const restoredReport: BuildReport = { timings: {} };
    const restored = await buildProjectIndexIncremental(root, { ...build, report: restoredReport });
    const restoredCold = await buildProjectIndex(root, cold);
    await check({
      root,
      first,
      second,
      mutated,
      survivor,
      consumer: files[consumerRelative]!,
      unrelated: files[unrelatedRelative]!,
      decoy: files[decoyRelative]!,
      query: {
        file: files[consumerRelative]!,
        line: fixture.useLine,
        column: columnOf(fixture.consumerLines, fixture.useLine, "Gadget"),
      },
      declaration: {
        file: survivor,
        line: fixture.declarationLine,
        column: columnOf(fixture.declarerLines, fixture.declarationLine, "Gadget"),
      },
      duplicated,
      removed,
      removedCold,
      removedReport,
      restored,
      restoredCold,
      restoredReport,
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function resolvedImportTargets(index: ProjectIndex, file: string): string[] {
  const imports = index.byFile.get(fileIdentityKey(file))?.imports ?? [];
  return imports.flatMap((binding) =>
    typeof binding.resolved === "string" ? [fileIdentityKey(binding.resolved)] : [],
  );
}

/** The importer's edges while both duplicates are declared: external, or the first file for PHP. */
export function duplicatedImportTargets(
  fixture: DuplicateDeclarationFixture,
  project: DuplicateDeclarationProject,
): string[] {
  if (fixture.duplicatedTarget === "first") return [`file:${fileIdentityKey(project.first)}`];
  return [`external:${fixture.specifier}`];
}

/**
 * Removing a duplicate leaves its survivor as the only declarer, so the importer binds the survivor exactly as a
 * cold build does. Restoring the duplicate returns the importer to its first state. A decoy that declares the
 * name elsewhere is never bound, and an importer of a missing name stays external throughout.
 */
export function expectDuplicateRemovalMatchesColdBuilds(
  fixture: DuplicateDeclarationFixture,
  project: DuplicateDeclarationProject,
): void {
  const { consumer, unrelated, decoy, survivor, duplicated, removed, removedCold, restored, restoredCold } = project;
  const duplicatedTargets = duplicatedImportTargets(fixture, project);
  expect(declarationImportTargets(duplicated, consumer)).toEqual(duplicatedTargets);

  expect(declarationImportTargets(removed, consumer)).toEqual([`file:${fileIdentityKey(survivor)}`]);
  expect(declarationImportTargets(removed, consumer)).toEqual(declarationImportTargets(removedCold, consumer));
  expect(declarationImportTargets(removed, consumer)).not.toContain(`file:${fileIdentityKey(decoy)}`);
  expect(resolvedImportTargets(removed, consumer)).toEqual(resolvedImportTargets(removedCold, consumer));
  expect(resolvedImportTargets(removed, consumer)).toContain(fileIdentityKey(survivor));
  expect(resolvedImportTargets(removed, consumer)).not.toContain(fileIdentityKey(decoy));
  expect(declarationImportTargets(removed, unrelated)).toEqual(declarationImportTargets(duplicated, unrelated));
  expect(declarationImportTargets(removed, unrelated)).toEqual(declarationImportTargets(removedCold, unrelated));

  expect(declarationImportTargets(restored, consumer)).toEqual(duplicatedTargets);
  expect(declarationImportTargets(restored, consumer)).toEqual(declarationImportTargets(restoredCold, consumer));
  expect(resolvedImportTargets(restored, consumer)).toEqual(resolvedImportTargets(restoredCold, consumer));
  expect(declarationImportTargets(restored, unrelated)).toEqual(declarationImportTargets(duplicated, unrelated));
}
