/**
 * The error a cancelled MCP tool call ends with: the deadline error or custom reason that aborted the call, or a
 * generic cancellation message for a plain `AbortError`.
 */
export function mcpCancellationError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name !== "AbortError") return reason;
  return new Error("MCP tool call was cancelled.");
}
