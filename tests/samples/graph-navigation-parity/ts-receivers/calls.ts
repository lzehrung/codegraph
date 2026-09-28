import * as ns from "./base";
import { NamedFace } from "./named-face";
export function helper(): number { return 0; }
class Derived extends ns.Base { run(): number { return super.helper(); } }
class AliasChild implements NamedFace { run(): number { return this.fromAlias(); } }
class Box { helper = () => 1; caller(): number { return this.helper(); } }
export function use(): number { return new Derived().run() + new AliasChild().run() + new Box().caller(); }
