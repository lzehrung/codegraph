import type { ProgressUpdate } from "../types.js";

export type CliProgressPolicy = "auto" | "always" | "never";
export type CliProgressPresentation = "interactive" | "log" | "off";

export type CliProgressDisplay = {
  update: (update: ProgressUpdate) => void;
  clear: () => void;
  dispose: () => void;
};

type CreateCliProgressDisplayOptions = {
  presentation: Exclude<CliProgressPresentation, "off">;
  write: (chunk: string) => void;
};

const REFRESH_INTERVAL_MS = 100;
const CLEAR_LINE = "\r\u001b[2K";
const SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;

export function resolveCliProgressPresentation(input: {
  policy: CliProgressPolicy;
  stderrIsTTY: boolean;
  terminalSupportsControlSequences: boolean;
}): CliProgressPresentation {
  if (input.policy === "never") return "off";
  if (input.stderrIsTTY && input.terminalSupportsControlSequences) return "interactive";
  if (input.policy === "always") return "log";
  return "off";
}

export function createCliProgressDisplay(options: CreateCliProgressDisplayOptions): CliProgressDisplay {
  if (options.presentation === "log") return createLogProgressDisplay(options.write);
  return createInteractiveProgressDisplay(options.write);
}

function createInteractiveProgressDisplay(write: (chunk: string) => void): CliProgressDisplay {
  let active = false;
  let rendered = false;
  let frameIndex = 0;
  let current = 0;
  let total = 0;
  let mode: NonNullable<ProgressUpdate["mode"]> = "build";
  let interval: NodeJS.Timeout | undefined;

  const clear = (): void => {
    if (!rendered) return;
    write(CLEAR_LINE);
    rendered = false;
  };

  const render = (): void => {
    if (!active) return;
    const action = mode === "build" ? "Building" : "Updating";
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length]!;
    frameIndex += 1;
    const count = total > 0 ? ` ${current}/${total} files` : "";
    write(`${CLEAR_LINE}${action} project index... ${frame}${count}`);
    rendered = true;
  };

  const stopInterval = (): void => {
    if (interval === undefined) return;
    clearInterval(interval);
    interval = undefined;
  };

  const start = (update: ProgressUpdate): void => {
    stopInterval();
    clear();
    active = true;
    frameIndex = 0;
    current = update.current;
    total = update.total;
    mode = update.mode ?? "build";
    render();
    interval = setInterval(render, REFRESH_INTERVAL_MS);
    interval.unref();
  };

  const complete = (update: ProgressUpdate): void => {
    if (!active) return;
    active = false;
    stopInterval();
    clear();
    const verb = mode === "build" ? "Built" : "Updated";
    const fileCount = update.total;
    const files = fileCount === 1 ? "file" : "files";
    const elapsed = update.elapsedMs === undefined ? "" : ` in ${formatDuration(update.elapsedMs)}`;
    write(`${verb} project index: ${fileCount} ${files}${elapsed}.\n`);
  };

  return {
    update: (update) => {
      if (update.phase === "start") {
        start(update);
        return;
      }
      if (update.phase === "complete") {
        complete(update);
        return;
      }
      if (!active) start(update);
      current = update.current;
      total = update.total;
      mode = update.mode ?? mode;
    },
    clear,
    dispose: () => {
      active = false;
      stopInterval();
      clear();
    },
  };
}

function createLogProgressDisplay(write: (chunk: string) => void): CliProgressDisplay {
  let active = false;
  let mode: NonNullable<ProgressUpdate["mode"]> = "build";

  return {
    update: (update) => {
      if (update.phase === "start") {
        active = true;
        mode = update.mode ?? "build";
        const action = mode === "build" ? "Building" : "Updating";
        write(`[Progress] ${action} project index.\n`);
        return;
      }
      if (update.phase === "complete") {
        if (!active) return;
        active = false;
        const verb = mode === "build" ? "Built" : "Updated";
        const elapsed = update.elapsedMs === undefined ? "" : ` in ${formatDuration(update.elapsedMs)}`;
        write(`[Progress] ${verb} project index: ${update.total} files${elapsed}.\n`);
        return;
      }
      if (!active) active = true;
      const isComplete = update.current >= update.total;
      if (update.current === 1 || isComplete || update.current % 100 === 0) {
        write(`[Progress] ${update.current}/${update.total} files processed.\n`);
      }
    },
    clear: () => {},
    dispose: () => {
      active = false;
    },
  };
}

function formatDuration(elapsedMs: number): string {
  if (elapsedMs < 1_000) return `${Math.max(0, Math.round(elapsedMs))}ms`;
  return `${(elapsedMs / 1_000).toFixed(1)}s`;
}
