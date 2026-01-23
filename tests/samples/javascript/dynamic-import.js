// Scenario: dynamic import should create a dependency edge to helpers.js.
export async function loadHelpers() {
  const helpers = await import("./helpers.js");
  return helpers.anotherHelper();
}
