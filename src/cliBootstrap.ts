#!/usr/bin/env node
import { enableCliCompileCache } from "./cli/compileCache.js";
import { markCliBootstrapActive } from "./cli/bootstrap.js";

// Enable before loading the heavy CLI graph so subsequent dynamic imports (and
// later process invocations) can reuse V8's module compile cache.
enableCliCompileCache();
markCliBootstrapActive();

const { main } = await import("./cli.js");
void main();
