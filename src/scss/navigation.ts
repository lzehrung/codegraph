import { buildIndexedCandidateCoverage } from "../indexer/navigation-references.js";
import { createNavigationProvenance, okGoToResult } from "../indexer/navigation-provenance.js";
import { sameDef } from "../indexer/reference-context.js";
import type {
  FindReferencesResult,
  GoToRequest,
  GoToResult,
  ProjectIndex,
  Reference,
  SymbolDef,
} from "../indexer/types.js";
import type { FileId } from "../types.js";
import { fileIdentityKey } from "../util/paths.js";
import {
  isScssFile,
  resolveScssUse,
  scssFactsForFile,
  scssLocalDefinition,
  scssMemberForDefinition,
  scssReferenceCandidates,
  scssUseAt,
  scssUseEditRange,
  scssUseMayNameMember,
} from "./resolution.js";
import type { ScssUse } from "./syntax.js";

/**
 * SCSS navigation for Sass module members. Same-file selectors and other symbols the module
 * model does not own return null so the generic scope walker keeps them.
 */

type FindScssReferencesOptions = {
  includeDefinition: boolean;
  maxReferences?: number;
};

function siteKey(file: FileId, range: Reference["range"]): string {
  return `${fileIdentityKey(file)}:${range.start.line}:${range.start.column}`;
}

/** A name that only a module can supply: a miss there never falls back to the generic walker. */
function isModuleSite(use: ScssUse): boolean {
  if (use.namespace !== null) return true;
  return (
    use.syntax === "config" ||
    use.syntax === "show" ||
    use.syntax === "hide" ||
    use.syntax === "extend" ||
    use.syntax === "include"
  );
}

export async function goToScssDefinition(index: ProjectIndex, req: GoToRequest): Promise<GoToResult | null> {
  if (!isScssFile(index, req.file)) return null;
  const facts = await scssFactsForFile(index, req.file);
  if (!facts) return null;
  const use = scssUseAt(facts, req.line, req.column);
  if (!use) return null;
  const resolved = await resolveScssUse(index, req.file, use);
  if (resolved.status === "shadow") {
    // A local variable owns the name, so a module member is wrong. The generic walker sees a
    // block-level declaration but misreads a parameter default as the module member, so the
    // answer comes from here.
    const local = await scssLocalDefinition(index, req.file, resolved.range, use.canonical);
    if (local) return okGoToResult(index, local, { resolution: "exact", confidence: "high" });
    return { status: "not_found", reason: `A local variable hides the SCSS member ${use.text}` };
  }
  if (resolved.status === "ok") {
    return okGoToResult(index, resolved.def, { resolution: "namespace", confidence: "high" });
  }
  if (isModuleSite(use) || resolved.unproven) return { status: "not_found", reason: resolved.reason };
  // A bare name the module model does not know can still be a same-file symbol or a CSS function
  // such as `rgb(`, unless the file loads members without a namespace.
  const loadsGlobally = facts.loads.some((load) => load.star || load.kind === "import");
  if (!loadsGlobally) return null;
  return { status: "not_found", reason: resolved.reason };
}

export async function findScssReferences(
  index: ProjectIndex,
  def: SymbolDef,
  options: FindScssReferencesOptions,
): Promise<FindReferencesResult | null> {
  if (!isScssFile(index, def.file)) return null;
  const member = await scssMemberForDefinition(index, def);
  if (!member) return null;

  const { files, unavailable } = await scssReferenceCandidates(index, member.def);
  const references: Reference[] = [];
  const seen = new Set<string>();
  const scanned: FileId[] = [];
  const unavailableFiles = [...unavailable];
  const unavailableKeys = new Set(unavailable.map((file) => fileIdentityKey(file)));
  let truncated = false;

  const markUnavailable = (file: FileId): void => {
    const key = fileIdentityKey(file);
    if (unavailableKeys.has(key)) return;
    unavailableKeys.add(key);
    unavailableFiles.push(file);
  };

  const push = (file: FileId, range: Reference["range"]): boolean => {
    if (options.maxReferences !== undefined && references.length >= options.maxReferences) {
      truncated = true;
      return false;
    }
    const key = siteKey(file, range);
    if (seen.has(key)) return true;
    seen.add(key);
    references.push({ file, range, provenance: createNavigationProvenance("namespace", "high") });
    return true;
  };

  // Every assignment of a variable is a site of the same variable; `def` itself is the
  // definition and stays out unless the caller asks for it.
  for (const site of member.sites) {
    if (!options.includeDefinition && sameDef(site, def)) continue;
    if (!push(site.file, site.range)) break;
  }

  for (const file of files) {
    if (truncated) break;
    const facts = await scssFactsForFile(index, file);
    if (!facts) {
      markUnavailable(file);
      continue;
    }
    scanned.push(file);
    let unproven = false;
    for (const use of facts.uses) {
      if (!scssUseMayNameMember(use, member)) continue;
      const resolved = await resolveScssUse(index, file, use);
      if (resolved.status === "shadow") continue;
      if (resolved.status === "not_found") {
        if (resolved.unproven) unproven = true;
        continue;
      }
      if (!sameDef(resolved.def, member.def)) continue;
      const range = scssUseEditRange(facts, use, resolved.prefix);
      if (!range) {
        unproven = true;
        continue;
      }
      if (!push(file, range)) break;
    }
    if (unproven) markUnavailable(file);
  }

  references.sort(compareReferences);
  return {
    status: "ok",
    definition: member.def,
    references,
    // The generic import-binding check stays out: this module resolves every load itself and
    // reports a load it cannot prove through `strategyUnavailableFiles`. The check would also flag
    // a variable that one file assigns again, because the shared export table keeps each
    // assignment as a separate export of the same name.
    referenceCoverage: buildIndexedCandidateCoverage({
      index,
      def: member.def,
      languageId: "scss",
      exportedNames: [],
      candidateFiles: [],
      scannedFiles: scanned,
      truncated,
      strategyUnavailableFiles: unavailableFiles,
    }),
    provenance: createNavigationProvenance("namespace", "high"),
  };
}

function compareReferences(left: Reference, right: Reference): number {
  const file = left.file.localeCompare(right.file);
  if (file !== 0) return file;
  if (left.range.start.line !== right.range.start.line) return left.range.start.line - right.range.start.line;
  return left.range.start.column - right.range.start.column;
}
