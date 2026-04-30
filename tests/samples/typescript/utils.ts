export function helperFunction(): string {
  return "Hello from utils";
}

export class UtilityClass {
  private value: number;

  constructor(value: number = 42) {
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  setValue(value: number): void {
    this.value = value;
  }
}

export const CONSTANT_VALUE = "constant";

export type UtilityType = {
  id: number;
  name: string;
};

// Re-export from another module
export { helperFunction as reExportedHelper } from "./helpers";

// Default export
export default function defaultExport(): string {
  return "default export";
}
