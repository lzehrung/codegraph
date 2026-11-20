import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
} from "../src/index.js";
import { clearMemoryCache, closeDiskCacheDatabase } from "../src/indexer/build-cache.js";
import * as jsonCandidateCache from "../src/indexer/build-cache/json-candidates.js";
import * as parseContext from "../src/indexer/parse-context.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
import { mkTmpDir } from "./helpers/filesystem.js";

const modes = (["memory", "disk"] as const).flatMap((cache) =>
  (["full", "incremental"] as const).map((api) => ({ cache, api })),
);
const cases = (["vue", "svelte"] as const).flatMap((framework) =>
  (["ts", "json"] as const).flatMap((sibling) => modes.map((mode) => ({ framework, sibling, ...mode }))),
);

describe("component stylesheet imports survive candidate record recovery", () => {
  it.each(cases)(
    "keeps the stylesheet binding of a same-stem $sibling file ($framework, $cache, $api)",
    async ({ framework, sibling, cache, api }) => {
      const root = await mkTmpDir("cg-sfc-style-recovery-");
      const options = { cache, threads: 1, useNativeWorkers: false, logLevel: "silent" as const };
      const component = path.join(root, `component.${framework}`);
      const shadowed = path.join(root, sibling === "ts" ? "shadowed.ts" : "shadowed.json");
      const style = path.join(root, "shadowed.css");
      const imports = (index: ProjectIndex) =>
        JSON.stringify(
          index.byFile
            .get(fileIdentityKey(component))
            ?.imports.map((binding) => [
              binding.kind,
              binding.from,
              typeof binding.resolved === "string" ? normalizePath(binding.resolved) : binding.resolved,
            ]),
        );
      try {
        await fsp.writeFile(shadowed, sibling === "ts" ? "export const color = 1;\n" : "{}\n");
        await fsp.writeFile(style, ".a { color: red; }\n");
        await fsp.writeFile(
          component,
          `<script>\nexport const c = ${sibling === "ts" ? "color" : "1"};\n</script>\n<style>\n@import "./shadowed";\n</style>\n`,
        );
        await buildProjectIndex(root, options);
        if (cache === "disk") {
          closeDiskCacheDatabase(root, options);
          clearMemoryCache();
          const directory = path.join(root, ".codegraph", "cache", "index-v1");
          await fsp.rm(path.join(directory, "manifest.json"));
          await fsp.rm(path.join(directory, "project-index-snapshot.json"));
        } else {
          jsonCandidateCache.clearMemoryJsonCandidates();
        }
        const warm =
          api === "full" ? await buildProjectIndex(root, options) : await buildProjectIndexIncremental(root, options);
        const cold = await buildProjectIndex(root, { ...options, cache: "off" });
        expect(imports(warm)).toEqual(imports(cold));
        if (sibling === "ts") {
          const request = { file: shadowed, line: 1, column: 14 };
          expect(await findReferences(warm, request)).toEqual(await findReferences(cold, request));
        }
      } finally {
        closeDiskCacheDatabase(root, options);
        clearMemoryCache();
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
  );
});

const trackerModes = (["vue", "svelte"] as const).flatMap((framework) =>
  (["memory", "disk"] as const).flatMap((cache) =>
    [false, true].map((styleExists) => ({ framework, cache, styleExists })),
  ),
);

async function buildWithExtractionCount(
  root: string,
  options: Parameters<typeof buildProjectIndexIncremental>[1],
  component: string,
): Promise<{ index: ProjectIndex; componentExtractions: number }> {
  const prepare = vi.spyOn(parseContext, "prepareFileForIndexing");
  try {
    const index = await buildProjectIndexIncremental(root, options);
    const componentExtractions = prepare.mock.calls.filter(
      ([file]) => fileIdentityKey(file) === fileIdentityKey(component),
    ).length;
    return { index, componentExtractions };
  } finally {
    prepare.mockRestore();
  }
}

async function expectAnswersMatchCold(
  warm: ProjectIndex,
  cold: ProjectIndex,
  component: string,
  client: string,
): Promise<void> {
  const edges = (index: ProjectIndex): string[] => index.graph.edges.map((edge) => JSON.stringify(edge)).sort();
  const detailedEdges = async (index: ProjectIndex): Promise<string[]> =>
    (await buildSymbolGraphDetailed(index)).edges.map((edge) => JSON.stringify(edge)).sort();
  expect(edges(warm)).toEqual(edges(cold));
  expect(await detailedEdges(warm)).toEqual(await detailedEdges(cold));
  const request = { file: client, line: 2, column: 23 };
  const goto = await goToDefinition(warm, request);
  expect(goto).toEqual(await goToDefinition(cold, request));
  expect(goto.status).toBe("ok");
  const definition = { file: component, line: 2, column: 17 };
  const references = await findReferences(warm, definition);
  expect(references).toEqual(await findReferences(cold, definition));
  expect(references.status).toBe("ok");
}

describe("component stylesheet JSON candidate freshness", () => {
  it.each(trackerModes)(
    "reuses unchanged $framework modules with same-stem JSON ($cache, stylesheet=$styleExists)",
    async ({ framework, cache, styleExists }) => {
      const root = await mkTmpDir("cg-sfc-style-json-stable-");
      const options = { cache, threads: 1, useNativeWorkers: false, logLevel: "silent" as const };
      const component = path.join(root, `component.${framework}`);
      const client = path.join(root, "client.js");
      const json = path.join(root, "tokens.json");
      const style = path.join(root, "tokens.css");
      const check = async (): Promise<number> => {
        const { index: warm, componentExtractions } = await buildWithExtractionCount(root, options, component);
        const cold = await buildProjectIndex(root, { ...options, cache: "off" });
        await expectAnswersMatchCold(warm, cold, component, client);
        const hasJsonEdge = warm.graph.edges.some((edge) => {
          if (fileIdentityKey(edge.from) !== fileIdentityKey(component)) return false;
          if (edge.to.type !== "file") return false;
          return fileIdentityKey(edge.to.path) === fileIdentityKey(json);
        });
        expect(hasJsonEdge).toBe(false);
        return componentExtractions;
      };
      try {
        await fsp.writeFile(
          component,
          '<script>\nexport function value() { return 1; }\n</script>\n<style>\n@import "./tokens";\n</style>\n',
        );
        await fsp.writeFile(
          client,
          `import { value } from "./component.${framework}";\nexport const result = value();\n`,
        );
        await fsp.writeFile(
          path.join(root, "00-other.js"),
          'import data from "./tokens.json";\nexport const first = data;\n',
        );
        await fsp.writeFile(
          path.join(root, "zz-other.js"),
          'import data from "./tokens.json";\nexport const last = data;\n',
        );
        await fsp.writeFile(json, "{}\n");
        if (styleExists) await fsp.writeFile(style, ".t { color: red; }\n");
        expect((await buildWithExtractionCount(root, options, component)).componentExtractions).toBe(1);
        for (let iteration = 0; iteration < 3; iteration++) {
          expect(await check()).toBe(0);
        }
        await fsp.writeFile(json, '{"updated":true}\n');
        expect(await check()).toBeLessThanOrEqual(1);
        for (let iteration = 0; iteration < 2; iteration++) {
          expect(await check()).toBe(0);
        }
      } finally {
        closeDiskCacheDatabase(root, options);
        clearMemoryCache();
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(trackerModes)(
    "tracks a same-specifier script side effect in $framework ($cache, stylesheet=$styleExists)",
    async ({ framework, cache, styleExists }) => {
      const root = await mkTmpDir("cg-sfc-shared-style-script-");
      const options = { cache, threads: 1, useNativeWorkers: false, logLevel: "silent" as const };
      const component = path.join(root, `component.${framework}`);
      const client = path.join(root, "client.js");
      const json = path.join(root, "tokens.json");
      const style = path.join(root, "tokens.css");
      const check = async (jsonExists: boolean): Promise<number> => {
        const { index: warm, componentExtractions } = await buildWithExtractionCount(root, options, component);
        const cold = await buildProjectIndex(root, { ...options, cache: "off" });
        await expectAnswersMatchCold(warm, cold, component, client);
        const componentEdges = warm.graph.edges.filter(
          (edge) => fileIdentityKey(edge.from) === fileIdentityKey(component),
        );
        const hasJsonEdge = componentEdges.some(
          (edge) => edge.to.type === "file" && fileIdentityKey(edge.to.path) === fileIdentityKey(json),
        );
        expect(hasJsonEdge).toBe(jsonExists);
        const hasStyleEdge = componentEdges.some((edge) => {
          if (styleExists) return edge.to.type === "file" && fileIdentityKey(edge.to.path) === fileIdentityKey(style);
          return edge.to.type === "external" && edge.to.name === "./tokens";
        });
        expect(hasStyleEdge).toBe(true);
        return componentExtractions;
      };
      try {
        await fsp.writeFile(
          component,
          '<script>\nexport function value() { return 1; }\nimport "./tokens";\n</script>\n<style>\n@import "./tokens";\n</style>\n',
        );
        await fsp.writeFile(
          client,
          `import { value } from "./component.${framework}";\nexport const result = value();\n`,
        );
        await fsp.writeFile(
          path.join(root, "00-other.js"),
          'import data from "./tokens.json";\nexport const first = data;\n',
        );
        await fsp.writeFile(
          path.join(root, "zz-other.js"),
          'import data from "./tokens.json";\nexport const last = data;\n',
        );
        if (styleExists) await fsp.writeFile(style, ".t { color: red; }\n");
        expect(await check(false)).toBe(1);
        await fsp.writeFile(json, "{}\n");
        await check(true);
        await fsp.unlink(json);
        await check(false);
        await fsp.writeFile(json, '{"restored":true}\n');
        await check(true);
        expect((await buildWithExtractionCount(root, options, component)).componentExtractions).toBe(0);
      } finally {
        closeDiskCacheDatabase(root, options);
        clearMemoryCache();
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
  );
});
