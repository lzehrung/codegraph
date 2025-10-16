import defA, { aHelper, AClass, A_CONST } from '@acme/pkg-a';
import * as a from '@acme/pkg-a';

export function bUseA() {
  return aHelper() + A_CONST;
}

export function bMakeA() {
  return new AClass(2);
}

// Namespace import usages
const nsVal = a.aHelper();
const nsObj = new a.AClass(5);

// CommonJS require destructuring (for parsing/graph tests)
const { aHelper: requireAlias } = require('@acme/pkg-a');
const reqVal = requireAlias();

// Default import usage
const defVal = defA();

// Re-exports from pkg-a
export { aHelper as bHelper } from '@acme/pkg-a';
export { AClass as ExportedAClass } from '@acme/pkg-a';
export * from '@acme/pkg-a';

// Subpath import consumer (will be exercised when exports provide subpath)
// import { aHelper as subHelper } from '@acme/pkg-a/sub';


