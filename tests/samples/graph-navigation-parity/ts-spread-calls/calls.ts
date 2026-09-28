export function g(value: number): { x: number } { return { x: value }; }
export function f(value: { x: number }): number { return value.x; }
export function run(value: number): number { return f({ ...g(value) }); }
