import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectIndex } from "../src/index.js";
import { runWithProbeCache } from "../src/util/fs-probe-cache.js";
import { clearResolutionCaches, loadNearestTsconfigFor, resolveSpecifier } from "../src/util/resolution.js";
import { matchMappedSpecifier } from "../src/util/resolution/tsconfig.js";
import {
  getResolutionExtensions,
  iterateResolutionCandidates,
  listResolutionCandidates,
  stripKnownResolutionExtension,
} from "../src/util/resolution-candidates.js";
import { loadWorkspaceConfig } from "../src/util/workspace.js";
import { normalizePath } from "../src/util/paths.js";
import { createTempRootRegistry, tryCreateDirectorySymlink } from "./helpers/filesystem.js";

const roots = createTempRootRegistry();

beforeEach(() => {
  clearResolutionCaches();
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearResolutionCaches();
  await roots.cleanup();
});

async function write(root: string, relative: string, content = "export const value = 1;\n"): Promise<string> {
  const target = path.join(root, ...relative.split("/"));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, "utf8");
  return target;
}

type Resolved = string | { external: string };

function plain(result: Resolved): string {
  return typeof result === "string" ? normalizePath(result) : `external:${result.external}`;
}

type Probe = { api: string; target: string };

/** Records every probe of a path under `root` (project-relative, slash-separated) made after this call. */
function recordProbes(root: string): Probe[] {
  const calls: Probe[] = [];
  const record = (api: string, args: unknown[]): void => {
    const target = args[0];
    if (typeof target !== "string") return;
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return;
    calls.push({ api, target: normalizePath(relative) });
  };
  const original = {
    statSync: fs.statSync.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    stat: fsp.stat.bind(fsp),
    lstat: fsp.lstat.bind(fsp),
    realpath: fsp.realpath.bind(fsp),
    readdir: fsp.readdir.bind(fsp),
  };
  vi.spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
    record("statSync", args);
    return original.statSync(...args);
  }) as typeof fs.statSync);
  vi.spyOn(fs, "existsSync").mockImplementation((...args: Parameters<typeof fs.existsSync>) => {
    record("existsSync", args);
    return original.existsSync(...args);
  });
  vi.spyOn(fsp, "stat").mockImplementation(((...args: Parameters<typeof fsp.stat>) => {
    record("stat", args);
    return original.stat(...args);
  }) as typeof fsp.stat);
  vi.spyOn(fsp, "lstat").mockImplementation(((...args: Parameters<typeof fsp.lstat>) => {
    record("lstat", args);
    return original.lstat(...args);
  }) as typeof fsp.lstat);
  vi.spyOn(fsp, "realpath").mockImplementation((...args: Parameters<typeof fsp.realpath>) => {
    record("realpath", args);
    return original.realpath(...args);
  });
  vi.spyOn(fsp, "readdir").mockImplementation(((...args: Parameters<typeof fsp.readdir>) => {
    record("readdir", args);
    return original.readdir(...args);
  }) as typeof fsp.readdir);
  return calls;
}

/** The probes whose path has a segment that is `name` or starts with `name.` (a candidate of the specifier). */
function probesOf(calls: readonly Probe[], ...names: string[]): Probe[] {
  const segment = new RegExp(`(^|/)(${names.join("|")})([./]|$)`);
  return calls.filter((call) => segment.test(call.target));
}

function describeProbes(probes: readonly Probe[]): string {
  return probes.map((probe) => `${probe.api}:${probe.target}`).join("\n");
}

/** Resolves as one build does (inside a probe cache) and as a standalone call does, and requires the same answer. */
async function resolveBothWays(
  fromFile: string,
  spec: string,
  root: string,
  options: { tsconfig?: boolean; resolveNodeModules?: boolean; workspace?: boolean } = {},
): Promise<string> {
  const resolveOnce = async (): Promise<Resolved> => {
    const matchPath = options.tsconfig ? (await loadNearestTsconfigFor(fromFile, root)).matchPath : undefined;
    const workspaceConfig = options.workspace ? await loadWorkspaceConfig(root) : undefined;
    return await resolveSpecifier(fromFile, spec, root, matchPath, workspaceConfig, {
      resolveNodeModules: !!options.resolveNodeModules,
    });
  };
  clearResolutionCaches();
  const standalone = plain(await resolveOnce());
  clearResolutionCaches();
  const inBuild = plain(await runWithProbeCache(resolveOnce));
  expect(inBuild, `${spec} from ${path.basename(fromFile)}`).toBe(standalone);
  return inBuild;
}

