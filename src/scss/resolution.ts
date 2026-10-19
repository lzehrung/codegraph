import path from "node:path";
import { ensureParsedContext } from "../indexer/parse-context.js";
import { sameDef } from "../indexer/reference-context.js";
import { SymbolKind, type ModuleIndex, type ProjectIndex, type Reference, type SymbolDef } from "../indexer/types.js";
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
  type ScssCallableLocal,
  type ScssFileFacts,
  type ScssLocalBinding,
  type ScssMemberKind,
  type ScssModuleLoad,
  type ScssDynamic,
  type ScssDynamicForm,
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

/**
 * How a use reaches its member: in the file that declares it, through `@import` (which has no
 * privacy), or through `@use` or `@forward` (which hide names that start with `-` or `_`).
 */
export type ScssAccess = "own" | "import" | "module";

/**
 * A `@forward` that has a `show` or `hide` list and that a member passed through. `exposed` is the
 * canonical name the list sees: the prefix of this forward and of the forwards inside it, plus the
 * declared name.
 */
export type ScssForwardFilter = { load: ScssModuleLoad; exposed: string };

export type ScssResolved = {
  status: "ok";
  def: SymbolDef;
  prefix: string;
  access: ScssAccess;
  /** The forward lists on the path from the declaring file to the use, innermost first. */
  filters: readonly ScssForwardFilter[];
};

/**
 * `shadow`: a local variable owns the name, so module lookup must not claim it. `indexed` is true
 * when the index holds a definition for one of those locals (a variable that a block declares);
 * a parameter or a loop variable has none.
 */
export type ScssResolution = ScssResolved | { status: "shadow"; indexed: boolean } | ScssNotFound;

/** A place where a member is declared. */
export type ScssSite = { file: FileId; range: Range };

/** A top-level declaration, as the index and the navigation consumers see it. */
export type ScssDeclaredMember = {
  kind: ScssMemberKind;
  /** Canonical declared name. */
  declared: string;
  /** First declaration of the member. A variable assigned again in the file keeps the first one. */
  def: SymbolDef;
  /** Every declaration site of the member, `def` first. */
  sites: readonly ScssSite[];
};

type LoadTarget = { type: "file"; file: FileId } | { type: "builtin" } | { type: "unresolved"; extraStems?: string[] };

type ResolvedLoad = { load: ScssModuleLoad; target: LoadTarget };

type OwnMember = {
  kind: Exclude<ScssMemberKind, "placeholder">;
  declared: string;
  def: SymbolDef;
  sites: ScssSite[];
  /** `defKey` of every site, so a definition that the index reports finds its member. */
  siteKeys: Set<string>;
  /** True when any top-level assignment of the variable uses `!default`. */
  isDefault: boolean;
};

/**
 * A placeholder as one file declares it. Sass extends every rule of a file that has the name, in a
 * media query or in another rule too, so the repeated declarations are one placeholder.
 */
type PlaceholderDeclaration = {
  def: SymbolDef;
  declared: string;
  /** Every declaration site in the file, `def` first. */
  sites: ScssSite[];
  /** `defKey` of every site, so a definition that the index reports finds its placeholder. */
  siteKeys: Set<string>;
};

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
  /** Dynamic calls whose sass:meta load comes from an @import importer. */
  inheritedDynamics: NonNullable<ScssUse["dynamic"]>[];
  /** Names whose file-scope flow assignment could not be joined to one imported variable. */
  unprovenFlowAssigns: Set<string>;
  /** Flow assignments joined to an imported variable. A click on either site is that variable. */
  joinedAssignments: { range: Range; member: OwnMember }[];
};

type ProjectModel = {
  files: Map<string, ModuleModel>;
  /** Files that load a file directly, by the key of the loaded file. */
  reverse: Map<string, FileId[]>;
  /** Keys of the files that `@import` a file, by the key of the imported file. */
  importers: Map<string, string[]>;
  importerChains: Map<string, ModuleModel[]>;
  exposures: Map<string, Exposure>;
  /** Files that are not SCSS but import a stylesheet URL that did not resolve, by stem. */
  hostsByStem: Map<string, FileId[]>;
  /** Files that are not SCSS but import a file, by the key of the imported file. */
  hostsByTarget: Map<string, FileId[]>;
  /**
   * A definition that exposures show although its name is private. Rename preview sets it on a
   * copy of the model to see the scopes that a private member joins when it takes a public name.
   */
  unhide?: SymbolDef;
};

