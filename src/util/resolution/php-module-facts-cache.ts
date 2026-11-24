import type { PhpModuleImportNames } from "../../indexer/php-module-facts-types.js";
import { fileIdentityKey } from "../paths.js";

export const phpParsedModuleCache = new Map<
  string,
  PhpModuleImportNames | null | Promise<PhpModuleImportNames | null>
>();
export const phpModuleNamesReader: {
  current: ((file: string) => Promise<PhpModuleImportNames | null | undefined>) | undefined;
} = { current: undefined };

/** Indexed candidates borrow the active build's memoized extraction instead of parsing for proof. */
export function setPhpModuleImportNamesReader(reader: typeof phpModuleNamesReader.current): void {
  phpModuleNamesReader.current = reader;
}

/** The active build supplies declarations from its single native extraction or an unchanged module row. */
export function primePhpModuleImportNames(file: string, names: PhpModuleImportNames | null): void {
  phpParsedModuleCache.set(fileIdentityKey(file), names);
}
