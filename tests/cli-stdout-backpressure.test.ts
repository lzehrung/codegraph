import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runWithCliRuntime, waitForStreamDrain, writeStdoutLineAndWait } from "../src/cli/context.js";

/** A stream with a four-byte buffer whose writes finish only when `finishWrite` is called, like a stalled pipe. */
function backedUpStream(): { stream: Writable; received: string[]; finishWrite: () => void } {
  const received: string[] = [];
  const finishers: Array<() => void> = [];
  const stream = new Writable({
    highWaterMark: 4,
    decodeStrings: false,
    write(chunk, _encoding, done) {
      received.push(String(chunk));
      finishers.push(() => done());
    },
  });
  return { stream, received, finishWrite: () => finishers.shift()?.() };
}

async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
}

describe("waitForStreamDrain", () => {
  it("resolves at once for a stream with room in its buffer", async () => {
    const { stream } = backedUpStream();

    await expect(waitForStreamDrain(stream)).resolves.toBeUndefined();
  });

  it("stays pending while the stream signals backpressure, and resolves when it drains", async () => {
    const { stream, finishWrite } = backedUpStream();
    expect(stream.write("0123456789")).toBe(false);
    let drained = false;
    const waiting = waitForStreamDrain(stream).then(() => {
      drained = true;
    });

    await flushMicrotasks();
    expect(drained).toBe(false);
    finishWrite();
    await waiting;

    expect(drained).toBe(true);
  });

  it("rejects when the stream fails while it is backed up", async () => {
    const { stream } = backedUpStream();
    stream.write("0123456789");
    const waiting = waitForStreamDrain(stream);

    stream.destroy(new Error("EPIPE: consumer went away"));

    await expect(waiting).rejects.toThrow("EPIPE");
  });

  it("resolves when the stream closes without draining, so a closed pipe cannot hold it forever", async () => {
    const { stream } = backedUpStream();
    stream.write("0123456789");
    const waiting = waitForStreamDrain(stream);

    stream.destroy();

    await expect(waiting).resolves.toBeUndefined();
  });
});

describe("writeStdoutLineAndWait", () => {
  it("writes the line and resolves only once the stream behind stdout can take more", async () => {
    const { stream, received, finishWrite } = backedUpStream();

    await runWithCliRuntime(
      { stdout: (chunk) => stream.write(chunk), stdoutDrained: () => waitForStreamDrain(stream) },
      async () => {
        let settled = false;
        const first = writeStdoutLineAndWait("first line").then(() => {
          settled = true;
        });

        await flushMicrotasks();
        expect(received).toEqual(["first line\n"]);
        expect(settled).toBe(false);

        finishWrite();
        await first;
        expect(settled).toBe(true);

        const second = writeStdoutLineAndWait("second line");
        await flushMicrotasks();
        expect(received).toEqual(["first line\n", "second line\n"]);
        finishWrite();
        await second;
      },
    );
  });
});
