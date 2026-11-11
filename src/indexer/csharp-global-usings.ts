import path from "node:path";
import { fileIdentityKey, isFilePathWithinRoot } from "../util/paths.js";
import { normalizeCsharpIdentifier, normalizeCsharpQualifiedName } from "../util/identifiers.js";
import type { CsharpProjectUsing } from "../util/csharp-project-usings.js";
import { getCompilationUnitPeers } from "./compilation-units.js";
import type { ImportBinding, ModuleIndex, ProjectIndex } from "./types.js";
import { CSHARP_PACKAGE_MANIFEST_NAMES, resolveNearestManifestRootSync } from "../util/resolution/files.js";
import { csharpTypeNameWithArity } from "../util/csharp-tree.js";

const sourceBindings = new WeakMap<ImportBinding, ImportBinding>();
const namespaceFiles = new WeakMap<ImportBinding, string[]>();
const namespaceTypes = new WeakMap<ImportBinding, ReadonlyMap<string, readonly string[]>>();
const normalizedNamespaces = new WeakMap<ImportBinding, string>();

type GlobalImportLookup = {
  ordinary: readonly ImportBinding[];
  byType: ReadonlyMap<string, readonly ImportBinding[]>;
  combined: Map<string, readonly ImportBinding[]>;
};
const globalImportLookups = new WeakMap<readonly ImportBinding[], GlobalImportLookup>();

/** A projected binding retains the original directive's namespace dependency edges, not its source positions. */
export function csharpGlobalUsingSource(binding: ImportBinding): ImportBinding {
  return sourceBindings.get(binding) ?? binding;
}

export function csharpProjectUsingNamespaceFiles(binding: ImportBinding): readonly string[] | undefined {
  return namespaceFiles.get(binding) ?? namespaceFiles.get(csharpGlobalUsingSource(binding));
}

/** Namespace imports expose only their declared top-level types; absent names never need a directory export scan. */
export function csharpGlobalNamespaceMayExport(binding: ImportBinding, name: string, arity = 0): boolean {
  if (!binding.csharpGlobal || binding.kind !== "star" || binding.staticMembersOf) return true;
  if (name.includes(".") || name.startsWith("global::")) return true;
  const types = namespaceTypes.get(binding) ?? namespaceTypes.get(csharpGlobalUsingSource(binding));
  return !types || types.has(csharpTypeNameWithArity(normalizeCsharpIdentifier(name), arity));
}

/** Normalize each source binding once; projected copies keep the same namespace identity. */
export function csharpImportNamespace(binding: ImportBinding): string {
  const source = csharpGlobalUsingSource(binding);
  let name = normalizedNamespaces.get(source);
  if (name === undefined) {
    name = normalizeCsharpQualifiedName(source.from).replace(/^global::/u, "");
    normalizedNamespaces.set(source, name);
  }
  return name;
}

/** Known declaring files for the outer type of a qualified namespace lookup. */
export function csharpGlobalTypeFiles(
  binding: ImportBinding,
  lookupName: string,
  arity = 0,
): readonly string[] | undefined {
  const source = csharpGlobalUsingSource(binding);
  const types = namespaceTypes.get(source);
  if (!types) return undefined;
  const prefix = `${csharpImportNamespace(source)}.`;
  const qualified = normalizeCsharpQualifiedName(lookupName).replace(/^global::/u, "");
  if (!qualified.startsWith(prefix)) return undefined;
  const relative = qualified.slice(prefix.length);
  const separator = relative.indexOf(".");
  const outer = separator < 0 ? relative : relative.slice(0, separator);
  return types.get(csharpTypeNameWithArity(outer, separator < 0 ? arity : 0));
}

/** A view's ordinary imports plus only global namespace directives declaring this simple type. */
export function csharpImportsForName(mod: ModuleIndex, name: string, arity = 0): readonly ImportBinding[] {
  const lookup = globalImportLookups.get(mod.imports);
  if (!lookup || name.includes(".") || name.startsWith("global::")) return mod.imports;
  const key = csharpTypeNameWithArity(name, arity);
  const globals = lookup.byType.get(key);
  if (!globals) return lookup.ordinary;
  if (!lookup.ordinary.length) return globals;
  let combined = lookup.combined.get(key);
  if (!combined) {
    combined = [...lookup.ordinary, ...globals];
    lookup.combined.set(key, combined);
  }
  return combined;
}

