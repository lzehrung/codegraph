import fsp from "node:fs/promises";
import type { ParsedFileContext } from "../indexer/parse-context.js";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import { extractAngularJsReferences, extractAngularJsRegistrations } from "../frameworks/angularjs.js";
import type { Edge } from "../types.js";
import { fileIdentityKey } from "../util/paths.js";
import { resolveSpecifier } from "../util/resolution.js";
import { type WorkspaceConfig } from "../util/workspace.js";

type AngularJsFileContext = {
  file: string;
  source: string;
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
): Promise<Edge[]> {
  const jsFiles = files.filter((file) => {
    const support = supportForFileWithoutHeaderSample(file);
    return support !== undefined && ANGULAR_JS_LANGUAGE_IDS.has(support.id);
  });
  if (!jsFiles.length) return [];

  const contexts: AngularJsFileContext[] = [];
  for (const file of jsFiles) {
    const parsedSource = parsed?.get(fileIdentityKey(file))?.source;
    if (parsedSource !== undefined) {
      contexts.push({ file, source: parsedSource });
      continue;
    }

    try {
      const source = await fsp.readFile(file, "utf8");
      contexts.push({ file, source });
    } catch {
      continue;
    }
  }

  const registrationFilesByName = new Map<string, Set<string>>();
  for (const context of contexts) {
    for (const registration of extractAngularJsRegistrations(context.source)) {
      let filesForName = registrationFilesByName.get(registration.name);
      if (!filesForName) {
        filesForName = new Set<string>();
        registrationFilesByName.set(registration.name, filesForName);
      }
      filesForName.add(context.file.replace(/\\/g, "/"));
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  const pushEdge = (edge: Edge): void => {
    const key = `${edge.from}::${edge.raw}::${edge.to.type === "file" ? edge.to.path : `external:${edge.to.name}`}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  for (const context of contexts) {
    const normalizedFile = context.file.replace(/\\/g, "/");
    const references = extractAngularJsReferences(context.source);
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
