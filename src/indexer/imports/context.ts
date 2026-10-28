import type { ImportBinding } from "../types.js";
import type { CFamilyIncludeForm, ModuleSpecifierResolutionKind, RubyLoadForm } from "../../util/specifiers.js";

export type ResolvedImportTarget = Exclude<ImportBinding["resolved"], undefined>;

/**
 * Per-occurrence resolution facts the capture path can prove but the extracted specifier text
 * cannot. A C/C++ `#include` keeps its literal/angle/macro form here so resolution never infers
 * it from the file's other spellings.
 */
export type ImportResolverOptions = {
  includeForm?: CFamilyIncludeForm;
  rubyLoadForm?: RubyLoadForm;
  resolutionKind?: ModuleSpecifierResolutionKind;
  jvmPackageWildcard?: true;
  /** Rust `#[path = "..."]` on this module item. Resolved only inside the project root. */
  pathAttribute?: string;
  statementStartIndex?: number;
};

export type ImportResolver = (
  from: string,
  phpImportType?: "class" | "function" | "const",
  opts?: ImportResolverOptions,
) => Promise<ResolvedImportTarget>;

export type ImportBindingSink = {
  pushBinding: (binding: ImportBinding) => void;
};

/**
 * Marks the module whose imports are being extracted as incomplete. `cause: "lookup"` says the imports are incomplete
 * because a lookup over other project files could not read one of them, not because this source failed to extract, so
 * the same source can resolve differently in a later build without changing.
 */
export type ImportDegradedHook = (cause?: "lookup") => void;
