function helper(): number { return 1; }
class Box {
  helper = 2;
  caller(): number { return this.helper(); }
}
export function run(): number { return new Box().caller() + helper(); }
