import fs from "node:fs/promises";
import path from "node:path";
import { defNodeId } from "../graphs/symbol-graph.js";
import { shapeCandidateTests, type RenameCandidateTest } from "./candidateTests.js";
export type { RenameCandidateTest };
import { findReferences } from "../indexer/navigation.js";
import { resolveExport } from "../indexer/navigation-resolve.js";
import { getCachedScope } from "../indexer/navigation-references.js";
import { findImplementations as queryImplementations } from "../indexer/type-hierarchy.js";
import { SymbolKind, type BuildOptions, type ProjectIndex, type Reference, type SymbolDef } from "../indexer/types.js";
import { supportForFile } from "../languages.js";
import type { Range } from "../types.js";
import { ensureParsedContext } from "../indexer/parse-context.js";
import { resolveReadableFile } from "../util/confinedFile.js";
import { errorMessage } from "../util/errors.js";
import { fileIdentityKey } from "../util/paths.js";
import { classifySensitiveFile } from "./fileView.js";
import { normalizeAgentFilePath } from "./normalize.js";
import type { SemanticLocation, SemanticProvenance, SemanticResponseEnvelope, SemanticSymbol } from "./semantic.js";
import { requireSemanticSymbol, semanticSymbolFromDef } from "./semanticSymbols.js";
import {
  createAgentSession,
  type AgentFreshnessResult,
  type AgentProjectSnapshot,
  type AgentSession,
} from "./session.js";
import { buildSymbolLookup } from "./symbolLookup.js";

export type RenamePreviewRequest = {
  root: string;
  handle: string;
  newName: string;
  includeComments?: boolean;
  includeStrings?: boolean;
  includeFilenames?: boolean;
  maxEdits?: number;
  buildOptions?: BuildOptions;
};

export type RenameEditKind = "definition" | "reference" | "import" | "export" | "comment" | "string";

export type RenameEdit = {
  file: string;
  range: Range;
  oldText: string;
  newText: string;
  kind: RenameEditKind;
  provenance: SemanticProvenance;
};

export type RenameUnsafeSite = {
  location: SemanticLocation;
  text: string;
  reason:
    | "ambiguous_target"
    | "unresolved_reference"
    | "dynamic_access"
    | "unsupported_syntax"
    | "parse_degraded"
    | "generated_file"
    | "sensitive_file"
    | "outside_root"
    | "limit_exceeded";
  provenance: SemanticProvenance;
};

export type RenameConflict = {
  file: string;
  location?: SemanticLocation;
  reason: "name_collision" | "shadowing" | "duplicate_export" | "invalid_identifier" | "case_only_filesystem_risk";
  existingHandle?: string;
  message: string;
};

export type RenameFilenameSuggestion = {
  from: string;
  to: string;
  caseOnlyRisk: boolean;
};


export type RenamePreviewResponse = SemanticResponseEnvelope & {
  target: SemanticSymbol;
  newName: string;
  safe: boolean;
  edits: RenameEdit[];
  unsafeSites: RenameUnsafeSite[];
  conflicts: RenameConflict[];
  filenameSuggestions: RenameFilenameSuggestion[];
  candidateTests: RenameCandidateTest[];
};

type CandidateEdit = {
  file: string;
  range: Range;
  kind: "definition" | "reference" | "import" | "export";
  reference?: Reference;
};

type ImportDeclarationScan = {
  candidates: CandidateEdit[];
  missing: Reference[];
};

type ExportDeclarationScan = {
  candidates: CandidateEdit[];
  missingFiles: string[];
};

type IndexedExportDeclaration = {
  file: string;
  sourceName: string;
  exportedName: string;
  moduleSpecifier?: string;
  required: boolean;
};

type RenameSourceLoader = (file: string) => Promise<string | null>;

type LoadedRenameFile = {
  displayPath: string;
  realPath: string;
  source: string;
  beforeSize: number;
  beforeMtimeMs: number;
};
type TextualRenameScanInput = {
  snapshot: AgentProjectSnapshot;
  realRoot: string;
  oldName: string;
  newName: string;
  includeComments: boolean;
  includeStrings: boolean;
  remaining: number;
  loadedFiles: Map<string, Promise<LoadedRenameFile | null>>;
  unsafeSites: RenameUnsafeSite[];
  semanticProvenance: SemanticProvenance;
};

const DEFAULT_MAX_RENAME_EDITS = 5_000;
const MAX_RENAME_EDITS = 10_000;
const renameExportIndexCache = new WeakMap<ProjectIndex, ReadonlyMap<string, readonly IndexedExportDeclaration[]>>();
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export async function previewRename(request: RenamePreviewRequest): Promise<RenamePreviewResponse> {
  const session = createAgentSession({
    root: request.root,
    ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
  });
  return await previewRenameWithSession(session, request);
}

export async function previewRenameWithSession(
  session: AgentSession,
  request: RenamePreviewRequest,
): Promise<RenamePreviewResponse> {
  const freshness = session.checkFreshness ? await session.checkFreshness() : { state: "fresh" as const };
  const snapshot = await session.loadProject();
  return await previewRenameInSnapshot(snapshot, request, freshness);
}

