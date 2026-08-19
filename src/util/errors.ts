/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return String(error);
  if (typeof error === "object") {
    try {
      const serialized = JSON.stringify(error);
      if (serialized) return serialized;
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/** Check whether an unknown value carries a specific filesystem error code. */
export function isFileSystemErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && String(error.code) === code;
}
