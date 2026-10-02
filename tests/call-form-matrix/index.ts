/**
 * Aggregates every language's call-form cells and omissions (docs/plans/2026-09-28-unified-name-
 * resolution.md, Step 1) for the coverage report. `tests/call-form-matrix.<language>.test.ts`
 * files import a single language's cells directly from `./languages/<language>.js`; this module
 * is for the report generator, which needs the whole set.
 */
import { cCells, cOmissions } from "./languages/c.js";
import { cppCells, cppOmissions } from "./languages/cpp.js";
import { csharpCells, csharpOmissions } from "./languages/csharp.js";
import { goCells, goOmissions } from "./languages/go.js";
import { javaCells, javaOmissions } from "./languages/java.js";
import { jsCells, jsOmissions } from "./languages/js.js";
import { kotlinCells, kotlinOmissions } from "./languages/kotlin.js";
import { phpCells, phpOmissions } from "./languages/php.js";
import { pythonCells, pythonOmissions } from "./languages/python.js";
import { rubyCells, rubyOmissions } from "./languages/ruby.js";
import { rustCells, rustOmissions } from "./languages/rust.js";
import { swiftCells, swiftOmissions } from "./languages/swift.js";
import { tsCells, tsOmissions } from "./languages/ts.js";
import { tsxCells, tsxOmissions } from "./languages/tsx.js";
import { zigCells, zigOmissions } from "./languages/zig.js";
import type { OmissionsByLanguage } from "./omissions.js";
import type { MatrixCell } from "./types.js";

export const ALL_CELLS: readonly MatrixCell[] = [
  ...tsCells,
  ...tsxCells,
  ...jsCells,
  ...pythonCells,
  ...phpCells,
  ...goCells,
  ...javaCells,
  ...cCells,
  ...cppCells,
  ...csharpCells,
  ...kotlinCells,
  ...rubyCells,
  ...rustCells,
  ...swiftCells,
  ...zigCells,
];

export const OMISSIONS_BY_LANGUAGE: OmissionsByLanguage = {
  ts: tsOmissions,
  tsx: tsxOmissions,
  js: jsOmissions,
  python: pythonOmissions,
  php: phpOmissions,
  go: goOmissions,
  java: javaOmissions,
  c: cOmissions,
  cpp: cppOmissions,
  csharp: csharpOmissions,
  kotlin: kotlinOmissions,
  ruby: rubyOmissions,
  rust: rustOmissions,
  swift: swiftOmissions,
  zig: zigOmissions,
};