export async function previewRenameInSnapshot(
  snapshot: AgentProjectSnapshot,
  request: Omit<RenamePreviewRequest, "buildOptions">,
  freshness: AgentFreshnessResult = { state: "fresh" },
): Promise<RenamePreviewResponse> {
  const resolved = requireSemanticSymbol(snapshot, request.handle);
  const maxEdits = normalizeMaxEdits(request.maxEdits);
  const provenance = semanticRenameProvenance(snapshot);
  const conflicts = validateNewName(snapshot, resolved.def, request.newName);
  const semanticReferences: Reference[] = [];
  let referenceFailure: string | undefined;
  try {
    const referenceResult = await findReferences(
      snapshot.index,
      { def: resolved.def },
      { maxReferences: maxEdits + 1 },
    );
    if (referenceResult.status === "ok") semanticReferences.push(...referenceResult.references);
    else referenceFailure = referenceResult.reason;
  } catch (error: unknown) {
    referenceFailure = errorMessage(error);
  }
  const semanticDefinitions = new Map<string, SymbolDef>([[resolved.id, resolved.def]]);
  const implementationResult = queryImplementations(snapshot.index, snapshot.symbolGraph, resolved.id, {
    limit: 500,
  });
  let omittedImplementations = implementationResult.status === "ok" ? implementationResult.omitted : 0;
  let missingImplementationDefinitions = 0;
  let implementationAmbiguityReason: string | undefined;
  const implementationUnsafeSites: RenameUnsafeSite[] = [];
  if (implementationResult.status === "ok") {
    const lookup = buildSymbolLookup(snapshot);
    for (const unresolved of implementationResult.unresolved) {
      const unresolvedDef = lookup.defById.get(unresolved.symbolId);
      const evidenceSite =
        unresolved.site ?? (unresolvedDef ? { file: unresolvedDef.file, range: unresolvedDef.range } : undefined);
      implementationUnsafeSites.push({
        location: evidenceSite
          ? {
              file: normalizeAgentFilePath(snapshot.root, evidenceSite.file),
              range: evidenceSite.range,
            }
          : {
              file: normalizeAgentFilePath(snapshot.root, resolved.def.file),
              range: resolved.def.range,
            },
        text: unresolvedDef?.localName ?? resolved.def.localName,
        reason: "ambiguous_target",
        provenance: {
          ...provenance,
          confidence: "low",
          reason: `Implementation identity could not be proven for ${unresolved.symbolId}.`,
        },
      });
    }
    for (const implementation of implementationResult.implementations) {
      if (!implementation.implementingTypeId) continue;
      const memberDef = lookup.defById.get(implementation.symbolId);
      if (!memberDef) {
        const implementingType = lookup.defById.get(implementation.implementingTypeId);
        const evidenceSite =
          implementation.site ??
          (implementingType ? { file: implementingType.file, range: implementingType.range } : undefined);
        implementationUnsafeSites.push({
          location: evidenceSite
            ? {
                file: normalizeAgentFilePath(snapshot.root, evidenceSite.file),
                range: evidenceSite.range,
              }
            : {
                file: normalizeAgentFilePath(snapshot.root, resolved.def.file),
                range: resolved.def.range,
              },
          text: implementingType?.localName ?? resolved.def.localName,
          reason: "unresolved_reference",
          provenance: {
            ...provenance,
            confidence: "low",
            reason: `Proven implementation ${implementation.symbolId} could not be resolved.`,
          },
        });
        missingImplementationDefinitions += 1;
        continue;
      }
      semanticDefinitions.set(implementation.symbolId, memberDef);
      try {
        const memberReferences = await findReferences(
          snapshot.index,
          { def: memberDef },
          { maxReferences: maxEdits + 1 },
        );
        if (memberReferences.status === "ok") semanticReferences.push(...memberReferences.references);
        else referenceFailure ??= memberReferences.reason;
      } catch (error: unknown) {
        referenceFailure ??= errorMessage(error);
      }
    }
  } else if (/\b(?:ambiguous|overload)\b/i.test(implementationResult.reason)) {
    implementationAmbiguityReason = implementationResult.reason;
  }
  omittedImplementations += missingImplementationDefinitions;
  const edits: RenameEdit[] = [];
  const unsafeSites: RenameUnsafeSite[] = [];
  unsafeSites.push(...implementationUnsafeSites);
  const loadedFiles = new Map<string, Promise<LoadedRenameFile | null>>();
  const realRoot = await fs.realpath(snapshot.root);
  const loadSource: RenameSourceLoader = async (file) => {
    const loaded = await loadRenameFile(snapshot, realRoot, file, loadedFiles, unsafeSites, provenance);
    return loaded?.source ?? null;
  };
  if (referenceFailure) {
    unsafeSites.push({
      location: {
        file: normalizeAgentFilePath(snapshot.root, resolved.def.file),
        range: resolved.def.range,
      },
      text: resolved.def.localName,
      reason: "unresolved_reference",
      provenance: { ...provenance, confidence: "low", reason: referenceFailure },
    });
  }
  if (implementationAmbiguityReason) {
    unsafeSites.push({
      location: {
        file: normalizeAgentFilePath(snapshot.root, resolved.def.file),
        range: resolved.def.range,
      },
      text: resolved.def.localName,
      reason: "ambiguous_target",
      provenance: {
        ...provenance,
        confidence: "low",
        reason: implementationAmbiguityReason,
      },
    });
  }
  const definitionCandidates = [...semanticDefinitions.values()].map(
    (definition): CandidateEdit => ({
      file: definition.file,
      range: definition.range,
      kind: "definition",
    }),
  );
  const referenceLimitExceeded = semanticReferences.length > maxEdits;
  const selectedReferences = semanticReferences.slice(0, maxEdits);
  const importDeclarations = await collectImportDeclarationCandidates(
    selectedReferences,
    resolved.def.localName,
    loadSource,
  );
  const exportDeclarations = await collectExportDeclarationCandidates(snapshot, resolved.def, loadSource);
  const allCandidates: CandidateEdit[] = [
    ...definitionCandidates,
    ...importDeclarations.candidates,
    ...exportDeclarations.candidates,
    ...selectedReferences.map(
      (reference): CandidateEdit => ({
        file: reference.file,
        range: reference.range,
        kind: "reference",
        reference,
      }),
    ),
  ];
  const candidateLimitExceeded = allCandidates.length > maxEdits;
  const candidates = allCandidates.slice(0, maxEdits);
  await addScopeConflicts(snapshot, resolved.def, request.newName, selectedReferences, conflicts);

  for (const reference of importDeclarations.missing) {
    unsafeSites.push({
      location: {
        file: normalizeAgentFilePath(snapshot.root, reference.file),
        range: reference.range,
      },
      text: resolved.def.localName,
      reason: "unsupported_syntax",
      provenance: { ...provenance, confidence: "low", reason: "Import declaration range could not be proven." },
    });
  }

  for (const file of exportDeclarations.missingFiles) {
    unsafeSites.push({
      location: { file: normalizeAgentFilePath(snapshot.root, file), range: zeroRange() },
      text: resolved.def.localName,
      reason: "unsupported_syntax",
      provenance: { ...provenance, confidence: "low", reason: "Re-export declaration range could not be proven." },
    });
  }

  for (const candidate of candidates) {
    const loaded = await loadRenameFile(snapshot, realRoot, candidate.file, loadedFiles, unsafeSites, provenance);
    if (!loaded) continue;
    const oldText = textAtRange(loaded.source, candidate.range);
    if (
      candidate.reference?.via?.import &&
      isPreservedImportAlias(candidate.reference, oldText, resolved.def.localName)
    ) {
      continue;
    }
    if (oldText !== resolved.def.localName) {
      unsafeSites.push({
        location: { file: loaded.displayPath, range: candidate.range },
        text: oldText,
        reason: "unresolved_reference",
        provenance: { ...provenance, confidence: "low", reason: "Live source no longer matches indexed symbol text." },
      });
      continue;
    }
    edits.push({
      file: loaded.displayPath,
      range: candidate.range,
      oldText,
      newText: request.newName,
      kind: candidate.kind,
      provenance,
    });
  }
  let textualOmitted = 0;
  if (request.includeComments || request.includeStrings) {
    const textual = await collectTextualRenameEdits({
      snapshot,
      realRoot,
      oldName: resolved.def.localName,
      newName: request.newName,
      includeComments: request.includeComments ?? false,
      includeStrings: request.includeStrings ?? false,
      remaining: Math.max(0, maxEdits - edits.length),
      loadedFiles,
      unsafeSites,
      semanticProvenance: provenance,
    });
    edits.push(...textual.edits);
    textualOmitted = textual.omitted;
  }

  const verifiedFiles = await verifyFilesUnchanged(loadedFiles, unsafeSites, provenance);
  const normalizedEdits = normalizeEdits(edits, unsafeSites, provenance);
  let limitReason = "Textual candidate scan exceeded the requested edit limit.";
  if (omittedImplementations) limitReason = "Implementation lookup exceeded its response limit.";
  else if (candidateLimitExceeded) limitReason = "Combined semantic edits exceeded the requested edit limit.";
  else if (referenceLimitExceeded) limitReason = "Reference scan exceeded the requested edit limit.";

  if (omittedImplementations || referenceLimitExceeded || candidateLimitExceeded || textualOmitted) {
    const targetFile = normalizeAgentFilePath(snapshot.root, resolved.def.file);
    unsafeSites.push({
      location: { file: targetFile, range: resolved.def.range },
      text: resolved.def.localName,
      reason: "limit_exceeded",
      provenance: {
        ...provenance,
        confidence: "low",
        reason: limitReason,
      },
    });
  }
  if (snapshot.analysis.mode !== "semantic") {
    unsafeSites.push({
      location: {
        file: normalizeAgentFilePath(snapshot.root, resolved.def.file),
        range: resolved.def.range,
      },
      text: resolved.def.localName,
      reason: "parse_degraded",
      provenance: { ...provenance, confidence: "low", reason: snapshot.analysis.label },
    });
  }

  const editedFiles = [...new Set(normalizedEdits.map((edit) => edit.file))];
  const { candidateTests, omittedCandidateTests } = shapeCandidateTests(
    snapshot.index,
    snapshot.root,
    editedFiles,
    [...semanticDefinitions.keys()],
  );
  if (omittedCandidateTests) {
    unsafeSites.push({
      location: {
        file: normalizeAgentFilePath(snapshot.root, resolved.def.file),
        range: resolved.def.range,
      },
      text: resolved.def.localName,
      reason: "limit_exceeded",
      provenance: {
        ...provenance,
        confidence: "low",
        reason: "Candidate test scan exceeded the response limit.",
      },
    });
  }
  const filenameSuggestions = request.includeFilenames
    ? buildFilenameSuggestions(snapshot, resolved.def, request.newName)
    : [];
  const safeFreshness = freshness.state === "fresh" || freshness.state === "refreshed";
  const safe =
    safeFreshness &&
    verifiedFiles &&
    !referenceLimitExceeded &&
    !candidateLimitExceeded &&
    !omittedImplementations &&
    snapshot.analysis.mode === "semantic" &&
    !unsafeSites.length &&
    !conflicts.length;

  return {
    schemaVersion: 1,
    root: snapshot.root,
    analysis: snapshot.analysis,
    freshness,
    limits: { edits: maxEdits, candidateTests: 100 },
    omittedCounts: {
      edits:
        Math.max(
          Math.max(0, semanticReferences.length - selectedReferences.length),
          Math.max(0, allCandidates.length - candidates.length),
        ) +
        textualOmitted +
        omittedImplementations,
      candidateTests: omittedCandidateTests,
    },
    target: semanticSymbolFromDef(snapshot, resolved.def),
    newName: request.newName,
    safe,
    edits: normalizedEdits,
    unsafeSites: unsafeSites.sort(compareUnsafeSites),
    conflicts: conflicts.sort(compareConflicts),
    filenameSuggestions,
    candidateTests,
  };
}

