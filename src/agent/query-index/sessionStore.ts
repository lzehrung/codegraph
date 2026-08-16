import type { AgentProjectSnapshot, AgentSession } from "../session.js";
import { registerSessionInvalidationHook } from "../sessionLifecycle.js";
import { ensureQueryIndex, type QueryIndexHandle } from "./update.js";

type SessionQueryIndexState = {
  identity: string;
  handle: Promise<QueryIndexHandle>;
  resolved?: QueryIndexHandle;
  closing?: boolean;
};

const QUERY_INDEX_BY_SESSION = new WeakMap<AgentSession, SessionQueryIndexState>();
const QUERY_INDEX_INVALIDATION_HOOKS = new WeakSet<AgentSession>();
const MAX_QUERY_INDEX_GENERATION_RETRIES = 3;

function closeHandle(handle: QueryIndexHandle): void {
  handle.store?.close();
}

function closeState(state: SessionQueryIndexState): void {
  state.closing = true;
  if (state.resolved) {
    closeHandle(state.resolved);
    return;
  }
  void state.handle.then(closeHandle, () => undefined);
}

function disposeSessionQueryIndexOnInvalidation(session: AgentSession): () => void {
  return () => {
    QUERY_INDEX_INVALIDATION_HOOKS.delete(session);
    disposeSessionQueryIndex(session);
  };
}

export async function ensureSessionQueryIndex(
  session: AgentSession,
  snapshot: AgentProjectSnapshot,
): Promise<QueryIndexHandle> {
  const identity = snapshot.index.projectSnapshotIdentity ?? "";
  for (let attempt = 0; attempt < MAX_QUERY_INDEX_GENERATION_RETRIES; attempt += 1) {
    const existing = QUERY_INDEX_BY_SESSION.get(session);
    if (existing?.identity === identity && !existing.closing) {
      const resolved = await existing.handle;
      if (!existing.closing) return resolved;
    }
    if (existing) {
      QUERY_INDEX_BY_SESSION.delete(session);
      closeState(existing);
    }

    const handle = ensureQueryIndex(snapshot);
    const state: SessionQueryIndexState = { identity, handle };
    if (!QUERY_INDEX_INVALIDATION_HOOKS.has(session)) {
      QUERY_INDEX_INVALIDATION_HOOKS.add(session);
      registerSessionInvalidationHook(session, disposeSessionQueryIndexOnInvalidation(session));
    }
    QUERY_INDEX_BY_SESSION.set(session, state);
    handle.catch(() => {
      if (QUERY_INDEX_BY_SESSION.get(session) === state) QUERY_INDEX_BY_SESSION.delete(session);
    });
    const resolved = await handle;
    if (QUERY_INDEX_BY_SESSION.get(session) === state && !state.closing) {
      state.resolved = resolved;
      if (snapshot.buildReport) snapshot.buildReport.queryIndex = resolved.diagnostics;
      if (snapshot.index.buildReport) snapshot.index.buildReport.queryIndex = resolved.diagnostics;
      return resolved;
    }
    closeHandle(resolved);
  }
  throw new Error(
    "Query index generation changed repeatedly while loading; retry the request after refresh completes.",
  );
}

export function disposeSessionQueryIndex(session: AgentSession): void {
  const existing = QUERY_INDEX_BY_SESSION.get(session);
  if (!existing) return;
  QUERY_INDEX_BY_SESSION.delete(session);
  closeState(existing);
}
