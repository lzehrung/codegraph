import config from "./data.json" assert { type: "json" };
import { name as configName } from "./data.json";

export function getProjectName() {
  return config.project.name;
}

export const invalid = configName;
