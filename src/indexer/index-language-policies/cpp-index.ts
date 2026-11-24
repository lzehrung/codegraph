import { collectCppDeclaredModules, isCppNamedModuleSpecifier } from "../../util/resolution/cpp.js";
import type { PublicSurfaceHooks } from "../public-surface-types.js";
import type { ModuleIndexHooks } from "../language-hook-types.js";
import { cFamilyModule } from "./c-family-index.js";

export const cppModule: ModuleIndexHooks = {
  ...cFamilyModule,
  declaredContainers: collectCppDeclaredModules,
};

export const cppPublicSurface: PublicSurfaceHooks = {
  declarationNames(mod, support) {
    const names = new Set<string>();
    const add = (name: string): void => {
      const normalized = support.normalizeIdentifier?.(name) ?? name;
      if (normalized) names.add(normalized);
    };
    if (mod.jvmFacts) {
      const packageName = mod.jvmFacts.packageName;
      if (packageName) add(packageName);
      for (const name of mod.jvmFacts.symbols) {
        add(name);
        if (packageName) add(`${packageName}.${name}`);
      }
    } else if (mod.csharpNamespaceFacts) {
      for (const region of mod.csharpNamespaceFacts.regions) add(region.name);
      for (const name of mod.csharpNamespaceFacts.types) add(name);
    } else {
      for (const name of mod.declaredContainers ?? []) add(name);
    }
    return names;
  },
  recheck(binding) {
    if ("includeForm" in binding && binding.includeForm) return "none";
    return undefined;
  },
  acceptSpecifier: isCppNamedModuleSpecifier,
  remainingSpecifierMatches: () => false,
  resolvedBindingNamesAdded: () => false,
};
