export function aHelper(): string {
  return "a";
}

export class AClass {
  private value: number;
  constructor(value: number = 1) {
    this.value = value;
  }
  getValue(): number { return this.value; }
}

export const A_CONST = "A";


