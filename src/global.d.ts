declare module "fast-glob" {
  export default function glob(patterns: string[], options?: GlobOptions): Promise<string[]>;
}