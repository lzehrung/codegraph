declare module "fast-glob" {
  export default function glob(
    patterns: string[],
    options?: GlobOptions,
  ): Promise<string[]>;
}

declare module "tree-sitter-html" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-css" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-scss" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-vue" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-svelte" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-ruby" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-go" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-java" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-c-sharp" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-rust" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-c" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-cpp" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-javascript" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-python" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-kotlin" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-swift" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-typescript" {
  import type { Language } from "tree-sitter";
  const languages: {
    typescript: Language;
    tsx: Language;
  };
  export default languages;
}
declare module "picomatch";
