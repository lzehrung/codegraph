import { runBuildNativeIfAvailable } from "./build-native-if-available-lib.mjs";

process.exit(
  runBuildNativeIfAvailable({
    strict: process.argv.includes("--strict"),
  }),
);
