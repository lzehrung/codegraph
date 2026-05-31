import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isGitIndexSentinel, isGitWorktreeSentinel } from "../util/git.js";
import { compareArchitectureSnapshots } from "./compare.js";
import { buildArchitectureSnapshot } from "./snapshot.js";
import { loadArchitectureSnapshotFromArtifact } from "./artifact.js";
import type { ArchitectureDriftOptions, ArchitectureDriftReport, ArchitectureSnapshotOptions } from "./types.js";

const execFileAsync = promisify(execFile);

function snapshotOptions(options: ArchitectureDriftOptions): ArchitectureSnapshotOptions {
  return {
    ...(options.includeRoots ? { includeRoots: options.includeRoots } : {}),
    ...(options.discovery ? { discovery: options.discovery } : {}),
    ...(options.graph ? { graph: options.graph } : {}),
    ...(options.index ? { index: options.index } : {}),
    ...(options.native !== undefined ? { native: options.native } : {}),
    ...(options.duplicateLimit !== undefined ? { duplicateLimit: options.duplicateLimit } : {}),
  };
}

function isCurrentCheckoutRef(ref: string | undefined): boolean {
  return ref === undefined || ref === "." || (typeof ref === "string" && isGitWorktreeSentinel(ref));
}

async function materializeGitRef(root: string, ref: string | undefined, prefix: string): Promise<{ root: string; cleanup?: string }> {
  const checkoutRef = ref;
  if (checkoutRef !== undefined && isGitIndexSentinel(checkoutRef)) {
    throw new Error("Architecture drift does not support STAGED/INDEX snapshots yet.");
  }
  if (checkoutRef === undefined || checkoutRef === "." || isGitWorktreeSentinel(checkoutRef)) return { root };
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await execFileAsync("git", ["clone", "--quiet", "--no-checkout", root, tempRoot], { env: process.env });
    await execFileAsync("git", ["checkout", "--quiet", checkoutRef], { cwd: tempRoot, env: process.env });
    return { root: tempRoot, cleanup: tempRoot };
  } catch (error) {
    await fsp.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function analyzeArchitectureDrift(
  root: string,
  options: ArchitectureDriftOptions,
): Promise<ArchitectureDriftReport> {
  if (options.provider && options.provider !== "git") {
    throw new Error(`Unsupported architecture drift provider: ${options.provider}`);
  }
  if (options.baseArtifact) {
    const baseSnapshot = await loadArchitectureSnapshotFromArtifact(options.baseArtifact);
    const headSnapshot = await buildArchitectureSnapshot(path.resolve(root), snapshotOptions(options));
    return compareArchitectureSnapshots(baseSnapshot, headSnapshot, {
      ...(options.failOn ? { failOn: options.failOn } : {}),
      ...(options.thresholds ? { thresholds: options.thresholds } : {}),
    });
  }
  if (!options.base) {
    throw new Error("Architecture drift requires --base or --base-artifact.");
  }
  const resolvedRoot = path.resolve(root);
  const base = await materializeGitRef(resolvedRoot, options.base, "cg-drift-base-");
  const head = await materializeGitRef(resolvedRoot, options.head, "cg-drift-head-");
  try {
    const baseSnapshot = await buildArchitectureSnapshot(base.root, snapshotOptions(options));
    const headSnapshot = await buildArchitectureSnapshot(head.root, snapshotOptions(options));
    return compareArchitectureSnapshots(baseSnapshot, headSnapshot, {
      ...(options.failOn ? { failOn: options.failOn } : {}),
      ...(options.thresholds ? { thresholds: options.thresholds } : {}),
    });
  } finally {
    if (base.cleanup) await fsp.rm(base.cleanup, { recursive: true, force: true });
    if (head.cleanup) await fsp.rm(head.cleanup, { recursive: true, force: true });
  }
}
