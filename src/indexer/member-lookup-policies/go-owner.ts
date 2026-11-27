/**
 * Go receiver members: the methods a package declares on a type in any of its files, and the members of the types the
 * type embeds. This module imports no navigation module: those import the policy registry, so the helpers it needs
 * arrive as `deps`.
 */
import { unwrapNamedType } from "../../graphs/symbol-graph-detailed/receiver-calls.js";
import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import { fileIdentityKey } from "../../util/paths.js";
import { getCompilationUnitPeers } from "../compilation-units.js";
import { selectMember, type MemberModel } from "../member-selection.js";
import type { ParsedFileContext } from "../parse-context.js";
import { ensureParsedContextForIndex } from "../parsed-cache.js";
import { definitionIdentityKey } from "../reference-context.js";
import { findLocalsWithinNode, RECEIVER_HIERARCHY_DEPTH } from "../shared.js";
import type { ModuleIndex, ProjectIndex, SymbolDef } from "../types.js";
import type { OwnerHooks } from "./types.js";

function goMethodReceiverTypeName(methodNode: SyntaxNodeLike, source: string, sup: LanguageSupport): string | null {
  const receiver = methodNode.childForFieldName("receiver");
  if (!receiver) return null;
  const parameter =
    receiver.namedChildren.find((child) => child.type === "parameter_declaration") ?? receiver.namedChildren[0] ?? null;
  const typeNode = parameter?.childForFieldName("type") ?? null;
  if (!typeNode) return null;
  const named = unwrapNamedType(typeNode, sup);
  return named ? sliceText(named, source) : null;
}

function goTypeSpecNamed(
  root: SyntaxNodeLike,
  typeName: string,
  source: string,
  normalizeIdentifier: (name: string) => string,
): SyntaxNodeLike | null {
  const normalized = normalizeIdentifier(typeName);
  let found: SyntaxNodeLike | null = null;
  const visit = (node: SyntaxNodeLike): boolean => {
    if (node.type === "type_spec") {
      const name = node.childForFieldName("name");
      if (name && normalizeIdentifier(sliceText(name, source)) === normalized) {
        found = node;
        return false;
      }
    }
    for (const child of node.namedChildren) {
      if (!visit(child)) return false;
    }
    return true;
  };
  visit(root);
  return found;
}

/** The names of the types that the Go type `typeName`, declared in `targetContext`, embeds as nameless fields. */
export function goEmbeddedTypeNames(
  typeName: string,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
): string[] {
  const spec = goTypeSpecNamed(targetContext.tree.rootNode, typeName, targetContext.source, normalizeIdentifier);
  if (!spec) return [];
  const typeNode = spec.childForFieldName("type");
  if (!typeNode) return [];
  const names: string[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "field_declaration") {
      if (node.childForFieldName("name")) return;
      const fieldType = node.childForFieldName("type");
      const named = fieldType ? unwrapNamedType(fieldType, targetContext.sup) : null;
      if (named) names.push(sliceText(named, targetContext.source));
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(typeNode);
  return names;
}

function goMethodsNamedOnType(
  locals: readonly SymbolDef[],
  member: string,
  typeName: string,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
): SymbolDef[] {
  const matches: SymbolDef[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "method_declaration") {
      const receiverType = goMethodReceiverTypeName(node, targetContext.source, targetContext.sup);
      if (receiverType && normalizeIdentifier(receiverType) === normalizeIdentifier(typeName)) {
        for (const local of findLocalsWithinNode(locals, member, node, normalizeIdentifier)) {
          if (!matches.includes(local)) matches.push(local);
        }
      }
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(targetContext.tree.rootNode);
  return matches;
}

/** One file of a Go package, with its parsed syntax; a peer file of another language declares no Go member. */
async function goPackageFile(
  index: ProjectIndex,
  file: string,
): Promise<{ module: ModuleIndex; context: ParsedFileContext } | null> {
  const module = index.byFile.get(fileIdentityKey(file));
  if (!module) return null;
  const context = await ensureParsedContextForIndex(index, file);
  return context.sup.id === "go" ? { module, context } : null;
}

/** The method or embedded member `member` of the Go type `receiverDef`, across the files of its package. */
export const selectGoReceiverMember: NonNullable<OwnerHooks["receiverMembers"]> = async (
  index,
  receiverDef,
  member,
  receiverContext,
  _locals,
  _normalizeIdentifier,
  knownArgumentCount,
  deps,
) => {
  const normalizeIdentifier = receiverContext.sup.normalizeIdentifier;
  const peers = getCompilationUnitPeers(index, receiverDef.file).files;
  const files = await Promise.all([...peers].map((file) => goPackageFile(index, file)));
  const contexts = files.filter((file) => file !== null);
  const members = new Map<string, SymbolDef[]>();
  const embedded = new Map<string, string[]>();
  const seen = new Set<string>();
  let level = [receiverDef.localName];
  for (let depth = 0; depth < RECEIVER_HIERARCHY_DEPTH && level.length; depth += 1) {
    const next: string[] = [];
    for (const typeName of level) {
      if (seen.has(typeName)) continue;
      seen.add(typeName);
      const matches: SymbolDef[] = [];
      const bases: string[] = [];
      for (const { module, context } of contexts) {
        const normalize = context.sup.normalizeIdentifier;
        matches.push(...goMethodsNamedOnType(module.locals, member, typeName, context, normalize));
        const spec = goTypeSpecNamed(context.tree.rootNode, typeName, context.source, normalize);
        if (!spec) continue;
        matches.push(
          ...deps
            .findDirectLocalsWithinNode(module.locals, member, spec, context, normalize)
            .filter((def) => def.isMember),
        );
        for (const base of goEmbeddedTypeNames(typeName, context, normalize)) {
          if (!bases.includes(base)) bases.push(base);
          if (!seen.has(base) && !next.includes(base)) next.push(base);
        }
      }
      members.set(typeName, matches);
      embedded.set(typeName, bases);
    }
    level = next;
  }
  const model: MemberModel<string, SymbolDef> = {
    ownerKey: (owner) => owner,
    members: (owner) => members.get(owner) ?? [],
    supertypes: (owner) => embedded.get(owner) ?? [],
    name: (def) => normalizeIdentifier(def.localName),
    key: (def) => def.callable?.key ?? definitionIdentityKey(def),
    callable: (def) => def.callable,
    scope: () => "any",
    visible: () => true,
  };
  const selected = selectMember([receiverDef.localName], model, {
    name: normalizeIdentifier(member),
    argumentCount: knownArgumentCount ?? null,
    scope: "any",
    useFile: receiverDef.file,
    keepUniqueArityMismatch: true,
  });
  return selected.status === "unique" ? selected.member : undefined;
};
