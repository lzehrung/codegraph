import { randomUUID } from "node:crypto";
import fsp, { type FileHandle } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomically, writeFileAtomicallyFrom, type AtomicWriteOptions } from "../src/util/atomic-file.js";
import {
  createTempRootRegistry,
  openFifoForReading,
  tryCreateFifo,
  tryCreateFileSymlink,
  withUmask,
} from "./helpers/filesystem.js";
import { runTsxScriptWithStdoutFile } from "./helpers/tsx.js";

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

type Write = (target: string, content: string, options?: AtomicWriteOptions) => Promise<void>;

const writers: Array<[string, Write]> = [
  ["writeFileAtomically", (target, content, options) => writeFileAtomically(target, content, options)],
  [
    "writeFileAtomicallyFrom",
    (target, content, options) =>
      writeFileAtomicallyFrom(
        target,
        async (handle) => {
          await handle.writeFile(content);
        },
        options,
      ),
  ],
];

/** A destination the user named, as `graph --json --output <path>` passes it. */
const userDestination: AtomicWriteOptions = { userDestination: true };

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

// Without `userDestination` a writer replaces the directory entry at the path and nothing else. The disk cache is written
// this way, so a link planted at a cache file path cannot send a write to a file outside the cache.
describe("a file that codegraph owns (no userDestination)", () => {
  describe.each(writers)("%s", (_name, write) => {
    it("replaces a symbolic link at the path and never writes the file the link points to", async () => {
      const root = await roots.create("cg-atomic-owned-link-");
      const cacheDir = path.join(root, "cache");
      const outsideDir = path.join(root, "outside");
      await fsp.mkdir(cacheDir);
      await fsp.mkdir(outsideDir);
      const outside = path.join(outsideDir, "secret.txt");
      const entry = path.join(cacheDir, "state.json");
      await fsp.writeFile(outside, "outside\n", "utf8");
      if (!(await tryCreateFileSymlink(outside, entry))) return;

      await write(entry, "next");

      expect((await fsp.lstat(entry)).isSymbolicLink()).toBe(false);
      await expect(fsp.readFile(entry, "utf8")).resolves.toBe("next");
      await expect(fsp.readFile(outside, "utf8")).resolves.toBe("outside\n");
      expect(await fsp.readdir(cacheDir)).toEqual(["state.json"]);
      expect(await fsp.readdir(outsideDir)).toEqual(["secret.txt"]);
    });

    it("replaces a symbolic link that points at nothing, and creates nothing where it pointed", async () => {
      const root = await roots.create("cg-atomic-owned-dangling-");
      const cacheDir = path.join(root, "cache");
      const outsideDir = path.join(root, "outside");
      await fsp.mkdir(cacheDir);
      await fsp.mkdir(outsideDir);
      const entry = path.join(cacheDir, "state.json");
      if (!(await tryCreateFileSymlink(path.join(outsideDir, "created.txt"), entry))) return;

      await write(entry, "next");

      expect((await fsp.lstat(entry)).isSymbolicLink()).toBe(false);
      await expect(fsp.readFile(entry, "utf8")).resolves.toBe("next");
      expect(await fsp.readdir(outsideDir)).toEqual([]);
    });

    // A descriptor path and a FIFO exist on Linux and macOS only.
    it.skipIf(process.platform === "win32")(
      "replaces a symbolic link to a descriptor path and never writes the file behind it",
      async () => {
        const root = await roots.create("cg-atomic-owned-fd-");
        const heldPath = path.join(root, "held.json");
        const entry = path.join(root, "state.json");
        const held = await fsp.open(heldPath, "w+");
        try {
          await fsp.symlink(`/dev/fd/${held.fd}`, entry);

          await write(entry, "next");

          expect((await fsp.lstat(entry)).isSymbolicLink()).toBe(false);
          await expect(fsp.readFile(entry, "utf8")).resolves.toBe("next");
          await expect(fsp.readFile(heldPath, "utf8")).resolves.toBe("");
        } finally {
          await held.close();
        }
      },
    );

    it.skipIf(process.platform === "win32")("replaces a FIFO at the path instead of opening it", async () => {
      const root = await roots.create("cg-atomic-owned-fifo-");
      const entry = path.join(root, "state.json");
      if (!(await tryCreateFifo(entry))) return;
      // With a reader open, a writer that did open the FIFO would fail the checks below instead of waiting for one.
      const reader = await openFifoForReading(entry);
      try {
        await write(entry, "next");

        expect((await fsp.lstat(entry)).isFile()).toBe(true);
        await expect(fsp.readFile(entry, "utf8")).resolves.toBe("next");
        expect(await fsp.readdir(root)).toEqual(["state.json"]);
      } finally {
        await reader.close();
      }
    });
  });
});

