import fsp from "node:fs/promises";
import type { ParsedFileContext } from "../indexer/parse-context.js";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import { extractAngularJsFileFacts, type AngularJsFileFacts } from "../frameworks/angularjs.js";
import type { ModuleIndex } from "../indexer/types.js";
import type { Edge } from "../types.js";
import { uniqueEdgePusher } from "../util/graph-edges.js";
import { fileIdentityKey } from "../util/paths.js";
import { resolveSpecifier } from "../util/resolution.js";
import { type WorkspaceConfig } from "../util/workspace.js";

type AngularJsFileContext = {
  file: string;
  facts: AngularJsFileFacts;
};

// Languages whose source can hold AngularJS registrations. `.jsx`, `.mjs`, and `.cjs` resolve
// to `js`, so filtering on the resolved language covers every JS-family file instead of a
// literal-extension list.
const ANGULAR_JS_LANGUAGE_IDS = new Set(["js", "ts", "tsx"]);

export async function collectAngularJsFrameworkEdges(
  projectRoot: string,
  files: string[],
  workspaceConfig: WorkspaceConfig | undefined,
  parsed?: Map<string, ParsedFileContext>,
  modules?: Iterable<Pick<ModuleIndex, "file" | "angularJsFacts">>,
): Promise<Edge[]> {
  const contexts: AngularJsFileContext[] = [];
  if (modules) {
    for (const module of modules) {
      if (module.angularJsFacts) contexts.push({ file: module.file, facts: module.angularJsFacts });
    }
  } else {
    for (const file of files) {
      const support = supportForFileWithoutHeaderSample(file);
      if (!support || !ANGULAR_JS_LANGUAGE_IDS.has(support.id)) continue;
      let source = parsed?.get(fileIdentityKey(file))?.source;
      if (source === undefined) {
        try {
          source = await fsp.readFile(file, "utf8");
        } catch {
          continue;
        }
      }
      const facts = extractAngularJsFileFacts(source);
      if (facts) contexts.push({ file, facts });
    }
  }
  if (!contexts.length) return [];

  const registrationFilesByName = new Map<string, Set<string>>();
  for (const context of contexts) {
    for (const registration of context.facts.registrations) {
      let filesForName = registrationFilesByName.get(registration.name);
      if (!filesForName) {
        filesForName = new Set<string>();
        registrationFilesByName.set(registration.name, filesForName);
      }
      filesForName.add(context.file.replace(/\\/g, "/"));
    }
  }

  const edges: Edge[] = [];
  const pushEdge = uniqueEdgePusher(edges);

  for (const context of contexts) {
    const normalizedFile = context.file.replace(/\\/g, "/");
    const references = context.facts.references;
    for (const reference of references) {
      if (reference.kind === "templateUrl") {
        const resolved = await resolveSpecifier(context.file, reference.value, projectRoot, undefined, workspaceConfig);
        pushEdge({
          from: normalizedFile,
          to:
            typeof resolved === "string"
              ? { type: "file", path: resolved.replace(/\\/g, "/") }
              : { type: "external", name: resolved.external },
          raw: reference.value,
          resolved: "heuristic",
          confidence: 0.9,
        });
        continue;
      }

      const resolvedFiles = registrationFilesByName.get(reference.value);
      if (resolvedFiles && resolvedFiles.size > 0) {
        for (const targetFile of resolvedFiles) {
          if (targetFile === normalizedFile) continue;
          pushEdge({
            from: normalizedFile,
            to: { type: "file", path: targetFile },
            raw: reference.value,
            resolved: "heuristic",
            confidence: reference.kind === "controller" ? 0.9 : 0.8,
          });
        }
        continue;
      }

      pushEdge({
        from: normalizedFile,
        to: { type: "external", name: reference.value },
        raw: reference.value,
        resolved: "heuristic",
        confidence: reference.kind === "controller" ? 0.75 : 0.7,
      });
    }
  }

  return edges;
}
