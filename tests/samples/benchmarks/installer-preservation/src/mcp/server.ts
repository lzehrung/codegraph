export interface ExistingSessionRequest {
  method: string;
  requestId: string;
}

export function handleExistingMcpSessionRequest(request: ExistingSessionRequest): string {
  return `Handled existing MCP session request ${request.requestId} for ${request.method}`;
}

export function restoreExistingMcpSession(request: ExistingSessionRequest): ExistingSessionRequest {
  return { ...request };
}
