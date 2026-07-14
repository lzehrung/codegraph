import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadNativeBinding } from "../../dist/native/bindingLoader.js";

const require = createRequire(import.meta.url);
const request = JSON.parse(process.argv[2]);
const platformPackageName = "@lzehrung/codegraph-native-win32-x64-msvc";
const binaryPath = path.join(request.platformPackageRoot, "index.win32-x64-msvc.node");
const umbrellaEntry = path.join(request.packageRoot, "node_modules", "@lzehrung", "codegraph-native", "index.js");
const localPackageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "missing-workspace-native");
const loaded = loadNativeBinding({
  packageName: "@lzehrung/codegraph-native",
  localPackageRoot,
  requireFn: require,
  resolveFn: (specifier) => {
    if (specifier === platformPackageName) return binaryPath;
    if (specifier === "@lzehrung/codegraph-native") return umbrellaEntry;
    throw new Error(`unexpected package resolution: ${specifier}`);
  },
  platform: "win32",
  arch: "x64",
  cacheRoot: request.cacheRoot,
});

if (!loaded.binding) {
  throw loaded.error instanceof Error ? loaded.error : new Error(String(loaded.error));
}

process.send?.({ type: "loaded", origin: loaded.origin, languages: loaded.binding.supportedLanguageIds().length });
process.on("message", (message) => {
  if (message === "verify") {
    process.send?.({ type: "verified", languages: loaded.binding.supportedLanguageIds().length });
    return;
  }
  if (message === "stop") process.exit(0);
});
