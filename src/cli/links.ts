import { checkMarkdownLinks } from "../documentLinks/check.js";
import type { MarkdownLinkCheckResult } from "../documentLinks/check.js";

export type LinksCommandContext = {
  projectRootFs: string;
  hasFlag: (name: string) => boolean;
  writeJSONLine: (value: MarkdownLinkCheckResult) => void;
  writeStdoutLine: (message: string) => void;
  exit: (code: number) => never;
};

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareFailures(
  left: MarkdownLinkCheckResult["failures"][number],
  right: MarkdownLinkCheckResult["failures"][number],
): number {
  const fileComparison = compareText(left.file, right.file);
  if (fileComparison) return fileComparison;

  const lineComparison = left.range.start.line - right.range.start.line;
  if (lineComparison) return lineComparison;

  const columnComparison = left.range.start.column - right.range.start.column;
  if (columnComparison) return columnComparison;

  const reasonComparison = compareText(left.reason, right.reason);
  if (reasonComparison) return reasonComparison;

  return compareText(left.raw, right.raw);
}

export function formatMarkdownLinkCheckResult(result: MarkdownLinkCheckResult, verbose: boolean): string {
  const { summary } = result;
  const lines: string[] = [];

  if (!summary.failures) {
    lines.push("No broken Markdown links found.");
  } else {
    lines.push(`${summary.failures} broken Markdown links found:`);
    for (const failure of [...result.failures].sort(compareFailures)) {
      const { line, column } = failure.range.start;
      lines.push(`${failure.file}:${line}:${column} ${failure.reason}: ${failure.raw}`);
    }
  }

  if (verbose) {
    lines.push(
      `Scanned ${summary.filesScanned} Markdown files; checked ${summary.linksChecked} links; skipped ${summary.externalSkipped} external links.`,
    );
  }

  return lines.join("\n");
}

export async function handleLinksCommand(context: LinksCommandContext): Promise<void> {
  const result = await checkMarkdownLinks(context.projectRootFs);

  if (context.hasFlag("--json")) {
    context.writeJSONLine(result);
  } else {
    context.writeStdoutLine(formatMarkdownLinkCheckResult(result, context.hasFlag("--verbose")));
  }

  if (result.summary.failures) context.exit(1);
}
