import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentProbeCache,
  FsProbeCache,
  runWithProbeCache,
  type FsProbeOps,
  type ProbeDirent,
  type ProbeKind,
} from "../src/util/fs-probe-cache.js";
import { createTempRootRegistry, tryCreateDirectorySymlink, tryCreateFileSymlink } from "./helpers/filesystem.js";

type FakeNode =
  | { type: "file" }
  | { type: "directory"; children: Map<string, FakeNode>; listable: boolean; searchable: boolean }
  | { type: "symlink"; target: string };

type Resolved = { node: FakeNode; segments: string[] };

function errno(code: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${syscall}`), { code });
}

/**
 * A file system that answers like the real one in either case mode, so the cache can be checked against the
 * semantics `fs.stat` and `fs.realpath` have on a case-sensitive and on a case-insensitive volume. With
 * `normalizationInsensitive`, names that differ only in Unicode normalization (as on macOS) name one entry.
 */
class FakeFs implements FsProbeOps {
  readonly calls = { readdir: 0, stat: 0, lstat: 0, realpath: 0, access: 0 };
  private readonly top: FakeNode = { type: "directory", children: new Map(), listable: true, searchable: true };

  constructor(
    private readonly caseInsensitive: boolean,
    readonly normalizationInsensitive = false,
    readonly realpathStoresCase = true,
    readonly root = path.resolve(path.sep, "fake-volume"),
  ) {}

  at(...segments: string[]): string {
    return path.join(this.root, ...segments);
  }

  mkdir(relative: string, options: { listable?: boolean; searchable?: boolean } = {}): void {
    this.put(relative, {
      type: "directory",
      children: new Map(),
      listable: options.listable ?? true,
      searchable: options.searchable ?? true,
    });
  }

  file(relative: string): void {
    this.put(relative, { type: "file" });
  }

  symlink(relative: string, target: string): void {
    this.put(relative, { type: "symlink", target });
  }

  private put(relative: string, node: FakeNode): void {
    const parts = relative.split("/");
    const name = parts.pop() as string;
    let current = this.top;
    for (const part of parts) {
      if (current.type !== "directory") throw new Error(`not a directory: ${part}`);
      const next = this.find(current, part);
      if (next?.node.type !== "directory") throw new Error(`missing parent directory: ${part}`);
      current = next.node;
    }
    if (current.type !== "directory") throw new Error("not a directory");
    current.children.set(name, node);
  }

  private find(directory: FakeNode, name: string): { name: string; node: FakeNode } | undefined {
    if (directory.type !== "directory") return undefined;
    const exact = directory.children.get(name);
    if (exact) return { name, node: exact };
    if (!this.caseInsensitive && !this.normalizationInsensitive) return undefined;
    const fold = (text: string): string => {
      const normalized = this.normalizationInsensitive ? text.normalize("NFD") : text;
      return this.caseInsensitive ? normalized.toLowerCase() : normalized;
    };
    for (const [actual, node] of directory.children) {
      if (fold(actual) === fold(name)) return { name: actual, node };
    }
    return undefined;
  }

  private segmentsOf(target: string): string[] {
    const relative = path.relative(this.root, path.resolve(target));
    return relative ? relative.split(/[\\/]/) : [];
  }

  /** Resolves a path as the kernel does, following every link except a final one when `followFinal` is false. */
  private resolve(segments: string[], followFinal: boolean, depth = 0): Resolved {
    if (depth > 8) throw errno("ELOOP", "resolve");
    let node: FakeNode = this.top;
    const actual: string[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      if (node.type !== "directory") throw errno("ENOTDIR", segments.join("/"));
      if (!node.searchable) throw errno("EACCES", segments.join("/"));
      const found = this.find(node, segments[index] as string);
      if (!found) throw errno("ENOENT", segments.join("/"));
      const isFinal = index === segments.length - 1;
      if (found.node.type === "symlink" && (!isFinal || followFinal)) {
        const target = this.resolve(
          [...actual, ...found.node.target.split("/")].flatMap((part) => (part === ".." ? [part] : [part])),
          true,
          depth + 1,
        );
        node = target.node;
        actual.length = 0;
        actual.push(...target.segments);
        continue;
      }
      node = found.node;
      actual.push(this.realpathStoresCase ? found.name : (segments[index] as string));
    }
    return { node, segments: actual };
  }

  /** The kind `fs.stat` reports, without counting a call. */
  truthKind(target: string): ProbeKind | null {
    try {
      const { node } = this.resolve(this.segmentsOf(target), true);
      return node.type === "file" ? "file" : "directory";
    } catch {
      return null;
    }
  }

  truthRealpath(target: string): string | null {
    try {
      const { segments } = this.resolve(this.segmentsOf(target), true);
      return path.join(this.root, ...segments);
    } catch {
      return null;
    }
  }

  readdir(directory: string): Promise<readonly ProbeDirent[]> {
    this.calls.readdir += 1;
    try {
      const { node } = this.resolve(this.segmentsOf(directory), true);
      if (node.type !== "directory") throw errno("ENOTDIR", directory);
      if (!node.listable) throw errno("EACCES", directory);
      return Promise.resolve(
        [...node.children].map(([name, child]) => ({
          name,
          isFile: () => child.type === "file",
          isDirectory: () => child.type === "directory",
          isSymbolicLink: () => child.type === "symlink",
          isFIFO: () => false,
          isSocket: () => false,
          isCharacterDevice: () => false,
          isBlockDevice: () => false,
        })),
      );
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  stat(target: string): Promise<{ isFile(): boolean; isDirectory(): boolean }> {
    this.calls.stat += 1;
    try {
      const { node } = this.resolve(this.segmentsOf(target), true);
      return Promise.resolve({ isFile: () => node.type === "file", isDirectory: () => node.type === "directory" });
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  lstat(target: string): Promise<unknown> {
    this.calls.lstat += 1;
    try {
      return Promise.resolve(this.resolve(this.segmentsOf(target), false).node);
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  realpath(target: string): Promise<string> {
    this.calls.realpath += 1;
    const real = this.truthRealpath(target);
    return real === null ? Promise.reject(errno("ENOENT", target)) : Promise.resolve(real);
  }

  access(directory: string): Promise<void> {
    this.calls.access += 1;
    try {
      this.resolve(this.segmentsOf(directory), true);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }
}

const roots = createTempRootRegistry();

afterEach(async () => {
  await roots.cleanup();
});

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe.each([
  { label: "case-sensitive", caseInsensitive: false },
  { label: "case-insensitive", caseInsensitive: true },
])("probe cache over a $label volume", ({ caseInsensitive }) => {
  function project(): FakeFs {
    const fake = new FakeFs(caseInsensitive);
    fake.mkdir("proj");
    fake.mkdir("proj/src");
    fake.file("proj/src/Alpha.ts");
    fake.file("proj/src/beta.ts");
    fake.file("proj/src/gamma.d.ts");
    fake.file("proj/src/data.json");
    fake.mkdir("proj/src/Widget");
    fake.file("proj/src/Widget/index.tsx");
    fake.mkdir("proj/src/empty");
    return fake;
  }

  it("answers every probe as stat does, from one listing once a directory is probed enough", async () => {
    const fake = project();
    const cache = new FsProbeCache(fake);
    const names = [
      "Alpha.ts",
      "alpha.ts",
      "ALPHA.TS",
      "Alpha",
      "Alpha.tsx",
      "beta.ts",
      "Beta.ts",
      "gamma.d.ts",
      "Gamma.D.TS",
      "gamma.ts",
      "data.json",
      "DATA.JSON",
      "Widget",
      "widget",
      "Widget/index.tsx",
      "widget/INDEX.tsx",
      "Widget/index.ts",
      "empty",
      "empty/index.ts",
      "missing.ts",
      "Alpha.ts/child",
    ];
    for (const name of names) {
      const target = fake.at("proj", "src", ...name.split("/"));
      expect(await cache.kind(target), name).toBe(fake.truthKind(target));
    }
    // `src` is listed once; `src/Widget`, `src/empty`, and `src/Alpha.ts` are probed below the budget or missing.
    expect(fake.calls.readdir).toBeLessThanOrEqual(4);
    const listedBefore = fake.calls.readdir;
    const statBefore = fake.calls.stat;
    for (const name of ["Alpha.ts", "alpha.ts", "beta.ts", "nope.ts", "gamma.d.ts"]) {
      const target = fake.at("proj", "src", name);
      expect(await cache.kind(target), name).toBe(fake.truthKind(target));
    }
    expect(fake.calls.readdir).toBe(listedBefore);
    expect(fake.calls.stat).toBe(statBefore);
  });

  it("probes the first names of a directory with stat and lists it from the fourth different name", async () => {
    const fake = project();
    const cache = new FsProbeCache(fake);
    for (const name of ["Alpha.ts", "beta.ts", "gamma.d.ts"]) await cache.kind(fake.at("proj", "src", name));
    expect(fake.calls.readdir).toBe(0);
    expect(fake.calls.stat).toBe(3);
    await cache.kind(fake.at("proj", "src", "data.json"));
    expect(fake.calls.readdir).toBe(1);
    expect(fake.calls.stat).toBe(3);
  });

  it("reads one listing for concurrent probes of a new directory", async () => {
    const fake = project();
    const cache = new FsProbeCache(fake);
    const targets = Array.from({ length: 40 }, (_, index) => fake.at("proj", "src", `candidate${index}.ts`));
    const kinds = await Promise.all(targets.map((target) => cache.kind(target)));
    expect(kinds.every((kind) => kind === null)).toBe(true);
    expect(fake.calls.readdir).toBe(1);
  });

  it("matches stat for random names of one directory, with the listing loaded first", async () => {
    const fake = project();
    const cache = new FsProbeCache(fake);
    for (const name of ["a1", "a2", "a3", "a4"]) await cache.kind(fake.at("proj", "src", name));
    const random = seeded(7);
    const stems = ["Alpha", "alpha", "beta", "BETA", "gamma", "Gamma", "data", "Widget", "empty", "x"];
    const extensions = ["", ".ts", ".TS", ".tsx", ".d.ts", ".D.TS", ".json", ".js", ".d.mts"];
    for (let round = 0; round < 400; round += 1) {
      const stem = stems[Math.floor(random() * stems.length)] as string;
      const extension = extensions[Math.floor(random() * extensions.length)] as string;
      const target = fake.at("proj", "src", `${stem}${extension}`);
      expect(await cache.kind(target), `${stem}${extension}`).toBe(fake.truthKind(target));
    }
  });

  it("reports the real path of a listed entry with the case the directory stores", async () => {
    const fake = project();
    const cache = new FsProbeCache(fake);
    for (const name of ["a1", "a2", "a3", "a4"]) await cache.kind(fake.at("proj", "src", name));
    const realpathCallsBefore = fake.calls.realpath;
    for (const name of ["Alpha.ts", "alpha.ts", "ALPHA.TS", "beta.ts", "Beta.ts", "Widget", "widget", "missing.ts"]) {
      const target = fake.at("proj", "src", name);
      expect(await cache.realpath(target), name).toBe(fake.truthRealpath(target));
    }
    // One call for the directory, none for the files in it.
    expect(fake.calls.realpath - realpathCallsBefore).toBe(1);
  });

  it("follows links as stat and realpath do and asks the file system for them", async () => {
    const fake = project();
    fake.symlink("proj/src/linked.ts", "proj/src/beta.ts");
    fake.symlink("proj/src/dirlink", "proj/src/Widget");
    fake.symlink("proj/src/dangling.ts", "proj/src/nothing.ts");
    const cache = new FsProbeCache(fake);
    for (const name of ["a1", "a2", "a3", "a4"]) await cache.kind(fake.at("proj", "src", name));
    for (const name of ["linked.ts", "dirlink", "dirlink/index.tsx", "dangling.ts"]) {
      const target = fake.at("proj", "src", ...name.split("/"));
      expect(await cache.kind(target), name).toBe(fake.truthKind(target));
      expect(await cache.realpath(target), name).toBe(fake.truthRealpath(target));
    }
  });

  it("falls back to stat for a directory it cannot list", async () => {
    const fake = project();
    fake.mkdir("proj/locked", { listable: false });
    fake.file("proj/locked/secret.ts");
    const cache = new FsProbeCache(fake);
    for (const name of ["secret.ts", "other.ts", "Secret.ts", "x.ts", "y.ts", "secret.ts"]) {
      const target = fake.at("proj", "locked", name);
      expect(await cache.kind(target), name).toBe(fake.truthKind(target));
    }
    expect(fake.calls.readdir).toBe(1);
  });

  it.skipIf(process.platform === "win32")("falls back to stat for a directory that cannot be searched", async () => {
    const fake = project();
    fake.mkdir("proj/closed", { searchable: false });
    fake.file("proj/closed/secret.ts");
    const cache = new FsProbeCache(fake);
    for (const name of ["secret.ts", "other.ts", "x.ts", "y.ts", "z.ts"]) {
      const target = fake.at("proj", "closed", name);
      expect(await cache.kind(target), name).toBe(fake.truthKind(target));
    }
  });

  it("answers a missing directory and a path below a file without listing again", async () => {
    const fake = project();
    const cache = new FsProbeCache(fake);
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
      expect(await cache.kind(fake.at("proj", "nowhere", name))).toBeNull();
      expect(await cache.kind(fake.at("proj", "src", "Alpha.ts", name))).toBeNull();
    }
    // `nowhere` and `src/Alpha.ts` are each listed at most once.
    expect(fake.calls.readdir).toBeLessThanOrEqual(2);
    expect(await cache.realpath(fake.at("proj", "nowhere", "a.ts"))).toBeNull();
  });

  it("answers below an entry its parent's listing shows is absent or no directory without asking the file system", async () => {
    const fake = project();
    const cache = new FsProbeCache(fake);
    for (const name of ["a1", "a2", "a3", "a4"]) await cache.kind(fake.at("proj", "src", name));
    const listed = { readdir: fake.calls.readdir, stat: fake.calls.stat };
    for (const name of ["x.ts", "index.ts", "package.json", "y.ts", "z.ts"]) {
      expect(await cache.kind(fake.at("proj", "src", "nowhere", name)), name).toBe(null);
      expect(await cache.kind(fake.at("proj", "src", "Alpha.ts", name)), name).toBe(null);
      expect(await cache.kind(fake.at("proj", "src", "nowhere", "deeper", name)), name).toBe(null);
      expect(await cache.realpath(fake.at("proj", "src", "nowhere", name)), name).toBe(null);
    }
    expect(fake.calls.readdir).toBe(listed.readdir);
    expect(fake.calls.stat).toBe(listed.stat);
  });

  it("forgets everything on reset", async () => {
    const fake = project();
    const cache = new FsProbeCache(fake);
    for (const name of ["a1", "a2", "a3", "a4"]) await cache.kind(fake.at("proj", "src", name));
    const firstId = cache.id;
    expect(await cache.kind(fake.at("proj", "src", "late.ts"))).toBeNull();
    fake.file("proj/src/late.ts");
    expect(await cache.kind(fake.at("proj", "src", "late.ts"))).toBeNull();
    cache.reset();
    expect(cache.id).not.toBe(firstId);
    expect(await cache.kind(fake.at("proj", "src", "late.ts"))).toBe("file");
  });
});

describe("probe cache case rules", () => {
  it("reads case sensitivity from the directory with one lstat of a flipped name", async () => {
    const insensitive = new FakeFs(true);
    insensitive.mkdir("d");
    insensitive.file("d/Foo.ts");
    const insensitiveCache = new FsProbeCache(insensitive);
    for (const name of ["x1", "x2", "x3", "x4", "foo.ts", "FOO.TS", "Foo.ts", "foo.tsx"]) {
      await insensitiveCache.kind(insensitive.at("d", name));
    }
    expect(insensitive.calls.lstat).toBe(1);
    expect(await insensitiveCache.kind(insensitive.at("d", "foo.ts"))).toBe("file");
    expect(await insensitiveCache.kind(insensitive.at("d", "foo.tsx"))).toBeNull();

    const sensitive = new FakeFs(false);
    sensitive.mkdir("d");
    sensitive.file("d/Foo.ts");
    const sensitiveCache = new FsProbeCache(sensitive);
    for (const name of ["x1", "x2", "x3", "x4"]) await sensitiveCache.kind(sensitive.at("d", name));
    expect(await sensitiveCache.kind(sensitive.at("d", "foo.ts"))).toBeNull();
    expect(await sensitiveCache.kind(sensitive.at("d", "Foo.ts"))).toBe("file");
    expect(sensitive.calls.lstat).toBe(1);
  });

  it("treats two entries that differ by case as proof of a case-sensitive directory without asking", async () => {
    const fake = new FakeFs(false);
    fake.mkdir("d");
    fake.file("d/Util.ts");
    fake.file("d/util.ts");
    const cache = new FsProbeCache(fake);
    for (const name of ["x1", "x2", "x3", "x4"]) await cache.kind(fake.at("d", name));
    expect(await cache.kind(fake.at("d", "UTIL.ts"))).toBeNull();
    expect(await cache.kind(fake.at("d", "Util.ts"))).toBe("file");
    expect(await cache.kind(fake.at("d", "util.ts"))).toBe("file");
    expect(fake.calls.lstat).toBe(0);
  });

  it("lets the file system answer for non-ASCII names where the case rule is unproven", async () => {
    const fake = new FakeFs(true);
    fake.mkdir("d");
    fake.file("d/Stra\u00dfe.ts");
    fake.file("d/plain.ts");
    const cache = new FsProbeCache(fake);
    for (const name of ["x1", "x2", "x3", "x4"]) await cache.kind(fake.at("d", name));
    const statBefore = fake.calls.stat;
    for (const name of ["PLAIN.ts", "strasse.ts", "STRA\u00dfE.ts", "stra\u00dfe.ts", "Stra\u00dfe.ts"]) {
      const target = fake.at("d", name);
      expect(await cache.kind(target), name).toBe(fake.truthKind(target));
    }
    // The directory holds non-ASCII text, so a name that has no exact entry is checked with stat.
    expect(fake.calls.stat).toBeGreaterThan(statBefore);
  });

  it("lets the file system answer when names match up to Unicode normalization", async () => {
    const fake = new FakeFs(false, true);
    fake.mkdir("d");
    // The Kelvin sign normalizes to ASCII `K`, and an accented letter has two spellings.
    fake.file("d/\u212A.ts");
    fake.file("d/caf\u00e9.ts");
    fake.file("d/plain.ts");
    const cache = new FsProbeCache(fake);
    for (const name of ["x1", "x2", "x3", "x4"]) await cache.kind(fake.at("d", name));
    const statBefore = fake.calls.stat;
    for (const name of ["K.ts", "k.ts", "cafe\u0301.ts", "caf\u00e9.ts", "plain.ts", "missing.ts"]) {
      const target = fake.at("d", name);
      expect(await cache.kind(target), name).toBe(fake.truthKind(target));
    }
    expect(fake.truthKind(fake.at("d", "K.ts"))).toBe("file");
    expect(fake.calls.stat).toBeGreaterThan(statBefore);
  });

  it("answers from the listing on a normalization-insensitive volume that holds only ASCII names", async () => {
    const fake = new FakeFs(false, true);
    fake.mkdir("d");
    fake.file("d/plain.ts");
    const cache = new FsProbeCache(fake);
    for (const name of ["x1", "x2", "x3", "x4"]) await cache.kind(fake.at("d", name));
    const statBefore = fake.calls.stat;
    expect(await cache.kind(fake.at("d", "plain.ts"))).toBe("file");
    expect(await cache.kind(fake.at("d", "missing.ts"))).toBeNull();
    expect(fake.calls.stat).toBe(statBefore);
  });

  it("asks the file system for the real path of a name spelled in another case where realpath keeps the spelling", async () => {
    const fake = new FakeFs(true, false, false);
    fake.mkdir("d");
    fake.file("d/Alpha.ts");
    const cache = new FsProbeCache(fake);
    for (const name of ["x1", "x2", "x3", "x4"]) await cache.kind(fake.at("d", name));
    const exact = fake.at("d", "Alpha.ts");
    const other = fake.at("d", "alpha.ts");
    expect(await cache.realpath(exact)).toBe(fake.truthRealpath(exact));
    const afterExact = fake.calls.realpath;
    expect(await cache.realpath(exact)).toBe(fake.truthRealpath(exact));
    expect(fake.calls.realpath).toBe(afterExact);
    expect(await cache.realpath(other)).toBe(fake.truthRealpath(other));
    expect(fake.truthRealpath(other)).toBe(other);
    expect(fake.calls.realpath).toBe(afterExact + 1);
  });
});

describe("probe cache scope", () => {
  it("exists only inside a build and is shared by a build started inside it", async () => {
    expect(currentProbeCache()).toBeUndefined();
    const outer = await runWithProbeCache(async () => {
      const first = currentProbeCache();
      await Promise.resolve();
      const nested = await runWithProbeCache(() => Promise.resolve(currentProbeCache()));
      return { first, second: currentProbeCache(), nested };
    });
    expect(outer.first).toBeDefined();
    expect(outer.second).toBe(outer.first);
    expect(outer.nested).toBe(outer.first);
    expect(currentProbeCache()).toBeUndefined();
  });

  it("gives concurrent builds their own caches", async () => {
    const gate = Promise.withResolvers<void>();
    const builds = [0, 1, 2].map(() =>
      runWithProbeCache(async () => {
        await gate.promise;
        return currentProbeCache();
      }),
    );
    gate.resolve();
    const seen = await Promise.all(builds);
    expect(new Set(seen).size).toBe(3);
  });
});

describe("probe cache over the real file system", () => {
  async function truthKind(target: string): Promise<ProbeKind | null> {
    try {
      const stat = await fsp.stat(target);
      if (stat.isFile()) return "file";
      return stat.isDirectory() ? "directory" : "other";
    } catch {
      return null;
    }
  }

  async function truthRealpath(target: string): Promise<string | null> {
    try {
      return await fsp.realpath(target);
    } catch {
      return null;
    }
  }

  it("answers case variants, odd names, and links exactly as stat and realpath do on this platform", async () => {
    const root = await fsp.realpath(await roots.create("dg-probe-real-"));
    const src = path.join(root, "src");
    await fsp.mkdir(path.join(src, "Widget"), { recursive: true });
    await fsp.mkdir(path.join(root, "outside"), { recursive: true });
    for (const name of ["Alpha.ts", "beta.ts", "gamma.d.ts", "caf\u00e9.ts", "Widget/index.tsx", "..hidden.ts"]) {
      await fsp.writeFile(path.join(src, name), "export {};\n", "utf8");
    }
    await fsp.writeFile(path.join(root, "outside", "leak.ts"), "export {};\n", "utf8");
    await tryCreateDirectorySymlink(path.join(root, "outside"), path.join(src, "leak"));
    await tryCreateFileSymlink(path.join(src, "beta.ts"), path.join(src, "linked.ts"));

    const cache = new FsProbeCache();
    const names = [
      "Alpha.ts",
      "alpha.ts",
      "ALPHA.TS",
      "Alpha.ts.",
      "Alpha.ts ",
      "ALPHA~1.TS",
      "Alpha.ts::$DATA",
      "beta.ts",
      "Beta.TS",
      "gamma.d.ts",
      "GAMMA.D.TS",
      "gamma.ts",
      "caf\u00e9.ts",
      "CAF\u00c9.ts",
      "cafe\u0301.ts",
      "..hidden.ts",
      "..HIDDEN.ts",
      "nul.ts",
      "con",
      "Widget",
      "widget",
      "Widget/index.tsx",
      "widget/INDEX.TSX",
      "WIDGET/index.ts",
      "leak/leak.ts",
      "leak",
      "linked.ts",
      "linked.TS",
      "missing.ts",
      "missing/child.ts",
      "Alpha.ts/child",
      "../src/Alpha.ts",
      "./Alpha.ts",
    ];
    // Probing the whole list twice proves both the stat phase and the listed phase against the platform.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const name of names) {
        const target = path.join(src, ...name.split("/"));
        expect(await cache.kind(target), `${pass}:${name}`).toBe(await truthKind(target));
        expect(await cache.realpath(target), `${pass}:${name}`).toBe(await truthRealpath(target));
      }
    }
  });

  it("does not list a directory for a few probes", async () => {
    const root = await roots.create("dg-probe-few-");
    await fsp.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
    const cache = new FsProbeCache();
    expect(await cache.kind(path.join(root, "package.json"))).toBe("file");
    expect(await cache.kind(path.join(root, "pnpm-workspace.yaml"))).toBeNull();
    expect(await cache.kind(path.join(root, "lerna.json"))).toBeNull();
  });

  it("answers a drive or filesystem root and the paths around it as stat and realpath do", async () => {
    const tmp = os.tmpdir();
    const root = path.parse(tmp).root;
    const cache = new FsProbeCache();
    // Four different names list the root, so its own entry is then asked of a loaded listing.
    for (const name of ["rp-root-a", "rp-root-b", "rp-root-c", "rp-root-d"]) await cache.kind(path.join(root, name));
    const targets = [
      root,
      path.join(root, "."),
      path.join(root, "rp-root-missing", ".."),
      tmp,
      path.join(tmp, ".."),
      path.join(tmp, "rp-root-missing"),
    ];
    for (const target of targets) {
      expect(await cache.kind(target), target).toBe(await truthKind(target));
      expect(await cache.realpath(target), target).toBe(await truthRealpath(target));
    }
  });
});

describe.skipIf(process.platform !== "win32")("probe cache over a UNC share", () => {
  function share(): FakeFs {
    const fake = new FakeFs(true, false, true, "\\\\fake-server\\fake-share");
    fake.mkdir("src");
    fake.file("a.ts");
    fake.file("src/b.ts");
    return fake;
  }

  it("answers the share root, spelled in any form, and the paths around it as the file system does", async () => {
    const fake = share();
    const cache = new FsProbeCache(fake);
    // Four different names directly under the share list it, so its own root is then asked of a loaded listing.
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) await cache.kind(fake.at(name));
    expect(fake.calls.readdir).toBe(1);
    const targets = [
      fake.root,
      `${fake.root}\\`,
      `${fake.root}\\.`,
      `${fake.root}\\src\\..`,
      fake.at("a.ts"),
      fake.at("src"),
      fake.at("src", "b.ts"),
      fake.at("missing.ts"),
    ];
    for (const target of targets) {
      expect(await cache.kind(target), target).toBe(fake.truthKind(target));
      expect(await cache.realpath(target), target).toBe(fake.truthRealpath(target));
    }
  });

  it("answers a file directly under the share root from the share's listing", async () => {
    const fake = share();
    const cache = new FsProbeCache(fake);
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) await cache.kind(fake.at(name));
    const statBefore = fake.calls.stat;
    expect(await cache.kind(fake.at("a.ts"))).toBe("file");
    expect(await cache.kind(fake.at("A.TS"))).toBe("file");
    expect(await cache.kind(fake.at("e.ts"))).toBeNull();
    expect(fake.calls.stat).toBe(statBefore);
  });
});
