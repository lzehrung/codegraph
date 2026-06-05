import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isGitIndexSentinel, isGitWorktreeSentinel } from "../util/git.js";
import { normalizePath } from "../util/paths.js";
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

async function cleanupTempDir(dir: string | undefined): Promise<void> {
  if (!dir) return;
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures so they do not mask the primary drift error.
  }
}

async function resolveGitCommit(root: string, ref: string): Promise<string> {
  const rev = `${ref}^{commit}`;
  const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", rev], {
    cwd: root,
    env: process.env,
  });
  return stdout.toString().trim();
}

async function materializeGitRef(
  root: string,
  ref: string | undefined,
  prefix: string,
): Promise<{ root: string; cleanup?: string }> {
  const checkoutRef = ref;
  if (checkoutRef !== undefined && isGitIndexSentinel(checkoutRef)) {
    throw new Error("Architecture drift does not support STAGED/INDEX snapshots yet.");
  }
  if (checkoutRef === undefined || checkoutRef === "." || isGitWorktreeSentinel(checkoutRef)) return { root };
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await execFileAsync("git", ["clone", "--quiet", "--no-checkout", root, tempRoot], { env: process.env });
    const checkoutCommit = await resolveGitCommit(root, checkoutRef);
    await execFileAsync("git", ["checkout", "--quiet", checkoutCommit], { cwd: tempRoot, env: process.env });
    return { root: tempRoot, cleanup: tempRoot };
  } catch (error) {
    await cleanupTempDir(tempRoot);
    throw error;
  }
}

function withReportRefs(
  report: ArchitectureDriftReport,
  root: string,
  refs: { baseRef?: string; headRef?: string; baseRoot?: string; headRoot?: string },
): ArchitectureDriftReport {
  const normalizedRoot = normalizePath(path.resolve(root));
  return {
    ...report,
    root: normalizedRoot,
    base: {
      ...report.base,
      root: refs.baseRoot ?? normalizedRoot,
      ...(refs.baseRef !== undefined ? { ref: refs.baseRef } : {}),
    },
    head: {
      ...report.head,
      root: refs.headRoot ?? normalizedRoot,
      ...(refs.headRef !== undefined ? { ref: refs.headRef } : {}),
    },
  };
}

export async function analyzeArchitectureDrift(
  root: string,
  options: ArchitectureDriftOptions,
): Promise<ArchitectureDriftReport> {
  if (options.baseArtifact && options.base) {
    throw new Error("Architecture drift cannot combine --base with --base-artifact.");
  }

  if (options.baseArtifact) {
    if (options.head && !isCurrentCheckoutRef(options.head)) {
      throw new Error("Architecture drift with --base-artifact only supports the current checkout as --head.");
    }
    const baseSnapshot = await loadArchitectureSnapshotFromArtifact(options.baseArtifact);
    const headSnapshot = await buildArchitectureSnapshot(path.resolve(root), snapshotOptions(options));
    return withReportRefs(
      compareArchitectureSnapshots(baseSnapshot, headSnapshot, {
        ...(options.failOn ? { failOn: options.failOn } : {}),
        ...(options.graphEdges ? { graphEdges: options.graphEdges } : {}),
        ...(options.publicApi ? { publicApi: options.publicApi } : {}),
        ...(options.format ? { format: options.format } : {}),
        ...(options.thresholds ? { thresholds: options.thresholds } : {}),
      }),
      root,
      {
        baseRef: `artifact:${normalizePath(path.resolve(options.baseArtifact))}`,
        baseRoot: normalizePath(path.resolve(options.baseArtifact)),
        headRef: options.head ?? ".",
      },
    );
  }
  if (!options.base) {
    throw new Error("Architecture drift requires --base or --base-artifact.");
  }
  const resolvedRoot = path.resolve(root);
  let base: { root: string; cleanup?: string } | undefined;
  let head: { root: string; cleanup?: string } | undefined;
  try {
    base = await materializeGitRef(resolvedRoot, options.base, "cg-drift-base-");
    head = await materializeGitRef(resolvedRoot, options.head, "cg-drift-head-");
    const baseSnapshot = await buildArchitectureSnapshot(base.root, snapshotOptions(options));
    const headSnapshot = await buildArchitectureSnapshot(head.root, snapshotOptions(options));
    return withReportRefs(
      compareArchitectureSnapshots(baseSnapshot, headSnapshot, {
        ...(options.failOn ? { failOn: options.failOn } : {}),
        ...(options.graphEdges ? { graphEdges: options.graphEdges } : {}),
        ...(options.publicApi ? { publicApi: options.publicApi } : {}),
        ...(options.format ? { format: options.format } : {}),
        ...(options.thresholds ? { thresholds: options.thresholds } : {}),
      }),
      resolvedRoot,
      {
        baseRef: options.base,
        headRef: options.head ?? ".",
      },
    );
  } finally {
    await cleanupTempDir(head?.cleanup);
    await cleanupTempDir(base?.cleanup);
  }
}
