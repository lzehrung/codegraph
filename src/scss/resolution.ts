import path from "node:path";
import { ensureParsedContext } from "../indexer/parse-context.js";
import type { ModuleIndex, ProjectIndex, SymbolDef } from "../indexer/types.js";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import { isNativeRequiredUnavailableError } from "../native/runtime.js";
import type { FileId, Range } from "../types.js";
import { fileIdentityKey } from "../util/paths.js";
import {
  extractScssFacts,
  isSassBuiltinUrl,
  memberEditSpan,
  moduleStem,
  sassBare,
  sassCanonical,
  SCSS_LANGUAGE_ID,
  scssOffsetAt,
  scssOffsetRange,
  type ScssFileFacts,
  type ScssLocalBinding,
  type ScssMemberKind,
  type ScssModuleLoad,
  type ScssUse,
} from "./syntax.js";

/**
 * The one place that decides what an SCSS module member names. `goToDefinition`,
 * `findReferences`, and rename preview all resolve sites here.
 *
 * URLs use the indexed stylesheet edges (and the import bindings those edges share).
 * `sass:` modules stay external. A name declared more than once in the visible set
 * resolves to nothing, except a variable that one file assigns again: that is one variable.
 */

export type ScssNotFound = { status: "not_found"; reason: string; unproven?: true };

export type ScssResolution =
  | { status: "ok"; def: SymbolDef; prefix: string }
  | { status: "shadow"; range: Range }
  | ScssNotFound;

/** A top-level declaration, as the index and the navigation consumers see it. */
export type ScssDeclaredMember = {
  kind: ScssMemberKind;
  /** Canonical declared name. */
  declared: string;
  /** First declaration of the member. A variable assigned again in the file keeps the first one. */
  def: SymbolDef;
  /** Every declaration site of the member, `def` first. */
  sites: readonly SymbolDef[];
};

type LoadTarget = { type: "file"; file: FileId } | { type: "builtin" } | { type: "unresolved" };

type ResolvedLoad = { load: ScssModuleLoad; target: LoadTarget };

type OwnMember = {
  kind: Exclude<ScssMemberKind, "placeholder">;
  declared: string;
  def: SymbolDef;
  sites: SymbolDef[];
  isDefault: boolean;
};

type PlaceholderDeclaration = { def: SymbolDef; declared: string };

type ModuleModel = {
  file: FileId;
  key: string;
  facts: ScssFileFacts;
  loads: ResolvedLoad[];
  own: OwnMember[];
  ownByName: Map<string, OwnMember[]>;
  placeholders: PlaceholderDeclaration[];
  localsByName: Map<string, ScssLocalBinding[]>;
  defAt: Map<string, SymbolDef>;
  /** Stems of the load URLs that did not resolve. */
  unresolvedStems: Set<string>;
  /** Stems `meta.load-css` names; null stands for a URL that is not a string literal. */
  dynamicStems: Set<string | null>;
};

type ProjectModel = {
  files: Map<string, ModuleModel>;
  /** Files that load a file directly, by the key of the loaded file. */
  reverse: Map<string, FileId[]>;
  exposures: Map<string, Exposure>;
  /** Files that are not SCSS but import a stylesheet URL that did not resolve, by stem. */
  hostsByStem: Map<string, FileId[]>;
  /** Files that are not SCSS but import a file, by the key of the imported file. */
  hostsByTarget: Map<string, FileId[]>;
};

/** A member as one module exposes it. A forward prefix changes `exposed`, never `def`. */
type Member = {
  kind: Exclude<ScssMemberKind, "placeholder">;
  /** Canonical name the module exposes: forward prefix plus declared name. */
  exposed: string;
  /** Forward prefix in source spelling; empty when no forward renamed the member. */
  prefix: string;
  def: SymbolDef;
  sites: readonly SymbolDef[];
  isDefault: boolean;
};

type Exposure = {
  members: Member[];
  byName: Map<string, Member[]>;
  /** A load that could add members did not resolve, or a loaded file could not be read. */
  incomplete: boolean;
};

