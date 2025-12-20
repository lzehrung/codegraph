import {
  makeLanguageConfig,
  type LanguageConfig,
} from "../chunking/languageConfig.js";
import { JAVASCRIPT_DEF } from "../languages/definitions/javascript.js";
import { PYTHON_DEF } from "../languages/definitions/python.js";
import {
  TYPESCRIPT_DEF,
  TSX_DEF,
} from "../languages/definitions/typescript.js";
import { HTML_DEF } from "../languages/definitions/html.js";
import { CSS_DEF } from "../languages/definitions/css.js";
import { SCSS_DEF } from "../languages/definitions/scss.js";
import { LESS_DEF } from "../languages/definitions/less.js";
import { RUBY_DEF } from "../languages/definitions/ruby.js";
import { GO_DEF } from "../languages/definitions/go.js";
import { JAVA_DEF } from "../languages/definitions/java.js";
import { CSHARP_DEF } from "../languages/definitions/csharp.js";
import { RUST_DEF } from "../languages/definitions/rust.js";

export type { LanguageConfig };

export const LANG_CONFIGS: Record<string, LanguageConfig> = {
  javascript: makeLanguageConfig(JAVASCRIPT_DEF),
  typescript: makeLanguageConfig(TYPESCRIPT_DEF),
  tsx: makeLanguageConfig(TSX_DEF),
  python: makeLanguageConfig(PYTHON_DEF),
  html: makeLanguageConfig(HTML_DEF),
  css: makeLanguageConfig(CSS_DEF),
  scss: makeLanguageConfig(SCSS_DEF),
  less: makeLanguageConfig(LESS_DEF),
  ruby: makeLanguageConfig(RUBY_DEF),
  go: makeLanguageConfig(GO_DEF),
  java: makeLanguageConfig(JAVA_DEF),
  csharp: makeLanguageConfig(CSHARP_DEF),
  rust: makeLanguageConfig(RUST_DEF),
};