function validateNewName(snapshot: AgentProjectSnapshot, def: SymbolDef, newName: string): RenameConflict[] {
  const file = normalizeAgentFilePath(snapshot.root, def.file);
  const conflicts: RenameConflict[] = [];
  const invalidPathCharacters = newName.includes("/") || newName.includes("\\") || newName.includes("\0");
  const support = supportForFile(def.file);
  const allowsDollar = support?.id === "js" || support?.id === "ts" || support?.id === "tsx";
  const identifierPattern = allowsDollar
    ? /^[$_\p{ID_Start}](?:[$_\p{ID_Continue}]|\u200c|\u200d)*$/u
    : /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u;
  if (!newName || invalidPathCharacters || !identifierPattern.test(newName)) {
    conflicts.push({
      file,
      location: { file, range: def.range },
      reason: "invalid_identifier",
      message: `"${newName}" is not a valid ${support?.id ?? "conservative"} identifier.`,
    });
  }
  if (newName !== def.localName && newName.toLocaleLowerCase() === def.localName.toLocaleLowerCase()) {
    conflicts.push({
      file,
      location: { file, range: def.range },
      reason: "case_only_filesystem_risk",
      message: "Case-only renames can collide on case-insensitive filesystems.",
    });
  }
  return conflicts;
}

