/**
 * Swift property requirements and their witnesses. A protocol's `var title: String { get }` is satisfied by the `title`
 * each conforming type declares, so renaming one of them without the others stops the type from conforming. The
 * conformers come from source alone: the conformance clauses that name the protocol, the protocols that refine it, and
 * the class bases of a conforming class. Anything the clauses cannot place is reported as unproven, never guessed.
 */
import type { SyntaxNodeLike } from "../../languages/types.js";
import { fileIdentityKey } from "../../util/paths.js";
import { ensureParsedContextForIndex, rethrowStaleQuerySource } from "../parsed-cache.js";
import { getSharedOwnerIdentity } from "../shared-owner-identity.js";
import { isSwiftConstrainedExtension, isSwiftExtensionContainer } from "./swift-owner.js";
import { SymbolKind, type ProjectIndex, type Reference, type SymbolDef } from "../types.js";
import type { MemberLookupDeps, MemberOwnerRef, RenameCompanions } from "./types.js";

/** Bounds on the walk; a family beyond them is reported unproven rather than cut short. */
const MAX_PROTOCOLS = 32;
const MAX_TYPES = 128;
const MAX_FAMILY = 256;

type PropertyMember = { def: SymbolDef; ref: MemberOwnerRef };
type UsesOf = (def: SymbolDef) => Promise<readonly Reference[] | null>;

/** A property of the project's name: where it is declared, and whether a protocol body declares it as a requirement. */
type NamedProperty = { def: SymbolDef; owner: MemberOwnerRef | null; isRequirement: boolean };

/** Where a use of a type name sits relative to the declarations that depend on it. */
type NameUseSite =
  | { kind: "clause"; holder: MemberOwnerRef }
  | { kind: "typealias" }
  | { kind: "self-constraint"; extension: MemberOwnerRef }
  | { kind: "other" };

const ownerKey = (ref: MemberOwnerRef): string =>
  `${fileIdentityKey(ref.file)}:${ref.container.startIndex}:${ref.container.endIndex}`;
const definitionKey = (def: SymbolDef): string => `${fileIdentityKey(def.file)}:${def.range.start.index}`;
const groupKey = (group: readonly MemberOwnerRef[]): string => group.map(ownerKey).sort().join("|");
const isProtocolBody = (ref: MemberOwnerRef): boolean => ref.container.type === "protocol_declaration";

function isClassPart(ref: MemberOwnerRef): boolean {
  return (
    ref.container.type === "class_declaration" &&
    !isSwiftExtensionContainer(ref.container, ref.context.source) &&
    ref.container.childForFieldName("declaration_kind")?.text === "class"
  );
}

/** The type a declaration container names; an extension header names an existing type and declares none. */
function declaredTypeOf(ref: MemberOwnerRef): SymbolDef | null {
  const name = ref.container.childForFieldName("name");
  if (!name || name.type === "user_type") return null;
  return ref.module.locals.find((local) => local.range.start.index === name.startIndex) ?? null;
}

class PropertyFamilyWalk {
  private readonly name: string;
  private readonly targetKey: string;
  private readonly isStatic: boolean;
  /** Every declaration that must be renamed with the target, keyed by position. */
  private readonly members = new Map<string, SymbolDef>();
  private readonly unproven: string[] = [];
  /** False once the walk gave up because the family is beyond its bounds: it then lists no witness. */
  private listed = true;
  /** Conforming parts that declare no witness of their own. */
  private readonly witnessless: MemberOwnerRef[][] = [];
  /** Conforming parts whose own declaration witnesses the requirement. */
  private readonly witnessing: MemberOwnerRef[][] = [];
  private defaultCount = 0;
  /** Identity paths of every type the walk relates to the family, for the leftover scan. */
  private readonly relatedPaths = new Set<string>();
  /** Properties of the name that a walked part declares, whether or not they belong to the family. */
  private readonly reached = new Set<string>();

