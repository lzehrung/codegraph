import { createHash } from "node:crypto";

function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJsonValue(value[key])]),
    );
  }
  return value;
}

export function canonicalizeSelectedScenarios(schemaVersion, scenarios) {
  return JSON.stringify(canonicalizeJsonValue({ schemaVersion, scenarios }));
}

export function calculateScenarioDigest(schemaVersion, scenarios) {
  const canonical = canonicalizeSelectedScenarios(schemaVersion, scenarios);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
