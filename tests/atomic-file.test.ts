import { randomUUID } from "node:crypto";
import fsp, { type FileHandle } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomically, writeFileAtomicallyFrom } from "../src/util/atomic-file.js";
import { createTempRootRegistry, openFifoForReading, tryCreateFifo, withUmask } from "./helpers/filesystem.js";

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

const writers: Array<[string, (target: string, content: string) => Promise<void>]> = [
  ["writeFileAtomically", (target, content) => writeFileAtomically(target, content)],
  [
    "writeFileAtomicallyFrom",
    (target, content) =>
      writeFileAtomicallyFrom(target, async (handle) => {
        await handle.writeFile(content);
      }),
  ],
];

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

// POSIX permission bits do not exist on Windows: a mode there carries only the read-only attribute, and the writers
// copy nothing on that platform. These tests run in the Linux and macOS CI lanes.
describe.skipIf(process.platform === "win32")("permission bits of a replaced file", () => {
  const modeOf = async (file: string): Promise<number> => (await fsp.stat(file)).mode & 0o7777;

  describe.each(writers)("%s", (_name, write) => {
    it.each([
      { why: "keeps a private file private", mode: 0o600, umask: 0o022 },
      { why: "keeps the group write bit that the umask would remove", mode: 0o664, umask: 0o022 },
      { why: "keeps the group and other bits that the umask would remove", mode: 0o755, umask: 0o077 },
      { why: "replaces a read-only file and keeps it read-only", mode: 0o444, umask: 0o022 },
    ])("$why", async ({ mode, umask }) => {
      const root = await roots.create("cg-atomic-mode-");
      const target = path.join(root, "state.json");
      await fsp.writeFile(target, "previous", "utf8");
      await fsp.chmod(target, mode);

      await withUmask(umask, () => write(target, "next"));

      await expect(fsp.readFile(target, "utf8")).resolves.toBe("next");
      expect(await modeOf(target)).toBe(mode);
      expect(await temporaryNames(root)).toEqual([]);
    });

    it("gives a new file the default mode of the umask", async () => {
      const root = await roots.create("cg-atomic-mode-new-");
      const target = path.join(root, "state.json");

      // 0o666 without the bits that 0o027 removes.
      await withUmask(0o027, () => write(target, "next"));

      expect(await modeOf(target)).toBe(0o640);
    });

    it("takes the mode from the file a symbolic link points to and replaces the link with a regular file", async () => {
      const root = await roots.create("cg-atomic-mode-link-");
      const real = path.join(root, "real.json");
      const link = path.join(root, "link.json");
      await fsp.writeFile(real, "previous", "utf8");
      await fsp.chmod(real, 0o640);
      await fsp.symlink(real, link);

      await withUmask(0o022, () => write(link, "next"));

      expect((await fsp.lstat(link)).isSymbolicLink()).toBe(false);
      expect(await modeOf(link)).toBe(0o640);
      await expect(fsp.readFile(link, "utf8")).resolves.toBe("next");
      // The file the link used to point to is not touched.
      await expect(fsp.readFile(real, "utf8")).resolves.toBe("previous");
    });
  });

  it("never opens the new content to more users than the old content had, even before the rename", async () => {
    const root = await roots.create("cg-atomic-mode-window-");
    const target = path.join(root, "secret.json");
    await fsp.writeFile(target, "previous", "utf8");
    await fsp.chmod(target, 0o600);
    let modeWhileWriting = 0;

    await withUmask(0o022, () =>
      writeFileAtomicallyFrom(target, async (handle) => {
        modeWhileWriting = (await handle.stat()).mode & 0o777;
        await handle.writeFile("secret");
      }),
    );

    expect(modeWhileWriting).toBe(0o600);
  });
});

describe("a destination that is not a regular file", () => {
  describe.each(writers)("%s", (_name, write) => {
    it("fails for a directory and leaves it, and what is in it, alone", async () => {
      const root = await roots.create("cg-atomic-dir-");
      const target = path.join(root, "output");
      await fsp.mkdir(target);
      await fsp.writeFile(path.join(target, "keep.txt"), "kept", "utf8");

      await expect(write(target, "next")).rejects.toMatchObject({ code: "EISDIR" });

      expect(await fsp.readdir(root)).toEqual(["output"]);
      expect(await fsp.readdir(target)).toEqual(["keep.txt"]);
    });
  });
});

