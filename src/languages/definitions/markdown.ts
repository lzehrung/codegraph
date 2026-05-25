import { registerLanguage } from "../registry.js";
import { htmlStubLanguage } from "./htmlStub.js";

export const MARKDOWN_DEF = htmlStubLanguage("markdown", [".md"]);

registerLanguage(MARKDOWN_DEF);
