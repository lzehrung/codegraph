import type { SyntaxNodeLike } from "../languages/types.js";
import type { ProjectIndex } from "./types.js";
import { SHARED_OWNER_RULES } from "./member-lookup-policies/owner-identity.js";
import type { SharedOwnerIdentity } from "./member-lookup-policies/owner-identity-types.js";
/**
 * `file` is the declaring file path. It is required to scope C# `file` owners and must be the
 * same spelling for every part of one file (callers pass the module or peer file).
 */
export function getSharedOwnerIdentity(
  container: SyntaxNodeLike,
  source: string,
  languageId: string,
  file: string,
): SharedOwnerIdentity | null {
  return SHARED_OWNER_RULES[languageId]?.identity(container, source, file) ?? null;
}

/** The first owner can access members of the second owner without proving Swift constraints. */
export function sharedOwnerCanUseMembers(left: SharedOwnerIdentity, right: SharedOwnerIdentity): boolean {
  return (
    left.languageId === right.languageId &&
    left.fullPath === right.fullPath &&
    (left.declarationKind ?? "") === (right.declarationKind ?? "") &&
    (left.genericArity ?? 0) === (right.genericArity ?? 0) &&
    (left.fileLocalTo ?? "") === (right.fileLocalTo ?? "") &&
    (right.swiftConstraint === undefined || left.swiftConstraint === right.swiftConstraint)
  );
}

/** A container's owner identity, and what decides whether two parts of one owner share members. */
export type SharedOwnerFacts = {
  identity: SharedOwnerIdentity | null;
  /** The container is a Swift extension. */
  isExtension: boolean;
  /** Parts share members only when one of them is an extension (Swift); C# parts are always one type. */
  requiresExtension: boolean;
};

// A cached extension identity depends only on its container in this index's syntax tree.

const swiftOwnerFacts = new WeakMap<ProjectIndex, WeakMap<SyntaxNodeLike, SharedOwnerFacts>>();

/**
 * The owner identity of `container`. A Swift owner's path and constraints depend only on that container in this
 * index's syntax tree, so they are read once per index instead of at every call site.
 */
export function getSharedOwnerFacts(
  index: ProjectIndex,
  container: SyntaxNodeLike,
  source: string,
  languageId: string,
  file: string,
): SharedOwnerFacts {
  const isExtensionContainer = SHARED_OWNER_RULES[languageId]?.isExtension;
  if (!isExtensionContainer) {
    return {
      identity: getSharedOwnerIdentity(container, source, languageId, file),
      isExtension: false,
      requiresExtension: false,
    };
  }
  let cache = swiftOwnerFacts.get(index);
  if (!cache) {
    cache = new WeakMap();
    swiftOwnerFacts.set(index, cache);
  }
  let facts = cache.get(container);
  if (!facts) {
    facts = {
      identity: getSharedOwnerIdentity(container, source, languageId, file),
      isExtension: isExtensionContainer(container, source),
      requiresExtension: true,
    };
    cache.set(container, facts);
  }
  return facts;
}

/** Whether two parts of one owner share members: a Swift pair needs an extension. */
export function sharedOwnerPartsShareMembers(owner: SharedOwnerFacts, peer: SharedOwnerFacts): boolean {
  return !owner.requiresExtension || owner.isExtension || peer.isExtension;
}
