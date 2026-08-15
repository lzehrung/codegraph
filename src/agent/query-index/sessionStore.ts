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

export async function ensureSessionQueryIndex(
  session: AgentSession,
  snapshot: AgentProjectSnapshot,
): Promise<QueryIndexHandle> {
  const identity = snapshot.index.projectSnapshotIdentity ?? "";
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
  if (!existing) registerSessionInvalidationHook(session, () => disposeSessionQueryIndex(session));
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
  return await ensureSessionQueryIndex(session, snapshot);
}

export function disposeSessionQueryIndex(session: AgentSession): void {
  const existing = QUERY_INDEX_BY_SESSION.get(session);
  if (!existing) return;
  QUERY_INDEX_BY_SESSION.delete(session);
  closeState(existing);
}
