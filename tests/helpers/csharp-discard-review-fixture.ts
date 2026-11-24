// Roslyn-checked declarations and references, including a plain out argument that binds the field.
export const CSHARP_DISCARD_REVIEW_SOURCE = `using System;
public class DiscardShapes {
 int _ = 3;
 static bool Parse(out int v) { v = 1; return true; }
 int Typed() { (int _, int p) = (1, 2); return _ + p; }
 int TypedOut() { Parse(out int _); return _; }
 int PlainOut() { Parse(out _); return _; }
 int Pattern(object x) => x is int _ ? _ : this._;
 int PatternVar(object x) => x is var _ ? _ : this._;
 int LambdaSingle() { Func<int,int> f = _ => _ + 1; return f(_); }
 int LambdaPair() { Func<int,int,int> f = (_, _) => _ + this._; return f(_, _); }
 int LambdaTyped() { Func<int,int,int> f = (int _, int _) => _ + this._; return f(_, _); }
 int Local() { int _ = 1; return _; }
 int Escaped() { (int @_, int p) = (1, 2); return @_ + p; }
}
`;

export const CSHARP_DISCARD_FIELD_SITES: ReadonlyArray<readonly [number, number]> = [
  [3, 6],
  [5, 48],
  [6, 44],
  [7, 29],
  [7, 40],
  [8, 40],
  [8, 49],
  [9, 43],
  [9, 52],
  [10, 62],
  [11, 53],
  [11, 62],
  [11, 74],
  [11, 77],
  [12, 62],
  [12, 71],
  [12, 83],
  [12, 86],
];

export const CSHARP_DISCARD_NONREFERENCES: ReadonlyArray<readonly [number, number]> = [
  [5, 21],
  [6, 33],
  [8, 36],
  [9, 39],
  [11, 44],
  [11, 47],
  [12, 49],
  [12, 56],
];

export const CSHARP_NESTED_DISCARD_SOURCE = `using System;
using System.Collections.Generic;
public class Discards {
 public int _ = 1, p = 2;
 public int Untyped() { var (_, p) = (3, 4); return _ + p; }
 public int UntypedNested() { var (_, (p, _)) = (3, (4, 5)); return _ + p; }
 public int Typed() { (int _, int p) = (3, 4); return _ + p; }
 public int EachVar() { (var _, var p) = (3, 4); return _ + p; }
 public int TypedNested() { (int _, (int p, int _)) = (3, (4, 5)); return _ + p; }
 public int Each(IEnumerable<(int,int)> values) { int sum=0; foreach(var (_,p) in values) sum += p + _; return sum + _ + p; }
 public int OrdinaryUnderscore(int _) => _ + p;
 public int Pattern(object value) => value is (int _, int p) ? _ + p : this._;
}
`;

export const CSHARP_NESTED_DISCARD_FIELD_SITES: ReadonlyArray<readonly [number, number]> = [
  [4, 13],
  [5, 53],
  [6, 69],
  [7, 55],
  [8, 57],
  [9, 75],
  [10, 102],
  [10, 118],
  [12, 64],
  [12, 77],
];
