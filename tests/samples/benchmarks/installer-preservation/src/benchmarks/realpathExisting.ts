import path from "node:path";

export function realpathExistingInstallerBenchmark(entry: string): string {
  return path.resolve(entry);
}

export function preserveExistingBenchmarkDirectory(entry: string): string {
  return realpathExistingInstallerBenchmark(entry);
}

export function realpathExistingMcpBenchmark(entry: string): string {
  return path.resolve(entry, "mcp", "install");
}