  constructor(
    private readonly index: ProjectIndex,
    private readonly deps: MemberLookupDeps,
    private readonly usesOf: UsesOf,
    private readonly target: SymbolDef,
    targetOwner: MemberOwnerRef,
  ) {
    this.name = target.localName;
    this.targetKey = definitionKey(target);
    this.isStatic = deps.hasStaticModifier(target, targetOwner.context, targetOwner.container);
  }

  /**
   * Every declaration but the target, and the first reason one of them could not be proven. A family beyond the walk's
   * bounds lists none: the rename is unsafe, and finding the uses of a partial list would only cost time.
   */
  result(): RenameCompanions {
    const definitions = this.listed ? [...this.members.values()] : [];
    const unprovenReason = this.unproven[0];
    return unprovenReason ? { definitions, unprovenReason } : { definitions };
  }

  fail(reason: string): void {
    if (!this.unproven.includes(reason)) this.unproven.push(reason);
  }

  /** Give up listing the family: it is beyond the walk's bounds, so the rest of the walk proves nothing. */
  private abandon(reason: string): void {
    this.fail(reason);
    this.listed = false;
  }

  /** The part a container declares together with every other part of the same type the shared members reach. */
  private async parts(ref: MemberOwnerRef): Promise<MemberOwnerRef[]> {
    const peers = await this.deps.resolveSharedOwnerContainers({
      index: this.index,
      ownerFile: ref.file,
      ownerContainer: ref.container,
      ownerSource: ref.context.source,
      languageId: "swift",
    });
    return [ref, ...peers];
  }

  /** The variables a part declares directly, never a local of one of its methods. */
  private properties(parts: readonly MemberOwnerRef[]): PropertyMember[] {
    const found: PropertyMember[] = [];
    for (const ref of parts) {
      const normalize = ref.context.sup.normalizeIdentifier;
      for (const def of this.deps.findDirectLocalsWithinNode(
        ref.module.locals,
        this.name,
        ref.container,
        ref.context,
        normalize,
      )) {
        if (def.kind !== SymbolKind.Variable || !def.isMember) continue;
        found.push({ def, ref });
        this.reached.add(definitionKey(def));
      }
    }
    return found;
  }

  private sameStaticness(member: PropertyMember): boolean {
    return this.deps.hasStaticModifier(member.def, member.ref.context, member.ref.container) === this.isStatic;
  }

  private addMember(def: SymbolDef): void {
    if (definitionKey(def) === this.targetKey) return;
    if (this.members.size >= MAX_FAMILY) this.fail("the family of declarations is too large to list");
    else this.members.set(definitionKey(def), def);
  }

  private relate(parts: readonly MemberOwnerRef[]): void {
    for (const ref of parts) {
      const identity = getSharedOwnerIdentity(ref.container, ref.context.source, "swift", ref.file);
      if (identity) this.relatedPaths.add(identity.fullPath);
    }
  }

  /** The use of a type name at `reference`, read from the syntax around it. */
  private async siteOf(reference: Reference): Promise<NameUseSite | null> {
    let context;
    try {
      context = await ensureParsedContextForIndex(this.index, reference.file);
    } catch (error) {
      rethrowStaleQuerySource(error);
      return null;
    }
    const module = this.index.byFile.get(fileIdentityKey(reference.file));
    const start = reference.range.start.index;
    if (!module || start === undefined) return null;
    const node = context.tree.rootNode.descendantForIndex(start, reference.range.end.index ?? start);
    const owner = (container: SyntaxNodeLike): MemberOwnerRef => ({ file: reference.file, context, container, module });
    for (let current: SyntaxNodeLike | null = node.parent; current; current = current.parent) {
      if (current.type === "typealias_declaration") return { kind: "typealias" };
      if (current.type === "inheritance_specifier") {
        const holder = current.parent;
        const isDeclaration = holder?.type === "class_declaration" || holder?.type === "protocol_declaration";
        return isDeclaration ? { kind: "clause", holder: owner(holder) } : { kind: "other" };
      }
      if (current.type === "inheritance_constraint") {
        let declaration: SyntaxNodeLike | null = current.parent;
        while (declaration && declaration.type !== "class_declaration") declaration = declaration.parent;
        const constrainsSelf = current.namedChildren[0]?.text === "Self";
        return constrainsSelf && declaration
          ? { kind: "self-constraint", extension: owner(declaration) }
          : { kind: "other" };
      }
      if (current.type === "class_body" || current.type === "protocol_body" || current.type === "function_body") break;
    }
    return { kind: "other" };
  }

