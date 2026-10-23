// @def mark
export function mark<T extends Function>(target: T): T { return target; }
@mark // @ref mark @goto mark
// @def Decorated
export class Decorated {
  @mark // @ref mark
  method(): void {}
}
