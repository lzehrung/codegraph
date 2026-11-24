import { supportForFileWithoutHeaderSample } from "../../languages.js";
import { getImportableLanguageExtensions } from "../resolution-candidates.js";
import {
  csharpTypeNameQualifierDeclared,
  resolveCsharpDottedTypeImportPath,
  resolveCsharpNamespaceImportPaths,
} from "./csharp.js";
import type { SpecifierTargetPolicy } from "./language-policy-types.js";

export const CSHARP_SPECIFIER_POLICY: SpecifierTargetPolicy = {
  representativeBindingTarget: true,
  // A using target cannot name a file parsed by another grammar.
  acceptsFile: (file, metadata) =>
    supportForFileWithoutHeaderSample(file, metadata.languageExtensions)?.id === "csharp",
  async resolve(file, specifier, metadata, deps, policy) {
    if (specifier.includes("<") || specifier.includes(">")) {
      return { files: [], externalName: metadata.rawSpecifier ?? specifier };
    }
    const namespaceTargets = await resolveCsharpNamespaceImportPaths(
      metadata.projectRoot,
      specifier,
      file,
      metadata.languageExtensions,
      metadata.report,
      metadata.parsedFiles,
    );
    if (namespaceTargets.length) return { files: namespaceTargets, externalName: specifier };
    const typeMatch = await resolveCsharpDottedTypeImportPath(
      metadata.projectRoot,
      specifier,
      file,
      metadata.languageExtensions,
      metadata.report,
      metadata.parsedFiles,
    );
    if (typeMatch.status === "found") return { files: [typeMatch.file], externalName: specifier };
    if (typeMatch.status === "ambiguous" || typeMatch.status === "partial") {
      return { files: [], externalName: metadata.rawSpecifier ?? specifier, retainExternalEdge: true };
    }
    // A declared qualifier makes a type miss authoritative; a same-stem file cannot replace it.
    const qualifierDeclared = await csharpTypeNameQualifierDeclared(
      metadata.projectRoot,
      specifier,
      file,
      metadata.languageExtensions,
      metadata.report,
      metadata.parsedFiles,
    );
    if (qualifierDeclared) return { files: [], externalName: metadata.rawSpecifier ?? specifier };
    return deps.resolvePathFallbackTargets(file, specifier, policy, metadata);
  },
};

export const RUBY_SPECIFIER_POLICY: SpecifierTargetPolicy = {
  async resolve(file, specifier, metadata, deps, policy) {
    if (metadata.rubyLoadForm === "require_relative") {
      const relativeSpecifier = specifier.startsWith(".") ? specifier : "./" + specifier;
      const relative = await deps.resolveSpecifier(
        file,
        relativeSpecifier,
        metadata.projectRoot,
        undefined,
        undefined,
        {
          resolutionExtensions: getImportableLanguageExtensions("ruby"),
        },
      );
      return { files: typeof relative === "string" ? [relative] : [], externalName: specifier };
    }
    return deps.resolvePathFallbackTargets(file, specifier, policy, metadata);
  },
};
