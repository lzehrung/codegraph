export function nativeTargetSuffixForPlatform(platform, arch, linuxAbi) {
  if (platform === "win32") {
    if (arch === "x64") return "win32-x64-msvc";
    if (arch === "arm64") return "win32-arm64-msvc";
    return null;
  }
  if (platform === "darwin") {
    if (arch === "x64") return "darwin-x64";
    if (arch === "arm64") return "darwin-arm64";
    return null;
  }
  if (platform === "linux") {
    if (arch === "x64") return `linux-x64-${linuxAbi}`;
    if (arch === "arm64") return `linux-arm64-${linuxAbi}`;
  }
  return null;
}
