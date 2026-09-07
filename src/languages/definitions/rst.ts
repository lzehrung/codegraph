import { registerLanguage } from "../registry.js";
import { htmlStubLanguage } from "./html-stub.js";

export const RST_DEF = htmlStubLanguage("rst", [".rst"]);

registerLanguage(RST_DEF);
