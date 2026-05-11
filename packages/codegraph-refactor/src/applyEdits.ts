import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ApplyEditsOptions, ApplyEditsResult, TextEdit } from "./types.js";

const execFileAsync = promisify(execFile);

type FilePlan = {
  file: string;
  text: string;
  existed: boolean;
};

function detectEol(source: string): "\r\n" | "\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function hasOverlap(edits: TextEdit[]): boolean {
  const ascending = [...edits].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ascending.length; index += 1) {
    const previous = ascending[index - 1]!;
    const current = ascending[index]!;
    if (current.start < previous.end) {
      return true;
    }
  }
  return false;
}

function applyFileEdits(source: string, edits: TextEdit[]): string {
  const eol = detectEol(source);
  let next = source;
  const descending = [...edits].sort((left, right) => right.start - left.start);
  for (const edit of descending) {
    const normalizedNewText = edit.newText.replace(/\r\n?/g, "\n");
    const replacement = eol === "\n" ? normalizedNewText : normalizedNewText.replace(/\n/g, eol);
    next = `${next.slice(0, edit.start)}${replacement}${next.slice(edit.end)}`;
  }
  return next;
}

async function readUtf8File(file: string): Promise<{ status: "ok"; source: string } | { status: "missing" } | { status: "binary" }> {
  try {
    const buffer = await readFile(file);
    try {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      if (source.includes("\u0000")) {
        return { status: "binary" };
      }
      return { status: "ok", source };
    } catch {
      return { status: "binary" };
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }
}

async function writeAtomically(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeFile(tempFile, text, "utf8");
  await rename(tempFile, file);
}

function gitPath(file: string, gitCwd: string | undefined): string {
  if (!gitCwd) return file;
  const relative = path.relative(gitCwd, file);
  const insideGitCwd = relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (insideGitCwd) {
    return relative;
  }
  return file;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim();
}

async function trackWithGit(file: string, existed: boolean, opts: ApplyEditsOptions | undefined): Promise<string | undefined> {
  if (!opts?.useGit || existed) return undefined;
  try {
    await execFileAsync("git", ["add", "--", gitPath(file, opts.gitCwd)], { cwd: opts.gitCwd });
    return undefined;
  } catch (error) {
    return `git add failed for ${file}: ${errorMessage(error)}`;
  }
}

export async function applyEdits(edits: TextEdit[], opts?: ApplyEditsOptions): Promise<ApplyEditsResult> {
  const byFile = new Map<string, TextEdit[]>();
  for (const edit of edits) {
    const bucket = byFile.get(edit.file);
    if (bucket) bucket.push(edit);
    else byFile.set(edit.file, [edit]);
  }

  const result: ApplyEditsResult = {
    writes: [],
    conflicts: [],
    skipped: [],
    previews: {},
    warnings: [],
  };
  const plans: FilePlan[] = [];

  for (const [file, fileEdits] of byFile) {
    if (hasOverlap(fileEdits)) {
      result.conflicts.push(file);
      continue;
    }

    const readResult = await readUtf8File(file);
    if (readResult.status === "binary") {
      result.skipped.push(file);
      continue;
    }

    const source = readResult.status === "missing" ? "" : readResult.source;
    const text = applyFileEdits(source, fileEdits);
    result.previews[file] = text;
    plans.push({ file, text, existed: readResult.status === "ok" });
  }

  if (opts?.dryRun) {
    return result;
  }

  for (const plan of plans) {
    await writeAtomically(plan.file, plan.text);
    const warning = await trackWithGit(plan.file, plan.existed, opts);
    if (warning) result.warnings.push(warning);
    result.writes.push(plan.file);
  }

  return result;
}
