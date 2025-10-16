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

export default function aDefault(): string {
  return "default-a";
}

// Internal alias import (via @utils/*)
// export { extraUtil as A_EXTRA } from '@utils/extra';


