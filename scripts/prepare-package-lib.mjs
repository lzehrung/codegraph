export function shouldReusePreparedDist(isGlobalInstall, isDryRunPack, distReady, needsBuild) {
  return (isGlobalInstall || isDryRunPack) && distReady && !needsBuild;
}
