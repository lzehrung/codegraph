// File with intentionally broken syntax that should still be parseable
import { validImport } from "./valid";

export function brokenFunction( {
  // Missing closing paren
  return "broken";
}

export const validExport = "valid";

// More valid code after the error
export function workingFunction() {
  return "works";
}
