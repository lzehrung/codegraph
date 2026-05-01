import type { GoToResult, ProjectIndex, ResolutionProvenance, SymbolDef } from "./types.js";

type GoToVia = Extract<GoToResult, { status: "ok" }>["via"];
type ResolutionKind = NonNullable<ResolutionProvenance["resolution"]>;
type ResolutionConfidence = NonNullable<ResolutionProvenance["confidence"]>;

function getNavigationBackend(index: ProjectIndex): ResolutionProvenance["backend"] | undefined {
  if (index.nativeMode === "on") {
    return "native";
  }
  if (index.nativeMode === "off") {
    return "js-fallback";
  }
  return undefined;
}

export function createNavigationProvenance(
  index: ProjectIndex,
  resolution: ResolutionKind,
  confidence: ResolutionConfidence,
): ResolutionProvenance {
  const backend = getNavigationBackend(index);
  return {
    ...(backend ? { backend } : {}),
    ...(resolution ? { resolution } : {}),
    ...(confidence ? { confidence } : {}),
  };
}

export function okGoToResult(
  index: ProjectIndex,
  definition: SymbolDef,
  options: {
    via?: GoToVia;
    resolution: ResolutionKind;
    confidence: ResolutionConfidence;
  },
): GoToResult {
  return {
    status: "ok",
    definition,
    ...(options.via ? { via: options.via } : {}),
    provenance: createNavigationProvenance(index, options.resolution, options.confidence),
  };
}
