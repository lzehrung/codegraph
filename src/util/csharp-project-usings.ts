import fsp from "node:fs/promises";
import path from "node:path";
import { HTML_SUPPORT, supportForFileWithoutHeaderSample, type LanguageExtensionMap } from "../languages.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import { fileIdentityKey, isPhysicalPathWithinRoot, normalizePath } from "./paths.js";
import {
  CSHARP_PACKAGE_MANIFEST_NAMES,
  findNearestManifest,
  type ManifestDirectoryListings,
} from "./resolution/files.js";
import { parseSyntaxTree } from "./syntax-tree.js";
import { mapLimit } from "./concurrency.js";
import { currentProbeCache, type FsProbeCache } from "./fs-probe-cache.js";

export type CsharpProjectUsing = { from: string; alias?: string; isStatic: boolean; remove?: boolean };
/** Own-file MSBuild facts. File paths are project-relative, including in persisted snapshots. */
export type CsharpProjectUsingFacts = { file: string; directives: CsharpProjectUsing[]; signature?: string };

const XML_ATTRIBUTE_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const manifestDiscoveries = new WeakMap<FsProbeCache, { id: number; scopes: Map<string, Promise<string[]>> }>();

/** The nearest project and SDK-imported props file for each indexed C# directory. */
export async function csharpProjectUsingFiles(
  projectRoot: string,
  files: readonly string[],
  languageExtensions?: LanguageExtensionMap,
  directoryListings?: ManifestDirectoryListings,
): Promise<string[]> {
  const directories = new Map<string, string>();
  for (const file of files) {
    if (supportForFileWithoutHeaderSample(file, languageExtensions)?.id !== "csharp") continue;
    const directory = path.dirname(file);
    directories.set(fileIdentityKey(directory), directory);
  }
  const probes = currentProbeCache();
  let cached = probes && manifestDiscoveries.get(probes);
  if (probes && cached?.id !== probes.id) {
    cached = { id: probes.id, scopes: new Map() };
    manifestDiscoveries.set(probes, cached);
  }
  const key = `${fileIdentityKey(projectRoot)}\0${[...directories.keys()].sort().join("\0")}`;
  const previous = cached?.scopes.get(key);
  if (previous) return await previous;
  const discovery = discoverCsharpProjectUsingFiles(projectRoot, directories.values(), directoryListings);
  cached?.scopes.set(key, discovery);
  return await discovery;
}

async function discoverCsharpProjectUsingFiles(
  projectRoot: string,
  directories: Iterable<string>,
  directoryListings?: ManifestDirectoryListings,
): Promise<string[]> {
  const manifests = new Set<string>();
  const nearest = new Map<string, string | null>();
  const confined = new Map<string, Promise<boolean>>();
  const isConfined = (file: string): Promise<boolean> => {
    let result = confined.get(file);
    if (!result) {
      result = isPhysicalPathWithinRoot(projectRoot, file);
      confined.set(file, result);
    }
    return result;
  };
  await mapLimit([...directories], 16, async (directory) => {
    const manifest = await findNearestManifest(
      directory,
      projectRoot,
      CSHARP_PACKAGE_MANIFEST_NAMES,
      nearest,
      directoryListings,
    );
    if (!manifest || !(await isConfined(manifest))) return;
    manifests.add(manifest);
    const props = await findNearestManifest(path.dirname(manifest), projectRoot, ["Directory.Build.props"], nearest);
    if (props && (await isConfined(props))) manifests.add(props);
  });
  return [...manifests].sort();
}

/** Decode XML's five named entities and numeric character references inside an already parsed attribute value. */
function decodeXmlAttribute(value: string): string | undefined {
  if (!value.includes("&")) return value;
  let invalid = false;
  const decoded = value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/gu, (entity, name: string) => {
    if (!name.startsWith("#")) return XML_ATTRIBUTE_ENTITIES[name] ?? entity;
    const hexadecimal = name.startsWith("#x");
    const codePoint = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    const validScalar = codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
    if (validScalar) return String.fromCodePoint(codePoint);
    invalid = true;
    return entity;
  });
  // An invalid reference's semicolon must not become an MSBuild item separator.
  return invalid ? undefined : decoded;
}

