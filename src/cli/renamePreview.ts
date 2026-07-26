import {
  previewRename,
  type RenameConflict,
  type RenameEdit,
  type RenamePreviewResponse,
  type RenameUnsafeSite,
} from "../agent/renamePreview.js";
import type { SemanticSymbol } from "../agent/semantic.js";
import type { CliAgentCommandContext } from "./context.js";
import { RENAME_PREVIEW_HELP_TEXT } from "./help.js";
import { parseOptionalBoundedIntegerOption } from "./options.js";

export type RenamePreviewCommandContext = CliAgentCommandContext;

const MAX_RENAME_EDITS = 10_000;

export async function handleRenamePreviewCommand(context: RenamePreviewCommandContext): Promise<void> {
  const handle = context.positionals[0]?.trim();
  const newName = context.positionals[1]?.trim();
  if (!handle || !newName) {
    context.writeStderrLine(RENAME_PREVIEW_HELP_TEXT.trimEnd());
    context.exit(2);
  }

  try {
    const maxEdits = parseOptionalBoundedIntegerOption(
      context.getOpt("--max-edits"),
      "--max-edits",
      1,
      MAX_RENAME_EDITS,
    );
    const response = await previewRename({
      root: context.root,
      handle,
      newName,
      includeComments: context.hasFlag("--include-comments"),
      includeStrings: context.hasFlag("--include-strings"),
      includeFilenames: context.hasFlag("--include-filenames"),
      ...(maxEdits !== undefined ? { maxEdits } : {}),
      ...(context.buildOptions ? { buildOptions: context.buildOptions } : {}),
    });
    if (context.hasFlag("--json")) {
      context.writeJSONLine(response);
      return;
    }
    context.writeStdoutLine(formatRenamePreviewResponse(response));
  } catch (error: unknown) {
    context.writeStderrLine(error instanceof Error ? error.message : String(error));
    context.exit(1);
  }
}

function formatRenamePreviewResponse(response: RenamePreviewResponse): string {
  const lines = [
    `Target: ${formatSymbol(response.target)}`,
    `New name: ${response.newName}`,
    `Safe: ${response.safe ? "yes" : "no"}`,
    `Edits: ${response.edits.length}`,
  ];
  for (const edit of response.edits) lines.push(`  ${formatEdit(edit)}`);
  appendConflicts(lines, response.conflicts);
  appendUnsafeSites(lines, response.unsafeSites);
  if (response.filenameSuggestions.length) {
    lines.push(`Filename suggestions: ${response.filenameSuggestions.length} (suggestions only; no apply command)`);
    for (const suggestion of response.filenameSuggestions) {
      const risk = suggestion.caseOnlyRisk ? " [case-only risk]" : "";
      lines.push(`  ${suggestion.from} -> ${suggestion.to}${risk}`);
    }
  }
  if (response.candidateTests.length) {
    lines.push(`Candidate tests: ${response.candidateTests.length}`);
    for (const test of response.candidateTests) lines.push(`  ${test.file} [${test.confidence}] ${test.reason}`);
  }
  if (response.omittedCounts.edits) lines.push(`Omitted edits: ${response.omittedCounts.edits}`);
  return lines.join("\n");
}

function formatSymbol(symbol: SemanticSymbol): string {
  const { file, range } = symbol.location;
  return `${symbol.name} [${symbol.kind}] ${file}:${range.start.line}:${range.start.column}`;
}

function formatEdit(edit: RenameEdit): string {
  const { range } = edit;
  return `${edit.kind} ${edit.file}:${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column} ${edit.oldText} -> ${edit.newText}`;
}

function appendConflicts(lines: string[], conflicts: RenameConflict[]): void {
  if (!conflicts.length) return;
  lines.push(`Conflicts: ${conflicts.length}`);
  for (const conflict of conflicts) lines.push(`  ${conflict.reason} ${conflict.file}: ${conflict.message}`);
}

function appendUnsafeSites(lines: string[], unsafeSites: RenameUnsafeSite[]): void {
  if (!unsafeSites.length) return;
  lines.push(`Unsafe sites: ${unsafeSites.length}`);
  for (const site of unsafeSites) {
    const { file, range } = site.location;
    lines.push(`  ${site.reason} ${file}:${range.start.line}:${range.start.column} ${site.text}`);
  }
}
