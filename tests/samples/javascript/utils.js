export function helperFunction() {
  return "Hello from utils";
}

export class UtilityClass {
  constructor(value = 42) {
    this.value = value;
  }

  getValue() {
    return this.value;
  }

  setValue(value) {
    this.value = value;
  }
}

export const CONSTANT_VALUE = "constant";

// Re-export from another module
export { helperFunction as reExportedHelper } from './helpers.js';

// Default export
export default function defaultExport() {
  return "default export";
}

// CommonJS style export (for mixed environments)
module.exports = {
  helperFunction,
  UtilityClass,
  CONSTANT_VALUE
};