/** How a file is loaded: `@use` and `@forward` expose a module, `@import` merges global scope. */
type LoadMode = "module" | "import";

type Walk = { trail: Set<string>; cuts: number };

const HOST_EXTENSIONS = [".vue", ".svelte"];

const factsByModule = new WeakMap<ModuleIndex, Promise<ScssFileFacts | null>>();
const projects = new WeakMap<ProjectIndex, Promise<ProjectModel>>();

export function isScssFile(index: ProjectIndex, file: FileId): boolean {
  return supportForFileWithoutHeaderSample(file, index.languageExtensions)?.id === SCSS_LANGUAGE_ID;
}

async function computeFacts(index: ProjectIndex, module: ModuleIndex): Promise<ScssFileFacts | null> {
  try {
    const parsed = await ensureParsedContext(
      module.file,
      index.parsed?.get(fileIdentityKey(module.file)),
      index.languageExtensions,
    );
    if (parsed.sup.id !== SCSS_LANGUAGE_ID) return null;
    return extractScssFacts(parsed.source);
  } catch (error) {
    if (isNativeRequiredUnavailableError(error)) throw error;
    return null;
  }
}

/** Declarations, loads, and uses of one indexed SCSS file, or null when it cannot be read. */
export function scssFactsForFile(index: ProjectIndex, file: FileId): Promise<ScssFileFacts | null> {
  const module = index.byFile.get(fileIdentityKey(file));
  if (!module || !isScssFile(index, module.file)) return Promise.resolve(null);
  let facts = factsByModule.get(module);
  if (!facts) {
    facts = computeFacts(index, module);
    factsByModule.set(module, facts);
  }
  return facts;
}

function defKey(line: number, column: number, canonical: string): string {
  return `${line}:${column}:${canonical}`;
}

function isPrivateName(canonical: string): boolean {
  return canonical.startsWith("-");
}

function appendTo<T>(table: Map<string, T[]>, key: string, value: T): void {
  const existing = table.get(key);
  if (existing) existing.push(value);
  else table.set(key, [value]);
}

