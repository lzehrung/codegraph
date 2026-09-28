export namespace A { export function select(value: string): string { return value; } }
export namespace B { export function one(): string { return "one"; } }
export namespace B {
  export function select(value: string): string;
  export function select(value: string, count: number): string;
  export function select(value: string, count?: number): string { return value + count; }
}
export function run(): string { return B.select("b", 2) + B.one(); }
export function wrongArity(): void { B.select("b", 2, 3); }