// A FIFO and /dev/null are on Linux and macOS. Windows has the NUL device and named pipes, which are covered below.
describe.skipIf(process.platform === "win32")("a FIFO or a device on a POSIX platform", () => {
  describe.each(writers)("%s", (_name, write) => {
    it("writes into a FIFO in place: it stays a FIFO, and no temporary file is made", async () => {
      const root = await roots.create("cg-atomic-fifo-");
      const fifo = path.join(root, "pipe");
      if (!(await tryCreateFifo(fifo))) return;
      const reader = await openFifoForReading(fifo);
      try {
        await write(fifo, "next content");

        expect((await fsp.lstat(fifo)).isFIFO()).toBe(true);
        await expect(reader.readFile("utf8")).resolves.toBe("next content");
        expect(await fsp.readdir(root)).toEqual(["pipe"]);
      } finally {
        await reader.close();
      }
    });

    it("judges a symbolic link by its target: a link to a FIFO feeds the FIFO and stays a link", async () => {
      const root = await roots.create("cg-atomic-fifo-link-");
      const fifo = path.join(root, "pipe");
      const link = path.join(root, "link");
      if (!(await tryCreateFifo(fifo))) return;
      await fsp.symlink(fifo, link);
      const reader = await openFifoForReading(fifo);
      try {
        await write(link, "next content");

        expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
        expect((await fsp.lstat(fifo)).isFIFO()).toBe(true);
        await expect(reader.readFile("utf8")).resolves.toBe("next content");
        expect((await fsp.readdir(root)).sort()).toEqual(["link", "pipe"]);
      } finally {
        await reader.close();
      }
    });

    // Root could rename a file over the device, so the test that names /dev/null runs for other users only.
    it.skipIf(process.getuid?.() === 0)("writes to /dev/null and leaves the device in place", async () => {
      await write("/dev/null", "discarded");

      expect((await fsp.stat("/dev/null")).isCharacterDevice()).toBe(true);
    });
  });

  it("calls fill once with the FIFO itself, and keeps the FIFO when fill fails", async () => {
    const root = await roots.create("cg-atomic-fifo-fill-");
    const fifo = path.join(root, "pipe");
    if (!(await tryCreateFifo(fifo))) return;
    const reader = await openFifoForReading(fifo);
    // The error looks like transient contention, but "half" has gone out, so a write in place cannot be tried again.
    const fill = vi.fn(async (handle: FileHandle) => {
      await handle.writeFile("half");
      throw fileError("EBUSY");
    });
    try {
      await expect(writeFileAtomicallyFrom(fifo, fill)).rejects.toMatchObject({ code: "EBUSY" });

      expect(fill).toHaveBeenCalledTimes(1);
      expect((await fsp.lstat(fifo)).isFIFO()).toBe(true);
      await expect(reader.readFile("utf8")).resolves.toBe("half");
      expect(await fsp.readdir(root)).toEqual(["pipe"]);
    } finally {
      await reader.close();
    }
  });
});

// Windows has no FIFO and no /dev/null; its counterparts are the NUL device and named pipes. `stat` by path reports a
// named pipe as a regular file there, and `Stats.isFIFO()` is always false, so the pipe test reads what the server got.
describe.skipIf(process.platform !== "win32")("a device or a named pipe on Windows", () => {
  const nul = "\\\\.\\NUL";

  it("writes to the NUL device", async () => {
    await expect(writeFileAtomically(nul, "discarded")).resolves.toBeUndefined();
  });

  it("hands fill the NUL device itself", async () => {
    let isDevice = false;
    await writeFileAtomicallyFrom(nul, async (handle) => {
      isDevice = (await handle.stat()).isCharacterDevice();
      await handle.writeFile("discarded");
    });

    expect(isDevice).toBe(true);
  });

  it.each(writers)(
    "%s writes to a named pipe through one connection and makes no temporary file",
    async (_name, write) => {
      const pipePath = `\\\\.\\pipe\\cg-atomic-${randomUUID()}`;
      let connections = 0;
      const received: Buffer[] = [];
      let onClosed: () => void = () => undefined;
      const closed = new Promise<void>((resolve) => {
        onClosed = resolve;
      });
      const server = net.createServer((socket) => {
        connections += 1;
        socket.on("data", (chunk: Buffer) => received.push(chunk));
        socket.on("close", onClosed);
      });
      await new Promise<void>((resolve) => server.listen(pipePath, resolve));
      try {
        await write(pipePath, "next content");
        await closed;

        expect(Buffer.concat(received).toString("utf8")).toBe("next content");
        // Inspecting a pipe connects to it, which would use up the connection of a server that takes just one.
        expect(connections).toBe(1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
