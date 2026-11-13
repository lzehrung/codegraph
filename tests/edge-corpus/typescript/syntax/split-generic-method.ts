interface B { m(): void } // @def inheritedM=m
interface A extends B {
  m // @def ownM=m
  <T>(): void
}
declare const a: A;
a.m<string>(); // @goto ownM=m

interface OptionalSplit extends B {
  readonly m? // @def optionalSplitM=m
  <T>(): void
}
declare const optionalSplit: OptionalSplit;
optionalSplit.m<string>(); // @goto optionalSplitM=m
optionalSplit.m(); // @goto optionalSplitM=m

class SplitBase { m(value: number): void {} } // @def splitBaseM=m
class SplitClass extends SplitBase {
  m // @def splitClassM=m
  <T>(): void {}
}
declare const splitClass: SplitClass;
splitClass.m<string>(); // @goto splitClassM=m
splitClass.m(); // @goto splitClassM=m

// Construct signatures have no method name, even when `new` is on its own line.
interface SplitConstructor {
  new
  <T>(): SplitClass
  new
  (): SplitClass
}