  /** The declarations whose base clause names `typeDef`, or null (reported) when its uses are not all proven. */
  private async clauseHolders(typeDef: SymbolDef, subject: string): Promise<MemberOwnerRef[] | null> {
    const uses = await this.usesOf(typeDef);
    if (!uses) {
      this.fail(`the uses of ${subject} are not all proven`);
      return null;
    }
    const holders: MemberOwnerRef[] = [];
    for (const use of uses) {
      const site = await this.siteOf(use);
      if (!site) this.fail(`a use of ${subject} could not be read`);
      else if (site.kind === "typealias") this.fail(`a typealias names ${subject}`);
      else if (site.kind === "self-constraint") {
        // `extension Other where Self: Named` can supply a default for the requirement.
        if (this.properties([site.extension]).length)
          this.fail("a constrained protocol extension may supply a default");
      } else if (site.kind === "clause") holders.push(site.holder);
    }
    return holders;
  }

  /** Every class that inherits from `classDef`, directly or through other subclasses; `visit` receives each one's parts. */
  private async forEachSubclass(
    classDef: SymbolDef,
    seen: Set<string>,
    visit: (parts: MemberOwnerRef[]) => void | Promise<void>,
  ): Promise<void> {
    const queue: SymbolDef[] = [classDef];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      if (cursor >= MAX_TYPES) {
        this.fail("the class hierarchy is too large to list");
        return;
      }
      const holders = await this.clauseHolders(queue[cursor]!, "a class");
      for (const holder of holders ?? []) {
        if (
          holder.container.type !== "class_declaration" ||
          isSwiftExtensionContainer(holder.container, holder.context.source)
        ) {
          continue;
        }
        const parts = await this.parts(holder);
        if (seen.has(groupKey(parts))) continue;
        seen.add(groupKey(parts));
        this.relate(parts);
        await visit(parts);
        const subclass = declaredTypeOf(holder);
        if (subclass) queue.push(subclass);
      }
    }
  }

  /** Settle one conforming type: its own declaration, a default, or a reason that none is proven. */
  private async settleConformer(parts: readonly MemberOwnerRef[], seenTypes: Set<string>): Promise<void> {
    this.relate(parts);
    const nested = parts.some((ref) =>
      getSharedOwnerIdentity(ref.container, ref.context.source, "swift", ref.file)?.fullPath.includes("."),
    );
    // Uses through a nested type's qualified name are not all resolved, so its witness cannot be listed with its uses.
    if (nested) this.fail("a nested conforming type may have uses that are not resolved");
    const own = this.properties(parts).filter((member) => this.sameStaticness(member));
    if (own.some((member) => this.deps.nameNodeForDef(member.ref.context, member.def)?.parent?.type === "enum_entry")) {
      this.fail("an enum case may witness the requirement");
    } else if (own.length > 1) {
      this.fail("a conforming type declares more than one property of this name");
    } else if (own.length === 1) {
      this.addMember(own[0]!.def);
      this.witnessing.push([...parts]);
    } else {
      this.witnessless.push([...parts]);
    }
    const classPart = parts.find(isClassPart);
    const classDef = classPart ? declaredTypeOf(classPart) : null;
    // A subclass inherits the witness; one that redeclares it overrides it, which the rename would leave behind.
    if (classDef) {
      await this.forEachSubclass(classDef, seenTypes, (subclassParts) => {
        if (this.properties(subclassParts).length) {
          this.fail("a subclass of a conforming class redeclares the property");
        }
      });
    }
  }

  /**
   * Every protocol that refines the one holding the target, and every type that conforms to any of them. False when
   * the family is beyond the bounds, and the walk stopped.
   */
  async walkRequirement(protocol: MemberOwnerRef): Promise<boolean> {
    const protocols: MemberOwnerRef[] = [protocol];
    const seenProtocols = new Set<string>([ownerKey(protocol)]);
    const seenTypes = new Set<string>();
    for (let cursor = 0; cursor < protocols.length; cursor += 1) {
      if (cursor >= MAX_PROTOCOLS) {
        this.abandon("the protocols that refine it are too many to list");
        return false;
      }
      const current = protocols[cursor]!;
      const parts = await this.parts(current);
      this.relate(parts);
      // A refining protocol that repeats the requirement, or an extension that supplies a default, renames with it.
      for (const member of this.properties(parts)) {
        if (!this.sameStaticness(member)) continue;
        if (!isProtocolBody(member.ref)) this.defaultCount += 1;
        this.addMember(member.def);
      }
      const protocolDef = declaredTypeOf(current);
      const holders = protocolDef ? await this.clauseHolders(protocolDef, "the protocol") : null;
      if (!protocolDef) this.fail("the protocol is not declared by a named type");
      for (const holder of holders ?? []) {
        if (isProtocolBody(holder)) {
          if (!seenProtocols.has(ownerKey(holder))) {
            seenProtocols.add(ownerKey(holder));
            protocols.push(holder);
          }
        } else if (isSwiftConstrainedExtension(holder.container, holder.context.source)) {
          this.fail("a conditional conformance may declare a witness");
        } else {
          const holderParts = await this.parts(holder);
          if (seenTypes.has(groupKey(holderParts))) continue;
          seenTypes.add(groupKey(holderParts));
          if (seenTypes.size > MAX_TYPES) {
            this.abandon("the conforming types are too many to list");
            return false;
          }
          await this.settleConformer(holderParts, seenTypes);
        }
      }
    }
    return true;
  }

  /**
   * After the walk: a type with no witness of its own needs a default (a class inherits one instead), and a witness
   * that another protocol's requirement also needs would keep that requirement's name.
   */
  async settleConformers(): Promise<void> {
    for (const parts of this.witnessless) {
      if (parts.some(isClassPart)) this.fail("a conforming class declares no witness, so it inherits one");
      else if (!this.defaultCount)
        this.fail("a conforming type declares no witness and the protocol supplies no default");
    }
    for (const parts of this.witnessing) {
      if (await this.reachesRequirement(parts[0]!))
        this.fail("a witness also satisfies a requirement of another protocol");
    }
  }

  /** A same-named property in a part of a related type that the shared members do not reach cannot be left out. */
  scanLeftovers(everyProperty: readonly NamedProperty[]): void {
    for (const property of everyProperty) {
      const key = definitionKey(property.def);
      if (key === this.targetKey || this.reached.has(key) || !property.owner) continue;
      const { container, context, file } = property.owner;
      const identity = getSharedOwnerIdentity(container, context.source, "swift", file);
      if (identity && this.relatedPaths.has(identity.fullPath)) {
        this.fail("a part of a related type declares a property of this name that no shared member reaches");
        return;
      }
    }
  }

  /** Whether a protocol the owner's declared bases reach declares a property of this name outside the family. */
  async reachesRequirement(owner: MemberOwnerRef): Promise<boolean> {
    const queue = await this.parts(owner);
    const seen = new Set<string>(queue.map(ownerKey));
    const outsideFamily = (member: PropertyMember): boolean =>
      definitionKey(member.def) !== this.targetKey && !this.members.has(definitionKey(member.def));
    for (let cursor = 0; cursor < queue.length && cursor < MAX_TYPES; cursor += 1) {
      const current = queue[cursor]!;
      if (isProtocolBody(current) && this.properties([current]).some(outsideFamily)) return true;
      for (const base of await this.deps.baseOwnersOf(this.index, current)) {
        if (seen.has(ownerKey(base))) continue;
        seen.add(ownerKey(base));
        queue.push(base);
      }
    }
    return false;
  }

  /** Whether a subclass of the target's class conforms to a protocol that requires this property, which it inherits. */
  async subclassReachesRequirement(owner: MemberOwnerRef): Promise<boolean> {
    const classPart = isClassPart(owner) ? owner : (await this.parts(owner)).find(isClassPart);
    const classDef = classPart ? declaredTypeOf(classPart) : null;
    if (!classDef) return false;
    let reached = false;
    await this.forEachSubclass(classDef, new Set(), async (parts) => {
      if (!reached) reached = await this.reachesRequirement(parts[0]!);
    });
    return reached;
  }
}

