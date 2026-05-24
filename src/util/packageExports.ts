export function pickPackageExportTarget(target: unknown): string | null {
  if (!target) return null;
  if (typeof target === "string") return target;
  if (typeof target !== "object") return null;
  const exportTarget = target as Record<string, unknown>;
  const candidate = exportTarget.import ?? exportTarget.default ?? exportTarget.require ?? exportTarget.module;
  if (typeof candidate === "string") return candidate;
  return null;
}
