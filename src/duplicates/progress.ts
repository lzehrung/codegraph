import { performance } from "node:perf_hooks";
import type { ProgressUpdate } from "../types.js";

/** Longest synchronous stretch before a stage hands the event loop back, so a progress display can repaint. */
const YIELD_INTERVAL_MS = 50;

export const DUPLICATE_STAGE_UNITS = "Collecting duplicate units";
export const DUPLICATE_STAGE_PAIRS = "Finding candidate pairs";
export const DUPLICATE_STAGE_SCORING = "Scoring candidate pairs";
export const DUPLICATE_STAGE_GROUPING = "Grouping duplicate findings";
export const DUPLICATE_STAGE_DONE = "Detected duplicates";

export type DuplicateProgress = {
  /** Names the active stage. The first call opens the run; later calls update it. */
  stage: (activity: string, current?: number, total?: number, unit?: string) => void;
  /** Closes the run with the elapsed time since the progress origin. */
  complete: (units: number) => void;
  /** A promise to await when the stage has run long enough that the event loop should turn, else undefined. */
  yieldPoint: () => Promise<void> | undefined;
};

/** Creates a reporter for one duplicate-detection run, or undefined when nobody listens. */
export function createDuplicateProgress(
  onProgress: ((update: ProgressUpdate) => void) | undefined,
  startedAt: number | undefined,
): DuplicateProgress | undefined {
  if (!onProgress) return undefined;
  const origin = startedAt ?? performance.now();
  let opened = false;
  let lastYield = performance.now();
  return {
    stage: (activity, current = 0, total = 0, unit) => {
      onProgress({
        type: "progress",
        phase: opened ? "update" : "start",
        mode: "check",
        message: activity,
        activity,
        current,
        total,
        ...(unit !== undefined ? { unit } : {}),
      });
      opened = true;
    },
    complete: (units) => {
      if (!opened) return;
      onProgress({
        type: "progress",
        phase: "complete",
        mode: "check",
        message: DUPLICATE_STAGE_DONE,
        activity: DUPLICATE_STAGE_DONE,
        current: units,
        total: units,
        unit: "unit",
        elapsedMs: performance.now() - origin,
      });
    },
    yieldPoint: () => {
      if (performance.now() - lastYield < YIELD_INTERVAL_MS) return undefined;
      return new Promise<void>((resolve) => {
        setImmediate(() => {
          lastYield = performance.now();
          resolve();
        });
      });
    },
  };
}
