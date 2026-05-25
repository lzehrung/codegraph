import { registerLanguage } from "../registry.js";
import { htmlStubLanguage } from "./htmlStub.js";

export const HBS_DEF = htmlStubLanguage("hbs", [".hbs", ".handlebars"]);

registerLanguage(HBS_DEF);
