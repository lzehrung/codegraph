import { camelCase } from "lodash";

export function formatLabel(label: string): string {
  return camelCase(label);
}
