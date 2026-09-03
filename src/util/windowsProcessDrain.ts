/**
 * Node 23+ on Windows can abort during process teardown with
 * `UV_HANDLE_CLOSING` in libuv `src/win/async.c` when `uv_async_send`
 * runs after `uv_close` (https://github.com/nodejs/node/issues/56645).
 * Codegraph hits that after a successful CLI `explore` that opened
 * `node:sqlite`, the native addon, or a worker thread: stdout is already
 * written, then the process exits `3221226505`.
 *
 * Keeping the event loop alive briefly after that work lets libuv finish
 * closing handles before Node destroys the loop. Off Windows this is a no-op.
 */

export const WINDOWS_LIBUV_EXIT_DRAIN_MS = 100;

let drainRequired = false;

export function markWindowsProcessDrainRequired(): void {
  drainRequired = true;
}

export function windowsProcessDrainIsRequired(): boolean {
  return drainRequired;
}

export function resetWindowsProcessDrainForTests(): void {
  drainRequired = false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function drainWindowsProcessHandles(options?: {
  platform?: NodeJS.Platform;
  required?: boolean;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  const platform = options?.platform ?? process.platform;
  const required = options?.required ?? drainRequired;
  if (platform !== "win32" || !required) return;
  await (options?.wait ?? delay)(WINDOWS_LIBUV_EXIT_DRAIN_MS);
}
