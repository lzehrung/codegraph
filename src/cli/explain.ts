import { explainCodegraphTarget, formatAgentExplanation } from "../agent/explain.js";
import { EXPLAIN_HELP_TEXT } from "./help.js";
import { parsePositiveIntegerOption } from "./options.js";

export type ExplainCommandContext = {
  positionals: string[];
  root: string;
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

export async function handleExplainCommand(context: ExplainCommandContext): Promise<void> {
  const target = context.positionals.join(" ").trim();
  if (!target) {
    context.writeStderrLine(EXPLAIN_HELP_TEXT.trimEnd());
    context.exit(2);
  }

  const maxDependenciesRaw = context.getOpt("--max-dependencies");
  const maxSnippetsRaw = context.getOpt("--max-snippets");
  const maxSymbolsRaw = context.getOpt("--max-symbols");
  const base = context.getOpt("--base");
  const head = context.getOpt("--head");
  if (context.hasFlag("--changed-context") && (base === undefined || head === undefined)) {
    context.writeStderrLine("--changed-context requires --base and --head.");
    context.exit(2);
  }

  const response = await explainCodegraphTarget({
    root: context.root,
    target,
    includeChangedContext: context.hasFlag("--changed-context"),
    ...(base !== undefined ? { base } : {}),
    ...(head !== undefined ? { head } : {}),
    ...(maxDependenciesRaw !== undefined
      ? { maxDependencies: parsePositiveIntegerOption(maxDependenciesRaw, "--max-dependencies", 20) }
      : {}),
    ...(maxSnippetsRaw !== undefined
      ? { maxSnippets: parsePositiveIntegerOption(maxSnippetsRaw, "--max-snippets", 8) }
      : {}),
    ...(maxSymbolsRaw !== undefined
      ? { maxSymbols: parsePositiveIntegerOption(maxSymbolsRaw, "--max-symbols", 50) }
      : {}),
  });

  if (context.hasFlag("--json")) {
    context.writeJSONLine(response);
  } else {
    context.writeStdoutLine(formatAgentExplanation(response));
  }
}
