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
  delayMs?: number;
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
  if (input.stderrIsTTY) {
    return input.terminalSupportsControlSequences ? "interactive" : "log";
  }
  return "log";
}

export function createCliProgressDisplay(options: CreateCliProgressDisplayOptions): CliProgressDisplay {
  if (options.presentation === "log") return createLogProgressDisplay(options.write, options.delayMs);
  return createInteractiveProgressDisplay(options.write, options.delayMs);
}

function createInteractiveProgressDisplay(write: (chunk: string) => void, delayMs: number = 0): CliProgressDisplay {
  let active = false;
  let rendered = false;
  let frameIndex = 0;
  let current = 0;
  let total = 0;
  let mode: NonNullable<ProgressUpdate["mode"]> = "build";
  let interval: NodeJS.Timeout | undefined;
  let delay: NodeJS.Timeout | undefined;
  const clear = (): void => {
    if (!rendered) return;
    write(CLEAR_LINE);
    rendered = false;
  };

  const render = (): void => {
    if (!active) return;
    const action = progressAction(mode);
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length]!;
    frameIndex += 1;
    const count = total > 0 ? ` ${current}/${total} files` : "";
    write(`${CLEAR_LINE}${action} project index... ${frame}${count}`);
    rendered = true;
  };
  const stopInterval = (): void => {
    if (interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
    if (delay !== undefined) {
      clearTimeout(delay);
      delay = undefined;
    }
  };
  const start = (update: ProgressUpdate): void => {
    stopInterval();
    clear();
    active = true;
    rendered = false;
    frameIndex = 0;
    current = update.current;
    total = update.total;
    mode = update.mode ?? "build";
    const beginRendering = (): void => {
      if (!active) return;
      render();
      interval = setInterval(render, REFRESH_INTERVAL_MS);
      interval.unref();
    };
    if (delayMs) {
      delay = setTimeout(beginRendering, delayMs);
      delay.unref();
    } else {
      beginRendering();
    }
  };
  const complete = (update: ProgressUpdate): void => {
    if (!active) return;
    active = false;
    stopInterval();
    if (!rendered) return;
    clear();
    const verb = progressCompleteVerb(mode);
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
      if (!active) {
        if (update.phase === "update") return;
        start(update);
      }
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

function createLogProgressDisplay(write: (chunk: string) => void, delayMs: number = 0): CliProgressDisplay {
  let active = false;
  let rendered = false;
  let current = 0;
  let total = 0;
  let mode: NonNullable<ProgressUpdate["mode"]> = "build";
  let delay: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;

  const stopTimers = (): void => {
    if (delay !== undefined) {
      clearTimeout(delay);
      delay = undefined;
    }
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };
  const renderStart = (): void => {
    if (!active || rendered) return;
    rendered = true;
    write(`[Progress] ${progressAction(mode)} project index.\n`);
    heartbeat = setInterval(() => {
      if (!active) return;
      write(`[Progress] ${progressAction(mode)} project index: ${current}/${total} files.\n`);
    }, 1_000);
    heartbeat.unref();
  };
  const start = (update: ProgressUpdate): void => {
    stopTimers();
    active = true;
    rendered = false;
    current = update.current;
    total = update.total;
    mode = update.mode ?? "build";
    if (delayMs) {
      delay = setTimeout(renderStart, delayMs);
      delay.unref();
    } else {
      renderStart();
    }
  };

  return {
    update: (update) => {
      if (update.phase === "start") {
        start(update);
        return;
      }
      if (update.phase === "complete") {
        if (!active) return;
        active = false;
        stopTimers();
        if (!rendered) return;
        const verb = progressCompleteVerb(mode);
        const elapsed = update.elapsedMs === undefined ? "" : ` in ${formatDuration(update.elapsedMs)}`;
        write(`[Progress] ${verb} project index: ${update.total} files${elapsed}.\n`);
        return;
      }
      if (!active) {
        if (update.phase === "update") return;
        start(update);
      }
      current = update.current;
      total = update.total;
      mode = update.mode ?? mode;
      const isComplete = update.current >= update.total;
      if (rendered && (update.current === 1 || isComplete || update.current % 100 === 0)) {
        write(`[Progress] ${update.current}/${update.total} files processed.\n`);
      }
    },
    clear: () => {},
    dispose: () => {
      active = false;
      stopTimers();
    },
  };
}

function progressAction(mode: NonNullable<ProgressUpdate["mode"]>): string {
  if (mode === "build") return "Building";
  if (mode === "update") return "Updating";
  return "Checking";
}

function progressCompleteVerb(mode: NonNullable<ProgressUpdate["mode"]>): string {
  if (mode === "build") return "Built";
  if (mode === "update") return "Updated";
  return "Checked";
}

function formatDuration(elapsedMs: number): string {
  if (elapsedMs < 1_000) return `${Math.max(0, Math.round(elapsedMs))}ms`;
  return `${(elapsedMs / 1_000).toFixed(1)}s`;
}