function attributes(tag: SyntaxNodeLike): Map<string, string> | undefined {
  const result = new Map<string, string>();
  for (const child of tag.namedChildren) {
    if (child.type !== "attribute") continue;
    const name = child.namedChildren.find((node) => node.type === "attribute_name")?.text;
    const quoted = child.namedChildren.find((node) => node.type === "quoted_attribute_value");
    const value = quoted?.namedChildren.find((node) => node.type === "attribute_value")?.text;
    if (!name || value === undefined) continue;
    const decoded = decodeXmlAttribute(value);
    if (decoded === undefined) return undefined;
    result.set(name, decoded);
  }
  return result;
}

/** The HTML grammar recovers an XML declaration as one leading document-level error node. */
function isXmlDeclaration(node: SyntaxNodeLike): boolean {
  if (node.parent?.type !== "document") return false;
  if (node.parent.namedChildren[0]?.id !== node.id) return false;
  return node.text.startsWith("<?xml ") && node.text.endsWith("?>");
}

/** Literal Alias/Static child metadata overrides attributes, as it does in SDK Using items. */
function usingMetadata(node: SyntaxNodeLike, values: Map<string, string>): boolean {
  for (const child of node.namedChildren) {
    if (child.type !== "element") continue;
    const tag = child.namedChildren.find((part) => part.type === "start_tag" || part.type === "self_closing_tag");
    const name = tag?.namedChildren.find((part) => part.type === "tag_name")?.text;
    if (!tag || (name !== "Alias" && name !== "Static")) return false;
    if (tag.namedChildren.some((part) => part.type === "attribute")) return false;
    let text = "";
    for (const part of child.namedChildren) {
      if (part.id === tag.id || part.type === "end_tag" || part.type === "comment") continue;
      if (part.type !== "text" && part.type !== "entity") return false;
      text += part.text;
    }
    const decoded = decodeXmlAttribute(text);
    if (decoded === undefined) return false;
    const value = decoded.trim();
    if (value.includes("$") || value.includes("@(")) return false;
    values.set(name, value);
  }
  return true;
}

