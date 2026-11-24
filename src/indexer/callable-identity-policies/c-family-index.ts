import type { CallableIdentityPolicy } from "../callable-identity-policy-types.js";
import type { SymbolDef } from "../types.js";

/**
 * A C++ function first declared `static` keeps internal linkage when a later declaration in the
 * same file omits `static` (`static int run(); int run() {}`). One declaration node cannot see
 * that, so give every same-signature declaration in the file the static one's file-scoped key.
 */
function propagateCppInternalLinkage(file: string, locals: readonly SymbolDef[]): void {
  const prefix = file + "\0";
  const internal = new Set<string>();
  for (const local of locals) {
    const callable = local.callable;
    if (callable?.signature && callable.key.startsWith(prefix)) internal.add(callable.key.slice(prefix.length));
  }
  if (!internal.size) return;
  for (const local of locals) {
    const callable = local.callable;
    if (callable?.signature && internal.has(callable.key)) local.callable = { ...callable, key: prefix + callable.key };
  }
}

export const cCallableIdentityPolicy: CallableIdentityPolicy = {
  keyShape: "file-name",
};

export const cppCallableIdentityPolicy: CallableIdentityPolicy = {
  completeLocals: propagateCppInternalLinkage,
  keyShape: "qualified-signature",
};
