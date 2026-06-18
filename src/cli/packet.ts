import { formatAgentExplanation, type AgentExplanation } from "../agent/explain.js";
import { getCodegraphPacket } from "../agent/packet.js";
import type { CliAgentCommandContext } from "./context.js";
import { PACKET_HELP_TEXT } from "./help.js";
import { parsePositiveIntegerOption } from "./options.js";

export type PacketCommandContext = CliAgentCommandContext;

export async function handlePacketCommand(context: PacketCommandContext): Promise<void> {
  const subcommand = context.positionals[0];
  const target = context.positionals[1];
  if (subcommand !== "get" || target === undefined) {
    context.writeStderrLine(PACKET_HELP_TEXT.trimEnd());
    context.exit(2);
  }

  try {
    const response = await getCodegraphPacket({
      root: context.root,
      target,
      ...(context.buildOptions ? { buildOptions: context.buildOptions } : {}),
      ...(context.getOpt("--max-symbols") !== undefined
        ? { maxSymbols: parsePositiveIntegerOption(context.getOpt("--max-symbols"), "--max-symbols", 50) }
        : {}),
      ...(context.getOpt("--max-snippets") !== undefined
        ? { maxSnippets: parsePositiveIntegerOption(context.getOpt("--max-snippets"), "--max-snippets", 8) }
        : {}),
      ...(context.getOpt("--max-duplicates") !== undefined
        ? { maxDuplicates: parsePositiveIntegerOption(context.getOpt("--max-duplicates"), "--max-duplicates", 5) }
        : {}),
    });

    if (context.hasFlag("--json") || !context.hasFlag("--pretty")) {
      context.writeJSONLine(response);
    } else if (isAgentExplanation(response.packet)) {
      context.writeStdoutLine(formatAgentExplanation(response.packet));
    } else {
      context.writeJSONLine(response);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.writeStderrLine(message);
    context.exit(1);
  }
}

function isAgentExplanation(packet: object): packet is AgentExplanation {
  return "target" in packet && "summary" in packet && "followUps" in packet;
}