function hasHostExtension(file: FileId): boolean {
  const lower = file.toLowerCase();
  return HOST_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Where each stylesheet URL of an SCSS file points, by `fileKey NUL url`. One pass over the graph
 * edges replaces a scan of every edge for every load.
 */
function stylesheetTargets(index: ProjectIndex, scssKeys: ReadonlySet<string>): Map<string, FileId> {
  const targets = new Map<string, FileId>();
  for (const edge of index.graph.edges) {
    if (edge.to.type !== "file") continue;
    const key = fileIdentityKey(edge.from);
    if (!scssKeys.has(key)) continue;
    const entry = `${key}\0${edge.raw}`;
    if (!targets.has(entry)) targets.set(entry, edge.to.path);
  }
  return targets;
}

/**
 * Vue and Svelte files import stylesheets from `<style>` blocks that SCSS navigation does not
 * read. Their imports are kept by target when a resolver proved one and by stem when not.
 */
function hostImports(index: ProjectIndex): {
  byStem: Map<string, FileId[]>;
  byTarget: Map<string, FileId[]>;
} {
  const byStem = new Map<string, FileId[]>();
  const byTarget = new Map<string, FileId[]>();
  const add = (table: Map<string, FileId[]>, key: string, host: FileId): void => {
    const files = table.get(key);
    if (!files) table.set(key, [host]);
    else if (!files.includes(host)) files.push(host);
  };
  for (const edge of index.graph.edges) {
    if (!hasHostExtension(edge.from)) continue;
    if (edge.to.type === "file") add(byTarget, fileIdentityKey(edge.to.path), edge.from);
    else add(byStem, moduleStem(edge.raw), edge.from);
  }
  return { byStem, byTarget };
}

function loadTarget(
  targets: ReadonlyMap<string, FileId>,
  importTargets: ReadonlyMap<string, FileId>,
  key: string,
  url: string,
): LoadTarget {
  const trimmed = url.trim();
  if (isSassBuiltinUrl(trimmed)) return { type: "builtin" };
  const edge = targets.get(`${key}\0${trimmed}`) ?? importTargets.get(trimmed);
  if (edge) return { type: "file", file: edge };
  return { type: "unresolved" };
}

function buildOwnMembers(
  facts: ScssFileFacts,
  defAt: ReadonlyMap<string, SymbolDef>,
): { own: OwnMember[]; ownByName: Map<string, OwnMember[]>; placeholders: PlaceholderDeclaration[] } {
  const own: OwnMember[] = [];
  const ownByName = new Map<string, OwnMember[]>();
  const variables = new Map<string, OwnMember>();
  const placeholders: PlaceholderDeclaration[] = [];
  for (const declaration of facts.declarations) {
    if (!declaration.topLevel) continue;
    const def = defAt.get(defKey(declaration.range.start.line, declaration.range.start.column, declaration.canonical));
    if (!def) continue;
    if (declaration.kind === "placeholder") {
      placeholders.push({ def, declared: declaration.canonical });
      continue;
    }
    const name = `${declaration.kind}:${declaration.canonical}`;
    const assignedBefore = declaration.kind === "variable" ? variables.get(name) : undefined;
    if (assignedBefore) {
      // One file assigning a variable again is still one variable.
      assignedBefore.sites.push(def);
      continue;
    }
    const member: OwnMember = {
      kind: declaration.kind,
      declared: declaration.canonical,
      def,
      sites: [def],
      isDefault: declaration.isDefault,
    };
    if (declaration.kind === "variable") variables.set(name, member);
    own.push(member);
    appendTo(ownByName, name, member);
  }
  return { own, ownByName, placeholders };
}

async function buildProjectModel(index: ProjectIndex): Promise<ProjectModel> {
  const scssModules: { module: ModuleIndex; facts: ScssFileFacts }[] = [];
  const scssKeys = new Set<string>();
  for (const module of index.byFile.values()) {
    if (!isScssFile(index, module.file)) continue;
    const facts = await scssFactsForFile(index, module.file);
    if (!facts) continue;
    scssModules.push({ module, facts });
    scssKeys.add(fileIdentityKey(module.file));
  }
  const targets = stylesheetTargets(index, scssKeys);
  const files = new Map<string, ModuleModel>();
  const reverse = new Map<string, FileId[]>();
  for (const { module, facts } of scssModules) {
    const key = fileIdentityKey(module.file);
    const importTargets = new Map<string, FileId>();
    const defAt = new Map<string, SymbolDef>();
    for (const binding of module.imports) {
      if (typeof binding.resolved === "string" && !importTargets.has(binding.from)) {
        importTargets.set(binding.from, binding.resolved);
      }
    }
    for (const local of module.locals) {
      const at = defKey(local.range.start.line, local.range.start.column, sassCanonical(local.localName));
      if (!defAt.has(at)) defAt.set(at, local);
    }
    const loads = facts.loads.map((load) => ({ load, target: loadTarget(targets, importTargets, key, load.url) }));
    const unresolvedStems = new Set<string>();
    for (const resolved of loads) {
      if (resolved.target.type === "file") {
        appendTo(reverse, fileIdentityKey(resolved.target.file), module.file);
      } else if (resolved.target.type === "unresolved") {
        unresolvedStems.add(moduleStem(resolved.load.url));
      }
    }
    const dynamicStems = new Set<string | null>();
    for (const dynamic of facts.dynamics) {
      if (dynamic.form === "load-css") dynamicStems.add(dynamic.arg === null ? null : moduleStem(dynamic.arg));
    }
    const localsByName = new Map<string, ScssLocalBinding[]>();
    for (const local of facts.locals) appendTo(localsByName, local.canonical, local);
    const { own, ownByName, placeholders } = buildOwnMembers(facts, defAt);
    files.set(key, {
      file: module.file,
      key,
      facts,
      loads,
      own,
      ownByName,
      placeholders,
      localsByName,
      defAt,
      unresolvedStems,
      dynamicStems,
    });
  }
  const hosts = hostImports(index);
  return { files, reverse, exposures: new Map(), hostsByStem: hosts.byStem, hostsByTarget: hosts.byTarget };
}

function projectModel(index: ProjectIndex): Promise<ProjectModel> {
  let pending = projects.get(index);
  if (!pending) {
    pending = buildProjectModel(index);
    projects.set(index, pending);
  }
  return pending;
}

function ownAsMember(member: OwnMember): Member {
  return {
    kind: member.kind,
    exposed: member.declared,
    prefix: "",
    def: member.def,
    sites: member.sites,
    isDefault: member.isDefault,
  };
}

function withPrefix(member: Member, prefix: string): Member {
  if (!prefix) return member;
  return { ...member, exposed: sassCanonical(prefix) + member.exposed, prefix: prefix + member.prefix };
}

function listMatches(
  list: readonly { name: string; kind: "variable" | "callable" }[],
  member: Member,
  exposed: string,
) {
  return list.some((entry) => {
    const wantsVariable = entry.kind === "variable";
    if (wantsVariable !== (member.kind === "variable")) return false;
    return sassCanonical(entry.name) === exposed;
  });
}

/**
 * `show` and `hide` list the names a forward exposes, so they compare against the prefixed
 * spelling. A bare name selects mixins and functions, a `$name` selects variables.
 */
function passesFilter(member: Member, load: ScssModuleLoad): boolean {
  const exposed = sassCanonical(load.prefix) + member.exposed;
  if (load.show && !listMatches(load.show, member, exposed)) return false;
  if (load.hide && listMatches(load.hide, member, exposed)) return false;
  return true;
}

function finishExposure(members: Member[], incomplete: boolean): Exposure {
  const byName = new Map<string, Member[]>();
  for (const member of members) appendTo(byName, `${member.kind}:${member.exposed}`, member);
  return { members, byName, incomplete };
}

/**
 * Members `file` shows to a consumer. A `module` consumer (`@use`, `@forward`) sees the public
 * declarations, the forwarded modules, and what the file `@import`s. An `@import` consumer sees
 * private declarations too, because `@import` has no privacy. `@use` never passes members on.
 * Results are cached unless a cycle cut the walk short.
 */
function exposureOf(model: ProjectModel, key: string, mode: LoadMode, walk: Walk): Exposure {
  const cacheKey = `${mode}:${key}`;
  const cached = model.exposures.get(cacheKey);
  if (cached) return cached;
  const current = model.files.get(key);
  if (!current) return finishExposure([], true);
  if (walk.trail.has(key)) {
    walk.cuts += 1;
    return finishExposure([], false);
  }
  const cutsBefore = walk.cuts;
  walk.trail.add(key);
  const members: Member[] = [];
  let incomplete = false;
  for (const member of current.own) {
    if (mode === "module" && isPrivateName(member.declared)) continue;
    members.push(ownAsMember(member));
  }
  for (const resolved of current.loads) {
    const { load, target } = resolved;
    if (load.kind === "use") continue;
    if (target.type === "unresolved") incomplete = true;
    if (target.type !== "file") continue;
    const forwarded = load.kind === "forward";
    const inner = exposureOf(model, fileIdentityKey(target.file), forwarded ? "module" : "import", walk);
    if (inner.incomplete) incomplete = true;
    for (const member of inner.members) {
      if (forwarded) {
        if (passesFilter(member, load)) members.push(withPrefix(member, load.prefix));
      } else if (mode === "import" || !isPrivateName(member.exposed)) {
        members.push(member);
      }
    }
  }
  walk.trail.delete(key);
  const exposure = finishExposure(members, incomplete);
  if (walk.cuts === cutsBefore) model.exposures.set(cacheKey, exposure);
  return exposure;
}

function newWalk(): Walk {
  return { trail: new Set<string>(), cuts: 0 };
}

function kindMatches(member: ScssMemberKind, use: ScssUse["kind"]): boolean {
  if (use === "callable") return member === "mixin" || member === "function";
  return member === use;
}

/**
 * Cheap test before a use is resolved: it can name the member only when the kind agrees and the
 * spelling ends with the declared name, because a forward prefix only adds text in front.
 */
export function scssUseMayNameMember(use: ScssUse, member: ScssDeclaredMember): boolean {
  return kindMatches(member.kind, use.kind) && use.canonical.endsWith(member.declared);
}

function lookup(table: ReadonlyMap<string, readonly Member[]>, kind: ScssUse["kind"], canonical: string): Member[] {
  if (kind === "callable") {
    return [...(table.get(`mixin:${canonical}`) ?? []), ...(table.get(`function:${canonical}`) ?? [])];
  }
  return [...(table.get(`${kind}:${canonical}`) ?? [])];
}

function uniqueMembers(members: readonly Member[]): Member[] {
  const seen = new Set<SymbolDef>();
  const unique: Member[] = [];
  for (const member of members) {
    if (seen.has(member.def)) continue;
    seen.add(member.def);
    unique.push(member);
  }
  return unique;
}

function choose(
  members: readonly Member[],
  ambiguousReason: string,
  emptyReason: string,
  incomplete: boolean,
): ScssResolution {
  const [first, ...rest] = uniqueMembers(members);
  if (!first) {
    if (!incomplete) return { status: "not_found", reason: emptyReason };
    return { status: "not_found", reason: `${emptyReason}; a loaded module did not resolve`, unproven: true };
  }
  if (rest.length) return { status: "not_found", reason: ambiguousReason, unproven: true };
  return { status: "ok", def: first.def, prefix: first.prefix };
}

function unresolvedIntroducesMembers(loads: readonly ResolvedLoad[]): boolean {
  return loads.some((resolved) => {
    if (resolved.target.type !== "unresolved") return false;
    return resolved.load.kind === "import" || (resolved.load.kind === "use" && resolved.load.star);
  });
}

function localShadowing(current: ModuleModel, use: ScssUse): ScssLocalBinding | undefined {
  if (use.kind !== "variable") return undefined;
  return current.localsByName
    .get(use.canonical)
    ?.find((local) => use.nameStart >= local.from && use.nameStart < local.to);
}

function resolveLoadName(model: ProjectModel, current: ModuleModel, use: ScssUse): ScssResolution {
  const resolved = use.loadIndex === null ? undefined : current.loads[use.loadIndex];
  if (!resolved) return { status: "not_found", reason: "SCSS module load is missing" };
  const { load, target } = resolved;
  if (target.type === "builtin") return { status: "not_found", reason: "Built-in Sass module" };
  if (target.type === "unresolved") {
    return { status: "not_found", reason: `Module URL ${load.url} did not resolve`, unproven: true };
  }
  const inner = exposureOf(model, fileIdentityKey(target.file), "module", newWalk());
  const written = sassCanonical(use.text);
  const isConfig = use.syntax === "config";
  // `show` and `hide` spell the names this forward exposes; `with` spells the names the target exposes.
  const loadPrefix = isConfig ? "" : sassCanonical(load.prefix);
  const matches = inner.members.filter((member) => {
    if (!kindMatches(member.kind, use.kind) || loadPrefix + member.exposed !== written) return false;
    return !isConfig || member.isDefault;
  });
  const choice = choose(
    matches,
    `More than one SCSS member matches ${use.text}`,
    `No SCSS member matches ${use.text}`,
    inner.incomplete,
  );
  if (choice.status !== "ok") return choice;
  return { ...choice, prefix: isConfig ? choice.prefix : load.prefix + choice.prefix };
}

function resolveNamespaced(model: ProjectModel, current: ModuleModel, use: ScssUse, namespace: string): ScssResolution {
  // Sass compares namespaces as written: `my-lib` and `my_lib` are different namespaces.
  const namespaces = current.loads.filter(
    (resolved) => resolved.load.kind === "use" && resolved.load.namespace === namespace,
  );
  if (namespaces.length > 1) {
    return { status: "not_found", reason: `SCSS namespace ${namespace} is declared more than once`, unproven: true };
  }
  const found = namespaces[0];
  if (!found) return { status: "not_found", reason: `No SCSS namespace ${namespace}` };
  if (found.target.type === "builtin") return { status: "not_found", reason: "Built-in Sass module" };
  if (found.target.type === "unresolved") {
    return { status: "not_found", reason: `Module URL ${found.load.url} did not resolve`, unproven: true };
  }
  const inner = exposureOf(model, fileIdentityKey(found.target.file), "module", newWalk());
  return choose(
    lookup(inner.byName, use.kind, use.canonical),
    `More than one SCSS member matches ${namespace}.${use.text}`,
    `No SCSS member matches ${namespace}.${use.text}`,
    inner.incomplete,
  );
}

function resolveUnnamespaced(model: ProjectModel, current: ModuleModel, use: ScssUse): ScssResolution {
  const shadow = localShadowing(current, use);
  if (shadow) return { status: "shadow", range: shadow.range };
  const own = current.ownByName.get(`${use.kind}:${use.canonical}`) ?? [];
  if (own.length > 1) {
    return { status: "not_found", reason: `More than one SCSS member matches ${use.text}`, unproven: true };
  }
  const [only] = own;
  if (only) return { status: "ok", def: only.def, prefix: "" };
  if (unresolvedIntroducesMembers(current.loads)) {
    return { status: "not_found", reason: "An unresolved SCSS import may also define this name", unproven: true };
  }
  const imported: Member[] = [];
  let incomplete = false;
  for (const resolved of current.loads) {
    if (resolved.target.type !== "file") continue;
    const star = resolved.load.kind === "use" && resolved.load.star;
    const legacy = resolved.load.kind === "import";
    if (!star && !legacy) continue;
    const inner = exposureOf(model, fileIdentityKey(resolved.target.file), legacy ? "import" : "module", newWalk());
    if (inner.incomplete) incomplete = true;
    imported.push(...lookup(inner.byName, use.kind, use.canonical));
  }
  return choose(
    imported,
    `More than one SCSS member matches ${use.text}`,
    `No SCSS member matches ${use.text}`,
    incomplete,
  );
}

/** `@extend` reaches placeholders of the file and of every module it loads, public ones only. */
function resolvePlaceholder(model: ProjectModel, current: ModuleModel, use: ScssUse): ScssResolution {
  const found: PlaceholderDeclaration[] = current.placeholders.filter((entry) => entry.declared === use.canonical);
  const seen = new Set<string>([current.key]);
  const queue = [current];
  let unproven = false;
  for (let next = queue.shift(); next; next = queue.shift()) {
    for (const resolved of next.loads) {
      if (resolved.target.type === "unresolved") unproven = true;
      if (resolved.target.type !== "file") continue;
      const key = fileIdentityKey(resolved.target.file);
      if (seen.has(key)) continue;
      seen.add(key);
      const loaded = model.files.get(key);
      if (!loaded) {
        unproven = true;
        continue;
      }
      queue.push(loaded);
      for (const entry of loaded.placeholders) {
        if (entry.declared === use.canonical && !isPrivateName(entry.declared)) found.push(entry);
      }
    }
  }
  if (unproven) {
    return { status: "not_found", reason: "SCSS @extend modules were not all readable", unproven: true };
  }
  const defs = [...new Set(found.map((entry) => entry.def))];
  const [first, ...rest] = defs;
  if (!first) return { status: "not_found", reason: `No SCSS placeholder matches %${use.text}` };
  if (rest.length) {
    return {
      status: "not_found",
      reason: `More than one SCSS placeholder matches %${use.text}`,
      unproven: true,
    };
  }
  return { status: "ok", def: first, prefix: "" };
}

/**
 * Resolves one scanned use. `shadow` means an enclosing local owns the name, so module
 * lookup must not claim it. `unproven` means more than one member matches, or a load that
 * could contribute members did not resolve.
 */
export async function resolveScssUse(index: ProjectIndex, file: FileId, use: ScssUse): Promise<ScssResolution> {
  const model = await projectModel(index);
  const current = model.files.get(fileIdentityKey(file));
  if (!current) return { status: "not_found", reason: "SCSS file is not indexed", unproven: true };
  if (use.kind === "placeholder") return resolvePlaceholder(model, current, use);
  if (use.loadIndex !== null) return resolveLoadName(model, current, use);
  if (use.namespace !== null) return resolveNamespaced(model, current, use, use.namespace);
  return resolveUnnamespaced(model, current, use);
}

/** The top-level member a definition declares, or null for locals, parameters, and selectors. */
export async function scssMemberForDefinition(index: ProjectIndex, def: SymbolDef): Promise<ScssDeclaredMember | null> {
  const model = await projectModel(index);
  const current = model.files.get(fileIdentityKey(def.file));
  if (!current) return null;
  const at = defKey(def.range.start.line, def.range.start.column, sassCanonical(def.localName));
  const declared = current.defAt.get(at);
  if (!declared) return null;
  const member = current.own.find((entry) => entry.sites.includes(declared));
  if (member) return member;
  const placeholder = current.placeholders.find((entry) => entry.def === declared);
  if (!placeholder) return null;
  return { kind: "placeholder", declared: placeholder.declared, def: placeholder.def, sites: [placeholder.def] };
}

/**
 * Definition of the local variable that hides a member. A variable declared in a block has an
 * indexed definition; a parameter or loop variable has none.
 */
export async function scssLocalDefinition(
  index: ProjectIndex,
  file: FileId,
  binding: Range,
  canonical: string,
): Promise<SymbolDef | undefined> {
  const model = await projectModel(index);
  return model.files.get(fileIdentityKey(file))?.defAt.get(defKey(binding.start.line, binding.start.column, canonical));
}

/** Reference span for a use. Null when a forward prefix cannot be split from the member. */
export function scssUseEditRange(facts: ScssFileFacts, use: ScssUse, prefix: string): Range | null {
  const span = memberEditSpan(use.text, prefix);
  if (!span) return null;
  return scssOffsetRange(facts, use.nameStart + span.start, use.nameStart + span.end);
}

/**
 * Files that can see `def`, plus files whose unresolved URL or `meta.load-css` may load the
 * declaring file. `unavailable` files were not fully proved. A directory index (`_index.scss`)
 * is also reached through the name of its directory.
 */
export async function scssReferenceCandidates(
  index: ProjectIndex,
  def: SymbolDef,
): Promise<{ files: FileId[]; unavailable: FileId[] }> {
  const model = await projectModel(index);
  const files: FileId[] = [];
  const seen = new Set<string>();
  const queue: FileId[] = [def.file];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const key = fileIdentityKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(next);
    queue.push(...(model.reverse.get(key) ?? []));
    queue.push(...(model.hostsByTarget.get(key) ?? []));
  }

  const unavailable: FileId[] = [];
  const unavailableKeys = new Set<string>();
  const markUnavailable = (file: FileId): void => {
    const key = fileIdentityKey(file);
    if (unavailableKeys.has(key)) return;
    unavailableKeys.add(key);
    unavailable.push(file);
  };

  const stems = new Set<string>([moduleStem(def.file)]);
  if (moduleStem(def.file) === "index") stems.add(moduleStem(path.dirname(def.file)));
  for (const current of model.files.values()) {
    if (seen.has(current.key)) continue;
    const unresolvedMatch = [...stems].some((stem) => current.unresolvedStems.has(stem));
    const dynamicMatch = current.dynamicStems.has(null) || [...stems].some((stem) => current.dynamicStems.has(stem));
    if (!unresolvedMatch && !dynamicMatch) continue;
    seen.add(current.key);
    files.push(current.file);
    markUnavailable(current.file);
  }
  for (const stem of stems) {
    for (const host of model.hostsByStem.get(stem) ?? []) {
      if (seen.has(fileIdentityKey(host))) continue;
      seen.add(fileIdentityKey(host));
      files.push(host);
    }
  }

  for (const file of files) {
    const current = model.files.get(fileIdentityKey(file));
    // A host file keeps its styles in blocks this scan does not read, so it is never proved.
    if (!current) {
      markUnavailable(file);
      continue;
    }
    // A load that did not resolve may reach members this scan cannot see.
    const unresolvedLoad = current.loads.some((resolved) => resolved.target.type === "unresolved");
    if (unresolvedLoad || current.facts.dynamics.length) markUnavailable(file);
  }
  return { files, unavailable };
}

