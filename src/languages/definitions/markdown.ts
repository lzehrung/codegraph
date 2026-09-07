import { registerLanguage } from "../registry.js";
import { htmlStubLanguage } from "./html-stub.js";

export const MARKDOWN_DEF = htmlStubLanguage("markdown", [".md"]);

registerLanguage(MARKDOWN_DEF);