// POSIX permission bits do not exist on Windows: a mode there carries only the read-only attribute, and the writers
// copy nothing on that platform. These tests run in the Linux and macOS CI lanes.
describe.skipIf(process.platform === "win32")("permission bits of a replaced user destination", () => {
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

      await withUmask(umask, () => write(target, "next", userDestination));

      await expect(fsp.readFile(target, "utf8")).resolves.toBe("next");
      expect(await modeOf(target)).toBe(mode);
      expect(await temporaryNames(root)).toEqual([]);
    });

    it("gives a new file the default mode of the umask", async () => {
      const root = await roots.create("cg-atomic-mode-new-");
      const target = path.join(root, "state.json");

      // 0o666 without the bits that 0o027 removes.
      await withUmask(0o027, () => write(target, "next", userDestination));

      expect(await modeOf(target)).toBe(0o640);
    });

    it("keeps the permission bits of the file a symbolic link points to", async () => {
      const root = await roots.create("cg-atomic-mode-link-");
      const real = path.join(root, "real.json");
      const link = path.join(root, "link.json");
      await fsp.writeFile(real, "previous", "utf8");
      await fsp.chmod(real, 0o640);
      await fsp.symlink(real, link);

      await withUmask(0o022, () => write(link, "next", userDestination));

      expect(await modeOf(real)).toBe(0o640);
      await expect(fsp.readFile(link, "utf8")).resolves.toBe("next");
    });
  });

  it("never opens the new content to more users than the old content had, even before the rename", async () => {
    const root = await roots.create("cg-atomic-mode-window-");
    const target = path.join(root, "secret.json");
    await fsp.writeFile(target, "previous", "utf8");
    await fsp.chmod(target, 0o600);
    let modeWhileWriting = 0;

    await withUmask(0o022, () =>
      writeFileAtomicallyFrom(
        target,
        async (handle) => {
          modeWhileWriting = (await handle.stat()).mode & 0o777;
          await handle.writeFile("secret");
        },
        userDestination,
      ),
    );

    expect(modeWhileWriting).toBe(0o600);
  });
});

describe("a directory as a user destination", () => {
  describe.each(writers)("%s", (_name, write) => {
    it("fails for a directory and leaves it, and what is in it, alone", async () => {
      const root = await roots.create("cg-atomic-dir-");
      const target = path.join(root, "output");
      await fsp.mkdir(target);
      await fsp.writeFile(path.join(target, "keep.txt"), "kept", "utf8");

      await expect(write(target, "next", userDestination)).rejects.toMatchObject({ code: "EISDIR" });

      expect(await fsp.readdir(root)).toEqual(["output"]);
      expect(await fsp.readdir(target)).toEqual(["keep.txt"]);
    });
  });
});

