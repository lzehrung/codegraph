import { helperFunction, UtilityClass, CONSTANT_VALUE } from "./utils.js";
import * as utils from "./utils.js";
import { helperFunction as helperAlias } from "./utils.js";
import defaultExport from "./utils.js";

// Namespace import usage
const utilsResult = utils.helperFunction();
const utilsClass = new utils.UtilityClass(100);

// Direct import usage
const result = helperFunction();
const util = new UtilityClass(50);
const value = util.getValue();

// Alias usage
const aliasResult = helperAlias();

// Default import usage
const defaultResult = defaultExport();

// Constant usage
console.log(CONSTANT_VALUE);

// CommonJS require (mixed module system)
const { helperFunction: requireHelper } = require("./helpers.js");

export function main() {
  console.log(result);
  console.log(value);
  console.log(utilsResult);
  console.log(aliasResult);
  console.log(defaultResult);
  console.log(requireHelper());
}

// Dynamic import
async function loadModule() {
  const module = await import("./helpers.js");
  return module.anotherHelper();
}
