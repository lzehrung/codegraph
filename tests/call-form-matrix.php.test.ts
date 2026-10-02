import { describe } from "vitest";
import { isNativeTreeSitterAvailable } from "../src/native/tree-sitter-native.js";
import { registerMatrixSuite } from "./call-form-matrix/harness.js";
import { phpCells } from "./call-form-matrix/languages/php.js";

const suite = isNativeTreeSitterAvailable() ? describe : describe.skip;

suite("call-form matrix: PHP", () => {
  registerMatrixSuite(phpCells);
});