/**
 * Resolves a list of specifiers as one build does (all inside one probe cache, so a directory probed often enough is
 * listed) and as separate standalone calls do, and requires the same answers.
 */
async function resolveAllBothWays(fromFile: string, specs: readonly string[], root: string): Promise<string[]> {
  const resolveSpec = async (spec: string): Promise<string> => plain(await resolveSpecifier(fromFile, spec, root));
  const standalone: string[] = [];
  for (const spec of specs) {
    clearResolutionCaches();
    standalone.push(await resolveSpec(spec));
  }
  clearResolutionCaches();
  const inBuild = await runWithProbeCache(async () => {
    const answers: string[] = [];
    for (const spec of specs) answers.push(await resolveSpec(spec));
    return answers;
  });
  expect(inBuild).toEqual(standalone);
  return inBuild;
}

describe("probe counts", () => {
  const FILES = 40;

  async function writeProject(root: string): Promise<void> {
    await write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
    await write(root, "src/shared.ts", "export const shared = 1;\n");
    for (let index = 0; index < FILES; index += 1) {
      await write(
        root,
        `src/f${index}.ts`,
        [
          'import fs from "fs";',
          'import path from "path";',
          'import "missing-pkg";',
          'import { shared } from "./shared";',
          `export const v${index} = shared + fs.sep.length + path.sep.length;`,
          "",
        ].join("\n"),
      );
    }
  }

  it("probes a bounded number of candidates however many files import the same specifiers", async () => {
    const root = await roots.create("dg-probe-count-");
    await writeProject(root);
    const calls = recordProbes(root);

    const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });

    const sharedTarget = normalizePath(path.join(root, "src", "shared.ts"));
    const dependents = index.graph.edges.filter((edge) => edge.to.type === "file" && edge.to.path === sharedTarget);
    expect(dependents).toHaveLength(FILES);
    // 40 files, each with three bare specifiers (89 candidates apiece) and one relative one. A build resolves each
    // shape once: before, this was 10,000+ probes, 10,680 of them blocking statSync calls.
    const probes = probesOf(calls, "fs", "path", "shared", "missing-pkg");
    expect(probes.length, describeProbes(probes)).toBeLessThan(FILES);
    expect(probes.filter((probe) => probe.api === "statSync")).toHaveLength(0);
  });

  it("answers the candidates of many specifiers from the directory they share", async () => {
    const root = await roots.create("dg-probe-listing-");
    await write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
    const specifiers = ["fs", "path", "os", "util", "crypto", "stream", "events", "zlib"];
    await write(root, "src/main.ts", `${specifiers.map((name) => `import "${name}";`).join("\n")}\nexport {};\n`);
    const calls = recordProbes(root);

    await buildProjectIndex(root, { cache: "off", logLevel: "silent" });

    // Eight bare specifiers have 89 candidates each in the project root, 700 probes before. The root is listed,
    // and the first few candidates are the only ones a stat answers.
    const rootProbes = calls.filter((call) => !call.target.includes("/") && call.target !== "src");
    const candidates = probesOf(rootProbes, ...specifiers);
    expect(candidates.length, describeProbes(candidates)).toBeLessThan(10);
  });
});

