// Scenario: dynamic import should create a dependency edge to helpers.ts.
export async function loadHelpers() {
  const helpers = await import("./helpers");
  return helpers.anotherHelper();
}
