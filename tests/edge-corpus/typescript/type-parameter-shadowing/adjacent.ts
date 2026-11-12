// @def outerT=T
type T = string;
interface Adjacent {
  <
    T // @def firstT=T
  >(
    value: T // @goto firstT=T @known-gap signature_parameter_binds_outer_alias observed=outerT
  ): T
  <
    T // @def secondT=T
  >(
    value: T, // @goto secondT=T @known-gap signature_parameter_binds_outer_alias observed=outerT
    extra: number
  ): T
}
let outside: T; // @goto outerT=T
