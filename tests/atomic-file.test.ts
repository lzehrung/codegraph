import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomically, writeFileAtomicallyFrom } from "../src/util/atomic-file.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  vi.restoreAllMocks();
  await roots.cleanup();
});

function fileError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

async function temporaryNames(directory: string): Promise<string[]> {
  return (await fsp.readdir(directory)).filter((name) => name.endsWith(".tmp"));
}

describe("writeFileAtomically", () => {
  it.each(["EBUSY", "EPERM", "ENOTEMPTY"])("retries a rename that fails with %s", async (code) => {
    const root = await roots.create("cg-atomic-transient-");
    const target = path.join(root, "state.json");
    await fsp.writeFile(target, "previous", "utf8");
    const renameSpy = vi.spyOn(fsp, "rename").mockRejectedValueOnce(fileError(code));

    await writeFileAtomically(target, Buffer.from("next"));

    expect(renameSpy).toHaveBeenCalledTimes(2);
    await expect(fsp.readFile(target, "utf8")).resolves.toBe("next");
    expect(await temporaryNames(root)).toEqual([]);
  });

  it("throws the contention error after four retries and keeps the previous content", async () => {
    const root = await roots.create("cg-atomic-budget-");
    const target = path.join(root, "state.json");
    await fsp.writeFile(target, "previous", "utf8");
    const renameSpy = vi.spyOn(fsp, "rename").mockRejectedValue(fileError("EBUSY"));

    await expect(writeFileAtomically(target, "next")).rejects.toMatchObject({ code: "EBUSY" });

    expect(renameSpy).toHaveBeenCalledTimes(5);
    await expect(fsp.readFile(target, "utf8")).resolves.toBe("previous");
    expect(await temporaryNames(root)).toEqual([]);
  });

  it("does not retry a failure that is not transient contention", async () => {
    const root = await roots.create("cg-atomic-permanent-");
    const target = path.join(root, "state.json");
    const renameSpy = vi.spyOn(fsp, "rename").mockRejectedValue(fileError("EACCES"));

    await expect(writeFileAtomically(target, "next")).rejects.toMatchObject({ code: "EACCES" });

    expect(renameSpy).toHaveBeenCalledTimes(1);
    await expect(fsp.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await temporaryNames(root)).toEqual([]);
  });
});

describe("writeFileAtomicallyFrom", () => {
  it("replaces the file only once the content is complete", async () => {
    const root = await roots.create("cg-atomic-from-");
    const target = path.join(root, "state.json");
    await fsp.writeFile(target, "previous", "utf8");

    await writeFileAtomicallyFrom(target, async (handle) => {
      await handle.writeFile("next ");
      // Half written: a reader still sees the previous content, and the half is in a temporary file.
      await expect(fsp.readFile(target, "utf8")).resolves.toBe("previous");
      expect(await temporaryNames(root)).toHaveLength(1);
      await handle.writeFile("content");
    });

    await expect(fsp.readFile(target, "utf8")).resolves.toBe("next content");
    expect(await temporaryNames(root)).toEqual([]);
  });

  it("keeps a previous file and leaves no temporary file when the content cannot be produced", async () => {
    const root = await roots.create("cg-atomic-from-fail-");
    const target = path.join(root, "state.json");
    await fsp.writeFile(target, "previous", "utf8");

    await expect(
      writeFileAtomicallyFrom(target, async (handle) => {
        await handle.writeFile("half");
        throw new Error("producer failed");
      }),
    ).rejects.toThrow("producer failed");

    await expect(fsp.readFile(target, "utf8")).resolves.toBe("previous");
    expect(await fsp.readdir(root)).toEqual(["state.json"]);
  });

  it("keeps a previous file when the temporary file cannot be opened", async () => {
    const root = await roots.create("cg-atomic-from-open-");
    const target = path.join(root, "state.json");
    await fsp.writeFile(target, "previous", "utf8");
    const fill = vi.fn(async (_handle: FileHandle) => undefined);
    vi.spyOn(fsp, "open").mockRejectedValueOnce(fileError("EACCES"));

    await expect(writeFileAtomicallyFrom(target, fill)).rejects.toMatchObject({ code: "EACCES" });

    expect(fill).not.toHaveBeenCalled();
    await expect(fsp.readFile(target, "utf8")).resolves.toBe("previous");
    expect(await fsp.readdir(root)).toEqual(["state.json"]);
  });

  it("produces the content again for a fresh temporary file after transient contention", async () => {
    const root = await roots.create("cg-atomic-from-retry-");
    const target = path.join(root, "state.json");
    await fsp.writeFile(target, "previous", "utf8");
    const renameSpy = vi.spyOn(fsp, "rename").mockRejectedValueOnce(fileError("EBUSY"));
    const fill = vi.fn(async (handle: FileHandle) => {
      await handle.writeFile("next");
    });

    await writeFileAtomicallyFrom(target, fill);

    expect(fill).toHaveBeenCalledTimes(2);
    expect(renameSpy).toHaveBeenCalledTimes(2);
    await expect(fsp.readFile(target, "utf8")).resolves.toBe("next");
    expect(await temporaryNames(root)).toEqual([]);
  });
});
