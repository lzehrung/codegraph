import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MCP_LIFECYCLE_HEALTH_TOKEN_ENV = "CODEGRAPH_MCP_LIFECYCLE_HEALTH_TOKEN";

export type McpLifecycleHealthIdentity = {
  pid: number;
  root: string;
  startedAt: string;
};

const TOKEN_BYTES = 32;
const CHALLENGE_BYTES = 16;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createMcpLifecycleHealthToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function readMcpLifecycleHealthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[MCP_LIFECYCLE_HEALTH_TOKEN_ENV];
  if (!value || !TOKEN_PATTERN.test(value)) return undefined;
  return value;
}

export function createMcpLifecycleHealthChallenge(): string {
  return randomBytes(CHALLENGE_BYTES).toString("base64url");
}

export function createMcpLifecycleHealthProof(
  token: string,
  challenge: string,
  identity: McpLifecycleHealthIdentity,
): string {
  return createHmac("sha256", token).update(serializeHealthIdentity(challenge, identity)).digest("base64url");
}

export function matchesMcpLifecycleHealthProof(
  proof: string | undefined,
  token: string,
  challenge: string,
  identity: McpLifecycleHealthIdentity,
): boolean {
  if (!proof) return false;
  const expected = createMcpLifecycleHealthProof(token, challenge, identity);
  const proofBytes = Buffer.from(proof);
  const expectedBytes = Buffer.from(expected);
  return proofBytes.length === expectedBytes.length && timingSafeEqual(proofBytes, expectedBytes);
}

function serializeHealthIdentity(challenge: string, identity: McpLifecycleHealthIdentity): string {
  return JSON.stringify({
    challenge,
    pid: identity.pid,
    root: identity.root,
    startedAt: identity.startedAt,
  });
}
