// The declaration/use pairs below were checked with Roslyn, not just by compiling a rename.
export const CSHARP_BINDER_SOURCE = `using System;
using System.Collections.Generic;
using System.Linq;

public class Box { public int Value { get; set; } }
public class Binders {
  private int p = 5;
  private int other = 9;
  public int Field() => p + other;
  public int Anonymous() {
    Func<int, int> f = delegate(int p) { return p + this.p; };
    return f(p);
  }
  public int TupleVar() {
    var (p, q) = (1, 2);
    return p + q + this.p;
  }
  public int NestedTuple() {
    var (p, (q, r)) = (1, (2, 3));
    return p + q + r + this.p;
  }
  public int TupleEachVar() {
    (var p, var q) = (1, 2);
    return p + q + this.p;
  }
  public int TupleTyped() {
    (int p, int q) = (1, 2);
    return p + q + this.p;
  }
  public int MixedAssign(int x) {
    (x, int p) = (1, 2);
    return p + x + this.p;
  }
  public int Each(IEnumerable<(int, int)> source) {
    int total = 0;
    foreach (var (p, q) in source) total += p + q;
    return total + p;
  }
  public int EachTyped(IEnumerable<(int, int)> source) {
    int total = 0;
    foreach ((int p, int q) in source) total += p + q;
    return total + p;
  }
  public int AfterNested() {
    { var (p, q) = (1, 2); Console.WriteLine(p + q); }
    return p;
  }
  public int Pattern(object value) {
    switch (value) {
      case Box { Value: > 0 } p when p.Value > 1: return p.Value;
      default: return p;
    }
  }
  public int IsPattern(object value) => value is Box { Value: > 0 } p ? p.Value : this.p;
  public int SwitchArm(object value) => value switch { Box { Value: > 0 } p => p.Value, _ => p };
  public int Out() { int.TryParse("1", out var p); return p + this.p; }
  public int Query(int[] input) {
    var a = from p in input where p > 0 select p;
    var b = from x in input let p = x + 1 select p;
    var c = from x in input join p in input on x equals p select p;
    var d = from x in input group x by x into p select p.Count();
    return a.Count() + b.Count() + c.Count() + d.Count() + p;
  }
  public int QuerySource(int[] input) {
    var q = from p in Enumerable.Range(1, p) select p;
    return q.Count() + p;
  }
  public int Siblings() {
    { var (p, q) = (1, 2); Console.WriteLine(p + q); }
    { int p = 3; Console.WriteLine(p); }
    return p;
  }
  public int Parameter(int p) => p + other;
  public int Local() { int p = 3; return p + other; }
  public int Discard() { var (p, _) = (1, 2); return p + this.p; }
  public int Escaped() { var (@p, q) = (1, 2); return @p + q + this.p; }
  public int EachOrdinary(int[] source) { foreach (var p in source) { Console.WriteLine(p); } return p; }
}
`;

type Position = readonly [line: number, column: number];
export type CsharpBinder = {
  declaration: Position;
  uses: readonly Position[];
  name?: string;
  unindexed?: true;
};

export const CSHARP_BINDERS: readonly CsharpBinder[] = [
  { declaration: [11, 37], uses: [[11, 49]], unindexed: true },
  { declaration: [15, 10], uses: [[16, 12]], unindexed: true },
  { declaration: [19, 10], uses: [[20, 12]], unindexed: true },
  { declaration: [23, 10], uses: [[24, 12]] },
  { declaration: [27, 10], uses: [[28, 12]] },
  { declaration: [31, 13], uses: [[32, 12]] },
  { declaration: [36, 19], uses: [[36, 45]], unindexed: true },
  { declaration: [41, 19], uses: [[41, 49]] },
  { declaration: [45, 12], uses: [[45, 46]], unindexed: true },
  {
    declaration: [50, 31],
    uses: [
      [50, 38],
      [50, 58],
    ],
    unindexed: true,
  },
  { declaration: [54, 69], uses: [[54, 73]], unindexed: true },
  { declaration: [55, 75], uses: [[55, 80]], unindexed: true },
  { declaration: [56, 48], uses: [[56, 59]] },
  {
    declaration: [58, 18],
    uses: [
      [58, 35],
      [58, 48],
    ],
  },
  { declaration: [59, 33], uses: [[59, 50]] },
  {
    declaration: [60, 34],
    uses: [
      [60, 57],
      [60, 66],
    ],
  },
  { declaration: [61, 47], uses: [[61, 56]] },
  { declaration: [65, 18], uses: [[65, 53]] },
  { declaration: [69, 12], uses: [[69, 46]], unindexed: true },
  {
    declaration: [7, 15],
    uses: [
      [9, 25],
      [11, 58],
      [12, 14],
      [16, 25],
      [20, 29],
      [24, 25],
      [28, 25],
      [32, 25],
      [37, 20],
      [42, 20],
      [46, 12],
      [51, 23],
      [54, 88],
      [55, 94],
      [56, 68],
      [62, 60],
      [65, 43],
      [66, 24],
      [71, 12],
      [75, 63],
      [76, 69],
      [77, 102],
    ],
  },
  { declaration: [70, 11], uses: [[70, 36]] },
  { declaration: [73, 28], uses: [[73, 34]] },
  { declaration: [74, 28], uses: [[74, 42]] },
  { declaration: [75, 31], uses: [[75, 54]], unindexed: true },
  { declaration: [76, 31], uses: [[76, 55]], name: "@p", unindexed: true },
  { declaration: [15, 13], uses: [[16, 16]], name: "q", unindexed: true },
  { declaration: [19, 14], uses: [[20, 16]], name: "q", unindexed: true },
  {
    declaration: [8, 15],
    uses: [
      [9, 29],
      [73, 38],
      [74, 46],
    ],
    name: "other",
  },
];
