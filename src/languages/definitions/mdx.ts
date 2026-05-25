import { registerLanguage } from "../registry.js";
import { htmlStubLanguage } from "./htmlStub.js";

export const MDX_DEF = htmlStubLanguage("mdx", [".mdx"]);

registerLanguage(MDX_DEF);
