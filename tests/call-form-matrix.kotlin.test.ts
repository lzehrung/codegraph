import { describe } from "vitest";
import { isNativeTreeSitterAvailable } from "../src/native/tree-sitter-native.js";
import { registerMatrixSuite } from "./call-form-matrix/harness.js";
import { kotlinCells } from "./call-form-matrix/languages/kotlin.js";

const suite = isNativeTreeSitterAvailable() ? describe : describe.skip;

suite("call-form matrix: Kotlin", () => {
  registerMatrixSuite(kotlinCells);
});
