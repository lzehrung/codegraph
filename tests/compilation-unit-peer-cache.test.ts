import path from "node:path";
import { describe, expect, it } from "vitest";

import { getCompilationUnitPeers } from "../src/indexer/compilation-units.js";
import type { ParsedFileContext } from "../src/indexer/parse-context.js";
import type { ModuleIndex } from "../src/indexer/types.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { makeTestProjectIndex } from "./helpers/narrow.js";

type ScanStats = { visits: number };

type IndexedFile = {
  file: string;
  source: string;
};

function peerKeys(peers: { files: ReadonlySet<string> }): Set<string> {
  return new Set(Array.from(peers.files, (file) => fileIdentityKey(file)));
}

function instrumentByFile(map: Map<string, ModuleIndex>): ScanStats {
  const stats: ScanStats = { visits: 0 };
  const originalValues = map.values.bind(map);
  Object.defineProperty(map, "values", {
    configurable: true,
    value: function values(): IterableIterator<ModuleIndex> {
      const inner = originalValues();
      return {
        [Symbol.iterator]() {
          return this;
        },
        next() {
          const result = inner.next();
          if (!result.done) stats.visits += 1;
          return result;
        },
      };
    },
  });
  return stats;
}

function parsedSource(source: string): ParsedFileContext {
  return { source } as ParsedFileContext;
}

function stubIndex(files: readonly IndexedFile[]) {
  const byFile = new Map<string, ModuleIndex>();
  const parsed = new Map<string, ParsedFileContext>();
  for (const entry of files) {
    const key = fileIdentityKey(entry.file);
    byFile.set(key, { file: entry.file, exports: [], imports: [], locals: [] });
    parsed.set(key, parsedSource(entry.source));
  }
  const stats = instrumentByFile(byFile);
  const index = makeTestProjectIndex({ byFile, parsed, modules: byFile });
  return { index, stats, files: files.map((entry) => entry.file) };
}

function addIndexedFile(index: ReturnType<typeof makeTestProjectIndex>, entry: IndexedFile): void {
  const key = fileIdentityKey(entry.file);
  index.byFile.set(key, { file: entry.file, exports: [], imports: [], locals: [] });
  const parsed = index.parsed ?? new Map();
  index.parsed = parsed;
  parsed.set(key, parsedSource(entry.source));
}