export function scssUseAt(facts: ScssFileFacts, line: number, column: number): ScssUse | undefined {
  const offset = scssOffsetAt(facts, line, column);
  if (offset < 0) return undefined;
  return facts.uses.find((use) => offset >= use.hitStart && offset < use.nameEnd);
}

/** Members one file sees without a namespace: its own declarations, `@use ... as *`, and `@import`. */
function globalScope(model: ProjectModel, current: ModuleModel): Member[] {
  const members = current.own.map(ownAsMember);
  for (const resolved of current.loads) {
    if (resolved.target.type !== "file") continue;
    const star = resolved.load.kind === "use" && resolved.load.star;
    const legacy = resolved.load.kind === "import";
    if (!star && !legacy) continue;
    const inner = exposureOf(model, fileIdentityKey(resolved.target.file), legacy ? "import" : "module", newWalk());
    members.push(...inner.members);
  }
  return members;
}

/**
 * Same-kind members that would share the new name with `def` in a scope that sees `def`: the
 * module that declares it, every module that exposes it, and every file that sees it without a
 * namespace (`@use ... as *`, `@import`). A forward prefix stays in front of the new name.
 */
export async function scssRenameCollisions(index: ProjectIndex, def: SymbolDef, newName: string): Promise<SymbolDef[]> {
  const model = await projectModel(index);
  const member = await scssMemberForDefinition(index, def);
  if (!member) return [];
  const next = sassCanonical(newName);
  if (next === member.declared) return [];
  const collisions = new Set<SymbolDef>();
  if (member.kind === "placeholder") {
    const origin = model.files.get(fileIdentityKey(def.file));
    for (const entry of origin?.placeholders ?? []) {
      if (entry.declared === next && entry.def !== member.def) collisions.add(entry.def);
    }
    return [...collisions];
  }
  const check = (members: readonly Member[]): void => {
    const own = members.find((entry) => entry.def === member.def);
    if (!own) return;
    const wanted = own.exposed.slice(0, own.exposed.length - member.declared.length) + next;
    for (const entry of members) {
      if (entry.kind === member.kind && entry.def !== member.def && entry.exposed === wanted) collisions.add(entry.def);
    }
  };
  const { files } = await scssReferenceCandidates(index, member.def);
  for (const file of files) {
    const current = model.files.get(fileIdentityKey(file));
    if (!current) continue;
    check(exposureOf(model, current.key, "module", newWalk()).members);
    check(exposureOf(model, current.key, "import", newWalk()).members);
    check(globalScope(model, current));
  }
  return [...collisions];
}

