import { buildSqlModuleIndex } from "../../sql/source-graph.js";
import type { ModuleIndexHooks } from "../language-hook-types.js";

export const sqlModule: ModuleIndexHooks = { sourceModule: buildSqlModuleIndex };
