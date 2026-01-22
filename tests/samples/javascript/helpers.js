export function helperFunction() {
  return "Helper function from helpers module";
}

export function anotherHelper() {
  return 123;
}

const { uniq } = require("lodash");

export function uniqueValues(values) {
  return uniq(values);
}

export class HelperInterface {
  constructor(name, value) {
    this.name = name;
    this.value = value;
  }
}

// CommonJS style export
module.exports = {
  helperFunction,
  anotherHelper,
  HelperInterface
};
