import { isPlainRecord } from "../util/guards.js";
import { fileIdentityKey } from "../util/paths.js";

/** Visit only protocol envelopes, never arbitrary result objects or source content. */
export function mapMcpResponseEnvelopes(
  toolName: string,
  value: Record<string, unknown>,
  transform: (envelope: Record<string, unknown>, hasRootMetadata: boolean) => Record<string, unknown>,
): Record<string, unknown> {
  let mapped = transform(value, true);
  let nestedKey: "packet" | "rename" | undefined;
  if (toolName === "packet_get") nestedKey = "packet";
  else if (toolName === "refactor_plan") nestedKey = "rename";
  if (nestedKey) {
    const nested = value[nestedKey];
    if (isPlainRecord(nested)) {
      const hasRootMetadata = toolName !== "packet_get" || value.kind !== "review";
      const mappedNested = transform(nested, hasRootMetadata);
      if (mappedNested !== nested) mapped = { ...mapped, [nestedKey]: mappedNested };
    }
  }
  // AgentExploreResponse embeds full AgentPacketResponse values, not packet summaries.
  if (toolName === "explore" && Array.isArray(value.packets)) {
    const originalPackets: unknown[] = value.packets;
    const packets = originalPackets.map((packet) =>
      isPlainRecord(packet) ? mapMcpResponseEnvelopes("packet_get", packet, transform) : packet,
    );
    if (packets.some((packet, index) => packet !== originalPackets[index])) mapped = { ...mapped, packets };
  }
  if (toolName === "explore" && isPlainRecord(value.fileView)) {
    const fileView = transform(value.fileView, false);
    if (fileView !== value.fileView) mapped = { ...mapped, fileView };
  }
  return mapped;
}

export function rebaseMcpResponseRoots(
  toolName: string,
  value: Record<string, unknown>,
  physicalRoot: string,
  logicalRoot: string,
): Record<string, unknown> {
  if (physicalRoot === logicalRoot) return value;
  const physicalRootKey = fileIdentityKey(physicalRoot);
  const rebaseRoot = (envelope: Record<string, unknown>, hasRootMetadata: boolean): Record<string, unknown> => {
    if (!hasRootMetadata || typeof envelope.root !== "string" || fileIdentityKey(envelope.root) !== physicalRootKey) {
      return envelope;
    }
    return { ...envelope, root: logicalRoot };
  };
  return mapMcpResponseEnvelopes(toolName, value, rebaseRoot);
}
