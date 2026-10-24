// @def identity @coverage identity complete
export function identity<
  T // @def identityT=T @coverage identityT complete @known-gap generic_type_parameters_not_indexed observed=not_found
>(
  value: T // @ref identityT @known-gap generic_type_parameter_reference_missing observed=none
): T { // @ref identityT @known-gap generic_type_parameter_reference_missing observed=none
  return value;
}

export function wrapper<
  T
>(
  value: T
): T {
  return identity(value); // @ref identity
}

export function format(value: string): string;
export function format(value: number): string;
// @def format @coverage format complete
export function format(value: string | number): string {
  return String(value);
}
export function run(): string {
  return format("value"); // @ref format @goto format
}
