import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isFilePathWithinRoot, toProjectRelativePath } from "../src/util.js";
import { resetFileIdentityCaseSensitivityForTests } from "../src/util/paths.js";
import { createTempRootRegistry, tryCreateDirectorySymlink } from "./helpers/filesystem.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  vi.restoreAllMocks();
  await roots.cleanup();
});

function useWindowsPlatform(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) throw new Error("expected process.platform descriptor");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  return () => Object.defineProperty(process, "platform", descriptor);
}

describe("Windows alias containment", () => {
  it("keeps a path that is genuinely inside the root", async () => {
    const root = await roots.create("cg-alias-inside-");
    const file = path.join(root, "src", "main.ts");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    expect(isFilePathWithinRoot(root, file)).toBe(true);
    expect(toProjectRelativePath(root, file)).toBe("src/main.ts");
  });

  it("rejects an ordinary path outside the root without ancestor stats", async () => {
    const root = await roots.create("cg-alias-root-");
    const other = await roots.create("cg-alias-other-");
    const file = path.join(other, "outside.ts");
    await fsp.writeFile(file, "export {};\n", "utf8");
    const statSpy = vi.spyOn(fs, "statSync");

    expect(isFilePathWithinRoot(root, file)).toBe(false);
    expect(toProjectRelativePath(root, file)).toBeNull();
    expect(statSpy).not.toHaveBeenCalled();
  });

  it("skips ancestor stats when realpath only normalizes directory casing for an outside file", () => {
    const restorePlatform = useWindowsPlatform();
    resetFileIdentityCaseSensitivityForTests(true);
    const nativeSpy = vi.spyOn(fs.realpathSync, "native").mockImplementation((input) => {
      const filePath = typeof input === "string" ? input : String(input);
      const normalized = filePath.replace(/\\/g, "/");
      if (normalized === "C:/Repo") return "C:\\repo";
      if (normalized === "C:/Other/outside.ts") return "C:\\other\\outside.ts";
      return filePath.replace(/\//g, "\\");
    });
    const statSpy = vi.spyOn(fs, "statSync");

    try {
      expect(isFilePathWithinRoot("C:/Repo", "C:/Other/outside.ts")).toBe(false);
      expect(toProjectRelativePath("C:/Repo", "C:/Other/outside.ts")).toBeNull();
      expect(statSpy).not.toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
      nativeSpy.mockRestore();
      resetFileIdentityCaseSensitivityForTests();
      restorePlatform();
    }
  });

  it("treats a nested submodule path as inside both the superproject and the submodule", () => {
    const root = "C:/Game/Source";
    const submodule = "C:/Game/Source/Plugins/AmazonGameLift";
    const insideSubmodule = `${submodule}/Source/Bar.cpp`;
    const outsideSubmodule = `${root}/Runtime/Foo.cpp`;

    expect(isFilePathWithinRoot(root, insideSubmodule)).toBe(true);
    expect(toProjectRelativePath(root, insideSubmodule)).toBe("Plugins/AmazonGameLift/Source/Bar.cpp");
    expect(isFilePathWithinRoot(submodule, insideSubmodule)).toBe(true);
    expect(toProjectRelativePath(submodule, insideSubmodule)).toBe("Source/Bar.cpp");
    expect(isFilePathWithinRoot(root, outsideSubmodule)).toBe(true);
    expect(toProjectRelativePath(root, outsideSubmodule)).toBe("Runtime/Foo.cpp");
    expect(isFilePathWithinRoot(submodule, outsideSubmodule)).toBe(false);
    expect(toProjectRelativePath(submodule, outsideSubmodule)).toBeNull();
  });

  it("accepts Windows drive-letter case differences within the same root", () => {
    const root = "C:/Repo";
    const file = "c:/Repo/src/main.ts";

    expect(isFilePathWithinRoot(root, file)).toBe(true);
    expect(toProjectRelativePath(root, file)).toBe("src/main.ts");
  });

  it("relativizes POSIX absolute paths with POSIX semantics", () => {
    const root = "/mnt/e/git repos/codegraph";

    expect(isFilePathWithinRoot(root, `${root}/src/main.ts`)).toBe(true);
    expect(toProjectRelativePath(root, `${root}/src/main.ts`)).toBe("src/main.ts");
    expect(isFilePathWithinRoot(root, "/mnt/e/git repos/codegraph-tools/src/main.ts")).toBe(false);
    expect(toProjectRelativePath(root, "/mnt/e/git repos/codegraph-tools/src/main.ts")).toBeNull();
  });

  it("treats a realpath alias as inside the root when the lexical path is outside", () => {
    const restorePlatform = useWindowsPlatform();
    const nativeSpy = vi.spyOn(fs.realpathSync, "native").mockImplementation((input) => {
      const filePath = typeof input === "string" ? input : String(input);
      const normalized = filePath.replace(/\\/g, "/");
      if (normalized === "C:/Alias/src/main.ts") return "C:\\Repo\\src\\main.ts";
      if (normalized === "C:/Repo") return "C:\\Repo";
      return filePath.replace(/\//g, "\\");
    });

    try {
      expect(isFilePathWithinRoot("C:/Repo", "C:/Alias/src/main.ts")).toBe(true);
      expect(toProjectRelativePath("C:/Repo", "C:/Alias/src/main.ts")).toBe("src/main.ts");
    } finally {
      nativeSpy.mockRestore();
      restorePlatform();
    }
  });

  it("treats a physical file as inside when the root itself is a realpath alias", () => {
    const restorePlatform = useWindowsPlatform();
    const nativeSpy = vi.spyOn(fs.realpathSync, "native").mockImplementation((input) => {
      const filePath = typeof input === "string" ? input : String(input);
      const normalized = filePath.replace(/\\/g, "/");
      if (normalized === "C:/Alias") return "C:\\Repo";
      return filePath.replace(/\//g, "\\");
    });

    try {
      expect(isFilePathWithinRoot("C:/Alias", "C:/Repo/src/main.ts")).toBe(true);
      expect(toProjectRelativePath("C:/Alias", "C:/Repo/src/main.ts")).toBe("src/main.ts");
    } finally {
      nativeSpy.mockRestore();
      restorePlatform();
    }
  });

  it.skipIf(process.platform !== "win32")(
    "treats a file reached through a directory junction as inside the root",
    async () => {
      const realRoot = await roots.create("cg-alias-junction-real-");
      const parent = await roots.create("cg-alias-junction-parent-");
      const linkedRoot = path.join(parent, "alias");
      const created = await tryCreateDirectorySymlink(realRoot, linkedRoot);
      if (!created) {
        throw new Error("win32 could not create a directory junction");
      }

      const file = path.join(realRoot, "src", "main.ts");
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, "export const value = 1;\n", "utf8");
      const aliasedFile = path.join(linkedRoot, "src", "main.ts");

      expect(isFilePathWithinRoot(realRoot, aliasedFile)).toBe(true);
      expect(toProjectRelativePath(realRoot, aliasedFile)).toBe("src/main.ts");
    },
  );
});
