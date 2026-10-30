import { errorMessage } from "../util/errors.js";

/**
 * What a client sees when a running server meets a missing part of its own package. An in-place upgrade replaces the
 * files on disk while the old process still holds the old module graph, so a module that was not loaded yet is gone.
 */
export const STALE_INSTALL_MESSAGE =
  "The codegraph package changed on disk after this MCP server started, so a part of it that had not been loaded yet " +
  "is gone. Restart the MCP server (or reload the MCP client) to run the installed version.";

// Node's own wording, for an error that crossed a worker thread or was rebuilt from its message and lost its code.
const MODULE_NOT_FOUND_MESSAGE = /^Cannot find (?:module|package)\b/;
const MAX_CAUSE_DEPTH = 5;

/**
 * True when `error`, or an error it wraps, reports that Node could not load a module or package. The MCP server loads
 * only its own package and its dependencies, so a module that is missing there means the installation changed.
 */
export function isStaleInstallError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if ("code" in current && (current.code === "ERR_MODULE_NOT_FOUND" || current.code === "MODULE_NOT_FOUND"))
      return true;
    if (MODULE_NOT_FOUND_MESSAGE.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

/** The text to show for a failure of the running server: the restart advice for a stale install, else the message. */
export function describeMcpRuntimeError(error: unknown): string {
  return isStaleInstallError(error) ? STALE_INSTALL_MESSAGE : errorMessage(error);
}
