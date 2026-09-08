import { registerLanguage } from "../registry.js";
import { htmlStubLanguage } from "./html-stub.js";

export const HBS_DEF = htmlStubLanguage("hbs", [".hbs", ".handlebars"]);

registerLanguage(HBS_DEF);