describe("a symbolic link at a user destination", () => {
  describe.each(writers)("%s", (_name, write) => {
    it("replaces the file the link points to, beside that file, and keeps the link", async () => {
      const root = await roots.create("cg-atomic-link-");
      const realDir = path.join(root, "real");
      const linkDir = path.join(root, "links");
      await fsp.mkdir(realDir);
      await fsp.mkdir(linkDir);
      const real = path.join(realDir, "state.json");
      const link = path.join(linkDir, "state.json");
      await fsp.writeFile(real, "previous", "utf8");
      if (!(await tryCreateFileSymlink(real, link))) return;
      const renameSpy = vi.spyOn(fsp, "rename");

      await write(link, "next", userDestination);

      expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
      await expect(fsp.readFile(link, "utf8")).resolves.toBe("next");
      await expect(fsp.readFile(real, "utf8")).resolves.toBe("next");
      // One rename, of a temp file made where the replaced file lives, never in the directory of the link.
      const realDirectory = await fsp.realpath(realDir);
      expect(renameSpy).toHaveBeenCalledTimes(1);
      const [from, to] = renameSpy.mock.calls[0]!;
      expect(path.dirname(String(from))).toBe(realDirectory);
      expect(String(to)).toBe(path.join(realDirectory, "state.json"));
      expect(await fsp.readdir(linkDir)).toEqual(["state.json"]);
      expect(await fsp.readdir(realDir)).toEqual(["state.json"]);
    });

    it("follows a chain of links, relative ones included, and keeps every link", async () => {
      const root = await roots.create("cg-atomic-link-chain-");
      await fsp.mkdir(path.join(root, "real"));
      await fsp.mkdir(path.join(root, "links"));
      const real = path.join(root, "real", "state.json");
      const inner = path.join(root, "links", "inner.json");
      const outer = path.join(root, "links", "outer.json");
      await fsp.writeFile(real, "previous", "utf8");
      if (!(await tryCreateFileSymlink(path.join("..", "real", "state.json"), inner))) return;
      await tryCreateFileSymlink("inner.json", outer);

      await write(outer, "next", userDestination);

      expect((await fsp.lstat(outer)).isSymbolicLink()).toBe(true);
      expect((await fsp.lstat(inner)).isSymbolicLink()).toBe(true);
      await expect(fsp.readFile(real, "utf8")).resolves.toBe("next");
      expect(await fsp.readdir(path.join(root, "links"))).toEqual(["inner.json", "outer.json"]);
      expect(await fsp.readdir(path.join(root, "real"))).toEqual(["state.json"]);
    });

    it("creates the file a link points to when there is none yet, and keeps the link", async () => {
      const root = await roots.create("cg-atomic-link-dangling-");
      await fsp.mkdir(path.join(root, "shared"));
      const link = path.join(root, "state.json");
      if (!(await tryCreateFileSymlink(path.join("shared", "state.json"), link))) return;

      await write(link, "next", userDestination);

      expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
      await expect(fsp.readFile(path.join(root, "shared", "state.json"), "utf8")).resolves.toBe("next");
      expect(await fsp.readdir(path.join(root, "shared"))).toEqual(["state.json"]);
    });

    it("fails on a loop of links and leaves them as they were", async () => {
      const root = await roots.create("cg-atomic-link-loop-");
      const first = path.join(root, "a");
      const second = path.join(root, "b");
      if (!(await tryCreateFileSymlink("b", first))) return;
      await tryCreateFileSymlink("a", second);

      await expect(write(first, "next", userDestination)).rejects.toMatchObject({ code: "ELOOP" });

      expect((await fsp.lstat(first)).isSymbolicLink()).toBe(true);
      expect((await fsp.lstat(second)).isSymbolicLink()).toBe(true);
      expect(await fsp.readdir(root)).toEqual(["a", "b"]);
    });
  });
});

// A descriptor path names an open descriptor of a process, which can hold a regular file that a shell opened with `>` or
// `>>`. Windows has no such paths.
describe.skipIf(process.platform === "win32")("a descriptor path as a user destination", () => {
  const prefixes = process.platform === "linux" ? ["/dev/fd", "/proc/self/fd"] : ["/dev/fd"];

  describe.each(writers)("%s", (_name, write) => {
    it.each(prefixes)(
      "%s/<n> is written into the file behind the descriptor, which is not replaced",
      async (prefix) => {
        const root = await roots.create("cg-atomic-fd-");
        const file = path.join(root, "held.json");
        const held = await fsp.open(file, "w+");
        try {
          const before = await fsp.stat(file);

          await write(`${prefix}/${held.fd}`, "next content", userDestination);

          await expect(fsp.readFile(file, "utf8")).resolves.toBe("next content");
          expect((await fsp.stat(file)).ino).toBe(before.ino);
          expect(await fsp.readdir(root)).toEqual(["held.json"]);
        } finally {
          await held.close();
        }
      },
    );

    it("appends after what a descriptor opened for appending holds, as `>>` does", async () => {
      const root = await roots.create("cg-atomic-fd-append-");
      const file = path.join(root, "held.json");
      await fsp.writeFile(file, "head\n", "utf8");
      const held = await fsp.open(file, "a");
      try {
        await write(`/dev/fd/${held.fd}`, "next content", userDestination);

        await expect(fsp.readFile(file, "utf8")).resolves.toBe("head\nnext content");
      } finally {
        await held.close();
      }
    });

    it("follows a symbolic link to a descriptor path, writes into the file behind it, and keeps the link", async () => {
      const root = await roots.create("cg-atomic-fd-link-");
      const file = path.join(root, "held.json");
      const link = path.join(root, "out.json");
      const held = await fsp.open(file, "w+");
      try {
        await fsp.symlink(`/dev/fd/${held.fd}`, link);
        const before = await fsp.stat(file);

        await write(link, "next content", userDestination);

        expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
        await expect(fsp.readFile(file, "utf8")).resolves.toBe("next content");
        expect((await fsp.stat(file)).ino).toBe(before.ino);
        expect(await fsp.readdir(root)).toEqual(["held.json", "out.json"]);
      } finally {
        await held.close();
      }
    });
  });
});

