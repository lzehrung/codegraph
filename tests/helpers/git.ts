import { spawnSync } from "node:child_process";

export function runGit(root: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Codegraph Test",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "codegraph@example.test",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Codegraph Test",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "codegraph@example.test",
    },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}