/** Every variable of the project's name, parsed once: its owner part and whether a protocol body declares it. */
async function namedProperties(
  index: ProjectIndex,
  name: string,
  deps: MemberLookupDeps,
): Promise<readonly NamedProperty[]> {
  const found: NamedProperty[] = [];
  for (const module of index.byFile.values()) {
    const candidates = module.locals.filter(
      (local) => local.kind === SymbolKind.Variable && local.isMember && local.localName === name,
    );
    if (!candidates.length) continue;
    let context;
    try {
      context = await ensureParsedContextForIndex(index, module.file);
    } catch (error) {
      rethrowStaleQuerySource(error);
      continue;
    }
    if (context.sup.id !== "swift") continue;
    for (const def of candidates) {
      const nameNode = deps.nameNodeForDef(context, def);
      const container = nameNode ? deps.nearestMemberContainer(nameNode) : null;
      const owner = container ? { file: module.file, context, container, module } : null;
      const isRequirement = nameNode?.parent?.parent?.type === "protocol_property_declaration";
      found.push({ def, owner, isRequirement });
    }
  }
  return found;
}

/**
 * The declarations a rename of the Swift property `target` must rename with it. A requirement brings the witnesses of
 * every conformer the clauses prove; a witness or default whose protocols declare the requirement is unproven, because
 * renaming it alone breaks the conformance. Every other property renames alone, and costs only a scan of the project's
 * same-named properties.
 */
