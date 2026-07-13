import { target } from "./calls.js";

export interface Contract {
  run(): number;
}

export class Base {}
export class Mid extends Base {}
export class Leaf extends Mid implements Contract {
  run(): number {
    return target();
  }
}
