import { loadJSON, helper, Boom } from "./lib";
export function* gen(): Generator<number> { yield helper(); }
export async function* agen(): AsyncGenerator<number> { yield helper(); }
export async function typed(): Promise<number> { const v = await loadJSON<number>("1"); return v; }
export function voided(): void { void helper(); }
export function thrower(flag: boolean): void { if (flag) throw new Boom(); }
export const arrow = async (): Promise<number> => loadJSON<number>("2");
