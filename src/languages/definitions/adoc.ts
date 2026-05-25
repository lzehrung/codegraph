import { registerLanguage } from "../registry.js";
import { htmlStubLanguage } from "./htmlStub.js";

export const ADOC_DEF = htmlStubLanguage("adoc", [".adoc", ".asciidoc"]);

registerLanguage(ADOC_DEF);
