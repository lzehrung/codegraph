export namespace A {
  export namespace B {
    export function f(value: string): string;
  }
}
export namespace A {
  export namespace B {
    export function f(value: string): string {
      return value;
    }
  }
}
export namespace Z {
  export namespace B {
    export function f(value: string, count: number): string {
      return value + count;
    }
  }
}
export function run(): string {
  return A.B.f("x");
}
