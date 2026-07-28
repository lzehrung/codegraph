import type { PreparedQueryIndexFile } from "./content.js";
import { prepareQueryIndexFile } from "./content.js";
import { resolveQueryIndexSourcePath } from "./paths.js";

export type QueryIndexWorkerTask = {
  projectRoot: string;
  relativePath: string;
  sourceIdentity: string;
};

export default async function prepareQueryIndexWorkerTask(
  task: QueryIndexWorkerTask,
): Promise<PreparedQueryIndexFile | null> {
  const absolutePath = resolveQueryIndexSourcePath(task.projectRoot, task.relativePath);
  return await prepareQueryIndexFile({
    absolutePath,
    path: task.relativePath,
    sourceIdentity: task.sourceIdentity,
  });
}
