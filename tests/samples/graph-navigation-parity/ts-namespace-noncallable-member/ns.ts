export namespace N {
  export const value = 1;
  export const compute = (): number => 2;
  export function run(): number {
    return 3;
  }
}

export function use(): number {
  return N.value() + N.compute() + N.run();
}