describe("builtin names and tsconfig mappings", () => {
  it("keeps a paths alias of a builtin name ahead of the builtin", async () => {
    const root = await roots.create("dg-probe-alias-");
    await write(
      root,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { fs: ["shims/fs.ts"], "app:*": ["lib/*"] } } }),
    );
    const shim = await write(root, "shims/fs.ts");
    await write(root, "lib/util.ts");
    const main = await write(root, "src/main.ts", 'import fs from "fs";\nimport "app:util";\nexport {};\n');

    expect(await resolveBothWays(main, "fs", root, { tsconfig: true })).toBe(normalizePath(shim));
    expect(await resolveBothWays(main, "app:util", root, { tsconfig: true })).toBe("external:app:util");
    expect(await resolveBothWays(main, "child_process", root, { tsconfig: true })).toBe("external:child_process");

    const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
    const edges = index.graph.edges.filter((edge) => edge.from === normalizePath(main));
    expect(edges.map((edge) => (edge.to.type === "file" ? edge.to.path : `external:${edge.to.name}`)).sort()).toEqual(
      [normalizePath(shim), "external:app:util"].sort(),
    );
  });

  it("keeps the alias for every importer while probing the builtin's candidates once", async () => {
    const root = await roots.create("dg-probe-alias-many-");
    await write(
      root,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { fs: ["shims/fs.ts"] } } }),
    );
    const shim = await write(root, "shims/fs.ts");
    const importers: string[] = [];
    for (let index = 0; index < 24; index += 1) {
      importers.push(await write(root, `src/f${index}.ts`, 'import fs from "fs";\nimport os from "os";\nexport {};\n'));
    }
    const calls = recordProbes(root);

    const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });

    const aliased = index.graph.edges.filter((edge) => edge.to.type === "file" && edge.to.path === normalizePath(shim));
    expect(aliased.map((edge) => edge.from).sort()).toEqual(importers.map(normalizePath).sort());
    const probes = probesOf(calls, "fs", "os");
    expect(probes.length, describeProbes(probes)).toBeLessThan(24);
  });

  it("links a style block import through a tsconfig path alias to its file", async () => {
    const root = await roots.create("dg-probe-vue-style-alias-");
    await write(
      root,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } } }),
    );
    const vars = await write(root, "lib/vars.scss", "$a: 1;\n");
    const app = await write(
      root,
      "src/App.vue",
      '<script setup lang="ts">\nexport const a = 1;\n</script>\n<style lang="scss">\n@use "@lib/vars";\n@use "@lib/missing";\n</style>\n',
    );

    const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });

    const edges = index.graph.edges.filter((edge) => edge.from === normalizePath(app));
    const targets = edges.map((edge) => (edge.to.type === "file" ? edge.to.path : `external:${edge.to.name}`));
    expect(targets.sort()).toEqual([normalizePath(vars), "external:@lib/missing"].sort());
  });

  it("keeps a catch-all alias and a baseUrl sibling ahead of builtins", async () => {
    const root = await roots.create("dg-probe-catchall-");
    await write(
      root,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "*": ["shims/*", "*"] } } }),
    );
    const pathShim = await write(root, "shims/path.ts");
    const osSibling = await write(root, "os.ts");
    const main = await write(root, "src/main.ts", "export {};\n");

    expect(await resolveBothWays(main, "path", root, { tsconfig: true })).toBe(normalizePath(pathShim));
    expect(await resolveBothWays(main, "os", root, { tsconfig: true })).toBe(normalizePath(osSibling));
    expect(await resolveBothWays(main, "fs", root, { tsconfig: true })).toBe("external:fs");
  });

  it("does not let one config's alias answer for a file under another config", async () => {
    const root = await roots.create("dg-probe-scopes-");
    await write(
      root,
      "a/tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { fs: ["shim.ts"] } } }),
    );
    await write(root, "b/tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
    const shim = await write(root, "a/shim.ts");
    const fromA = await write(root, "a/src/x.ts", "export {};\n");
    const fromA2 = await write(root, "a/src/deeper/y.ts", "export {};\n");
    const fromB = await write(root, "b/src/z.ts", "export {};\n");
    const fromNone = await write(root, "c/w.ts", "export {};\n");

    const run = async (): Promise<string[]> => {
      const answers: string[] = [];
      for (const file of [fromB, fromA, fromNone, fromA2, fromB, fromA]) {
        const { matchPath } = await loadNearestTsconfigFor(file, root);
        answers.push(plain(await resolveSpecifier(file, "fs", root, matchPath)));
      }
      return answers;
    };
    const aliased = normalizePath(shim);
    const expected = ["external:fs", aliased, "external:fs", aliased, "external:fs", aliased];
    clearResolutionCaches();
    expect(await run()).toEqual(expected);
    clearResolutionCaches();
    expect(await runWithProbeCache(run)).toEqual(expected);
  });

  it("shares one resolution between configs that extend the same base", async () => {
    const root = await roots.create("dg-probe-shared-base-");
    await write(root, "tsconfig.base.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
    const files: string[] = [];
    for (const name of ["one", "two", "three"]) {
      await write(root, `packages/${name}/tsconfig.json`, JSON.stringify({ extends: "../../tsconfig.base.json" }));
      files.push(await write(root, `packages/${name}/src/main.ts`));
    }
    await write(root, "fs.ts");
    const calls = recordProbes(root);

    const answers = await runWithProbeCache(async () => {
      const results: string[] = [];
      for (const file of files) {
        const { matchPath } = await loadNearestTsconfigFor(file, root);
        results.push(plain(await resolveSpecifier(file, "fs", root, matchPath)));
      }
      return results;
    });

    const sibling = normalizePath(path.join(root, "fs.ts"));
    expect(answers).toEqual([sibling, sibling, sibling]);
    // Three importers, one config content: the candidates of `fs` are probed once, not once per config.
    const probes = probesOf(calls, "fs").filter((probe) => ["stat", "statSync", "existsSync"].includes(probe.api));
    expect(probes.length, describeProbes(probes)).toBeLessThanOrEqual(3);
  });
});

