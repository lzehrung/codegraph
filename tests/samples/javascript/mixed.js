// Mixed module system - both ES6 and CommonJS
import { helperFunction } from './helpers.js';
const { legacyFunction } = require('./legacy.js');

export function mixedFunction() {
  return helperFunction() + " + " + legacyFunction();
}

// Re-export both ES6 and CommonJS
export { helperFunction } from './helpers.js';
export { legacyFunction } from './legacy.js';

// Default export
export default function mixedDefault() {
  return "Mixed module default export";
}
