/**
 * Default source byte cap before native parse/projection.
 * 8 MiB is above virtually all hand-written sources while preventing a single
 * generated/minified file from OOM-ing a long-lived extraction worker.
 */
export const DEFAULT_NATIVE_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
