import { registerLanguage } from "../registry.js";
import { htmlStubLanguage } from "./html-stub.js";

export const MDX_DEF = htmlStubLanguage("mdx", [".mdx"]);

registerLanguage(MDX_DEF);
