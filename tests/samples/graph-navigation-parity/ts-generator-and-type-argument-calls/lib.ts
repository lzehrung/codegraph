export async function loadJSON<T>(file: string): Promise<T> { return JSON.parse(file) as T; }
export function helper(): number { return 1; }
export class Boom extends Error {}