describe("compilation-unit peer cache", () => {
  it("builds one per-index grouping and reuses it across file requests without quadratic module scans", () => {
    const root = path.resolve("cg-unit-peer-cache-root").replace(/\\/g, "/");
    const mainDir = `${root}/src/main`;
    const testDir = `${root}/src/test`;
    const otherDir = `${root}/src/other`;
    const csDir = `${root}/csharp`;
    const csOtherDir = `${root}/csharp-other`;
    const swiftDir = `${root}/swift`;
    const swiftOtherDir = `${root}/swift-other`;
    const goDir = `${root}/go`;
    const goOtherDir = `${root}/go-other`;

    const javaMain: IndexedFile[] = [];
    const javaTest: IndexedFile[] = [];
    const javaOther: IndexedFile[] = [];
    for (let i = 0; i < 24; i += 1) {
      javaMain.push({ file: `${mainDir}/Main${i}.java`, source: `package p;\nclass Main${i} {}\n` });
      javaTest.push({ file: `${testDir}/Test${i}.java`, source: `package p;\nclass Test${i} {}\n` });
      javaOther.push({ file: `${otherDir}/Other${i}.java`, source: `package q;\nclass Other${i} {}\n` });
    }
    const kotlinSibling: IndexedFile = {
      file: `${mainDir}/Lib.kt`,
      source: "package p\nclass Lib\n",
    };

    const csharpPeers: IndexedFile[] = [];
    const csharpUnrelated: IndexedFile[] = [];
    const csharpNested: IndexedFile[] = [];
    const csharpOther: IndexedFile[] = [];
    for (let i = 0; i < 12; i += 1) {
      csharpPeers.push({ file: `${csDir}/Peer${i}.cs`, source: `namespace P; class Peer${i} {}\n` });
      csharpUnrelated.push({ file: `${csDir}/Other${i}.cs`, source: `namespace Q; class Other${i} {}\n` });
      csharpNested.push({ file: `${csDir}/Nested${i}.cs`, source: `namespace P.Inner; class Nested${i} {}\n` });
      csharpOther.push({ file: `${csOtherDir}/Outside${i}.cs`, source: `namespace P; class Outside${i} {}\n` });
    }
    const csharpGlobal: IndexedFile = { file: `${csDir}/Global.cs`, source: "class Global {}\n" };

    const swiftPeers: IndexedFile[] = [];
    const swiftOutside: IndexedFile[] = [];
    for (let i = 0; i < 16; i += 1) {
      swiftPeers.push({ file: `${swiftDir}/A${i}.swift`, source: `func a${i}() {}\n` });
      swiftOutside.push({ file: `${swiftOtherDir}/B${i}.swift`, source: `func b${i}() {}\n` });
    }

    const goPeers: IndexedFile[] = [
      { file: `${goDir}/a.go`, source: "package p\nfunc Shared() int { return 1 }\n" },
      { file: `${goDir}/b.go`, source: "package p\nfunc Use() int { return Shared() }\n" },
    ];
    const goOther: IndexedFile = {
      file: `${goOtherDir}/c.go`,
      source: "package p\nfunc Other() int { return 1 }\n",
    };

    const allFiles = [
      ...javaMain,
      ...javaTest,
      ...javaOther,
      kotlinSibling,
      ...csharpPeers,
      ...csharpUnrelated,
      ...csharpNested,
      ...csharpOther,
      csharpGlobal,
      ...swiftPeers,
      ...swiftOutside,
      ...goPeers,
      goOther,
    ];
    const { index, stats, files } = stubIndex(allFiles);

    for (const file of files) {
      getCompilationUnitPeers(index, file);
      getCompilationUnitPeers(index, file, { csharpQualifiedName: true });
    }

    // Requesting every file must not require one full module walk per file.
    expect(stats.visits).toBeLessThan(files.length * 2);

    const javaPeerSet = new Set([
      fileIdentityKey(kotlinSibling.file),
      ...javaMain.map((entry) => fileIdentityKey(entry.file)),
    ]);
    const javaPeers = getCompilationUnitPeers(index, javaMain[0]!.file);
    expect(peerKeys(javaPeers)).toEqual(javaPeerSet);
    expect(javaPeers.complete).toBe(false);

    const otherJava = getCompilationUnitPeers(index, javaOther[0]!.file);
    expect(peerKeys(otherJava)).toEqual(new Set(javaOther.map((entry) => fileIdentityKey(entry.file))));
    expect(otherJava.complete).toBe(true);

    const csharpBare = getCompilationUnitPeers(index, csharpPeers[0]!.file);
    expect(peerKeys(csharpBare)).toEqual(
      new Set([
        fileIdentityKey(csharpGlobal.file),
        ...csharpPeers.map((entry) => fileIdentityKey(entry.file)),
        ...csharpNested.map((entry) => fileIdentityKey(entry.file)),
      ]),
    );
    expect(csharpBare.complete).toBe(false);

    const csharpUnrelatedPeers = getCompilationUnitPeers(index, csharpUnrelated[0]!.file);
    expect(peerKeys(csharpUnrelatedPeers)).toEqual(
      new Set([fileIdentityKey(csharpGlobal.file), ...csharpUnrelated.map((entry) => fileIdentityKey(entry.file))]),
    );
    // An unrelated namespace in another directory must not mark this unit incomplete.
    expect(csharpUnrelatedPeers.complete).toBe(true);

    const csharpQualified = getCompilationUnitPeers(index, csharpPeers[0]!.file, { csharpQualifiedName: true });
    expect(peerKeys(csharpQualified)).toEqual(
      new Set([
        fileIdentityKey(csharpGlobal.file),
        ...csharpPeers.map((entry) => fileIdentityKey(entry.file)),
        ...csharpNested.map((entry) => fileIdentityKey(entry.file)),
        ...csharpUnrelated.map((entry) => fileIdentityKey(entry.file)),
      ]),
    );
    expect(csharpQualified.complete).toBe(false);

    const swiftResult = getCompilationUnitPeers(index, swiftPeers[0]!.file);
    expect(peerKeys(swiftResult)).toEqual(new Set(swiftPeers.map((entry) => fileIdentityKey(entry.file))));
    expect(swiftResult.complete).toBe(false);

    const goResult = getCompilationUnitPeers(index, goPeers[0]!.file);
    expect(peerKeys(goResult)).toEqual(new Set(goPeers.map((entry) => fileIdentityKey(entry.file))));
    expect(goResult.complete).toBe(true);
  });

  it("reports partial coverage when an indexed peer's declaration source is unreadable", () => {
    const root = path.resolve("cg-unit-peer-cache-unreadable").replace(/\\/g, "/");
    const java: IndexedFile = { file: root + "/pkg/A.java", source: "package p;\nclass A {}\n" };
    const unknownJava: IndexedFile = { file: root + "/other/B.java", source: "" };
    const jvm = stubIndex([java, unknownJava]);
    jvm.index.parsed?.delete(fileIdentityKey(unknownJava.file));
    const javaPeers = getCompilationUnitPeers(jvm.index, java.file);
    expect(peerKeys(javaPeers)).toEqual(new Set([fileIdentityKey(java.file)]));
    expect(javaPeers.complete).toBe(false);
    const unnamed = stubIndex([java, { file: root + "/other/C.java", source: "class C {}\n" }]);
    expect(getCompilationUnitPeers(unnamed.index, java.file).complete).toBe(true);

    const csharp: IndexedFile = { file: root + "/cs/A.cs", source: "namespace P; class A {}\n" };
    const unknownCsharp: IndexedFile = { file: root + "/cs-other/B.cs", source: "" };
    const cs = stubIndex([csharp, unknownCsharp]);
    cs.index.parsed?.delete(fileIdentityKey(unknownCsharp.file));
    const csharpPeers = getCompilationUnitPeers(cs.index, csharp.file);
    expect(peerKeys(csharpPeers)).toEqual(new Set([fileIdentityKey(csharp.file)]));
    expect(csharpPeers.complete).toBe(false);

    const go: IndexedFile = { file: root + "/go/a.go", source: "package p\nfunc A() {}\n" };
    const unknownGo: IndexedFile = { file: root + "/go/b.go", source: "" };
    const golang = stubIndex([go, unknownGo]);
    golang.index.parsed?.delete(fileIdentityKey(unknownGo.file));
    const goPeers = getCompilationUnitPeers(golang.index, go.file);
    expect(peerKeys(goPeers)).toEqual(new Set([fileIdentityKey(go.file)]));
    expect(goPeers.complete).toBe(false);
    const outside = stubIndex([go, { file: root + "/go-other/c.go", source: "" }]);
    outside.index.parsed?.delete(fileIdentityKey(root + "/go-other/c.go"));
    expect(getCompilationUnitPeers(outside.index, go.file).complete).toBe(true);
  });
  it("invalidates cached peers when a warm index gains a same-package sibling", () => {
    const root = path.resolve("cg-unit-peer-cache-warm").replace(/\\/g, "/");
    const first: IndexedFile = { file: `${root}/A.java`, source: "package p;\nclass A {}\n" };
    const { index } = stubIndex([first]);
    const before = getCompilationUnitPeers(index, first.file);
    expect(peerKeys(before)).toEqual(new Set([fileIdentityKey(first.file)]));

    const second: IndexedFile = { file: `${root}/B.java`, source: "package p;\nclass B {}\n" };
    addIndexedFile(index, second);

    const after = getCompilationUnitPeers(index, first.file);
    expect(peerKeys(after)).toEqual(new Set([fileIdentityKey(first.file), fileIdentityKey(second.file)]));
  });

  it("invalidates cached peers when a warm index loses a same-package sibling", () => {
    const root = path.resolve("cg-unit-peer-cache-warm-lose").replace(/\\/g, "/");
    const first: IndexedFile = { file: `${root}/A.java`, source: "package p;\nclass A {}\n" };
    const second: IndexedFile = { file: `${root}/B.java`, source: "package p;\nclass B {}\n" };
    const { index } = stubIndex([first, second]);
    const before = getCompilationUnitPeers(index, first.file);
    expect(peerKeys(before)).toEqual(new Set([fileIdentityKey(first.file), fileIdentityKey(second.file)]));

    index.byFile.delete(fileIdentityKey(second.file));
    index.parsed?.delete(fileIdentityKey(second.file));

    const after = getCompilationUnitPeers(index, first.file);
    expect(peerKeys(after)).toEqual(new Set([fileIdentityKey(first.file)]));
  });

  it("invalidates cached peers when a warm index remaps language extensions", () => {
    const root = path.resolve("cg-unit-peer-cache-warm-remap").replace(/\\/g, "/");
    const kotlinMapped: IndexedFile = { file: `${root}/A.jvm`, source: "package p\nclass A\n" };
    const javaSibling: IndexedFile = { file: `${root}/B.java`, source: "package p;\nclass B {}\n" };
    const { index } = stubIndex([kotlinMapped, javaSibling]);
    const before = getCompilationUnitPeers(index, kotlinMapped.file);
    expect(peerKeys(before)).toEqual(new Set([fileIdentityKey(kotlinMapped.file)]));
    expect(before.complete).toBe(false);

    index.languageExtensions = { ".jvm": "kotlin" };

    const after = getCompilationUnitPeers(index, kotlinMapped.file);
    expect(peerKeys(after)).toEqual(new Set([fileIdentityKey(kotlinMapped.file), fileIdentityKey(javaSibling.file)]));
  });

  it("rebuilds Go directory peers on a warm index without adopting another directory", () => {
    const root = path.resolve("cg-unit-peer-cache-warm-go").replace(/\\/g, "/");
    const first: IndexedFile = { file: `${root}/pkg/a.go`, source: "package p\nfunc A() {}\n" };
    const { index } = stubIndex([first]);
    const before = getCompilationUnitPeers(index, first.file);
    expect(peerKeys(before)).toEqual(new Set([fileIdentityKey(first.file)]));

    const sibling: IndexedFile = { file: `${root}/pkg/b.go`, source: "package p\nfunc B() {}\n" };
    addIndexedFile(index, sibling);
    const otherDir: IndexedFile = { file: `${root}/other/c.go`, source: "package p\nfunc C() {}\n" };
    addIndexedFile(index, otherDir);

    const after = getCompilationUnitPeers(index, first.file);
    expect(peerKeys(after)).toEqual(new Set([fileIdentityKey(first.file), fileIdentityKey(sibling.file)]));
    expect(after.complete).toBe(true);
  });
});
