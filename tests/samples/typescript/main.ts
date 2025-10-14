import { helperFunction, UtilityClass, CONSTANT_VALUE, UtilityType } from './utils';
import * as utils from './utils';
import { helperFunction as helperAlias } from './utils';
import defaultExport from './utils';

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

// Type usage
const typedValue: UtilityType = {
  id: 1,
  name: "test"
};

// Constant usage
console.log(CONSTANT_VALUE);

export function main(): void {
  console.log(result);
  console.log(value);
  console.log(utilsResult);
  console.log(aliasResult);
  console.log(defaultResult);
  console.log(typedValue);
}
