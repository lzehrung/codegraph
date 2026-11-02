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

/** Thrown when code reads the target of an import whose resolution a module record still defers. */
export class PendingImportResolutionError extends Error {
  constructor(request: number) {
    super(`Import resolution request ${request} is pending: a module record resolves it on the main thread.`);
    this.name = "PendingImportResolutionError";
  }
}

/**
 * Stands in for the target of an import while a module record defers its resolution to the main thread (see
 * `module-record.ts`). One instance stands for one distinct resolution request and is shared by every binding of that
 * request. It is neither a file nor an external name: reading it as either throws `PendingImportResolutionError`, so
 * code that runs before resolution cannot mistake a pending import for an unresolved one. The target also remembers
 * the read, because code that catches errors broadly would otherwise hide it.
 */
export class PendingImportTarget {
  readonly request: number;
  #read = false;

  constructor(request: number) {
    this.request = request;
  }

  /** Whether code has tried to read this target, even code that caught the error. */
  get read(): boolean {
    return this.#read;
  }

  /** Records a read of this target and throws `PendingImportResolutionError`. */
  refuseRead(): never {
    this.#read = true;
    throw new PendingImportResolutionError(this.request);
  }

  get external(): never {
    return this.refuseRead();
  }

  toString(): never {
    return this.refuseRead();
  }

  toJSON(): never {
    return this.refuseRead();
  }

  [Symbol.toPrimitive](): never {
    return this.refuseRead();
  }
}

/**
 * The file an import binding resolved to, or `undefined` when it resolved to an external name or was not resolved.
 * Rules that depend on a resolved target read it here, so a binding whose resolution is still pending throws
 * `PendingImportResolutionError` instead of reading as unresolved.
 */
export function resolvedImportFile(binding: ImportBinding): string | undefined {
  const target = binding.resolved;
  if (target instanceof PendingImportTarget) target.refuseRead();
  return typeof target === "string" ? target : undefined;
}
