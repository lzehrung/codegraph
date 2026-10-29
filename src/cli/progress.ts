import { performance } from "node:perf_hooks";
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
/** The noun a count measures unless an update names another one. */
const DEFAULT_COUNT_UNIT = "file";

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
  let unit = DEFAULT_COUNT_UNIT;
  let activity = progressAction(mode);
  let interval: NodeJS.Timeout | undefined;
  let delay: NodeJS.Timeout | undefined;
  let phaseStartedAt = performance.now();
  const clear = (): void => {
    if (!rendered) return;
    write(CLEAR_LINE);
    rendered = false;
  };

  const render = (): void => {
    if (!active) return;
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length]!;
    frameIndex += 1;
    const count = hasProgressCount(mode, current, total) ? formatProgressCount(current, total, unit) : "";
    const elapsed = ` (${formatDuration(performance.now() - phaseStartedAt)})`;
    write(`${CLEAR_LINE}${activity}... ${frame}${count}${elapsed}`);
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
    unit = update.unit ?? DEFAULT_COUNT_UNIT;
    activity = update.activity ?? `${progressAction(mode)} project index`;
    phaseStartedAt = performance.now();
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
    const elapsed = update.elapsedMs === undefined ? "" : ` in ${formatDuration(update.elapsedMs)}`;
    if (update.activity !== undefined) {
      write(
        `${update.activity}: ${formatCount(update.total, update.unit ?? DEFAULT_COUNT_UNIT, "words")}${elapsed}.\n`,
      );
      return;
    }
    const verb = progressCompleteVerb(update.mode ?? mode);
    write(`${verb} project index: ${formatCount(update.total, DEFAULT_COUNT_UNIT, "words")}${elapsed}.\n`);
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
      if (update.activity !== undefined) unit = update.unit ?? DEFAULT_COUNT_UNIT;
      else if (update.unit !== undefined) unit = update.unit;
      if (update.activity !== undefined && update.activity !== activity) phaseStartedAt = performance.now();
      if (update.activity !== undefined) activity = update.activity;
    },
    clear,
    dispose: () => {
      active = false;
      stopInterval();
      clear();
    },
  };
}

function formatCount(count: number, unit: string, zeroFormat: "numeric" | "words" = "numeric"): string {
  if (!count && zeroFormat === "words") return `no ${unit}s`;
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function formatProgressCount(current: number, total: number, unit: string): string {
  if (total > 0) return ` ${current}/${formatCount(total, unit)}`;
  return ` ${formatCount(current, unit)} processed`;
}

function hasProgressCount(mode: NonNullable<ProgressUpdate["mode"]>, current: number, total: number): boolean {
  return mode !== "check" || current > 0 || total > 0;
}

function createLogProgressDisplay(write: (chunk: string) => void, delayMs: number = 0): CliProgressDisplay {
  let active = false;
  let rendered = false;
  let current = 0;
  let total = 0;
  let mode: NonNullable<ProgressUpdate["mode"]> = "build";
  let unit = DEFAULT_COUNT_UNIT;
  let activity = progressAction(mode);
  let delay: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let phaseStartedAt = performance.now();

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
    write(`[Progress] ${activity}.\n`);
    heartbeat = setInterval(() => {
      if (!active) return;
      const count = hasProgressCount(mode, current, total) ? `:${formatProgressCount(current, total, unit)}` : "";
      const elapsed = formatDuration(performance.now() - phaseStartedAt);
      write(`[Progress] ${activity}${count}. (${elapsed})\n`);
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
    unit = update.unit ?? DEFAULT_COUNT_UNIT;
    activity = update.activity ?? `${progressAction(mode)} project index`;
    phaseStartedAt = performance.now();
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
        const elapsed = update.elapsedMs === undefined ? "" : ` in ${formatDuration(update.elapsedMs)}`;
        if (update.activity !== undefined) {
          write(
            `[Progress] ${update.activity}: ${formatCount(update.total, update.unit ?? DEFAULT_COUNT_UNIT, "words")}${elapsed}.\n`,
          );
          return;
        }
        const verb = progressCompleteVerb(update.mode ?? mode);
        write(
          `[Progress] ${verb} project index: ${formatCount(update.total, DEFAULT_COUNT_UNIT, "words")}${elapsed}.\n`,
        );
        return;
      }
      if (!active) {
        if (update.phase === "update") return;
        start(update);
      }
      const previousActivity = activity;
      current = update.current;
      total = update.total;
      mode = update.mode ?? mode;
      if (update.activity !== undefined) unit = update.unit ?? DEFAULT_COUNT_UNIT;
      else if (update.unit !== undefined) unit = update.unit;
      if (update.activity !== undefined) activity = update.activity;
      const activityChanged = activity !== previousActivity;
      if (activityChanged) phaseStartedAt = performance.now();
      const isComplete = update.total > 0 && update.current >= update.total;
      const shouldPrintCount =
        rendered && (update.current === 1 || isComplete || (update.current > 0 && update.current % 100 === 0));
      if (rendered && activityChanged && !shouldPrintCount) {
        write(`[Progress] ${activity}.\n`);
      }
      if (shouldPrintCount) {
        const elapsed = formatDuration(performance.now() - phaseStartedAt);
        if (update.activity !== undefined) {
          write(`[Progress] ${activity}:${formatProgressCount(update.current, update.total, unit)}. (${elapsed})\n`);
        } else {
          write(`[Progress] ${formatCount(update.current, unit)} processed. (${elapsed})\n`);
        }
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
  const durationMs = Math.max(0, elapsedMs);
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}
