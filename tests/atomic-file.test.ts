import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomically } from "../src/util/atomic-file.js";
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
