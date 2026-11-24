import { foldPhpIdentifierCase } from "../../util/identifiers.js";
import { phpConstructorPromotedVariable, phpPropertyPromotionParameter } from "../navigation-php.js";
import type { DeclarationHooks } from "../language-hook-types.js";
import { PHP_INCOMPLETE_DECLARATION_IDENTITY } from "../php-namespace-symbols.js";
import { emptyDeclarationNameChanges, type PublicSurfaceHooks } from "../public-surface-types.js";
import type { ModuleIndex } from "../types.js";

export const phpDeclarations: DeclarationHooks = {
  promotedProperties: { parameter: phpPropertyPromotionParameter, variable: phpConstructorPromotedVariable },
};

/** A role-free PHP declaration identity, folded like a specifier. */
function identityName(identity: string): string {
  if (identity === PHP_INCOMPLETE_DECLARATION_IDENTITY) return identity;
  return foldPhpIdentifierCase(identity.slice(identity.indexOf(":") + 1));
}

/** A module's declarations, including incomplete parser evidence. */
function declarationIdentities(mod: ModuleIndex | undefined): Set<string> {
  const identities = new Set(mod?.phpDeclarationNames);
  if (mod?.parserDegraded || mod?.parseErrorRanges?.length) identities.add(PHP_INCOMPLETE_DECLARATION_IDENTITY);
  return identities;
}

/** The directly containing namespace of each class, function, or constant. */
function declaredPackages(identities: ReadonlySet<string>): Set<string> {
  const packages = new Set<string>();
  for (const identity of identities) {
    if (identity === PHP_INCOMPLETE_DECLARATION_IDENTITY || identity.startsWith("namespace:")) continue;
    const qualified = identity.slice(identity.indexOf(":") + 1);
    const separator = qualified.lastIndexOf("\\");
    if (separator > 0) packages.add(foldPhpIdentifierCase(qualified.slice(0, separator)));
  }
  return packages;
}

export const phpPublicSurface: PublicSurfaceHooks = {
  nameSeparator: "\\",
  normalizeImportName(name, support) {
    const normalized = support.normalizeIdentifier?.(name) ?? name;
    return foldPhpIdentifierCase(normalized).replace(/^\\+/u, "");
  },
  declarationNames(mod) {
    if (!mod.phpDeclarationNames) return undefined;
    const identities = declarationIdentities(mod);
    const names = new Set(Array.from(identities, identityName));
    for (const name of declaredPackages(identities)) names.add(name);
    return names;
  },
  declarationNameChanges(previous, current) {
    if (!current.phpDeclarationNames) return undefined;
    const before = declarationIdentities(previous);
    const after = declarationIdentities(current);
    const changes = emptyDeclarationNameChanges();
    const { added, removed } = changes;
    for (const identity of after) if (!before.has(identity)) added.add(identityName(identity));
    for (const identity of before) if (!after.has(identity)) removed.add(identityName(identity));
    const packagesBefore = declaredPackages(before);
    const packagesAfter = declaredPackages(after);
    for (const name of packagesAfter) if (!packagesBefore.has(name)) added.add(name);
    for (const name of packagesBefore) if (!packagesAfter.has(name)) removed.add(name);
    return added.size || removed.size ? changes : null;
  },
  remainingSpecifierMatches(specifier, names) {
    const separator = specifier.lastIndexOf("\\");
    if (names.has(specifier.slice(separator + 1))) return true;
    return separator >= 0 && names.has(specifier.slice(0, separator));
  },
  resolvedBindingNamesAdded(specifier, names) {
    return names.has(specifier.slice(specifier.lastIndexOf("\\") + 1));
  },
  declarationCertaintyChanged(changes) {
    return (
      changes.added.has(PHP_INCOMPLETE_DECLARATION_IDENTITY) || changes.removed.has(PHP_INCOMPLETE_DECLARATION_IDENTITY)
    );
  },
};
