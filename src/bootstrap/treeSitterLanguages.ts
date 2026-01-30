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
import { C_DEF } from "../languages/definitions/c.js";
import { CPP_DEF } from "../languages/definitions/cpp.js";
import { KOTLIN_DEF } from "../languages/definitions/kotlin.js";
import { SWIFT_DEF } from "../languages/definitions/swift.js";

export type { LanguageConfig };

const CONFIG_DEFS = {
  javascript: JAVASCRIPT_DEF,
  typescript: TYPESCRIPT_DEF,
  tsx: TSX_DEF,
  python: PYTHON_DEF,
  html: HTML_DEF,
  css: CSS_DEF,
  scss: SCSS_DEF,
  less: LESS_DEF,
  ruby: RUBY_DEF,
  go: GO_DEF,
  java: JAVA_DEF,
  csharp: CSHARP_DEF,
  rust: RUST_DEF,
  c: C_DEF,
  cpp: CPP_DEF,
  kotlin: KOTLIN_DEF,
  swift: SWIFT_DEF,
} as const;

type LanguageConfigId = keyof typeof CONFIG_DEFS;

const configCache = new Map<LanguageConfigId, Promise<LanguageConfig>>();

async function getLanguageConfigByKey(
  key: LanguageConfigId,
): Promise<LanguageConfig> {
  let cached = configCache.get(key);
  if (!cached) {
    cached = makeLanguageConfig(CONFIG_DEFS[key]);
    configCache.set(key, cached);
  }
  return cached;
}

export async function getLanguageConfig(
  id: string,
): Promise<LanguageConfig | undefined> {
  const key = id as LanguageConfigId;
  if (!(key in CONFIG_DEFS)) return undefined;
  return getLanguageConfigByKey(key);
}

export async function getLanguageConfigs(): Promise<
  Record<string, LanguageConfig>
> {
  const entries = await Promise.all(
    (Object.keys(CONFIG_DEFS) as LanguageConfigId[]).map(async (key) => {
      const config = await getLanguageConfigByKey(key);
      return [key, config] as const;
    }),
  );
  return Object.fromEntries(entries);
}
