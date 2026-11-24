export type PhpModuleImportNames = {
  classes: Set<string>;
  functions: Set<string>;
  consts: Set<string>;
  namespaces: Set<string>;
  incomplete: boolean;
};