async function addScopeConflicts(
  snapshot: AgentProjectSnapshot,
  target: SymbolDef,
  newName: string,
  references: readonly Reference[],
  conflicts: RenameConflict[],
): Promise<void> {
  const moduleIndex = snapshot.index.byFile.get(fileIdentityKey(target.file));
  if (!moduleIndex) return;
  const file = normalizeAgentFilePath(snapshot.root, target.file);
  let localCollision: SymbolDef | undefined;
  try {
    const parsed = await ensureParsedContext(target.file, snapshot.index.parsed?.get(fileIdentityKey(target.file)));
    const scopeIndex = getCachedScope(snapshot.index, target.file, moduleIndex, parsed);
    const targetBinding = scopeIndex.all.find(
      (binding) =>
        binding.name === target.localName &&
        binding.def?.start.index === target.range.start.index &&
        binding.def?.end.index === target.range.end.index,
    );
    const targetScope = targetBinding
      ? scopeIndex.allScopes.find((scope) => scope.map.get(target.localName) === targetBinding)
      : undefined;
    const collisionBinding = targetScope?.map.get(newName);
    if (collisionBinding?.def) {
      localCollision = moduleIndex.locals.find(
        (candidate) =>
          candidate.localName === newName && candidate.range.start.index === collisionBinding.def?.start.index,
      );
    }
  } catch {
    localCollision = moduleIndex.locals.find((candidate) => candidate !== target && candidate.localName === newName);
  }
  if (localCollision) {
    conflicts.push({
      file,
      location: { file, range: localCollision.range },
      reason: "name_collision",
      existingHandle: semanticSymbolFromDef(snapshot, localCollision).handle,
      message: `The target scope already declares "${newName}".`,
    });
  }

  const targetId = defNodeId(target);
  const ownerId = snapshot.symbolGraph.edges.find((edge) => edge.from === targetId && edge.label === "member_of")?.to;
  const memberCollisionId = ownerId
    ? snapshot.symbolGraph.edges
        .filter((edge) => edge.to === ownerId && edge.label === "member_of" && edge.from !== targetId)
        .map((edge) => edge.from)
        .find((id) => snapshot.symbolGraph.nodes.get(id)?.name === newName)
    : undefined;
  const memberCollision = memberCollisionId ? buildSymbolLookup(snapshot).defById.get(memberCollisionId) : undefined;
  if (memberCollision) {
    conflicts.push({
      file,
      location: { file, range: memberCollision.range },
      reason: "name_collision",
      existingHandle: semanticSymbolFromDef(snapshot, memberCollision).handle,
      message: `The owning type already declares a member named "${newName}".`,
    });
  }

  const duplicateExport = moduleIndex.exports.find((entry) => {
    if (!("exportedAs" in entry) || entry.exportedAs !== newName) return false;
    if (entry.type !== "local") return true;
    return defNodeId(entry.target) !== targetId;
  });
  if (duplicateExport) {
    const duplicateDef = duplicateExport.type === "local" ? duplicateExport.target : undefined;
    conflicts.push({
      file,
      ...(duplicateDef ? { location: { file, range: duplicateDef.range } } : {}),
      reason: "duplicate_export",
      ...(duplicateDef ? { existingHandle: semanticSymbolFromDef(snapshot, duplicateDef).handle } : {}),
      message: `The target module already exports "${newName}".`,
    });
  }

  const seenImportFiles = new Set<string>();
  for (const reference of references) {
    const activeImport = reference.via?.import;
    const localImportWillChange = activeImport?.kind === "named" && activeImport.local === target.localName;
    if (!activeImport || !localImportWillChange || seenImportFiles.has(fileIdentityKey(reference.file))) continue;
    seenImportFiles.add(fileIdentityKey(reference.file));
    const consumer = snapshot.index.byFile.get(fileIdentityKey(reference.file));
    if (!consumer) continue;
    let collides = false;
    try {
      const parsed = await ensureParsedContext(
        reference.file,
        snapshot.index.parsed?.get(fileIdentityKey(reference.file)),
      );
      const scopeIndex = getCachedScope(snapshot.index, reference.file, consumer, parsed);
      const activeBinding = scopeIndex.all.find((binding) => binding.import === activeImport);
      const activeScope = activeBinding
        ? scopeIndex.allScopes.find((scope) => scope.map.get(activeImport.local) === activeBinding)
        : undefined;
      const collisionBinding = activeScope?.map.get(newName);
      collides = !!collisionBinding && collisionBinding !== activeBinding;
    } catch {
      collides =
        consumer.locals.some((candidate) => candidate.localName === newName) ||
        consumer.imports.some((binding) => {
          if (binding === activeImport || binding.kind === "star") return false;
          const local = binding.kind === "namespace" ? binding.localNS : binding.local;
          return local === newName;
        });
    }
    if (!collides) continue;
    const consumerFile = normalizeAgentFilePath(snapshot.root, reference.file);
    conflicts.push({
      file: consumerFile,
      location: { file: consumerFile, range: reference.range },
      reason: "shadowing",
      message: `Renaming this import would collide with an existing "${newName}" binding.`,
    });
  }
}

