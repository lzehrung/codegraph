import type { ImportBinding } from "../import-types.js";
import type { Binding, ScopeBindingRules } from "../scope-types.js";

/** Python module names follow execution order, or the completed module inside a function body. */
export const effectivePythonModuleScopeBinding: NonNullable<ScopeBindingRules["effectiveModuleBinding"]> = (
  binding,
  useNode,
  moduleLookupAtRuntime,
  pendingInDefault,
  selectExplicitOrLocal,
): Binding | null => {
  const useStartIndex = useNode.startIndex;
  let importBinding: ImportBinding | undefined;
  let importSource: Binding | undefined;
  let localBinding: Binding | undefined;
  let latestLocalStart = -1;
  for (let candidate: Binding | undefined = binding; candidate; candidate = candidate.earlierSameScope) {
    const localStart = candidate.def?.start.index;
    const pendingFunction = candidate.kind === "function" && pendingInDefault(candidate.def?.start.index, useNode);
    if (
      !pendingFunction &&
      localStart !== undefined &&
      (moduleLookupAtRuntime || localStart <= useStartIndex) &&
      localStart > latestLocalStart
    ) {
      localBinding = candidate;
      latestLocalStart = localStart;
    }
    if (!importBinding && candidate.import) {
      importBinding = candidate.import;
      importSource = candidate;
    }
  }
  const imports = importBinding ? [importBinding] : [];
  const effective = selectExplicitOrLocal(
    imports,
    "python",
    () => true,
    localBinding?.def?.start.index,
    useStartIndex,
    moduleLookupAtRuntime,
  );
  if (effective?.kind === "local") return localBinding ?? null;
  if (effective?.kind === "explicit") return importSource ?? null;
  return null;
};