function buildGlobalNamespaceIndex(globals: readonly ImportBinding[]): {
  bindings: ReadonlyMap<ImportBinding, ImportBinding>;
  byType: ReadonlyMap<string, readonly ImportBinding[]>;
} {
  const bindings = new Map<ImportBinding, ImportBinding>();
  const byType = new Map<string, ImportBinding[]>();
  for (const original of globals) {
    if (original.kind !== "star" || original.staticMembersOf) continue;
    const types = namespaceTypes.get(original);
    if (!types) continue;
    const binding = { ...original };
    delete binding.csharpDirectiveStartIndex;
    sourceBindings.set(binding, original);
    bindings.set(original, binding);
    for (const name of types.keys()) {
      const matches = byType.get(name);
      if (matches) matches.push(binding);
      else byType.set(name, [binding]);
    }
  }
  return { bindings, byType };
}

function cacheImportLookup(
  imports: readonly ImportBinding[],
  byType: ReadonlyMap<string, readonly ImportBinding[]>,
): void {
  const ordinary: ImportBinding[] = [];
  for (const binding of imports) {
    const types = namespaceTypes.get(csharpGlobalUsingSource(binding));
    const namespaceGlobal = binding.csharpGlobal && binding.kind === "star" && !binding.staticMembersOf;
    if (!namespaceGlobal || !types) ordinary.push(binding);
  }
  if (ordinary.length !== imports.length) {
    globalImportLookups.set(imports, { ordinary, byType, combined: new Map() });
  }
}

function projectBinding(
  directive: CsharpProjectUsing,
  modules: readonly ModuleIndex[],
  typeLookupComplete = true,
): ImportBinding {
  const name = normalizeCsharpQualifiedName(directive.from).replace(/^global::/u, "");
  const namespaces: string[] = [];
  const types: string[] = [];
  const importedTypes = new Map<string, string[]>();
  const namespacePrefix = `${name}.`;
  for (const mod of modules) {
    if (mod.csharpNamespaceFacts?.regions.some((region) => region.name === name)) namespaces.push(mod.file);
    if (mod.csharpNamespaceFacts?.types.includes(name)) types.push(mod.file);
    for (const type of mod.csharpNamespaceFacts?.types ?? []) {
      if (!type.startsWith(namespacePrefix)) continue;
      const simple = type.slice(namespacePrefix.length);
      if (simple.includes(".")) continue;
      const files = importedTypes.get(simple);
      if (files) files.push(mod.file);
      else importedTypes.set(simple, [mod.file]);
    }
  }
  const typeFile = typeLookupComplete && types.length === 1 ? types[0]! : undefined;
  const external = { external: directive.from };
  let binding: ImportBinding;
  if (directive.alias && namespaces.length) {
    binding = {
      kind: "namespace",
      localNS: directive.alias,
      from: directive.from,
      resolved: namespaces[0]!,
      explicitAlias: true,
    };
  } else if (directive.alias) {
    binding = {
      kind: "named",
      local: directive.alias,
      imported: name.slice(name.lastIndexOf(".") + 1),
      from: directive.from,
      resolved: typeFile ?? external,
      explicitAlias: true,
    };
  } else if (directive.isStatic) {
    binding = { kind: "star", from: directive.from, resolved: typeFile ?? external, staticMembersOf: name };
  } else {
    binding = { kind: "star", from: directive.from, resolved: namespaces[0] ?? external };
  }
  binding.csharpGlobal = directive;
  normalizedNamespaces.set(binding, name);
  if (namespaces.length) namespaceFiles.set(binding, namespaces);
  namespaceTypes.set(binding, importedTypes);
  return binding;
}

function projectMetadataBindings(
  index: ProjectIndex,
  modules: readonly ModuleIndex[],
  complete: boolean,
): ImportBinding[] {
  const root = index.projectRoot;
  const facts = index.csharpProjectUsings;
  if (!root || !modules.length || !facts?.length) return [];
  const boundary = resolveNearestManifestRootSync(root, modules[0]!.file, CSHARP_PACKAGE_MANIFEST_NAMES);
  const selected = [];
  let nearestProps: (typeof facts)[number] | undefined;
  let propsDepth = -1;
  for (const fact of facts) {
    const file = path.resolve(root, fact.file);
    const directory = path.dirname(file);
    if (file.toLowerCase().endsWith(".csproj")) {
      if (fileIdentityKey(directory) === fileIdentityKey(boundary)) selected.push(fact);
      continue;
    }
    const applies =
      fileIdentityKey(directory) === fileIdentityKey(boundary) || isFilePathWithinRoot(directory, boundary);
    if (applies && directory.length > propsDepth) {
      nearestProps = fact;
      propsDepth = directory.length;
    }
  }
  if (nearestProps) selected.unshift(nearestProps);
  const directives: CsharpProjectUsing[] = [];
  for (const fact of selected) {
    for (const directive of fact.directives) {
      if (!directive.remove) {
        directives.push(directive);
        continue;
      }
      for (let at = directives.length - 1; at >= 0; at -= 1) {
        if (directives[at]!.from === directive.from) directives.splice(at, 1);
      }
    }
  }
  return directives.map((directive) => projectBinding(directive, modules, complete));
}

