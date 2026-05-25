import { registerLanguage } from "../registry.js";
import { htmlStubLanguage } from "./htmlStub.js";

export const ASTRO_DEF = htmlStubLanguage("astro", [".astro"]);

registerLanguage(ASTRO_DEF);
