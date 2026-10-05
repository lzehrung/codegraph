import type { GoToResult, ProjectIndex, ResolutionProvenance, SymbolDef } from "./types.js";

type GoToVia = Extract<GoToResult, { status: "ok" }>["via"];
type ResolutionKind = NonNullable<ResolutionProvenance["resolution"]>;
type ResolutionConfidence = NonNullable<ResolutionProvenance["confidence"]>;

export function createNavigationProvenance(
  resolution: ResolutionKind,
  confidence: ResolutionConfidence,
): ResolutionProvenance {
  // Navigation always runs on the required native backend.
  return {
    backend: "native",
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
    provenance: createNavigationProvenance(options.resolution, options.confidence),
  };
}