/** A member as one module exposes it. A forward prefix changes `exposed`, never `def`. */
type Member = {
  kind: Exclude<ScssMemberKind, "placeholder">;
  /** Canonical name the module exposes: forward prefix plus declared name. */
  exposed: string;
  /** Forward prefix in source spelling; empty when no forward renamed the member. */
  prefix: string;
  def: SymbolDef;
  isDefault: boolean;
  /** Reached through `@import` only, so a name that starts with `-` or `_` is still visible. */
  importOnly: boolean;
  /** The `@forward` lists the member passed through, innermost first. */
  filters: readonly ScssForwardFilter[];
  /**
   * Exposed name before a rename lens rewrote it. Set only while judging a rename, and only on
   * the member being renamed, so a `show` or `hide` entry can be read under the new name.
   */
  lensFrom?: string;
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

/** A proposed rename, used to recompute `@forward` visibility before collision checks. */
type RenameLens = { def: SymbolDef; from: string; to: string; cache: Map<string, Exposure> };

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
  // Variables, mixins, and functions fold `_` into `-`; a placeholder keeps the spelling it has.
  return canonical.startsWith("-") || canonical.startsWith("_");
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

function indexedFile(index: ProjectIndex, candidate: string): FileId | undefined {
  return index.byFile.get(fileIdentityKey(candidate))?.file;
}

type ImportOnlyHit = { status: "one"; file: FileId } | { status: "ambiguous"; stems: string[] } | { status: "none" };

function importUrlLocation(
  fromFile: FileId,
  url: string,
): { base: string; dir: string; stem: string; hasStyleExtension: boolean } | null {
  const trimmed = url.trim();
  const bare = (trimmed.split(/[?#]/u)[0] ?? "").trim();
  if (!bare || isSassBuiltinUrl(trimmed)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare) && !/^[a-z]:[\/]/i.test(bare)) return null;
  const resolved = path.resolve(path.dirname(fromFile), bare);
  const extension = path.extname(resolved).toLowerCase();
  const hasStyleExtension = extension === ".scss" || extension === ".sass" || extension === ".css";
  let stemPath = hasStyleExtension ? resolved.slice(0, -extension.length) : resolved;
  if (stemPath.toLowerCase().endsWith(".import")) stemPath = stemPath.slice(0, -".import".length);
  let stem = path.basename(stemPath);
  if (stem.startsWith("_")) stem = stem.slice(1);
  return { base: resolved, dir: path.dirname(stemPath), stem, hasStyleExtension };
}

/**
 * One tier of import-only files `@import` tries for `url`.
 *
 * The order is file import-only sibling, then an ordinary file, then a directory import-only
 * index, then a directory index. A directory `_index.import.scss` must not hide `lib.scss`.
 * `@use` and `@forward` never take this path. Two siblings in one tier are ambiguous.
 */
function importOnlyTarget(
  index: ProjectIndex,
  fromFile: FileId,
  url: string,
  tier: "file" | "directory",
): ImportOnlyHit {
  const located = importUrlLocation(fromFile, url);
  if (!located || !located.stem) return { status: "none" };
  const pick = (candidates: readonly string[]): ImportOnlyHit | null => {
    const found = candidates
      .map((candidate) => indexedFile(index, candidate))
      .filter((file): file is FileId => file !== undefined);
    const unique = [...new Map(found.map((file) => [fileIdentityKey(file), file])).values()];
    if (unique.length > 1) return { status: "ambiguous", stems: unique.map((file) => moduleStem(file)) };
    const [only] = unique;
    return only ? { status: "one", file: only } : null;
  };
  if (tier === "file") {
    return (
      pick([
        path.join(located.dir, `_${located.stem}.import.scss`),
        path.join(located.dir, `${located.stem}.import.scss`),
      ]) ?? { status: "none" }
    );
  }
  if (located.hasStyleExtension) return { status: "none" };
  return (
    pick([path.join(located.base, "_index.import.scss"), path.join(located.base, "index.import.scss")]) ?? {
      status: "none",
    }
  );
}

/** True when `target` is the directory index of `url`, not a stylesheet file of that name. */
function isDirectoryIndexFile(fromFile: FileId, url: string, target: FileId): boolean {
  const located = importUrlLocation(fromFile, url);
  if (!located || located.hasStyleExtension || !located.stem) return false;
  const rel = path.relative(located.base, path.resolve(target)).replace(/\\/g, "/");
  return /^_?index\.(scss|sass|css)$/i.test(rel);
}

function loadTarget(
  targets: ReadonlyMap<string, FileId>,
  importTargets: ReadonlyMap<string, FileId>,
  key: string,
  url: string,
  kind: ScssModuleLoad["kind"],
  fromFile: FileId,
  index: ProjectIndex,
): LoadTarget {
  const trimmed = url.trim();
  if (isSassBuiltinUrl(trimmed)) return { type: "builtin" };
  const edge = targets.get(`${key}\0${trimmed}`) ?? importTargets.get(trimmed);
  // `@import` prefers an import-only file. `@use` and `@forward` keep the ordinary edge.
  if (kind === "import") {
    const fileLevel = importOnlyTarget(index, fromFile, trimmed, "file");
    if (fileLevel.status === "one") return { type: "file", file: fileLevel.file };
    if (fileLevel.status === "ambiguous") return { type: "unresolved", extraStems: fileLevel.stems };
    // A directory import-only index must not override an ordinary file such as lib.scss.
    if (edge && !isDirectoryIndexFile(fromFile, trimmed, edge)) return { type: "file", file: edge };
    const directoryLevel = importOnlyTarget(index, fromFile, trimmed, "directory");
    if (directoryLevel.status === "one") return { type: "file", file: directoryLevel.file };
    if (directoryLevel.status === "ambiguous") return { type: "unresolved", extraStems: directoryLevel.stems };
  }
  if (edge) return { type: "file", file: edge };
  return { type: "unresolved" };
}

function buildOwnMembers(
  file: FileId,
  facts: ScssFileFacts,
  defAt: ReadonlyMap<string, SymbolDef>,
): { own: OwnMember[]; ownByName: Map<string, OwnMember[]>; placeholders: PlaceholderDeclaration[] } {
  const own: OwnMember[] = [];
  const ownByName = new Map<string, OwnMember[]>();
  const variables = new Map<string, OwnMember>();
  const placeholders: PlaceholderDeclaration[] = [];
  const placeholderSites = new Map<string, { def: SymbolDef | undefined; siteKey: string; range: Range }[]>();
  for (const declaration of facts.declarations) {
    if (!declaration.topLevel) continue;
    // The key matches `defAt`: the position of the definition and its name with `_` folded into `-`.
    const siteKey = defKey(
      declaration.range.start.line,
      declaration.range.start.column,
      sassCanonical(declaration.name),
    );
    const def = defAt.get(siteKey);
    if (declaration.kind === "placeholder") {
      appendTo(placeholderSites, declaration.canonical, { def, siteKey, range: declaration.range });
      continue;
    }
    const name = `${declaration.kind}:${declaration.canonical}`;
    const assignedBefore = declaration.kind === "variable" ? variables.get(name) : undefined;
    if (assignedBefore) {
      // One file assigning a variable again is still one variable. The assignment is a site even
      // when the index holds no definition for it, as for an assignment inside `@each`: a rename
      // that skipped it would leave the old name behind.
      assignedBefore.sites.push({ file, range: declaration.range });
      assignedBefore.siteKeys.add(siteKey);
      // `$x: null; $x: 1 !default` is configurable: `with` is legal when any assignment uses `!default`.
      if (declaration.isDefault) assignedBefore.isDefault = true;
      continue;
    }
    if (!def) continue;
    const member: OwnMember = {
      kind: declaration.kind,
      declared: declaration.canonical,
      def,
      sites: [{ file: def.file, range: def.range }],
      siteKeys: new Set([siteKey]),
      isDefault: declaration.isDefault,
    };
    if (declaration.kind === "variable") variables.set(name, member);
    own.push(member);
    appendTo(ownByName, name, member);
  }
  // Sass extends every rule of a file that has the name, so the declarations of one name are one
  // placeholder. Each of them is a site, also when the index holds no definition for it: a rename
  // that skipped one would leave the old name behind.
  for (const [declared, entries] of placeholderSites) {
    const first = entries.find((entry) => entry.def);
    if (!first?.def) continue;
    placeholders.push({
      def: first.def,
      declared,
      sites: [
        { file: first.def.file, range: first.def.range },
        ...entries.filter((entry) => entry !== first).map((entry) => ({ file, range: entry.range })),
      ],
      siteKeys: new Set(entries.map((entry) => entry.siteKey)),
    });
  }
  return { own, ownByName, placeholders };
}

function detachFlowLocal(current: ModuleModel, local: ScssLocalBinding): void {
  const list = current.localsByName.get(local.canonical);
  if (list) {
    const next = list.filter((entry) => entry !== local);
    if (next.length) current.localsByName.set(local.canonical, next);
    else current.localsByName.delete(local.canonical);
  }
  const index = current.facts.locals.indexOf(local);
  if (index >= 0) current.facts.locals.splice(index, 1);
}

/**
 * A file-scope flow assignment after `@import` updates the imported variable when exactly one
 * variable of that name is in scope. Several matches, or an import that did not resolve, leave
 * the name unproven instead of inventing a local. No match keeps the block local.
 */
function joinImportedFlowAssignments(model: ProjectModel): void {
  for (const current of model.files.values()) {
    for (const assignment of current.facts.flowAssignments) {
      const found: Member[] = [];
      let incomplete = false;
      for (const resolved of current.loads) {
        if (resolved.load.kind !== "import" || resolved.load.nested) continue;
        const assignmentAt = assignment.range.start.index;
        if (assignmentAt !== undefined && resolved.load.at > assignmentAt) continue;
        if (resolved.target.type !== "file") {
          incomplete = true;
          continue;
        }
        const inner = exposureOf(model, fileIdentityKey(resolved.target.file), "import", newWalk());
        if (inner.incomplete) incomplete = true;
        found.push(...lookup(inner.byName, "variable", assignment.canonical));
      }
      const matches = uniqueMembers(found);
      if (!incomplete && matches.length === 0) continue;
      detachFlowLocal(current, assignment.local);
      if (incomplete || matches.length !== 1) {
        current.unprovenFlowAssigns.add(assignment.canonical);
        continue;
      }
      const member = matches[0]!;
      const owner = model.files.get(fileIdentityKey(member.def.file));
      const own = owner?.own.find((entry) => entry.def === member.def);
      if (!own) {
        current.unprovenFlowAssigns.add(assignment.canonical);
        continue;
      }
      own.sites.push({ file: current.file, range: assignment.range });
      current.joinedAssignments.push({ range: assignment.range, member: own });
    }
  }
}

function memberDeclaredAfter(current: ModuleModel, use: ScssUse, member: OwnMember): boolean {
  if (member.kind !== "function" && member.kind !== "mixin") return false;
  if (use.kind !== member.kind) return false;
  const declaredAt = scssOffsetAt(current.facts, member.def.range.start.line, member.def.range.start.column);
  return declaredAt > use.nameStart;
}

async function buildProjectModel(index: ProjectIndex): Promise<ProjectModel> {
  const scssModules: { module: ModuleIndex; facts: ScssFileFacts }[] = [];
  const scssKeys = new Set<string>();
  const unreadable = new Set<string>();
  for (const module of index.byFile.values()) {
    if (!isScssFile(index, module.file)) continue;
    const facts = await scssFactsForFile(index, module.file);
    if (!facts) {
      unreadable.add(fileIdentityKey(module.file));
      continue;
    }
    scssModules.push({ module, facts });
    scssKeys.add(fileIdentityKey(module.file));
  }
  const targets = stylesheetTargets(index, scssKeys);
  const files = new Map<string, ModuleModel>();
  const reverse = new Map<string, FileId[]>();
  const importers = new Map<string, string[]>();
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
    const loads = facts.loads.map((load) => ({
      load,
      target: loadTarget(targets, importTargets, key, load.url, load.kind, module.file, index),
    }));
    const unresolvedStems = new Set<string>();
    for (const resolved of loads) {
      if (resolved.target.type === "file") {
        const targetKey = fileIdentityKey(resolved.target.file);
        appendTo(reverse, targetKey, module.file);
        if (resolved.load.kind === "import" && !importers.get(targetKey)?.includes(key)) {
          appendTo(importers, targetKey, key);
        }
      } else if (resolved.target.type === "unresolved") {
        unresolvedStems.add(moduleStem(resolved.load.url));
        for (const stem of resolved.target.extraStems ?? []) unresolvedStems.add(stem);
      }
    }
    const dynamicStems = new Set<string | null>();
    for (const dynamic of facts.dynamics) {
      if (dynamic.form === "load-css") dynamicStems.add(dynamic.arg === null ? null : moduleStem(dynamic.arg));
    }
    const localsByName = new Map<string, ScssLocalBinding[]>();
    for (const local of facts.locals) appendTo(localsByName, local.canonical, local);
    const { own, ownByName, placeholders } = buildOwnMembers(module.file, facts, defAt);
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
      inheritedDynamics: [],
      unprovenFlowAssigns: new Set(),
      joinedAssignments: [],
    });
  }
  // An SCSS file whose text could not be read still loads other files, as far as the graph knows. It
  // stays a consumer that is never proved, so the coverage of what it loads is partial.
  if (unreadable.size) {
    for (const edge of index.graph.edges) {
      if (edge.to.type === "file" && unreadable.has(fileIdentityKey(edge.from))) {
        appendTo(reverse, fileIdentityKey(edge.to.path), edge.from);
      }
    }
  }
  const hosts = hostImports(index);
  const model: ProjectModel = {
    files,
    reverse,
    importers,
    importerChains: new Map(),
    exposures: new Map(),
    hostsByStem: hosts.byStem,
    hostsByTarget: hosts.byTarget,
  };
  joinImportedFlowAssignments(model);
  for (const current of files.values()) {
    for (const use of current.facts.uses) {
      if (!use.dynamic || !inheritsMetaLookup(model, current, use)) continue;
      current.inheritedDynamics.push(use.dynamic);
      if (use.dynamic.form === "load-css") {
        current.dynamicStems.add(use.dynamic.arg === null ? null : moduleStem(use.dynamic.arg));
      }
    }
  }
  return model;
}

