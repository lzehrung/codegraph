type SessionInvalidationHook = () => void;

const INVALIDATION_HOOKS = new WeakMap<object, Set<SessionInvalidationHook>>();

export function registerSessionInvalidationHook(session: object, hook: SessionInvalidationHook): void {
  const existing = INVALIDATION_HOOKS.get(session);
  if (existing) {
    existing.add(hook);
    return;
  }
  INVALIDATION_HOOKS.set(session, new Set([hook]));
}

export function runSessionInvalidationHooks(session: object): void {
  const hooks = INVALIDATION_HOOKS.get(session);
  if (!hooks) return;
  INVALIDATION_HOOKS.delete(session);
  for (const hook of hooks) hook();
}