describe("what a cached resolution depends on", () => {
  it("separates importers by directory for relative specifiers and shares a directory", async () => {
    const root = await roots.create("dg-probe-relative-");
    const sharedA = await write(root, "a/shared.ts");
    const inA = await write(root, "a/one.ts", "export {};\n");
    const alsoInA = await write(root, "a/two.ts", "export {};\n");
    const inB = await write(root, "b/three.ts", "export {};\n");
    const run = async (): Promise<string[]> => [
      plain(await resolveSpecifier(inB, "./shared", root)),
      plain(await resolveSpecifier(inA, "./shared", root)),
      plain(await resolveSpecifier(alsoInA, "./shared", root)),
      plain(await resolveSpecifier(inB, "./shared", root)),
    ];
    const expected = ["external:./shared", normalizePath(sharedA), normalizePath(sharedA), "external:./shared"];
    clearResolutionCaches();
    expect(await run()).toEqual(expected);
    clearResolutionCaches();
    expect(await runWithProbeCache(run)).toEqual(expected);
  });

  it("answers a call that passes the tsconfig mappings and one that does not each for its own inputs", async () => {
    const root = await roots.create("dg-probe-matcher-collision-");
    await write(
      root,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } } }),
    );
    const target = await write(root, "lib/util.ts");
    const importer = await write(root, "src/main.ts", "export {};\n");
    const { matchPath } = await loadNearestTsconfigFor(importer, root);
    if (!matchPath) throw new Error("expected a tsconfig matcher");
    const withMappings = async (): Promise<string> =>
      plain(await resolveSpecifier(importer, "@lib/util", root, matchPath));
    const withoutMappings = async (): Promise<string> => plain(await resolveSpecifier(importer, "@lib/util", root));
    const aliased = normalizePath(target);
    const orders: ReadonlyArray<() => Promise<string[]>> = [
      async () => [await withMappings(), await withoutMappings()],
      async () => [await withoutMappings(), await withMappings()],
    ];
    const expected = [
      [aliased, "external:@lib/util"],
      ["external:@lib/util", aliased],
    ];
    for (const [index, order] of orders.entries()) {
      clearResolutionCaches();
      expect(await order(), `standalone order ${index}`).toEqual(expected[index]);
      clearResolutionCaches();
      expect(await runWithProbeCache(order), `in build order ${index}`).toEqual(expected[index]);
    }
  });

  it("separates path-like importer languages from other importers for a bare specifier", async () => {
    const root = await roots.create("dg-probe-pathlike-");
    const target = await write(root, "pkg/util.ts");
    const goFile = await write(root, "main.go", "package main\n");
    const tsFile = await write(root, "main.ts", "export {};\n");
    const run = async (): Promise<string[]> => [
      plain(await resolveSpecifier(tsFile, "pkg/util", root)),
      plain(await resolveSpecifier(goFile, "pkg/util", root)),
      plain(await resolveSpecifier(tsFile, "pkg/util", root)),
    ];
    const expected = ["external:pkg/util", normalizePath(target), "external:pkg/util"];
    clearResolutionCaches();
    expect(await run()).toEqual(expected);
    clearResolutionCaches();
    expect(await runWithProbeCache(run)).toEqual(expected);
  });

  it("starts a node_modules lookup in the importer's own directory", async () => {
    const root = await roots.create("dg-probe-node-modules-");
    const entry = await write(root, "a/node_modules/dep/index.js");
    const fromA = await write(root, "a/src/x.ts", "export {};\n");
    const fromB = await write(root, "b/src/y.ts", "export {};\n");
    const run = async (): Promise<string[]> => {
      const answers: string[] = [];
      for (const file of [fromB, fromA, fromB, fromA]) {
        const resolved = await resolveSpecifier(file, "dep", root, undefined, undefined, { resolveNodeModules: true });
        answers.push(plain(resolved));
      }
      return answers;
    };
    const expected = ["external:dep", normalizePath(entry), "external:dep", normalizePath(entry)];
    clearResolutionCaches();
    expect(await run()).toEqual(expected);
    clearResolutionCaches();
    expect(await runWithProbeCache(run)).toEqual(expected);
  });

  it("separates SCSS importers from other importers for a partial", async () => {
    const root = await roots.create("dg-probe-scss-");
    const partial = await write(root, "styles/_tokens.scss", "$a: 1;\n");
    const fromScss = await write(root, "styles/main.scss", "@use 'tokens';\n");
    const fromCss = await write(root, "styles/main.css", "a {}\n");
    const resolve = async (file: string): Promise<string> =>
      plain(await resolveSpecifier(file, "./tokens", root, undefined, undefined, { allowScssPartialResolution: true }));
    const run = async (): Promise<string[]> => [
      await resolve(fromCss),
      await resolve(fromScss),
      await resolve(fromCss),
    ];
    const expected = ["external:./tokens", normalizePath(partial), "external:./tokens"];
    clearResolutionCaches();
    expect(await run()).toEqual(expected);
    clearResolutionCaches();
    expect(await runWithProbeCache(run)).toEqual(expected);
  });
});

