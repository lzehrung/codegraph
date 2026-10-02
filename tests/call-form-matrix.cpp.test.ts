import { describe } from "vitest";
import { isNativeTreeSitterAvailable } from "../src/native/tree-sitter-native.js";
import { registerMatrixSuite } from "./call-form-matrix/harness.js";
import { cppCells } from "./call-form-matrix/languages/cpp.js";

const suite = isNativeTreeSitterAvailable() ? describe : describe.skip;

suite("call-form matrix: C++", () => {
  registerMatrixSuite(cppCells);
});