function projectModel(index: ProjectIndex): Promise<ProjectModel> {
  let pending = projects.get(index);
  if (!pending) {
    pending = buildProjectModel(index);
    projects.set(index, pending);
  }
  return pending;
}

function ownAsMember(member: OwnMember, importOnly: boolean): Member {
  return {
    kind: member.kind,
    exposed: member.declared,
    prefix: "",
    def: member.def,
    isDefault: member.isDefault,
    importOnly,
    filters: [],
  };
}

function withPrefix(member: Member, prefix: string): Member {
  if (!prefix) return member;
  const canonicalPrefix = sassCanonical(prefix);
  return {
    ...member,
    exposed: canonicalPrefix + member.exposed,
    prefix: prefix + member.prefix,
    ...(member.lensFrom !== undefined ? { lensFrom: canonicalPrefix + member.lensFrom } : {}),
  };
}

/**
 * The member as a module that forwards it exposes it: the prefix is added, and a `show` or `hide`
 * list is kept, so rename preview can test the new name against it.
 */
function withForward(member: Member, load: ScssModuleLoad): Member {
  const prefixed = withPrefix(member, load.prefix);
  if (!load.show && !load.hide) return prefixed;
  return { ...prefixed, filters: [...member.filters, { load, exposed: prefixed.exposed }] };
}

/**
 * `@import` runs the imported file inside the scope of the importer. The chain holds every file
 * that imports `key`, directly or through other imports, nearest first, so a partial can read what
 * its importers declared and loaded. `@use` and `@forward` give a file no such scope.
 */
function importerChain(model: ProjectModel, key: string): ModuleModel[] {
  const cached = model.importerChains.get(key);
  if (cached) return cached;
  const chain: ModuleModel[] = [];
  const seen = new Set<string>([key]);
  const queue: string[] = [key];
  for (let next = queue.shift(); next; next = queue.shift()) {
    for (const importerKey of model.importers.get(next) ?? []) {
      if (seen.has(importerKey)) continue;
      seen.add(importerKey);
      const importer = model.files.get(importerKey);
      if (!importer) continue;
      chain.push(importer);
      queue.push(importerKey);
    }
  }
  model.importerChains.set(key, chain);
  return chain;
}

function listMatches(
  list: readonly { name: string; kind: "variable" | "callable" }[],
  member: Member,
  exposed: string,
  adjust?: (canonical: string) => string,
) {
  return list.some((entry) => {
    const wantsVariable = entry.kind === "variable";
    if (wantsVariable !== (member.kind === "variable")) return false;
    const name = sassCanonical(entry.name);
    return (adjust ? adjust(name) : name) === exposed;
  });
}

/**
 * `show` and `hide` list the names a forward exposes, so they compare against the prefixed
 * spelling. A bare name selects mixins and functions, a `$name` selects variables.
 */