describe("file system semantics", () => {
  it("resolves a case-mismatched import exactly as stat reports on this platform", async () => {
    const root = await roots.create("dg-probe-case-");
    const lower = await write(root, "src/util.ts");
    await write(root, "src/Helper.ts");
    await write(root, "Lib/index.ts");
    const main = await write(root, "src/main.ts", "export {};\n");
    const specs = [
      "./util",
      "./Util",
      "./UTIL",
      "./helper",
      "./Helper",
      "../lib",
      "../LIB",
      "../LIB/index",
      "./util.TS",
      "./Util.ts",
    ];
    // Extra specifiers so `src` is probed with enough different names to be listed, not just stat-ed.
    const fillers = ["./a1", "./a2", "./a3", "./a4"];
    const calls = recordProbes(root);
    const answers = await resolveAllBothWays(main, [...fillers, ...specs], root);

    for (const [index, spec] of specs.entries()) {
      const resolved = answers[fillers.length + index] as string;
      const spelled = path.resolve(path.dirname(main), spec);
      let statSaysFile = false;
      for (const candidate of [spelled, `${spelled}.ts`, path.join(spelled, "index.ts")]) {
        const stat = await fsp.stat(candidate).catch(() => undefined);
        if (stat?.isFile()) {
          statSaysFile = true;
          break;
        }
      }
      expect(resolved.startsWith("external:"), `${spec} -> ${resolved}`).toBe(!statSaysFile);
      if (!resolved.startsWith("external:")) expect(resolved.toLowerCase().endsWith(".ts")).toBe(true);
    }
    // One build listed `src` once, whatever case each import spelled.
    expect(calls.filter((call) => call.api === "readdir" && call.target === "src")).toHaveLength(1);
    expect(lower).toBeTruthy();
  });

  it("sees a file created between two builds", async () => {
    const root = await roots.create("dg-probe-between-builds-");
    for (const name of ["a", "b", "c", "d"]) await write(root, `src/${name}.ts`);
    const main = await write(
      root,
      "src/main.ts",
      ["a", "b", "c", "d", "late"].map((name) => `import "./${name}";`).join("\n") + "\nexport {};\n",
    );
    const calls = recordProbes(root);
    const targets = async (): Promise<string[]> => {
      const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
      return index.graph.edges
        .filter((edge) => edge.from === normalizePath(main))
        .map((edge) => (edge.to.type === "file" ? path.basename(edge.to.path) : `external:${edge.to.name}`))
        .sort();
    };

    expect(await targets()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "external:./late"]);
    // The first build listed `src` (five different names were probed there), so a later build must list it again.
    const listedFirst = calls.filter((call) => call.api === "readdir" && call.target === "src").length;
    expect(listedFirst).toBeGreaterThanOrEqual(1);
    await write(root, "src/late.ts");
    expect(await targets()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "late.ts"]);
    expect(calls.filter((call) => call.api === "readdir" && call.target === "src").length).toBeGreaterThan(listedFirst);
  });

  it("keeps a symlinked directory inside the root and rejects one that leaves it", async () => {
    const base = await roots.create("dg-probe-links-");
    const root = path.join(base, "project");
    const outside = path.join(base, "outside");
    await fsp.mkdir(path.join(root, "real"), { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await write(root, "real/inner.ts");
    await write(outside, "leak.ts");
    const main = await write(root, "src/main.ts", "export {};\n");
    const created = [
      await tryCreateDirectorySymlink(path.join(root, "real"), path.join(root, "src", "inside")),
      await tryCreateDirectorySymlink(outside, path.join(root, "src", "escape")),
    ];
    if (created.some((ok) => !ok)) return;

    const answers = await resolveAllBothWays(
      main,
      ["./a1", "./a2", "./a3", "./a4", "./inside/inner", "./escape/leak", "./escape"],
      root,
    );
    const inner = normalizePath(path.join(root, "src", "inside", "inner.ts"));
    expect(answers.slice(4)).toEqual([inner, "external:./escape/leak", "external:./escape"]);

    // Many importers of the same link: the physical check of the root and of each directory runs once.
    const importers: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      importers.push(
        await write(root, `src/f${index}.ts`, 'import "./inside/inner";\nimport "./escape/leak";\nexport {};\n'),
      );
    }
    const calls = recordProbes(root);
    const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
    const targetsOf = (file: string): string[] =>
      index.graph.edges
        .filter((edge) => edge.from === normalizePath(file))
        .map((edge) => (edge.to.type === "file" ? edge.to.path : `external:${edge.to.name}`))
        .sort();
    for (const file of importers) expect(targetsOf(file)).toEqual([inner, "external:./escape/leak"].sort());
    const physical = calls.filter((call) => call.api === "realpath" && /^src\/(inside|escape)/.test(call.target));
    expect(physical.length, describeProbes(physical)).toBeLessThan(20);
  });
});

