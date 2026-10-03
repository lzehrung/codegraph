import { describe } from "vitest";
import { isNativeTreeSitterAvailable } from "../src/native/tree-sitter-native.js";
import { registerMatrixSuite } from "./call-form-matrix/harness.js";
import { goCells } from "./call-form-matrix/languages/go.js";

const suite = isNativeTreeSitterAvailable() ? describe : describe.skip;

suite("call-form matrix: Go", () => {
  registerMatrixSuite(goCells);
});