type GlobalUsingViews = {
  source: ProjectIndex["byFile"];
  size: number;
  views: Map<ModuleIndex, ModuleIndex>;
  hasGlobals: boolean;
};
const globalUsingViews = new WeakMap<ProjectIndex, GlobalUsingViews>();

function hasGlobalUsings(index: ProjectIndex): boolean {
  if (index.csharpProjectUsings?.some((fact) => fact.directives.length)) return true;
  for (const module of index.byFile.values()) {
    if (module.imports.some((binding) => binding.csharpGlobal)) return true;
  }
  return false;
}

/**
 * Read-only query view: own imports plus global directives from this compilation. Cached modules keep only
 * their own directives, so changing another file never leaves cross-file facts in a memory or disk cache.
 */
export function withCsharpGlobalUsings(index: ProjectIndex, mod: ModuleIndex): ModuleIndex {
  if (!mod.csharpNamespaceFacts) return mod;
  let cached = globalUsingViews.get(index);
  if (!cached || cached.source !== index.byFile || cached.size !== index.byFile.size) {
    cached = { source: index.byFile, size: index.byFile.size, views: new Map(), hasGlobals: hasGlobalUsings(index) };
    globalUsingViews.set(index, cached);
  }
  if (!cached.hasGlobals) return mod;
  const previous = cached.views.get(mod);
  if (previous) return previous;
  const peers = getCompilationUnitPeers(index, mod.file, { csharpProject: true });
  const modules = [...peers.files].flatMap((file) => {
    const peer = index.byFile.get(fileIdentityKey(file));
    return peer ? [peer] : [];
  });
  const globals: ImportBinding[] = [];
  const resolvedGlobals = new Map<ImportBinding, ImportBinding>();
  for (const peer of modules) {
    for (const original of peer.imports) {
      if (!original.csharpGlobal) continue;
      const resolved = projectBinding(original.csharpGlobal, modules, peers.complete && !peer.importLookupIncomplete);
      const binding = { ...original, ...resolved };
      normalizedNamespaces.set(binding, csharpImportNamespace(resolved));
      const files = namespaceFiles.get(resolved);
      if (files) namespaceFiles.set(binding, files);
      const types = namespaceTypes.get(resolved);
      if (types) namespaceTypes.set(binding, types);
      resolvedGlobals.set(original, binding);
      globals.push(binding);
    }
  }
  globals.push(...projectMetadataBindings(index, modules, peers.complete));
  if (!globals.length) {
    for (const peer of modules) cached.views.set(peer, peer);
    return mod;
  }
  const namespaceIndex = buildGlobalNamespaceIndex(globals);
  for (const peer of modules) {
    const imports = peer.imports.map((binding) => {
      const resolved = resolvedGlobals.get(binding) ?? binding;
      return namespaceIndex.bindings.get(resolved) ?? resolved;
    });
    for (const original of globals) {
      const shared = namespaceIndex.bindings.get(original);
      if (shared) {
        if (!imports.includes(shared)) imports.push(shared);
        continue;
      }
      if (imports.includes(original)) continue;
      const binding = { ...original };
      if (binding.kind === "star") delete binding.csharpDirectiveStartIndex;
      else {
        delete binding.localRange;
        if (binding.kind === "named") delete binding.importedRange;
      }
      sourceBindings.set(binding, original);
      imports.push(binding);
    }
    cacheImportLookup(imports, namespaceIndex.byType);
    const view = imports.length === peer.imports.length && !resolvedGlobals.size ? peer : { ...peer, imports };
    cached.views.set(peer, view);
    cached.views.set(view, view);
  }
  return cached.views.get(mod) ?? mod;
}