describe("mapped specifier search", () => {
  it("finds what matchPath finds for generated mappings, files, and packages", async () => {
    const root = await roots.create("dg-probe-match-");
    await write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: "./src",
          paths: {
            "@app/*": ["app/*", "legacy/*"],
            "@lib": ["lib/main.ts", "lib/index.ts"],
            "ui/*": ["widgets/*/index"],
            "exact-name": ["vendor/exact.js"],
            "*": ["types/*"],
          },
        },
      }),
    );
    for (const relative of [
      "src/app/one.ts",
      "src/app/two/index.tsx",
      "src/legacy/old.js",
      "src/legacy/two.ts",
      "src/lib/index.ts",
      "src/widgets/button/index.ts",
      "src/widgets/panel/index.d.ts",
      "src/vendor/exact.js",
      "src/types/node.d.ts",
      "src/pkg/package.json",
      "src/pkg/lib/entry.js",
      "src/direct.ts",
      "src/direct.json",
      "src/Mixed/Case.ts",
    ]) {
      const content = relative.endsWith("package.json") ? JSON.stringify({ main: "lib/entry.js" }) : "export {};\n";
      await write(root, relative, content);
    }
    const importer = path.join(root, "src", "main.ts");
    const { matchPath } = await loadNearestTsconfigFor(importer, root);
    if (!matchPath) throw new Error("expected a tsconfig matcher");
    const extensions = [".ts", ".tsx", ".d.ts", ".js", ".json"];
    const specs = [
      "@app/one",
      "@app/two",
      "@app/old",
      "@app/two/index",
      "@app/missing",
      "@lib",
      "@lib/extra",
      "ui/button",
      "ui/panel",
      "ui/none",
      "exact-name",
      "node",
      "pkg",
      "pkg/lib/entry",
      "direct",
      "direct.json",
      "mixed/case",
      "Mixed/Case",
      "fs",
      "path/posix",
      "./relative",
      "",
    ];
    for (const spec of specs) {
      clearResolutionCaches();
      const standalone = await matchMappedSpecifier(matchPath, spec, root, extensions);
      clearResolutionCaches();
      const inBuild = await runWithProbeCache(
        async () => await matchMappedSpecifier(matchPath, spec, root, extensions),
      );
      expect(inBuild, spec).toBe(standalone);
    }
  });

  it("falls back to the standalone search for an empty extension list", async () => {
    const root = await roots.create("dg-probe-empty-extensions-");
    await write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
    await write(root, "pkg/package.json", JSON.stringify({ main: "nope.js" }));
    const importer = await write(root, "src/main.ts", "export {};\n");
    const { matchPath } = await loadNearestTsconfigFor(importer, root);
    if (!matchPath) throw new Error("expected a tsconfig matcher");
    const found = await runWithProbeCache(async () => await matchMappedSpecifier(matchPath, "pkg", root, []));
    expect(found).toBeUndefined();
  });

  it("does not probe a mapped candidate outside the project root", async () => {
    const base = await roots.create("dg-probe-outside-root-");
    const root = path.join(base, "project");
    await write(
      root,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "out/*": ["../outside/*"] } } }),
    );
    await write(base, "outside/thing.ts");
    await write(root, "inside/thing.ts");
    const importer = await write(root, "src/main.ts", "export {};\n");
    const { matchPath } = await loadNearestTsconfigFor(importer, root);
    if (!matchPath) throw new Error("expected a tsconfig matcher");
    const extensions = [".ts", ".js"];
    const standaloneInside = await matchMappedSpecifier(matchPath, "inside/thing", root, extensions);
    expect(standaloneInside).toBeDefined();
    const calls = recordProbes(base);

    const outside = await runWithProbeCache(
      async () => await matchMappedSpecifier(matchPath, "out/thing", root, extensions),
    );
    const inside = await runWithProbeCache(
      async () => await matchMappedSpecifier(matchPath, "inside/thing", root, extensions),
    );

    expect(outside).toBeUndefined();
    expect(inside).toBe(standaloneInside);
    // The library reads a candidate directory's package.json without the root check, in either search.
    const outsideCandidates = probesOf(calls, "outside").filter((call) => !call.target.endsWith("/package.json"));
    expect(outsideCandidates, describeProbes(outsideCandidates)).toEqual([]);
    expect(probesOf(calls, "inside").length).toBeGreaterThan(0);
  });
});