/**
 * Reference sites that a local variable of the new name would capture after the rename: a
 * parameter, loop variable, or block variable already in scope there. Only variables can be
 * captured this way.
 */
export async function scssRenameCaptures(
  index: ProjectIndex,
  def: SymbolDef,
  newName: string,
  references: readonly { file: FileId; range: Range }[],
): Promise<{ file: FileId; range: Range }[]> {
  const model = await projectModel(index);
  const member = await scssMemberForDefinition(index, def);
  if (member?.kind !== "variable") return [];
  const next = sassCanonical(newName);
  const captured: { file: FileId; range: Range }[] = [];
  for (const reference of references) {
    const current = model.files.get(fileIdentityKey(reference.file));
    const bindings = current?.localsByName.get(next);
    const at = reference.range.start.index;
    if (!bindings || at === undefined) continue;
    if (bindings.some((binding) => at >= binding.from && at < binding.to)) captured.push(reference);
  }
  return captured;
}

/** Replacement text for one SCSS member edit, or null when the site is not that member. */
export function scssReplacementText(localName: string, oldText: string, newName: string): string | null {
  const newBare = sassBare(newName);
  if (sassCanonical(oldText) === sassCanonical(localName)) {
    if (localName.startsWith("$") && oldText.startsWith("$")) return newName.startsWith("$") ? newName : `$${newBare}`;
    if (localName.startsWith("%") && oldText.startsWith("%")) return `%${newBare}`;
    return newBare;
  }
  return null;
}