async function loadRenameFile(
  snapshot: AgentProjectSnapshot,
  realRoot: string,
  file: string,
  cache: Map<string, Promise<LoadedRenameFile | null>>,
  unsafeSites: RenameUnsafeSite[],
  provenance: SemanticProvenance,
): Promise<LoadedRenameFile | null> {
  const cached = cache.get(file);
  if (cached) return await cached;
  const load = (async (): Promise<LoadedRenameFile | null> => {
    try {
      const resolved = await resolveReadableFile(realRoot, snapshot.root, file);
      const sensitiveKind = classifySensitiveFile(resolved.displayPath) ?? classifySensitiveFile(resolved.realPath);
      if (sensitiveKind) {
        unsafeSites.push({
          location: { file: resolved.displayPath, range: zeroRange() },
          text: "",
          reason: "sensitive_file",
          provenance: {
            ...provenance,
            confidence: "low",
            reason: `Rename preview does not read ${sensitiveKind} files.`,
          },
        });
        return null;
      }
      if (isGeneratedRenameFile(resolved.displayPath) || isGeneratedRenameFile(resolved.realPath)) {
        unsafeSites.push({
          location: { file: resolved.displayPath, range: zeroRange() },
          text: "",
          reason: "generated_file",
          provenance: {
            ...provenance,
            confidence: "low",
            reason: "Generated or vendored files are not edited by rename preview.",
          },
        });
        return null;
      }
      const before = await fs.stat(resolved.realPath);
      const indexedSignature = snapshot.fileSignatures?.get(file) ?? snapshot.fileSignatures?.get(resolved.realPath);
      if (indexedSignature && (indexedSignature.size !== before.size || indexedSignature.mtimeMs !== before.mtimeMs)) {
        unsafeSites.push({
          location: { file: resolved.displayPath, range: zeroRange() },
          text: "",
          reason: "unresolved_reference",
          provenance: { ...provenance, confidence: "low", reason: "File changed after indexing." },
        });
        return null;
      }
      const bytes = await fs.readFile(resolved.realPath);
      if (bytes.includes(0)) throw new Error("Binary source contains NUL bytes.");
      let source: string;
      try {
        source = strictUtf8Decoder.decode(bytes);
      } catch {
        throw new Error("Malformed UTF-8 source cannot be renamed safely.");
      }
      return {
        displayPath: resolved.displayPath,
        realPath: resolved.realPath,
        source,
        beforeSize: before.size,
        beforeMtimeMs: before.mtimeMs,
      };
    } catch (error: unknown) {
      const message = errorMessage(error);
      let reason: RenameUnsafeSite["reason"] = "unresolved_reference";
      if (/outside project root/i.test(message)) reason = "outside_root";
      else if (/binary source|malformed UTF-8/i.test(message)) reason = "unsupported_syntax";
      unsafeSites.push({
        location: { file: normalizeAgentFilePath(snapshot.root, file), range: zeroRange() },
        text: "",
        reason,
        provenance: { ...provenance, confidence: "low", reason: message },
      });
      return null;
    }
  })();
  cache.set(file, load);
  return await load;
}

function isGeneratedRenameFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return /(?:^|\/)(?:dist|build|generated|vendor)\//i.test(normalized) || /(?:^|\.)generated\.[^/]+$/i.test(normalized);
}

async function verifyFilesUnchanged(
  cache: Map<string, Promise<LoadedRenameFile | null>>,
  unsafeSites: RenameUnsafeSite[],
  provenance: SemanticProvenance,
): Promise<boolean> {
  let unchanged = true;
  for (const load of cache.values()) {
    const file = await load;
    if (!file) {
      unchanged = false;
      continue;
    }
    try {
      const after = await fs.stat(file.realPath);
      if (after.size === file.beforeSize && after.mtimeMs === file.beforeMtimeMs) continue;
      unchanged = false;
      unsafeSites.push({
        location: { file: file.displayPath, range: zeroRange() },
        text: "",
        reason: "unresolved_reference",
        provenance: { ...provenance, confidence: "low", reason: "File changed during rename preview." },
      });
    } catch (error: unknown) {
      unchanged = false;
      unsafeSites.push({
        location: { file: file.displayPath, range: zeroRange() },
        text: "",
        reason: "unresolved_reference",
        provenance: {
          ...provenance,
          confidence: "low",
          reason: errorMessage(error),
        },
      });
    }
  }
  return unchanged;
}