describe("resolution candidates", () => {
  /** The eager definition the lazy walk replaced: every candidate built up front, repeats removed. */
  function eagerCandidates(base: string, resolutionExtensions?: readonly string[]): string[] {
    const extensions = getResolutionExtensions(resolutionExtensions);
    return Array.from(
      new Set([
        base,
        ...extensions.map((extension) => `${base}${extension}`),
        ...extensions.map((extension) => path.join(base, `index${extension}`)),
      ]),
    );
  }

  it("walks the same candidates in the same order as listing them all", () => {
    const bases = [path.resolve("/proj/src/foo"), path.resolve("/proj/src/foo.model"), path.resolve("/proj/src/a.b.c")];
    const extensionLists = [undefined, [".ts", ".tsx"], [".ts", ".ts", ""], [""], [], [".d.ts", ".ts", ".d.ts"]];
    for (const base of bases) {
      for (const extensions of extensionLists) {
        // A base that ends in a known extension takes the explicit-extension branch instead.
        if (stripKnownResolutionExtension(base, getResolutionExtensions(extensions)) !== base) continue;
        expect(listResolutionCandidates(base, extensions), `${base} ${JSON.stringify(extensions)}`).toEqual(
          eagerCandidates(base, extensions),
        );
        expect([...iterateResolutionCandidates(base, extensions)]).toEqual(eagerCandidates(base, extensions));
      }
    }
  });

  it("keeps the explicit-extension families of a base that names a source file", () => {
    const base = path.resolve("/proj/src/widget.js");
    expect(listResolutionCandidates(base).map((candidate) => path.basename(candidate))).toEqual([
      "widget.ts",
      "widget.tsx",
      "widget.d.ts",
      "widget.js",
      "widget.jsx",
    ]);
    expect([...iterateResolutionCandidates(base, [".ts"])].map((candidate) => path.basename(candidate))).toEqual([
      "widget.ts",
      "widget.js",
    ]);
  });
});