// The shape of `codegraph graph --json --output /dev/stdout > graph.json`: a child process whose stdout is a regular file
// writes its document to /dev/stdout. With a rename, a user could not create the temp file in /dev, and root would
// replace the /dev/stdout link itself, so this runs for other users only, as the /dev/null test does.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "/dev/stdout of a process whose stdout is a file",
  () => {
    const writeJsonTo = path.resolve(process.cwd(), "tests", "helpers", "write-json-to.ts");

    async function runRedirected(flags: "w" | "a", head: string) {
      const root = await roots.create("cg-atomic-stdout-");
      // Over a million characters once pretty-printed, so the document goes out in more than one piece.
      const document = { files: Array.from({ length: 60_000 }, (_, index) => `src/file-${index}.ts`) };
      const documentPath = path.join(root, "document.json");
      const captured = path.join(root, "captured.json");
      await fsp.writeFile(documentPath, JSON.stringify(document), "utf8");
      await fsp.writeFile(captured, head, "utf8");
      const devStdoutBefore = await fsp.lstat("/dev/stdout");
      // `>` empties the file when the shell opens it, `>>` keeps what is there and appends.
      const redirect = await fsp.open(captured, flags);
      try {
        const result = await runTsxScriptWithStdoutFile(writeJsonTo, ["/dev/stdout", documentPath], redirect.fd);
        const devStdoutAfter = await fsp.lstat("/dev/stdout");
        return {
          result,
          text: await fsp.readFile(captured, "utf8"),
          expected: `${JSON.stringify(document, null, 2)}\n`,
          devStdoutUntouched:
            devStdoutBefore.ino === devStdoutAfter.ino &&
            devStdoutBefore.isSymbolicLink() === devStdoutAfter.isSymbolicLink() &&
            devStdoutBefore.mode === devStdoutAfter.mode,
          names: (await fsp.readdir(root)).sort(),
        };
      } finally {
        await redirect.close();
      }
    }

    it("receives the whole document when stdout is redirected with `>`, and /dev/stdout is left alone", async () => {
      const run = await runRedirected("w", "stale content from an earlier run\n");

      expect(run.result.exitCode, run.result.stderr).toBe(0);
      expect(run.text).toBe(run.expected);
      expect(run.devStdoutUntouched).toBe(true);
      expect(run.names).toEqual(["captured.json", "document.json"]);
    });

    it("appends the document when stdout is redirected with `>>`", async () => {
      const run = await runRedirected("a", "output of an earlier command\n");

      expect(run.result.exitCode, run.result.stderr).toBe(0);
      expect(run.text).toBe(`output of an earlier command\n${run.expected}`);
      expect(run.devStdoutUntouched).toBe(true);
    });
  },
);

// A FIFO and /dev/null are on Linux and macOS. Windows has the NUL device and named pipes, which are covered below.
describe.skipIf(process.platform === "win32")("a FIFO or a device as a user destination on a POSIX platform", () => {
  describe.each(writers)("%s", (_name, write) => {
    it("writes into a FIFO in place: it stays a FIFO, and no temporary file is made", async () => {
      const root = await roots.create("cg-atomic-fifo-");
      const fifo = path.join(root, "pipe");
      if (!(await tryCreateFifo(fifo))) return;
      const reader = await openFifoForReading(fifo);
      try {
        await write(fifo, "next content", userDestination);

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
        await write(link, "next content", userDestination);

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
      await write("/dev/null", "discarded", userDestination);

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
      await expect(writeFileAtomicallyFrom(fifo, fill, userDestination)).rejects.toMatchObject({ code: "EBUSY" });

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
describe.skipIf(process.platform !== "win32")("a device or a named pipe as a user destination on Windows", () => {
  const nul = "\\\\.\\NUL";

  it("writes to the NUL device", async () => {
    await expect(writeFileAtomically(nul, "discarded", userDestination)).resolves.toBeUndefined();
  });

  it("hands fill the NUL device itself", async () => {
    let isDevice = false;
    await writeFileAtomicallyFrom(
      nul,
      async (handle) => {
        isDevice = (await handle.stat()).isCharacterDevice();
        await handle.writeFile("discarded");
      },
      userDestination,
    );

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
        await write(pipePath, "next content", userDestination);
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
