import { describe } from "vitest";
import { isNativeTreeSitterAvailable } from "../src/native/tree-sitter-native.js";
import { registerMatrixSuite } from "./call-form-matrix/harness.js";
import { swiftCells } from "./call-form-matrix/languages/swift.js";

const suite = isNativeTreeSitterAvailable() ? describe : describe.skip;

suite("call-form matrix: Swift", () => {
  registerMatrixSuite(swiftCells);
});
