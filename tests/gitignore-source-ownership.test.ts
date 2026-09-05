import fs from "node:fs";
import type { BigIntStats } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitIgnoreSourceOwnershipLookup,
  owningGitIgnoreSourceRoot,
  type GitIgnoreSourceRoot,
} from "../src/util/projectFiles.js";

const superproject: GitIgnoreSourceRoot = {
  path: "C:/Game/Source",
  repositoryRoot: "C:/Game/Source",
};
const submodule: GitIgnoreSourceRoot = {
  path: "C:/Game/Source/Plugins/AmazonGameLift",
  repositoryRoot: "C:/Game/Source/Plugins/AmazonGameLift",
};
const shortAlias: GitIgnoreSourceRoot = {
  path: "C:/Game/Source/Plugins/AmazonGameLift",
  repositoryRoot: "C:/Game/Source",
};
const longAlias: GitIgnoreSourceRoot = {
  path: "C:/Game/Source/Plugins/AmazonGameLift",
  repositoryRoot: "C:/Game/Source/Plugins/AmazonGameLift",
};

const aliasedSuper: GitIgnoreSourceRoot = {
  path: "C:/Alias",
  repositoryRoot: "C:/Alias",
};
const aliasedSub: GitIgnoreSourceRoot = {
  path: "C:/Alias/Plugins/AmazonGameLift",
  repositoryRoot: "C:/Alias/Plugins/AmazonGameLift",
};

afterEach(() => {
  vi.restoreAllMocks();
});

function useWindowsPlatform(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) throw new Error("expected process.platform descriptor");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  return () => Object.defineProperty(process, "platform", descriptor);
}

function toWindowsPath(filePath: string): string {
  return filePath.replace(/\//g, "\\");
}

function aliasToPhysical(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized === "C:/Alias" || normalized.startsWith("C:/Alias/")) {
    return toWindowsPath(normalized.replace("C:/Alias", "C:/Game/Source"));
  }
  return toWindowsPath(normalized);
}

function fakeDirectoryStat(filePath: string): BigIntStats {
  let hash = 1n;
  for (const character of filePath) {
    hash = (hash * 33n + BigInt(character.charCodeAt(0))) & 0xffffffffn;
  }
  return {
    ino: hash === 0n ? 1n : hash,
    dev: 1n,
    birthtimeNs: 0n,
  } as BigIntStats;
}

function countCalls(calls: readonly string[], target: string): number {
  return calls.filter((filePath) => filePath === target).length;
}