async function collectTextualRenameEdits(
  input: TextualRenameScanInput,
): Promise<{ edits: RenameEdit[]; omitted: number }> {
  const edits: RenameEdit[] = [];
  let omitted = 0;
  const heuristicProvenance: SemanticProvenance = {
    ...input.semanticProvenance,
    capability: "heuristic",
    confidence: "low",
    reason: "Opt-in whole-identifier text candidate classified from syntax context.",
  };
  for (const file of [...input.snapshot.files].sort()) {
    const loaded = await loadRenameFile(
      input.snapshot,
      input.realRoot,
      file,
      input.loadedFiles,
      input.unsafeSites,
      input.semanticProvenance,
    );
    if (!loaded) continue;
    let parsed;
    try {
      parsed = await ensureParsedContext(file, input.snapshot.index.parsed?.get(fileIdentityKey(file)));
    } catch (error: unknown) {
      input.unsafeSites.push({
        location: { file: loaded.displayPath, range: zeroRange() },
        text: "",
        reason: "parse_degraded",
        provenance: {
          ...heuristicProvenance,
          reason: errorMessage(error),
        },
      });
      continue;
    }
    for (const startIndex of wholeIdentifierOffsets(loaded.source, input.oldName)) {
      const endIndex = startIndex + input.oldName.length;
      const kind = classifyTextualOccurrence(parsed.tree.rootNode.descendantForIndex(startIndex, endIndex));
      const included = (kind === "comment" && input.includeComments) || (kind === "string" && input.includeStrings);
      if (!included || !kind) continue;
      if (edits.length >= input.remaining) {
        omitted += 1;
        continue;
      }
      edits.push({
        file: loaded.displayPath,
        range: rangeFromOffsets(loaded.source, startIndex, endIndex),
        oldText: input.oldName,
        newText: input.newName,
        kind,
        provenance: heuristicProvenance,
      });
    }
  }
  return { edits, omitted };
}

function wholeIdentifierOffsets(source: string, identifier: string): number[] {
  const offsets: number[] = [];
  let offset = source.indexOf(identifier);
  while (offset >= 0) {
    const before = source[offset - 1];
    const after = source[offset + identifier.length];
    const startsAtBoundary = before === undefined || !/[$_\p{ID_Continue}]/u.test(before);
    const endsAtBoundary = after === undefined || !/[$_\p{ID_Continue}]/u.test(after);
    if (startsAtBoundary && endsAtBoundary) offsets.push(offset);
    offset = source.indexOf(identifier, offset + identifier.length);
  }
  return offsets;
}

function classifyTextualOccurrence(node: {
  type: string;
  parent: { type: string; parent: (typeof node)["parent"] } | null;
}): "comment" | "string" | null {
  let current: { type: string; parent: (typeof node)["parent"] } | null = node;
  let stringLike = false;
  while (current) {
    const type = current.type.toLocaleLowerCase();
    if (type.includes("comment")) return "comment";
    if (type.includes("import") || type === "use_declaration") {
      return null;
    }
    if (type.includes("string") || type.includes("template") || type.includes("quoted") || type === "char_literal") {
      stringLike = true;
    }
    current = current.parent;
  }
  return stringLike ? "string" : null;
}

async function collectImportDeclarationCandidates(
  references: readonly Reference[],
  oldName: string,
  loadSource: RenameSourceLoader,
): Promise<ImportDeclarationScan> {
  const candidates: CandidateEdit[] = [];
  const missing: Reference[] = [];
  const seenBindings = new Set<string>();
  for (const reference of references) {
    const binding = reference.via?.import;
    if (!binding || binding.kind !== "named" || binding.imported !== oldName) continue;
    const key = `${reference.file}:${binding.from}:${binding.imported}:${binding.local}`;
    if (seenBindings.has(key)) continue;
    seenBindings.add(key);
    const source = await loadSource(reference.file);
    if (!source) continue;
    const range = findImportDeclarationRange(source, binding.from, oldName);
    if (range) candidates.push({ file: reference.file, range, kind: "import" });
    else missing.push(reference);
  }
  return { candidates, missing };
}

async function collectExportDeclarationCandidates(
  snapshot: AgentProjectSnapshot,
  target: SymbolDef,
  loadSource: RenameSourceLoader,
): Promise<ExportDeclarationScan> {
  const candidates: CandidateEdit[] = [];
  const missingFiles: string[] = [];
  const seenRanges = new Set<string>();
  const declarations = getRenameExportIndex(snapshot.index).get(defNodeId(target)) ?? [];
  for (const declaration of declarations) {
    const source = await loadSource(declaration.file);
    if (!source) continue;
    const range = findExportDeclarationRange(
      source,
      declaration.sourceName,
      declaration.exportedName,
      declaration.moduleSpecifier,
    );
    if (range) pushExportCandidate(candidates, seenRanges, declaration.file, range);
    else if (declaration.required) missingFiles.push(declaration.file);
  }
  return { candidates, missingFiles: [...new Set(missingFiles)] };
}

function getRenameExportIndex(index: ProjectIndex): ReadonlyMap<string, readonly IndexedExportDeclaration[]> {
  const cached = renameExportIndexCache.get(index);
  if (cached) return cached;
  const byTarget = new Map<string, IndexedExportDeclaration[]>();
  const add = (targetId: string, declaration: IndexedExportDeclaration): void => {
    const declarations = byTarget.get(targetId) ?? [];
    declarations.push(declaration);
    byTarget.set(targetId, declarations);
  };
  for (const moduleIndex of index.byFile.values()) {
    for (const entry of moduleIndex.exports) {
      if (entry.type === "local") {
        add(defNodeId(entry.target), {
          file: moduleIndex.file,
          sourceName: entry.target.localName,
          exportedName: entry.exportedAs,
          required: false,
        });
        continue;
      }
      if (entry.type !== "reexport") continue;
      const resolved = resolveExport(index, moduleIndex.file, entry.exportedAs, {
        allowLocalFallback: false,
      });
      if (resolved?.kind !== "resolved") continue;
      add(defNodeId(resolved.def), {
        file: moduleIndex.file,
        sourceName: entry.sourceSpecifier,
        exportedName: entry.exportedAs,
        moduleSpecifier: entry.moduleSpecifier ?? entry.fromModule,
        required: true,
      });
    }
  }
  renameExportIndexCache.set(index, byTarget);
  return byTarget;
}

