import type { IndexLanguagePolicy } from "../language-hook-types.js";
import { cDeclarations, cFamilyModule } from "./c-family-index.js";
import { cppDeclarations } from "./cpp-export-index.js";
import { cppModule, cppPublicSurface } from "./cpp-index.js";
import { csharpDeclarations, csharpProjectFacts, csharpPublicSurface } from "./csharp-index.js";
import { javaDeclarations, kotlinDeclarations } from "./jvm-declaration-index.js";
import { javaProjectFacts, kotlinProjectFacts } from "./jvm-index.js";
import { kotlinPublicSurface } from "./kotlin-index.js";
import { phpDeclarations, phpPublicSurface } from "./php-index.js";
import { phpModule } from "./php-preparation-index.js";
import { pythonDeclarations, pythonPublicSurface } from "./python-index.js";
import { rubyDeclarations } from "./ruby-export-index.js";
import { rustPublicSurface } from "./rust-index.js";
import { sqlModule } from "./sql-index.js";
import { swiftDeclarations } from "./swift-index.js";
import { typescriptDeclarations, typescriptModule } from "./typescript-index.js";

const NO_POLICY: IndexLanguagePolicy = {};
const POLICIES: Readonly<Record<string, IndexLanguagePolicy>> = {
  c: { module: cFamilyModule, declarations: cDeclarations },
  cpp: { module: cppModule, declarations: cppDeclarations, publicSurface: cppPublicSurface },
  csharp: {
    module: { projectFacts: csharpProjectFacts },
    declarations: csharpDeclarations,
    publicSurface: csharpPublicSurface,
  },
  java: { module: { projectFacts: javaProjectFacts }, declarations: javaDeclarations },
  kotlin: {
    module: { projectFacts: kotlinProjectFacts },
    declarations: kotlinDeclarations,
    publicSurface: kotlinPublicSurface,
  },
  php: { module: phpModule, declarations: phpDeclarations, publicSurface: phpPublicSurface },
  python: { declarations: pythonDeclarations, publicSurface: pythonPublicSurface },
  ruby: { declarations: rubyDeclarations },
  rust: { publicSurface: rustPublicSurface },
  sql: { module: sqlModule },
  swift: { declarations: swiftDeclarations },
  ts: { module: typescriptModule, declarations: typescriptDeclarations },
  tsx: { module: typescriptModule, declarations: typescriptDeclarations },
};

export function indexLanguagePolicyFor(languageId: string): IndexLanguagePolicy {
  return POLICIES[languageId] ?? NO_POLICY;
}
