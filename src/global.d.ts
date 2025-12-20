declare module "fast-glob" {
  export default function glob(
    patterns: string[],
    options?: GlobOptions,
  ): Promise<string[]>;
}

declare module "tree-sitter-html";
declare module "tree-sitter-css";
declare module "tree-sitter-scss";
declare module "tree-sitter-vue";
declare module "tree-sitter-svelte";
declare module "tree-sitter-ruby";
declare module "tree-sitter-go";
declare module "tree-sitter-java";
declare module "tree-sitter-c-sharp";
declare module "tree-sitter-rust";