function pushExportCandidate(candidates: CandidateEdit[], seenRanges: Set<string>, file: string, range: Range): void {
  const key = `${file}:${range.start.index ?? ""}:${range.end.index ?? ""}`;
  if (seenRanges.has(key)) return;
  seenRanges.add(key);
  candidates.push({ file, range, kind: "export" });
}

function findExportDeclarationRange(
  source: string,
  sourceName: string,
  exportedName: string,
  moduleSpecifier?: string,
): Range | null {
  const ranges: Range[] = [];
  const statementPattern = /\bexport\s+(?:type\s+)?\{([\s\S]*?)\}\s*(?:from\s+(["'])([^"']+)\2)?\s*;?/gu;
  for (const statement of source.matchAll(statementPattern)) {
    const statementStart = statement.index;
    const statementText = statement[0];
    const specifiers = statement[1];
    const from = statement[3];
    if (statementStart === undefined || specifiers === undefined) continue;
    if (moduleSpecifier) {
      if (from === undefined || !sameModuleSpecifier(from, moduleSpecifier)) continue;
    } else if (from !== undefined) {
      continue;
    }
    const specifierStart = statementText.indexOf(specifiers);
    const specifierPattern =
      /([$_\p{ID_Start}][$_\p{ID_Continue}]*)\s*(?:\s+as\s+([$_\p{ID_Start}][$_\p{ID_Continue}]*))?\s*(?:,|$)/gu;
    for (const specifier of specifiers.matchAll(specifierPattern)) {
      const candidateSource = specifier[1];
      const candidateExport = specifier[2] ?? candidateSource;
      if (candidateSource !== sourceName || candidateExport !== exportedName || specifier.index === undefined) {
        continue;
      }
      const sourceOffset = specifier[0].indexOf(sourceName);
      const start = statementStart + specifierStart + specifier.index + sourceOffset;
      ranges.push(rangeFromOffsets(source, start, start + sourceName.length));
    }
  }
  return ranges.length === 1 ? ranges[0]! : null;
}

function findImportDeclarationRange(source: string, specifier: string, oldName: string): Range | null {
  const offsets: number[] = [];
  const esPattern = /\bimport\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+(["'])([^"']+)\2\s*;?/gu;
  for (const statement of source.matchAll(esPattern)) {
    const statementStart = statement.index;
    const statementText = statement[0];
    const specifiers = statement[1];
    const from = statement[3];
    if (
      statementStart === undefined ||
      specifiers === undefined ||
      from === undefined ||
      !sameModuleSpecifier(from, specifier)
    ) {
      continue;
    }
    const specifierStart = statementText.indexOf(specifiers);
    for (const relativeOffset of namedImportSpecifierOffsets(specifiers, oldName)) {
      offsets.push(statementStart + specifierStart + relativeOffset);
    }
  }

  const pythonPattern = /(?:^|\n)\s*from\s+([^\s]+)\s+import\s+([^\r\n;]+)/gu;
  for (const statement of source.matchAll(pythonPattern)) {
    const statementStart = statement.index;
    const statementText = statement[0];
    const from = statement[1];
    const specifiers = statement[2];
    if (
      statementStart === undefined ||
      from === undefined ||
      specifiers === undefined ||
      !sameModuleSpecifier(from, specifier)
    ) {
      continue;
    }
    const specifierStart = statementText.indexOf(specifiers);
    for (const relativeOffset of namedImportSpecifierOffsets(specifiers, oldName)) {
      offsets.push(statementStart + specifierStart + relativeOffset);
    }
  }

  const phpPattern = /\buse\s+(?:function\s+|const\s+)?([^;]+);/gu;
  for (const statement of source.matchAll(phpPattern)) {
    const statementStart = statement.index;
    const statementText = statement[0];
    const imports = statement[1];
    if (
      statementStart === undefined ||
      imports === undefined ||
      (!statementText.includes(specifier) && !statementText.includes(path.basename(specifier)))
    ) {
      continue;
    }
    const importsStart = statementText.indexOf(imports);
    for (const imported of imports.matchAll(/(?:^|,)\s*([^,\s]+)(?:\s+as\s+[$_\p{ID_Start}][$_\p{ID_Continue}]*)?/gu)) {
      const qualifiedName = imported[1];
      if (qualifiedName === undefined || imported.index === undefined) continue;
      const nameOffset = qualifiedName.lastIndexOf(oldName);
      const before = qualifiedName[nameOffset - 1];
      const exactImportedName =
        nameOffset >= 0 &&
        nameOffset + oldName.length === qualifiedName.length &&
        (nameOffset === 0 || before === "\\");
      if (!exactImportedName) continue;
      offsets.push(statementStart + importsStart + imported.index + imported[0].indexOf(qualifiedName) + nameOffset);
    }
  }

  const uniqueOffsets = [...new Set(offsets)];
  if (uniqueOffsets.length !== 1) return null;
  const start = uniqueOffsets[0]!;
  return rangeFromOffsets(source, start, start + oldName.length);
}

function namedImportSpecifierOffsets(specifiers: string, oldName: string): number[] {
  const offsets: number[] = [];
  const pattern =
    /(?:^|,)\s*(?:type\s+)?([$_\p{ID_Start}][$_\p{ID_Continue}]*)(?:\s+as\s+[$_\p{ID_Start}][$_\p{ID_Continue}]*)?\s*(?=,|$)/gu;
  for (const specifier of specifiers.matchAll(pattern)) {
    if (specifier[1] !== oldName || specifier.index === undefined) continue;
    offsets.push(specifier.index + specifier[0].indexOf(oldName));
  }
  return offsets;
}

function sameModuleSpecifier(actual: string, expected: string): boolean {
  if (actual === expected || path.basename(actual) === path.basename(expected)) return true;
  const actualStem = path.basename(actual, path.extname(actual));
  const expectedStem = path.basename(expected, path.extname(expected));
  return actualStem === expectedStem;
}

function rangeFromOffsets(source: string, startIndex: number, endIndex: number): Range {
  const startPrefix = source.slice(0, startIndex);
  const endPrefix = source.slice(0, endIndex);
  const startLineBreak = startPrefix.lastIndexOf("\n");
  const endLineBreak = endPrefix.lastIndexOf("\n");
  return {
    start: {
      line: startPrefix.split("\n").length,
      column: startIndex - startLineBreak,
      index: startIndex,
    },
    end: {
      line: endPrefix.split("\n").length,
      column: endIndex - endLineBreak,
      index: endIndex,
    },
  };
}

function isPreservedImportAlias(reference: Reference, text: string, oldName: string): boolean {
  const binding = reference.via?.import;
  if (!binding || binding.kind === "star" || binding.kind === "namespace") return false;
  if (binding.kind === "default") return true;
  return binding.local !== oldName && text === binding.local;
}

function normalizeEdits(
  edits: RenameEdit[],
  unsafeSites: RenameUnsafeSite[],
  provenance: SemanticProvenance,
): RenameEdit[] {
  const byRange = new Map<string, RenameEdit>();
  for (const edit of edits) {
    const key = `${edit.file}:${edit.range.start.index ?? ""}:${edit.range.end.index ?? ""}:${edit.oldText}:${edit.newText}`;
    if (!byRange.has(key)) byRange.set(key, edit);
  }
  const normalized = [...byRange.values()].sort(compareEdits);
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1]!;
    const current = normalized[index]!;
    if (previous.file !== current.file) continue;
    const previousEnd = previous.range.end.index;
    const currentStart = current.range.start.index;
    if (previousEnd === undefined || currentStart === undefined || currentStart >= previousEnd) continue;
    unsafeSites.push({
      location: { file: current.file, range: current.range },
      text: current.oldText,
      reason: "unsupported_syntax",
      provenance: { ...provenance, confidence: "low", reason: "Rename edits overlap." },
    });
  }
  return normalized;
}

function buildFilenameSuggestions(
  snapshot: AgentProjectSnapshot,
  def: SymbolDef,
  newName: string,
): RenameFilenameSuggestion[] {
  const isPublicType =
    def.kind === SymbolKind.Class || def.kind === SymbolKind.Interface || def.kind === SymbolKind.TypeAlias;
  const isExported = snapshot.index.byFile
    .get(fileIdentityKey(def.file))
    ?.exports.some((entry) => entry.type === "local" && defNodeId(entry.target) === defNodeId(def));
  if (!isPublicType || !isExported) return [];
  const parsed = path.parse(normalizeAgentFilePath(snapshot.root, def.file));
  if (parsed.name !== def.localName) return [];
  const to = path.posix.join(parsed.dir.replace(/\\/g, "/"), `${newName}${parsed.ext}`);
  return [
    {
      from: normalizeAgentFilePath(snapshot.root, def.file),
      to,
      caseOnlyRisk: parsed.name !== newName && parsed.name.toLocaleLowerCase() === newName.toLocaleLowerCase(),
    },
  ];
}

function semanticRenameProvenance(snapshot: AgentProjectSnapshot): SemanticProvenance {
  const degraded = snapshot.analysis.mode !== "semantic";
  return {
    capability: degraded ? "graph" : "semantic",
    backend: snapshot.analysis.backend,
    confidence: degraded ? "medium" : "high",
    ...(degraded ? { reason: snapshot.analysis.label } : {}),
  };
}

function textAtRange(source: string, range: Range): string {
  if (range.start.index !== undefined && range.end.index !== undefined) {
    return source.slice(range.start.index, range.end.index);
  }
  const lines = source.split(/\r?\n/);
  if (range.start.line !== range.end.line) return "";
  const line = lines[range.start.line - 1] ?? "";
  return line.slice(range.start.column - 1, range.end.column - 1);
}

function normalizeMaxEdits(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RENAME_EDITS;
  if (!Number.isInteger(value) || value < 1) throw new Error("Rename maxEdits must be a positive integer.");
  return Math.min(value, MAX_RENAME_EDITS);
}

function compareEdits(left: RenameEdit, right: RenameEdit): number {
  return (
    left.file.localeCompare(right.file) ||
    left.range.start.line - right.range.start.line ||
    left.range.start.column - right.range.start.column ||
    left.kind.localeCompare(right.kind)
  );
}

function compareUnsafeSites(left: RenameUnsafeSite, right: RenameUnsafeSite): number {
  return (
    left.location.file.localeCompare(right.location.file) ||
    left.location.range.start.line - right.location.range.start.line ||
    left.location.range.start.column - right.location.range.start.column ||
    left.reason.localeCompare(right.reason)
  );
}

function compareConflicts(left: RenameConflict, right: RenameConflict): number {
  return (
    left.file.localeCompare(right.file) ||
    left.reason.localeCompare(right.reason) ||
    left.message.localeCompare(right.message)
  );
}

function zeroRange(): Range {
  return {
    start: { line: 1, column: 1, index: 0 },
    end: { line: 1, column: 1, index: 0 },
  };
}