function passesFilter(member: Member, load: ScssModuleLoad): boolean {
  const exposed = sassCanonical(load.prefix) + member.exposed;
  // A list entry that spells the name the member has today is edited with the rename. Every other
  // entry stays, so a `show $y` that did not name `$x` admits `$x` once it is renamed to `$y`.
  const previous = member.lensFrom === undefined ? undefined : sassCanonical(load.prefix) + member.lensFrom;
  const adjust = previous === undefined ? undefined : (name: string) => (name === previous ? exposed : name);
  if (load.show && !listMatches(load.show, member, exposed, adjust)) return false;
  if (load.hide && listMatches(load.hide, member, exposed, adjust)) return false;
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
function applyLens(member: Member, lens: RenameLens | undefined): Member {
  if (!lens || member.def !== lens.def || !member.exposed.endsWith(lens.from)) return member;
  return {
    ...member,
    exposed: member.exposed.slice(0, member.exposed.length - lens.from.length) + lens.to,
    lensFrom: member.exposed,
  };
}

function exposureOf(model: ProjectModel, key: string, mode: LoadMode, walk: Walk, lens?: RenameLens): Exposure {
  const cache = lens?.cache ?? model.exposures;
  const cacheKey = `${mode}:${key}`;
  const cached = cache.get(cacheKey);
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
    if (mode === "module" && isPrivateName(member.declared) && member.def !== model.unhide) continue;
    members.push(applyLens(ownAsMember(member, mode === "import"), lens));
  }
  for (const resolved of current.loads) {
    const { load, target } = resolved;
    if (load.kind === "use" || load.nested) continue;
    if (target.type === "unresolved") incomplete = true;
    if (target.type !== "file") continue;
    const forwarded = load.kind === "forward";
    const inner = exposureOf(model, fileIdentityKey(target.file), forwarded ? "module" : "import", walk, lens);
    if (inner.incomplete) incomplete = true;
    for (const member of inner.members) {
      if (forwarded) {
        if (passesFilter(member, load)) members.push(withForward(member, load));
      } else if (mode === "import") {
        members.push(member);
      } else if (!isPrivateName(member.exposed) || member.def === model.unhide) {
        // A consumer of a module cannot see a private name that `@import` brought in.
        members.push({ ...member, importOnly: false });
      }
    }
  }
  walk.trail.delete(key);
  const exposure = finishExposure(members, incomplete);
  if (walk.cuts === cutsBefore) cache.set(cacheKey, exposure);
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
function scssUseMayNameMember(use: ScssUse, member: ScssDeclaredMember): boolean {
  return kindMatches(member.kind, use.kind) && use.canonical.endsWith(member.declared);
}

function lookup(table: ReadonlyMap<string, readonly Member[]>, kind: ScssUse["kind"], canonical: string): Member[] {
  if (kind === "callable") {
    return [...(table.get(`mixin:${canonical}`) ?? []), ...(table.get(`function:${canonical}`) ?? [])];
  }
  return [...(table.get(`${kind}:${canonical}`) ?? [])];
}

/** One member per declaration. A declaration reached by several paths keeps the most permissive access. */
function uniqueMembers(members: readonly Member[]): Member[] {
  const byDef = new Map<SymbolDef, Member>();
  for (const member of members) {
    const seen = byDef.get(member.def);
    if (!seen) byDef.set(member.def, member);
    else if (member.importOnly && !seen.importOnly) byDef.set(member.def, { ...seen, importOnly: true });
  }
  return [...byDef.values()];
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
  return {
    status: "ok",
    def: first.def,
    prefix: first.prefix,
    access: first.importOnly ? "import" : "module",
    filters: first.filters,
  };
}

function unresolvedIntroducesMembers(loads: readonly ResolvedLoad[], beforeOffset?: number): boolean {
  return loads.some((resolved) => {
    if (beforeOffset !== undefined && resolved.load.at > beforeOffset) return false;
    if (resolved.target.type !== "unresolved") return false;
    return resolved.load.kind === "import" || (resolved.load.kind === "use" && resolved.load.star);
  });
}

/** The local variables that are in scope at `use` and have its name, outermost and earliest first. */
function coveringCallable(current: ModuleModel, use: ScssUse): boolean {
  if (use.namespace !== null || (use.kind !== "mixin" && use.kind !== "function")) return false;
  if (use.syntax !== "include" && use.syntax !== "call") return false;
  return current.facts.callableLocals.some(
    (local) =>
      local.kind === use.kind &&
      local.canonical === use.canonical &&
      use.nameStart >= local.from &&
      use.nameStart < local.to,
  );
}

function coveringLocals(current: ModuleModel, use: ScssUse): ScssLocalBinding[] {
  if (use.kind !== "variable") return [];
  const bindings = current.localsByName.get(use.canonical) ?? [];
  return bindings.filter((local) => use.nameStart >= local.from && use.nameStart < local.to);
}

function resolveLoadName(model: ProjectModel, current: ModuleModel, use: ScssUse): ScssResolution {
  const resolved = use.loadIndex === null ? undefined : current.loads[use.loadIndex];
  if (!resolved) return { status: "not_found", reason: "SCSS module load is missing" };
  const { load, target } = resolved;
  if (target.type === "builtin") return { status: "not_found", reason: "Built-in Sass module" };
  if (target.type === "unresolved") {
    return { status: "not_found", reason: `Module URL ${load.url} did not resolve`, unproven: true };
  }
  const isConfig = use.syntax === "config";
  // `with` can configure a private variable of the loaded module, which every other use through
  // `@use` is denied, so only a configuration key looks at the declarations the module hides.
  const inner = exposureOf(model, fileIdentityKey(target.file), isConfig ? "import" : "module", newWalk());
  const written = sassCanonical(use.text);
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

function matchingNamespaces(file: ModuleModel, namespace: string): ResolvedLoad[] {
  // Sass compares namespaces as written: `my-lib` and `my_lib` are different namespaces.
  return file.loads.filter((resolved) => resolved.load.kind === "use" && resolved.load.namespace === namespace);
}

/** One load per target, so two importers that load the same module do not look like a clash. */
function uniqueTargets(loads: readonly ResolvedLoad[]): ResolvedLoad[] {
  const seen = new Set<string>();
  const unique: ResolvedLoad[] = [];
  for (const resolved of loads) {
    const { target, load } = resolved;
    const key = target.type === "file" ? `file:${fileIdentityKey(target.file)}` : `${target.type}:${load.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(resolved);
  }
  return unique;
}

/** An @imported partial inherits the caller's @use binding, not the spelling of its namespace. */
function inheritsMetaLookup(model: ProjectModel, current: ModuleModel, use: ScssUse): boolean {
  if (!use.dynamic) return false;
  const importers = importerChain(model, current.key);
  if (use.namespace === null) {
    if (current.ownByName.has(use.kind + ":" + use.canonical)) return false;
    return importers.some((importer) =>
      importer.loads.some(
        ({ load, target }) =>
          load.kind === "use" && load.star && load.url.trim() === "sass:meta" && target.type === "builtin",
      ),
    );
  }
  const namespace = use.namespace;
  if (matchingNamespaces(current, namespace).length) return false;
  const inherited = uniqueTargets(importers.flatMap((importer) => matchingNamespaces(importer, namespace)));
  return inherited.some(({ load, target }) => load.url.trim() === "sass:meta" && target.type === "builtin");
}

function resolveNamespaced(model: ProjectModel, current: ModuleModel, use: ScssUse, namespace: string): ScssResolution {
  let namespaces = matchingNamespaces(current, namespace);
  if (!namespaces.length) {
    // A file that an `@import` runs inside its importer can use the namespaces of that importer.
    const inherited = importerChain(model, current.key).flatMap((importer) => matchingNamespaces(importer, namespace));
    namespaces = uniqueTargets(inherited);
  }
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

/**
 * Adds the members of the `@use ... as *` and `@import` loads of `file` that have `kind` and the
 * name `canonical`. A nested `@import` is left out, see {@link nestedMembers}. Returns true when a
 * load could not be read, so the lookup is not complete.
 */
function collectLoaded(
  model: ProjectModel,
  file: ModuleModel,
  kind: ScssUse["kind"],
  canonical: string,
  into: Member[],
  beforeOffset?: number,
): boolean {
  let incomplete = false;
  for (const resolved of file.loads) {
    if (beforeOffset !== undefined && resolved.load.at > beforeOffset) continue;
    if (resolved.target.type !== "file" || resolved.load.nested) continue;
    const star = resolved.load.kind === "use" && resolved.load.star;
    const legacy = resolved.load.kind === "import";
    if (!star && !legacy) continue;
    const inner = exposureOf(model, fileIdentityKey(resolved.target.file), legacy ? "import" : "module", newWalk());
    if (inner.incomplete) incomplete = true;
    into.push(...lookup(inner.byName, kind, canonical));
  }
  return incomplete;
}

/**
 * The members that the `@import`s nested in a rule of `file` give a name. Sass declares what a
 * nested `@import` brings in inside the rule that holds it, and this scan does not follow blocks,
 * so a use of such a name is unproven instead of resolved to either side.
 */
function nestedMembers(model: ProjectModel, file: ModuleModel, kind: ScssUse["kind"], canonical: string): Member[] {
  const found: Member[] = [];
  for (const resolved of file.loads) {
    if (!resolved.load.nested || resolved.target.type !== "file") continue;
    const inner = exposureOf(model, fileIdentityKey(resolved.target.file), "import", newWalk());
    found.push(...lookup(inner.byName, kind, canonical));
  }
  return found;
}

function nestedImportUnproven(use: ScssUse): ScssNotFound {
  return { status: "not_found", reason: `A nested @import may declare ${use.text} in its own block`, unproven: true };
}

/**
 * True when `use` is a bare `get-function` call that precedes the user-defined function in this
 * file. dart-sass still calls the legacy built-in for that earlier call.
 */
function legacyGetFunctionBeforeDeclaration(current: ModuleModel, use: ScssUse, member: OwnMember): boolean {
  if (use.syntax !== "call" || use.namespace !== null) return false;
  if (use.canonical !== "get-function" && use.canonical !== "call") return false;
  if (member.kind !== "function") return false;
  const declaredAt = scssOffsetAt(current.facts, member.def.range.start.line, member.def.range.start.column);
  return declaredAt > use.nameStart;
}

function legacyBuiltinUse(dynamic: ScssDynamic): ScssUse {
  const at = dynamic.at ?? 0;
  return {
    kind: "function",
    syntax: "call",
    namespace: null,
    text: dynamic.form,
    canonical: dynamic.form,
    nameStart: at,
    nameEnd: at + dynamic.form.length,
    hitStart: at,
    loadIndex: null,
  };
}

/**
 * True when a dynamic lookup in `file` is not proved to be a user-defined function. A bare legacy
 * built-in (`get-function` or an existence predicate) is proved when it resolves to a function
 * another file declares.
 */
async function hasUnprovenDynamic(index: ProjectIndex, file: ModuleModel): Promise<boolean> {
  if (file.inheritedDynamics.length) return true;
  for (const dynamic of file.facts.dynamics) {
    if (!dynamic.legacyBare) return true;
    const resolved = await resolveScssUse(index, file.file, legacyBuiltinUse(dynamic));
    if (resolved.status === "ok" && fileIdentityKey(resolved.def.file) !== file.key) continue;
    return true;
  }
  return false;
}

function resolveUnnamespaced(model: ProjectModel, current: ModuleModel, use: ScssUse): ScssResolution {
  if (coveringCallable(current, use)) return { status: "shadow", indexed: false };
  const covering = coveringLocals(current, use);
  if (covering.length) {
    const nearest = covering[covering.length - 1]!;
    // The generic scope walker compares names exactly. Let it answer only when it can prove this
    // binding, not a same-spelled outer module member behind an equivalent -/_ local.
    const indexed =
      nearest.spelling === use.text &&
      current.defAt.has(defKey(nearest.range.start.line, nearest.range.start.column, nearest.canonical));
    return { status: "shadow", indexed };
  }
  if (use.kind === "variable" && current.unprovenFlowAssigns.has(use.canonical)) {
    return {
      status: "not_found",
      reason: "A flow-control assignment may change an imported variable",
      unproven: true,
    };
  }
  if (nestedMembers(model, current, use.kind, use.canonical).length) return nestedImportUnproven(use);
  const ownKey = `${use.kind}:${use.canonical}`;
  const own = current.ownByName.get(ownKey) ?? [];
  if (own.length > 1) {
    return { status: "not_found", reason: `More than one SCSS member matches ${use.text}`, unproven: true };
  }
  const [only] = own;
  const legacyEarly = !!only && legacyGetFunctionBeforeDeclaration(current, use, only);
  const declaredLater = !!only && memberDeclaredAfter(current, use, only);
  // A mixin or function body runs when it is invoked. A declaration later in the file may or may
  // not exist yet, so the call is not a proven reference of either side.
  if (only && declaredLater && use.deferred && !legacyEarly) {
    return { status: "not_found", reason: `A deferred call may or may not see ${use.text}`, unproven: true };
  }
  // An eager call before the declaration is plain CSS unless a preceding load already supplies the
  // name. A later `get-function` never owns an earlier call: that call is the legacy built-in.
  const ignoreOwn = legacyEarly || (declaredLater && !use.deferred);
  if (only && !ignoreOwn) {
    return { status: "ok", def: only.def, prefix: "", access: "own", filters: [] };
  }
  const before = ignoreOwn ? use.nameStart : undefined;
  if (unresolvedIntroducesMembers(current.loads, before)) {
    return { status: "not_found", reason: "An unresolved SCSS import may also define this name", unproven: true };
  }
  const found: Member[] = [];
  let incomplete = collectLoaded(model, current, use.kind, use.canonical, found, before);
  if (!found.length) {
    // `@import` runs a file inside the scope of its importer, so the file reads what the importer
    // declared and loaded. The order of the imports is not modeled.
    for (const importer of importerChain(model, current.key)) {
      if (nestedMembers(model, importer, use.kind, use.canonical).length) return nestedImportUnproven(use);
      for (const member of importer.ownByName.get(ownKey) ?? []) found.push(ownAsMember(member, true));
      if (unresolvedIntroducesMembers(importer.loads)) incomplete = true;
      if (collectLoaded(model, importer, use.kind, use.canonical, found)) incomplete = true;
    }
  }
  return choose(
    found,
    `More than one SCSS member matches ${use.text}`,
    `No SCSS member matches ${use.text}`,
    incomplete,
  );
}

type VisiblePlaceholders = {
  /** The placeholders with the name that an `@extend` in the file can reach. */
  found: Set<SymbolDef>;
  /** A load did not resolve or a loaded file could not be read, so the set may lack some. */
  unproven: boolean;
  /** The files that `@import` runs in one scope with the file: a private name stays visible there. */
  sameModule: ReadonlyMap<string, ModuleModel>;
};

/**
 * `@extend` reaches the placeholders of its module and of the modules it loads. `@import` runs a
 * file inside its importer, so the file, the files that import it, and everything they `@import`
 * are one module, where a private name stays visible. Modules loaded with `@use` or `@forward`
 * show public names only.
 */
function visiblePlaceholders(model: ProjectModel, current: ModuleModel, canonical: string): VisiblePlaceholders {
  const sameModule = new Map<string, ModuleModel>();
  for (const file of [current, ...importerChain(model, current.key)]) sameModule.set(file.key, file);
  let unproven = false;
  const importQueue = [...sameModule.values()];
  for (let next = importQueue.shift(); next; next = importQueue.shift()) {
    for (const resolved of next.loads) {
      if (resolved.load.kind !== "import" || resolved.target.type !== "file") continue;
      const key = fileIdentityKey(resolved.target.file);
      if (sameModule.has(key)) continue;
      const loaded = model.files.get(key);
      if (!loaded) {
        unproven = true;
        continue;
      }
      sameModule.set(key, loaded);
      importQueue.push(loaded);
    }
  }
  const found = new Set<SymbolDef>();
  const collect = (file: ModuleModel, publicOnly: boolean): void => {
    for (const entry of file.placeholders) {
      if (entry.declared === canonical && !(publicOnly && isPrivateName(entry.declared))) found.add(entry.def);
    }
  };
  for (const file of sameModule.values()) collect(file, false);
  const seen = new Set<string>(sameModule.keys());
  const queue = [...sameModule.values()];
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
      collect(loaded, true);
      queue.push(loaded);
    }
  }
  return { found, unproven, sameModule };
}

function resolvePlaceholder(model: ProjectModel, current: ModuleModel, use: ScssUse): ScssResolution {
  const { found, unproven, sameModule } = visiblePlaceholders(model, current, use.canonical);
  if (unproven) {
    return { status: "not_found", reason: "SCSS @extend modules were not all readable", unproven: true };
  }
  const [first, ...rest] = [...found];
  if (!first) return { status: "not_found", reason: `No SCSS placeholder matches %${use.text}` };
  if (rest.length) {
    return {
      status: "not_found",
      reason: `More than one SCSS placeholder matches %${use.text}`,
      unproven: true,
    };
  }
  const declaringKey = fileIdentityKey(first.file);
  let access: ScssAccess = "module";
  if (declaringKey === current.key) access = "own";
  else if (sameModule.has(declaringKey)) access = "import";
  return { status: "ok", def: first, prefix: "", access, filters: [] };
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
  if (use.dynamic && current.inheritedDynamics.includes(use.dynamic)) {
    return { status: "not_found", reason: "An inherited sass:meta lookup is dynamic", unproven: true };
  }
  if (use.namespace !== null) return resolveNamespaced(model, current, use, use.namespace);
  return resolveUnnamespaced(model, current, use);
}

/**
 * The member a definition declares: a top-level member, or a placeholder at any depth. Null for
 * locals, parameters, and other selectors.
 */
export async function scssMemberForDefinition(index: ProjectIndex, def: SymbolDef): Promise<ScssDeclaredMember | null> {
  const model = await projectModel(index);
  const current = model.files.get(fileIdentityKey(def.file));
  if (!current) return null;
  const at = defKey(def.range.start.line, def.range.start.column, sassCanonical(def.localName));
  if (!current.defAt.has(at)) return null;
  const member = current.own.find((entry) => entry.siteKeys.has(at));
  if (member) return member;
  const placeholder = current.placeholders.find((entry) => entry.siteKeys.has(at));
  if (placeholder) {
    return { kind: "placeholder", declared: placeholder.declared, def: placeholder.def, sites: placeholder.sites };
  }
  const joined = current.joinedAssignments.find(
    (entry) => entry.range.start.line === def.range.start.line && entry.range.start.column === def.range.start.column,
  );
  return joined?.member ?? null;
}

/**
 * True when an indexed block variable is spelled with a different mix of `-` and `_` than a use it covers.
 * The exact-name reference walk omits that use, so coverage must not claim to be complete.
 */
export function scssLocalSpellingGap(facts: ScssFileFacts, def: SymbolDef): boolean {
  if (!def.localName.startsWith("$")) return false;
  const local = facts.locals.find(
    (entry) => entry.range.start.line === def.range.start.line && entry.range.start.column === def.range.start.column,
  );
  if (!local) return false;
  return facts.uses.some(
    (use) =>
      use.kind === "variable" &&
      use.namespace === null &&
      use.canonical === local.canonical &&
      use.text !== local.spelling &&
      use.nameStart >= local.from &&
      use.nameStart < local.to,
  );
}

/** The imported variable a joined flow-control assignment names, when the click is on that assignment. */
export async function scssAssignmentDefinition(
  index: ProjectIndex,
  file: FileId,
  line: number,
  column: number,
): Promise<SymbolDef | null> {
  const model = await projectModel(index);
  const current = model.files.get(fileIdentityKey(file));
  if (!current) return null;
  const offset = scssOffsetAt(current.facts, line, column);
  if (offset < 0) return null;
  const joined = current.joinedAssignments.find((entry) => {
    const start = entry.range.start.index;
    const end = entry.range.end.index;
    return start !== undefined && end !== undefined && offset >= start && offset < end;
  });
  return joined?.member.def ?? null;
}

/** True when this indexed variable is a file-scope flow assignment that could not be joined. */
export async function scssFlowLocalUnproven(index: ProjectIndex, def: SymbolDef): Promise<boolean> {
  if (!def.localName.startsWith("$")) return false;
  const model = await projectModel(index);
  const current = model.files.get(fileIdentityKey(def.file));
  return current?.unprovenFlowAssigns.has(sassCanonical(def.localName)) ?? false;
}

function existenceNamesLocal(dynamic: ScssDynamic, canonical: string, local: ScssLocalBinding | undefined): boolean {
  if (dynamic.form !== "variable-exists") return false;
  if (dynamic.arg !== null && sassCanonical(dynamic.arg) !== canonical) return false;
  const at = dynamic.at;
  if (local && at !== undefined && (at < local.from || at >= local.to)) return false;
  return true;
}

/**
 * True when a block local, parameter, or loop variable may be the variable `variable-exists`
 * names. `global-variable-exists` does not see a block local. A proved user function is not the
 * built-in. Module members are left to {@link hasUnprovenDynamic}.
 */
export async function scssBlockLocalExistenceUnproven(index: ProjectIndex, def: SymbolDef): Promise<boolean> {
  if (!def.localName.startsWith("$")) return false;
  if (await scssMemberForDefinition(index, def)) return false;
  const model = await projectModel(index);
  const current = model.files.get(fileIdentityKey(def.file));
  if (!current) return false;
  const canonical = sassCanonical(def.localName);
  const local = current.facts.locals.find(
    (entry) => entry.range.start.line === def.range.start.line && entry.range.start.column === def.range.start.column,
  );
  for (const dynamic of current.facts.dynamics) {
    if (!existenceNamesLocal(dynamic, canonical, local)) continue;
    if (dynamic.legacyBare) {
      const resolved = await resolveScssUse(index, current.file, legacyBuiltinUse(dynamic));
      if (resolved.status === "ok" && fileIdentityKey(resolved.def.file) !== current.key) continue;
    }
    return true;
  }
  for (const use of current.facts.uses) {
    if (!use.dynamic || !current.inheritedDynamics.includes(use.dynamic)) continue;
    if (!existenceNamesLocal({ ...use.dynamic, at: use.nameStart }, canonical, local)) continue;
    return true;
  }
  return false;
}

/** Reference span for a use. Null when a forward prefix cannot be split from the member. */
export function scssUseEditRange(facts: ScssFileFacts, use: ScssUse, prefix: string): Range | null {
  const span = memberEditSpan(use.text, prefix);
  if (!span) return null;
  return scssOffsetRange(facts, use.nameStart + span.start, use.nameStart + span.end);
}

/**
 * True when `file` assigns the variable `canonical` and also loads a module that declares it with
 * `@use ... as *`. Sass then assigns the variable of the module, so one variable has declarations
 * in two files, and this scan does not join them. A namespaced `@use` keeps the variables apart.
 */
function assignsStarVariable(model: ProjectModel, file: ModuleModel, canonical: string): boolean {
  if (!file.ownByName.has(`variable:${canonical}`)) return false;
  return file.loads.some((resolved) => {
    if (resolved.target.type !== "file" || resolved.load.kind !== "use" || !resolved.load.star) return false;
    const inner = exposureOf(model, fileIdentityKey(resolved.target.file), "module", newWalk());
    return lookup(inner.byName, "variable", canonical).length > 0;
  });
}

/** True when a consumer of `file` can reach `def` through it: the file declares it, forwards it, or imports it. */
function exposesDefinition(model: ProjectModel, file: ModuleModel, def: SymbolDef): boolean {
  return (["module", "import"] as const).some((mode) =>
    exposureOf(model, file.key, mode, newWalk()).members.some((member) => member.def === def),
  );
}

/**
 * Files that can see `member`, plus files whose unresolved URL or `meta.load-css` may load the
 * declaring file. `unavailable` files were not fully proved. A directory index (`_index.scss`)
 * is also reached through the name of its directory.
 */
export async function scssReferenceCandidates(
  index: ProjectIndex,
  member: ScssDeclaredMember,
): Promise<{ files: FileId[]; unavailable: FileId[] }> {
  const def = member.def;
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
  // `@import` runs a file inside the scope of its importer, so a file that an included file
  // imports can use the member without loading the file that declares it. A target that is not
  // SCSS (plain CSS) cannot read a Sass member.
  const importQueue = [...files];
  for (let next = importQueue.shift(); next; next = importQueue.shift()) {
    for (const resolved of model.files.get(fileIdentityKey(next))?.loads ?? []) {
      if (resolved.load.kind !== "import" || resolved.target.type !== "file") continue;
      const target = resolved.target.file;
      const key = fileIdentityKey(target);
      if (seen.has(key) || !isScssFile(index, target)) continue;
      seen.add(key);
      files.push(target);
      importQueue.push(target);
    }
  }

  const unavailable: FileId[] = [];
  const unavailableKeys = new Set<string>();
  const markUnavailable = (file: FileId): void => {
    const key = fileIdentityKey(file);
    if (unavailableKeys.has(key)) return;
    unavailableKeys.add(key);
    unavailable.push(file);
  };

  // `@import` puts files in one global scope. A file there that declares the same name assigns the
  // same variable (or replaces the same mixin or function), and this scan does not follow which
  // declaration a use reads, so that file is not proved.
  if (member.kind !== "placeholder") {
    const declaringKey = fileIdentityKey(def.file);
    const sharedScope = new Set<string>([declaringKey]);
    const importerQueue = [declaringKey];
    for (let next = importerQueue.shift(); next; next = importerQueue.shift()) {
      for (const importerKey of model.importers.get(next) ?? []) {
        if (sharedScope.has(importerKey)) continue;
        sharedScope.add(importerKey);
        importerQueue.push(importerKey);
      }
    }
    const childQueue = [...sharedScope];
    for (let next = childQueue.shift(); next; next = childQueue.shift()) {
      for (const resolved of model.files.get(next)?.loads ?? []) {
        if (resolved.load.kind !== "import" || resolved.target.type !== "file") continue;
        const key = fileIdentityKey(resolved.target.file);
        if (sharedScope.has(key)) continue;
        sharedScope.add(key);
        childQueue.push(key);
      }
    }
    const ownKey = `${member.kind}:${member.declared}`;
    for (const key of sharedScope) {
      const other = model.files.get(key);
      if (key !== declaringKey && other?.ownByName.has(ownKey)) markUnavailable(other.file);
      if (member.kind === "variable" && other?.unprovenFlowAssigns.has(member.declared)) markUnavailable(other.file);
    }
  }

  // A URL can reach the member through the declaring file, or through a module that forwards or
  // imports it. Each of them gives a stem that a load of an unresolved URL can name.
  const stems = new Set<string>();
  const addStems = (file: FileId): void => {
    const stem = moduleStem(file);
    stems.add(stem);
    if (stem === "index") stems.add(moduleStem(path.dirname(file)));
  };
  addStems(def.file);
  for (const file of files) {
    const current = model.files.get(fileIdentityKey(file));
    if (current && exposesDefinition(model, current, def)) addStems(file);
  }
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
    if (unresolvedLoad || (await hasUnprovenDynamic(index, current))) markUnavailable(file);
    if (member.kind === "variable" && assignsStarVariable(model, current, member.declared)) markUnavailable(file);
  }
  return { files, unavailable };
}

export function scssUseAt(facts: ScssFileFacts, line: number, column: number): ScssUse | undefined {
  const offset = scssOffsetAt(facts, line, column);
  if (offset < 0) return undefined;
  return facts.uses.find((use) => offset >= use.hitStart && offset < use.nameEnd);
}

/**
 * Members one file sees without a namespace: its own declarations, `@use ... as *`, `@import`, and
 * the scope it inherits from the files that `@import` it.
 */
function globalScope(model: ProjectModel, current: ModuleModel, lens?: RenameLens): Member[] {
  const members: Member[] = [];
  for (const file of [current, ...importerChain(model, current.key)]) {
    for (const own of file.own) members.push(applyLens(ownAsMember(own, true), lens));
    for (const resolved of file.loads) {
      if (resolved.target.type !== "file") continue;
      const star = resolved.load.kind === "use" && resolved.load.star;
      const legacy = resolved.load.kind === "import";
      if (!star && !legacy) continue;
      const inner = exposureOf(
        model,
        fileIdentityKey(resolved.target.file),
        legacy ? "import" : "module",
        newWalk(),
        lens,
      );
      members.push(...inner.members);
    }
  }
  return members;
}

/**
 * Same-kind members that would share the new name with `def` in a scope that sees `def`: the
 * module that declares it, every module that exposes it, and every file that sees it without a
 * namespace (`@use ... as *`, `@import`). A forward prefix stays in front of the new name. A
 * placeholder has no namespace, so no file that sees it may also see another placeholder that has
 * the new name.
 */
export async function scssRenameCollisions(index: ProjectIndex, def: SymbolDef, newName: string): Promise<SymbolDef[]> {
  const model = await projectModel(index);
  const member = await scssMemberForDefinition(index, def);
  if (!member) return [];
  // Sass compares a placeholder as written and folds `_` into `-` for every other member.
  const next = member.kind === "placeholder" ? sassBare(newName) : sassCanonical(newName);
  if (next === member.declared) return [];
  const collisions = new Set<SymbolDef>();
  const { files } = await scssReferenceCandidates(index, member);
  if (member.kind === "placeholder") {
    // An `@extend` reaches the placeholders of its own scope, so each file that sees the renamed
    // placeholder is a scope where the new name must be free.
    for (const file of files) {
      const current = model.files.get(fileIdentityKey(file));
      if (!current) continue;
      for (const found of visiblePlaceholders(model, current, next).found) {
        if (found !== member.def) collisions.add(found);
      }
    }
    return [...collisions];
  }
  const check = (members: readonly Member[]): void => {
    // One declaration can be exposed under several spellings (a module that forwards it with two
    // prefixes), and each spelling takes the new name in its own place.
    for (const exposure of members) {
      if (exposure.def !== member.def) continue;
      const wanted =
        exposure.lensFrom !== undefined
          ? exposure.exposed
          : exposure.exposed.slice(0, exposure.exposed.length - member.declared.length) + next;
      for (const entry of members) {
        if (entry.kind === member.kind && entry.def !== member.def && entry.exposed === wanted) {
          collisions.add(entry.def);
        }
      }
    }
  };
  // A private member is hidden from the files that load it with `@use ... as *` or `@forward`. A
  // public member joins their scopes, so those scopes must not already use the new name.
  const becomesPublic = isPrivateName(member.declared) && !isPrivateName(next);
  const view: ProjectModel = becomesPublic ? { ...model, exposures: new Map(), unhide: member.def } : model;
  // Recompute `show` and `hide` under the new name. An entry the rename edits keeps exposing the
  // member; an entry that already spells the new name can newly expose it or hide it.
  const lens: RenameLens = { def: member.def, from: member.declared, to: next, cache: new Map() };
  for (const file of files) {
    const current = model.files.get(fileIdentityKey(file));
    if (!current) continue;
    check(exposureOf(view, current.key, "module", newWalk(), lens).members);
    check(exposureOf(view, current.key, "import", newWalk(), lens).members);
    check(globalScope(view, current, lens));
  }
  return [...collisions];
}

export type ScssMemberUse = { use: ScssUse; resolved: ScssResolved };

/**
 * The uses in `facts` that resolve to `member`, in source order. `unproven` is true when a use that
 * may name the member could not be resolved, so the file is not fully proved.
 */
export async function scssMemberUses(
  index: ProjectIndex,
  file: FileId,
  facts: ScssFileFacts,
  member: ScssDeclaredMember,
): Promise<{ matches: ScssMemberUse[]; unproven: boolean }> {
  const matches: ScssMemberUse[] = [];
  let unproven = false;
  for (const use of facts.uses) {
    if (!scssUseMayNameMember(use, member)) continue;
    const resolved = await resolveScssUse(index, file, use);
    if (resolved.status === "shadow") continue;
    if (resolved.status === "not_found") {
      if (resolved.unproven) unproven = true;
      continue;
    }
    if (sameDef(resolved.def, member.def)) matches.push({ use, resolved });
  }
  return { matches, unproven };
}

/** `with`, `show`, and `hide` name a member without reading it, so its privacy does not matter to them. */
function readsMember(use: ScssUse): boolean {
  return use.syntax !== "config" && use.syntax !== "show" && use.syntax !== "hide";
}

export type ScssRenameSite = { file: FileId; range: Range };

/**
 * The scoped mixin or function that owns a bare use at `at`.
 * Scope runs from the end of the name to the end of the containing block. The nearest same-kind
 * callable with that Sass name (`-` and `_` equivalent) wins. `renamed` treats one local as if it
 * already had a different name, which is how a rename captures calls.
 */
function nearestScopedCallable(
  facts: ScssFileFacts,
  kind: ScssCallableLocal["kind"],
  canonical: string,
  at: number,
  renamed?: { local: ScssCallableLocal; canonical: string },
): ScssCallableLocal | undefined {
  let best: ScssCallableLocal | undefined;
  for (const candidate of facts.callableLocals) {
    if (candidate.kind !== kind) continue;
    const name = renamed && candidate === renamed.local ? renamed.canonical : candidate.canonical;
    if (name !== canonical || at < candidate.from || at >= candidate.to) continue;
    if (!best || candidate.from >= best.from) best = candidate;
  }
  return best;
}

function scopedCallableLocal(facts: ScssFileFacts, def: SymbolDef): ScssCallableLocal | undefined {
  const end = def.range.end.index;
  if (end === undefined || def.kind !== SymbolKind.Function) return undefined;
  const canonical = sassCanonical(def.localName);
  return facts.callableLocals.find((candidate) => candidate.from === end && candidate.canonical === canonical);
}

const SCOPED_FUNCTION_LOOKUPS = new Set<ScssDynamicForm>(["function-exists", "get-function", "call"]);
const SCOPED_MIXIN_LOOKUPS = new Set<ScssDynamicForm>(["mixin-exists", "get-mixin"]);

/**
 * True when this lookup may name a scoped callable. A non-literal or interpolated argument may
 * be any name. `-` and `_` are the same character. `call` and `get-function` name functions;
 * `get-mixin` and `mixin-exists` name mixins.
 */
function dynamicMayNameCallable(dynamic: ScssDynamic, local: ScssCallableLocal): boolean {
  const forms = local.kind === "function" ? SCOPED_FUNCTION_LOOKUPS : SCOPED_MIXIN_LOOKUPS;
  if (!forms.has(dynamic.form)) return false;
  if (dynamic.arg === null || dynamic.arg.includes("#{")) return true;
  return sassCanonical(dynamic.arg) === local.canonical;
}

/** The lookup sits in the span where `local` is the nearest visible callable of its name. */
function lookupInCallableScope(facts: ScssFileFacts, local: ScssCallableLocal, at: number | undefined): boolean {
  if (at === undefined || at < local.from || at >= local.to) return false;
  return nearestScopedCallable(facts, local.kind, local.canonical, at) === local;
}

/**
 * A legacy bare built-in is not a lookup when a user function already owns the call: a scoped
 * function of that name, or a function proved in another file. A later declaration does not.
 */
async function legacyBuiltinOwnedByUser(
  index: ProjectIndex,
  current: ModuleModel,
  dynamic: ScssDynamic,
): Promise<boolean> {
  if (!dynamic.legacyBare) return false;
  const resolved = await resolveScssUse(index, current.file, legacyBuiltinUse(dynamic));
  if (resolved.status === "shadow") return true;
  return resolved.status === "ok" && fileIdentityKey(resolved.def.file) !== current.key;
}

/**
 * True when a dynamic lookup in the span where `def` is visible may name that scoped mixin or
 * function. Existence predicates, `call`, and `get-function` name a function; `mixin-exists` and
 * `get-mixin` name a mixin. The call is a proved `sass:meta` binding or a legacy bare built-in.
 * A lookup outside the block, or one a user function owns, does not. Static uses stay references.
 */
export async function scssScopedCallableDynamicUnproven(index: ProjectIndex, def: SymbolDef): Promise<boolean> {
  if (!isScssFile(index, def.file) || def.kind !== SymbolKind.Function) return false;
  const model = await projectModel(index);
  const current = model.files.get(fileIdentityKey(def.file));
  if (!current) return false;
  const local = scopedCallableLocal(current.facts, def);
  if (!local) return false;
  for (const dynamic of current.facts.dynamics) {
    if (!dynamicMayNameCallable(dynamic, local) || !lookupInCallableScope(current.facts, local, dynamic.at)) {
      continue;
    }
    if (await legacyBuiltinOwnedByUser(index, current, dynamic)) continue;
    return true;
  }
  for (const use of current.facts.uses) {
    if (!use.dynamic || !current.inheritedDynamics.includes(use.dynamic)) continue;
    // A bare call a scoped user function owns is that function, not the built-in.
    if (coveringCallable(current, use)) continue;
    const dynamic = use.dynamic;
    if (!dynamicMayNameCallable(dynamic, local)) continue;
    if (!lookupInCallableScope(current.facts, local, dynamic.at ?? use.nameStart)) continue;
    return true;
  }
  return false;
}

/**
 * Bare same-kind calls and includes a scoped mixin or function owns.
 * Null when `def` is not a scoped callable. `unproven` when the file cannot be scanned, so
 * coverage must not claim to be complete. A dynamic lookup that may name the callable is reported
 * separately by {@link scssScopedCallableDynamicUnproven}; these ranges stay the proved uses.
 */
export async function scssScopedCallableReferences(
  index: ProjectIndex,
  def: SymbolDef,
): Promise<{ ranges: Range[]; unproven: boolean } | null> {
  if (!isScssFile(index, def.file) || def.kind !== SymbolKind.Function) return null;
  const facts = await scssFactsForFile(index, def.file);
  if (!facts || def.range.end.index === undefined) return { ranges: [], unproven: true };
  const local = scopedCallableLocal(facts, def);
  if (!local) return null;
  const syntax = local.kind === "mixin" ? "include" : "call";
  const ranges: Range[] = [];
  for (const use of facts.uses) {
    if (use.namespace !== null || use.kind !== local.kind || use.syntax !== syntax) continue;
    if (nearestScopedCallable(facts, local.kind, use.canonical, use.nameStart) !== local) continue;
    ranges.push(scssOffsetRange(facts, use.nameStart, use.nameEnd));
  }
  return { ranges, unproven: false };
}

/**
 * A scoped callable is not a module member. `captured` lists bare calls already spelled with
 * the proposed name that this local would own, and `shadowed` lists calls this local owns when
 * a different same-kind scoped callable would own the edited name (`-` and `_` equivalent).
 * `unaccounted` lists calls of the original name that this local owns and the reference walk
 * omitted; a nearer scoped callable keeps its own calls. Null means `def` is not a scoped callable.
 */
export async function scssScopedCallableRenameSites(
  index: ProjectIndex,
  def: SymbolDef,
  newName: string,
  references: readonly Reference[],
): Promise<{
  captured: ScssRenameSite[];
  shadowed: ScssRenameSite[];
  unaccounted: Array<ScssRenameSite & { text: string }>;
} | null> {
  const model = await projectModel(index);
  const current = model.files.get(fileIdentityKey(def.file));
  if (!current) return null;
  const local = scopedCallableLocal(current.facts, def);
  if (!local) return null;
  const next = sassCanonical(newName);
  const syntax = local.kind === "mixin" ? "include" : "call";
  const covered = new Set<number>();
  for (const reference of references) {
    if (fileIdentityKey(reference.file) === current.key && reference.range.start.index !== undefined) {
      covered.add(reference.range.start.index);
    }
  }
  const captured: ScssRenameSite[] = [];
  const shadowed: ScssRenameSite[] = [];
  const unaccounted: Array<ScssRenameSite & { text: string }> = [];
  const renamed = { local, canonical: next };
  for (const use of current.facts.uses) {
    if (use.namespace !== null || use.kind !== local.kind || use.syntax !== syntax) continue;
    const range = scssOffsetRange(current.facts, use.nameStart, use.nameEnd);
    const ownedByLocal =
      use.canonical === local.canonical &&
      nearestScopedCallable(current.facts, local.kind, local.canonical, use.nameStart) === local;
    if (
      next !== local.canonical &&
      use.canonical === next &&
      nearestScopedCallable(current.facts, local.kind, next, use.nameStart, renamed) === local
    ) {
      captured.push({ file: current.file, range });
    }
    // The edited reference keeps this local's place. A nearer same-kind callable of the new
    // name, including an equivalent `-`/`_` spelling, would own the call instead.
    if (ownedByLocal && next !== local.canonical) {
      const owner = nearestScopedCallable(current.facts, local.kind, next, use.nameStart, renamed);
      if (owner && owner !== local) shadowed.push({ file: current.file, range });
    }
    if (ownedByLocal && !covered.has(use.nameStart)) {
      unaccounted.push({ file: current.file, range, text: use.text });
    }
  }
  return { captured, shadowed, unaccounted };
}

/** True when a file that sees `def` forwards it through a `show` or `hide` list. */
function isForwardedThroughList(model: ProjectModel, files: readonly FileId[], def: SymbolDef): boolean {
  return files.some((file) => {
    const current = model.files.get(fileIdentityKey(file));
    if (!current?.loads.some(({ load }) => load.kind === "forward" && (load.show || load.hide))) return false;
    return exposureOf(model, current.key, "module", newWalk()).members.some(
      (entry) => entry.def === def && entry.filters.length > 0,
    );
  });
}

/**
 * True when a `hide` list on the path of a use names the member under its new name. A `show` list
 * and a `hide` list that name the member today are edited with it, so only another entry can hide
 * the new name.
 */
function hidesRenamedMember(filters: readonly ScssForwardFilter[], member: ScssDeclaredMember, next: string): boolean {
  return filters.some(({ load, exposed }) => {
    const renamed = exposed.slice(0, exposed.length - member.declared.length) + next;
    return (load.hide ?? []).some(
      (entry) => (entry.kind === "variable") === (member.kind === "variable") && sassCanonical(entry.name) === renamed,
    );
  });
}

/**
 * The uses that the new name would break.
 * - A block variable captures a bare variable use, or a scoped mixin/function captures a bare
 *   include/call, when its same-kind name matches the forward prefix plus the proposed name.
 *   A namespaced use cannot be captured.
 * - A name that starts with `-` or `_` is private to its module, so a use through `@use` or
 *   `@forward` could no longer reach it. `@import` and the declaring file keep access.
 * - A `@forward` with a `hide` list that names the new name (with the forward prefix) hides the
 *   member from the use that reads it through that forward.
 */
export async function scssRenameUseConflicts(
  index: ProjectIndex,
  def: SymbolDef,
  newName: string,
): Promise<{ captured: ScssRenameSite[]; inaccessible: ScssRenameSite[]; hidden: ScssRenameSite[] }> {
  const captured: ScssRenameSite[] = [];
  const inaccessible: ScssRenameSite[] = [];
  const hidden: ScssRenameSite[] = [];
  const member = await scssMemberForDefinition(index, def);
  if (!member) return { captured, inaccessible, hidden };
  const next = sassCanonical(newName);
  if (next === member.declared) return { captured, inaccessible, hidden };
  const becomesPrivate = isPrivateName(next) && !isPrivateName(member.declared);
  const canBeCaptured = member.kind !== "placeholder";
  // A placeholder is in no `show` or `hide` list, so only a private name can break its uses.
  if (member.kind === "placeholder" && !becomesPrivate) return { captured, inaccessible, hidden };
  const model = await projectModel(index);
  const { files } = await scssReferenceCandidates(index, member);
  const mayBeHidden = isForwardedThroughList(model, files, member.def);
  if (!canBeCaptured && !becomesPrivate && !mayBeHidden) return { captured, inaccessible, hidden };
  for (const file of files) {
    const current = model.files.get(fileIdentityKey(file));
    if (!current) continue;
    const { matches } = await scssMemberUses(index, file, current.facts, member);
    for (const { use, resolved } of matches) {
      const range = scssUseEditRange(current.facts, use, resolved.prefix);
      if (!range) continue;
      if (canBeCaptured && use.namespace === null) {
        const spelled = sassCanonical(resolved.prefix) + next;
        if (member.kind === "variable" && use.syntax === "variable") {
          const bindings = current.localsByName.get(spelled);
          if (bindings?.some((binding) => use.nameStart >= binding.from && use.nameStart < binding.to)) {
            captured.push({ file, range });
          }
        } else if (
          (use.syntax === "call" || use.syntax === "include") &&
          current.facts.callableLocals.some(
            (local) =>
              local.kind === member.kind &&
              local.canonical === spelled &&
              use.nameStart >= local.from &&
              use.nameStart < local.to,
          )
        ) {
          captured.push({ file, range });
        }
      }
      if (becomesPrivate && resolved.access === "module" && readsMember(use)) inaccessible.push({ file, range });
      if (mayBeHidden && readsMember(use) && hidesRenamedMember(resolved.filters, member, next)) {
        hidden.push({ file, range });
      }
    }
  }
  return { captured, inaccessible, hidden };
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

/**
 * The name an SCSS edit writes for a rename request. The symbol keeps its sigil, so a request of
 * `y` for `$x` writes `$y`, and the conflict checks must look for that spelling.
 */
export function scssRenamedName(localName: string, newName: string): string {
  return scssReplacementText(localName, localName, newName) ?? newName;
}
