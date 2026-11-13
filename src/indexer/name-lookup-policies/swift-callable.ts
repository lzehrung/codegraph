import { getCallArgumentCount } from "../../languages/callable-arity.js";
import { swiftCallLabels, swiftLabelsFit, swiftParametersAcceptLabels } from "../../util/swift-tree.js";
import { fileIdentityKey } from "../../util/paths.js";
import { AMBIGUOUS_SWIFT_OVERLOAD_REASON } from "../ambiguous-resolution.js";
import { getCompilationUnitPeers } from "../compilation-units.js";
import { definitionForBinding } from "../navigation-local.js";
import { okGoToResult } from "../navigation-provenance.js";
import type { NameLookupState, NameResolution } from "../name-resolution-types.js";
import type { Binding } from "../scope-types.js";
import { SymbolKind, type ProjectIndex, type SymbolDef } from "../types.js";

type SwiftPeerCandidate = { peerKey: string; definition: SymbolDef };
type SwiftUnitCandidates = Map<string, SwiftPeerCandidate[]>;
type SwiftCandidateCache = {
  byFile: ProjectIndex["byFile"];
  size: number;
  languageExtensions: ProjectIndex["languageExtensions"];
  unitsByFile: Map<string, SwiftUnitCandidates>;
};

const swiftCandidateCaches = new WeakMap<ProjectIndex, SwiftCandidateCache>();

/** Group visible unit exports once per index generation, shared by all files in the unit. */
function swiftUnitCandidates(
  index: ProjectIndex,
  file: string,
  normalize: (name: string) => string,
): SwiftUnitCandidates {
  let cache = swiftCandidateCaches.get(index);
  if (
    !cache ||
    cache.byFile !== index.byFile ||
    cache.size !== index.byFile.size ||
    cache.languageExtensions !== index.languageExtensions
  ) {
    cache = {
      byFile: index.byFile,
      size: index.byFile.size,
      languageExtensions: index.languageExtensions,
      unitsByFile: new Map(),
    };
    swiftCandidateCaches.set(index, cache);
  }
  const fileKey = fileIdentityKey(file);
  const existing = cache.unitsByFile.get(fileKey);
  if (existing) return existing;

  const grouped: SwiftUnitCandidates = new Map();
  const peers = getCompilationUnitPeers(index, file).files;
  if (peers.size === 1) {
    cache.unitsByFile.set(fileKey, grouped);
    return grouped;
  }
  for (const peerFile of peers) {
    const peerKey = fileIdentityKey(peerFile);
    cache.unitsByFile.set(peerKey, grouped);
    const peer = index.byFile.get(peerKey);
    if (!peer) continue;
    for (const entry of peer.exports) {
      if (entry.type !== "local" || entry.target.isMember || entry.target.kind !== SymbolKind.Function) continue;
      const name = normalize(entry.exportedAs);
      const candidates = grouped.get(name);
      const candidate = { peerKey, definition: entry.target };
      if (candidates) candidates.push(candidate);
      else grouped.set(name, [candidate]);
    }
  }
  return grouped;
}

/** Select a Swift bare function call from its lexical overloads and visible unit peers. */
export function swiftFreeCallableLookup(
  state: NameLookupState,
  fallback: NameResolution | null,
  bindingIsMember: boolean,
): NameResolution | null {
  const { use, closestBinding, lookupName } = state;
  const { node, parsed, scopeIndex, index, file } = use;
  const parent = node.parent;
  const call = parent?.type === "call_expression" && parent.namedChildren[0]?.id === node.id ? parent : null;
  if (!call && closestBinding?.kind !== "function") return fallback;
  if (closestBinding && closestBinding.kind !== "function") return fallback;
  const root = scopeIndex.allScopes[0];
  const normalizedName = parsed.sup.normalizeIdentifier(lookupName);
  const rootBinding = root?.map.get(normalizedName);
  const localFunction = closestBinding && !bindingIsMember && closestBinding !== rootBinding;
  const candidates: SymbolDef[] = [];
  const addBindingGroup = (start: Binding | undefined): void => {
    for (let binding = start; binding?.kind === "function"; binding = binding.earlierSameScope) {
      const definition = definitionForBinding(binding, file, node, parsed.sup, parsed.source, parsed.tree);
      if (definition) candidates.push(definition);
    }
  };
  if (localFunction) {
    addBindingGroup(closestBinding);
  } else {
    addBindingGroup(rootBinding);
    const ownFileKey = fileIdentityKey(file);
    const unitCandidates = swiftUnitCandidates(index, file, parsed.sup.normalizeIdentifier).get(normalizedName);
    if (unitCandidates) {
      for (const { peerKey, definition } of unitCandidates) {
        if (peerKey === ownFileKey) continue;
        const definitionFileKey = fileIdentityKey(definition.file);
        const alreadyIncluded = candidates.some(
          (candidate) =>
            fileIdentityKey(candidate.file) === definitionFileKey &&
            candidate.range.start.index === definition.range.start.index,
        );
        if (!alreadyIncluded) candidates.push(definition);
      }
    }
  }
  if (!candidates.length) return fallback;
  const labels = call ? swiftCallLabels(node) : null;
  const count = call ? getCallArgumentCount({ languageId: "swift", source: parsed.source, call }) : null;
  const labelsFit = (candidate: SymbolDef): boolean => {
    const parameters = candidate.callable?.swiftParameters;
    return !labels || !parameters || swiftLabelsFit(parameters, labels);
  };
  const countFits = (candidate: SymbolDef): boolean => {
    const arity = candidate.callable?.arity;
    return count === null || !arity || (count >= arity.minArgs && (arity.maxArgs === null || count <= arity.maxArgs));
  };
  const acceptsCall = (candidate: SymbolDef): boolean => {
    const parameters = candidate.callable?.swiftParameters;
    return countFits(candidate) && (!labels || !parameters || swiftParametersAcceptLabels(parameters, labels));
  };
  // A lone function of that name stays the target of a call whose labels or argument count do not fit it, which impact
  // analysis reports; a label the call spells wrongly proves another declaration only when overloads compete.
  const fitting = candidates.length === 1 ? candidates : candidates.filter(labelsFit);
  const matching = fitting.filter(acceptsCall);
  // When no label chooses, the argument count does: the one overload whose count fits. Once any overload's labels
  // fit, never resurrect an overload whose labels did not fit.
  const countPool = fitting.length ? fitting : candidates;
  const byCount = !matching.length && fitting.length !== 1 ? countPool.filter(countFits) : [];
  let selected: NameResolution;
  if (matching.length === 1) {
    selected = okGoToResult(index, matching[0]!, { resolution: "exact", confidence: "high" });
  } else if (!matching.length && fitting.length === 1) {
    selected = okGoToResult(index, fitting[0]!, { resolution: "exact", confidence: "medium" });
  } else if (byCount.length === 1) {
    selected = okGoToResult(index, byCount[0]!, { resolution: "exact", confidence: "medium" });
  } else {
    selected = {
      status: "not_found",
      reason: matching.length ? AMBIGUOUS_SWIFT_OVERLOAD_REASON : "No applicable Swift callable",
    };
  }
  // A member reached through implicit self precedes a module function of the same spelling.
  if (fallback?.status === "deferred" && fallback.request.kind === "implicit-self-member") {
    return { ...fallback, fallback: selected };
  }
  return selected;
}
