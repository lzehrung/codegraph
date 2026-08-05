const CLI_BOOTSTRAP_STATE = Symbol.for("@lzehrung/codegraph/cli-bootstrap");

export function markCliBootstrapActive(): void {
  Reflect.set(globalThis, CLI_BOOTSTRAP_STATE, true);
}

export function isCliBootstrapActive(): boolean {
  return Boolean(Reflect.get(globalThis, CLI_BOOTSTRAP_STATE));
}