export async function swiftPropertyRenameCompanions(args: {
  index: ProjectIndex;
  target: SymbolDef;
  deps: MemberLookupDeps;
  usesOf: UsesOf;
}): Promise<RenameCompanions | undefined> {
  const { index, target, deps, usesOf } = args;
  if (target.kind !== SymbolKind.Variable || !target.isMember) return undefined;
  const everyProperty = await namedProperties(index, target.localName, deps);
  if (!everyProperty.some((property) => property.isRequirement)) return undefined;
  const targetKey = definitionKey(target);
  const own = everyProperty.find((property) => definitionKey(property.def) === targetKey);
  if (!own?.owner) return undefined;
  const walk = new PropertyFamilyWalk(index, deps, usesOf, target, own.owner);
  if (own.isRequirement) {
    if (await walk.reachesRequirement(own.owner)) walk.fail("a refined protocol declares the same requirement");
    if (await walk.walkRequirement(own.owner)) {
      await walk.settleConformers();
      walk.scanLeftovers(everyProperty);
    }
    return walk.result();
  }
  if ((await walk.reachesRequirement(own.owner)) || (await walk.subclassReachesRequirement(own.owner))) {
    walk.fail("the declaration witnesses or defaults a protocol requirement of this name");
    return walk.result();
  }
  return undefined;
}
