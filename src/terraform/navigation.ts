import { createNavigationProvenance, okGoToResult } from "../indexer/navigation-provenance.js";
import { buildIndexedCandidateCoverage } from "../indexer/navigation-references.js";
import { rangeContains, sameDef } from "../indexer/reference-context.js";
import type {
  FindReferencesResult,
  GoToRequest,
  GoToResult,
  ProjectIndex,
  Reference,
  SymbolDef,
} from "../indexer/types.js";
import type { FileId, Range } from "../types.js";
import { fileIdentityKey } from "../util/paths.js";
import {
  isTerraformFile,
  resolveTerraformTarget,
  TERRAFORM_LANGUAGE_ID,
  terraformAddressMayName,
  terraformDeclarationForDefinition,
  terraformFactsForFile,
  terraformModuleCallerFiles,
  terraformModuleUseTargetsDefinition,
  terraformModuleFiles,
} from "./resolution.js";

/**
 * Go-to-definition for a position in a Terraform file, or null for other languages. A position
 * on a declared name returns that declaration; a position on a reference resolves it through
 * `resolveTerraformTarget`.
 */
export async function goToTerraformDefinition(index: ProjectIndex, req: GoToRequest): Promise<GoToResult | null> {
  if (!isTerraformFile(index, req.file)) return null;
  const facts = await terraformFactsForFile(index, req.file);
  if (!facts) return { status: "not_found", reason: "Terraform file could not be parsed" };
  const position = { row: req.line, column: req.column };
  const module = index.byFile.get(fileIdentityKey(req.file));
  const declared = module?.locals.find((local) => rangeContains(local.range, position));
  if (declared) return okGoToResult(index, declared, { resolution: "exact", confidence: "high" });
  const site = facts.references.find((reference) => rangeContains(reference.range, position));
  if (!site) return { status: "not_found", reason: "No Terraform reference at position" };
  const resolved = await resolveTerraformTarget(index, req.file, site.target);
  if (resolved.status !== "ok") return { status: "not_found", reason: resolved.reason };
  return okGoToResult(index, resolved.def, { resolution: "exact", confidence: "high" });
}

type FindTerraformReferencesOptions = {
  includeDefinition: boolean;
  maxReferences?: number;
};

function siteKey(file: FileId, range: Range): string {
  return `${fileIdentityKey(file)}:${range.start.line}:${range.start.column}`;
}

/** Declarations another module can name: inputs, outputs, and what a resource address names. */
const CROSS_MODULE_KINDS = new Set(["variable", "output", "module", "resource", "data"]);

/**
 * References to a Terraform declaration, or null for other languages. Candidates are the files
 * of the declaring module plus, for input variables and outputs, the files that call that module
 * through a local source. Every candidate site resolves through `resolveTerraformTarget`, so
 * references agree with go-to-definition.
 */
export async function findTerraformReferences(
  index: ProjectIndex,
  def: SymbolDef,
  options: FindTerraformReferencesOptions,
): Promise<FindReferencesResult | null> {
  if (!isTerraformFile(index, def.file)) return null;
  const declaration = await terraformDeclarationForDefinition(index, def);
  const candidateFiles = terraformModuleFiles(index, def.file);
  const unavailableFiles: FileId[] = [];
  if (declaration && CROSS_MODULE_KINDS.has(declaration.kind)) {
    const callers = await terraformModuleCallerFiles(index, def);
    // A file whose facts cannot load may call this module or hold an address, so it is unproven.
    unavailableFiles.push(...callers.unavailable);
    // Callers name inputs and outputs; a resource address anywhere can name nested module calls,
    // resources, and data sources.
    const callerFiles = declaration.kind === "variable" || declaration.kind === "output" ? callers.files : [];
    const addressFiles = declaration.kind === "variable" || declaration.kind === "output" ? [] : callers.addressFiles;
    for (const caller of [...callerFiles, ...addressFiles]) {
      if (!candidateFiles.some((file) => fileIdentityKey(file) === fileIdentityKey(caller))) {
        candidateFiles.push(caller);
      }
    }
  }
  const maxReferences = options.maxReferences;
  const collectionLimit = maxReferences === undefined ? undefined : maxReferences + 1;
  const references: Reference[] = [];
  const seen = new Set<string>();
  const definitionKey = siteKey(def.file, def.range);
  const addReference = (file: FileId, range: Range): void => {
    if (collectionLimit !== undefined && references.length >= collectionLimit) return;
    const key = siteKey(file, range);
    if (!options.includeDefinition && key === definitionKey) return;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ file, range });
  };

  if (options.includeDefinition) addReference(def.file, def.range);
  const scannedFiles: FileId[] = [];
  if (!declaration) unavailableFiles.push(def.file);
  for (const file of declaration ? candidateFiles : []) {
    const facts = await terraformFactsForFile(index, file);
    if (!facts) {
      unavailableFiles.push(file);
      continue;
    }
    scannedFiles.push(file);
    let unprovenUse = false;
    for (const site of facts.references) {
      if (site.target.name !== def.localName) continue;
      const resolved = await resolveTerraformTarget(index, file, site.target);
      if (resolved.status === "ok") {
        if (sameDef(resolved.def, def, index.languageExtensions)) addReference(file, site.range);
      } else if (resolved.unproven) {
        // A same-named use behind a duplicate declaration or an unreadable file may still name it.
        unprovenUse = true;
      }
    }
    // A whole module value (`module.net`), or indexes that do not fit the call's instancing, may
    // read this output without naming it; a resource address can name a nested module call, a
    // resource, or a data source that references cannot rewrite yet.
    for (const use of facts.moduleObjectUses) {
      if (use.addressChain) {
        if (await terraformAddressMayName(index, file, use.addressChain, def, declaration?.kind)) unprovenUse = true;
      } else if (declaration?.kind === "output") {
        if (await terraformModuleUseTargetsDefinition(index, file, use, def)) unprovenUse = true;
      }
    }
    if (unprovenUse) unavailableFiles.push(file);
  }

  references.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.range.start.line - right.range.start.line ||
      left.range.start.column - right.range.start.column,
  );
  const truncated = maxReferences !== undefined && references.length > maxReferences;
  if (truncated) references.length = maxReferences;
  return {
    status: "ok",
    definition: def,
    references,
    provenance: createNavigationProvenance("exact", "high"),
    referenceCoverage: buildIndexedCandidateCoverage({
      index,
      def,
      languageId: TERRAFORM_LANGUAGE_ID,
      exportedNames: [],
      candidateFiles,
      scannedFiles,
      truncated,
      strategyUnavailableFiles: unavailableFiles,
    }),
  };
}
