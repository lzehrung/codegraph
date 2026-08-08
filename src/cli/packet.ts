import { formatAgentExplanation, type AgentExplanation } from "../agent/explain.js";
import { getCodegraphPacket } from "../agent/packet.js";
import { formatAgentFollowUpsAsCli } from "../agent/followUps.js";
import type { CliAgentCommandContext } from "./context.js";
import { errorMessage } from "../util/errors.js";
import { PACKET_HELP_TEXT } from "./help.js";
import { parsePositiveIntegerOption } from "./options.js";
import { formatPrettyValue } from "./pretty.js";

export type PacketCommandContext = CliAgentCommandContext;

export async function handlePacketCommand(context: PacketCommandContext): Promise<void> {
  const [first, second] = context.positionals;
  const subcommand = second === undefined && first !== "get" ? "get" : first;
  const target = subcommand === "get" && first !== "get" ? first : second;
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

    if (context.hasFlag("--json")) {
      context.writeJSONLine(response);
    } else if (isAgentExplanation(response.packet)) {
      context.writeStdoutLine(formatAgentExplanation(response.packet));
    } else {
      context.writeStdoutLine(
        formatPrettyValue({
          ...response,
          followUps: formatAgentFollowUpsAsCli(response.followUps),
        }),
      );
    }
  } catch (error: unknown) {
    const message = errorMessage(error);
    context.writeStderrLine(message);
    context.exit(1);
  }
}

function isAgentExplanation(packet: object): packet is AgentExplanation {
  return "target" in packet && "summary" in packet && "followUps" in packet;
}
