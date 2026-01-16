import { helperFunction } from "./helpers";
import { missingExport } from "./helpers";

const result = helperFunction();
const missingImportResult = anotherHelper();
const sharedUtilResult = sharedUtil();
const missingDeclarationResult = undeclaredFunction();

export function run(): string {
  return `${result}-${missingImportResult}-${sharedUtilResult}-${missingDeclarationResult}`;
}
