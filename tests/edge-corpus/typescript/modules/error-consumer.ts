import * as ns from "./facade";

const broken = ns.visible.; // @ref original @known-gap parse_error_reexport_reference observed=none
const brokenGoto = ns.visible.; // @goto original=visible
// @def decoyName
function decoyName() {}
const stringOnly = "decoyName" + ; // @not-ref decoyName
