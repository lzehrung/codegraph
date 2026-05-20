import type { ImportBinding } from "../types.js";

export type ResolvedImportTarget = Exclude<ImportBinding["resolved"], undefined>;

export type ImportResolver = (
  from: string,
  phpImportType?: "class" | "function" | "const",
) => Promise<ResolvedImportTarget>;

export type ImportBindingSink = {
  pushBinding: (binding: ImportBinding) => void;
};
