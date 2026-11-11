export interface Handler {
  <T0>(): Forward<T0> // @goto Forward @known-gap generic_call_signature_asi observed=not_found
  <T1>(): Forward<T1>
  <T2>(): Forward<T2>
}
// @def Forward
type Forward<T> = T;
