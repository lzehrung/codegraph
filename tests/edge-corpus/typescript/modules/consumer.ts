import { alias as localAlias } from "./barrel"; // @ref original
import { starValue } from "./barrel";
import { nested } from "./barrel";
import Widget from "./source";
import * as sourceNS from "./source";
const direct = sourceNS.original; // @ref original @goto original
const aliased = localAlias; // @ref original
const starred = starValue; // @ref starValue
const namespaced = nested.namespaceValue; // @ref namespaceValue @known-gap namespace_reexport_member_reference_missing observed=none
const namespaceGoto = nested.namespaceValue; // @goto namespaceValue
const widget = new Widget(); // @ref Widget @goto Widget
const decoyText = "original";
const decoyForms = [`original`, /original/]; // @not-ref original
const decoyComment = 0; // original appears only in this comment @not-ref original
