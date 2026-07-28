param(
  [string]$Version = $env:CODEGRAPH_VERSION,
  [switch]$Latest,
  [switch]$Yes
)
$ErrorActionPreference = "Stop"
$Repository = if ($env:CODEGRAPH_REPOSITORY) { $env:CODEGRAPH_REPOSITORY } else { "lzehrung/codegraph" }
if (-not $Version) { $Version = "latest" }
if ($Latest) { $Version = "latest" }

$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($Architecture -eq "x64") { $Target = "win32-x64" }
elseif ($Architecture -eq "arm64") { $Target = "win32-arm64" }
else {
  throw "Unsupported Windows architecture '$Architecture'. Use the package or source installation path: https://github.com/$Repository/blob/main/docs/installation.md"
}
$LocalAppData = [Environment]::GetFolderPath("LocalApplicationData")
$InstallBase = if ($env:CODEGRAPH_INSTALL_BASE) { $env:CODEGRAPH_INSTALL_BASE } else { Join-Path $LocalAppData "Programs/codegraph" }
$BinDir = if ($env:CODEGRAPH_BIN_DIR) { $env:CODEGRAPH_BIN_DIR } else { Join-Path $LocalAppData "Programs/codegraph/bin" }
if (-not $Yes) {
  try {
    $Answer = Read-Host "Install Codegraph $Version for $Target under $InstallBase and write $BinDir/codegraph.cmd? [y/N]"
  } catch {
    throw "Noninteractive install requires -Yes. Target: $Target. Install root: $InstallBase. Launcher: $BinDir/codegraph.cmd."
  }
  if ($Answer -notin @("y", "Y", "yes", "YES")) {
    Write-Output "Cancelled."
    return
  }
}
$BaseUrl = if ($env:CODEGRAPH_RELEASE_BASE_URL) {
  $env:CODEGRAPH_RELEASE_BASE_URL.TrimEnd("/")
} elseif ($Version -eq "latest") {
  "https://github.com/$Repository/releases/latest/download"
} else {
  $Tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
  "https://github.com/$Repository/releases/download/$Tag"
}
$Archive = "codegraph-$Target.zip"
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codegraph-install-" + [guid]::NewGuid().ToString("N"))
$Staging = $null
New-Item -ItemType Directory -Path $TempRoot | Out-Null
try {
  $ArchivePath = Join-Path $TempRoot $Archive
  $ChecksumsPath = Join-Path $TempRoot "SHA256SUMS"
  Invoke-WebRequest -UseBasicParsing "$BaseUrl/$Archive" -OutFile $ArchivePath
  Invoke-WebRequest -UseBasicParsing "$BaseUrl/SHA256SUMS" -OutFile $ChecksumsPath
  $ChecksumLine = Get-Content $ChecksumsPath | Where-Object { $_ -match "\s+$([regex]::Escape($Archive))$" } | Select-Object -First 1
  if (-not $ChecksumLine) { throw "No checksum found for $Archive." }
  $Expected = ($ChecksumLine -split "\s+")[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 $ArchivePath).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) { throw "Checksum verification failed for $Archive." }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Zip = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    foreach ($Entry in $Zip.Entries) {
      $Name = $Entry.FullName.Replace("\", "/")
      if ([string]::IsNullOrWhiteSpace($Name) -or $Name.StartsWith("/") -or $Name -match "^[A-Za-z]:/" -or ($Name.Split("/") -contains "..")) {
        throw "Archive contains an unsafe path: $Name"
      }
      $UnixType = ($Entry.ExternalAttributes -shr 16) -band 0xF000
      if ($UnixType -eq 0xA000 -or $UnixType -eq 0x6000 -or $UnixType -eq 0x2000 -or $UnixType -eq 0x1000) {
        throw "Archive contains an unsafe link or device: $Name"
      }
    }
  } finally {
    $Zip.Dispose()
  }
  [System.IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $TempRoot)
  $Bundle = Join-Path $TempRoot "codegraph-$Target"
  $Node = Join-Path $Bundle "node.exe"
  $Cli = Join-Path $Bundle "dist/cli.js"
  $Manifest = Join-Path $Bundle "manifest.json"
  if (-not (Test-Path $Node -PathType Leaf) -or -not (Test-Path $Cli -PathType Leaf) -or -not (Test-Path $Manifest -PathType Leaf)) {
    throw "Standalone archive is incomplete."
  }
  $InstalledVersion = (& $Node $Cli version).Trim()
  if ($InstalledVersion -notmatch "^[0-9A-Za-z][0-9A-Za-z._-]*$") { throw "Bundled Codegraph returned an unsafe version: $InstalledVersion" }
  & $Node $Cli doctor --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Bundled codegraph doctor failed." }

  $VersionRoot = Join-Path $InstallBase $InstalledVersion
  New-Item -ItemType Directory -Force -Path $InstallBase, $BinDir | Out-Null
  if (-not (Test-Path $VersionRoot)) {
    $Staging = Join-Path $InstallBase (".installing-$InstalledVersion-" + [guid]::NewGuid().ToString("N"))
    try {
      Move-Item $Bundle $Staging
      Move-Item $Staging $VersionRoot
      $Staging = $null
    } catch {
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Staging
      throw
    }
  } else {
    $ProvenanceCheck = @'
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [incomingRoot, installedRoot] = process.argv.slice(2);

function fail(message) {
  throw new Error(`Existing standalone installation provenance mismatch: ${message}`);
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function collectFiles(root) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(`unsafe root: ${root}`);
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) fail(`unsafe symlink: ${relative}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative);
      else fail(`unsafe file type: ${relative}`);
    }
  }
  visit(root);
  return files.sort();
}

function readManifest(root) {
  const manifestPath = path.join(root, "manifest.json");
  let manifest;
  try {
    if (!fs.lstatSync(manifestPath).isFile()) fail(`invalid manifest: ${root}`);
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    fail(`invalid manifest: ${root}`);
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.channel !== "standalone-preview" ||
    typeof manifest.version !== "string" ||
    !manifest.version ||
    typeof manifest.target !== "string" ||
    !manifest.target ||
    typeof manifest.nativeSuffix !== "string" ||
    !manifest.nativeSuffix ||
    typeof manifest.nodeVersion !== "string" ||
    !manifest.nodeVersion ||
    (manifest.sourceRevision !== null && typeof manifest.sourceRevision !== "string") ||
    !Array.isArray(manifest.files)
  ) {
    fail(`invalid manifest: ${root}`);
  }
  const expected = new Map();
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      fail(`invalid file record: ${root}`);
    }
    const normalized = entry.path.replaceAll("\\", "/");
    if (
      normalized !== entry.path ||
      !normalized ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//u.test(normalized) ||
      normalized.split("/").includes("..") ||
      expected.has(entry.path)
    ) {
      fail(`invalid manifest path: ${entry.path}`);
    }
    expected.set(entry.path, entry);
  }
  for (const relative of collectFiles(root)) {
    if (relative === "manifest.json") continue;
    const entry = expected.get(relative);
    if (!entry) fail(`unmanifested file: ${relative}`);
    const absolute = path.resolve(root, relative);
    const rootRelative = path.relative(root, absolute);
    if (!rootRelative || rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) {
      fail(`unsafe file path: ${relative}`);
    }
    const stat = fs.statSync(absolute);
    if (stat.size !== entry.size || sha256File(absolute) !== entry.sha256) {
      fail(`file mismatch: ${relative}`);
    }
    expected.delete(relative);
  }
  if (expected.size) fail(`missing file: ${expected.keys().next().value}`);
  return manifest;
}

const incoming = readManifest(incomingRoot);
const installed = readManifest(installedRoot);
for (const field of ["version", "target", "nativeSuffix", "sourceRevision", "nodeVersion"]) {
  if (incoming[field] !== installed[field]) fail(field);
}
if (incoming.files.length !== installed.files.length) fail("files");
const installedFiles = new Map(installed.files.map((entry) => [entry.path, entry]));
for (const incomingFile of incoming.files) {
  const installedFile = installedFiles.get(incomingFile.path);
  if (
    !installedFile ||
    incomingFile.size !== installedFile.size ||
    incomingFile.sha256 !== installedFile.sha256
  ) {
    fail(incomingFile.path);
  }
}
'@
    $ProvenanceCheck | & $Node '--input-type=module' '-' $Bundle $VersionRoot
    if ($LASTEXITCODE -ne 0) { throw "Existing Codegraph installation provenance verification failed." }
  }
  $Launcher = Join-Path $BinDir "codegraph.cmd"
  $LauncherTemp = "$Launcher.tmp-$PID"
  @"
@echo off
rem codegraph standalone installer
"$VersionRoot\node.exe" "$VersionRoot\dist\cli.js" %*
"@ | Set-Content -Encoding Ascii $LauncherTemp
  $InstallManifestPath = Join-Path $InstallBase "install-manifest.json"
  $PreviousVersion = $null
  if (Test-Path $InstallManifestPath -PathType Leaf) {
    try { $PreviousVersion = (Get-Content -Raw $InstallManifestPath | ConvertFrom-Json).currentVersion } catch { $PreviousVersion = $null }
  }
  $InstallManifest = [ordered]@{
    schemaVersion = 1
    channel = "standalone-preview"
    currentVersion = $InstalledVersion
    previousVersion = $PreviousVersion
    target = $Target
    versionRoot = $VersionRoot
    launchers = @($Launcher)
    releaseUrl = "$BaseUrl/$Archive"
    archiveSha256 = $Actual
    verification = "sha256-from-https-release"
    installedAt = [DateTime]::UtcNow.ToString("o")
  }
  $InstallManifestTemp = "$InstallManifestPath.tmp-$PID"
  $InstallManifest | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $InstallManifestTemp
  $LauncherExisted = Test-Path $Launcher -PathType Leaf
  $ManifestExisted = Test-Path $InstallManifestPath -PathType Leaf
  $LauncherBackup = Join-Path $TempRoot "launcher.backup"
  $ManifestBackup = Join-Path $TempRoot "manifest.backup"
  if ($LauncherExisted) { Copy-Item $Launcher $LauncherBackup }
  if ($ManifestExisted) { Copy-Item $InstallManifestPath $ManifestBackup }
  try {
    Move-Item -Force $LauncherTemp $Launcher
    Move-Item -Force $InstallManifestTemp $InstallManifestPath
  } catch {
    if ($LauncherExisted) { Copy-Item -Force $LauncherBackup $Launcher } else { Remove-Item -Force -ErrorAction SilentlyContinue $Launcher }
    if ($ManifestExisted) { Copy-Item -Force $ManifestBackup $InstallManifestPath } else { Remove-Item -Force -ErrorAction SilentlyContinue $InstallManifestPath }
    throw
  }
  Write-Output "Installed Codegraph $InstalledVersion to $VersionRoot"
  Write-Output "Verified SHA-256: $Actual"
  Write-Output "Launcher: $Launcher"
  Write-Output "If that directory is not on PATH, add it explicitly."
  Write-Output "Next: codegraph install"
} finally {
  if ($Staging -and (Test-Path -LiteralPath $Staging)) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Staging
  }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $TempRoot
}
