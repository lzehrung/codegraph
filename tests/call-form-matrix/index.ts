/**
 * Aggregates every language's call-form cells (docs/plans/2026-09-28-unified-name-resolution.md,
 * Step 1) for the coverage report. `tests/call-form-matrix.<language>.test.ts` files import a
 * single language's cells directly from `./languages/<language>.js`; this module is for the
 * report generator, which needs the whole set.
 */
import { cCells } from "./languages/c.js";
import { cppCells } from "./languages/cpp.js";
import { csharpCells } from "./languages/csharp.js";
import { goCells } from "./languages/go.js";
import { javaCells } from "./languages/java.js";
import { jsCells } from "./languages/js.js";
import { kotlinCells } from "./languages/kotlin.js";
import { phpCells } from "./languages/php.js";
import { pythonCells } from "./languages/python.js";
import { rubyCells } from "./languages/ruby.js";
import { rustCells } from "./languages/rust.js";
import { swiftCells } from "./languages/swift.js";
import { tsCells } from "./languages/ts.js";
import { tsxCells } from "./languages/tsx.js";
import { zigCells } from "./languages/zig.js";
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
