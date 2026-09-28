import { Store, type SessionStore } from "./store";

export function optional(store: Store | undefined): number | undefined {
  return store?.metadata();
}

export function reassigned(path: string): number {
  let store: Store | undefined;
  try {
    store = new Store(path);
    store.close();
    store = undefined;
  } catch {
    store?.close();
    return 0;
  }
  return 1;
}

export function typed(sessions: SessionStore): void {
  sessions.delete("a");
}
