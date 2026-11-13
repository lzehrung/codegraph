export interface Handler {
  <T0>(): Forward<T0> // @ref Forward @goto Forward
  <T1>(): Forward<T1> // @ref Forward
  <T2>(): Forward<T2> // @ref Forward
}
// @def Forward @coverage Forward complete
type Forward<T> = T;