describe("Git ignore source ownership", () => {
  it("attributes candidates inside and outside a nested submodule", () => {
    const outside = "C:/Game/Source/Runtime/Foo.cpp";
    const inside = "C:/Game/Source/Plugins/AmazonGameLift/Source/Bar.cpp";
    const realpathMemo = new Map<string, string>();
    const roots = [superproject, submodule];

    expect(owningGitIgnoreSourceRoot(outside, roots, realpathMemo)).toEqual(superproject);
    expect(owningGitIgnoreSourceRoot(inside, roots, realpathMemo)).toEqual(submodule);
  });

  it("prefers the root with the longer repositoryRoot when both contain the candidate", () => {
    const file = "C:/Game/Source/Plugins/AmazonGameLift/Source/Bar.cpp";
    const realpathMemo = new Map<string, string>();

    expect(owningGitIgnoreSourceRoot(file, [shortAlias, longAlias], realpathMemo)).toEqual(longAlias);
    expect(owningGitIgnoreSourceRoot(file, [longAlias, shortAlias], realpathMemo)).toEqual(longAlias);
  });

  it("does not reuse ownership memos across discovery passes", () => {
    const inside = "C:/Game/Source/Plugins/AmazonGameLift/Source/Bar.cpp";
    const firstPass = createGitIgnoreSourceOwnershipLookup([superproject, submodule], new Map());
    const secondPass = createGitIgnoreSourceOwnershipLookup([superproject], new Map());

    expect(firstPass(inside)).toEqual(submodule);
    expect(secondPass(inside)).toEqual(superproject);
    expect(firstPass(inside)).toEqual(submodule);
  });

  it("attributes the same owning root through an aliased source when the lexical short-circuit is inert", () => {
    const restorePlatform = useWindowsPlatform();
    const realpathCalls: string[] = [];
    const bigintStatCalls: string[] = [];
    const nativeSpy = vi.spyOn(fs.realpathSync, "native").mockImplementation((input) => {
      const filePath = typeof input === "string" ? input : String(input);
      realpathCalls.push(filePath.replace(/\\/g, "/"));
      return aliasToPhysical(filePath);
    });
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, opts?: fs.StatSyncOptions) => {
      const filePath = typeof target === "string" ? target : String(target);
      if (opts && "bigint" in opts && opts.bigint) {
        bigintStatCalls.push(filePath.replace(/\\/g, "/"));
        return fakeDirectoryStat(filePath);
      }
      throw new Error(`unexpected non-bigint statSync: ${filePath}`);
    }) as typeof fs.statSync);

    const firstRuntime = "C:/Alias/Runtime/Foo.cpp";
    const siblingRuntime = "C:/Alias/Runtime/Bar.cpp";
    const otherRuntime = "C:/Alias/Runtime/Baz.cpp";
    const firstInside = "C:/Alias/Plugins/AmazonGameLift/Source/A.cpp";
    const siblingInside = "C:/Alias/Plugins/AmazonGameLift/Source/B.cpp";
    const firstPhysical = "C:/Game/Source/Engine/One.cpp";
    const siblingPhysical = "C:/Game/Source/Engine/Two.cpp";
    const roots = [aliasedSuper, aliasedSub];

    try {
      const realpathMemo = new Map<string, string>();
      const lookup = createGitIgnoreSourceOwnershipLookup(roots, realpathMemo);
      expect(lookup(firstRuntime)).toEqual(aliasedSuper);
      expect(bigintStatCalls.length).toBeGreaterThan(0);
      const realpathAfterFirstRuntime = realpathCalls.length;
      const statsAfterFirstRuntime = bigintStatCalls.length;
      const submoduleRealpathsAfterFirst = countCalls(realpathCalls, aliasedSub.path);

      expect(lookup(siblingRuntime)).toEqual(aliasedSuper);
      expect(lookup(otherRuntime)).toEqual(aliasedSuper);
      expect(realpathCalls.length).toBe(realpathAfterFirstRuntime);
      expect(bigintStatCalls.length).toBe(statsAfterFirstRuntime);

      expect(lookup(firstPhysical)).toEqual(aliasedSuper);
      expect(countCalls(realpathCalls, aliasedSub.path)).toBe(submoduleRealpathsAfterFirst);
      const realpathAfterFirstPhysical = realpathCalls.length;
      const statsAfterFirstPhysical = bigintStatCalls.length;
      expect(lookup(siblingPhysical)).toEqual(aliasedSuper);
      expect(realpathCalls.length).toBe(realpathAfterFirstPhysical);
      expect(bigintStatCalls.length).toBe(statsAfterFirstPhysical);

      expect(lookup(firstInside)).toEqual(aliasedSub);
      const realpathAfterFirstInside = realpathCalls.length;
      expect(lookup(siblingInside)).toEqual(aliasedSub);
      expect(realpathCalls.length).toBe(realpathAfterFirstInside);

      expect(owningGitIgnoreSourceRoot(firstRuntime, roots, realpathMemo)).toEqual(aliasedSuper);
      expect(owningGitIgnoreSourceRoot(firstInside, roots, realpathMemo)).toEqual(aliasedSub);
      expect(owningGitIgnoreSourceRoot(firstPhysical, roots, realpathMemo)).toEqual(aliasedSuper);
    } finally {
      statSpy.mockRestore();
      nativeSpy.mockRestore();
      restorePlatform();
    }
  });

  it("does not reuse realpath memos across discovery passes", () => {
    const restorePlatform = useWindowsPlatform();
    let physicalRoot = "C:\\Game\\Source";
    const nativeSpy = vi.spyOn(fs.realpathSync, "native").mockImplementation((input) => {
      const filePath = typeof input === "string" ? input : String(input);
      const normalized = filePath.replace(/\\/g, "/");
      if (normalized === "C:/Alias") return physicalRoot;
      return filePath.replace(/\//g, "\\");
    });

    try {
      const file = "C:/Game/Source/Runtime/Foo.cpp";
      expect(owningGitIgnoreSourceRoot(file, [aliasedSuper], new Map())).toEqual(aliasedSuper);
      physicalRoot = "C:\\Other\\Source";
      expect(owningGitIgnoreSourceRoot(file, [aliasedSuper], new Map())).toBeUndefined();
    } finally {
      nativeSpy.mockRestore();
      restorePlatform();
    }
  });
});
