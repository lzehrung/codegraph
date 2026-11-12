interface B { m(): void } // @def inheritedM=m
interface A extends B {
  m // @def ownM=m
  <T>(): void
}
declare const a: A;
a.m<string>(); // @goto ownM=m @known-gap split_generic_method_selects_inherited observed=inheritedM