/** Read literal, unconditional Using items from the native HTML tree's XML-compatible element nodes. */
export function collectCsharpProjectUsings(source: string): CsharpProjectUsing[] {
  const tree = parseSyntaxTree(source, HTML_SUPPORT).tree;
  if (!tree) return [];
  const directives: CsharpProjectUsing[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "ERROR") return;
    if (node.type === "element") {
      const tag = node.namedChildren.find((child) => child.type === "start_tag" || child.type === "self_closing_tag");
      if (!tag) return;
      const name = tag.namedChildren.find((child) => child.type === "tag_name")?.text;
      const values = attributes(tag);
      if (!values) return;
      if (values.has("Condition")) return;
      if (name === "Using") {
        if (!usingMetadata(node, values)) return;
        const includes = values.get("Include");
        const removes = values.get("Remove");
        const items = includes ?? removes;
        const alias = values.get("Alias")?.trim();
        if (!items) return;
        const needsBuildEvaluation = items.includes("$") || items.includes("@(");
        if (needsBuildEvaluation) return;
        for (const item of items.split(";")) {
          const from = item.trim();
          if (!from) continue;
          directives.push({
            from,
            ...(alias ? { alias } : {}),
            isStatic: values.get("Static")?.toLowerCase() === "true",
            ...(removes !== undefined ? { remove: true } : {}),
          });
        }
        return;
      }
      if (name !== "Project" && name !== "ItemGroup") return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  return directives;
}

/** Module-affecting project configuration, excluding query-time Using items and their empty containers. */
export function csharpProjectConfigurationWithoutUsings(source: string): string | undefined {
  const tree = parseSyntaxTree(source, HTML_SUPPORT).tree;
  if (!tree) return source;
  let malformed = false;
  const visit = (node: SyntaxNodeLike): unknown => {
    if (node.type === "ERROR") {
      if (isXmlDeclaration(node)) return null;
      malformed = true;
      return null;
    }
    if (node.type === "element") {
      const tag = node.namedChildren.find((child) => child.type === "start_tag" || child.type === "self_closing_tag");
      const name = tag?.namedChildren.find((child) => child.type === "tag_name")?.text;
      if (!tag || !name) {
        malformed = true;
        return null;
      }
      if (name === "Using") return null;
      const children: unknown[] = [];
      for (const child of node.namedChildren) {
        if (child.id === tag.id || child.type === "end_tag") continue;
        const value = visit(child);
        if (value !== null) children.push(value);
      }
      const attributeValues = attributes(tag);
      if (!attributeValues) {
        malformed = true;
        return null;
      }
      const values = [...attributeValues];
      if (!children.length && name === "ItemGroup") return null;
      if (!children.length && !values.length && name === "Project") return null;
      return [name, values, children];
    }
    if (!node.namedChildren.length) return node.text.trim() ? node.text : null;
    const children = node.namedChildren.map(visit).filter((value) => value !== null);
    return children.length ? [node.type, children] : null;
  };
  const configuration = visit(tree.rootNode);
  if (malformed) return source;
  return configuration === null ? undefined : JSON.stringify(configuration);
}

export async function readCsharpProjectUsingFacts(
  projectRoot: string,
  files: readonly string[],
  languageExtensions?: LanguageExtensionMap,
  previousFacts: readonly CsharpProjectUsingFacts[] = [],
): Promise<CsharpProjectUsingFacts[]> {
  const previousByFile = new Map<string, CsharpProjectUsingFacts>();
  for (const fact of previousFacts) previousByFile.set(fact.file, fact);
  const manifests = await csharpProjectUsingFiles(projectRoot, files, languageExtensions);
  return await mapLimit(manifests, 16, async (file) => {
    const relative = normalizePath(path.relative(projectRoot, file));
    const stat = await fsp.stat(file);
    const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.dev}:${stat.ino}`;
    const previous = previousByFile.get(relative);
    if (previous?.signature === signature) return previous;
    const source = await fsp.readFile(file, "utf8");
    return { file: relative, directives: collectCsharpProjectUsings(source), signature };
  });
}

/** Stat signatures validate own-file freshness, but do not change semantic snapshot identity. */
export function csharpProjectUsingFactsIdentity(facts: readonly CsharpProjectUsingFacts[] = []): string {
  return JSON.stringify(facts.map((fact) => ({ file: fact.file, directives: fact.directives })));
}

export function sameCsharpProjectUsingFacts(
  current: readonly CsharpProjectUsingFacts[],
  previous: readonly CsharpProjectUsingFacts[],
): boolean {
  if (current.length !== previous.length) return false;
  for (let at = 0; at < current.length; at += 1) {
    const fact = current[at]!;
    const before = previous[at]!;
    if (fact === before) continue;
    if (fact.file !== before.file) return false;
    if (JSON.stringify(fact.directives) !== JSON.stringify(before.directives)) return false;
  }
  return true;
}

export function isCsharpProjectUsing(value: unknown): value is CsharpProjectUsing {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CsharpProjectUsing>;
  return (
    typeof item.from === "string" &&
    typeof item.isStatic === "boolean" &&
    (item.remove === undefined || typeof item.remove === "boolean") &&
    (item.alias === undefined || typeof item.alias === "string")
  );
}

export function isCsharpProjectUsingFacts(value: unknown): value is CsharpProjectUsingFacts {
  if (!value || typeof value !== "object") return false;
  const facts = value as Partial<CsharpProjectUsingFacts>;
  return (
    typeof facts.file === "string" &&
    Array.isArray(facts.directives) &&
    facts.directives.every(isCsharpProjectUsing) &&
    (facts.signature === undefined || typeof facts.signature === "string")
  );
}
